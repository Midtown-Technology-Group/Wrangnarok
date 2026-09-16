// SPDX-License-Identifier: AGPL-3.0
// RUN-03 (issue #150, ADR 023): bounded synchronous and data-provider
// execution.
//
// Upstream pins at gobifrost/bifrost@3543c7e:
// - `api/src/models/contracts/executions.py:134-179`: `sync` blocks and
//   returns inline (overriding the persisted mode); `transient` skips
//   database persistence; scheduling rejects both `sync` and inline `code`.
// - `api/src/routers/workflows.py:976-1083`: providers always run sync while
//   honoring the transient flag; ordinary workflows honor `request.sync`.
//   Sync still dispatches through the worker queue and waits on Redis BLPOP,
//   bounded by the workflow timeout plus 60 seconds
//   (`api/src/services/execution/service.py:482-491`); a wait expiry returns
//   `Timeout`, never invented success.
// - `api/src/routers/endpoints.py:212-232`: endpoints dispatch by persisted
//   `execution_mode`, never caller choice.
//
// Cloudflare mapping (ADR 023): a Worker request cannot hold a Redis BLPOP
// wait, and queue-plus-wait is not in-request compute. The local equivalent
// is bounded inline execution of provider-eligible read-only Sagas inside
// the request deadline, plus the same durable Execution receipt the async
// path writes. Provider dispatch never touches a Workflow binding.
import {
  BODY_LIMIT,
  ECHO_INTEGRATION_ID,
  echoSaga,
  ExecutionStatus,
  Fault,
  NINJA_INTEGRATION_ID,
  NINJA_TIMEOUT_MS,
  ninjaSaga,
  VENDOR_TIMEOUT_MS,
} from "./domain";
import type { Principal, SagaDef } from "./domain";
import type { Bindings } from "./bindings";
import {
  admitExecution,
  beginOperation,
  executionIdForProvider,
  failExecution,
  finishOperation,
  loadSagaPolicy,
  policySnapshot,
  resolveConnection,
  visibleExecution,
} from "./executions";
import { buildOrgCtx, withOperation } from "./saga";
import { requireActiveInstall } from "./solutions";
import { scrubExecutionError, scrubExecutionValue } from "./secrets";
import { echo } from "./integrations/echo";
import { listOrganizations } from "./integrations/ninjaone";
import type { EchoInput, NinjaOrgsResult, SafeError } from "./domain";

/** One bounded inline request budget: the tightest proven vendor leg
 * (NINJA_TIMEOUT_MS). The async path has no such ceiling; the provider path
 * trades arbitrary waits for a named 504 with a durable receipt. */
export const PROVIDER_DEADLINE_MS = 5000;

/** Closed provider allowlist (ADR 023): read-only Sagas whose destination
 * behavior is proven. Never caller choice, never Saga source metadata. The
 * echo fixture is eligible only as the local harness proof; production
 * callers use provider Sagas, not the fixture. Digest composes a vendor call
 * plus a mutation-shaped transform, smoke writes verification probes, hello
 * is the migration pilot with no provider contract — all stay async-only. */
const PROVIDER_SAGAS: ReadonlySet<string> = new Set([ninjaSaga.id, echoSaga.id]);

export function isProviderEligible(sagaId: string): boolean {
  return PROVIDER_SAGAS.has(sagaId);
}

/** Parse the provider submission body: `{ sagaId, input }` only, mirroring
 * the async submit gate. `sync` and `transient` are named rejections here
 * (ADR 023): sync is chosen by route, not by flag, and provider mode never
 * skips persistence. The resolver maps a stable Saga UUID to its submission
 * definition (id, name, revision, parse); unknown IDs answer UNKNOWN_SAGA. */
export function parseProviderSubmission(
  value: unknown,
  resolve: (sagaId: string) => SagaDef | undefined,
): { saga: SagaDef; input: unknown; rejected: { sync?: boolean; transient?: boolean } } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(400, "INVALID_SUBMISSION", "Provide a built-in Saga ID and its input only.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["sagaId", "input", "sync", "transient"].includes(key)) {
      throw new Fault(400, "INVALID_SUBMISSION", "Provide a built-in Saga ID and its input only.");
    }
  }
  if (typeof record.sagaId !== "string") {
    throw new Fault(400, "INVALID_SUBMISSION", "Provide a built-in Saga ID and its input only.");
  }
  let saga: SagaDef | undefined;
  try {
    saga = resolve(record.sagaId);
  } catch {
    saga = undefined;
  }
  if (!saga) throw new Fault(400, "UNKNOWN_SAGA", "Provide a built-in Saga ID and its input only.");
  return {
    saga,
    input: saga.parse(record.input),
    rejected: {
      ...(record.sync === undefined ? {} : { sync: record.sync === true }),
      ...(record.transient === undefined ? {} : { transient: record.transient === true }),
    },
  };
}

