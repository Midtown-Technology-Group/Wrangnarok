// SPDX-License-Identifier: AGPL-3.0
// Stable ninjaone-orgs Saga definition (ADR 002): read-only census of
// NinjaOne organizations. Moved verbatim from src/sagas.ts; no behavior change.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { NINJA_INTEGRATION_ID, NINJA_TIMEOUT_MS, ninjaSaga, parseNinjaOrgsInput } from "../domain";
import type { ExecutionParams, NinjaOrgsResult, SafeError } from "../domain";
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

/** Stable ninjaone-orgs Saga: read-only census of NinjaOne organizations. */
export const ninjaOrgsSagaDef = defineSaga<NinjaOrgsResult>({
  id: ninjaSaga.id,
  name: ninjaSaga.name,
  revision: ninjaSaga.revision,
  description: ninjaSaga.description,
  tags: ["ninjaone", "read-only"],
  requiredIntegrations: [NINJA_INTEGRATION_ID],
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
      organizations: Object.freeze({ type: "array" }),
    }),
    required: Object.freeze(["organizationCount", "organizations"]),
    additionalProperties: false,
  }),
  parse: parseNinjaOrgsInput,
  run: async (ctx, step): Promise<NinjaOrgsResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, ninjaSaga.id, ninjaSaga.revision, parseNinjaOrgsInput),
      );
      // ADR-033-4: one Action convention — the helper supplies
      // (connection, secrets, deadline, operationId) and each leg takes what
      // its Action needs. The secret handle passes straight through the
      // Action boundary; presence is enforced inside listOrganizations, so
      // this step never branches on credentials.
      const outcome = await step.do("ninja-list-orgs-v1", () =>
        integrationOperation(ctx, ninjaOrgsSagaDef, prepared, {
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
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        timedOut = outcome.error.code === "NINJA_VENDOR_TIMEOUT";
        if (timedOut) {
          // Explicit timeout step, same posture as the echo and digest legs:
          // a slow NinjaOne vendor surfaces TimedOut, never an inferred failure.
          const failure: SafeError = scrubExecutionError(outcome.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      await step.do("persist-success-v1", () => persistRunSuccess(ctx.db, id, output));
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, timedOut);
    }
  },
});

export class NinjaOrgsWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<NinjaOrgsResult> {
    return executeSaga(this.env, event, step, ninjaOrgsSagaDef);
  }
}
