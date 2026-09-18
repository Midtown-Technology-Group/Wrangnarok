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
import { freezeBinding, loadFrozenBinding, previewCapability } from "./capabilities";
import type { FrozenCapabilityBinding } from "./capabilities";
import type { IdentityAdapter } from "./adapters/identity";
import { scrubExecutionError } from "./secrets";
import { withOperation } from "./saga";
import type { SagaDefinition, SagaEventContext, SagaSecrets } from "./saga";
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
   * Connection, the secret handle, the derived deadline, and the stable
   * outbound operation ID. One convention across all Sagas (ADR-033-4):
   * echo-style legs use connection/deadline/operationId, ninjaorgs-style
   * legs use connection/secrets/deadline — every leg takes the same four
   * and each Action adapts inside. Saga input, account mappings, and
   * execution identity close over from the author. */
  readonly call: (connection: Connection, secrets: SagaSecrets, deadline: number, operationId: string) => Promise<T>;
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
    // The secret handle passes straight through the Action boundary —
    // presence is enforced inside the Action, so legs never branch on
    // credentials. Runs inside step.do at the call site, so reading
    // ctx.secrets here keeps the determinism contract.
    result = await call(connection, ctx.secrets, deadline, `${id}-${stepOrg.operationId}`);
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

/** What one capability-routed call receives: the Adapter resolved from the
 * frozen binding's Integration plus the Adapter ports (resolved directory
 * Connection and the lazy Transport loader). The Saga names neither. */
export interface CapabilityCall {
  readonly adapter: IdentityAdapter;
  readonly directory: { readonly endpoint: string };
  readonly loadTransport: () => Promise<{
    readonly connection: { readonly endpoint: string };
    readonly secrets: SagaSecrets;
  }>;
  readonly frozen: FrozenCapabilityBinding;
}
export interface CapabilityOperationOptions<T> {
  /** Durable step name, e.g. "identity-provision-v1". Also the Operation row name. */
  readonly op: string;
  /** Operation position within the Execution's history. */
  readonly position: number;
  /** Semantic capability requested, e.g. "identity.primary". Must be declared
   * on the Saga definition: undeclared capability access is author misuse
   * and throws, mirroring integrationOperation's optional-access guard. */
  readonly capability: string;
  /** Adapter lookup keyed by the frozen binding's Integration id —
   * environment state, never an org/provider branch in Saga source. */
  readonly adapterFor: (integrationId: string) => IdentityAdapter;
  /** Integration default deadline; the effective deadline still resolves
   * inside the helper from Integration default + Execution policy snapshot
   * (never an author-passed number). */
  readonly vendorDefaultMs: number;
  /** Fixed-shape code/message for non-Fault transport failures. Faults pass
   * through with their own (scrubbed) code. */
  readonly failureCode: string;
  readonly failureMessage: string;
  /** The Adapter invocation only: receives the capability call, the secret
   * handle, the derived deadline, and the stable outbound operation ID. */
  readonly call: (binding: CapabilityCall, secrets: SagaSecrets, deadline: number, operationId: string) => Promise<T>;
}

/** The capability-routed step interior (issue #262): begin, applied-policy
 * deadline lookup, lazy-on-first-use capability resolution with frozen
 * Execution metadata, Adapter selection from the frozen binding, Fault
 * mapping, finish, and {ok,...} shaping. Must run inside step.do(op, ...) so
 * the determinism scanner keeps working unchanged. Takes no `step` and no
 * required list: required-vs-optional semantics derive from the Saga
 * definition's requiredCapabilities. */
export async function capabilityOperation<T>(
  ctx: SagaEventContext,
  def: Pick<SagaDefinition<unknown>, "requiredCapabilities">,
  prepared: Pick<PreparedExecution<unknown>, "orgCtx">,
  options: CapabilityOperationOptions<T>,
): Promise<IntegrationOutcome<T>> {
  const { op, position, capability, vendorDefaultMs, failureCode, failureMessage, call } = options;
  const id = ctx.executionId;
  await beginOperation(ctx.db, id, op, position);
  const deadline = vendorDeadlineMs(await loadExecutionPolicy(ctx.db, id), vendorDefaultMs);
  const stepOrg = withOperation(prepared.orgCtx, op);
  const declared = def.requiredCapabilities ?? [];
  if (!declared.includes(capability)) {
    throw new NonRetryableError("Unexpected undeclared capability access.");
  }
  try {
    let frozen = await loadFrozenBinding(ctx.db, id, capability);
    if (!frozen) {
      const preview = await previewCapability(ctx.db, stepOrg.orgId, capability, declared);
      if (!preview.found) {
        if (!preview.declared) throw new NonRetryableError("Unexpected undeclared capability access.");
        return { ok: false as const, error: preview.error };
      }
      const adapter = options.adapterFor(preview.preview.connection.integrationId);
      frozen = await freezeBinding(
        ctx.db,
        id,
        preview.preview,
        { id: adapter.id, revision: adapter.revision, transport: adapter.transport },
        op,
      );
    }
    const snap = frozen;
    let transport: { readonly connection: { readonly endpoint: string }; readonly secrets: SagaSecrets } | null = null;
    const adapter = options.adapterFor(snap.integrationId);
    // The frozen record carries identity, not a live endpoint copy: the
    // directory endpoint re-reads from the still-existing Connection row
    // under the Execution's own org predicate. A deleted row fails closed
    // here (the auditor still has the frozen identity); a merely disabled
    // row keeps serving this run per the ADR disabled rule.
    const directoryEndpoint = await readFrozenEndpoint(ctx.db, id, snap);
    if (directoryEndpoint === null) {
      return {
        ok: false as const,
        error: {
          code: "CAPABILITY_BINDING_CHANGED",
          message: "The capability binding changed during this Execution; cancel and re-run.",
        },
      };
    }
    const binding: CapabilityCall = {
      adapter,
      directory: { endpoint: directoryEndpoint },
      loadTransport: async () => {
        if (transport) return transport;
        const transportIntegrationId = adapter.transportIntegrationId;
        if (!transportIntegrationId) {
          throw new Fault(500, "TRANSPORT_NOT_SUPPORTED", "This Adapter declares no execution Transport.");
        }
        const resolved = await resolveConnection(ctx.db, stepOrg, transportIntegrationId, []);
        if (!resolved.found) {
          throw new Fault(
            424,
            "TRANSPORT_REQUIREMENT_UNSATISFIED",
            "This Organization has no Connection for the Adapter Transport.",
          );
        }
        transport = { connection: { endpoint: resolved.connection.endpoint }, secrets: ctx.secrets };
        return transport;
      },
      frozen: snap,
    };
    const result = await call(binding, ctx.secrets, deadline, `${id}-${stepOrg.operationId}`);
    await finishOperation(ctx.db, id, op, result);
    return { ok: true as const, result };
  } catch (error) {
    const safe =
      error instanceof Fault
        ? scrubExecutionError({ code: error.code, message: error.message }, id)
        : { code: failureCode, message: failureMessage };
    return { ok: false as const, error: safe };
  }
}

