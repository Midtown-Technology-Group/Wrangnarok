// SPDX-License-Identifier: AGPL-3.0
// Browser App SDK runtime (APP-02, issue #160; ADR 019).
//
// Scoped runtime for authored apps: an installed app (identified by its
// Organization-scoped app UUID) invokes granted Sagas, reads/writes granted
// Tables, and uploads/downloads granted files through the app's context.
// Authorization is deny-by-absence: an active grant row must exist for the
// (app, kind, ref, permission) tuple at call time. Revocation flips the row
// and is checked on every call, so already-discovered client state confers
// no access. Hidden Tables are never listed and never-readable through the
// read path. All data lives in D1 (Worker + D1 only): Tables hold JSON
// document rows with a per-Table change revision, files hold small byte
// payloads (32 KiB cap) with finalize-after-upload verification and
// optimistic versioning, and subscriptions are bounded polling against the
// authoritative D1 revision (polling is acceptable for the first slice per
// OBS-02; no WebSocket, Durable Object, or Queue here).
//
// Errors use the shared Fault envelope; codes are listed in src/sdk.ts
// (SDK_ERROR_CODES) and pinned by test/app-runtime.test.ts.
import { Fault, hash, object, UUID } from "./domain";
import type { Principal } from "./domain";
import { loadApp } from "./apps";

export const APP_SDK_VERSION = "1" as const;
export const APP_TABLE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const APP_FILE_NAME = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
export const APP_GRANT_KINDS = ["saga", "table", "file"] as const;
export const APP_GRANT_PERMISSIONS = ["invoke", "read", "write"] as const;
export const APP_TABLE_MAX_ROWS = 500;
export const APP_TABLE_MAX_QUERY = 100;
export const APP_ROW_MAX_BYTES = 4096;
export const APP_FILE_MAX_BYTES = 32768;
export const APP_FILE_TOKEN_TTL_MS = 15 * 60 * 1000;

export type AppGrantKind = (typeof APP_GRANT_KINDS)[number];
export type AppGrantPermission = (typeof APP_GRANT_PERMISSIONS)[number];

export interface AppGrant {
  readonly id: string;
  readonly kind: AppGrantKind;
  readonly ref: string;
  readonly permission: AppGrantPermission;
  readonly revoked: boolean;
  readonly createdAt: string;
}

export interface AppTableDef {
  readonly id: string;
  readonly name: string;
  readonly visibility: "visible" | "hidden";
  readonly columns: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
}

export interface AppTableRow {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly tableRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AppFileMeta {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly version: number;
  readonly status: "pending" | "ready";
  readonly createdAt: string;
  readonly updatedAt: string;
}

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return new Fault(status, code, message, details);
}

function isGrantKind(value: unknown): value is AppGrantKind {
  return value === "saga" || value === "table" || value === "file";
}

function isGrantPermission(value: unknown): value is AppGrantPermission {
  return value === "invoke" || value === "read" || value === "write";
}

/** Validate the app UUID from the route and load the caller's Organization
 * app row. Unknown ids (or foreign-Organization ids) answer APP_NOT_FOUND
 * (404), never a cross-tenant leak. */
export async function loadRuntimeApp(db: D1Database, caller: Principal, appId: string) {
  const id = UUID.test(appId) ? appId.toLowerCase() : null;
  if (!id) throw invalid("INVALID_APP_ID", "App lookups need the exact app UUID.", 400);
  const row = await loadApp(db, caller, id);
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  return row;
}

export function parseGrantBody(body: unknown): { kind: AppGrantKind; ref: string; permission: AppGrantPermission } {
  if (!object(body)) throw invalid("INVALID_APP_GRANT", "An app grant needs kind, ref, and permission.");
  if (!isGrantKind(body.kind)) throw invalid("INVALID_APP_GRANT", "Grant kind must be saga, table, or file.");
  if (!isGrantPermission(body.permission)) {
    throw invalid("INVALID_APP_GRANT", "Grant permission must be invoke, read, or write.");
  }
  if (typeof body.ref !== "string" || body.ref.length === 0 || body.ref.length > 128) {
    throw invalid("INVALID_APP_GRANT", "Grant ref must be 1 to 128 chars.");
  }
  if (body.kind === "table" && !APP_TABLE_NAME.test(body.ref)) {
    throw invalid("INVALID_APP_GRANT", "Table grant refs must be lowercase table slugs.");
  }
  if (body.kind === "file" && (body.ref.includes("..") || !APP_FILE_NAME.test(body.ref))) {
    throw invalid("INVALID_APP_GRANT", "File grant refs must be relative paths.");
  }
  if (body.kind === "saga" && !UUID.test(body.ref)) {
    throw invalid("INVALID_APP_GRANT", "Saga grant refs must be stable Saga UUIDs.");
  }
  return { kind: body.kind, ref: body.ref, permission: body.permission };
}

