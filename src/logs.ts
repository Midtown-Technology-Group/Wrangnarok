// SPDX-License-Identifier: AGPL-3.0
// OBS-02 (issue #153): bounded structured author logs and progress.
//
// A Saga emits logs from inside step.do() via appendAuthorLog; the Execution
// row supplies attribution (execution/org/caller/Saga), never caller input.
// SEC-01 scrubbing runs BEFORE persistence (execution registry) and again
// before streaming (deployment secrets at the HTTP layer), so a secret
// substring can never ride D1 or an HTTP response out.
//
// Durability posture: D1 is the source of truth. HTTP read/tail/search are
// polling views over durable rows with opaque seq cursors; a disconnected
// client reconnects by refetching from its last seq, and dedupes by seq
// (mergeLogPages). No WebSocket/DO/Queue surface exists here: polling is the
// first slice, and any live-push design needs an earned ADR.
//
// Bounds (explicit limits, tested):
// - LOG_MESSAGE_MAX_CHARS (1024): author messages longer than this throw.
// - LOG_DATA_MAX_BYTES (2048): stringified data above this throws.
// - LOG_RETENTION_PER_EXECUTION (200): only the newest 200 rows per
//   Execution survive; older rows are pruned on write.
// - Tail limit 1-100 (default 50); search limit 1-50 (default 20).
//
// Visibility tiers: DEBUG rows persist but are hidden from default reads.
// They are returned only when the caller explicitly asks for level=DEBUG
// (or a set containing it), so diagnostic detail never leaks into a
// default tail. There is no HTTP write path: logs are Saga-emitted only,
// which keeps attribution unforgeable.
import { Fault, parseDateBound } from "./domain";
import type { Principal } from "./domain";
import { assertJsonSerializable } from "./saga";
import { scrubExecutionText, scrubExecutionValue } from "./secrets";

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "PROGRESS"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** Default read tier: everything except DEBUG diagnostics. */
export const DEFAULT_VISIBLE_LEVELS: readonly LogLevel[] = ["INFO", "WARN", "ERROR", "PROGRESS"];
export const LOG_MESSAGE_MAX_CHARS = 1024;
export const LOG_DATA_MAX_BYTES = 2048;
export const LOG_RETENTION_PER_EXECUTION = 200;
export const LOG_TAIL_LIMIT_DEFAULT = 50;
export const LOG_TAIL_LIMIT_MAX = 100;
export const LOG_SEARCH_LIMIT_DEFAULT = 20;
export const LOG_SEARCH_LIMIT_MAX = 50;

export interface AuthorLogInput {
  readonly level: LogLevel;
  readonly message: string;
  readonly data?: unknown;
}

export interface LogEntry {
  readonly seq: number;
  readonly executionId: string;
  readonly sagaId: string;
  readonly sagaName: string;
  readonly orgId: string;
  readonly userId: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly data: unknown;
  readonly createdAt: string;
}

