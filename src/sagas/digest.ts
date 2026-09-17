// SPDX-License-Identifier: AGPL-3.0
// Stable ninjaone-echo-digest Saga definition (ADR 002, Phase 2): read-only
// NinjaOne census shaped into a bounded digest and echoed through the echo
// Integration. Migrated to the ADR 033 interior helpers (issue #416):
// schemaOf, prepareInput, integrationOperation (since #415),
// completeExecution/failSagaExecution, makeSagaWorkflow. Behavior unchanged;
// both timeout-mark-v1 steps are gone — failSagaExecution classifies vendor
// timeouts as TimedOut inside persist-failure-v1.
import { NonRetryableError } from "cloudflare:workflows";
import {
  digestSaga,
  ECHO_INTEGRATION_ID,
  NINJA_INTEGRATION_ID,
  NINJA_TIMEOUT_MS,
  parseDigestInput,
  shapeDigest,
  VENDOR_TIMEOUT_MS,
} from "../domain";
import type { DigestResult, SafeError } from "../domain";
import { defineSaga, schemaOf } from "../saga";
import { integrationOperation, prepareInput } from "../saga-helpers";
import { assertRunExecutionId, completeExecution, failSagaExecution } from "../executions";
import { makeSagaWorkflow } from "./shared";

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
  inputSchema: schemaOf({}, []),
  outputSchema: schemaOf({ organizationCount: "number", echoed: "object" }, ["organizationCount", "echoed"]),
  parse: parseDigestInput,
  run: async (ctx, step): Promise<DigestResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    // The expected-failure branches below persist before throwing, so the
    // catch rethrows an already-persisted failure untouched: step names are
    // unique per Execution, so exactly one persist-failure-v1 runs.
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, digestSaga, parseDigestInput));
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
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, orgs.error));
        terminalWritten = true;
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
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, echoed.error));
        terminalWritten = true;
        throw new NonRetryableError(echoed.error.code);
      }
      const output: DigestResult = { organizationCount: orgs.result.organizationCount, echoed: echoed.result };
      // Native wait primitive, same posture as echo: infrastructure checkpoint,
      // not a product Operation.
      await step.sleep("settle-wait-v1", "1 second");
      await step.do("persist-success-v1", () => completeExecution(ctx.db, id, output));
      return output;
    } catch (error) {
      if (terminalWritten) throw error;
      const failure: SafeError = {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, failure));
      throw new NonRetryableError(failure.code);
    }
  },
});

export class NinjaEchoDigestWorkflow extends makeSagaWorkflow(digestSagaDef) {}
