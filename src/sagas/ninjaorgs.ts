// SPDX-License-Identifier: AGPL-3.0
// Stable ninjaone-orgs Saga definition (ADR 002): read-only census of
// NinjaOne organizations. Migrated to the ADR 033 interior helpers (issue
// #416): schemaOf, prepareInput, integrationOperation (since #415),
// completeExecution/failSagaExecution, makeSagaWorkflow. Behavior unchanged;
// the timeout-mark-v1 step is gone — failSagaExecution classifies
// NINJA_VENDOR_TIMEOUT as TimedOut inside persist-failure-v1.
import { NonRetryableError } from "cloudflare:workflows";
import { NINJA_INTEGRATION_ID, NINJA_TIMEOUT_MS, ninjaSaga, parseNinjaOrgsInput } from "../domain";
import type { NinjaOrgsResult, SafeError } from "../domain";
import { defineSaga, schemaOf } from "../saga";
import { integrationOperation, prepareInput } from "../saga-helpers";
import { assertRunExecutionId, completeExecution, failSagaExecution } from "../executions";
import { makeSagaWorkflow } from "./shared";

/** Stable ninjaone-orgs Saga: read-only census of NinjaOne organizations. */
export const ninjaOrgsSagaDef = defineSaga<NinjaOrgsResult>({
  id: ninjaSaga.id,
  name: ninjaSaga.name,
  revision: ninjaSaga.revision,
  description: ninjaSaga.description,
  tags: ["ninjaone", "read-only"],
  requiredIntegrations: [NINJA_INTEGRATION_ID],
  inputSchema: schemaOf({}, []),
  outputSchema: schemaOf({ organizationCount: "number", organizations: "array" }, [
    "organizationCount",
    "organizations",
  ]),
  parse: parseNinjaOrgsInput,
  run: async (ctx, step): Promise<NinjaOrgsResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    // The expected-failure branch below persists before throwing, so the
    // catch rethrows an already-persisted failure untouched: step names are
    // unique per Execution, so exactly one persist-failure-v1 runs.
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, ninjaSaga, parseNinjaOrgsInput));
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
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, outcome.error));
        terminalWritten = true;
        throw new NonRetryableError(outcome.error.code);
      }
      const output = outcome.result;
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

export class NinjaOrgsWorkflow extends makeSagaWorkflow(ninjaOrgsSagaDef) {}
