// SPDX-License-Identifier: AGPL-3.0
// Administrative audit trail and operational notifications (OPS-01, issue
// #172; ADR 020).
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
