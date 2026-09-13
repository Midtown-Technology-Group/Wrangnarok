// SPDX-License-Identifier: AGPL-3.0
// Stable ninjaone-orgs Saga definition (ADR 002): read-only census of
// NinjaOne organizations. Moved verbatim from src/sagas.ts; no behavior change.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { EXECUTION_ID, Fault, NINJA_INTEGRATION_ID, NINJA_TIMEOUT_MS, ninjaSaga, parseNinjaOrgsInput } from "../domain";
import { parseStoredPolicy } from "../executions";
import { vendorDeadlineMs } from "../domain";
import type { ExecutionParams, NinjaOrgsResult, SafeError } from "../domain";
import { defineSaga, withOperation } from "../saga";
import { scrubExecutionError, scrubExecutionValue } from "../secrets";
import { beginOperation, failExecution, finishOperation, prepareExecution, resolveConnection } from "../executions";
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
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, ninjaSaga.id, ninjaSaga.revision, parseNinjaOrgsInput),
      );
      const outcome = await step.do("ninja-list-orgs-v1", async () => {
        await beginOperation(ctx.db, id, "ninja-list-orgs-v1", 1);
        // RUN-01 (ADR 018): vendor deadline from the Execution snapshot.
        const applied = await ctx.db
          .prepare("SELECT policy_json FROM executions WHERE id=?")
          .bind(id)
          .first<{ policy_json: string | null }>()
          .catch(() => null);
        const deadline = vendorDeadlineMs(
          applied?.policy_json == null ? parseStoredPolicy(null) : parseStoredPolicy(applied.policy_json),
          NINJA_TIMEOUT_MS,
        );
        // Phase 1b (ADR 010): exact-org Connection resolution through the
        // step's own OrgCtx. NinjaOne is declared required, so a miss fails
        // loud with 424 as a structured step result (no retry via
        // NonRetryableError).
        const stepOrg = withOperation(prepared.orgCtx, "ninja-list-orgs-v1");
        const resolved = await resolveConnection(
          ctx.db,
          stepOrg,
          NINJA_INTEGRATION_ID,
          ninjaOrgsSagaDef.requiredIntegrations,
        );
        if (!resolved.found && !resolved.declared) {
          // Unreachable while NinjaOne stays declared required: optional
          // access would resolve to None here instead of failing.
          throw new NonRetryableError("Unexpected optional Integration access.");
        }
        if (!resolved.found) return { ok: false as const, error: resolved.error };
        const connection = resolved.connection;
        // Local-only credential posture (documented Rung 1 deviation): the
        // client secret lives in env, never in D1. ADR 005 envelope before
        // any second Organization. The secret handle passes straight through
        // the Action boundary — presence is enforced inside listOrganizations,
        // so this step never branches on credentials.
        let result: NinjaOrgsResult;
        try {
          result = await ctx.integrations.ninjaone.listOrganizations(connection, ctx.secrets, id, deadline);
        } catch (error) {
          // Raw transport errors must not leak vendor-shaped text into step
          // results: Faults already carry fixed safe text (scrubbed at the
          // boundary); anything else maps to the generic integration failure.
          const safe =
            error instanceof Fault
              ? scrubExecutionError({ code: error.code, message: error.message }, id)
              : { code: "NINJA_INTEGRATION_FAILED", message: "The NinjaOne Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "ninja-list-orgs-v1", result);
        return { ok: true as const, result };
      });
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
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(scrubExecutionValue(output, id)), id)
          .run();
      });
      return output;
    } catch {
      // Expected failures are serialized step results, not Error subclasses transported by Workflows.
      const raw: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      const safe: SafeError = scrubExecutionError(raw, id);
      if (!timedOut) {
        await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      }
      throw new NonRetryableError(safe.code);
    }
  },
});

export class NinjaOrgsWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<NinjaOrgsResult> {
    return executeSaga(this.env, event, step, ninjaOrgsSagaDef);
  }
}
