// SPDX-License-Identifier: AGPL-3.0
// Thin interior helpers over the defineSaga contract (ADR-033-1).
//
// These own the repetitive *interior* of durable Operations while the Saga
// owns every visible step.do/step.sleep boundary: helpers never receive
// `step` and are always invoked *inside* a step callback (or a pure,
// non-durable section). No policy knobs, no peer contract, no codegen.
import { NonRetryableError } from "cloudflare:workflows";
import { Fault, vendorDeadlineMs } from "./domain";
import type { SafeError } from "./domain";
import type { Connection } from "./integrations";
import { scrubExecutionError } from "./secrets";
import { withOperation } from "./saga";
import type { SagaDefinition, SagaEventContext } from "./saga";
import {
  beginOperation,
  finishOperation,
  loadExecutionPolicy,
  prepareExecution,
  resolveConnection,
} from "./executions";
import type { PreparedExecution } from "./executions";

/** The prepare-input-v1 interior (ADR-033-1), always invoked as
 * `step.do("prepare-input-v1", () => prepareInput(ctx, saga, parse))`.
 * Takes no `step`: the Saga owns the durable boundary. */
export async function prepareInput<T>(
  ctx: SagaEventContext,
  saga: Pick<SagaDefinition<unknown>, "id" | "revision">,
  parse: (value: unknown) => T,
): Promise<PreparedExecution<T>> {
  return prepareExecution(ctx.db, ctx.executionId, saga.id, saga.revision, parse);
}

/** Structured outcome of one Integration Action call: success carries the
 * result, failure carries the safe (scrubbed, fixed-shape) error for the
 * author's persist-or-throw branch. No exceptions escape except the
 * unreachable optional-access misuse below. */
export type IntegrationOutcome<T> =
  { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: SafeError };

export interface IntegrationOperationOptions<T> {
  /** Durable step name, e.g. "echo-http-v1". Also the Operation row name. */
  readonly op: string;
  /** Operation position within the Execution's history. */
  readonly position: number;
  /** Stable Integration UUID being called. */
  readonly integrationId: string;
  /** Integration default vendor deadline; the effective deadline still
   * resolves inside the helper from Integration default + Execution policy
   * snapshot + platform ceiling (never an author-passed number). */
  readonly vendorDefaultMs: number;
  /** Fixed-shape code/message for non-Fault transport failures. Faults pass
   * through with their own (scrubbed) code — including vendor timeouts,
   * which the author routes until ADR-033-3 centralizes classification. */
  readonly failureCode: string;
  readonly failureMessage: string;
  /** The Integration Action invocation only: receives the resolved
   * Connection, the derived deadline, and the stable outbound operation ID.
   * Input, secrets, and execution identity close over from the author. */
  readonly call: (connection: Connection, deadline: number, operationId: string) => Promise<T>;
}

/** The Integration-step interior (ADR-033-1): begin, applied-policy deadline
 * lookup, org-scoped Connection resolution, Fault mapping, finish, and
 * {ok,...} shaping. Must run inside step.do(op, ...) so the determinism
 * scanner keeps working unchanged. Takes no `step` and no `required` list:
 * required-vs-optional semantics derive from the Saga definition. */
export async function integrationOperation<T>(
  ctx: SagaEventContext,
  def: Pick<SagaDefinition<unknown>, "requiredIntegrations">,
  prepared: Pick<PreparedExecution<unknown>, "orgCtx">,
  options: IntegrationOperationOptions<T>,
): Promise<IntegrationOutcome<T>> {
  const { op, position, integrationId, vendorDefaultMs, failureCode, failureMessage, call } = options;
  const id = ctx.executionId;
  await beginOperation(ctx.db, id, op, position);
  // RUN-01 (ADR 018, Slice A issue #135): the vendor deadline resolves
  // through the Execution's snapshotted policy (timeout 0 keeps the
  // Integration default). 0 disables only the override. A snapshot read
  // failure throws before any vendor work, never falling back to defaults.
  const deadline = vendorDeadlineMs(await loadExecutionPolicy(ctx.db, id), vendorDefaultMs);
  // Phase 1b (ADR 010): exact-org Connection resolution through the step's
  // own OrgCtx, so the stable operation ID and downstream idempotency agree.
  const stepOrg = withOperation(prepared.orgCtx, op);
  const resolved = await resolveConnection(ctx.db, stepOrg, integrationId, def.requiredIntegrations);
  if (!resolved.found && !resolved.declared) {
    // Unreachable while the Integration stays declared required: optional
    // access would resolve to None here instead of failing.
    throw new NonRetryableError("Unexpected optional Integration access.");
  }
  if (!resolved.found) return { ok: false as const, error: resolved.error };
  const connection = resolved.connection;
  let result: T;
  try {
    result = await call(connection, deadline, `${id}-${stepOrg.operationId}`);
  } catch (error) {
    // Raw transport errors must not leak vendor-shaped text into step
    // results: Faults already carry fixed safe text (scrubbed at the
    // boundary); anything else maps to the generic integration failure.
    const safe =
      error instanceof Fault
        ? scrubExecutionError({ code: error.code, message: error.message }, id)
        : { code: failureCode, message: failureMessage };
    return { ok: false as const, error: safe };
  }
  await finishOperation(ctx.db, id, op, result);
  return { ok: true as const, result };
}
