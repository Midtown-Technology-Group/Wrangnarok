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
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareInput(ctx, helloParentSaga, parseHelloParentInput),
      );
      // Child dispatch is a convergent Operation: the deterministic child ID
      // makes retries safe, so this step joins the checkpoint retry ceiling
      // via the child-dispatch- prefix rule in stepRetryLimit.
      const dispatched = await step.do("child-dispatch-invoke-v1", async () => {
        await beginOperation(ctx.db, id, "child-dispatch-invoke-v1", 1);
        const receipt = await ctx.children.invoke(
          helloSaga.id,
          { name: prepared.input.name },
          prepared.input.childKey === undefined ? undefined : { key: prepared.input.childKey },
        );
        await finishOperation(ctx.db, id, "child-dispatch-invoke-v1", receipt);
        return receipt;
      });
      // The await is a read loop over the child D1 row (retry limit 0):
      // terminal child state resolves here, never from native introspection.
      // Recorded as an Operation so ExecutionHistory shows the wait.
      const greeted = await step.do("child-await-invoke-v1", async () => {
        await beginOperation(ctx.db, id, "child-await-invoke-v1", 2);
        const result = await ctx.children.awaitResult<HelloResult>(dispatched);
        await finishOperation(ctx.db, id, "child-await-invoke-v1", result);
        return result;
      });
      const output: HelloParentResult = {
        greeting: greeted.greeting,
        name: greeted.name,
        childExecutionId: dispatched.executionId,
      };
      await step.do("persist-success-v1", () => completeExecution(ctx.db, id, output));
      return output;
    } catch (error) {
      // Child faults are actionable SafeErrors (CHILD_FAILED,
      // CHILD_DISPATCH_UNCONFIRMED, ...): persist their code/message, never
      // the generic marker. Anything else keeps the generic marker so the
      // parent can never invent success from an unknown failure. The catch
      // is the only persist-failure-v1 writer (no pre-persisting branch
      // above), so no already-persisted guard is needed.
      const raw: SafeError =
        error instanceof Fault
          ? { code: error.code, message: error.message }
          : {
              code: "EXECUTION_FAILED",
              message: "The Execution could not complete. Inspect local runtime diagnostics.",
            };
      await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, raw));
      throw new NonRetryableError(raw.code);
    }
  },
});

export class HelloParentWorkflow extends makeSagaWorkflow(helloParentSagaDef) {}
