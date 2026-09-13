// SPDX-License-Identifier: AGPL-3.0
// Stable echo Saga definition (ADR 002): prepare input and call the local
// HTTP echo Integration. Moved verbatim from src/sagas.ts; no behavior change.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { echoSaga, ECHO_INTEGRATION_ID, EXECUTION_ID, Fault, parseInput, VENDOR_TIMEOUT_MS } from "../domain";
import { parseStoredPolicy } from "../executions";
import { vendorDeadlineMs } from "../domain";
import type { EchoInput, ExecutionParams, SafeError } from "../domain";
import { defineSaga, withOperation } from "../saga";
import { scrubExecutionError, scrubExecutionValue } from "../secrets";
import { beginOperation, failExecution, finishOperation, prepareExecution, resolveConnection } from "../executions";
import { executeSaga } from "./shared";

const echoInputSchema = Object.freeze({
  type: "object" as const,
  properties: Object.freeze({ message: Object.freeze({ type: "string" }) }),
  required: Object.freeze(["message"]),
  additionalProperties: false,
});

/** Stable echo Saga: prepare input and call the local HTTP echo Integration. */
export const echoSagaDef = defineSaga<EchoInput>({
  id: echoSaga.id,
  name: echoSaga.name,
  revision: echoSaga.revision,
  description: echoSaga.description,
  tags: ["utility", "fixture"],
  requiredIntegrations: [ECHO_INTEGRATION_ID],
  inputSchema: echoInputSchema,
  outputSchema: echoInputSchema,
  parse: parseInput,
  run: async (ctx, step): Promise<EchoInput> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, echoSaga.id, echoSaga.revision, parseInput),
      );
      const outcome = await step.do("echo-http-v1", async () => {
        await beginOperation(ctx.db, id, "echo-http-v1", 1);
        // RUN-01 (ADR 018): the vendor deadline resolves through the
        // Execution's snapshotted policy (timeout 0 keeps the Integration
        // default, custom overrides it). 0 disables only the override.
        const applied = await ctx.db
          .prepare("SELECT policy_json FROM executions WHERE id=?")
          .bind(id)
          .first<{ policy_json: string | null }>()
          .catch(() => null);
        const deadline = vendorDeadlineMs(
          applied?.policy_json == null ? parseStoredPolicy(null) : parseStoredPolicy(applied.policy_json),
          VENDOR_TIMEOUT_MS,
        );
        // Phase 1b (ADR 010): exact-org Connection resolution through the
        // step's own OrgCtx. Echo is declared required, so a miss fails loud
        // with 424 as a structured step result (no retry via NonRetryableError
        // downstream). The outbound key derives from the step ctx, so the
        // stable operation ID and the downstream Idempotency-Key agree.
        const stepOrg = withOperation(prepared.orgCtx, "echo-http-v1");
        const resolved = await resolveConnection(
          ctx.db,
          stepOrg,
          ECHO_INTEGRATION_ID,
          echoSagaDef.requiredIntegrations,
        );
        if (!resolved.found && !resolved.declared) {
          // Unreachable while echo stays declared required: optional access
          // would resolve to None here instead of failing.
          throw new NonRetryableError("Unexpected optional Integration access.");
        }
        if (!resolved.found) return { ok: false as const, error: resolved.error };
        const connection = resolved.connection;
        let result: EchoInput;
        try {
          result = await ctx.integrations.echo.echo(
            connection,
            prepared.input,
            `${id}-${stepOrg.operationId}`,
            deadline,
          );
        } catch (error) {
          // Raw echo transport errors map to the generic failure; Fault text is
          // fixed-shape and scrubbed against this Execution's registry.
          const safe =
            error instanceof Fault
              ? scrubExecutionError({ code: error.code, message: error.message }, id)
              : { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "echo-http-v1", result);
        return { ok: true as const, result };
      });
      if (!outcome.ok) {
        expectedFailure = outcome.error;
        timedOut = outcome.error.code === "ECHO_VENDOR_TIMEOUT";
        if (timedOut) {
          // Explicit timeout step: the sole writer of TimedOut. The vendor
          // deadline fired inside echo-http-v1; nothing here is inferred from
          // native Workflow introspection. The shared catch below skips its
          // Failed checkpoint once this marker has persisted.
          const failure: SafeError = scrubExecutionError(outcome.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(expectedFailure.code);
      }
      const output = outcome.result;
      // Native wait primitive. Deliberately not a product Operation: not every
      // infrastructure checkpoint is ExecutionHistory.
      await step.sleep("settle-wait-v1", "1 second");
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

export class EchoWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<EchoInput> {
    return executeSaga(this.env, event, step, echoSagaDef);
  }
}
