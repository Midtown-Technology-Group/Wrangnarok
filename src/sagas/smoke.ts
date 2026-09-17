// SPDX-License-Identifier: AGPL-3.0
// Stable system.smoke Saga definition (ADR 002): loopback-free platform
// smoke. Moved verbatim from src/sagas.ts; no behavior change.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { parseSmokeInput, smokeSaga } from "../domain";
import type { ExecutionParams, SafeError, SmokeResult } from "../domain";
import { defineSaga } from "../saga";
import { getExecutionSecrets } from "../secrets";
import {
  assertRunExecutionId,
  beginOperation,
  finishOperation,
  persistRunFailure,
  persistRunSuccess,
  prepareExecution,
} from "../executions";
import { buildUsage, logUsage, persistUsage } from "../usage";
import { executeSaga } from "./shared";

/** Stable system.smoke Saga: loopback-free platform smoke. D1-only Operations
 * plus a pure transform — zero external vendor dependency, no Connection
 * lookup, no secrets, no fetch. D1 checkpoint steps only may use retries up to
 * the operator ceiling 2; expected failures throw NonRetryableError. */
export const smokeSagaDef = defineSaga<SmokeResult>({
  id: smokeSaga.id,
  name: smokeSaga.name,
  revision: smokeSaga.revision,
  description: smokeSaga.description,
  tags: ["platform", "smoke"],
  requiredIntegrations: [],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      d1WriteOk: Object.freeze({ type: "boolean" }),
      d1ReadOk: Object.freeze({ type: "boolean" }),
      operationCount: Object.freeze({ type: "number" }),
      operations: Object.freeze({ type: "array" }),
    }),
    required: Object.freeze(["d1WriteOk", "d1ReadOk", "operationCount", "operations"]),
    additionalProperties: false,
  }),
  parse: parseSmokeInput,
  run: async (ctx, step): Promise<SmokeResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    try {
      // startedMs is captured inside the shared prepare Operation
      // (replay-memoized), never at the top of run: wall-clock reads outside
      // step.do fail the contract.
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, smokeSaga.id, smokeSaga.revision, parseSmokeInput),
      );
      const written = await step.do("smoke-write-v1", async () => {
        // D1 write verification: durable probe row, then read it back in-step.
        await beginOperation(ctx.db, id, "smoke-write-v1", 1);
        await finishOperation(ctx.db, id, "smoke-write-v1", { probe: `smoke_${id.slice(0, 8)}` });
        const probe = await ctx.db
          .prepare("SELECT result_json FROM operations WHERE execution_id=? AND name=?")
          .bind(id, "smoke-write-v1")
          .first<{ result_json: string | null }>();
        if (!probe?.result_json || !probe.result_json.includes("smoke_")) {
          return {
            ok: false as const,
            error: { code: "SMOKE_WRITE_UNVERIFIED", message: "The smoke D1 write could not be verified." },
          };
        }
        return { ok: true as const, result: { probe: probe.result_json } };
      });
      if (!written.ok) {
        expectedFailure = written.error;
        throw new NonRetryableError(written.error.code);
      }
      const verified = await step.do("smoke-verify-v1", async () => {
        // D1 read verification + pure transform: confirm the Execution row and
        // all Operation rows, then shape the bounded summary. No I/O besides D1.
        await beginOperation(ctx.db, id, "smoke-verify-v1", 2);
        const execution = await ctx.db
          .prepare("SELECT id,status,org_id FROM executions WHERE id=?")
          .bind(id)
          .first<{ id: string; status: string; org_id: string }>();
        const operations = await ctx.db
          .prepare("SELECT name,status FROM operations WHERE execution_id=? ORDER BY position,name")
          .bind(id)
          .all<{ name: string; status: string }>();
        if (!execution || execution.id !== id || execution.status !== "Running") {
          return {
            ok: false as const,
            error: { code: "SMOKE_READ_UNVERIFIED", message: "The smoke D1 read could not be verified." },
          };
        }
        const names = operations.results.map((row) => row.name);
        for (const required of ["prepare-input-v1", "smoke-write-v1", "smoke-verify-v1"]) {
          if (!names.includes(required)) {
            return {
              ok: false as const,
              error: { code: "SMOKE_READ_UNVERIFIED", message: "The smoke Operation history is incomplete." },
            };
          }
        }
        const result: SmokeResult = {
          d1WriteOk: true,
          d1ReadOk: true,
          operationCount: names.length,
          operations: names,
        };
        await finishOperation(ctx.db, id, "smoke-verify-v1", result);
        return { ok: true as const, result: { shaped: result, orgId: execution.org_id } };
      });
      if (!verified.ok) {
        expectedFailure = verified.error;
        throw new NonRetryableError(verified.error.code);
      }
      const output: SmokeResult = verified.result.shaped;
      await step.do("persist-success-v1", async () => {
        await persistRunSuccess(ctx.db, id, output);
        const count = await ctx.db
          .prepare("SELECT COUNT(*) AS n FROM operations WHERE execution_id=?")
          .bind(id)
          .first<{ n: number }>();
        const usage = buildUsage({
          saga: smokeSaga.name,
          sagaRevision: smokeSaga.revision,
          executionId: id,
          orgId: verified.result.orgId || prepared.orgCtx.orgId,
          status: "Succeeded",
          operationRows: count?.n ?? output.operationCount,
          reads: 4,
          writes: 8,
          stepsExecuted: 4,
          durationMs: Date.now() - prepared.startedMs,
        });
        logUsage(usage, getExecutionSecrets(id));
        await persistUsage(ctx.db, id, usage, getExecutionSecrets(id));
      });
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, false);
    }
  },
});

export class SmokeWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<SmokeResult> {
    return executeSaga(this.env, event, step, smokeSagaDef);
  }
}
