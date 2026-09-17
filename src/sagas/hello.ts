// SPDX-License-Identifier: AGPL-3.0
// Stable hello Saga definition (ADR 002): migration pilot for issue #119,
// re-authored from workspace `workflows/sample/hello_world.py`. Migrated to
// the ADR 033 interior helpers (issue #416): schemaOf, prepareInput,
// completeExecution/failSagaExecution, makeSagaWorkflow. Behavior unchanged:
// prepare input plus a pure greeting transform — no Integration, no
// Connection, no fetch.
import { NonRetryableError } from "cloudflare:workflows";
import { helloSaga, parseHelloInput } from "../domain";
import type { HelloResult, SafeError } from "../domain";
import { defineSaga, schemaOf } from "../saga";
import { appendAuthorLog } from "../logs";
import {
  assertRunExecutionId,
  beginOperation,
  completeExecution,
  failSagaExecution,
  finishOperation,
} from "../executions";
import { prepareInput } from "../saga-helpers";
import { makeSagaWorkflow } from "./shared";

/** Stable hello Saga: prepare input plus a pure greeting transform. */
export const helloSagaDef = defineSaga<HelloResult>({
  id: helloSaga.id,
  name: helloSaga.name,
  revision: helloSaga.revision,
  description: helloSaga.description,
  tags: ["examples", "pilot"],
  requiredIntegrations: [],
  inputSchema: schemaOf({ name: "string" }, ["name"]),
  outputSchema: schemaOf({ greeting: "string", name: "string" }, ["greeting", "name"]),
  parse: parseHelloInput,
  run: async (ctx, step): Promise<HelloResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    // The greet-failure branch below persists before throwing, so the catch
    // rethrows an already-persisted failure untouched: step names are unique
    // per Execution, so exactly one persist-failure-v1 runs.
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, helloSaga, parseHelloInput));
      const greeted = await step.do(
        "greet-v1",
        async (): Promise<{ ok: true; result: HelloResult } | { ok: false; error: SafeError }> => {
          await beginOperation(ctx.db, id, "greet-v1", 1);
          const result: HelloResult = {
            greeting: `Hello, ${prepared.input.name}!`,
            name: prepared.input.name,
          };
          // OBS-02 progress proof: the pilot emits one bounded PROGRESS row
          // plus one INFO row from inside step.do(). Attribution comes from
          // the immutable Execution row; SEC-01 scrubbing runs before the
          // write, so a name carrying a secret substring can never persist.
          await appendAuthorLog(ctx.db, id, {
            level: "PROGRESS",
            message: `Greeting ${prepared.input.name}`,
          });
          await appendAuthorLog(ctx.db, id, {
            level: "INFO",
            message: `Hello Saga greeted ${prepared.input.name}`,
            data: { name: prepared.input.name },
          });
          await finishOperation(ctx.db, id, "greet-v1", result);
          return { ok: true as const, result };
        },
      );
      if (!greeted.ok) {
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, greeted.error));
        terminalWritten = true;
        throw new NonRetryableError(greeted.error.code);
      }
      const output: HelloResult = greeted.result;
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

export class HelloWorkflow extends makeSagaWorkflow(helloSagaDef) {}
