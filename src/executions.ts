// SPDX-License-Identifier: AGPL-3.0
import { NonRetryableError } from "cloudflare:workflows";
import {
  DEFAULT_SAGA_POLICY,
  digestSaga,
  encodeHistoryCursor,
  Fault,
  executionId,
  helloSaga,
  ninjaSaga,
  parseSagaPolicy,
  POLICY_JSON_BOUND,
  POLICY_VERSION,
  RECOVERY_WINDOW_MS,
  smokeSaga,
} from "./domain";
import type { ExecutionStatus, HistoryQuery, Principal, SafeError, SagaDef, SagaRuntimePolicy } from "./domain";
import type { Connection } from "./integrations";
import { buildOrgCtx } from "./saga";
import type { OrgCtx } from "./saga";
import { requireActiveInstall } from "./solutions";
import type { Bindings } from "./bindings";
import { scrubExecutionError, scrubExecutionValue } from "./secrets";
export interface ExecutionRow {
  id: string;
  saga_id: string;
  saga_name: string;
  saga_revision: string;
  org_id: string;
  user_id: string;
  input_json: string;
  dispatched: number;
  status: ExecutionStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_json: string | null;
  error_json: string | null;
  /** Applied runtime-policy snapshot (RUN-01, ADR 018). Null on rows written
   * before migration 0007; read paths treat null as DEFAULT_SAGA_POLICY. */
  policy_json: string | null;
}
export interface SagaPolicyRecord {
  readonly policy: SagaRuntimePolicy;
  readonly version: number;
  readonly updatedAt: string;
}
/** Parse a stored policy snapshot. Corrupt snapshots fail closed to the
 * default policy rather than inventing per-Saga behavior. */
export function parseStoredPolicy(value: string | null): SagaRuntimePolicy {
  if (value === null) return DEFAULT_SAGA_POLICY;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!objectLike(parsed) || !objectLike(parsed.policy)) return DEFAULT_SAGA_POLICY;
    return parseSagaPolicy(parsed.policy, DEFAULT_SAGA_POLICY);
  } catch {
    return DEFAULT_SAGA_POLICY;
  }
}
function objectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Load the effective policy for one (org, Saga): the persisted operator row
 * when present, else DEFAULT_SAGA_POLICY. Never throws on missing rows. */
export async function loadSagaPolicy(db: D1Database, orgId: string, sagaId: string): Promise<SagaPolicyRecord> {
  try {
    const row = await db
      .prepare("SELECT policy_json,version,updated_at FROM saga_policies WHERE org_id=? AND saga_id=?")
      .bind(orgId, sagaId)
      .first<{ policy_json: string; version: number; updated_at: string }>();
    if (!row) {
      return { policy: DEFAULT_SAGA_POLICY, version: POLICY_VERSION, updatedAt: new Date(0).toISOString() };
    }
    return { policy: parseStoredPolicy(row.policy_json), version: row.version, updatedAt: row.updated_at };
  } catch {
    // Old DB before migration 0007 (or a missing table in a unit double):
    // policy reverts to the code default rather than failing submit.
    return { policy: DEFAULT_SAGA_POLICY, version: POLICY_VERSION, updatedAt: new Date(0).toISOString() };
  }
}
/** Persist one operator policy row. Partial bodies merge over the current row
 * (defaults for a fresh row); unknown keys reject via parseSagaPolicy.
 * Returns the stored record; version bumps on every write. */
