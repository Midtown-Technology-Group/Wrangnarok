// SPDX-License-Identifier: AGPL-3.0
// Author Tables unit pins (TABLE-02, issue #154): branches that real HTTP
// traffic cannot reach without thousand-row fixtures or fault injection —
// corrupt persisted declarations, the bounded scan-cap count, the
// batch-race whole-request abort, and the defensive batch-delete guard. The stub below
// fakes only the D1Database surface these pure domain functions touch;
// every behavior above the stub (policy, parsing, batching) is the real
// src/tables.ts code.
import { describe, expect, it } from "vitest";
import migration9 from "../migrations/0009_tables.sql?raw";
import {
  countRows,
  executeBatchDelete,
  executeBatchWrite,
  loadTable,
  parseBatchRequest,
  parseDocument,
  parseTableQuery,
  requireVisibleTable,
  TABLE_BATCH_BODY_LIMIT,
  TABLE_BATCH_MAX,
  TABLE_DOC_MAX_BYTES,
  TABLE_DOCUMENT_IDS_MAX,
  TABLE_DOCUMENT_ID_QUERY_MAX,
  TABLE_QUERY_ROW_CAP,
  type TableDefinition,
} from "../src/tables";

const caller = { userId: "owner-1", orgId: "org-1" };
const table: TableDefinition = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: caller.orgId,
  name: "ledger",
  ownerUserId: caller.userId,
  createdAt: "2026-09-11T00:00:00.000Z",
};

interface StubOptions {
  readonly firstRow?: unknown;
  readonly allRows?: { doc_id: string }[];
  readonly batchThrows?: boolean;
  readonly runThrowsFor?: ReadonlySet<string>;
}

/** Minimal D1Database double: only prepare/bind/first/all/run/batch, only
 * what the tables domain calls. Unknown surfaces throw loudly rather than
 * silently answering, so stub drift fails the test instead of the product. */
function stubDb(options: StubOptions = {}): D1Database {
  const statement = (...bound: unknown[]) => ({
    first: async () => (options.firstRow === undefined ? null : options.firstRow),
    all: async () => ({ results: options.allRows ?? [] }),
    run: async () => {
      const docId = bound[2];
      if (typeof docId === "string" && options.runThrowsFor?.has(docId)) throw new Error("UNIQUE constraint failed");
      return { success: true, meta: { changes: 1 } };
    },
  });
  return {
    prepare: () => ({ bind: (...bound: unknown[]) => statement(...bound) }),
    batch: async (statements: unknown[]) => {
      if (options.batchThrows) throw new Error("D1 batch rejected on constraint");
      return statements.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

function faultCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) return String(error.code);
    throw error;
  }
  throw new Error("expected a Fault");
}

