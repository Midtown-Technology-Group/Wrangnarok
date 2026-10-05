// SPDX-License-Identifier: AGPL-3.0
// Stable hello-parent Saga definition (RUN-02, ADR 018): the nested
// invocation demo. Migrated to the ADR 033 interior helpers (issue #416):
// schemaOf, prepareInput, completeExecution/failSagaExecution,
// makeSagaWorkflow. Behavior unchanged: prepare input, dispatch the hello
// Saga as an authorized child with typed input, await its JSON output, and
// persist the greeting plus the child lineage. A child failure is actionable
// (CHILD_FAILED) and can never become fabricated parent success.
import { NonRetryableError } from "cloudflare:workflows";
import { Fault, helloParentSaga, helloSaga, parseHelloParentInput } from "../domain";
import type { HelloParentResult, HelloResult, SafeError } from "../domain";
import { defineSaga, schemaOf } from "../saga";
import {
  assertRunExecutionId,
  beginOperation,
  completeExecution,
  failSagaExecution,
  finishOperation,
} from "../executions";
import { prepareInput } from "../saga-helpers";
import { makeSagaWorkflow } from "./shared";
import { registerSagaDef } from "./registry";

/** Map a dispatch/await failure to a persistable SafeError. Faults keep
 * their actionable code/message; anything else keeps the generic marker so
 * the parent can never invent success from an unknown failure. */
function toSafeChildError(error: unknown): SafeError {
  if (error instanceof Fault) return { code: error.code, message: error.message };
  return {
    code: "EXECUTION_FAILED",
    message: "The Execution could not complete. Inspect local runtime diagnostics.",
  };
}

/** Stable hello-parent Saga: invoke hello as a child and await its greeting. */
export const helloParentSagaDef = defineSaga<HelloParentResult>({
  id: helloParentSaga.id,
  name: helloParentSaga.name,
  revision: helloParentSaga.revision,
  description: helloParentSaga.description,
  tags: ["examples", "children"],
  requiredIntegrations: [],
  inputSchema: schemaOf({ name: "string", childKey: "string" }, ["name"]),
  outputSchema: schemaOf({ greeting: "string", name: "string", childExecutionId: "string" }, [
    "greeting",
    "name",
    "childExecutionId",
  ]),
  parse: parseHelloParentInput,
  run: async (ctx, step): Promise<HelloParentResult> => {
    const id = assertRunExecutionId(ctx.executionId);
    // A step.do boundary rehydrates a thrown Fault as a plain Error (the
    // engine rebuilds it from String(error), dropping the code), so an
    // outer catch can only persist the generic marker. Dispatch/await
    // faults are therefore mapped to SafeError outcomes INSIDE their step
    // callbacks — while the Fault is intact — persisted there, and only the
    // safe code crosses the boundary as a NonRetryableError. terminalWritten
    // keeps failure persistence single-writer like the echo Saga.
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareInput(ctx, helloParentSaga, parseHelloParentInput),
      );
      // Child dispatch is a convergent Operation: the deterministic child ID
      // makes retries safe, so this step joins the checkpoint retry ceiling
      // via the child-dispatch- prefix rule in stepRetryLimit.
      const dispatched = await step.do("child-dispatch-invoke-v1", async () => {
        await beginOperation(ctx.db, id, "child-dispatch-invoke-v1", 1);
        try {
          const receipt = await ctx.children.invoke(
            helloSaga.id,
            { name: prepared.input.name },
            prepared.input.childKey === undefined ? undefined : { key: prepared.input.childKey },
          );
          await finishOperation(ctx.db, id, "child-dispatch-invoke-v1", receipt);
          return { ok: true as const, receipt };
        } catch (error) {
          const raw = toSafeChildError(error);
          await failSagaExecution(ctx.db, id, raw);
          terminalWritten = true;
          return { ok: false as const, raw };
        }
      });
      if (!dispatched.ok) throw new NonRetryableError(dispatched.raw.code);
      // The await is a read loop over the child D1 row (retry limit 0):
      // terminal child state resolves here, never from native introspection.
      // Recorded as an Operation so ExecutionHistory shows the wait.
      const greeted = await step.do("child-await-invoke-v1", async () => {
        await beginOperation(ctx.db, id, "child-await-invoke-v1", 2);
        try {
          const result = await ctx.children.awaitResult<HelloResult>(dispatched.receipt);
          await finishOperation(ctx.db, id, "child-await-invoke-v1", result);
          return { ok: true as const, result };
        } catch (error) {
          const raw = toSafeChildError(error);
          await failSagaExecution(ctx.db, id, raw);
          terminalWritten = true;
          return { ok: false as const, raw };
        }
      });
      if (!greeted.ok) throw new NonRetryableError(greeted.raw.code);
      const output: HelloParentResult = {
        greeting: greeted.result.greeting,
        name: greeted.result.name,
        childExecutionId: dispatched.receipt.executionId,
      };
      await step.do("persist-success-v1", () => completeExecution(ctx.db, id, output));
      return output;
    } catch (error) {
      // Child faults are already persisted above with their actionable
      // code/message: rethrow untouched, never the generic marker. Anything
      // else keeps the generic marker so the parent can never invent success
      // from an unknown failure.
      if (terminalWritten) throw error;
      const raw = toSafeChildError(error);
      await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, raw));
      throw new NonRetryableError(raw.code);
    }
  },
});

registerSagaDef(helloParentSagaDef);
export class HelloParentWorkflow extends makeSagaWorkflow(helloParentSagaDef) {}