export async function storeSagaPolicy(
  db: D1Database,
  orgId: string,
  sagaId: string,
  body: unknown,
): Promise<SagaPolicyRecord> {
  const current = await loadSagaPolicy(db, orgId, sagaId);
  const policy = parseSagaPolicy(body, current.policy);
  const snapshot = JSON.stringify({ version: POLICY_VERSION, policy });
  if (new TextEncoder().encode(snapshot).byteLength > POLICY_JSON_BOUND) {
    throw new Fault(400, "INVALID_POLICY", "The policy snapshot exceeds its storage bound.");
  }
  const now = new Date().toISOString();
  const existing = await db
    .prepare("SELECT version FROM saga_policies WHERE org_id=? AND saga_id=?")
    .bind(orgId, sagaId)
    .first<{ version: number }>();
  if (!existing) {
    await db
      .prepare("INSERT INTO saga_policies(org_id,saga_id,policy_json,version,updated_at) VALUES (?,?,?,?,?)")
      .bind(orgId, sagaId, snapshot, POLICY_VERSION, now)
      .run();
    return { policy, version: POLICY_VERSION, updatedAt: now };
  }
  const next = existing.version + 1;
  await db
    .prepare("UPDATE saga_policies SET policy_json=?,version=?,updated_at=? WHERE org_id=? AND saga_id=?")
    .bind(snapshot, next, now, orgId, sagaId)
    .run();
  return { policy, version: next, updatedAt: now };
}
export function policySnapshot(policy: SagaRuntimePolicy): string {
  return JSON.stringify({ version: POLICY_VERSION, policy });
}
export async function visibleExecution(db: D1Database, id: string, caller: Principal): Promise<ExecutionRow> {
  const row = await db
    .prepare("SELECT * FROM executions WHERE id = ? AND org_id = ? AND user_id = ?")
    .bind(id, caller.orgId, caller.userId)
    .first<ExecutionRow>();
  if (!row) throw new Fault(404, "EXECUTION_NOT_FOUND", "Execution not found.");
  return row;
}
/** One native Workflow binding per Saga. Never inferred from the request. */
export function workflowForSaga(env: Bindings, sagaId: string): Workflow<{ executionId: string }> {
  if (sagaId === ninjaSaga.id) return env.NINJA_WORKFLOW;
  if (sagaId === digestSaga.id) return env.DIGEST_WORKFLOW;
  if (sagaId === smokeSaga.id) return env.SMOKE_WORKFLOW;
  if (sagaId === helloSaga.id) return env.HELLO_WORKFLOW;
  return env.ECHO_WORKFLOW;
}
export async function submit(env: Bindings, caller: Principal, key: string, saga: SagaDef, input: unknown) {
  // Fail-closed execution gate (ADR 011 SOL-01, local decision): a Saga
  // covered by a bundle install runs only against the applicable active
  // install/revision. Orgs with no install rows at all keep working under
  // the explicit local/loose development exception. Checked before the
  // Execution row write so denied submissions persist nothing.
  await requireActiveInstall(env.DB, saga.id, saga.revision, caller.orgId);
  // Canonical per ADR 001 (reconciled #15): deterministic SHA execution ID
  // scoped to (org, user, key); required Idempotency-Key; createBatch
  // retained-ID dedup + dispatched marker; 15-min same-revision retry gate;
  // Pending never auto-swept; caller-driven retry on 503. RUN-01 (ADR 018):
  // the persisted per-Saga runtime policy gates admission and is snapshotted
  // onto the Execution row so applied behavior stays inspectable.
  const id = await executionId(caller, key);
  const inputJson = JSON.stringify(input);
  const effective = await loadSagaPolicy(env.DB, caller.orgId, saga.id);
  const policyJson = policySnapshot(effective.policy);
  let inserted: D1Result;
  try {
    inserted = await env.DB.prepare(
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
      .run();
  } catch {
    // Old DB before migration 0007: fall back to the pre-policy insert shape.
    inserted = await env.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(id, saga.id, saga.name, saga.revision, caller.orgId, caller.userId, inputJson, new Date().toISOString())
      .run();
  }
  const row = await visibleExecution(env.DB, id, caller);
  if (row.saga_id !== saga.id || row.input_json !== inputJson) {
    throw new Fault(409, "IDEMPOTENCY_CONFLICT", "This key already identifies different input.");
  }
  // Snapshot backfill: rows inserted before migration 0012 (or by an old
  // insert path) carry NULL; the submit path stamps the effective policy so
  // detail always exposes what admission applied.
  try {
    if (row.policy_json === null || row.policy_json === undefined) {
      await env.DB.prepare("UPDATE executions SET policy_json=? WHERE id=?").bind(policyJson, id).run();
    }
  } catch {
    // Old DB without the column: the snapshot is unavailable, never fatal.
  }
  // A cancelled Execution never dispatches (again): the row stays as the
  // durable receipt, and the caller must submit a fresh Idempotency-Key.
  if (row.status === "Cancelling" || row.status === "Cancelled") {
    throw new Fault(409, "EXECUTION_CANCELLED", "This Execution was cancelled and will not dispatch.");
  }
  if (!row.dispatched) {
    // Pause/admission policy (RUN-01): disabled Sagas fence new dispatches
    // with 409 SAGA_PAUSED; maxConcurrent fences with 429 ADMISSION_LIMITED.
    // In-flight Executions keep their snapshot and run to their own terminal.
    if (!effective.policy.admission.enabled) {
      throw new Fault(409, "SAGA_PAUSED", "This Saga is paused for this Organization; new Executions do not dispatch.");
    }
    if (effective.policy.admission.maxConcurrent > 0) {
      // The row itself was just inserted as Pending: exempt it so the first
      // Execution under a limit of 1 still dispatches, while the next active
      // row fences with 429.
      const active = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND saga_id=? AND status IN ('Pending','Running','Cancelling') AND id<>?",
      )
        .bind(caller.orgId, saga.id, id)
        .first<{ n: number }>();
      if ((active?.n ?? 0) >= effective.policy.admission.maxConcurrent) {
        throw new Fault(429, "ADMISSION_LIMITED", "This Saga reached its concurrent Execution limit.");
      }
    }
    // Same-revision + 15-min refusal window (ADR 001 #15): never auto-fail
    // Pending, never resurrect after the window, never invent success.
    if (row.saga_revision !== saga.revision || Date.now() - Date.parse(row.created_at) >= RECOVERY_WINDOW_MS) {
      throw new Fault(
        409,
        "RECOVERY_EXPIRED",
        "Inspect the existing Execution; it must not be automatically relaunched.",
      );
    }
    // One native Workflow binding per Saga. Never inferred from the request.
    const workflow = workflowForSaga(env, saga.id);
    try {
      // Cloudflare createBatch skips existing retained IDs. Never parse error strings as duplicates.
      await workflow.createBatch([{ id, params: { executionId: id } }]);
      await env.DB.prepare("UPDATE executions SET dispatched = 1 WHERE id = ?").bind(id).run();
    } catch {
      throw new Fault(
        503,
        "DISPATCH_UNCONFIRMED",
        "Work may have started. Retry the same request and Idempotency-Key.",
      );
    }
  }
  return { executionId: id, replayed: inserted.meta.changes === 0, statusUrl: `/api/executions/${id}` };
}
/** Connection resolution outcome (ADR 010 section 3, Phase 1b; entity split
 * per ADR 003). Lookup is always exactly one row for this Organization —
 * never a global cascade, never cross-org. A hit returns the typed
 * Connection (IDs plus non-secret config); declared-but-missing — including
 * a disabled mapping — fails loud with 424 so a miswired install can never
 * silently skip work; undeclared (optional) access resolves to None and the
 * Saga decides its own fallback/skip. */
