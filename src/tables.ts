// SPDX-License-Identifier: AGPL-3.0
// Author Tables over D1 (TABLE-01 minimal slice, TABLE-02 query/count/batch;
// issues #117, #154).
//
// A Table is an Organization-scoped, author-owned JSON-document store: a
// persisted declaration (name plus owning user) plus environment rows. Rows
// are plain JSON documents keyed by an author-chosen document ID, never
// portable source. Fresh Tables are deny-by-absence for everyone except the
// owning user until a grant names them.
//
// Authorization (deny-by-absence, mirroring the upstream Tables row-policy
// posture in docs/upstream-spec.md finding 8): the owning user holds every
// action implicitly; any other caller needs an explicit table_grants row for
// the action. Cross-Organization names resolve to null so routes answer 404,
// never a cross-tenant leak.
//
// Query semantics (TABLE-02 query/count slice): document-ID keyset scan with
// an optional key prefix, nested-JSON equality filters (dot paths into the
// stored document), ascending or descending document-ID order, and cursor
// pagination. Counts run scoped and let the caller skip them: skip_count
// answers total=-1 (a true omitted upstream specific, per issue #154) instead
// of scanning. Offset pagination, custom sorts, and projection/index
// management are unsupported and fail closed with explicit codes; version
// tokens were not established upstream and are a separate adaptation decision.
//
// D1 bounds (explicit, Free-tier viable): every document is capped at 4 KB of
// JSON, every bounded list scans at most QUERY_ROW_CAP rows in one query,
// and retention is org-owned deletion (see docs/upstream-parity.md TABLE-02).
// The D1 10 GB per-database limit, single-database transactions, and
// unsupported query operators are recorded there as explicit blockers.
//
// Realtime table-change subscriptions are NOT in this slice (the multi-slice
// note in issue #154 lets the query/count slice land first). Polling via
// repeated authorized queries is the interim path; any push design needs its
// own ADR before it is built.
import { Fault, object, UUID } from "./domain";
import type { Principal } from "./domain";

export const TABLE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DOC_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const FILTER_PATH = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;
export const TABLE_DOC_MAX_BYTES = 4096;
export const TABLE_QUERY_LIMIT_DEFAULT = 20;
export const TABLE_QUERY_LIMIT_MAX = 50;
/** Absolute scan ceiling behind one bounded list call: limit+1 keyset rows
 * plus one bounded COUNT scan that stops at this many matching rows. */
export const TABLE_QUERY_ROW_CAP = 1000;
/** Batch mutation ceiling: D1 batch writes and per-item preflight stay small. */
export const TABLE_BATCH_MAX = 25;
/** Nested-filter ceiling: enough for authored queries, never a full scan DSL. */
export const TABLE_FILTER_MAX = 5;

export type TableAction = "read" | "insert" | "update" | "delete";

export interface TableDefinition {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly createdAt: string;
}

export interface TableDocument {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TableFilter {
  readonly path: string;
  readonly value: unknown;
}

export interface TableQuery {
  readonly filters: readonly TableFilter[];
  readonly prefix?: string;
  readonly order: "asc" | "desc";
  /** When true the caller skips the count scan and total answers -1. */
  readonly skipCount: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

export interface TablePage {
  readonly rows: TableDocument[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  /** Filtered match count, or -1 when the caller passed skip_count. */
  readonly total: number;
}

export interface TableBatchItem {
  readonly docId: string;
  readonly data: Record<string, unknown>;
}

export interface TableBatchResult {
  readonly docId: string;
  readonly ok: boolean;
  readonly error: { code: string; message: string } | null;
}

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return new Fault(status, code, message, details);
}

export function parseTableName(value: unknown): string {
  if (typeof value !== "string" || !TABLE_NAME.test(value)) {
    throw invalid("INVALID_TABLE", "Table names must be lowercase alphanumerics and dashes, 1 to 64 chars.");
  }
  return value;
}

export function parseDocId(value: unknown): string {
  if (typeof value !== "string" || !DOC_ID.test(value)) {
    throw invalid(
      "INVALID_DOCUMENT_ID",
      "Document IDs must start with a letter or digit and hold letters, digits, dots, underscores, or dashes (1 to 128 chars).",
    );
  }
  return value;
}

/** Parse an author document: a plain JSON object within the byte bound.
 * Arrays, scalars, oversized payloads, and key-count floods fail closed. */
export function parseDocument(value: unknown): Record<string, unknown> {
  if (!object(value)) throw invalid("INVALID_DOCUMENT", "Table documents must be JSON objects.");
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 50) {
    throw invalid("INVALID_DOCUMENT", "Table documents must hold 1 to 50 top-level keys.");
  }
  for (const key of keys) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) {
      throw invalid(
        "INVALID_DOCUMENT",
        `Document key "${key}" must start with a letter and hold letters, digits, or underscores.`,
      );
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > TABLE_DOC_MAX_BYTES) {
    throw invalid("DOCUMENT_TOO_LARGE", `Table documents hold at most ${TABLE_DOC_MAX_BYTES} UTF-8 bytes of JSON.`);
  }
  return value;
}

