// SPDX-License-Identifier: AGPL-3.0
// Tables UI fixtures (issue #556): list/detail/rows/count/batch/grant
// payloads over the real /api/tables envelopes, plus interaction tests
// that drive the typed client wrappers with a mocked fetch and render the
// pages from fixtures. No realtime-subscription fixtures exist on purpose:
// the Worker offers polling via repeated GET rows, never push.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  batchDeleteTableRows,
  batchWriteTableRows,
  buildTableRowsQuery,
  countTableRows,
  createTable,
  fetchTable,
  grantTableAccess,
  listTables,
  queryTableRows,
  readTableRow,
  revokeTableAccess,
} from "../client/src/lib/tables-client";
import type { TablePage, TableSummary, TablesResponse } from "../client/src/lib/tables-client";
import { TableDetailView, TablesList } from "../client/src/pages/Tables";

const TABLE: TableSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "00000000-0000-4000-8000-000000000001",
  name: "notes",
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  createdAt: "2026-09-11T00:00:00.000Z",
};

const LIST: TablesResponse = {
  tables: [
    TABLE,
    {
      ...TABLE,
      id: "22222222-2222-4222-8222-222222222222",
      name: "contacts",
    },
  ],
};

const ROWS: TablePage = {
  rows: [
    {
      id: "a",
      data: { title: "hello" },
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:01.000Z",
    },
  ],
  hasMore: true,
  nextCursor: "a",
  total: 3,
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("builds the rows query string with the Worker-supported keys only", () => {
  const query = buildTableRowsQuery({
    filters: ['title="hello"'],
    documentIds: ["a", "b"],
    prefix: "a",
    order: "desc",
    skipCount: true,
    limit: 10,
    cursor: "a",
  });
  expect(query).toContain("filter=title%3D%22hello%22");
  expect(query).toContain("document_ids=a");
  expect(query).toContain("document_ids=b");
  expect(query).toContain("prefix=a");
  expect(query).toContain("order=desc");
  expect(query).toContain("skip_count=true");
  expect(query).toContain("limit=10");
  expect(query).toContain("cursor=a");
  expect(buildTableRowsQuery({})).toBe("");
});

it("lists tables and renders rows linking each detail", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ tables: LIST.tables }));
  const data = await listTables();
  expect(data.tables).toHaveLength(2);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TablesList initial={LIST} />
    </MemoryRouter>,
  );
  expect(html).toContain("notes");
  expect(html).toContain("contacts");
  expect(html).toContain("/tables/notes");
  expect(html).toContain("Refresh");
  expect(html).not.toContain("Loading tables.");
});

it("renders the empty state without implying missing tables are an error", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ tables: [] }));
  const data = await listTables();
  expect(data.tables).toHaveLength(0);
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TablesList initial={{ tables: [] }} />
    </MemoryRouter>,
  );
  expect(html).toContain("No tables yet.");
});

it("creates a table through POST /api/tables", async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push(String(input), (init as RequestInit)?.method ?? "GET");
    return Response.json({ table: TABLE }, { status: 201 });
  });
  const created = await createTable("notes");
  expect(created.name).toBe("notes");
  expect(seen).toEqual(["/api/tables", "POST"]);
});

it("queries scoped rows and counts through the Worker routes", async () => {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    seen.push(String(input));
    if (String(input).includes("/count")) return Response.json({ total: 3 });
    return Response.json(ROWS);
  });
  const page = await queryTableRows("notes", { limit: 20 });
  expect(page.rows).toHaveLength(1);
  expect(page.total).toBe(3);
  expect(page.nextCursor).toBe("a");
  const counted = await countTableRows("notes", { filters: ['title="hello"'] });
  expect(counted.total).toBe(3);
  expect(seen[0]).toBe("/api/tables/notes/rows?limit=20");
  expect(seen[1]).toBe("/api/tables/notes/count?filter=title%3D%22hello%22");
});

it("renders table detail with rows, totals, and manual refresh", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ table: TABLE }));
  const detail = await fetchTable("notes");
  expect(detail.name).toBe("notes");
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/tables/notes"]}>
      <Routes>
        <Route path="/tables/:name" element={<TableDetailView initial={TABLE} initialRows={ROWS} />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(html).toContain("notes");
  expect(html).toContain("hello");
  expect(html).toContain("3 matching rows");
  expect(html).toContain("Refresh");
  expect(html).toContain("Next page");
  expect(html).not.toContain("subscri");
  expect(html).not.toContain("Loading table.");
});

it("reads a single row through GET rows/:id", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ row: ROWS.rows[0] }));
  const row = await readTableRow("notes", "a");
  expect(row.id).toBe("a");
  expect(row.data).toMatchObject({ title: "hello" });
});

it("writes batches and deletes through the canonical endpoints", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = init as RequestInit;
    calls.push({ url: String(input), method: request.method ?? "GET", body: JSON.parse(String(request.body)) });
    return Response.json({ results: [{ docId: "a", ok: true, error: null }], count: 1 }, { status: 201 });
  });
  const written = await batchWriteTableRows("notes", {
    write_mode: "merge_upsert",
    items: [{ id: "a", data: { title: "hello" } }],
  });
  expect(written.count).toBe(1);
  expect(calls[0]).toMatchObject({ url: "/api/tables/notes/rows/batch", method: "POST" });
  const deleted = await batchDeleteTableRows("notes", ["a"]);
  expect(deleted.count).toBe(1);
  expect(calls[1]).toMatchObject({ url: "/api/tables/notes/rows/batch-delete", method: "POST" });
});

it("grants and revokes owner access through the grants endpoint", async () => {
  const calls: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ url: String(input), method: (init as RequestInit)?.method ?? "GET" });
    return Response.json({ granted: true });
  });
  await grantTableAccess("notes", "read", "user-2");
  await revokeTableAccess("notes", "read", "user-2");
  expect(calls).toEqual([
    { url: "/api/tables/notes/grants", method: "POST" },
    { url: "/api/tables/notes/grants", method: "DELETE" },
  ]);
});