export type ConnectionResolution =
  | { readonly found: true; readonly connection: Connection }
  | { readonly found: false; readonly declared: true; readonly error: SafeError }
  | { readonly found: false; readonly declared: false };

interface ResolutionRow {
  readonly id: string;
  readonly org_id: string;
  readonly integration_id: string;
  readonly endpoint: string;
  readonly display_name: string | null;
  readonly enabled: number | null;
  readonly managed_by: string | null;
}

/** Read the Execution-path Connection row, tolerating older databases:
 * full CON-01 columns first, then the 0004 managed_by schema, then the
 * original 0001 narrow schema (suites that apply only 0001-0002 exercise
 * each rung). Missing columns read as defaults — disabled never inferred,
 * loose never inferred managed — the same posture as the migration
 * backfill. */
async function resolutionRow(db: D1Database, orgId: string, integrationId: string): Promise<ResolutionRow | null> {
  try {
    return await db
      .prepare(
        "SELECT id,org_id,integration_id,endpoint,display_name,enabled,managed_by FROM connections WHERE org_id=? AND integration_id=?",
      )
      .bind(orgId, integrationId)
      .first<ResolutionRow>();
  } catch {
    // Fall through to the older schema rungs below.
  }
  try {
    const row = await db
      .prepare(
        "SELECT id,org_id,integration_id,endpoint,managed_by FROM connections WHERE org_id=? AND integration_id=?",
      )
      .bind(orgId, integrationId)
      .first<{ id: string; org_id: string; integration_id: string; endpoint: string; managed_by: string | null }>();
    if (!row) return null;
    return { ...row, display_name: null, enabled: 1 };
  } catch {
    const row = await db
      .prepare("SELECT id,org_id,integration_id,endpoint FROM connections WHERE org_id=? AND integration_id=?")
      .bind(orgId, integrationId)
      .first<{ id: string; org_id: string; integration_id: string; endpoint: string }>();
    if (!row) return null;
    return { ...row, display_name: null, enabled: 1, managed_by: null };
  }
}

