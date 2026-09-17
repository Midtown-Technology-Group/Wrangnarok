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
// an optional key prefix, a physical document-ID allowlist (repeated
// document_ids keys, upstream 8af322ac/PR #730), nested-JSON equality
// filters (dot paths into the stored document), ascending or descending
// document-ID order, and cursor pagination. The allowlist ANDs with every
// other constraint and keeps normal document-ID order, never input order.
// Counts run scoped and let the caller skip them: skip_count
// answers total=-1 (a true omitted upstream specific, per issue #154) instead
// of scanning. Offset pagination, custom sorts, and projection/index
// management are unsupported and fail closed with explicit codes; version
// tokens were not established upstream and are a separate adaptation decision.
//
// Batch-write contract (TABLE-02 canonical slice, upstream 0428e0fb/PR
// #735): one endpoint with an explicit write_mode — insert, merge_upsert, or
// replace_upsert — over 0 through 25 documents. 26+ is rejected before any
// write, and the caller never auto-chunks: oversized batches fail closed
// (INVALID_BATCH) so transaction/policy atomicity cannot silently change.
// Local documents are whole objects, so merge and replace upsert with the
// same wholesale effect; both modes stay accepted for SDK portability. The
// 25-document bound (not upstream's 1000) is the Cloudflare-driven
// adaptation, recorded in docs/upstream-parity.md TABLE-02.
//
// D1 bounds (explicit, Free-tier viable): every document is capped at 4 KB of
// JSON, every bounded list scans at most QUERY_ROW_CAP rows in one query,
// the document_ids allowlist caps at 25 IDs of at most 255 chars each
// (bound parameters, never interpolation), and retention is org-owned
// deletion (see docs/upstream-parity.md TABLE-02).
// The 25-document bound holds on Free by construction. Authoritative
// Cloudflare behavior (checked 2026-09-17):
// https://developers.cloudflare.com/d1/platform/limits/ publishes 50 queries
// per Worker invocation on Free (1000 on Paid) and states that limits for
// individual queries apply to each individual statement inside a batch, so
// every batched statement is counted against the invocation budget — one
// batch() method call does NOT count once.
// https://developers.cloudflare.com/d1/worker-api/d1-database/ documents
// batch() as one call whose statements run as a single SQL transaction: a
// failing statement aborts or rolls back the entire sequence of that call.
// Atomicity therefore ends at the batch() call boundary — spreading one
// request over several batch() calls is several transactions, not one.
// A full-size request under this bound spends at most 29 queries against
// the 50-query Free cap, proven under the strictest plausible counting
// (every batched statement counts, including a rolled-back call): 1
// declaration load, up to 2 grant checks, 1 preflight SELECT of at most 26
// binds against the 100-bound-parameter cap, and 25 statements in one
// batch() call — with 21 queries of margin, and no row-by-row fallback
// exists that could spend more. Each INSERT carries at most ~4.6 KB
// against the 100 KB statement cap. The batch transport cap is 256 KB for
// the route body (25 capped documents plus ids and envelope fit; what
// persists still answers to the per-document CHECK). The D1 500 MB Free
// per-database limit (10 GB Paid), single-database transactions, and
// unsupported query operators are recorded in the parity ledger as explicit
// blockers.
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
/** Canonical batch-write ceiling (upstream 0428e0fb/PR #735 adapts 1000 down
 * to 25): 0 through 25 documents per request. 26+ is rejected before any
 * write, and the caller never auto-chunks: splitting would change
 * transaction/policy atomicity. At 25, one request fits in a single batch()
 * transaction and costs at most 29 queries against the 50-query Free
 * invocation cap counting every batched statement — 21 of margin, and no
 * fallback path exists that could spend more (see the header note and
 * docs/upstream-parity.md TABLE-02). */
export const TABLE_BATCH_MAX = 25;
/** Transport cap for the batch route body: 25 capped 4 KB documents plus ids
 * and envelope fit inside 256 KB with margin. What persists still answers
 * to the per-document CHECK; this bounds only the wire. */
export const TABLE_BATCH_BODY_LIMIT = 256_000;
/** Nested-filter ceiling: enough for authored queries, never a full scan DSL. */
export const TABLE_FILTER_MAX = 5;
/** Physical document-ID list ceiling: D1 allows 100 bound parameters per
 * statement and every query already spends binds on table_id (plus
 * prefix/cursor/limit), so 25 keeps the IN list far under the cap with
 * headroom left. A Cloudflare/D1 adaptation of the upstream bound. */