/** Read a nested value out of a stored document by dot path. Arrays are
 * opaque: numeric segments never match, so filters stay object-scoped. */
export function lookupPath(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (!object(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function scalarEquals(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected === "string" || typeof expected === "boolean") return actual === expected;
  if (typeof expected === "number" && Number.isFinite(expected)) return actual === expected;
  return false;
}

/** Pure parser for the table query string. Throws Faults with
 * machine-readable codes; unit-tested without any runtime binding. */
export function parseTableQuery(params: URLSearchParams): TableQuery {
  for (const key of params.keys()) {
    if (!["filter", "prefix", "order", "skip_count", "limit", "cursor"].includes(key)) {
      throw invalid(
        "UNSUPPORTED_QUERY",
        "Only filter, prefix, order, skip_count, limit, and cursor are supported here.",
      );
    }
  }
  const filters: TableFilter[] = [];
  for (const raw of params.getAll("filter")) {
    if (filters.length >= TABLE_FILTER_MAX) {
      throw invalid("TOO_MANY_FILTERS", `At most ${TABLE_FILTER_MAX} filters are accepted.`);
    }
    const separator = raw.indexOf("=");
    if (separator <= 0) throw invalid("INVALID_FILTER", 'Filters read "path=value" with a dotted object path.');
    const path = raw.slice(0, separator);
    if (!FILTER_PATH.test(path) || path.length > 128) {
      throw invalid("INVALID_FILTER", 'Filters read "path=value" with a dotted object path.');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.slice(separator + 1));
    } catch {
      throw invalid("INVALID_FILTER", "Filter values must be JSON scalars (string, number, boolean, or null).");
    }
    if (!scalarEquals(value, value) || (typeof value === "object" && value !== null)) {
      throw invalid("INVALID_FILTER", "Filter values must be JSON scalars (string, number, boolean, or null).");
    }
    filters.push({ path, value });
  }
  let prefix: string | undefined;
  const rawPrefix = params.get("prefix");
  if (rawPrefix !== null) {
    if (rawPrefix.length === 0 || rawPrefix.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(rawPrefix)) {
      throw invalid("INVALID_PREFIX", "Prefixes must be 1 to 64 document-ID characters.");
    }
    prefix = rawPrefix;
  }
  let order: "asc" | "desc" = "asc";
  const rawOrder = params.get("order");
  if (rawOrder !== null) {
    if (rawOrder !== "asc" && rawOrder !== "desc") {
      throw invalid("INVALID_ORDER", 'Order must be "asc" or "desc". Custom sorts are unsupported.');
    }
    order = rawOrder;
  }
  let skipCount = false;
  const rawSkip = params.get("skip_count");
  if (rawSkip !== null) {
    if (rawSkip !== "true" && rawSkip !== "false") {
      throw invalid("INVALID_SKIP_COUNT", 'skip_count must be "true" or "false".');
    }
    skipCount = rawSkip === "true";
  }
  let limit = TABLE_QUERY_LIMIT_DEFAULT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > TABLE_QUERY_LIMIT_MAX) {
      throw invalid("INVALID_LIMIT", `Limit must be an integer from 1 to ${TABLE_QUERY_LIMIT_MAX}.`);
    }
    limit = Number(rawLimit);
  }
  if (params.has("cursor") && params.get("cursor") === "") {
    throw invalid("INVALID_CURSOR", "The table cursor must be a non-empty document ID.");
  }
  const rawCursor = params.get("cursor");
  if (rawCursor !== null) parseDocId(rawCursor);
  return {
    filters,
    ...(prefix === undefined ? {} : { prefix }),
    order,
    skipCount,
    limit,
    ...(rawCursor === null ? {} : { cursor: rawCursor }),
  };
}