export interface LogPage {
  readonly logs: LogEntry[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Opaque page marker: base64url of {seq}. Clients resume strictly above it. */
export function encodeLogCursor(seq: number): string {
  return btoa(JSON.stringify({ seq })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeLogCursor(value: string): number {
  let cursor: unknown;
  try {
    cursor = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    throw new Fault(400, "INVALID_CURSOR", "The log cursor is not a valid page marker.");
  }
  if (
    cursor === null ||
    typeof cursor !== "object" ||
    !("seq" in cursor) ||
    typeof (cursor as { seq: unknown }).seq !== "number" ||
    !Number.isInteger((cursor as { seq: number }).seq) ||
    (cursor as { seq: number }).seq < 0
  ) {
    throw new Fault(400, "INVALID_CURSOR", "The log cursor is not a valid page marker.");
  }
  return (cursor as { seq: number }).seq;
}

function parseLevels(raw: string | null): readonly LogLevel[] {
  if (raw === null) return DEFAULT_VISIBLE_LEVELS;
  const levels: LogLevel[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim();
    if (!isLogLevel(candidate)) {
      throw new Fault(400, "INVALID_LEVEL", "Level must be DEBUG, INFO, WARN, ERROR, or PROGRESS, comma-separated.");
    }
    if (!levels.includes(candidate)) levels.push(candidate);
  }
  if (levels.length === 0) {
    throw new Fault(400, "INVALID_LEVEL", "Level must be DEBUG, INFO, WARN, ERROR, or PROGRESS, comma-separated.");
  }
  return levels;
}

function parseLogLimit(raw: string | null, def: number, max: number): number {
  if (raw === null) return def;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    throw new Fault(400, "INVALID_LIMIT", `Limit must be an integer from 1 to ${max}.`);
  }
  return Number(raw);
}

/** Pure parser for GET /api/executions/:id/logs (tail). */
export interface LogTailQuery {
  readonly levels: readonly LogLevel[];
  readonly limit: number;
  readonly afterSeq?: number;
}
export function parseLogTailQuery(params: URLSearchParams): LogTailQuery {
  for (const key of params.keys()) {
    if (!["level", "limit", "cursor"].includes(key)) {
      throw new Fault(400, "UNSUPPORTED_QUERY", "Only level, limit, and cursor are supported here.");
    }
  }
  const rawCursor = params.get("cursor");
  return {
    levels: parseLevels(params.get("level")),
    limit: parseLogLimit(params.get("limit"), LOG_TAIL_LIMIT_DEFAULT, LOG_TAIL_LIMIT_MAX),
    ...(rawCursor === null ? {} : { afterSeq: decodeLogCursor(rawCursor) }),
  };
}

/** Pure parser for GET /api/logs (operator search by date/level/Saga). */
export interface LogSearchQuery extends LogTailQuery {
  readonly sagaId?: string;
  readonly sagaName?: string;
  readonly startAt?: string;
  readonly endBefore?: string;
}
export function parseLogSearchQuery(params: URLSearchParams): LogSearchQuery {
  for (const key of params.keys()) {
    if (!["level", "sagaId", "sagaName", "startDate", "endDate", "limit", "cursor"].includes(key)) {
      throw new Fault(
        400,
        "UNSUPPORTED_QUERY",
        "Only level, sagaId, sagaName, startDate, endDate, limit, and cursor are supported here.",
      );
    }
  }
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  let sagaId: string | undefined;
  const rawSaga = params.get("sagaId");
  if (rawSaga !== null) {
    if (!UUID.test(rawSaga)) throw new Fault(400, "INVALID_SAGA_ID", "sagaId must be a stable Saga UUID.");
    sagaId = rawSaga;
  }
  let sagaName: string | undefined;
  const rawName = params.get("sagaName");
  if (rawName !== null) {
    if (rawName.length === 0 || rawName.length > 256) {
      throw new Fault(400, "INVALID_SAGA_NAME", "sagaName must be 1 to 256 characters.");
    }
    sagaName = rawName;
  }
  const rawStart = params.get("startDate");
  const startAt = rawStart === null ? undefined : parseDateBound(rawStart, "INVALID_START_DATE");
  const rawEnd = params.get("endDate");
  const endAtRaw = rawEnd === null ? undefined : parseDateBound(rawEnd, "INVALID_END_DATE");
  // Plain-day endDates ("YYYY-MM-DD") are exclusive of the whole day: they
  // normalize to the next midnight so a From/To day-range pair covers the
  // full To day. Full datetimes stay exact. Mirrors parseHistoryQuery.
  const rawEndIsDay = rawEnd !== null && /^\d{4}-\d{2}-\d{2}$/.test(rawEnd);
  const endBefore =
    endAtRaw === undefined
      ? undefined
      : rawEndIsDay
        ? new Date(Date.parse(endAtRaw) + 24 * 60 * 60 * 1000).toISOString()
        : endAtRaw;
  if (startAt !== undefined && endBefore !== undefined && startAt >= endBefore) {
    throw new Fault(400, "INVALID_DATE_RANGE", "startDate must be before endDate.");
  }
  const rawCursor = params.get("cursor");
  return {
    levels: parseLevels(params.get("level")),
    limit: parseLogLimit(params.get("limit"), LOG_SEARCH_LIMIT_DEFAULT, LOG_SEARCH_LIMIT_MAX),
    ...(rawCursor === null ? {} : { afterSeq: decodeLogCursor(rawCursor) }),
    ...(sagaId === undefined ? {} : { sagaId }),
    ...(sagaName === undefined ? {} : { sagaName }),
    ...(startAt === undefined ? {} : { startAt }),
    ...(endBefore === undefined ? {} : { endBefore }),
  };
}

/** Merge a freshly polled page into the client's durable view: dedupe by seq
 * (reconnect replays are idempotent) and keep deterministic seq order. Pure;
 * shared by the browser tail and the CLI follow mode. */
export function mergeLogPages(existing: readonly LogEntry[], page: readonly LogEntry[]): LogEntry[] {
  const seen = new Set(existing.map((entry) => entry.seq));
  const merged = [...existing];
  for (const entry of page) {
    if (!seen.has(entry.seq)) {
      seen.add(entry.seq);
      merged.push(entry);
    }
  }
  merged.sort((a, b) => a.seq - b.seq);
  return merged;
}

/** Saga-author log write. Attribution comes from the immutable Execution row,
 * never from the entry. Must run inside step.do(). Validation failures throw
 * (author bugs fail loud); a missing table on an old DB best-effort no-ops
 * with a console warn so logging can never fail the Execution itself.
 * Returns the durable seq, or null when the table is unavailable. */
export async function appendAuthorLog(
  db: D1Database,
  executionId: string,
  entry: AuthorLogInput,
): Promise<number | null> {
  if (!isLogLevel(entry.level as string)) {
    throw new Error(`Invalid log level ${JSON.stringify(entry.level)}.`);
  }
  if (typeof entry.message !== "string" || entry.message.length === 0 || entry.message.length > LOG_MESSAGE_MAX_CHARS) {
    throw new Error(`Log message must be 1 to ${LOG_MESSAGE_MAX_CHARS} characters.`);
  }
  if (entry.data !== undefined) {
    assertJsonSerializable(entry.data, "log data");
    if (new TextEncoder().encode(JSON.stringify(entry.data)).length > LOG_DATA_MAX_BYTES) {
      throw new Error(`Log data must fit within ${LOG_DATA_MAX_BYTES} bytes.`);
    }
  }
  const row = await db
    .prepare("SELECT id,org_id,user_id,saga_id,saga_name FROM executions WHERE id=?")
    .bind(executionId)
    .first<{ id: string; org_id: string; user_id: string; saga_id: string; saga_name: string }>();
  if (!row) throw new Error("Unknown Execution for log write.");
  // SEC-01: scrub before persistence. The placeholder is shorter than any
  // registered secret floor, but a pathological pile-up could still exceed
  // the CHECK bound, so truncate post-scrub rather than fail the write.
  let message = scrubExecutionText(executionId, entry.message);
  if (message.length > LOG_MESSAGE_MAX_CHARS) message = message.slice(0, LOG_MESSAGE_MAX_CHARS);
  const data = entry.data === undefined ? null : scrubExecutionValue(entry.data, executionId);
  const createdAt = new Date().toISOString();
  try {
    const inserted = await db
      .prepare(
        "INSERT INTO execution_logs(execution_id,org_id,user_id,saga_id,saga_name,level,message,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        row.id,
        row.org_id,
        row.user_id,
        row.saga_id,
        row.saga_name,
        entry.level,
        message,
        data === null ? null : JSON.stringify(data),
        createdAt,
      )
      .run();
    const seq = Number(inserted.meta.last_row_id);
    // Retention: keep only the newest LOG_RETENTION_PER_EXECUTION rows.
    await db
      .prepare(
        "DELETE FROM execution_logs WHERE execution_id=? AND seq NOT IN (SELECT seq FROM execution_logs WHERE execution_id=? ORDER BY seq DESC LIMIT ?)",
      )
      .bind(row.id, row.id, LOG_RETENTION_PER_EXECUTION)
      .run();
    return seq;
  } catch {
    console.warn(`WRANGNAROK_LOGS_PERSIST_SKIPPED ${executionId}`);
    return null;
  }
}

interface LogRow {
  seq: number;
  execution_id: string;
  org_id: string;
  user_id: string;
  saga_id: string;
  saga_name: string;
  level: string;
  message: string;
  data_json: string | null;
  created_at: string;
}

const LOG_COLUMNS = "seq,execution_id,org_id,user_id,saga_id,saga_name,level,message,data_json,created_at";

function toEntry(row: LogRow): LogEntry {
  return {
    seq: row.seq,
    executionId: row.execution_id,
    sagaId: row.saga_id,
    sagaName: row.saga_name,
    orgId: row.org_id,
    userId: row.user_id,
    level: row.level as LogLevel,
    message: row.message,
    data: row.data_json === null ? null : (JSON.parse(row.data_json) as unknown),
    createdAt: row.created_at,
  };
}

function toPage(rows: LogRow[], limit: number, afterSeq?: number): LogPage {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  // nextCursor is the resume marker, not a completeness claim: the last seen
  // seq when rows exist (so a poller can refetch from it after a disconnect),
  // the caller's own cursor when the page is empty (so it keeps its place),
  // and null only when no cursor exists at all. hasMore means more rows
  // already exist beyond this page.
  return {
    logs: page.map(toEntry),
    hasMore,
    nextCursor:
      last !== undefined ? encodeLogCursor(last.seq) : afterSeq !== undefined ? encodeLogCursor(afterSeq) : null,
  };
}

/** Scoped tail for one Execution: owner-only (foreign callers get 404 from
 * the visibility check, never rows). Deterministic seq order. */
export async function listExecutionLogs(
  db: D1Database,
  caller: Principal,
  executionId: string,
  query: LogTailQuery,
): Promise<LogPage> {
  const owner = await db
    .prepare("SELECT id FROM executions WHERE id=? AND org_id=? AND user_id=?")
    .bind(executionId, caller.orgId, caller.userId)
    .first<{ id: string }>();
  if (!owner) {
    throw new Fault(404, "EXECUTION_NOT_FOUND", "Execution not found.");
  }
  const clauses = ["execution_id=?", `level IN (${query.levels.map(() => "?").join(",")})`];
  const binds: (string | number)[] = [executionId, ...query.levels];
  if (query.afterSeq !== undefined) {
    clauses.push("seq>?");
    binds.push(query.afterSeq);
  }
  const rows = await db
    .prepare(`SELECT ${LOG_COLUMNS} FROM execution_logs WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`)
    .bind(...binds, query.limit + 1)
    .all<LogRow>();
  return toPage(rows.results, query.limit, query.afterSeq);
}

/** Operator search across the caller's own Executions (org/user scoped),
 * filterable by date/level/Saga. Summaries carry attribution per row. */
export async function searchExecutionLogs(db: D1Database, caller: Principal, query: LogSearchQuery): Promise<LogPage> {
  const clauses = ["org_id=?", "user_id=?", `level IN (${query.levels.map(() => "?").join(",")})`];
  const binds: (string | number)[] = [caller.orgId, caller.userId, ...query.levels];
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
  if (query.afterSeq !== undefined) {
    clauses.push("seq>?");
    binds.push(query.afterSeq);
  }
  const rows = await db
    .prepare(`SELECT ${LOG_COLUMNS} FROM execution_logs WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`)
    .bind(...binds, query.limit + 1)
    .all<LogRow>();
  return toPage(rows.results, query.limit, query.afterSeq);
}
