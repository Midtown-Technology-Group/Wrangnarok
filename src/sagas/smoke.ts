// SPDX-License-Identifier: AGPL-3.0
// Stable system.smoke Saga definition (ADR 002): loopback-free platform
// smoke. Migrated to the ADR 033 interior helpers (issue #416): schemaOf,
// prepareInput, completeExecution/failSagaExecution, makeSagaWorkflow.
// Behavior unchanged: D1-only Operations plus a pure transform and the
// usage block — zero external vendor dependency, no Connection lookup,
// no secrets, no fetch.
import { NonRetryableError } from "cloudflare:workflows";
import { parseSmokeInput, smokeSaga } from "../domain";
import type { SafeError, SmokeResult } from "../domain";
import { defineSaga, schemaOf } from "../saga";
import { getExecutionSecrets } from "../secrets";
import {
  assertRunExecutionId,
  beginOperation,
  completeExecution,
  failSagaExecution,
  finishOperation,
} from "../executions";
import { prepareInput } from "../saga-helpers";
import { buildUsage, logUsage, persistUsage } from "../usage";
import { makeSagaWorkflow } from "./shared";
import { registerSagaDef } from "./registry";

/** Stable system.smoke Saga: loopback-free platform smoke. D1 checkpoint steps only may use retries up to
 * the operator ceiling 2; expected failures throw NonRetryableError. */
export const smokeSagaDef = defineSaga<SmokeResult>({
  id: smokeSaga.id,
  name: smokeSaga.name,
  revision: smokeSaga.revision,
  description: smokeSaga.description,
  tags: ["platform", "smoke"],
  requiredIntegrations: [],
  inputSchema: schemaOf({}, []),
  outputSchema: schemaOf({ d1WriteOk: "boolean", d1ReadOk: "boolean", operationCount: "number", operations: "array" }, [
    "d1WriteOk",
    "d1ReadOk",
    "operationCount",
    "operations",
  ]),
  parse: parseSmokeInput,
  run: async (ctx, step): Promise<SmokeResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    // The expected-failure branches below persist before throwing, so the
    // catch rethrows an already-persisted failure untouched: step names are
    // unique per Execution, so exactly one persist-failure-v1 runs.
    let terminalWritten = false;
    try {
      // startedMs is captured inside the shared prepare Operation
      // (replay-memoized), never at the top of run: wall-clock reads outside
      // step.do fail the contract.
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, smokeSaga, parseSmokeInput));
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
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, written.error));
        terminalWritten = true;
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
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, verified.error));
        terminalWritten = true;
        throw new NonRetryableError(verified.error.code);
      }
      const output: SmokeResult = verified.result.shaped;
      await step.do("persist-success-v1", async () => {
        await completeExecution(ctx.db, id, output);
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

registerSagaDef(smokeSagaDef);
export class SmokeWorkflow extends makeSagaWorkflow(smokeSagaDef) {}