export interface ProviderOutcome {
  readonly executionId: string;
  readonly sagaId: string;
  readonly sagaName: string;
  readonly status: ExecutionStatus;
  readonly result: unknown;
  readonly durationMs: number;
  readonly dispatch: { inline: true; workflow: false };
  readonly statusUrl: string;
}

/** Bounded inline provider execution: same admission (install gate,
 * idempotency, policy snapshot) as async submit, then the Integration Action
 * runs inside the request deadline and checkpoints terminal state directly.
 * No Workflow binding, no queue, no BLPOP wait. */
export async function runProvider(
  env: Bindings,
  caller: Principal,
  key: string,
  saga: SagaDef,
  input: unknown,
): Promise<ProviderOutcome> {
  if (!isProviderEligible(saga.id)) {
    throw new Fault(
      501,
      "PROVIDER_NOT_SUPPORTED",
      "This Saga runs through the async Execution path only; submit to POST /api/executions and poll the receipt.",
    );
  }
  await requireActiveInstall(env.DB, saga.id, saga.revision, caller.orgId);
  const started = Date.now();
  const id = await executionIdForProvider(caller, key);
  const inputJson = JSON.stringify(input);
  const effective = await loadSagaPolicy(env.DB, caller.orgId, saga.id);
  const policyJson = policySnapshot(effective.policy);
  const inserted = (
    await env.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at,policy_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(
        id,
        saga.id,
        saga.name,
        saga.revision,
        caller.orgId,
        caller.userId,
        inputJson,
        new Date().toISOString(),
        policyJson,
      )
      .run()
  ).meta.changes;
  const row = await visibleExecution(env.DB, id, caller);
  if (row.saga_id !== saga.id || row.input_json !== inputJson) {
    throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This key already identifies different input.");
  }
  try {
    await env.DB.prepare("UPDATE executions SET policy_json=? WHERE id=? AND policy_json IS NULL")
      .bind(policyJson, id)
      .run();
  } catch {
    // Old DB without the column: the snapshot is unavailable, never fatal.
  }
  if (row.status === "Cancelling" || row.status === "Cancelled") {
    throw new Fault(409, "EXECUTION_CANCELLED", "This Execution was cancelled and will not dispatch.");
  }
  if (row.status === "Succeeded" || row.status === "Failed" || row.status === "TimedOut") {
    const terminal = await providerTerminal(env.DB, id, caller);
    return { ...terminal, durationMs: Date.now() - started };
  }
  // Any other non-Pending row (Running, Cancelling) is an in-flight receipt:
  // the second caller gets 409 PROVIDER_IN_FLIGHT naming the poll path, never
  // a 200 with no inline result.
  if (row.status !== "Pending") {
    throw new Fault(409, "PROVIDER_IN_FLIGHT", "This Execution is already running; poll its statusUrl for the result.");
  }
  // Codex #344/#360: the provider path admitted any distinct key while the
  // async path fenced maxConcurrent. The canonical admitExecution decision
  // (shared with submit and child dispatch) owns both arms here too, so a
  // saturated Saga answers 429 before any token fetch or vendor call on any
  // route.
  const gate = await admitExecution(env.DB, caller.orgId, saga.id, id);
  if (gate.refusal) throw gate.refusal;
  // A racing owner cancel still wins below: the Running-mark write is
  // conditional on Pending, so a Cancelling row no-ops into the cancelled
  // fence instead of dispatching inline.
  if (inserted === 0 && row.status === "Pending") {
    // Same-key replay while a previous call is still in flight: the receipt
    // is durable, but there is no inline result to return yet. This is the
    // local equivalent of upstream's queue-plus-wait without inventing a
    // second dispatch: `409 PROVIDER_IN_FLIGHT` names the poll path.
    throw new Fault(409, "PROVIDER_IN_FLIGHT", "This Execution is already running; poll its statusUrl for the result.");
  }
  // Mark Running through the same conditional write the Workflow prepare step
  // owns on the async path. A cancelled row no-ops here and fails below.
  // Provider dispatch never touches a Workflow binding: the durable
  // `dispatched` marker records the inline run instead, so detail reports
  // dispatchConfirmed:true exactly like the async path after createBatch.
  const marked = await env.DB.prepare(
    "UPDATE executions SET status='Running',dispatched=1,started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'",
  )
    .bind(new Date().toISOString(), id)
    .run();
  if (marked.meta.changes === 0) {
    // The conditional mark is the race fence: a concurrent owner cancel or
    // terminal checkpoint already owns the row, so serve its receipt instead
    // of dispatching inline. Re-read the row (never the stale submit copy)
    // and let the terminal/cancelled fences below own the outcome.
    const current = await providerTerminal(env.DB, id, caller);
    if (current.status === "Cancelling" || current.status === "Cancelled") {
      throw new Fault(409, "EXECUTION_CANCELLED", "This Execution was cancelled and will not dispatch.");
    }
    return { ...current, durationMs: Date.now() - started };
  }
  await beginOperation(env.DB, id, "prepare-input-v1", 0);
  await finishOperation(env.DB, id, "prepare-input-v1", input);
  // The provider-inline-v1 row begins Running BEFORE the Action: every
  // failure path below then lands on a live operation row instead of dead
  // writes against a row that does not exist yet. Success closes it at the
  // end; failures mark it Failed alongside the Execution.
  await beginOperation(env.DB, id, "provider-inline-v1", 1);
  const orgCtx = buildOrgCtx(
    {
      id: row.id,
      org_id: row.org_id,
      user_id: row.user_id,
      saga_id: row.saga_id,
      saga_revision: row.saga_revision,
      dispatched: 1,
    },
    "provider-inline-v1",
  );
  const outcome = await runProviderAction(env, saga, input, withOperation(orgCtx, "provider-inline-v1"), id);
  const elapsed = Date.now() - started;
  if (!outcome.ok) {
    if (outcome.timedOut) {
      const failure: SafeError = scrubExecutionError(outcome.error, id);
      await env.DB.prepare(
        "UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'",
      )
        .bind(new Date().toISOString(), JSON.stringify(failure), id)
        .run();
      await failExecution(env.DB, id, failure, "TimedOut");
      throw new Fault(504, "PROVIDER_TIMEOUT", "The provider exceeded its inline deadline; poll the receipt.");
    }
    {
      const failure: SafeError = scrubExecutionError(outcome.error, id);
      await env.DB.prepare(
        "UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'",
      )
        .bind(new Date().toISOString(), JSON.stringify(failure), id)
        .run();
      await failExecution(env.DB, id, failure);
      const terminal = await providerTerminal(env.DB, id, caller);
      return { ...terminal, durationMs: elapsed };
    }
  }
  const resultJson = JSON.stringify(scrubExecutionValue(outcome.result, id));
  if (new TextEncoder().encode(resultJson).byteLength > BODY_LIMIT) {
    const failure: SafeError = {
      code: "PROVIDER_OUTPUT_TOO_LARGE",
      message: "The provider result exceeds its persisted bound.",
    };
    await env.DB.prepare(
      "UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'",
    )
      .bind(new Date().toISOString(), JSON.stringify(failure), id)
      .run();
    await failExecution(env.DB, id, failure);
    throw new Fault(413, "PROVIDER_OUTPUT_TOO_LARGE", "The provider result exceeds its persisted bound.");
  }
  await finishOperation(env.DB, id, "provider-inline-v1", outcome.result);
  await env.DB.prepare(
    "UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=? AND status='Running'",
  )
    .bind(new Date().toISOString(), resultJson, id)
    .run();
  const terminal = await providerTerminal(env.DB, id, caller);
  return { ...terminal, durationMs: Date.now() - started };
}