describe("tables defensive branches", () => {
  it("treats a corrupt persisted declaration as a server defect, never caller input", async () => {
    const db = stubDb({
      firstRow: {
        id: "not-a-uuid",
        org_id: table.orgId,
        name: table.name,
        owner_user_id: caller.userId,
        created_at: table.createdAt,
      },
    });
    await expect(loadTable(db, table.orgId, table.name)).rejects.toThrow(/invalid identity/);
  });

  it("reports a bounded (not invented) total when the count window fills", async () => {
    // The stub documents match an empty filter set; the -2 verdict comes
    // from the filled window alone, which is the point: the count refuses to
    // invent exactness past the scan cap.
    const fullWindow = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({
            results: Array.from({ length: TABLE_QUERY_ROW_CAP }, (_, index) => ({
              doc_id: `doc-${index}`,
              data_json: JSON.stringify({ n: index }),
            })),
          }),
        }),
      }),
    } as unknown as D1Database;
    await expect(countRows(fullWindow, caller, table, { filters: [], skipCount: false })).resolves.toEqual({
      total: -2,
    });
  });

  it("fails a raced insert batch whole for retry instead of persisting row by row", async () => {
    // Fault injection for the lost-race window: the preflight is clean but
    // the single write transaction aborts. The contract is all-or-nothing
    // persistence past the preflight — no item may land while its siblings
    // report per-item outcomes — so the whole request fails 503
    // TABLE_BATCH_RETRY (nothing persisted: the single call rolled back)
    // and the caller retries the full batch. A workerd integration test
    // cannot deterministically hit this window, so the stub aborts the
    // batch() call itself; every behavior above the stub is the real
    // src/tables.ts code.
    const db = stubDb({ batchThrows: true, runThrowsFor: new Set(["taken"]) });
    await expect(
      executeBatchWrite(
        db,
        caller,
        table,
        parseBatchRequest({
          items: [
            { id: "fresh", data: { n: 1 } },
            { id: "taken", data: { n: 2 } },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "TABLE_BATCH_RETRY", status: 503 });
  });

  it("fails a raced upsert batch whole for retry instead of reconciling row by row", async () => {
    const db = stubDb({ batchThrows: true, allRows: [{ doc_id: "kept" }] });
    await expect(
      executeBatchWrite(
        db,
        caller,
        table,
        parseBatchRequest({
          write_mode: "merge_upsert",
          items: [
            { id: "kept", data: { n: 9 } },
            { id: "fresh", data: { n: 1 } },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "TABLE_BATCH_RETRY", status: 503 });
    await expect(executeBatchDelete(db, caller, table, ["kept"])).rejects.toMatchObject({
      code: "TABLE_BATCH_RETRY",
      status: 503,
    });
  });

  it("accepts empty batch deletes and still bounds oversized ones", async () => {
    const db = stubDb();
    await expect(executeBatchDelete(db, caller, table, [])).resolves.toEqual({ results: [], count: 0 });
    await expect(
      executeBatchDelete(
        db,
        caller,
        table,
        Array.from({ length: TABLE_BATCH_MAX + 1 }, (_, index) => `doc-${index}`),
      ),
    ).rejects.toMatchObject({ code: "INVALID_BATCH" });
  });

  it("denies the whole batch before any write when the caller holds no grant", async () => {
    const stranger = { userId: "stranger-9", orgId: "org-1" };
    const db = stubDb();
    await expect(
      executeBatchWrite(db, stranger, table, parseBatchRequest({ items: [{ id: "a", data: { n: 1 } }] })),
    ).rejects.toMatchObject({ code: "TABLE_BATCH_DENIED" });
    await expect(
      executeBatchWrite(
        db,
        stranger,
        table,
        parseBatchRequest({ write_mode: "merge_upsert", items: [{ id: "a", data: { n: 1 } }] }),
      ),
    ).rejects.toMatchObject({ code: "TABLE_BATCH_DENIED" });
    await expect(executeBatchDelete(db, stranger, table, ["a"])).rejects.toMatchObject({
      code: "TABLE_BATCH_DENIED",
    });
    // Policy precedes execution even for empty batches: no grant, no success.
    await expect(executeBatchWrite(db, stranger, table, parseBatchRequest({ items: [] }))).rejects.toMatchObject({
      code: "TABLE_BATCH_DENIED",
    });
  });

  it("parses document_ids with first-seen set semantics and explicit bounds (issue #154)", () => {
    expect(TABLE_DOCUMENT_IDS_MAX).toBe(25);
    expect(TABLE_DOCUMENT_ID_QUERY_MAX).toBe(255);
    const params = new URLSearchParams();
    params.append("document_ids", "b");
    params.append("document_ids", "a");
    params.append("document_ids", "b");
    expect(parseTableQuery(params).documentIds).toEqual(["b", "a"]);
    expect(parseTableQuery(new URLSearchParams()).documentIds).toBeUndefined();
    const tooMany = new URLSearchParams();
    for (let i = 0; i < TABLE_DOCUMENT_IDS_MAX + 1; i += 1) tooMany.append("document_ids", `d${i}`);
    expect(faultCode(() => parseTableQuery(tooMany))).toBe("TOO_MANY_DOCUMENT_IDS");
    // Repeats cannot evade the max: the raw key count is bounded pre-dedup.
    const tooManyDupes = new URLSearchParams();
    for (let i = 0; i < TABLE_DOCUMENT_IDS_MAX + 1; i += 1) tooManyDupes.append("document_ids", "same");
    expect(faultCode(() => parseTableQuery(tooManyDupes))).toBe("TOO_MANY_DOCUMENT_IDS");
    for (const bad of ["", "   ", "x".repeat(TABLE_DOCUMENT_ID_QUERY_MAX + 1)]) {
      const single = new URLSearchParams();
      single.append("document_ids", bad);
      expect(faultCode(() => parseTableQuery(single))).toBe("INVALID_DOCUMENT_IDS");
    }
    const longest = new URLSearchParams();
    longest.append("document_ids", "x".repeat(TABLE_DOCUMENT_ID_QUERY_MAX));
    expect(parseTableQuery(longest).documentIds).toHaveLength(1);
  });

  it("shows the detail to owners and grantees, 404 to non-grantees (issue #353)", async () => {
    // Owner passes without touching grants.
    await expect(requireVisibleTable(stubDb(), caller, table)).resolves.toBeUndefined();
    const stranger = { userId: "stranger-9", orgId: "org-1" };
    // Grantee passes through the grant row.
    await expect(
      requireVisibleTable(stubDb({ firstRow: { id: "grant-1" } }), stranger, table),
    ).resolves.toBeUndefined();
    // Non-grantee answers 404, never metadata.
    await expect(requireVisibleTable(stubDb(), stranger, table)).rejects.toMatchObject({
      code: "TABLE_NOT_FOUND",
    });
  });
});

describe("tables retention-posture DDL pins (issue #154)", () => {
  /** Column names of one CREATE TABLE statement in definition order:
   * top-level comma-separated definitions, table constraints skipped.
   * (Mirrors the workerd applied-schema pin; both must agree.) */
  function topLevelColumns(createTableSql: string): string[] {
    const inner = createTableSql.slice(createTableSql.indexOf("(") + 1, createTableSql.lastIndexOf(")"));
    const defs: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of inner) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        defs.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    defs.push(current);
    const columns: string[] = [];
    for (const def of defs) {
      // Leading identifier, not the whitespace token: constraints read
      // UNIQUE(...) / PRIMARY KEY(...) with no space after the keyword.
      const first = def.trim().match(/^([A-Za-z_]+)/)?.[1] ?? "";
      if (["PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"].includes(first.toUpperCase())) continue;
      columns.push(first);
    }
    return columns;
  }

  function statementFor(ddl: string, table: string): string {
    const found = ddl
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.toUpperCase().startsWith(`CREATE TABLE ${table.toUpperCase()}(`));
    if (!found) throw new Error(`DDL is missing CREATE TABLE ${table}.`);
    return found;
  }

  it("tables DDL carries no TTL/partition columns and keeps the per-document CHECK", () => {
    // No background-expiry surface anywhere in the tables DDL: retention is
    // explicit deletion (deleteTable / row deletes) or nothing.
    expect(migration9).not.toMatch(/\b(ttl|expir(e[sd]?|y|ation)?|partition|retention)\b/i);
    expect(statementFor(migration9, "tables")).toContain("UNIQUE(org_id, name)");
    expect(topLevelColumns(statementFor(migration9, "tables"))).toEqual([
      "id",
      "org_id",
      "name",
      "owner_user_id",
      "created_at",
    ]);
    const rowsDdl = statementFor(migration9, "table_rows");
    expect(rowsDdl).toContain("CHECK(length(data_json) <= 4096)");
    expect(topLevelColumns(rowsDdl)).toEqual([
      "table_id",
      "org_id",
      "doc_id",
      "owner_user_id",
      "data_json",
      "created_at",
      "updated_at",
    ]);
    expect(topLevelColumns(statementFor(migration9, "table_grants"))).toEqual([
      "id",
      "table_id",
      "action",
      "grantee_user_id",
      "created_at",
    ]);
  });

  it("byte bounds stay pinned: 4 KB documents, 256 KB batch bodies", () => {
    expect(TABLE_DOC_MAX_BYTES).toBe(4096);
    expect(TABLE_BATCH_BODY_LIMIT).toBe(256_000);
    // Domain byte boundary: exactly 4096 UTF-8 bytes parses, 4097 fails.
    // {"blob":"..."} costs 11 envelope bytes around the payload.
    const boundary = { blob: "x".repeat(TABLE_DOC_MAX_BYTES - 11) };
    expect(new TextEncoder().encode(JSON.stringify(boundary)).byteLength).toBe(TABLE_DOC_MAX_BYTES);
    expect(parseDocument(boundary)).toEqual(boundary);
    expect(faultCode(() => parseDocument({ blob: "x".repeat(TABLE_DOC_MAX_BYTES - 10) }))).toBe("DOCUMENT_TOO_LARGE");
    // Bytes, not characters: 2044 multibyte chars exceed 4096 bytes and fail.
    expect(faultCode(() => parseDocument({ blob: "é".repeat(2044) }))).toBe("DOCUMENT_TOO_LARGE");
  });
});