export const TABLE_DOCUMENT_IDS_MAX = 25;
/** Per-ID character bound for the document_ids query filter. */
export const TABLE_DOCUMENT_ID_QUERY_MAX = 255;

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
  /** Physical document-ID allowlist with set semantics (first-seen order).
   * Omitted when no document_ids keys are present; an explicitly present
   * empty/blank entry is invalid. Results keep normal document-ID order,
   * never input order. */
  readonly documentIds?: readonly string[];
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
    if (!["filter", "document_ids", "prefix", "order", "skip_count", "limit", "cursor"].includes(key)) {
      throw invalid(
        "UNSUPPORTED_QUERY",
        "Only filter, document_ids, prefix, order, skip_count, limit, and cursor are supported here.",
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
  // Physical document-ID allowlist (upstream 8af322ac/PR #730): repeated
  // document_ids keys with set semantics (first-seen dedup for SQL).
  // Unknown IDs silently match nothing. The length bound applies to the raw
  // repeated-key count before validation/dedup, matching upstream: padding
  // the list with repeats cannot evade the max. Transport adaptation:
  // upstream spoke JSON, here the list rides repeated query keys, so an
  // explicitly present empty/blank ID fails closed — query encoding cannot
  // faithfully distinguish upstream JSON [] from a missing filter. Each ID
  // is bound, never interpolated.
  const rawDocumentIds = params.getAll("document_ids");
  if (rawDocumentIds.length > TABLE_DOCUMENT_IDS_MAX) {
    throw invalid("TOO_MANY_DOCUMENT_IDS", `At most ${TABLE_DOCUMENT_IDS_MAX} document_ids are accepted.`);
  }
  const documentIds: string[] = [];
  for (const raw of rawDocumentIds) {
    if (raw.length === 0 || raw.trim().length === 0 || raw.length > TABLE_DOCUMENT_ID_QUERY_MAX) {
      throw invalid(
        "INVALID_DOCUMENT_IDS",
        `document_ids entries must be 1 to ${TABLE_DOCUMENT_ID_QUERY_MAX} characters.`,
      );
    }
    if (!documentIds.includes(raw)) documentIds.push(raw);
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
    ...(rawDocumentIds.length === 0 ? {} : { documentIds }),
    ...(prefix === undefined ? {} : { prefix }),
    order,
    skipCount,
    limit,
    ...(rawCursor === null ? {} : { cursor: rawCursor }),
  };
}

/** Canonical batch write modes (upstream 0428e0fb/PR #735): insert writes
 * fresh rows and reports per-item conflicts; merge_upsert and replace_upsert
 * insert missing rows and replace present ones wholesale. Local documents
 * are whole objects, so the two upsert modes share one wholesale effect;
 * both stay accepted so portable callers need no local fork. */
export type TableWriteMode = "insert" | "merge_upsert" | "replace_upsert";

/** One parsed batch item: a null docId is an idless row (upstream permits
 * them on the upsert path); the executor assigns a server UUID. */
export interface TableBatchInputItem {
  readonly docId: string | null;
  readonly data: Record<string, unknown>;
}

/** A canonical batch response: per-item outcomes in submission order plus
 * the count of successful writes. Count-only callers (return_documents
 * false) receive an empty results list with the same count. */
export interface TableBatchResponse {
  readonly results: TableBatchResult[];
  readonly count: number;
}

/** Internal executor modes: the three canonical write modes plus the
 * update-only semantics behind the batch-update compatibility route. */
export type TableBatchMode = TableWriteMode | "update";

/** A parsed canonical batch request: the executor mode, 0 through 25
 * items, and whether the response carries per-item detail or a bare count. */
export interface TableBatchRequest {
  readonly mode: TableBatchMode;
  readonly items: readonly TableBatchInputItem[];
  readonly returnDocuments: boolean;
}

/** Parse a canonical batch body: { write_mode?, upsert?, return_documents?,
 * items }. Legacy { items } bodies read as insert; legacy upsert:true reads
 * as merge_upsert. An explicit write_mode wins over the legacy flag; a
 * non-boolean upsert fails closed. Empty item lists are valid (a 0-document
 * write succeeds with count 0); 26+ fails closed before any write. Compat
 * shims force their mode and, for the update shim, require every item to
 * carry an id. */
export function parseBatchRequest(value: unknown, forceMode?: TableBatchMode): TableBatchRequest {
  if (!object(value) || !Array.isArray(value.items)) {
    throw invalid("INVALID_BATCH", "Batch bodies must be a JSON object with an items list.");
  }
  if (value.items.length > TABLE_BATCH_MAX) {
    throw invalid(
      "INVALID_BATCH",
      `Batch bodies must list 0 to ${TABLE_BATCH_MAX} items; split nothing client-side, the bound is atomicity.`,
    );
  }
  let mode: TableBatchMode = "insert";
  if (forceMode !== undefined) {
    mode = forceMode;
  } else if (value.write_mode !== undefined) {
    if (value.write_mode !== "insert" && value.write_mode !== "merge_upsert" && value.write_mode !== "replace_upsert") {
      throw invalid("INVALID_WRITE_MODE", 'write_mode must be "insert", "merge_upsert", or "replace_upsert".');
    }
    mode = value.write_mode;
  } else if (value.upsert === true) {
    mode = "merge_upsert";
  }
  if (value.upsert !== undefined && value.upsert !== true && value.upsert !== false) {
    throw invalid("INVALID_BATCH", "upsert must be true or false when present; prefer write_mode.");
  }
  let returnDocuments = true;
  if (value.return_documents !== undefined) {
    if (typeof value.return_documents !== "boolean") {
      throw invalid("INVALID_BATCH", "return_documents must be true or false when present.");
    }
    returnDocuments = value.return_documents;
  }
  const items = value.items.map((entry) => {
    if (!object(entry)) throw invalid("INVALID_BATCH", "Each batch item needs { data } and an optional id.");
    const data = parseDocument(entry.data);
    if (entry.id === undefined || entry.id === null) {
      if (forceMode === "update") throw invalid("INVALID_BATCH", "Batch updates need an id per item.");
      return { docId: null, data };
    }
    return { docId: parseDocId(entry.id), data };
  });
  return { mode, items, returnDocuments };
}

/** Parse a batch delete body: { ids }. 0 through 25 ids; empty deletes
 * succeed with count 0 like the write path. */
export function parseBatchDeleteBody(value: unknown): string[] {
  if (!object(value) || !Array.isArray(value.ids)) {
    throw invalid("INVALID_BATCH", "Batch delete bodies must be a JSON object with an ids list.");
  }
  if (value.ids.length > TABLE_BATCH_MAX) {
    throw invalid("INVALID_BATCH", `Batch deletes must list 0 to ${TABLE_BATCH_MAX} document IDs.`);
  }
  return value.ids.map((id) => parseDocId(id));
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

/** Detail-route visibility (issue #353): the same rule listTables applies —
 * owner or any grant. Strangers answer 404 (never an existence leak);
 * same-org non-grantees answer 404 as well, matching the list's omission. */
export async function requireVisibleTable(db: D1Database, caller: Principal, table: TableDefinition): Promise<void> {
  if (caller.userId === table.ownerUserId) return;
  const grant = await db
    .prepare("SELECT id FROM table_grants WHERE table_id=? AND grantee_user_id=? LIMIT 1")
    .bind(table.id, caller.userId)
    .first<{ id: string }>();
  if (!grant) throw invalid("TABLE_NOT_FOUND", "Table not found.", 404);
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

/** Append the physical document-ID allowlist as bound IN parameters, never
 * interpolated, so hostile IDs cannot escape the statement. Missing or empty
 * means no ID constraint. The (table_id, doc_id) composite index serves the
 * lookup; no migration is needed. */
function applyDocumentIds(clauses: string[], binds: (string | number)[], ids: readonly string[] | undefined): void {
  if (ids === undefined || ids.length === 0) return;
  clauses.push(`doc_id IN (${ids.map(() => "?").join(",")})`);
  binds.push(...ids);
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
  applyDocumentIds(clauses, binds, query.documentIds);
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
        documentIds: query.documentIds,
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
  query: Pick<TableQuery, "filters" | "documentIds" | "prefix" | "skipCount">,
): Promise<{ total: number }> {
  await requireAct(db, table, caller, "read");
  if (query.skipCount) return { total: -1 };
  const clauses = ["table_id=?"];
  const binds: (string | number)[] = [table.id];
  applyDocumentIds(clauses, binds, query.documentIds);
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

/** Existence preflight in one SELECT: at most TABLE_BATCH_MAX ids plus
 * table_id binds, far under the D1 100-bound-parameter cap. Empty input
 * skips the query entirely. */
async function preflightExisting(db: D1Database, table: TableDefinition, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (ids.length === 0) return found;
  const rows = await db
    .prepare(`SELECT doc_id FROM table_rows WHERE table_id=? AND doc_id IN (${ids.map(() => "?").join(",")})`)
    .bind(table.id, ...ids)
    .all<{ doc_id: string }>();
  for (const row of rows.results) found.add(row.doc_id);
  return found;
}

/** Single-transaction write discipline: the whole surviving set goes through
 * ONE batch() call, so it lands atomically or not at all (a failing
 * statement aborts or rolls back the call's entire sequence per the D1
 * worker API). D1 batch() rejects the whole call on a constraint failure
 * instead of returning per-item results, so callers preflight first to
 * classify per-item outcomes. There is deliberately NO row-by-row fallback:
 * retrying items individually after an aborted call would persist a partial
 * write set the caller never approved item-by-item, and up to N extra
 * statements would break the proven Free worst case below. A lost race
 * instead fails the whole request with TABLE_BATCH_RETRY (503, nothing
 * persisted — the single call rolled back) and the caller retries the full
 * batch; wholesale writes replay safely and per-item outcomes are
 * re-derived. Never split one request across several batch() calls: each
 * extra call is a separate transaction and a separate slice of the 50-query
 * Free invocation budget. */
async function runSingleBatch(db: D1Database, statements: readonly D1PreparedStatement[]): Promise<void> {
  if (statements.length === 0) return;
  try {
    await db.batch([...statements]);
  } catch {
    throw invalid(
      "TABLE_BATCH_RETRY",
      "The batch did not land: the single write transaction aborted and rolled back, so nothing was persisted. Retry the full batch.",
      503,
    );
  }
}

/** The single canonical batch-write executor (upstream 0428e0fb/PR #735):
 * one implementation behind POST rows/batch and both compatibility shims,
 * so there is exactly one authoritative batch semantics path. Policy and
 * attribution denials fail the whole batch before any row is written
 * (TABLE_BATCH_DENIED); operational per-item outcomes for preflight-known
 * states (conflicts, missing rows) ride per-item results in submission
 * order with an ok count, and the surviving set persists through one atomic
 * transaction — never a partial row-by-row write. A write transaction that
 * aborts past a clean preflight (a concurrent writer won the race) fails
 * the whole request with TABLE_BATCH_RETRY (503, nothing persisted) for a
 * full-batch retry. Empty batches succeed with count 0. Tables are never
 * auto-created: the declaration must exist, so writes cannot bypass owner
 * attribution. */
export async function executeBatchWrite(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  request: TableBatchRequest,
): Promise<TableBatchResponse> {
  // All-or-denied policy preflight first: upsert modes compose both grants
  // fail-closed (upstream row-policies have no local per-action split; a
  // caller that may only insert must not gain update power through upsert,
  // and vice versa). Nothing is written before every required grant holds.
  // Whole-request validation at the domain layer too: a future caller that
  // skips the parser still cannot slip an oversized batch past the bound.
  // Validation precedes the policy preflight, matching the route order.
  if (request.items.length > TABLE_BATCH_MAX) {
    throw invalid(
      "INVALID_BATCH",
      `Batch bodies must list 0 to ${TABLE_BATCH_MAX} items; split nothing client-side, the bound is atomicity.`,
    );
  }
  const actions: TableAction[] =
    request.mode === "insert" ? ["insert"] : request.mode === "update" ? ["update"] : ["insert", "update"];
  for (const action of actions) {
    if (!(await canAct(db, table, caller, action))) {
      throw invalid("TABLE_BATCH_DENIED", `The batch is denied: this caller holds no ${action} grant.`, 403);
    }
  }
  // Idless rows (upstream permits them on the upsert path) take a server
  // UUID here, before the preflight, so the rest of the executor sees only
  // concrete ids. UUIDs satisfy the document-ID alphabet.
  const now = new Date().toISOString();
  const ids = request.items.map((item) => item.docId ?? crypto.randomUUID().toLowerCase());
  const finish = (results: TableBatchResult[]): TableBatchResponse => {
    const count = results.filter((result) => result.ok).length;
    return request.returnDocuments ? { results, count } : { results: [], count };
  };
  if (ids.length === 0) return finish([]);
  const buildInsert = (docId: string, data: Record<string, unknown>): D1PreparedStatement =>
    db
      .prepare(
        "INSERT INTO table_rows(table_id, org_id, doc_id, owner_user_id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(table.id, table.orgId, docId, caller.userId, JSON.stringify(data), now, now);
  const buildUpdate = (docId: string, data: Record<string, unknown>): D1PreparedStatement =>
    db
      .prepare("UPDATE table_rows SET data_json=?, updated_at=? WHERE table_id=? AND doc_id=?")
      .bind(JSON.stringify(data), now, table.id, docId);

  if (request.mode === "insert") {
    const taken = await preflightExisting(db, table, ids);
    const seen = new Set<string>();
    const fresh: { docId: string; data: Record<string, unknown> }[] = [];
    // Per-index conflict flags: a repeat of an id already seen in this same
    // request conflicts like a present row, since the first occurrence
    // writes it.
    const conflicted = ids.map(() => false);
    ids.forEach((docId, index) => {
      if (taken.has(docId) || seen.has(docId)) {
        conflicted[index] = true;
        return;
      }
      seen.add(docId);
      fresh.push({ docId, data: request.items[index]!.data });
    });
    // The surviving set lands through the single transaction; a lost race
    // fails the whole request for retry (TABLE_BATCH_RETRY) instead of
    // persisting a partial set row by row.
    await runSingleBatch(
      db,
      fresh.map((item) => buildInsert(item.docId, item.data)),
    );
    return finish(
      ids.map((docId, index) =>
        taken.has(docId) || conflicted[index]
          ? {
              docId,
              ok: false as const,
              error: { code: "DOCUMENT_CONFLICT", message: `Document "${docId}" already exists.` },
            }
          : { docId, ok: true as const, error: null },
      ),
    );
  }

  if (request.mode === "update") {
    const present = await preflightExisting(db, table, ids);
    const targets = ids
      .map((docId, index) => ({ docId, data: request.items[index]!.data }))
      .filter((item) => present.has(item.docId));
    // Missing rows ride per-item DOCUMENT_NOT_FOUND from the preflight; the
    // surviving set lands through the single transaction, and a lost race
    // fails the whole request for retry instead of persisting row by row.
    await runSingleBatch(
      db,
      targets.map((item) => buildUpdate(item.docId, item.data)),
    );
    return finish(
      ids.map((docId) =>
        present.has(docId)
          ? { docId, ok: true as const, error: null }
          : {
              docId,
              ok: false as const,
              error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." },
            },
      ),
    );
  }

  // merge_upsert and replace_upsert: present rows are replaced wholesale
  // (local documents are whole objects, so the modes share one effect);
  // missing rows are inserted under the caller's attribution while updates
  // preserve the existing owner. Within-request repeats apply in submission
  // order, last write winning, every occurrence reporting ok.
  const present = await preflightExisting(db, table, ids);
  const seen = new Set<string>();
  const statements = ids.map((docId, index) => {
    const data = request.items[index]!.data;
    if (present.has(docId) || seen.has(docId)) return buildUpdate(docId, data);
    seen.add(docId);
    return buildInsert(docId, data);
  });
  // Every item reports ok: upserts insert or replace wholesale, so the only
  // failure mode past the preflight is a lost race, which fails the whole
  // request for retry instead of reconciling row by row.
  await runSingleBatch(db, statements);
  return finish(ids.map((docId) => ({ docId, ok: true as const, error: null })));
}

/** Batch delete behind the batch-delete compatibility route: denied callers
 * fail the whole batch first (TABLE_BATCH_DENIED); missing rows ride
 * per-item DOCUMENT_NOT_FOUND results. Deletes land through the same single
 * batch() transaction discipline as writes. */
export async function executeBatchDelete(
  db: D1Database,
  caller: Principal,
  table: TableDefinition,
  docIds: readonly string[],
): Promise<TableBatchResponse> {
  if (docIds.length > TABLE_BATCH_MAX) {
    throw invalid("INVALID_BATCH", `Batch deletes must list 0 to ${TABLE_BATCH_MAX} document IDs.`);
  }
  if (!(await canAct(db, table, caller, "delete"))) {
    throw invalid("TABLE_BATCH_DENIED", "The batch is denied: this caller holds no delete grant.", 403);
  }
  if (docIds.length === 0) return { results: [], count: 0 };
  const present = await preflightExisting(db, table, docIds);
  const targets = docIds.filter((id) => present.has(id));
  // Missing rows ride per-item DOCUMENT_NOT_FOUND from the preflight; the
  // surviving deletes land through the single transaction, and a lost race
  // fails the whole request for retry instead of deleting row by row.
  await runSingleBatch(
    db,
    targets.map((id) => db.prepare("DELETE FROM table_rows WHERE table_id=? AND doc_id=?").bind(table.id, id)),
  );
  const results = docIds.map((id) =>
    present.has(id)
      ? { docId: id, ok: true as const, error: null }
      : { docId: id, ok: false as const, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } },
  );
  return { results, count: results.filter((result) => result.ok).length };
}
