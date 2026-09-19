// SPDX-License-Identifier: AGPL-3.0
// Stable ninjaone-org-lookup Saga definition (ADR 002, issue #115 second
// pilot): read-only NinjaOne organization lookup by name. Re-authored from
// workspace `features/ninjaone/workflows/sync_organizations.py` (private
// bifrost-workspace; unreachable from this lane, mapping operator-declared):
// only the vendor-read half is ported — one listOrganizations call, then a
// pure local match over the same bounded census the census Saga persists
// (first NINJA_ORGS_MAX; matchCount totals within that bound). Mapping
// writes stay a follow-up, never this Saga.
// Migrated to the ADR 033 interior helpers like its sibling census Saga:
// schemaOf, prepareInput, integrationOperation, completeExecution/
// failSagaExecution, makeSagaWorkflow.
import { NonRetryableError } from "cloudflare:workflows";
import {
  matchNinjaOrgs,
  NINJA_INTEGRATION_ID,
  NINJA_TIMEOUT_MS,
  ninjaLookupSaga,
  parseNinjaLookupInput,
} from "../domain";
import type { NinjaLookupResult, SafeError } from "../domain";
import { defineSaga, schemaOf } from "../saga";
import { integrationOperation, prepareInput } from "../saga-helpers";
import {
  assertRunExecutionId,
  beginOperation,
  completeExecution,
  failSagaExecution,
  finishOperation,
} from "../executions";
import { makeSagaWorkflow } from "./shared";
import { registerSagaDef } from "./registry";

/** Stable ninjaone-org-lookup Saga: one read-only NinjaOne census, matched
 * locally against a form-bound name query. */
export const ninjaLookupSagaDef = defineSaga<NinjaLookupResult>({
  id: ninjaLookupSaga.id,
  name: ninjaLookupSaga.name,
  revision: ninjaLookupSaga.revision,
  description: ninjaLookupSaga.description,
  tags: ["ninjaone", "read-only", "lookup"],
  requiredIntegrations: [NINJA_INTEGRATION_ID],
  inputSchema: schemaOf({ query: "string" }, ["query"]),
  outputSchema: schemaOf({ query: "string", organizationCount: "number", matchCount: "number", matches: "array" }, [
    "query",
    "organizationCount",
    "matchCount",
    "matches",
  ]),
  parse: parseNinjaLookupInput,
  run: async (ctx, step): Promise<NinjaLookupResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    // The expected-failure branch below persists before throwing, so the
    // catch rethrows an already-persisted failure untouched: step names are
    // unique per Execution, so exactly one persist-failure-v1 runs.
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareInput(ctx, ninjaLookupSaga, parseNinjaLookupInput),
      );
      // ADR-033-4: one Action convention — the helper supplies
      // (connection, secrets, deadline, operationId) and each leg takes what
      // its Action needs. The secret handle passes straight through the
      // Action boundary; presence is enforced inside listOrganizations, so
      // this step never branches on credentials. This is the single vendor
      // read: everything after it is a pure local transform.
      const outcome = await step.do("ninja-list-orgs-v1", () =>
        integrationOperation(ctx, ninjaLookupSagaDef, prepared, {
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
      // Pure local match over the census (no vendor contact): bracketed as
      // its own Operation (the hello greet-v1 idiom) so ExecutionHistory
      // shows the lookup, not just the read.
      const output = await step.do("ninja-match-orgs-v1", async () => {
        await beginOperation(ctx.db, id, "ninja-match-orgs-v1", 2);
        const { matchCount, matches } = matchNinjaOrgs(outcome.result.organizations, prepared.input.query);
        const result: NinjaLookupResult = {
          query: prepared.input.query,
          organizationCount: outcome.result.organizationCount,
          matchCount,
          matches,
        };
        await finishOperation(ctx.db, id, "ninja-match-orgs-v1", result);
        return result;
      });
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

registerSagaDef(ninjaLookupSagaDef);
export class NinjaLookupWorkflow extends makeSagaWorkflow(ninjaLookupSagaDef) {}