async function providerTerminal(
  db: D1Database,
  id: string,
  caller: Principal,
): Promise<Omit<ProviderOutcome, "durationMs">> {
  const row = await visibleExecution(db, id, caller);
  return {
    executionId: row.id,
    sagaId: row.saga_id,
    sagaName: row.saga_name,
    status: row.status,
    result: row.result_json ? (JSON.parse(row.result_json) as unknown) : null,
    dispatch: { inline: true, workflow: false },
    statusUrl: `/api/executions/${row.id}`,
  };
}

export type ProviderActionOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly timedOut: true; readonly error: SafeError }
  | { readonly ok: false; readonly timedOut: false; readonly error: SafeError };

async function runProviderAction(
  env: Bindings,
  saga: SagaDef,
  input: unknown,
  orgCtx: ReturnType<typeof withOperation>,
  id: string,
): Promise<ProviderActionOutcome> {
  const deadline = PROVIDER_DEADLINE_MS;
  if (saga.id === ninjaSaga.id) {
    const resolved = await resolveConnection(env.DB, orgCtx, NINJA_INTEGRATION_ID, [NINJA_INTEGRATION_ID]);
    // Both provider Sagas declare their Integration required, so a miss is
    // always the loud 424 declared branch — optional access is unreachable.
    if (!resolved.found && !resolved.declared) {
      throw new Fault(500, "PROVIDER_MISCONFIGURED", "The provider is not configured.");
    }
    if (!resolved.found) return { ok: false, timedOut: false, error: resolved.error };
    try {
      const result: NinjaOrgsResult = await withDeadline(
        listOrganizations(
          resolved.connection,
          { clientId: env.NINJA_CLIENT_ID, clientSecret: env.NINJA_CLIENT_SECRET },
          id,
          Math.min(deadline, NINJA_TIMEOUT_MS),
        ),
        deadline,
      );
      return { ok: true, result };
    } catch (error) {
      return mapActionError(error, id);
    }
  }
  if (saga.id === echoSaga.id) {
    const resolved = await resolveConnection(env.DB, orgCtx, ECHO_INTEGRATION_ID, [ECHO_INTEGRATION_ID]);
    if (!resolved.found && !resolved.declared) {
      throw new Fault(500, "PROVIDER_MISCONFIGURED", "The provider is not configured.");
    }
    if (!resolved.found) return { ok: false, timedOut: false, error: resolved.error };
    try {
      const result: EchoInput = await withDeadline(
        echo(
          resolved.connection,
          input as EchoInput,
          `${id}-provider-inline-v1`,
          Math.min(deadline, VENDOR_TIMEOUT_MS),
        ),
        deadline,
      );
      return { ok: true, result };
    } catch (error) {
      return mapActionError(error, id);
    }
  }
  throw new Fault(
    501,
    "PROVIDER_NOT_SUPPORTED",
    "This Saga runs through the async Execution path only; submit to POST /api/executions and poll the receipt.",
  );
}