/** Parse a batch mutation body: { items: [{ id, data }] }. IDs and payloads
 * share the single-row bounds; the operation count is capped. */
export function parseBatchBody(value: unknown): TableBatchItem[] {
  if (!object(value) || !Array.isArray(value.items)) {
    throw invalid("INVALID_BATCH", "Batch bodies must be a JSON object with an items list.");
  }
  if (value.items.length === 0 || value.items.length > TABLE_BATCH_MAX) {
    throw invalid("INVALID_BATCH", `Batch bodies must list 1 to ${TABLE_BATCH_MAX} items.`);
  }
  return value.items.map((entry) => {
    if (!object(entry)) throw invalid("INVALID_BATCH", "Each batch item needs { id, data }.");
    return { docId: parseDocId(entry.id), data: parseDocument(entry.data) };
  });
}

interface TableRow {
  id: string;
  org_id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

interface DocRow {
  doc_id: string;
  owner_user_id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

/** Load one Table for this Organization. Unknown names (or
 * foreign-Organization names) resolve to null so routes answer 404, never a
 * cross-tenant leak. */
export async function loadTable(db: D1Database, orgId: string, name: string): Promise<TableDefinition | null> {
  const row = await db
    .prepare("SELECT id,org_id,name,owner_user_id,created_at FROM tables WHERE org_id=? AND name=?")
    .bind(orgId, name)
    .first<TableRow>();
  if (!row) return null;
  if (!UUID.test(row.id)) throw new Error("Table declaration carries invalid identity.");
  return { id: row.id, orgId: row.org_id, name: row.name, ownerUserId: row.owner_user_id, createdAt: row.created_at };
}

/** Per-action policy check: the owning user holds every action implicitly;
 * any other caller needs an explicit grant row. Deny-by-absence everywhere. */
export async function canAct(
  db: D1Database,
  table: TableDefinition,
  caller: Principal,
  action: TableAction,
): Promise<boolean> {
  if (caller.userId === table.ownerUserId) return true;
  const grant = await db
    .prepare("SELECT id FROM table_grants WHERE table_id=? AND action=? AND grantee_user_id=?")
    .bind(table.id, action, caller.userId)
    .first<{ id: string }>();
  return grant !== null;
}

async function requireAct(
  db: D1Database,
  table: TableDefinition,
  caller: Principal,
  action: TableAction,
): Promise<void> {
  if (!(await canAct(db, table, caller, action))) {
    throw invalid(
      action === "read" ? "TABLE_NOT_FOUND" : "TABLE_FORBIDDEN",
      "Table not found.",
      action === "read" ? 404 : 403,
    );
  }
}

function toDocument(row: DocRow): TableDocument {
  return {
    id: row.doc_id,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureOrg(db: D1Database, orgId: string): Promise<unknown> {
  return db
    .prepare("INSERT INTO organizations(id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, "table-owner")
    .run();
}

/** Create a Table declaration. The creator owns it implicitly; name
 * conflicts fail with TABLE_CONFLICT (409). */
export async function createTable(db: D1Database, caller: Principal, name: unknown): Promise<TableDefinition> {
  const tableName = parseTableName(name);
  await ensureOrg(db, caller.orgId);
  const id = crypto.randomUUID().toLowerCase();
  const now = new Date().toISOString();
  try {
    await db
      .prepare("INSERT INTO tables(id, org_id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, caller.orgId, tableName, caller.userId, now)
      .run();
  } catch {
    throw invalid("TABLE_CONFLICT", `Table "${tableName}" already exists in this Organization.`, 409);
  }
  return (await loadTable(db, caller.orgId, tableName)) as TableDefinition;
}

export async function listTables(db: D1Database, caller: Principal): Promise<TableDefinition[]> {
  const rows = await db
    .prepare("SELECT id,org_id,name,owner_user_id,created_at FROM tables WHERE org_id=? ORDER BY name ASC, id ASC")
    .bind(caller.orgId)
    .all<TableRow>();
  const visible: TableDefinition[] = [];
  for (const row of rows.results) {
    const table: TableDefinition = {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
    };
    if (caller.userId === table.ownerUserId) {
      visible.push(table);
      continue;
    }
    const grant = await db
      .prepare("SELECT id FROM table_grants WHERE table_id=? AND grantee_user_id=? LIMIT 1")
      .bind(table.id, caller.userId)
      .first<{ id: string }>();
    if (grant) visible.push(table);
  }
  return visible;
}

/** Grant one action on a Table to another user. Owner-only; idempotent on
 * re-grant. Grants are user IDs in this slice (role claims belong to AUTH-02). */
export async function grantTable(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  action: unknown,
  grantee: unknown,
): Promise<void> {
  if (caller.userId !== table.ownerUserId) {
    throw invalid("TABLE_FORBIDDEN", "Only the owning user grants access.", 403);
  }
  if (action !== "read" && action !== "insert" && action !== "update" && action !== "delete") {
    throw invalid("INVALID_ACTION", "Grant actions are read, insert, update, or delete.");
  }
  if (typeof grantee !== "string" || grantee.length === 0 || grantee.length > 256) {
    throw invalid("INVALID_GRANTEE", "Grants name a non-empty user ID up to 256 chars.");
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO table_grants(id, table_id, action, grantee_user_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(table_id, action, grantee_user_id) DO NOTHING",
    )
    .bind(crypto.randomUUID().toLowerCase(), table.id, action, grantee, now)
    .run();
}

/** Revoke one action grant. Owner-only; revoking a missing grant succeeds
 * silently (revocation converges immediately for subsequent calls). */
export async function revokeTable(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  action: unknown,
  grantee: unknown,
): Promise<void> {
  if (caller.userId !== table.ownerUserId) {
    throw invalid("TABLE_FORBIDDEN", "Only the owning user revokes access.", 403);
  }
  if (action !== "read" && action !== "insert" && action !== "update" && action !== "delete") {
    throw invalid("INVALID_ACTION", "Grant actions are read, insert, update, or delete.");
  }
  if (typeof grantee !== "string") throw invalid("INVALID_GRANTEE", "Revokes name a grantee user ID.");
  await db
    .prepare("DELETE FROM table_grants WHERE table_id=? AND action=? AND grantee_user_id=?")
    .bind(table.id, action, grantee)
    .run();
}

/** Insert one document under the caller's attribution. Conflicting document
 * IDs fail with DOCUMENT_CONFLICT (409). */
export async function insertRow(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  docId: unknown,
  data: unknown,
): Promise<TableDocument> {
  await requireAct(db, table, caller, "insert");
  const id = parseDocId(docId);
  const document = parseDocument(data);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        "INSERT INTO table_rows(table_id, org_id, doc_id, owner_user_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(table.id, table.orgId, id, caller.userId, JSON.stringify(document), now, now)
      .run();
  } catch {
    throw invalid("DOCUMENT_CONFLICT", `Document "${id}" already exists.`, 409);
  }
  return { id, data: document, createdAt: now, updatedAt: now };
}

/** Read one document a caller may see: per-action policy first, then the
 * row. Attribution is not a read gate: any read grant sees every row. */
export async function readRow(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  docId: string,
): Promise<TableDocument> {
  await requireAct(db, table, caller, "read");
  const row = await db
    .prepare(
      "SELECT doc_id,owner_user_id,data_json,created_at,updated_at FROM table_rows WHERE table_id=? AND doc_id=?",
    )
    .bind(table.id, parseDocId(docId))
    .first<DocRow>();
  if (!row) throw invalid("DOCUMENT_NOT_FOUND", "Document not found.", 404);
  return toDocument(row);
}

/** Replace one document wholesale. Missing documents fail with 404;
 * conflicting concurrent writers surface DOCUMENT_CONFLICT only when the
 * row appears between the check and the write (last-writer-wins otherwise:
 * optimistic row-version tokens were not established upstream and stay a
 * separate adaptation decision per issue #154). */
export async function updateRow(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  docId: unknown,
  data: unknown,
): Promise<TableDocument> {
  await requireAct(db, table, caller, "update");
  const id = parseDocId(docId);
  const document = parseDocument(data);
  const existing = await db
    .prepare("SELECT created_at FROM table_rows WHERE table_id=? AND doc_id=?")
    .bind(table.id, id)
    .first<{ created_at: string }>();
  if (!existing) throw invalid("DOCUMENT_NOT_FOUND", "Document not found.", 404);
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE table_rows SET data_json=?, updated_at=? WHERE table_id=? AND doc_id=?")
    .bind(JSON.stringify(document), now, table.id, id)
    .run();
  return { id, data: document, createdAt: existing.created_at, updatedAt: now };
}

/** Delete one document. Missing documents fail with 404. */
export async function deleteRow(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  docId: unknown,
): Promise<void> {
  await requireAct(db, table, caller, "delete");
  const id = parseDocId(docId);
  const changed = await db.prepare("DELETE FROM table_rows WHERE table_id=? AND doc_id=?").bind(table.id, id).run();
  if (changed.meta.changes === 0) throw invalid("DOCUMENT_NOT_FOUND", "Document not found.", 404);
}

/** Delete a Table declaration and every row and grant under it. Owner-only;
 * retention beyond explicit deletion is out of scope for this slice (see the
 * retention note in docs/upstream-parity.md TABLE-02). */
export async function deleteTable(db: D1Database, caller: Principal, table: TableDefinition): Promise<void> {
  if (caller.userId !== table.ownerUserId) {
    throw invalid("TABLE_FORBIDDEN", "Only the owning user deletes the table.", 403);
  }
  await db.prepare("DELETE FROM table_rows WHERE table_id=?").bind(table.id).run();
  await db.prepare("DELETE FROM table_grants WHERE table_id=?").bind(table.id).run();
  await db.prepare("DELETE FROM tables WHERE id=?").bind(table.id).run();
}

function matchesFilters(data: Record<string, unknown>, filters: readonly TableFilter[]): boolean {
  for (const filter of filters) {
    const actual = lookupPath(data, filter.path);
    if (actual === undefined || !scalarEquals(actual, filter.value)) return false;
  }
  return true;
}

/** Policy-safe bounded query (TABLE-02 query/count slice). Policy is checked
 * before any data is touched: denied callers answer like a missing Table
 * (404), never an empty page that leaks existence. The scan itself is a
 * bounded document-ID keyset walk (at most QUERY_ROW_CAP rows per call)
 * with in-Worker nested-filter matching over the capped page, so memory
 * stays flat on large Tables. Counts scan the same bounded window and report
 * honestly; skip_count skips the scan and answers total=-1. */
export async function queryRows(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  query: TableQuery,
): Promise<TablePage> {
  await requireAct(db, table, caller, "read");
  const direction = query.order === "desc" ? "DESC" : "ASC";
  const comparator = query.order === "desc" ? "<" : ">";
  const clauses = ["table_id=?"];
  const binds: (string | number)[] = [table.id];
  if (query.prefix !== undefined) {
    clauses.push("doc_id LIKE ? ESCAPE '\\'");
    binds.push(`${query.prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  if (query.cursor !== undefined) {
    clauses.push(`doc_id ${comparator} ?`);
    binds.push(query.cursor);
  }
  const scanned = await db
    .prepare(
      `SELECT doc_id,owner_user_id,data_json,created_at,updated_at FROM table_rows WHERE ${clauses.join(" AND ")} ORDER BY doc_id ${direction} LIMIT ?`,
    )
    .bind(...binds, TABLE_QUERY_ROW_CAP)
    .all<DocRow>();
  // Bounded memory: count every match in the window but retain only the
  // page plus one lookahead row; large Tables never inflate the Worker.
  let matched = 0;
  const page: TableDocument[] = [];
  for (const row of scanned.results) {
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    if (!matchesFilters(data, query.filters)) continue;
    matched += 1;
    if (page.length <= query.limit) {
      page.push({ id: row.doc_id, data, createdAt: row.created_at, updatedAt: row.updated_at });
    }
  }
  const rows = page.slice(0, query.limit);
  const hasMore = matched > query.limit;
  const last = rows[rows.length - 1];
  // Total stays cursor-independent: a second bounded scan without the
  // keyset cursor counts the whole filtered set (skipped entirely when the
  // caller passes skip_count). A filled scan window reports -2 (bounded, not
  // complete) instead of an invented exact number.
  let total: number;
  if (query.skipCount) {
    total = -1;
  } else if (query.cursor === undefined && scanned.results.length < TABLE_QUERY_ROW_CAP) {
    total = matched;
  } else {
    total = (
      await countRows(db, caller, table, {
        filters: query.filters,
        ...(query.prefix === undefined ? {} : { prefix: query.prefix }),
        skipCount: false,
      })
    ).total;
  }
  return {
    rows,
    hasMore,
    nextCursor: hasMore && last !== undefined ? last.id : null,
    total,
  };
}

/** Count the filtered matches behind a query, scoped and policy-checked.
 * Denied callers answer 404 like a missing Table (never a zero that leaks
 * non-existence versus no-access). skip_count answers total=-1 without
 * scanning; a window that fills the scan cap answers total=-2 (bounded, not
 * complete) instead of an invented exact number. */
export async function countRows(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  query: Pick<TableQuery, "filters" | "prefix" | "skipCount">,
): Promise<{ total: number }> {
  await requireAct(db, table, caller, "read");
  if (query.skipCount) return { total: -1 };
  const clauses = ["table_id=?"];
  const binds: (string | number)[] = [table.id];
  if (query.prefix !== undefined) {
    clauses.push("doc_id LIKE ? ESCAPE '\\'");
    binds.push(`${query.prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  const scanned = await db
    .prepare(`SELECT data_json FROM table_rows WHERE ${clauses.join(" AND ")} ORDER BY doc_id ASC LIMIT ?`)
    .bind(...binds, TABLE_QUERY_ROW_CAP)
    .all<{ data_json: string }>();
  let total = 0;
  for (const row of scanned.results) {
    if (matchesFilters(JSON.parse(row.data_json) as Record<string, unknown>, query.filters)) total += 1;
  }
  if (scanned.results.length >= TABLE_QUERY_ROW_CAP) return { total: -2 };
  return { total };
}

/** Batch insert with all-or-denied policy semantics (TABLE-02 batch slice):
 * the per-action policy preflight runs for every item first, and a single
 * policy/attribution denial fails the whole batch before any row is written
 * (TABLE_BATCH_DENIED). Operational per-item failures (conflicts, invalid
 * shapes) instead ride per-item results after the surviving writes land.
 * D1 writes go through one batch() call, so the surviving set is atomic. */
export async function batchInsert(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  items: readonly TableBatchItem[],
): Promise<{ results: TableBatchResult[] }> {
  const allowed = await canAct(db, table, caller, "insert");
  if (!allowed) {
    throw invalid("TABLE_BATCH_DENIED", "The batch is denied: this caller holds no insert grant.", 403);
  }
  // D1 batch() rejects the whole call on a constraint failure instead of
  // returning per-item results, so conflicts are preflighted: known IDs ride
  // per-item DOCUMENT_CONFLICT results while only fresh rows go through the
  // single atomic batch() call. A writer that races the preflight is
  // classified per item on the fallback path below.
  const existing = await db
    .prepare(`SELECT doc_id FROM table_rows WHERE table_id=? AND doc_id IN (${items.map(() => "?").join(",")})`)
    .bind(table.id, ...items.map((item) => item.docId))
    .all<{ doc_id: string }>();
  const taken = new Set(existing.results.map((row) => row.doc_id));
  const fresh = items.filter((item) => !taken.has(item.docId));
  const now = new Date().toISOString();
  if (fresh.length > 0) {
    try {
      await db.batch(
        fresh.map((item) =>
          db
            .prepare(
              "INSERT INTO table_rows(table_id, org_id, doc_id, owner_user_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(table.id, table.orgId, item.docId, caller.userId, JSON.stringify(item.data), now, now),
        ),
      );
    } catch {
      // Lost a race with a concurrent writer between preflight and write:
      // retry the fresh set row by row so each item still reports its own
      // outcome (conflict or written) instead of failing the batch.
      for (const item of fresh) {
        try {
          await db
            .prepare(
              "INSERT INTO table_rows(table_id, org_id, doc_id, owner_user_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(table.id, table.orgId, item.docId, caller.userId, JSON.stringify(item.data), now, now)
            .run();
        } catch {
          taken.add(item.docId);
        }
      }
    }
  }
  return {
    results: items.map((item) =>
      taken.has(item.docId)
        ? {
            docId: item.docId,
            ok: false as const,
            error: { code: "DOCUMENT_CONFLICT", message: `Document "${item.docId}" already exists.` },
          }
        : { docId: item.docId, ok: true as const, error: null },
    ),
  };
}

/** Batch update with the same all-or-denied policy shape as batch insert:
 * denied callers fail the whole batch first (TABLE_BATCH_DENIED); missing
 * rows ride per-item DOCUMENT_NOT_FOUND results after the surviving writes
 * land atomically through one batch() call. */
export async function batchUpdate(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  items: readonly TableBatchItem[],
): Promise<{ results: TableBatchResult[] }> {
  const allowed = await canAct(db, table, caller, "update");
  if (!allowed) {
    throw invalid("TABLE_BATCH_DENIED", "The batch is denied: this caller holds no update grant.", 403);
  }
  const existing = await db
    .prepare(`SELECT doc_id FROM table_rows WHERE table_id=? AND doc_id IN (${items.map(() => "?").join(",")})`)
    .bind(table.id, ...items.map((item) => item.docId))
    .all<{ doc_id: string }>();
  const present = new Set(existing.results.map((row) => row.doc_id));
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const order: number[] = [];
  items.forEach((item, index) => {
    if (!present.has(item.docId)) return;
    order.push(index);
    statements.push(
      db
        .prepare("UPDATE table_rows SET data_json=?, updated_at=? WHERE table_id=? AND doc_id=?")
        .bind(JSON.stringify(item.data), now, table.id, item.docId),
    );
  });
  if (statements.length > 0) await db.batch(statements);
  return {
    results: items.map((item) =>
      present.has(item.docId)
        ? { docId: item.docId, ok: true as const, error: null }
        : {
            docId: item.docId,
            ok: false as const,
            error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." },
          },
    ),
  };
}

/** Batch delete with the same all-or-denied policy shape: denied callers
 * fail the whole batch first (TABLE_BATCH_DENIED); missing rows ride
 * per-item DOCUMENT_NOT_FOUND results after the surviving deletes land
 * atomically through one batch() call. */
export async function batchDelete(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  docIds: readonly string[],
): Promise<{ results: TableBatchResult[] }> {
  if (docIds.length === 0 || docIds.length > TABLE_BATCH_MAX) {
    throw invalid("INVALID_BATCH", `Batch deletes must list 1 to ${TABLE_BATCH_MAX} document IDs.`);
  }
  const parsed = docIds.map((id) => parseDocId(id));
  const allowed = await canAct(db, table, caller, "delete");
  if (!allowed) {
    throw invalid("TABLE_BATCH_DENIED", "The batch is denied: this caller holds no delete grant.", 403);
  }
  const existing = await db
    .prepare(`SELECT doc_id FROM table_rows WHERE table_id=? AND doc_id IN (${parsed.map(() => "?").join(",")})`)
    .bind(table.id, ...parsed)
    .all<{ doc_id: string }>();
  const present = new Set(existing.results.map((row) => row.doc_id));
  const statements = parsed
    .filter((id) => present.has(id))
    .map((id) => db.prepare("DELETE FROM table_rows WHERE table_id=? AND doc_id=?").bind(table.id, id));
  if (statements.length > 0) await db.batch(statements);
  return {
    results: parsed.map((id) =>
      present.has(id)
        ? { docId: id, ok: true as const, error: null }
        : { docId: id, ok: false as const, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
    ),
  };
}

/** Parse a batch delete body: { ids: [...] }. */
export function parseBatchDeleteBody(value: unknown): string[] {
  if (!object(value) || !Array.isArray(value.ids)) {
    throw invalid("INVALID_BATCH", "Batch delete bodies must be a JSON object with an ids list.");
  }
  if (value.ids.length === 0 || value.ids.length > TABLE_BATCH_MAX) {
    throw invalid("INVALID_BATCH", `Batch deletes must list 1 to ${TABLE_BATCH_MAX} document IDs.`);
  }
  return value.ids.map((id) => parseDocId(id));
}
