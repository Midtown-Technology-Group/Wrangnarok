// SPDX-License-Identifier: AGPL-3.0
// Administrative audit trail, operational notifications (OPS-01, issue #172;
// ADR 020), and Cloudflare-native diagnostics with operational repairs
// (OPS-02, issue #173).
//
// Two D1 tables (migration 0018_ops.sql), Worker + D1 only — no Queue,
// Durable Object, KV, or WebSocket is earned by this slice. Clients poll
// durable state; reconnects re-read the authoritative rows, never a stream.
//
// Audit events: one row per consequential management mutation or policy deny
// (app lifecycle, owner cancellation). Emission is best-effort: a failed
// insert logs WRANGNAROK_AUDIT_SKIPPED and never fails the primary mutation
// (adopted from upstream emit_audit, which swallows its own errors so audit
// failures never break the primary operation). Reads are Organization-scoped
// (AUTH-02 owns role-gated reads) with keyset pagination and bounded filters.
//
// Notifications: durable personal/org rows for long-running operations (app
// deploy jobs in v1). Dismissal is owner-only for personal rows; any same-org
// caller may dismiss an org-scoped row. Job-linked rows reconcile on read so
// an interrupted job never reports stale progress.
import { Fault, object, parseDateBound, UUID } from "./domain";
import type { Principal } from "./domain";
import { INTEGRATION_DEFINITIONS } from "./integrations";
import { normalizeSecretList, scrubTextWithSecrets, scrubValueWithSecrets } from "./secrets";

export type AuditOutcome = "success" | "failure";

export interface AuditEvent {
  readonly id: string;
  readonly orgId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly outcome: AuditOutcome;
  readonly detail: unknown;
  readonly createdAt: string;
}

export interface AuditCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface AuditQuery {
  readonly actionPrefix?: string;
  readonly outcome?: AuditOutcome;
  readonly search?: string;
  readonly startAt?: string;
  readonly endBefore?: string;
  readonly limit: number;
  readonly cursor?: AuditCursor;
}

export const AUDIT_LIMIT_DEFAULT = 20;
export const AUDIT_LIMIT_MAX = 50;

function encodeAuditCursor(cursor: AuditCursor): string {
  return btoa(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeAuditCursor(value: string): AuditCursor {
  let cursor: unknown;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    cursor = JSON.parse(atob(padded));
  } catch {
    throw new Fault(400, "INVALID_CURSOR", "The audit cursor is not a valid page marker.");
  }
  if (
    !object(cursor) ||
    typeof cursor.createdAt !== "string" ||
    cursor.createdAt.length === 0 ||
    typeof cursor.id !== "string" ||
    !UUID.test(cursor.id)
  ) {
    throw new Fault(400, "INVALID_CURSOR", "The audit cursor is not a valid page marker.");
  }
  return { createdAt: cursor.createdAt, id: cursor.id };
}

/** Pure parser for the audit list query string. Throws Faults with
 * machine-readable codes; unit-tested without any runtime binding. */
export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  for (const key of params.keys()) {
    if (!["action", "outcome", "search", "startDate", "endDate", "limit", "cursor"].includes(key)) {
      throw new Fault(
        400,
        "UNSUPPORTED_QUERY",
        "Only action, outcome, search, startDate, endDate, limit, and cursor are supported here.",
      );
    }
  }
  let actionPrefix: string | undefined;
  const rawAction = params.get("action");
  if (rawAction !== null) {
    if (rawAction.length === 0 || rawAction.length > 128) {
      throw new Fault(400, "INVALID_ACTION_PREFIX", "Action must be a 1 to 128 character prefix filter.");
    }
    actionPrefix = rawAction;
  }
  let outcome: AuditOutcome | undefined;
  const rawOutcome = params.get("outcome");
  if (rawOutcome !== null) {
    if (rawOutcome !== "success" && rawOutcome !== "failure") {
      throw new Fault(400, "INVALID_OUTCOME", "Outcome must be success or failure.");
    }
    outcome = rawOutcome;
  }
  let search: string | undefined;
  const rawSearch = params.get("search");
  if (rawSearch !== null) {
    if (rawSearch.length === 0 || rawSearch.length > 256) {
      throw new Fault(400, "INVALID_SEARCH", "Search must be 1 to 256 characters.");
    }
    search = rawSearch;
  }
  let limit = AUDIT_LIMIT_DEFAULT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > AUDIT_LIMIT_MAX) {
      throw new Fault(400, "INVALID_LIMIT", `Limit must be an integer from 1 to ${AUDIT_LIMIT_MAX}.`);
    }
    limit = Number(rawLimit);
  }
  let startAt: string | undefined;
  const rawStart = params.get("startDate");
  if (rawStart !== null) startAt = parseDateBound(rawStart, "INVALID_START_DATE");
  let endBefore: string | undefined;
  const rawEnd = params.get("endDate");
  if (rawEnd !== null) {
    const parsed = parseDateBound(rawEnd, "INVALID_END_DATE");
    // Plain-day endDates ("YYYY-MM-DD") are exclusive of the whole day: they
    // normalize to the next midnight so a From/To day-range pair covers the
    // full To day. Full datetimes stay exact.
    endBefore = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)
      ? new Date(Date.parse(parsed) + 24 * 60 * 60 * 1000).toISOString()
      : parsed;
  }
  if (startAt !== undefined && endBefore !== undefined && startAt >= endBefore) {
    throw new Fault(400, "INVALID_DATE_RANGE", "startDate must be before endDate.");
  }
  const rawCursor = params.get("cursor");
  return {
    ...(actionPrefix === undefined ? {} : { actionPrefix }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(search === undefined ? {} : { search }),
    ...(startAt === undefined ? {} : { startAt }),
    ...(endBefore === undefined ? {} : { endBefore }),
    limit,
    ...(rawCursor === null ? {} : { cursor: decodeAuditCursor(rawCursor) }),
  };
}

interface AuditRow {
  id: string;
  org_id: string;
  actor_user_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  detail_json: string | null;
  created_at: string;
}

