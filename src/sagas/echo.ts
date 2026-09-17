// SPDX-License-Identifier: AGPL-3.0
// Stable echo Saga definition (ADR 002): prepare input and call the local
// HTTP echo Integration. Moved verbatim from src/sagas.ts; no behavior change.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import { echoSaga, ECHO_INTEGRATION_ID, parseInput, VENDOR_TIMEOUT_MS } from "../domain";
import type { EchoInput, ExecutionParams, SafeError } from "../domain";
import { defineSaga } from "../saga";
import { integrationOperation } from "../saga-helpers";
import { scrubExecutionError } from "../secrets";
import {
  assertRunExecutionId,
  failExecution,
  persistRunFailure,
  persistRunSuccess,
  prepareExecution,
} from "../executions";
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
    const id = assertRunExecutionId(ctx.executionId);
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, echoSaga.id, echoSaga.revision, parseInput),
      );
      // ADR-033-4: the Integration-step interior lives in
      // integrationOperation, which derives required-vs-optional from the
      // Saga definition plus the integration ID — the call site passes no
      // required list and branches on no required/optional shape.
      const outcome = await step.do("echo-http-v1", () =>
        integrationOperation(ctx, echoSagaDef, prepared, {
          op: "echo-http-v1",
          position: 1,
          integrationId: ECHO_INTEGRATION_ID,
          vendorDefaultMs: VENDOR_TIMEOUT_MS,
          failureCode: "ECHO_INTEGRATION_FAILED",
          failureMessage: "The echo Integration could not complete.",
          call: (connection, _secrets, deadline, operationId) =>
            ctx.integrations.echo.echo(connection, prepared.input, operationId, deadline),
        }),
      );
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
      await step.do("persist-success-v1", () => persistRunSuccess(ctx.db, id, output));
      return output;
    } catch {
      return persistRunFailure(ctx, step, id, expectedFailure, timedOut);
    }
  },
});

export class EchoWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<EchoInput> {
    return executeSaga(this.env, event, step, echoSagaDef);
  }
}
