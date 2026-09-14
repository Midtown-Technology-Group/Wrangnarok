// SPDX-License-Identifier: AGPL-3.0
// Stable hello-parent Saga definition (RUN-02, ADR 018): the nested
// invocation demo. Prepare input, dispatch the hello Saga as an authorized
// child with typed input, await its JSON output, and persist the greeting
// plus the child lineage. A child failure is actionable (CHILD_FAILED) and
// can never become fabricated parent success.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { EXECUTION_ID, Fault, helloParentSaga, helloSaga, parseHelloParentInput } from "../domain";
import type { ExecutionParams, HelloParentResult, HelloResult, SafeError } from "../domain";
import { defineSaga } from "../saga";
import { scrubExecutionError, scrubExecutionValue } from "../secrets";
import { beginOperation, failExecution, finishOperation, prepareExecution } from "../executions";
import { executeSaga } from "./shared";

/** Stable hello-parent Saga: invoke hello as a child and await its greeting. */
export const helloParentSagaDef = defineSaga<HelloParentResult>({
  id: helloParentSaga.id,
  name: helloParentSaga.name,
  revision: helloParentSaga.revision,
  description: helloParentSaga.description,
  tags: ["examples", "children"],
  requiredIntegrations: [],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      name: Object.freeze({ type: "string" }),
      childKey: Object.freeze({ type: "string" }),
    }),
    required: Object.freeze(["name"]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      greeting: Object.freeze({ type: "string" }),
      name: Object.freeze({ type: "string" }),
      childExecutionId: Object.freeze({ type: "string" }),
    }),
    required: Object.freeze(["greeting", "name", "childExecutionId"]),
    additionalProperties: false,
  }),
  parse: parseHelloParentInput,
  run: async (ctx, step): Promise<HelloParentResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, helloParentSaga.id, helloParentSaga.revision, parseHelloParentInput),
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
      await step.do("persist-success-v1", async () => {
        await ctx.db
          .prepare(
            "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
          )
          .bind(new Date().toISOString(), JSON.stringify(scrubExecutionValue(output, id)), id)
          .run();
      });
      return output;
    } catch (error) {
      // Child faults are actionable SafeErrors (CHILD_FAILED,
      // CHILD_DISPATCH_UNCONFIRMED, ...): persist their code/message, never
      // the generic marker. Anything else keeps the generic marker so the
      // parent can never invent success from an unknown failure.
      const raw: SafeError =
        error instanceof Fault
          ? { code: error.code, message: error.message }
          : {
              code: "EXECUTION_FAILED",
              message: "The Execution could not complete. Inspect local runtime diagnostics.",
            };
      const safe: SafeError = scrubExecutionError(raw, id);
      await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      throw new NonRetryableError(safe.code);
    }
  },
});

export class HelloParentWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<HelloParentResult> {
    return executeSaga(this.env, event, step, helloParentSagaDef);
  }
}
