// SPDX-License-Identifier: AGPL-3.0
// Stable hello Saga definition (ADR 002): migration pilot for issue #119,
// re-authored from workspace `workflows/sample/hello_world.py`. Prepare input
// plus a pure greeting transform: no Integration, no Connection, no fetch.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { EXECUTION_ID, helloSaga, parseHelloInput } from "../domain";
import type { ExecutionParams, HelloResult, SafeError } from "../domain";
import { defineSaga } from "../saga";
import { appendAuthorLog } from "../logs";
import { scrubExecutionError, scrubExecutionValue } from "../secrets";
import { beginOperation, failExecution, finishOperation, prepareExecution } from "../executions";
import { executeSaga } from "./shared";

/** Stable hello Saga: prepare input plus a pure greeting transform. */
export const helloSagaDef = defineSaga<HelloResult>({
  id: helloSaga.id,
  name: helloSaga.name,
  revision: helloSaga.revision,
  description: helloSaga.description,
  tags: ["examples", "pilot"],
  requiredIntegrations: [],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({ name: Object.freeze({ type: "string" }) }),
    required: Object.freeze(["name"]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      greeting: Object.freeze({ type: "string" }),
      name: Object.freeze({ type: "string" }),
    }),
    required: Object.freeze(["greeting", "name"]),
    additionalProperties: false,
  }),
  parse: parseHelloInput,
  run: async (ctx, step): Promise<HelloResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, helloSaga.id, helloSaga.revision, parseHelloInput),
      );
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
        expectedFailure = greeted.error;
        throw new NonRetryableError(greeted.error.code);
      }
      const output: HelloResult = greeted.result;
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
      const raw: SafeError = expectedFailure ?? {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      const safe: SafeError = scrubExecutionError(raw, id);
      await step.do("persist-failure-v1", () => failExecution(ctx.db, id, safe));
      throw new NonRetryableError(safe.code);
    }
  },
});

export class HelloWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<HelloResult> {
    return executeSaga(this.env, event, step, helloSagaDef);
  }
}