/** Map one Action throw onto the provider outcome (exported for direct
 * unit coverage of the mapping table; the route always goes through
 * runProviderAction). */
export function mapActionError(error: unknown, id: string): ProviderActionOutcome {
  if (error instanceof Fault) {
    const safe = scrubExecutionError({ code: error.code, message: error.message }, id);
    if (error.code === "NINJA_VENDOR_TIMEOUT" || error.code === "ECHO_VENDOR_TIMEOUT") {
      return { ok: false, timedOut: true, error: safe };
    }
    return { ok: false, timedOut: false, error: safe };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return {
      ok: false,
      timedOut: true,
      error: { code: "PROVIDER_TIMEOUT", message: "The provider exceeded its inline deadline." },
    };
  }
  return {
    ok: false,
    timedOut: false,
    error: { code: "EXECUTION_FAILED", message: "The Execution could not complete." },
  };
}

/** Race one provider Action against the inline deadline. A slow Action that
 * resolves after the deadline is still a timeout: the receipt owns the
 * outcome, never a late inline value. */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const timeout = new Error("provider_deadline_exceeded");
          timeout.name = "TimeoutError";
          reject(timeout);
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Shared summary shape for the provider response: the durable receipt
 * fields plus the advisory dispatch marker. Never a substitute for detail. */
export function providerSummary(outcome: ProviderOutcome) {
  return {
    executionId: outcome.executionId,
    sagaId: outcome.sagaId,
    sagaName: outcome.sagaName,
    status: outcome.status,
    result: outcome.result,
    durationMs: outcome.durationMs,
    dispatch: outcome.dispatch,
    statusUrl: outcome.statusUrl,
  };
}
