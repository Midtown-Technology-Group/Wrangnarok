// SPDX-License-Identifier: AGPL-3.0
// Typed fetch wrappers for the Tables APIs (TABLE-01/TABLE-02, issues
// #117/#154; UI parity issue #556). Bearer [REDACTED] only, same as
// lib/api-client.ts. Lives in its own module so the Tables UI lane avoids
// editing the shared api-client.ts owned by sibling lanes.
//
// Worker routes covered: GET/POST /api/tables, GET/DELETE
// /api/tables/:name, GET rows, GET count, PUT/GET/PATCH/DELETE rows/:id,
// POST rows/batch, PUT rows/batch-update, POST rows/batch-delete, and
// POST/DELETE grants. Query keys mirror src/tables.ts parseTableQuery:
// filter, document_ids, prefix, order, skip_count, limit, cursor.
// Realtime subscriptions do not exist; callers poll with repeated GETs.
import { parseApiError } from "./api-error";
import { getToken } from "./api-client";

export interface TableSummary {
  id: string;
  orgId: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
}

export interface TablesResponse {
  tables: TableSummary[];
}

export interface TableRowDoc {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TablePage {
  rows: TableRowDoc[];
  hasMore: boolean;
  nextCursor: string | null;
  /** Filtered match count; -1 when skipped via skip_count, -2 when the
   * bounded scan window filled before the count completed. */
  total: number;
}

export interface TableCount {
  total: number;
}

export interface TableBatchItemResult {
  docId: string;
  ok: boolean;
  error: { code: string; message: string } | null;
}

export interface TableBatchResponse {
  results: TableBatchItemResult[];
  count: number;
}

export type TableWriteMode = "insert" | "merge_upsert" | "replace_upsert";
export type TableGrantAction = "read" | "insert" | "update" | "delete";

export interface TableRowsQuery {
  /** Raw "path=jsonValue" entries, one filter key per entry. */
  filters?: readonly string[];
  /** Physical document-ID allowlist, one document_ids key per entry. */
  documentIds?: readonly string[];
  prefix?: string;
  order?: "asc" | "desc";
  skipCount?: boolean;
  limit?: number;
  cursor?: string;
}

/** Encode the Worker-supported rows/count query keys. Empty queries encode
 * to "" (no trailing "?"). Values the Worker rejects (bad filter shape,
 * oversized lists) surface as Worker errors, never client guesses. */
export function buildTableRowsQuery(query: TableRowsQuery): string {
  const params = new URLSearchParams();
  for (const filter of query.filters ?? []) params.append("filter", filter);
  for (const id of query.documentIds ?? []) params.append("document_ids", id);
  if (query.prefix !== undefined) params.set("prefix", query.prefix);
  if (query.order !== undefined) params.set("order", query.order);
  if (query.skipCount !== undefined) params.set("skip_count", String(query.skipCount));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const encoded = params.toString();
  return encoded ? encoded : "";
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function read(response: Response): Promise<unknown> {
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as unknown;
}

function isTableSummary(value: unknown): value is TableSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["orgId"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["ownerUserId"] === "string" &&
    typeof v["createdAt"] === "string"
  );
}

function isTableRowDoc(value: unknown): value is TableRowDoc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const data = v["data"];
  return (
    typeof v["id"] === "string" &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    typeof v["createdAt"] === "string" &&
    typeof v["updatedAt"] === "string"
  );
}

function isTablePage(value: unknown): value is TablePage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v["rows"]) &&
    (v["rows"] as unknown[]).every(isTableRowDoc) &&
    typeof v["hasMore"] === "boolean" &&
    (typeof v["nextCursor"] === "string" || v["nextCursor"] === null) &&
    typeof v["total"] === "number"
  );
}

/** GET /api/tables — visible tables for this Organization (owner or grant). */
export async function listTables(): Promise<TablesResponse> {
  const data = (await read(await fetch("/api/tables", { headers: headers() }))) as { tables?: unknown };
  if (!Array.isArray(data.tables) || !data.tables.every(isTableSummary)) {
    throw new Error("Unexpected tables response shape.");
  }
  return { tables: data.tables };
}

/** POST /api/tables — declare a table; the caller owns it implicitly. */
export async function createTable(name: string): Promise<TableSummary> {
  const data = (await read(
    await fetch("/api/tables", { method: "POST", headers: headers(true), body: JSON.stringify({ name }) }),
  )) as { table?: unknown };
  if (!isTableSummary(data.table)) throw new Error("Unexpected table response shape.");
  return data.table;
}

/** GET /api/tables/:name — detail; non-grantees answer 404 like strangers. */
export async function fetchTable(name: string): Promise<TableSummary> {
  const data = (await read(await fetch(`/api/tables/${encodeURIComponent(name)}`, { headers: headers() }))) as {
    table?: unknown;
  };
  if (!isTableSummary(data.table)) throw new Error("Unexpected table response shape.");
  return data.table;
}