function toEvent(row: AuditRow): AuditEvent {
  let detail: unknown = null;
  if (row.detail_json !== null) {
    try {
      detail = JSON.parse(row.detail_json);
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id,
    orgId: row.org_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome as AuditOutcome,
    detail,
    createdAt: row.created_at,
  };
}

export interface AuditPage {
  readonly events: AuditEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/** Best-effort audit emission. A failed insert (missing table on an old DB,
 * constraint drift, anything else) logs WRANGNAROK_AUDIT_SKIPPED and never
 * throws, so the caller's primary mutation always survives. Details are
 * scrubbed by substring before the row lands (SEC-01 discipline). */
export async function recordAudit(
  db: D1Database,
  caller: Principal,
  action: string,
  target: { readonly type?: string; readonly id?: string } | undefined,
  outcome: AuditOutcome,
  detail: unknown,
  secrets: readonly unknown[] = [],
): Promise<void> {
  try {
    const scrubbed = scrubValueWithSecrets(detail, normalizeSecretList(secrets));
    const detailJson = scrubbed === undefined || scrubbed === null ? null : JSON.stringify(scrubbed);
    const scrubbedAction = scrubTextWithSecrets(action, normalizeSecretList(secrets));
    await db
      .prepare(
        "INSERT INTO audit_events(id,org_id,actor_user_id,action,target_type,target_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID().toLowerCase(),
        caller.orgId,
        caller.userId,
        scrubbedAction.slice(0, 128),
        target?.type ?? null,
        target?.id ?? null,
        outcome,
        detailJson === null ? null : detailJson.slice(0, 4096),
        new Date().toISOString(),
      )
      .run();
  } catch {
    console.warn(`WRANGNAROK_AUDIT_SKIPPED ${action}`);
  }
}

/** Organization-scoped audit listing in (created_at DESC, id DESC) order with
 * action-prefix, outcome, date, and bounded free-text filters plus cursor
 * pagination. Summaries carry the scrubbed detail; no raw bodies ride the list. */
export async function listAudit(db: D1Database, caller: Principal, query: AuditQuery): Promise<AuditPage> {
  const clauses = ["org_id=?"];
  const binds: (string | number)[] = [caller.orgId];
  if (query.actionPrefix !== undefined) {
    clauses.push("action LIKE ? ESCAPE '\\'");
    binds.push(`${query.actionPrefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
  }
  if (query.outcome !== undefined) {
    clauses.push("outcome=?");
    binds.push(query.outcome);
  }
  if (query.startAt !== undefined) {
    clauses.push("created_at>=?");
    binds.push(query.startAt);
  }
  if (query.endBefore !== undefined) {
    clauses.push("created_at<?");
    binds.push(query.endBefore);
  }
  if (query.search !== undefined) {
    const like = `%${query.search.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
    clauses.push(
      "(action LIKE ? ESCAPE '\\' OR target_type LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR detail_json LIKE ? ESCAPE '\\')",
    );
    binds.push(like, like, like, like);
  }
  if (query.cursor !== undefined) {
    clauses.push("((created_at < ?) OR (created_at = ? AND id < ?))");
    binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT id,org_id,actor_user_id,action,target_type,target_id,outcome,detail_json,created_at FROM audit_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<AuditRow>();
  const page = rows.results.slice(0, query.limit);
  const hasMore = rows.results.length > query.limit;
  const last = page[page.length - 1];
  return {
    events: page.map(toEvent),
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeAuditCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

// --- Notifications ------------------------------------------------------------

export type NotificationScope = "personal" | "org";
export type NotificationStatus = "pending" | "running" | "awaiting_action" | "completed" | "failed" | "cancelled";

export const NOTIFICATION_CATEGORIES = ["app_build", "system"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_LIMIT_DEFAULT = 50;
export const NOTIFICATION_LIMIT_MAX = 100;

export interface AppNotification {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly scope: NotificationScope;
  readonly category: string;
  readonly title: string;
  readonly body: string | null;
  readonly status: NotificationStatus;
  readonly progressPercent: number | null;
  readonly detail: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dismissedAt: string | null;
}

interface NotificationRow {
  id: string;
  org_id: string;
  user_id: string;
  scope: string;
  category: string;
  title: string;
  body: string | null;
  status: string;
  progress_percent: number | null;
  detail_json: string | null;
  created_at: string;
  updated_at: string;
  dismissed_at: string | null;
}

function toNotification(row: NotificationRow): AppNotification {
  let detail: unknown = null;
  if (row.detail_json !== null) {
    try {
      detail = JSON.parse(row.detail_json);
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    scope: row.scope as NotificationScope,
    category: row.category,
    title: row.title,
    body: row.body,
    status: row.status as NotificationStatus,
    progressPercent: row.progress_percent,
    detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dismissedAt: row.dismissed_at,
  };
}

export function parseNotificationId(value: string): string {
  if (!UUID.test(value)) throw new Fault(400, "INVALID_NOTIFICATION_ID", "Notification lookups need the exact UUID.");
  return value.toLowerCase();
}

export function parseNotificationLimit(params: URLSearchParams): number {
  for (const key of params.keys()) {
    if (key !== "limit") {
      throw new Fault(400, "UNSUPPORTED_QUERY", "Only limit is supported here.");
    }
  }
  const raw = params.get("limit");
  if (raw === null) return NOTIFICATION_LIMIT_DEFAULT;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > NOTIFICATION_LIMIT_MAX) {
    throw new Fault(400, "INVALID_LIMIT", `Limit must be an integer from 1 to ${NOTIFICATION_LIMIT_MAX}.`);
  }
  return Number(raw);
}

export interface CreateNotificationInput {
  readonly scope: NotificationScope;
  readonly category: string;
  readonly title: string;
  readonly body?: string;
  readonly status: NotificationStatus;
  readonly progressPercent?: number | null;
  readonly detail?: unknown;
  /** Deduplication key scoped to the Organization (e.g. app-build:<jobId>).
   * A second create with the same key returns the existing row. */
  readonly dedupKey?: string;
}

/** Server-side notification creation (there is deliberately no client-create
 * route: creation is a server emission, matching upstream). Duplicate
 * dedup keys converge on the existing row instead of forking. */
export async function createNotification(
  db: D1Database,
  caller: Principal,
  input: CreateNotificationInput,
  secrets: readonly unknown[] = [],
): Promise<AppNotification> {
  if (input.title.length === 0 || input.title.length > 200) {
    throw new Fault(400, "INVALID_NOTIFICATION", "Notification titles must be 1 to 200 characters.");
  }
  if (input.body !== undefined && input.body.length > 500) {
    throw new Fault(400, "INVALID_NOTIFICATION", "Notification bodies must be at most 500 characters.");
  }
  const scrubbed = scrubValueWithSecrets(input.detail ?? null, normalizeSecretList(secrets));
  const detailJson = scrubbed === null ? null : JSON.stringify(scrubbed).slice(0, 4096);
  const now = new Date().toISOString();
  const id = crypto.randomUUID().toLowerCase();
  if (input.dedupKey !== undefined) {
    await db
      .prepare(
        "INSERT INTO notifications(id,org_id,user_id,scope,category,title,body,status,progress_percent,detail_json,dedup_key,created_at,updated_at,dismissed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(org_id,dedup_key) DO NOTHING",
      )
      .bind(
        id,
        caller.orgId,
        caller.userId,
        input.scope,
        input.category,
        scrubTextWithSecrets(input.title, normalizeSecretList(secrets)),
        input.body === undefined ? null : scrubTextWithSecrets(input.body, normalizeSecretList(secrets)),
        input.status,
        input.progressPercent ?? null,
        detailJson,
        input.dedupKey,
        now,
        now,
      )
      .run();
    const existing = await db
      .prepare("SELECT * FROM notifications WHERE org_id=? AND dedup_key=?")
      .bind(caller.orgId, input.dedupKey)
      .first<NotificationRow>();
    // The INSERT above just wrote (or converged on) this row: a missing row
    // here means the table vanished mid-request, which D1 surfaces as a
    // throw, not a null. The non-null assertion documents that invariant.
    return toNotification(existing as NotificationRow);
  }
  await db
    .prepare(
      "INSERT INTO notifications(id,org_id,user_id,scope,category,title,body,status,progress_percent,detail_json,dedup_key,created_at,updated_at,dismissed_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)",
    )
    .bind(
      id,
      caller.orgId,
      caller.userId,
      input.scope,
      input.category,
      scrubTextWithSecrets(input.title, normalizeSecretList(secrets)),
      input.body === undefined ? null : scrubTextWithSecrets(input.body, normalizeSecretList(secrets)),
      input.status,
      input.progressPercent ?? null,
      detailJson,
      now,
      now,
    )
    .run();
  const row = await db.prepare("SELECT * FROM notifications WHERE id=?").bind(id).first<NotificationRow>();
  // Same invariant as the dedup path: the INSERT above wrote this row.
  return toNotification(row as NotificationRow);
}

/** Inbox: the caller's own personal rows plus same-Organization org-scoped
 * rows. Other users' personal rows never appear. Dismissed rows stay hidden;
 * there is no separate archive surface in v1. */
export async function listNotifications(db: D1Database, caller: Principal, limit: number): Promise<AppNotification[]> {
  const rows = await db
    .prepare(
      "SELECT * FROM notifications WHERE org_id=? AND dismissed_at IS NULL AND (scope='org' OR user_id=?) ORDER BY created_at DESC,id DESC LIMIT ?",
    )
    .bind(caller.orgId, caller.userId, limit)
    .all<NotificationRow>();
  const out: AppNotification[] = [];
  for (const row of rows.results) out.push(await reconcileNotification(db, row));
  return out;
}

/** One notification for this caller. Personal rows are owner-only; org rows
 * are visible to every same-Organization caller. Anything else answers null
 * so routes return 404, never a cross-user leak. */
export async function visibleNotification(
  db: D1Database,
  caller: Principal,
  id: string,
): Promise<AppNotification | null> {
  const row = await db
    .prepare("SELECT * FROM notifications WHERE id=? AND org_id=? AND dismissed_at IS NULL")
    .bind(id, caller.orgId)
    .first<NotificationRow>();
  if (!row) return null;
  if (row.scope !== "org" && row.user_id !== caller.userId) return null;
  return reconcileNotification(db, row);
}

/** Reconcile a job-linked notification against the authoritative app_jobs row
 * so an interrupted job never reports stale progress: a pending/running
 * notification whose job already settled advances to the matching terminal
 * status. A notification whose job row is gone is left untouched here; the
 * route layer decides its fate. */
async function reconcileNotification(db: D1Database, row: NotificationRow): Promise<AppNotification> {
  const current = toNotification(row);
  if (current.status !== "pending" && current.status !== "running") return current;
  const detail = (current.detail ?? {}) as Record<string, unknown>;
  const jobId = detail["jobId"];
  const appId = detail["appId"];
  if (typeof jobId !== "string" || typeof appId !== "string" || !UUID.test(jobId) || !UUID.test(appId)) return current;
  let job: { status: string } | null;
  try {
    job = await db
      .prepare("SELECT status FROM app_jobs WHERE id=? AND app_id=?")
      .bind(jobId.toLowerCase(), appId.toLowerCase())
      .first<{ status: string }>();
  } catch {
    return current;
  }
  if (!job) return current;
  const next: NotificationStatus | null =
    job.status === "succeeded" ? "completed" : job.status === "failed" ? "failed" : null;
  if (!next) return current;
  const now = new Date().toISOString();
  await db.prepare("UPDATE notifications SET status=?,updated_at=? WHERE id=?").bind(next, now, row.id).run();
  return { ...current, status: next, updatedAt: now };
}

/** Dismiss one notification. Personal rows dismiss by owner only; org-scoped
 * rows dismiss by any same-Organization caller. Returns false when the row is
 * missing, already dismissed, or owned by someone else — the route answers
 * 404 either way, so a second dismiss is gone, not an error to retry. */
export async function dismissNotification(db: D1Database, caller: Principal, id: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT * FROM notifications WHERE id=? AND org_id=? AND dismissed_at IS NULL")
    .bind(id, caller.orgId)
    .first<NotificationRow>();
  if (!row) return false;
  if (row.scope !== "org" && row.user_id !== caller.userId) return false;
  const applied = await db
    .prepare("UPDATE notifications SET dismissed_at=?,updated_at=? WHERE id=? AND dismissed_at IS NULL")
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run();
  return applied.meta.changes > 0;
}

// --- Diagnostics (OPS-02, issue #173) ---------------------------------------
// Cloudflare-native operational health, admission backlog, platform job
// progress, and repair actions. Upstream Bifrost keeps these as
// queue/worker/process surfaces (health/version/metrics/jobs routers,
// scheduler diagnostics, platform workers, maintenance); Wrangnarok maps
// each to the primitives it actually runs on — Worker, Workflow, D1 — and
// never invents container or RabbitMQ names. Every query is
// Organization-scoped; missing provider metrics answer "unavailable", never
// a fabricated number. All writes below are explicit, bounded, auditable
// repairs behind the double-commit contract (inspect, then act with
// confirmation); production stays manual per ADR 004.

/** Product version contract. The Worker serves this module's numbers only:
 * the SDK contract version (the protocol authors program against), the saga
 * catalog revision fingerprint (the Git-owned source identity), and the
 * applied D1 migration watermark observed on this database. Upstream
 * `routers/version.py` answers build metadata for deployed containers;
 * here there are no containers, so the answer names the durable state the
 * diagnosis actually depends on. No Cloudflare account, plan, or metering
 * values ride this payload: local inspection must work with no credentials. */
export interface OpsVersion {
  readonly sdkVersion: string;
  readonly sagaCatalog: { readonly count: number; readonly revision: string };
  readonly migrationsApplied: readonly string[];
}

/** Per-status Execution counts plus the admission backlog for this
 * Organization. Upstream `routers/metrics.py` aggregates broker queues and
 * worker pools; here the backlog is the durable D1 row state operators can
 * actually act on: undispatched Pending receipts (submit accepted, Workflow
 * dispatch unconfirmed), active (Pending/Running/Cancelling) rows, and
 * recent terminal failures with their safe error codes. Counts only, never
 * input/result bodies: the list routes own row-level detail. */
export interface OpsMetrics {
  readonly generatedAt: string;
  readonly executions: {
    readonly total: number;
    readonly pending: number;
    readonly pendingUndispatched: number;
    readonly running: number;
    readonly cancelling: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly timedOut: number;
    readonly cancelled: number;
  };
  readonly recentFailures: readonly {
    readonly executionId: string;
    readonly sagaName: string;
    readonly status: string;
    readonly code: string | null;
    readonly completedAt: string | null;
  }[];
}

/** One scheduled-task row: upstream `scheduler_diagnostics.py` inspects
 * APScheduler jobs; Wrangnarok has no scheduler process in this slice
 * (TRG-01 owns recurring schedules), so the answer is the durable trigger
 * surface that actually exists — Cron-capable endpoints are reported from
 * D1, and the cadence field stays honestly null until TRG-01 schedules
 * land. A missing scheduler is stated, never emulated with a fake ticker. */
export interface OpsScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly kind: "endpoint" | "scheduler";
  readonly enabled: boolean;
  readonly cadence: string | null;
  readonly detail: string;
}

/** One platform job row: upstream `platform_jobs.py` plus the per-app
 * deploy queue. App deploy jobs are the only long-running platform jobs
 * this product owns, so progress aggregates them per app; the Executions
 * half reuses the same backlog counters as OpsMetrics. An interrupted job
 * (app row stuck in `building` while its job rows settled) is flagged for
 * the stuck-build repair instead of being silently reported as progress. */
export interface OpsJobs {
  readonly generatedAt: string;
  readonly executions: OpsMetrics["executions"];
  readonly appBuilds: {
    readonly queued: number;
    readonly running: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly interrupted: readonly { readonly appId: string; readonly appName: string }[];
  };
}

/** Dependency preflight: upstream `maintenance.py` verifies provider
 * wiring before mutating work. Here preflight walks the static Integration
 * registry (never vendor HTTP, never secrets): each Integration reports
 * whether this Organization holds a Connection mapping, whether it is
 * enabled, and which deployment credentials the mapping still needs. The
 * `ready` verdict is static, never a live vendor probe — live probes stay
 * on the per-Connection test route where the operator explicitly asks. */
export interface OpsPreflight {
  readonly checkedAt: string;
  readonly integrations: readonly {
    readonly integrationId: string;
    readonly integrationName: string;
    readonly connected: boolean;
    readonly enabled: boolean;
    readonly missingSecrets: readonly string[];
    readonly ready: boolean;
  }[];
}

/** Repair operations this slice performs. Names stay boring on purpose:
 * retry is a fresh submit under a new key, cancel reuses the owner-cancel
 * path, and the three cleanups delete only rows/tokens the product itself
 * created. Nothing here touches vendor state or production bindings. */
export const OPS_REPAIR_KINDS = [
  "retry-execution",
  "cancel-execution",
  "cleanup-pending-uploads",
  "cleanup-expired-tokens",
  "repair-stuck-build",
] as const;

export type OpsRepairKind = (typeof OPS_REPAIR_KINDS)[number];

export interface OpsRepairInput {
  readonly kind: OpsRepairKind;
  /** Exact Execution ID (retry/cancel), app UUID (stuck-build), or absent
   * for the org-wide token/upload sweeps. Prefixes and search matches are
   * rejected, mirroring the CLI destructive-action rule. */
  readonly targetId?: string;
  /** Fresh Idempotency-Key for retry-execution (16-128 safe chars). */
  readonly idempotencyKey?: string;
}

export interface OpsRepairOutcome {
  readonly kind: OpsRepairKind;
  readonly dryRun: boolean;
  readonly targetId: string | null;
  readonly action: string;
  readonly result: unknown;
}

function opsFault(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function requireRepairTarget(kind: OpsRepairKind, target: string): string {
  if (target.length === 0) {
    throw opsFault("INVALID_REPAIR_TARGET", `Repair ${kind} needs an exact target ID.`);
  }
  if (kind === "retry-execution" || kind === "cancel-execution") {
    if (!/^[a-f0-9]{64}$/.test(target)) {
      throw opsFault(
        "INVALID_REPAIR_TARGET",
        "Execution repairs need the exact 64-hex Execution ID (no prefixes, no search).",
      );
    }
    return target;
  }
  if (!UUID.test(target)) {
    throw opsFault("INVALID_REPAIR_TARGET", "App repairs need the exact app UUID.");
  }
  return target.toLowerCase();
}

/** Parse a repair request body. Throws Faults with machine-readable codes;
 * unit-tested without any runtime binding. Unknown keys fail closed with
 * INVALID_REPAIR (never silently ignored), and dryRun defaults to true so
 * the inspect-first contract holds unless the caller explicitly commits. */
export function parseRepairBody(value: unknown): OpsRepairInput & { dryRun: boolean } {
  if (!object(value)) throw opsFault("INVALID_REPAIR", "Repair needs a JSON object with kind and dryRun.");
  for (const key of Object.keys(value)) {
    if (!["kind", "targetId", "idempotencyKey", "dryRun"].includes(key)) {
      throw opsFault("INVALID_REPAIR", "Only kind, targetId, idempotencyKey, and dryRun are supported here.");
    }
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !(OPS_REPAIR_KINDS as readonly string[]).includes(kind)) {
    throw opsFault("INVALID_REPAIR_KIND", `Repair kind must be one of ${OPS_REPAIR_KINDS.join("|")}.`);
  }
  const repair = kind as OpsRepairKind;
  const dryRun = value.dryRun ?? true;
  if (typeof dryRun !== "boolean") throw opsFault("INVALID_REPAIR", "dryRun must be a boolean.");
  if (value.targetId !== undefined && typeof value.targetId !== "string") {
    throw opsFault("INVALID_REPAIR_TARGET", "targetId must be a string.");
  }
  if (value.idempotencyKey !== undefined && typeof value.idempotencyKey !== "string") {
    throw opsFault("INVALID_REPAIR", "idempotencyKey must be a string.");
  }
  if (repair === "retry-execution" || repair === "cancel-execution" || repair === "repair-stuck-build") {
    if (value.targetId === undefined) {
      throw opsFault("INVALID_REPAIR_TARGET", `Repair ${repair} needs an exact target ID.`);
    }
    requireRepairTarget(repair, value.targetId);
  } else if (value.targetId !== undefined) {
    throw opsFault("INVALID_REPAIR_TARGET", `Repair ${repair} takes no targetId.`);
  }
  if (repair === "retry-execution") {
    if (typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(value.idempotencyKey)) {
      throw opsFault("INVALID_REPAIR_KEY", "Retry needs an idempotencyKey of 16 to 128 safe characters.");
    }
  } else if (value.idempotencyKey !== undefined) {
    throw opsFault("INVALID_REPAIR", "Only retry-execution takes idempotencyKey.");
  }
  return {
    kind: repair,
    ...(value.targetId === undefined ? {} : { targetId: value.targetId as string }),
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey as string }),
    dryRun,
  };
}

/** Version contract: SDK contract version plus the static Catalog
 * fingerprint plus the D1 migrations actually applied to this database
 * (the `d1_migrations` journal Wrangler maintains, best-effort — an
 * unreadable journal answers an empty list, never a failure). */
export async function opsVersion(
  db: D1Database,
  deps: { sdkVersion: string; catalog: readonly { id: string; revision: string }[] },
): Promise<OpsVersion> {
  let migrationsApplied: string[];
  try {
    const rows = await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{ name: string }>();
    migrationsApplied = rows.results.map((row) => row.name);
  } catch {
    migrationsApplied = [];
  }
  return {
    sdkVersion: deps.sdkVersion,
    sagaCatalog: {
      count: deps.catalog.length,
      revision: deps.catalog.map((entry) => `${entry.id}:${entry.revision}`).join(","),
    },
    migrationsApplied,
  };
}

interface ExecutionCountRow {
  status: string;
  n: number;
}

/** Single COUNT(*) read with the repo-standard degrade (orgs.ts count):
 * a null row answers 0. Callers wrap the whole diagnostics query in
 * try/catch for the missing-table arm. Bare COUNT(*) always yields exactly
 * one row, so the cast documents that invariant instead of branching on
 * an unreachable null. */
async function countRows(db: D1Database, sql: string, ...binds: (string | number)[]): Promise<number> {
  const row = (await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>()) as { n: number };
  return row.n;
}

async function executionCounters(db: D1Database, orgId: string): Promise<OpsMetrics["executions"]> {
  const zero: OpsMetrics["executions"] = {
    total: 0,
    pending: 0,
    pendingUndispatched: 0,
    running: 0,
    cancelling: 0,
    succeeded: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
  };
  let rows: { results: ExecutionCountRow[] };
  try {
    rows = await db
      .prepare("SELECT status,COUNT(*) AS n FROM executions WHERE org_id=? GROUP BY status")
      .bind(orgId)
      .all<ExecutionCountRow>();
  } catch {
    return zero;
  }
  const byStatus = new Map<string, number>(rows.results.map((row) => [row.status, row.n]));
  const pending = byStatus.get("Pending") ?? 0;
  let pendingUndispatched: number;
  try {
    pendingUndispatched = await countRows(
      db,
      "SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND status='Pending' AND dispatched=0",
      orgId,
    );
  } catch {
    pendingUndispatched = 0;
  }
  return {
    total: [...byStatus.values()].reduce((sum, n) => sum + n, 0),
    pending,
    pendingUndispatched,
    running: byStatus.get("Running") ?? 0,
    cancelling: byStatus.get("Cancelling") ?? 0,
    succeeded: byStatus.get("Succeeded") ?? 0,
    failed: byStatus.get("Failed") ?? 0,
    timedOut: byStatus.get("TimedOut") ?? 0,
    cancelled: byStatus.get("Cancelled") ?? 0,
  };
}

/** Execution metrics for this Organization: per-status counts, the
 * undispatched-Pending admission backlog, and the newest terminal failures
 * with their safe error codes (inputs/results never ride along). A missing
 * executions table (hand-built database older than migration 0001) answers
 * zeros, never a throw: diagnostics must degrade, not fail the operator. */
export async function opsMetrics(db: D1Database, caller: Principal, recentLimit = 10): Promise<OpsMetrics> {
  const executions = await executionCounters(db, caller.orgId);
  let recentFailures: OpsMetrics["recentFailures"];
  try {
    const rows = await db
      .prepare(
        "SELECT id,saga_name,status,error_json,completed_at FROM executions WHERE org_id=? AND status IN ('Failed','TimedOut') ORDER BY completed_at DESC,id DESC LIMIT ?",
      )
      .bind(caller.orgId, Math.max(1, Math.min(50, recentLimit)))
      .all<{ id: string; saga_name: string; status: string; error_json: string | null; completed_at: string | null }>();
    recentFailures = rows.results.map((row) => {
      let code: string | null = null;
      if (row.error_json) {
        try {
          const parsed = JSON.parse(row.error_json) as { code?: unknown };
          code = typeof parsed.code === "string" ? parsed.code : null;
        } catch {
          code = null;
        }
      }
      return {
        executionId: row.id,
        sagaName: row.saga_name,
        status: row.status,
        code,
        completedAt: row.completed_at,
      };
    });
  } catch {
    recentFailures = [];
  }
  return { generatedAt: new Date().toISOString(), executions, recentFailures };
}

/** Scheduled-task status for this Organization. No scheduler process exists
 * in this slice (TRG-01 owns recurring schedules), so tasks are the durable
 * endpoint inventory that can actually trigger work: each endpoint reports
 * name, kind, enabled state, and its delivery backlog depth. The cadence is
 * honestly null — there is no Cron Trigger row to read yet, and a fake
 * cadence would be worse than none. */
export async function opsScheduledTasks(db: D1Database, caller: Principal): Promise<{ tasks: OpsScheduledTask[] }> {
  let endpoints: { id: string; name: string; kind: string; enabled: number }[];
  try {
    const rows = await db
      .prepare("SELECT id,name,kind,enabled FROM endpoints WHERE org_id=? ORDER BY name")
      .bind(caller.orgId)
      .all<{ id: string; name: string; kind: string; enabled: number }>();
    endpoints = rows.results;
  } catch {
    endpoints = [];
  }
  const tasks: OpsScheduledTask[] = [];
  for (const endpoint of endpoints) {
    let pendingDeliveries: number;
    try {
      pendingDeliveries = await countRows(
        db,
        "SELECT COUNT(*) AS n FROM endpoint_events WHERE endpoint_id=?",
        endpoint.id,
      );
    } catch {
      pendingDeliveries = 0;
    }
    tasks.push({
      id: endpoint.id,
      name: endpoint.name,
      kind: "endpoint",
      enabled: endpoint.enabled === 1,
      cadence: null,
      detail:
        endpoint.kind === "webhook"
          ? `webhook endpoint with ${pendingDeliveries} recorded deliveries; recurring schedules arrive with TRG-01.`
          : `api-key endpoint with ${pendingDeliveries} recorded deliveries; recurring schedules arrive with TRG-01.`,
    });
  }
  return { tasks };
}

/** Platform job progress for this Organization: Execution backlog counters
 * plus per-app deploy-job aggregates. Apps stuck in `building` with no
 * live non-terminal job row are flagged interrupted for the stuck-build
 * repair; a missing apps schema degrades to zeros, never a throw. */
export async function opsJobs(db: D1Database, caller: Principal): Promise<OpsJobs> {
  const executions = await executionCounters(db, caller.orgId);
  let queued = 0;
  let running = 0;
  let succeeded = 0;
  let failed = 0;
  const interrupted: { appId: string; appName: string }[] = [];
  try {
    const counts = await db
      .prepare(
        "SELECT j.status AS status,COUNT(*) AS n FROM app_jobs j JOIN apps a ON a.id=j.app_id WHERE a.org_id=? GROUP BY j.status",
      )
      .bind(caller.orgId)
      .all<{ status: string; n: number }>();
    for (const row of counts.results) {
      // Statuses are CHECK-constrained to exactly these four, so the
      // final else only ever sees failed rows — never an unknown status.
      if (row.status === "queued") queued = row.n;
      else if (row.status === "running") running = row.n;
      else if (row.status === "succeeded") succeeded = row.n;
      else failed = row.n;
    }
    const stuck = await db
      .prepare(
        "SELECT a.id AS id,a.name AS name FROM apps a WHERE a.org_id=? AND a.status='building' AND NOT EXISTS (SELECT 1 FROM app_jobs j WHERE j.app_id=a.id AND j.status IN ('queued','running'))",
      )
      .bind(caller.orgId)
      .all<{ id: string; name: string }>();
    for (const row of stuck.results) interrupted.push({ appId: row.id, appName: row.name });
  } catch {
    // Pre-apps schema: counters stay zero and nothing is flagged.
  }
  return {
    generatedAt: new Date().toISOString(),
    executions,
    appBuilds: { queued, running, succeeded, failed, interrupted },
  };
}

/** Dependency preflight for this Organization: per-Integration mapping
 * presence, enabled state, and missing deployment-secret names. Static
 * registry reads plus one D1 connection row per Integration — no vendor
 * HTTP, no secret values, no dispatch. */
export async function opsPreflight(
  db: D1Database,
  caller: Principal,
  env: Record<string, string | undefined>,
): Promise<OpsPreflight> {
  const integrations = [];
  for (const def of INTEGRATION_DEFINITIONS) {
    let row: { enabled: number | null } | null;
    try {
      row = await db
        .prepare("SELECT enabled FROM connections WHERE org_id=? AND integration_id=?")
        .bind(caller.orgId, def.id)
        .first<{ enabled: number | null }>();
    } catch {
      row = null;
    }
    const connected = row !== null;
    const enabled = (row?.enabled ?? 1) === 1;
    const missingSecrets: string[] = [];
    if (connected && enabled) {
      // defineIntegration guarantees every requiredSecret names its env var;
      // only the deployment value can be missing here, never the mapping.
      for (const name of def.requiredSecrets) {
        const envVar = def.secretEnvVars[name] as string;
        if (env[envVar] === undefined) missingSecrets.push(name);
      }
    }
    integrations.push({
      integrationId: def.id,
      integrationName: def.name,
      connected,
      enabled,
      missingSecrets,
      ready: connected && enabled && missingSecrets.length === 0,
    });
  }
  return { checkedAt: new Date().toISOString(), integrations };
}

/** Connection health for this Organization: per-Integration static mapping
 * state plus the Integration registry health copy. Same static posture as
 * preflight (no vendor HTTP); the per-Connection live probe stays on the
 * explicit test route. Unknown-registry rows are skipped, mirroring the
 * Connection list behavior. */
export async function opsConnectionHealth(
  db: D1Database,
  caller: Principal,
): Promise<{
  connections: readonly {
    integrationId: string;
    integrationName: string;
    connected: boolean;
    enabled: boolean;
    testHint: string;
    remediation: string;
  }[];
}> {
  const connections = [];
  for (const def of INTEGRATION_DEFINITIONS) {
    let row: { enabled: number | null } | null;
    try {
      row = await db
        .prepare("SELECT enabled FROM connections WHERE org_id=? AND integration_id=?")
        .bind(caller.orgId, def.id)
        .first<{ enabled: number | null }>();
    } catch {
      row = null;
    }
    connections.push({
      integrationId: def.id,
      integrationName: def.name,
      connected: row !== null,
      enabled: (row?.enabled ?? 1) === 1,
      testHint: def.health.testHint,
      remediation: def.health.remediation,
    });
  }
  return { connections };
}

export interface OpsRepairDeps {
  readonly admin: boolean;
  readonly secrets: readonly unknown[];
}

/** Inspect a repair without mutating: every kind answers what WOULD happen,
 * including row counts and target state. Dry-run never writes, never
 * dispatches, never deletes — the route enforces this by calling inspect
 * only. */
export async function inspectRepair(
  db: D1Database,
  caller: Principal,
  input: OpsRepairInput,
): Promise<OpsRepairOutcome> {
  switch (input.kind) {
    case "retry-execution": {
      if (input.targetId === undefined) throw opsFault("INVALID_REPAIR_TARGET", "Repair needs an exact target ID.");
      const id = requireRepairTarget(input.kind, input.targetId);
      let row: {
        id: string;
        saga_id: string;
        saga_name: string;
        status: string;
        input_json: string;
      } | null;
      try {
        row = await db
          .prepare("SELECT id,saga_id,saga_name,status,input_json FROM executions WHERE id=? AND org_id=?")
          .bind(id, caller.orgId)
          .first<{ id: string; saga_id: string; saga_name: string; status: string; input_json: string }>();
      } catch {
        row = null;
      }
      if (!row) throw opsFault("EXECUTION_NOT_FOUND", "Execution not found.", 404);
      if (row.status === "Pending" || row.status === "Running" || row.status === "Cancelling") {
        throw opsFault(
          "EXECUTION_NOT_REPAIRABLE",
          "Only terminal Executions can be retried; cancel the live one first.",
          409,
        );
      }
      let originalInput: unknown;
      try {
        originalInput = JSON.parse(row.input_json) as unknown;
      } catch {
        originalInput = {};
      }
      return {
        kind: input.kind,
        dryRun: true,
        targetId: row.id,
        action: `Submit ${row.saga_name} again under a fresh Idempotency-Key.`,
        result: { sagaId: row.saga_id, sagaName: row.saga_name, status: row.status, input: originalInput },
      };
    }
    case "cancel-execution": {
      if (input.targetId === undefined) throw opsFault("INVALID_REPAIR_TARGET", "Repair needs an exact target ID.");
      const id = requireRepairTarget(input.kind, input.targetId);
      let row: { id: string; saga_name: string; status: string } | null;
      try {
        row = await db
          .prepare("SELECT id,saga_name,status FROM executions WHERE id=? AND org_id=?")
          .bind(id, caller.orgId)
          .first<{ id: string; saga_name: string; status: string }>();
      } catch {
        row = null;
      }
      if (!row) throw opsFault("EXECUTION_NOT_FOUND", "Execution not found.", 404);
      const cancellable = row.status === "Pending" || row.status === "Running";
      return {
        kind: input.kind,
        dryRun: true,
        targetId: row.id,
        action: cancellable
          ? "Mark Cancelling, then confirm via the owner-cancel path."
          : "Already terminal: no cancel needed.",
        result: { sagaName: row.saga_name, status: row.status, cancellable },
      };
    }
    case "cleanup-pending-uploads": {
      const pending = await countPendingUploads(db, caller.orgId);
      return {
        kind: input.kind,
        dryRun: true,
        targetId: null,
        action: `Delete ${pending} pending file rows with no ready version (ready rows untouched).`,
        result: { pending },
      };
    }
    case "cleanup-expired-tokens": {
      const counts = await countExpiredTokens(db, caller.orgId);
      const total = counts.capabilities + counts.appTokens;
      return {
        kind: input.kind,
        dryRun: true,
        targetId: null,
        action: `Delete ${total} expired capability rows (${counts.capabilities} file, ${counts.appTokens} app-file); live tokens untouched.`,
        result: counts,
      };
    }
    case "repair-stuck-build": {
      if (input.targetId === undefined) throw opsFault("INVALID_REPAIR_TARGET", "Repair needs an exact target ID.");
      const appId = requireRepairTarget(input.kind, input.targetId);
      let row: { id: string; name: string; status: string } | null;
      try {
        row = await db
          .prepare("SELECT id,name,status FROM apps WHERE id=? AND org_id=?")
          .bind(appId, caller.orgId)
          .first<{ id: string; name: string; status: string }>();
      } catch {
        row = null;
      }
      if (!row) throw opsFault("APP_NOT_FOUND", "App not found.", 404);
      // A missing app_jobs table degrades to zero live jobs (never a throw);
      // a present table always answers a COUNT row.
      let liveJobs: number;
      try {
        liveJobs = await countRows(
          db,
          "SELECT COUNT(*) AS n FROM app_jobs WHERE app_id=? AND status IN ('queued','running')",
          appId,
        );
      } catch {
        liveJobs = 0;
      }
      const stuck = row.status === "building" && liveJobs === 0;
      return {
        kind: input.kind,
        dryRun: true,
        targetId: row.id,
        action: stuck
          ? "Restore the prior usable status (live when a deployment exists, else ready)."
          : "Not stuck: no status change needed.",
        result: { appName: row.name, status: row.status, liveJobs, stuck },
      };
    }
  }
}

async function countPendingUploads(db: D1Database, orgId: string): Promise<number> {
  try {
    return await countRows(db, "SELECT COUNT(*) AS n FROM files WHERE org_id=? AND status='pending'", orgId);
  } catch {
    return 0;
  }
}

async function countExpiredTokens(db: D1Database, orgId: string): Promise<{ capabilities: number; appTokens: number }> {
  const now = new Date().toISOString();
  let capabilities: number;
  let appTokens: number;
  try {
    capabilities = await countRows(
      db,
      "SELECT COUNT(*) AS n FROM file_capabilities WHERE org_id=? AND expires_at<=?",
      orgId,
      now,
    );
  } catch {
    capabilities = 0;
  }
  try {
    appTokens = await countRows(
      db,
      "SELECT COUNT(*) AS n FROM app_file_tokens t JOIN app_files f ON f.id=t.file_id WHERE f.org_id=? AND t.expires_at<=?",
      orgId,
      now,
    );
  } catch {
    appTokens = 0;
  }
  return { capabilities, appTokens };
}

/** Execute a repair. Admin-gated, audited by the route layer (best-effort,
 * like every other mutation here). Each repair is conditional and bounded:
 * stuck-build restores only when still stuck, cleanups delete only expired
 * or pending rows, cancel reuses the owner-cancel state machine, and retry
 * submits under the caller-supplied fresh key. */
export async function runRepair(
  db: D1Database,
  caller: Principal,
  input: OpsRepairInput,
  deps: OpsRepairDeps & {
    retry?: (key: string, sagaId: string, input: unknown) => Promise<{ executionId: string; replayed: boolean }>;
    cancel?: (executionId: string) => Promise<{ status: string; cancelled: boolean }>;
  },
): Promise<OpsRepairOutcome> {
  if (!deps.admin) throw opsFault("REPAIR_FORBIDDEN", "Only an admin may run operational repairs.", 403);
  const inspected = await inspectRepair(db, caller, input);
  switch (input.kind) {
    case "retry-execution": {
      if (!deps.retry) throw opsFault("REPAIR_UNAVAILABLE", "Retry dispatch is unavailable on this route.", 503);
      const detail = inspected.result as { sagaId: string; input: unknown };
      // inspectRepair always sets input (original row JSON, {} on corrupt
      // rows), so the retry replays the original submission verbatim.
      const receipt = await deps.retry(input.idempotencyKey as string, detail.sagaId, detail.input);
      return {
        kind: input.kind,
        dryRun: false,
        targetId: inspected.targetId,
        action: inspected.action,
        result: receipt,
      };
    }
    case "cancel-execution": {
      if (!deps.cancel) throw opsFault("REPAIR_UNAVAILABLE", "Cancel dispatch is unavailable on this route.", 503);
      const receipt = await deps.cancel(inspected.targetId as string);
      return {
        kind: input.kind,
        dryRun: false,
        targetId: inspected.targetId,
        action: inspected.action,
        result: receipt,
      };
    }
    case "cleanup-pending-uploads": {
      let deleted: number;
      try {
        const applied = await db
          .prepare("DELETE FROM files WHERE org_id=? AND status='pending'")
          .bind(caller.orgId)
          .run();
        deleted = applied.meta.changes;
      } catch {
        deleted = 0;
      }
      return {
        kind: input.kind,
        dryRun: false,
        targetId: null,
        action: inspected.action,
        result: { deleted },
      };
    }
    case "cleanup-expired-tokens": {
      const now = new Date().toISOString();
      let capabilities: number;
      let appTokens: number;
      try {
        const caps = await db
          .prepare("DELETE FROM file_capabilities WHERE org_id=? AND expires_at<=?")
          .bind(caller.orgId, now)
          .run();
        capabilities = caps.meta.changes;
      } catch {
        capabilities = 0;
      }
      try {
        const apps = await db
          .prepare(
            "DELETE FROM app_file_tokens WHERE token_hash IN (SELECT t.token_hash FROM app_file_tokens t JOIN app_files f ON f.id=t.file_id WHERE f.org_id=? AND t.expires_at<=?)",
          )
          .bind(caller.orgId, now)
          .run();
        appTokens = apps.meta.changes;
      } catch {
        appTokens = 0;
      }
      return {
        kind: input.kind,
        dryRun: false,
        targetId: null,
        action: inspected.action,
        result: { capabilities, appTokens, deleted: capabilities + appTokens },
      };
    }
    case "repair-stuck-build": {
      const detail = inspected.result as { status: string; liveJobs: number; stuck: boolean };
      if (!detail.stuck) {
        return {
          kind: input.kind,
          dryRun: false,
          targetId: inspected.targetId,
          action: "Not stuck: no change.",
          result: detail,
        };
      }
      // The apps row was just read by inspectRepair above, so the table
      // exists: a failed lookup here is a genuine storage failure (500),
      // never a missing app (404, already handled).
      const live = (await db
        .prepare("SELECT active_deployment_id FROM apps WHERE id=? AND org_id=?")
        .bind(inspected.targetId as string, caller.orgId)
        .first<{ active_deployment_id: string | null }>()) as { active_deployment_id: string | null };
      const restored = live.active_deployment_id ? "live" : "ready";
      const applied = await db
        .prepare("UPDATE apps SET status=?,updated_at=? WHERE id=? AND org_id=? AND status='building'")
        .bind(restored, new Date().toISOString(), inspected.targetId as string, caller.orgId)
        .run();
      return {
        kind: input.kind,
        dryRun: false,
        targetId: inspected.targetId,
        action: `Restored status to ${restored}.`,
        result: { ...detail, restored, applied: applied.meta.changes },
      };
    }
  }
}
