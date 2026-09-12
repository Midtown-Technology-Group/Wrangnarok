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
  batchDelete,
  batchInsert,
  countRows,
  loadTable,
  TABLE_BATCH_MAX,
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
      batchInsert(db, caller, table, [
        { docId: "fresh", data: { n: 1 } },
        { docId: "taken", data: { n: 2 } },
      ]),
    ).resolves.toEqual({
      results: [
        { docId: "fresh", ok: true, error: null },
        {
          docId: "taken",
          ok: false,
          error: { code: "DOCUMENT_CONFLICT", message: 'Document "taken" already exists.' },
        },
      ],
    });
  });

  it("refuses empty and oversized batch deletes before touching policy or rows", async () => {
    const db = stubDb();
    await expect(batchDelete(db, caller, table, [])).rejects.toMatchObject({ code: "INVALID_BATCH" });
    await expect(
      batchDelete(
        db,
        caller,
        table,
        Array.from({ length: TABLE_BATCH_MAX + 1 }, (_, index) => `doc-${index}`),
      ),
    ).rejects.toMatchObject({ code: "INVALID_BATCH" });
  });
});