export async function resolveConnection(
  db: D1Database,
  org: OrgCtx,
  integrationId: string,
  required: readonly string[],
): Promise<ConnectionResolution> {
  const row = await resolutionRow(db, org.orgId, integrationId);
  // A disabled mapping is unusable, not a silent skip: declared work fails
  // loud (424), optional access resolves to None. Pre-0007 rows read NULL
  // enabled and behave as enabled (migration backfill).
  if (row && (row.enabled ?? 1) === 1) {
    const connection: Connection = {
      id: row.id,
      integrationId: row.integration_id,
      orgId: row.org_id,
      endpoint: row.endpoint,
      displayName: row.display_name,
      enabled: true,
      managedBy: row.managed_by,
    };
    return { found: true, connection };
  }
  if (required.includes(integrationId)) {
    return {
      found: false,
      declared: true,
      error: {
        code: "INTEGRATION_REQUIREMENT_UNSATISFIED",
        message: "This Saga requires an Integration Connection that is not configured for this Organization.",
      },
    };
  }
  return { found: false, declared: false };
}
/** Shared prepare-input-v1 Operation (hygiene: one copy, not one per Saga).
 * Validates the invocation against the immutable D1 Execution row, marks
 * Pending -> Running, records the prepare Operation, and builds the OrgCtx
 * from the row — never from client input or Workflow params. startedMs is
 * captured here, inside the Operation, so it is replay-memoized and never a
 * top-of-run Date.now(). Must run inside step.do("prepare-input-v1"). */