/** Author-side grant administration (trusted Organization caller): create,
 * list, and revoke grants for one app. Grants are additive capability rows;
 * there is no update path (revoke then re-grant). */
export async function createAppGrant(
  db: D1Database,
  caller: Principal,
  appId: string,
  body: unknown,
): Promise<AppGrant> {
  const app = await loadRuntimeApp(db, caller, appId);
  const grant = parseGrantBody(body);
  const now = new Date().toISOString();
  const id = crypto.randomUUID().toLowerCase();
  try {
    await db
      .prepare(
        "INSERT INTO app_grants(id, app_id, org_id, kind, ref, permission, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      )
      .bind(id, app.id, caller.orgId, grant.kind, grant.ref, grant.permission, now)
      .run();
  } catch {
    throw invalid("APP_GRANT_CONFLICT", "This grant already exists for the app.", 409);
  }
  return { id, kind: grant.kind, ref: grant.ref, permission: grant.permission, revoked: false, createdAt: now };
}

export async function listAppGrants(db: D1Database, caller: Principal, appId: string): Promise<AppGrant[]> {
  const app = await loadRuntimeApp(db, caller, appId);
  const rows = await db
    .prepare(
      "SELECT id, kind, ref, permission, revoked, created_at FROM app_grants WHERE app_id=? ORDER BY created_at ASC, id ASC",
    )
    .bind(app.id)
    .all<{ id: string; kind: string; ref: string; permission: string; revoked: number; created_at: string }>();
  return rows.results.map((row) => ({
    id: row.id,
    kind: row.kind as AppGrantKind,
    ref: row.ref,
    permission: row.permission as AppGrantPermission,
    revoked: row.revoked === 1,
    createdAt: row.created_at,
  }));
}

export async function revokeAppGrant(
  db: D1Database,
  caller: Principal,
  appId: string,
  grantId: string,
): Promise<AppGrant> {
  const app = await loadRuntimeApp(db, caller, appId);
  if (!UUID.test(grantId)) throw invalid("INVALID_APP_GRANT", "Grant lookups need the exact grant UUID.", 400);
  const row = await db
    .prepare("SELECT id, kind, ref, permission, revoked, created_at FROM app_grants WHERE id=? AND app_id=?")
    .bind(grantId.toLowerCase(), app.id)
    .first<{ id: string; kind: string; ref: string; permission: string; revoked: number; created_at: string }>();
  if (!row) throw invalid("APP_GRANT_NOT_FOUND", "App grant not found.", 404);
  await db.prepare("UPDATE app_grants SET revoked=1 WHERE id=?").bind(row.id).run();
  return {
    id: row.id,
    kind: row.kind as AppGrantKind,
    ref: row.ref,
    permission: row.permission as AppGrantPermission,
    revoked: true,
    createdAt: row.created_at,
  };
}

/** Runtime guard: the app's own context must carry an active (non-revoked)
 * grant for this exact tuple. Checked on every scoped call, so revocation
 * takes effect immediately and discovered-but-ungranted refs fail. */
export async function requireAppGrant(
  db: D1Database,
  appId: string,
  kind: AppGrantKind,
  ref: string,
  permission: AppGrantPermission,
): Promise<void> {
  const row = await db
    .prepare("SELECT revoked FROM app_grants WHERE app_id=? AND kind=? AND ref=? AND permission=?")
    .bind(appId, kind, ref, permission)
    .first<{ revoked: number }>();
  if (!row || row.revoked === 1) {
    const code =
      kind === "saga" ? "APP_SAGA_FORBIDDEN" : kind === "table" ? "APP_TABLE_FORBIDDEN" : "APP_FILE_FORBIDDEN";
    throw invalid(code, "This app is not granted access to the requested resource.", 403);
  }
}

export function parseTableBody(body: unknown): { name: string; columns: string[]; visibility: "visible" | "hidden" } {
  if (!object(body)) throw invalid("INVALID_APP_TABLE", "A Table needs a name and optional columns.");
  if (typeof body.name !== "string" || !APP_TABLE_NAME.test(body.name)) {
    throw invalid("INVALID_APP_TABLE", "Table names must be lowercase slugs of 1 to 64 chars.");
  }
  let columns: string[] = [];
  if (body.columns !== undefined) {
    if (!Array.isArray(body.columns) || body.columns.length > 32) {
      throw invalid("INVALID_APP_TABLE", "Table columns must be a list of at most 32 names.");
    }
    for (const entry of body.columns) {
      if (typeof entry !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entry)) {
        throw invalid(
          "INVALID_APP_TABLE",
          "Column names must start with a letter and hold letters, digits, or underscores.",
        );
      }
    }
    columns = [...body.columns];
  }
  const visibility = body.visibility === undefined ? "visible" : body.visibility;
  if (visibility !== "visible" && visibility !== "hidden") {
    throw invalid("INVALID_APP_TABLE", "Table visibility must be visible or hidden.");
  }
  return { name: body.name, columns, visibility };
}

