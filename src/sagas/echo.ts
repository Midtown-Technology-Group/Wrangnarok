// SPDX-License-Identifier: AGPL-3.0
// Stable echo Saga definition (ADR 002): prepare input and call the local
// HTTP echo Integration. Migrated to the ADR 033 interior helpers (issue
// #416): schemaOf, prepareInput, integrationOperation (since #415),
// completeExecution/failSagaExecution, makeSagaWorkflow. Behavior unchanged;
// the timeout-mark-v1 step is gone — failSagaExecution classifies
// ECHO_VENDOR_TIMEOUT as TimedOut inside persist-failure-v1.
import { NonRetryableError } from "cloudflare:workflows";
import { echoSaga, ECHO_INTEGRATION_ID, parseInput, VENDOR_TIMEOUT_MS } from "../domain";
import type { EchoInput, SafeError } from "../domain";
import { defineSaga, schemaOf } from "../saga";
import { integrationOperation, prepareInput } from "../saga-helpers";
import { assertRunExecutionId, completeExecution, failSagaExecution } from "../executions";
import { makeSagaWorkflow } from "./shared";
import { registerSagaDef } from "./registry";

/** Stable echo Saga: prepare input and call the local HTTP echo Integration. */
export const echoSagaDef = defineSaga<EchoInput>({
  id: echoSaga.id,
  name: echoSaga.name,
  revision: echoSaga.revision,
  description: echoSaga.description,
  tags: ["utility", "fixture"],
  requiredIntegrations: [ECHO_INTEGRATION_ID],
  inputSchema: schemaOf({ message: "string" }, ["message"]),
  outputSchema: schemaOf({ message: "string" }, ["message"]),
  parse: parseInput,
  run: async (ctx, step): Promise<EchoInput> => {
    const id = assertRunExecutionId(ctx.executionId);
    // The expected-failure branch below persists before throwing, so the
    // catch rethrows an already-persisted failure untouched: step names are
    // unique per Execution, so exactly one persist-failure-v1 runs.
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, echoSaga, parseInput));
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
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, outcome.error));
        terminalWritten = true;
        throw new NonRetryableError(outcome.error.code);
      }
      const output = outcome.result;
      // Native wait primitive. Deliberately not a product Operation: not every
      // infrastructure checkpoint is ExecutionHistory.
      await step.sleep("settle-wait-v1", "1 second");
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

registerSagaDef(echoSagaDef);
export class EchoWorkflow extends makeSagaWorkflow(echoSagaDef) {}