/** DELETE /api/tables/:name — owner-only declaration removal. */
export async function deleteTable(name: string): Promise<void> {
  await read(await fetch(`/api/tables/${encodeURIComponent(name)}`, { method: "DELETE", headers: headers() }));
}

/** GET /api/tables/:name/rows — scoped keyset query with filters. */
export async function queryTableRows(name: string, query: TableRowsQuery = {}): Promise<TablePage> {
  const suffix = buildTableRowsQuery(query);
  const data = (await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/rows${suffix ? `?${suffix}` : ""}`, {
      headers: headers(),
    }),
  )) as unknown;
  if (!isTablePage(data)) throw new Error("Unexpected table rows response shape.");
  return data;
}

/** GET /api/tables/:name/count — scoped filtered count (same keys). */
export async function countTableRows(name: string, query: TableRowsQuery = {}): Promise<TableCount> {
  const suffix = buildTableRowsQuery(query);
  const data = (await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/count${suffix ? `?${suffix}` : ""}`, {
      headers: headers(),
    }),
  )) as { total?: unknown };
  if (typeof data.total !== "number") throw new Error("Unexpected table count response shape.");
  return { total: data.total };
}

/** PUT /api/tables/:name/rows/:id — insert one document (409 on conflict). */
export async function insertTableRow(name: string, docId: string, data: Record<string, unknown>): Promise<TableRowDoc> {
  const body = (await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/rows/${encodeURIComponent(docId)}`, {
      method: "PUT",
      headers: headers(true),
      body: JSON.stringify({ data }),
    }),
  )) as { row?: unknown };
  if (!isTableRowDoc(body.row)) throw new Error("Unexpected table row response shape.");
  return body.row;
}

/** GET /api/tables/:name/rows/:id — read one document. */
export async function readTableRow(name: string, docId: string): Promise<TableRowDoc> {
  const body = (await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/rows/${encodeURIComponent(docId)}`, {
      headers: headers(),
    }),
  )) as { row?: unknown };
  if (!isTableRowDoc(body.row)) throw new Error("Unexpected table row response shape.");
  return body.row;
}

/** PATCH /api/tables/:name/rows/:id — wholesale document replace. */
export async function updateTableRow(name: string, docId: string, data: Record<string, unknown>): Promise<TableRowDoc> {
  const body = (await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/rows/${encodeURIComponent(docId)}`, {
      method: "PATCH",
      headers: headers(true),
      body: JSON.stringify({ data }),
    }),
  )) as { row?: unknown };
  if (!isTableRowDoc(body.row)) throw new Error("Unexpected table row response shape.");
  return body.row;
}

/** DELETE /api/tables/:name/rows/:id — remove one document. */
export async function deleteTableRow(name: string, docId: string): Promise<void> {
  await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/rows/${encodeURIComponent(docId)}`, {
      method: "DELETE",
      headers: headers(),
    }),
  );
}

export interface TableBatchWrite {
  write_mode?: TableWriteMode;
  upsert?: boolean;
  return_documents?: boolean;
  items: { id?: string | null; data: Record<string, unknown> }[];
}

/** POST /api/tables/:name/rows/batch — canonical 0-25 document write. */
export async function batchWriteTableRows(name: string, batch: TableBatchWrite): Promise<TableBatchResponse> {
  const data = (await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/rows/batch`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(batch),
    }),
  )) as TableBatchResponse;
  if (!Array.isArray(data.results) || typeof data.count !== "number") {
    throw new Error("Unexpected batch response shape.");
  }
  return data;
}

/** POST /api/tables/:name/rows/batch-delete — batch delete by IDs. */
export async function batchDeleteTableRows(name: string, ids: string[]): Promise<TableBatchResponse> {
  const data = (await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/rows/batch-delete`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ ids }),
    }),
  )) as TableBatchResponse;
  if (!Array.isArray(data.results) || typeof data.count !== "number") {
    throw new Error("Unexpected batch response shape.");
  }
  return data;
}

/** POST /api/tables/:name/grants — owner-only grant of one action. */
export async function grantTableAccess(name: string, action: TableGrantAction, granteeUserId: string): Promise<void> {
  await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/grants`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ action, granteeUserId }),
    }),
  );
}

/** DELETE /api/tables/:name/grants — owner-only revocation. */
export async function revokeTableAccess(name: string, action: TableGrantAction, granteeUserId: string): Promise<void> {
  await read(
    await fetch(`/api/tables/${encodeURIComponent(name)}/grants`, {
      method: "DELETE",
      headers: headers(true),
      body: JSON.stringify({ action, granteeUserId }),
    }),
  );
}