/** Declare (or redeclare) an app Table. Redeclaration keeps rows and bumps
 * nothing; visibility transitions take effect immediately for the list and
 * read paths below. */
export async function declareAppTable(
  db: D1Database,
  caller: Principal,
  app: { id: string },
  body: unknown,
): Promise<AppTableDef> {
  const parsed = parseTableBody(body);
  const now = new Date().toISOString();
  const existing = await db
    .prepare(
      "SELECT id, name, visibility, columns_json, revision, created_at FROM app_tables WHERE app_id=? AND name=?",
    )
    .bind(app.id, parsed.name)
    .first<{
      id: string;
      name: string;
      visibility: string;
      columns_json: string;
      revision: number;
      created_at: string;
    }>();
  if (existing) {
    await db
      .prepare("UPDATE app_tables SET visibility=?, columns_json=? WHERE id=?")
      .bind(parsed.visibility, JSON.stringify(parsed.columns), existing.id)
      .run();
    return {
      id: existing.id,
      name: existing.name,
      visibility: parsed.visibility,
      columns: parsed.columns,
      revision: existing.revision,
      createdAt: existing.created_at,
    };
  }
  const id = crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO app_tables(id, app_id, org_id, name, visibility, columns_json, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(id, app.id, caller.orgId, parsed.name, parsed.visibility, JSON.stringify(parsed.columns), now)
    .run();
  return { id, name: parsed.name, visibility: parsed.visibility, columns: parsed.columns, revision: 0, createdAt: now };
}

async function loadTableForApp(
  db: D1Database,
  appId: string,
  name: string,
): Promise<{
  id: string;
  name: string;
  visibility: string;
  columns_json: string;
  revision: number;
  created_at: string;
} | null> {
  if (!APP_TABLE_NAME.test(name)) throw invalid("INVALID_APP_TABLE", "Table names must be lowercase slugs.", 400);
  const row = await db
    .prepare(
      "SELECT id, name, visibility, columns_json, revision, created_at FROM app_tables WHERE app_id=? AND name=?",
    )
    .bind(appId, name)
    .first<{
      id: string;
      name: string;
      visibility: string;
      columns_json: string;
      revision: number;
      created_at: string;
    }>();
  return row ?? null;
}

/** Tables visible to the app runtime: hidden Tables are never listed. The
 * trusted author view (listDeclaredTables) shows both with visibility flags. */
export async function listRuntimeTables(db: D1Database, appId: string): Promise<AppTableDef[]> {
  const rows = await db
    .prepare(
      "SELECT id, name, visibility, columns_json, revision, created_at FROM app_tables WHERE app_id=? AND visibility='visible' ORDER BY name ASC",
    )
    .bind(appId)
    .all<{
      id: string;
      name: string;
      visibility: string;
      columns_json: string;
      revision: number;
      created_at: string;
    }>();
  const grants = await db
    .prepare(
      "SELECT ref FROM app_grants WHERE app_id=? AND kind='table' AND permission IN ('read', 'write') AND revoked=0",
    )
    .bind(appId)
    .all<{ ref: string }>();
  const allowed = new Set(grants.results.map((entry) => entry.ref));
  return rows.results
    .filter((row) => allowed.has(row.name))
    .map((row) => ({
      id: row.id,
      name: row.name,
      visibility: row.visibility as "visible" | "hidden",
      columns: JSON.parse(row.columns_json) as string[],
      revision: row.revision,
      createdAt: row.created_at,
    }));
}

export async function listDeclaredTables(db: D1Database, caller: Principal, appId: string): Promise<AppTableDef[]> {
  const app = await loadRuntimeApp(db, caller, appId);
  const rows = await db
    .prepare(
      "SELECT id, name, visibility, columns_json, revision, created_at FROM app_tables WHERE app_id=? ORDER BY name ASC",
    )
    .bind(app.id)
    .all<{
      id: string;
      name: string;
      visibility: string;
      columns_json: string;
      revision: number;
      created_at: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    visibility: row.visibility as "visible" | "hidden",
    columns: JSON.parse(row.columns_json) as string[],
    revision: row.revision,
    createdAt: row.created_at,
  }));
}

export interface TableQuery {
  readonly filter: Record<string, string | number | boolean>;
  readonly limit: number;
  readonly cursor: string | null;
  readonly sinceRevision: number | null;
}