/** Re-read the frozen binding's directory endpoint from the Connection row
 * it froze from. The org comes from the immutable Execution row (never from
 * the frozen record, never from caller input); the row lookup is predicated
 * on both id and org so a cross-org row can never satisfy it. */
async function readFrozenEndpoint(
  db: D1Database,
  executionId: string,
  snap: FrozenCapabilityBinding,
): Promise<string | null> {
  try {
    const execution = await db
      .prepare("SELECT org_id FROM executions WHERE id=?")
      .bind(executionId)
      .first<{ org_id: string }>();
    if (!execution) return null;
    const row = await db
      .prepare("SELECT endpoint FROM connections WHERE id=? AND org_id=?")
      .bind(snap.connectionId, execution.org_id)
      .first<{ endpoint: string }>();
    return row?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Structured outcome of one optional provider-direct call: success carries
 * the result, declared-but-missing carries the safe error, and
 * undeclared-missing skips without throwing so escape-hatch legs stay green
 * outside their home stack. */
export type OptionalIntegrationOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: SafeError }
  | { readonly skipped: true };

export interface OptionalIntegrationOperationOptions<T> {
  /** Durable step name, e.g. "entra-license-v1". Also the Operation row name. */
  readonly op: string;
  /** Operation position within the Execution's history. */
  readonly position: number;
  /** Stable Integration UUID called directly (the escape-hatch stack). */
  readonly integrationId: string;
  /** Integration default deadline; the effective deadline still resolves
   * inside the helper from Integration default + Execution policy snapshot. */
  readonly vendorDefaultMs: number;
  /** Fixed-shape code/message for non-Fault transport failures. */
  readonly failureCode: string;
  readonly failureMessage: string;
  /** The Integration Action invocation only: receives the resolved
   * Connection, the secret handle, the derived deadline, and the stable
   * outbound operation ID. */
  readonly call: (connection: Connection, secrets: SagaSecrets, deadline: number, operationId: string) => Promise<T>;
}

/** The optional provider-direct step interior (issue #262, ADR TBD §1
 * escape hatches): the same interior as integrationOperation, except an
 * undeclared-missing Connection skips instead of throwing. Must run inside
 * step.do(op, ...). Required-vs-optional derives from the Saga definition:
 * call sites pass no required list. */
export async function optionalIntegrationOperation<T>(
  ctx: SagaEventContext,
  def: Pick<SagaDefinition<unknown>, "requiredIntegrations">,
  prepared: Pick<PreparedExecution<unknown>, "orgCtx">,
  options: OptionalIntegrationOperationOptions<T>,
): Promise<OptionalIntegrationOutcome<T>> {
  const { op, position, integrationId, vendorDefaultMs, failureCode, failureMessage, call } = options;
  const id = ctx.executionId;
  await beginOperation(ctx.db, id, op, position);
  const deadline = vendorDeadlineMs(await loadExecutionPolicy(ctx.db, id), vendorDefaultMs);
  const stepOrg = withOperation(prepared.orgCtx, op);
  const resolved = await resolveConnection(ctx.db, stepOrg, integrationId, def.requiredIntegrations);
  if (!resolved.found && !resolved.declared) {
    await finishOperation(ctx.db, id, op, { skipped: true });
    return { skipped: true as const };
  }
  if (!resolved.found) return { ok: false as const, error: resolved.error };
  const connection = resolved.connection;
  let result: T;
  try {
    result = await call(connection, ctx.secrets, deadline, `${id}-${stepOrg.operationId}`);
  } catch (error) {
    const safe =
      error instanceof Fault
        ? scrubExecutionError({ code: error.code, message: error.message }, id)
        : { code: failureCode, message: failureMessage };
    return { ok: false as const, error: safe };
  }
  await finishOperation(ctx.db, id, op, result);
  return { ok: true as const, result };
}
