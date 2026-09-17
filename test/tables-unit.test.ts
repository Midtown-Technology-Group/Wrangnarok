// SPDX-License-Identifier: AGPL-3.0
// Author Tables unit pins (TABLE-02, issue #154): branches that real HTTP
// traffic cannot reach without thousand-row fixtures or fault injection —
// corrupt persisted declarations, the bounded scan-cap count, the
// batch-race fallback, and the defensive batch-delete guard. The stub below
// fakes only the D1Database surface these pure domain functions touch;
// every behavior above the stub (policy, parsing, batching) is the real
// src/tables.ts code.
import { describe, expect, it } from "vitest";
import {
  countRows,
  executeBatchDelete,
  executeBatchWrite,
  loadTable,
  parseBatchRequest,
  parseTableQuery,
  requireVisibleTable,
  TABLE_BATCH_MAX,
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

  it("retries a raced batch row by row so each item keeps its own outcome", async () => {
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
    ).resolves.toEqual({
      results: [
        { docId: "fresh", ok: true, error: null },
        {
          docId: "taken",
          ok: false,
          error: { code: "DOCUMENT_CONFLICT", message: 'Document "taken" already exists.' },
        },
      ],
      count: 1,
    });
  });

  it("reconciles a raced upsert row by row without losing writes", async () => {
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
    ).resolves.toEqual({
      results: [
        { docId: "kept", ok: true, error: null },
        { docId: "fresh", ok: true, error: null },
      ],
      count: 2,
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
