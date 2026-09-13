// SPDX-License-Identifier: AGPL-3.0
// Stable ninjaone-echo-digest Saga definition (ADR 002, Phase 2): read-only
// NinjaOne census shaped into a bounded digest and echoed through the echo
// Integration. Moved verbatim from src/sagas.ts; no behavior change.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Bindings } from "../bindings";
import {
  digestSaga,
  ECHO_INTEGRATION_ID,
  EXECUTION_ID,
  Fault,
  NINJA_INTEGRATION_ID,
  NINJA_TIMEOUT_MS,
  parseDigestInput,
  shapeDigest,
  VENDOR_TIMEOUT_MS,
} from "../domain";
import { parseStoredPolicy } from "../executions";
import { vendorDeadlineMs } from "../domain";
import type { DigestResult, EchoInput, ExecutionParams, NinjaOrgsResult, SafeError } from "../domain";
import { defineSaga, withOperation } from "../saga";
import { scrubExecutionError, scrubExecutionValue } from "../secrets";
import { beginOperation, failExecution, finishOperation, prepareExecution, resolveConnection } from "../executions";
import { executeSaga } from "./shared";

/** Stable ninjaone-echo-digest Saga (Phase 2): read-only NinjaOne census
 * shaped into a bounded digest and echoed through the echo Integration. Both
 * vendor steps resolve retries 0 via stepRetryLimit; the digest is a pure
 * transform of the census and never carries secrets or vendor bodies. */
export const digestSagaDef = defineSaga<DigestResult>({
  id: digestSaga.id,
  name: digestSaga.name,
  revision: digestSaga.revision,
  description: digestSaga.description,
  tags: ["ninjaone", "echo", "read-only"],
  requiredIntegrations: [NINJA_INTEGRATION_ID, ECHO_INTEGRATION_ID],
  inputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    required: Object.freeze([]),
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: "object" as const,
    properties: Object.freeze({
      organizationCount: Object.freeze({ type: "number" }),
      echoed: Object.freeze({ type: "object" }),
    }),
    required: Object.freeze(["organizationCount", "echoed"]),
    additionalProperties: false,
  }),
  parse: parseDigestInput,
  run: async (ctx, step): Promise<DigestResult> => {
    const id = ctx.executionId;
    if (typeof id !== "string" || !EXECUTION_ID.test(id)) {
      throw new NonRetryableError("Invalid local Execution invocation.");
    }
    let expectedFailure: SafeError | undefined;
    let timedOut = false;
    try {
      const prepared = await step.do("prepare-input-v1", () =>
        prepareExecution(ctx.db, id, digestSaga.id, digestSaga.revision, parseDigestInput),
      );
      const orgs = await step.do("ninja-list-orgs-v1", async () => {
        await beginOperation(ctx.db, id, "ninja-list-orgs-v1", 1);
        // RUN-01 (ADR 018): vendor deadline from the Execution snapshot.
        const appliedNinja = await ctx.db
          .prepare("SELECT policy_json FROM executions WHERE id=?")
          .bind(id)
          .first<{ policy_json: string | null }>()
          .catch(() => null);
        const ninjaDeadline = vendorDeadlineMs(
          appliedNinja?.policy_json == null ? parseStoredPolicy(null) : parseStoredPolicy(appliedNinja.policy_json),
          NINJA_TIMEOUT_MS,
        );
        // Phase 1b (ADR 010): exact-org resolution through the step's own
        // OrgCtx. NinjaOne is declared required, so a miss fails loud with 424.
        const stepOrg = withOperation(prepared.orgCtx, "ninja-list-orgs-v1");
        const resolved = await resolveConnection(
          ctx.db,
          stepOrg,
          NINJA_INTEGRATION_ID,
          digestSagaDef.requiredIntegrations,
        );
        if (!resolved.found && !resolved.declared) {
          // Unreachable while NinjaOne stays declared required: optional
          // access would resolve to None here instead of failing.
          throw new NonRetryableError("Unexpected optional Integration access.");
        }
        if (!resolved.found) return { ok: false as const, error: resolved.error };
        const connection = resolved.connection;
        // Credential use stays behind the Action boundary: the secret handle
        // passes straight through and listOrganizations enforces presence, so
        // this step never branches on credentials.
        let result: NinjaOrgsResult;
        try {
          result = await ctx.integrations.ninjaone.listOrganizations(connection, ctx.secrets, id, ninjaDeadline);
        } catch (error) {
          const safe =
            error instanceof Fault
              ? scrubExecutionError({ code: error.code, message: error.message }, id)
              : { code: "NINJA_INTEGRATION_FAILED", message: "The NinjaOne Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "ninja-list-orgs-v1", result);
        return { ok: true as const, result };
      });
      if (!orgs.ok) {
        expectedFailure = orgs.error;
        timedOut = orgs.error.code === "NINJA_VENDOR_TIMEOUT";
        if (timedOut) {
          // Explicit timeout step, same posture as the echo leg: a slow
          // NinjaOne vendor surfaces TimedOut, never an inferred failure.
          const failure: SafeError = scrubExecutionError(orgs.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(orgs.error.code);
      }
      const echoed = await step.do("echo-digest-v1", async () => {
        await beginOperation(ctx.db, id, "echo-digest-v1", 2);
        // RUN-01 (ADR 018): vendor deadline from the Execution snapshot.
        const appliedEcho = await ctx.db
          .prepare("SELECT policy_json FROM executions WHERE id=?")
          .bind(id)
          .first<{ policy_json: string | null }>()
          .catch(() => null);
        const echoDeadline = vendorDeadlineMs(
          appliedEcho?.policy_json == null ? parseStoredPolicy(null) : parseStoredPolicy(appliedEcho.policy_json),
          VENDOR_TIMEOUT_MS,
        );
        // Phase 1b (ADR 010): exact-org resolution through the step's own
        // OrgCtx. Echo is declared required, so a miss fails loud with 424.
        // The outbound key derives from the step ctx, so the stable operation
        // ID and the downstream Idempotency-Key agree.
        const stepOrg = withOperation(prepared.orgCtx, "echo-digest-v1");
        const resolved = await resolveConnection(
          ctx.db,
          stepOrg,
          ECHO_INTEGRATION_ID,
          digestSagaDef.requiredIntegrations,
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
            shapeDigest(orgs.result),
            `${id}-${stepOrg.operationId}`,
            echoDeadline,
          );
        } catch (error) {
          const safe =
            error instanceof Fault
              ? scrubExecutionError({ code: error.code, message: error.message }, id)
              : { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." };
          return { ok: false as const, error: safe };
        }
        await finishOperation(ctx.db, id, "echo-digest-v1", result);
        return { ok: true as const, result };
      });
      if (!echoed.ok) {
        expectedFailure = echoed.error;
        timedOut = echoed.error.code === "ECHO_VENDOR_TIMEOUT";
        if (timedOut) {
          const failure: SafeError = scrubExecutionError(echoed.error, id);
          await step.do("timeout-mark-v1", () => failExecution(ctx.db, id, failure, "TimedOut"));
        }
        throw new NonRetryableError(echoed.error.code);
      }
      const output: DigestResult = { organizationCount: orgs.result.organizationCount, echoed: echoed.result };
      // Native wait primitive, same posture as echo: infrastructure checkpoint,
      // not a product Operation.
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

export class NinjaEchoDigestWorkflow extends WorkflowEntrypoint<Bindings, ExecutionParams> {
  async run(event: WorkflowEvent<ExecutionParams>, step: WorkflowStep): Promise<DigestResult> {
    return executeSaga(this.env, event, step, digestSagaDef);
  }
}