export interface PreparedExecution<T> {
  readonly input: T;
  readonly orgCtx: OrgCtx;
  readonly startedMs: number;
}
export async function prepareExecution<T>(
  db: D1Database,
  id: string,
  sagaId: string,
  sagaRevision: string,
  parse: (value: unknown) => T,
): Promise<PreparedExecution<T>> {
  const row = await db.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
  if (!row || row.saga_id !== sagaId || row.saga_revision !== sagaRevision) {
    throw new NonRetryableError("Unknown Saga revision.");
  }
  if (row.status === "Cancelling" || row.status === "Cancelled") {
    throw new NonRetryableError("Execution was cancelled.");
  }
  const input = parse(JSON.parse(row.input_json));
  await db
    .prepare("UPDATE executions SET status='Running',started_at=COALESCE(started_at,?) WHERE id=? AND status='Pending'")
    .bind(new Date().toISOString(), id)
    .run();
  await beginOperation(db, id, "prepare-input-v1", 0);
  await finishOperation(db, id, "prepare-input-v1", input);
  return { input, orgCtx: buildOrgCtx(row, "prepare-input-v1"), startedMs: Date.now() };
}
export async function beginOperation(db: D1Database, id: string, name: string, position: number): Promise<void> {
  // (Re)begin only from Running: a fresh row starts Running, a retried step
  // resets its Running row, and a terminal row is never resurrected (the
  // WHERE fences the DO UPDATE arm; the INSERT arm only fires for new rows).
  await db
    .prepare(
      "INSERT INTO operations(execution_id,name,position,status,started_at) VALUES (?,?,?,'Running',?) ON CONFLICT(execution_id,name) DO UPDATE SET status='Running',completed_at=NULL,result_json=NULL,error_json=NULL WHERE status='Running'",
    )
    .bind(id, name, position, new Date().toISOString())
    .run();
}
export async function finishOperation(db: D1Database, id: string, name: string, result: unknown): Promise<void> {
  // Fenced on Running: a late vendor callback that lands after Failed (or a
  // cancel marker) matches no row and no-ops instead of overwriting terminal
  // history with invented success. Write-time scrub: the Execution's
  // registered secrets (credentials, fetched tokens) are replaced by
  // substring, so a secret-bearing transform can never persist in history.
  await db
    .prepare(
      "UPDATE operations SET status='Succeeded',completed_at=?,result_json=? WHERE execution_id=? AND name=? AND status='Running'",
    )
    .bind(new Date().toISOString(), JSON.stringify(scrubExecutionValue(result, id)), id, name)
    .run();
}
export async function failExecution(
  db: D1Database,
  id: string,
  error: SafeError,
  status: "Failed" | "TimedOut" = "Failed",
): Promise<void> {
  // Terminal checkpoints only: conditional on still being Pending/Running
  // so a late checkpoint can never overwrite Cancelled, Cancelling, or
  // another terminal. Failed is written by persist-failure-v1, TimedOut
  // exclusively by the explicit timeout-mark-v1 step. Operation rows stay
  // within ('Running','Succeeded','Failed'); the timeout code lives in
  // error_json. Owner-cancel wins (ADR 001): once the Cancelling marker is
  // written, a racing terminal checkpoint is stale and no-ops; the cancel
  // marker below no-ops on non-Cancelling rows, so an acknowledged
  // cancellation is never rewritten. Write-time scrub: a secret substring
  // embedded in an error message is replaced before the terminal row lands.
  const now = new Date().toISOString();
  const json = JSON.stringify(scrubExecutionError(error, id));
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'",
      )
      .bind(now, json, id),
    db
      .prepare(
        "UPDATE executions SET status=?,completed_at=?,error_json=? WHERE id=? AND status IN ('Pending','Running')",
      )
      .bind(status, now, json, id),
  ]);
}
export async function cancelExecution(db: D1Database, id: string): Promise<void> {
  // Second half of Running/Pending -> Cancelling -> Cancelled. Conditional on
  // still being Cancelling so an already-terminal row is never rewritten
  // here. Owner-cancel wins (ADR 001): terminal checkpoints are fenced to
  // Pending/Running, so a checkpoint racing the cancel marker no-ops.
  const now = new Date().toISOString();
  const json = JSON.stringify({ code: "EXECUTION_CANCELLED", message: "The Execution was cancelled by its owner." });
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET status='Failed',completed_at=?,error_json=? WHERE execution_id=? AND status='Running'",
      )
      .bind(now, json, id),
    db
      .prepare(
        "UPDATE executions SET status='Cancelled',completed_at=?,error_json=? WHERE id=? AND status='Cancelling'",
      )
      .bind(now, json, id),
  ]);
}
export function summary(row: Omit<ExecutionRow, "input_json" | "result_json" | "error_json">) {
  return {
    executionId: row.id,
    sagaId: row.saga_id,
    sagaName: row.saga_name,
    sagaRevision: row.saga_revision,
    orgId: row.org_id,
    userId: row.user_id,
    status: row.status,
    dispatchConfirmed: row.dispatched === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface HistoryPage {
  readonly executions: ReturnType<typeof summary>[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}
const HISTORY_COLUMNS =
  "id,saga_id,saga_name,saga_revision,org_id,user_id,dispatched,status,created_at,started_at,completed_at";
/** ExecutionHistory listing (Phase 2, issues #76 then #152): org/requester-scoped
 * summaries in (created_at DESC, id DESC) order, with status (single or
 * comma-separated multi), sagaId, exact sagaName, and ISO startDate/endDate
 * bounds, plus cursor pagination. Summaries only — input/result never ride
 * the list. Never claim completeness when more rows exist: hasMore plus a
 * nextCursor carry the rest. */
export async function listHistory(db: D1Database, caller: Principal, query: HistoryQuery): Promise<HistoryPage> {
  const clauses = ["org_id=?", "user_id=?"];
  const binds: (string | number)[] = [caller.orgId, caller.userId];
  if (query.statuses.length > 0) {
    clauses.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
    binds.push(...query.statuses);
  }
  if (query.sagaId !== undefined) {
    clauses.push("saga_id=?");
    binds.push(query.sagaId);
  }
  if (query.sagaName !== undefined) {
    clauses.push("saga_name=?");
    binds.push(query.sagaName);
  }
  if (query.startAt !== undefined) {
    clauses.push("created_at>=?");
    binds.push(query.startAt);
  }
  if (query.endBefore !== undefined) {
    clauses.push("created_at<?");
    binds.push(query.endBefore);
  }
  if (query.cursor !== undefined) {
    clauses.push("((created_at < ?) OR (created_at = ? AND id < ?))");
    binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT ${HISTORY_COLUMNS} FROM executions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<Omit<ExecutionRow, "input_json" | "result_json" | "error_json">>();
  const page = rows.results.slice(0, query.limit);
  const hasMore = rows.results.length > query.limit;
  const last = page[page.length - 1];
  return {
    executions: page.map(summary),
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeHistoryCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
