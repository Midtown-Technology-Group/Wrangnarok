// SPDX-License-Identifier: AGPL-3.0
// Stable ninjaone-echo-digest Saga definition (ADR 002, Phase 2): read-only
// NinjaOne census shaped into a bounded digest and echoed through the echo
// Integration. Moved verbatim from src/sagas.ts; no behavior change.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import {
  digestSaga,
  ECHO_INTEGRATION_ID,
  NINJA_INTEGRATION_ID,
  NINJA_TIMEOUT_MS,
  parseDigestInput,
  shapeDigest,
  VENDOR_TIMEOUT_MS,
} from "../domain";
import type { DigestResult, ExecutionParams, SafeError } from "../domain";
import { defineSaga } from "../saga";
import { integrationOperation } from "../saga-helpers";
import { scrubExecutionError } from "../secrets";
import {
  assertRunExecutionId,
  failExecution,
  persistRunFailure,
  persistRunSuccess,
  prepareExecution,
} from "../executions";
import { executeSaga } from "./shared";

/** Stable ninjaone-echo-digest Saga (Phase 2): read-only NinjaOne census
 * shaped into a bounded digest and echoed through the echo Integration. Both
 * vendor steps resolve retries 0 via stepRetryLimit; the digest is a pure
 * transform of the census and never carries secrets or vendor bodies. */
export const digestSagaDef = defineSaga<DigestResult>({
  id: digestSaga.id,
  name: digestSaga.name,
  revision: digestSaga.revision,
  description: digestSaga.description,
  tags: ["ninjaone", "echo", "read-only"],
  requiredIntegrations: [NINJA_INTEGRATION_ID, ECHO_INTEGRATION_ID],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      organizationCount: Object.freeze({ type: "number" }),
      echoed: Object.freeze({ type: "object" }),
    }),
    required: Object.freeze(["organizationCount", "echoed"]),
    additionalProperties: false,
  }),
  parse: parseDigestInput,
  run: async (ctx, step): Promise<DigestResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, digestSaga.id, digestSaga.revision, parseDigestInput),
      );
      // ADR-033-4: one Action convention — the helper supplies
      // (connection, secrets, deadline, operationId) and each leg takes what
      // its Action needs. Credential use stays behind the Action boundary:
      // the secret handle passes straight through and listOrganizations
      // enforces presence, so this step never branches on credentials.
      const orgs = await step.do("ninja-list-orgs-v1", () =>
        integrationOperation(ctx, digestSagaDef, prepared, {
          op: "ninja-list-orgs-v1",
          position: 1,
          integrationId: NINJA_INTEGRATION_ID,
          vendorDefaultMs: NINJA_TIMEOUT_MS,
          failureCode: "NINJA_INTEGRATION_FAILED",
          failureMessage: "The NinjaOne Integration could not complete.",
          call: (connection, secrets, deadline) =>
            ctx.integrations.ninjaone.listOrganizations(connection, secrets, id, deadline),
        }),
      );
      if (!orgs.ok) {
        expectedFailure = orgs.error;
        timedOut = orgs.error.code === "NINJA_VENDOR_TIMEOUT";
        if (timedOut) {
          // Explicit timeout step, same posture as the echo leg: a slow
          // NinjaOne vendor surfaces TimedOut, never an inferred failure.
          const failure: SafeError = scrubExecutionError(orgs.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(orgs.error.code);
      }
      // ADR-033-4: same Action convention as the census leg above and
      // every other Saga. The digest is a pure transform of the census and
      // never carries secrets or vendor bodies.
      const echoed = await step.do("echo-digest-v1", () =>
        integrationOperation(ctx, digestSagaDef, prepared, {
          op: "echo-digest-v1",
          position: 2,
          integrationId: ECHO_INTEGRATION_ID,
          vendorDefaultMs: VENDOR_TIMEOUT_MS,
          failureCode: "ECHO_INTEGRATION_FAILED",
          failureMessage: "The echo Integration could not complete.",
          call: (connection, _secrets, deadline, operationId) =>
            ctx.integrations.echo.echo(connection, shapeDigest(orgs.result), operationId, deadline),
        }),
      );
      if (!echoed.ok) {
        expectedFailure = echoed.error;
        timedOut = echoed.error.code === "ECHO_VENDOR_TIMEOUT";
        if (timedOut) {
          const failure: SafeError = scrubExecutionError(echoed.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(echoed.error.code);
      }
      const output: DigestResult = { organizationCount: orgs.result.organizationCount, echoed: echoed.result };
      // Native wait primitive, same posture as echo: infrastructure checkpoint,
      // not a product Operation.
      await step.sleep("settle-wait-v1", "1 second");
      await step.do("persist-success-v1", () => persistRunSuccess(ctx.db, id, output));
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, timedOut);
    }
  },
});

export class NinjaEchoDigestWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<DigestResult> {
    return executeSaga(this.env, event, step, digestSagaDef);
  }
}