export function parseTableQuery(params: URLSearchParams): TableQuery {
  // Deny-by-default query keys: only the documented read keys ride along.
  for (const key of params.keys()) {
    if (!["filter", "limit", "cursor", "sinceRevision"].includes(key)) {
      throw invalid("UNSUPPORTED_QUERY", "Only filter, limit, cursor, and sinceRevision are supported here.");
    }
  }
  const filter: Record<string, string | number | boolean> = {};
  const rawFilter = params.get("filter");
  if (rawFilter !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawFilter);
    } catch {
      throw invalid("INVALID_TABLE_QUERY", "Table filter must be a JSON object of equality clauses.");
    }
    if (!object(parsed))
      throw invalid("INVALID_TABLE_QUERY", "Table filter must be a JSON object of equality clauses.");
    // Query-only filters (TABLE-02 follow-up): exact-match equality on
    // top-level fields only. Nested JSON filters, ranges, sorts, and counts
    // are explicit follow-ups (APP_TABLE_QUERY_UNSUPPORTED), never silently
    // widened into a scan that pretends to be a query.
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
        throw invalid("INVALID_TABLE_QUERY", `Filter field ${JSON.stringify(key)} is not a column name.`);
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw invalid(
          "APP_TABLE_QUERY_UNSUPPORTED",
          "Table filters support exact-match strings, numbers, and booleans only.",
          422,
        );
      }
      filter[key] = value;
    }
    if (Object.keys(filter).length > 8) {
      throw invalid("INVALID_TABLE_QUERY", "Table filters accept at most 8 equality clauses.");
    }
  }
  let limit = 50;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > APP_TABLE_MAX_QUERY) {
      throw invalid("INVALID_TABLE_QUERY", `Table limit must be an integer from 1 to ${APP_TABLE_MAX_QUERY}.`);
    }
  }
  const cursor = params.get("cursor");
  if (cursor !== null && !UUID.test(cursor)) {
    throw invalid("INVALID_TABLE_QUERY", "Table cursor must be an opaque row UUID from a previous page.");
  }
  let sinceRevision: number | null = null;
  const rawSince = params.get("sinceRevision");
  if (rawSince !== null) {
    sinceRevision = Number(rawSince);
    if (!Number.isInteger(sinceRevision) || sinceRevision < 0) {
      throw invalid("INVALID_TABLE_QUERY", "sinceRevision must be a non-negative integer Table revision.");
    }
  }
  return { filter, limit, cursor, sinceRevision };
}

function matchFilter(data: Record<string, unknown>, filter: Record<string, string | number | boolean>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (data[key] !== value) return false;
  }
  return true;
}

/** Filtered, bounded page read over one app Table. Hidden Tables are denied
 * (404 APP_TABLE_NOT_FOUND, never a leak); the read grant is enforced by the
 * caller before entry. Rows scan newest-first with cursor continuation; the
 * response carries the authoritative Table revision so pollers can detect
 * change without trusting a stream. */
export async function readTableRows(
  db: D1Database,
  app: { id: string },
  tableName: string,
  query: TableQuery,
): Promise<{ rows: AppTableRow[]; hasMore: boolean; nextCursor: string | null; tableRevision: number }> {
  const table = await loadTableForApp(db, app.id, tableName);
  if (!table || table.visibility !== "visible") {
    throw invalid("APP_TABLE_NOT_FOUND", "Table not found.", 404);
  }
  // Bounded-poll shortcut: a poller that already holds the authoritative
  // revision learns nothing changed without paying for the row scan.
  if (query.sinceRevision !== null && query.sinceRevision >= table.revision) {
    return { rows: [], hasMore: false, nextCursor: null, tableRevision: table.revision };
  }
  const rows = await db
    .prepare(
      "SELECT id, data_json, table_revision, created_at, updated_at FROM app_rows WHERE table_id=? ORDER BY created_at DESC, id DESC LIMIT 500",
    )
    .bind(table.id)
    .all<{ id: string; data_json: string; table_revision: number; created_at: string; updated_at: string }>();
  const matched: AppTableRow[] = [];
  for (const row of rows.results) {
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    if (!matchFilter(data, query.filter)) continue;
    matched.push({
      id: row.id,
      data,
      tableRevision: row.table_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  let start = 0;
  if (query.cursor) {
    const at = matched.findIndex((row) => row.id === query.cursor);
    if (at === -1) throw invalid("INVALID_TABLE_QUERY", "Table cursor is stale; re-list from the first page.");
    start = at + 1;
  }
  const page = matched.slice(start, start + query.limit);
  const rest = matched.length - start - page.length;
  return {
    rows: page,
    hasMore: rest > 0,
    nextCursor: rest > 0 && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null,
    tableRevision: table.revision,
  };
}

function checkRowData(data: unknown): Record<string, unknown> {
  if (!object(data)) throw invalid("INVALID_TABLE_ROW", "Table rows must be JSON objects.");
  const keys = Object.keys(data);
  if (keys.length === 0 || keys.length > 32) {
    throw invalid("INVALID_TABLE_ROW", "Table rows must carry 1 to 32 fields.");
  }
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw invalid("INVALID_TABLE_ROW", `Row field ${JSON.stringify(key)} is not a column name.`);
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
  if (bytes > APP_ROW_MAX_BYTES) {
    throw invalid("INVALID_TABLE_ROW", `Table rows must fit ${APP_ROW_MAX_BYTES} UTF-8 bytes.`);
  }
  return data;
}

/** Scoped row write: insert one document row. The write grant is enforced by
 * the caller before entry; the Table revision bumps once per write so
 * pollers observe change through the authoritative revision. */
export async function insertTableRow(
  db: D1Database,
  caller: Principal,
  app: { id: string },
  tableName: string,
  data: unknown,
): Promise<AppTableRow> {
  const table = await loadTableForApp(db, app.id, tableName);
  if (!table || table.visibility !== "visible") {
    throw invalid("APP_TABLE_NOT_FOUND", "Table not found.", 404);
  }
  const checked = checkRowData(data);
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM app_rows WHERE table_id=?")
    .bind(table.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= APP_TABLE_MAX_ROWS) {
    throw invalid(
      "APP_TABLE_FULL",
      `Table ${JSON.stringify(tableName)} holds at most ${APP_TABLE_MAX_ROWS} rows in this slice.`,
      409,
    );
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID().toLowerCase();
  const nextRevision = table.revision + 1;
  const dataJson = JSON.stringify(checked);
  await db
    .prepare(
      "INSERT INTO app_rows(id, table_id, app_id, org_id, data_json, table_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, table.id, app.id, caller.orgId, dataJson, nextRevision, now, now)
    .run();
  await db.prepare("UPDATE app_tables SET revision=? WHERE id=?").bind(nextRevision, table.id).run();
  return { id, data: checked, tableRevision: nextRevision, createdAt: now, updatedAt: now };
}

/** Scoped row patch: replace one document row by exact row UUID. The write
 * grant is enforced by the caller before entry. Blind PATCH retry is unsafe
 * for callers (last-writer-wins); the SDK retries PATCH only with an
 * idempotency key or not at all. */
export async function patchTableRow(
  db: D1Database,
  app: { id: string },
  tableName: string,
  rowId: string,
  data: unknown,
): Promise<AppTableRow> {
  const table = await loadTableForApp(db, app.id, tableName);
  if (!table || table.visibility !== "visible") {
    throw invalid("APP_TABLE_NOT_FOUND", "Table not found.", 404);
  }
  if (!UUID.test(rowId)) throw invalid("INVALID_TABLE_ROW", "Row lookups need the exact row UUID.", 400);
  const checked = checkRowData(data);
  const existing = await db
    .prepare("SELECT id, created_at FROM app_rows WHERE id=? AND table_id=?")
    .bind(rowId.toLowerCase(), table.id)
    .first<{ id: string; created_at: string }>();
  if (!existing) throw invalid("APP_ROW_NOT_FOUND", "Table row not found.", 404);
  const now = new Date().toISOString();
  const nextRevision = table.revision + 1;
  await db
    .prepare("UPDATE app_rows SET data_json=?, table_revision=?, updated_at=? WHERE id=?")
    .bind(JSON.stringify(checked), nextRevision, now, existing.id)
    .run();
  await db.prepare("UPDATE app_tables SET revision=? WHERE id=?").bind(nextRevision, table.id).run();
  return {
    id: existing.id,
    data: checked,
    tableRevision: nextRevision,
    createdAt: existing.created_at,
    updatedAt: now,
  };
}

/** Scoped row delete by exact row UUID. Counts toward the Table revision so
 * pollers observe removal. */
export async function deleteTableRow(
  db: D1Database,
  app: { id: string },
  tableName: string,
  rowId: string,
): Promise<{ deleted: true; tableRevision: number }> {
  const table = await loadTableForApp(db, app.id, tableName);
  if (!table || table.visibility !== "visible") {
    throw invalid("APP_TABLE_NOT_FOUND", "Table not found.", 404);
  }
  if (!UUID.test(rowId)) throw invalid("INVALID_TABLE_ROW", "Row lookups need the exact row UUID.", 400);
  const existing = await db
    .prepare("SELECT id FROM app_rows WHERE id=? AND table_id=?")
    .bind(rowId.toLowerCase(), table.id)
    .first<{ id: string }>();
  if (!existing) throw invalid("APP_ROW_NOT_FOUND", "Table row not found.", 404);
  await db.prepare("DELETE FROM app_rows WHERE id=?").bind(existing.id).run();
  const nextRevision = table.revision + 1;
  await db.prepare("UPDATE app_tables SET revision=? WHERE id=?").bind(nextRevision, table.id).run();
  return { deleted: true, tableRevision: nextRevision };
}

export function parseFileDeclare(body: unknown): { name: string; contentType: string } {
  if (!object(body)) throw invalid("INVALID_APP_FILE", "A file declaration needs a name.");
  if (typeof body.name !== "string" || body.name.includes("..") || !APP_FILE_NAME.test(body.name)) {
    throw invalid("INVALID_APP_FILE", "File names must be relative paths of 1 to 128 chars.");
  }
  const contentType = body.contentType === undefined ? "application/octet-stream" : body.contentType;
  if (typeof contentType !== "string" || contentType.length === 0 || contentType.length > 128) {
    throw invalid("INVALID_APP_FILE", "File content types must be 1 to 128 chars.");
  }
  return { name: body.name, contentType };
}

/** Declare a file location (author or runtime with the file grant context).
 * Declaration alone stores no bytes: status stays pending until an upload
 * token is redeemed with matching metadata (finalize-after-upload). */
export async function declareAppFile(
  db: D1Database,
  caller: Principal,
  app: { id: string },
  body: unknown,
): Promise<AppFileMeta> {
  const parsed = parseFileDeclare(body);
  const existing = await db
    .prepare(
      "SELECT id, name, content_type, size, sha256, version, status, created_at, updated_at FROM app_files WHERE app_id=? AND name=?",
    )
    .bind(app.id, parsed.name)
    .first<{
      id: string;
      name: string;
      content_type: string;
      size: number;
      sha256: string;
      version: number;
      status: string;
      created_at: string;
      updated_at: string;
    }>();
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      contentType: existing.content_type,
      size: existing.size,
      sha256: existing.sha256,
      version: existing.version,
      status: existing.status as "pending" | "ready",
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
    };
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO app_files(id, app_id, org_id, name, content_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, app.id, caller.orgId, parsed.name, parsed.contentType, now, now)
    .run();
  return {
    id,
    name: parsed.name,
    contentType: parsed.contentType,
    size: 0,
    sha256: "",
    version: 1,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export async function listAppFiles(db: D1Database, appId: string): Promise<AppFileMeta[]> {
  const rows = await db
    .prepare(
      "SELECT id, name, content_type, size, sha256, version, status, created_at, updated_at FROM app_files WHERE app_id=? ORDER BY name ASC",
    )
    .bind(appId)
    .all<{
      id: string;
      name: string;
      content_type: string;
      size: number;
      sha256: string;
      version: number;
      status: string;
      created_at: string;
      updated_at: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    contentType: row.content_type,
    size: row.size,
    sha256: row.sha256,
    version: row.version,
    status: row.status as "pending" | "ready",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Runtime file listing: only files carrying an active read grant for this
 * app are visible. Write-only files (upload targets) stay unlisted until a
 * read grant arrives, mirroring hidden Tables on the read path. */
export async function listRuntimeFiles(db: D1Database, appId: string): Promise<AppFileMeta[]> {
  const files = await listAppFiles(db, appId);
  const grants = await db
    .prepare("SELECT ref FROM app_grants WHERE app_id=? AND kind='file' AND permission='read' AND revoked=0")
    .bind(appId)
    .all<{ ref: string }>();
  const allowed = new Set(grants.results.map((row) => row.ref));
  return files.filter((file) => allowed.has(file.name));
}

export interface AppHandshakeApp {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

export interface AppHandshake {
  readonly sdk: "wrangnarok.app-runtime";
  readonly version: typeof APP_SDK_VERSION;
  readonly app: AppHandshakeApp;
}

/** Compatibility handshake descriptor (APP-02 acceptance): the browser SDK
 * asserts name and version before its first scoped call, so a stale bundled
 * SDK against a newer Worker (or vice versa) fails loud with APP_SDK_MISMATCH
 * instead of misreading a changed shape. */
export function describeAppHandshake(app: { id: string; name: string; slug: string; status: string }): AppHandshake {
  return {
    sdk: "wrangnarok.app-runtime",
    version: APP_SDK_VERSION,
    app: { id: app.id, name: app.name, slug: app.slug, status: app.status },
  };
}

async function loadFileForApp(
  db: D1Database,
  appId: string,
  name: string,
): Promise<{
  id: string;
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
} | null> {
  if (name.includes("..") || !APP_FILE_NAME.test(name)) {
    throw invalid("INVALID_APP_FILE", "File names must be relative paths.", 400);
  }
  const row = await db
    .prepare(
      "SELECT id, name, content_type, size, sha256, version, status, created_at, updated_at FROM app_files WHERE app_id=? AND name=?",
    )
    .bind(appId, name)
    .first<{
      id: string;
      name: string;
      content_type: string;
      size: number;
      sha256: string;
      version: number;
      status: string;
      created_at: string;
      updated_at: string;
    }>();
  return row ?? null;
}

/** Issue a single-use scoped capability token for one file upload or
 * download. Tokens are bearer capabilities: random, hashed at rest, bound
 * to one file and scope, expiring after 15 minutes. The app runtime
 * exchanges them without the Organization Bearer token. */
export async function issueFileToken(
  db: D1Database,
  appId: string,
  fileName: string,
  scope: "upload" | "download",
): Promise<{ token: string; expiresAt: string }> {
  const file = await loadFileForApp(db, appId, fileName);
  if (!file) throw invalid("APP_FILE_NOT_FOUND", "File not found.", 404);
  const raw = `appfile-${crypto.randomUUID()}-${Date.now()}`;
  const tokenHash = await hash(raw);
  const nowMs = Date.now();
  const expiresAt = new Date(nowMs + APP_FILE_TOKEN_TTL_MS).toISOString();
  await db
    .prepare(
      "INSERT INTO app_file_tokens(token_hash, file_id, app_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(tokenHash, file.id, appId, scope, expiresAt, new Date(nowMs).toISOString())
    .run();
  return { token: raw, expiresAt };
}

/** Redeem one upload token with the file bytes. Single-use: the token row
 * is deleted on first redemption. Declared metadata (contentType, size,
 * sha256) is verified against the bytes; mismatch fails closed without
 * storing. Stale versions conflict (409) rather than silently overwriting. */
export async function redeemFileUpload(
  db: D1Database,
  appId: string,
  token: string,
  body: unknown,
): Promise<AppFileMeta> {
  if (typeof token !== "string" || token.length === 0 || token.length > 256) {
    throw invalid("APP_FILE_TOKEN_INVALID", "A file upload token is required.", 401);
  }
  const tokenHash = await hash(token);
  const tokenRow = await db
    .prepare("SELECT file_id, app_id, scope, expires_at FROM app_file_tokens WHERE token_hash=?")
    .bind(tokenHash)
    .first<{ file_id: string; app_id: string; scope: string; expires_at: string }>();
  if (!tokenRow || tokenRow.app_id !== appId || tokenRow.scope !== "upload") {
    throw invalid("APP_FILE_TOKEN_INVALID", "The file upload token is unknown or out of scope.", 401);
  }
  if (Date.parse(tokenRow.expires_at) <= Date.now()) {
    await db.prepare("DELETE FROM app_file_tokens WHERE token_hash=?").bind(tokenHash).run();
    throw invalid("APP_FILE_TOKEN_EXPIRED", "The file upload token has expired.", 401);
  }
  if (!object(body)) throw invalid("INVALID_APP_FILE", "File upload needs content, contentType, size, and sha256.");
  const { content, contentType, size, sha256, expectedVersion } = body as Record<string, unknown>;
  if (
    typeof content !== "string" ||
    typeof contentType !== "string" ||
    typeof size !== "number" ||
    typeof sha256 !== "string"
  ) {
    throw invalid("INVALID_APP_FILE", "File upload needs content, contentType, size, and sha256.");
  }
  let bytes: Uint8Array;
  try {
    const bin = atob(content);
    bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    throw invalid("INVALID_APP_FILE", "File content must be base64.");
  }
  if (bytes.byteLength !== size) {
    throw invalid("APP_FILE_METADATA_MISMATCH", "Declared file size does not match the uploaded bytes.", 422);
  }
  if (bytes.byteLength > APP_FILE_MAX_BYTES) {
    throw invalid("APP_FILE_TOO_LARGE", `Files must fit ${APP_FILE_MAX_BYTES} bytes in this slice.`, 413);
  }
  const copy = Uint8Array.from(bytes);
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  const digest = Array.from(digestBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  if (digest !== sha256) {
    throw invalid("APP_FILE_METADATA_MISMATCH", "Declared file sha256 does not match the uploaded bytes.", 422);
  }
  const file = await db
    .prepare("SELECT id, name, version, status, created_at FROM app_files WHERE id=? AND app_id=?")
    .bind(tokenRow.file_id, appId)
    .first<{ id: string; name: string; version: number; status: string; created_at: string }>();
  if (!file) throw invalid("APP_FILE_NOT_FOUND", "File not found.", 404);
  // Deny-by-absence at redeem time, not issue time: a grant revoked after
  // the token was issued fails closed here, so outstanding tokens confer no
  // access on their own.
  await requireAppGrant(db, appId, "file", file.name, "write");
  if (expectedVersion !== undefined && expectedVersion !== file.version) {
    throw invalid("APP_FILE_VERSION_CONFLICT", "The file changed under this upload; re-list and retry.", 409);
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE app_files SET content_type=?, size=?, sha256=?, content_base64=?, version=?, status='ready', updated_at=? WHERE id=?",
    )
    .bind(
      contentType.slice(0, 128),
      size,
      sha256,
      content,
      file.version + (file.status === "ready" ? 1 : 0),
      now,
      file.id,
    )
    .run();
  await db.prepare("DELETE FROM app_file_tokens WHERE token_hash=?").bind(tokenHash).run();
  const updated = await db
    .prepare(
      "SELECT id, name, content_type, size, sha256, version, status, created_at, updated_at FROM app_files WHERE id=?",
    )
    .bind(file.id)
    .first<{
      id: string;
      name: string;
      content_type: string;
      size: number;
      sha256: string;
      version: number;
      status: string;
      created_at: string;
      updated_at: string;
    }>();
  if (!updated) throw invalid("APP_FILE_NOT_FOUND", "File not found.", 404);
  return {
    id: updated.id,
    name: updated.name,
    contentType: updated.content_type,
    size: updated.size,
    sha256: updated.sha256,
    version: updated.version,
    status: updated.status as "pending" | "ready",
    createdAt: updated.created_at,
    updatedAt: updated.updated_at,
  };
}

/** Redeem one download token. Single-use like upload. Returns metadata plus
 * the base64 bytes; only ready files download. */
export async function redeemFileDownload(
  db: D1Database,
  appId: string,
  token: string,
): Promise<{ meta: AppFileMeta; content: string }> {
  if (typeof token !== "string" || token.length === 0 || token.length > 256) {
    throw invalid("APP_FILE_TOKEN_INVALID", "A file download token is required.", 401);
  }
  const tokenHash = await hash(token);
  const tokenRow = await db
    .prepare("SELECT file_id, app_id, scope, expires_at FROM app_file_tokens WHERE token_hash=?")
    .bind(tokenHash)
    .first<{ file_id: string; app_id: string; scope: string; expires_at: string }>();
  if (!tokenRow || tokenRow.app_id !== appId || tokenRow.scope !== "download") {
    throw invalid("APP_FILE_TOKEN_INVALID", "The file download token is unknown or out of scope.", 401);
  }
  if (Date.parse(tokenRow.expires_at) <= Date.now()) {
    await db.prepare("DELETE FROM app_file_tokens WHERE token_hash=?").bind(tokenHash).run();
    throw invalid("APP_FILE_TOKEN_EXPIRED", "The file download token has expired.", 401);
  }
  const file = await db
    .prepare(
      "SELECT id, name, content_type, size, sha256, content_base64, version, status, created_at, updated_at FROM app_files WHERE id=? AND app_id=?",
    )
    .bind(tokenRow.file_id, appId)
    .first<{
      id: string;
      name: string;
      content_type: string;
      size: number;
      sha256: string;
      content_base64: string;
      version: number;
      status: string;
      created_at: string;
      updated_at: string;
    }>();
  if (!file) throw invalid("APP_FILE_NOT_FOUND", "File not found.", 404);
  // Deny-by-absence at redeem time, not issue time (mirrors upload): a grant
  // revoked after the token was issued fails closed here.
  await requireAppGrant(db, appId, "file", file.name, "read");
  if (file.status !== "ready") throw invalid("APP_FILE_NOT_READY", "The file has no uploaded bytes yet.", 409);
  await db.prepare("DELETE FROM app_file_tokens WHERE token_hash=?").bind(tokenHash).run();
  return {
    meta: {
      id: file.id,
      name: file.name,
      contentType: file.content_type,
      size: file.size,
      sha256: file.sha256,
      version: file.version,
      status: "ready",
      createdAt: file.created_at,
      updatedAt: file.updated_at,
    },
    content: file.content_base64,
  };
}

/** Scoped version-aware file delete (author or runtime with the write
 * grant). Stale versions conflict; missing files 404 (never silent). */
export async function deleteAppFile(
  db: D1Database,
  app: { id: string },
  fileName: string,
  expectedVersion: unknown,
): Promise<{ deleted: true }> {
  const file = await loadFileForApp(db, app.id, fileName);
  if (!file) throw invalid("APP_FILE_NOT_FOUND", "File not found.", 404);
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== file.version) {
    throw invalid("APP_FILE_VERSION_CONFLICT", "The file changed under this delete; re-list and retry.", 409);
  }
  await db.prepare("DELETE FROM app_file_tokens WHERE file_id=?").bind(file.id).run();
  await db.prepare("DELETE FROM app_files WHERE id=?").bind(file.id).run();
  return { deleted: true };
}

/** Record one app-scoped Execution linkage (invoke path writes this after a
 * successful submit). Powers the app activity tail: recent scoped
 * invocations without exposing foreign executions. */
export async function recordAppExecution(
  db: D1Database,
  caller: Principal,
  appId: string,
  executionId: string,
  sagaId: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO app_executions(app_id, execution_id, org_id, saga_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, execution_id) DO NOTHING",
    )
    .bind(appId, executionId, caller.orgId, sagaId, new Date().toISOString())
    .run();
}

export async function listAppExecutions(
  db: D1Database,
  appId: string,
  limit: number,
): Promise<readonly { executionId: string; sagaId: string; createdAt: string }[]> {
  const rows = await db
    .prepare(
      "SELECT execution_id, saga_id, created_at FROM app_executions WHERE app_id=? ORDER BY created_at DESC, execution_id DESC LIMIT ?",
    )
    .bind(appId, Math.min(Math.max(limit, 1), 50))
    .all<{ execution_id: string; saga_id: string; created_at: string }>();
  return rows.results.map((row) => ({ executionId: row.execution_id, sagaId: row.saga_id, createdAt: row.created_at }));
}
