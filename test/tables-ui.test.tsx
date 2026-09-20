// SPDX-License-Identifier: AGPL-3.0
// Tables UI fixtures (issue #556): list/detail/rows/count/batch/grant
// payloads over the real /api/tables envelopes, plus interaction tests
// that drive the typed client wrappers with a mocked fetch and render the
// pages from fixtures. No realtime-subscription fixtures exist on purpose:
// the Worker offers polling via repeated GET rows, never push.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";

// Mounted interaction tests below need React's act environment flag;
// the static-markup tests above never mount, so they do not.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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

// Mounted regression tests for the manual-refresh contract (issue #556
// review): query-control edits must not fetch on their own, and Refresh
// count must count even while Skip count is checked. react-test-renderer
// mounts without a DOM, so these run in the same workerd suite.
function mockTableRoutes(calls: string[], counted: number): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/tables/notes")) return Response.json({ table: TABLE });
    if (url.includes("/count")) return Response.json({ total: counted });
    return Response.json(ROWS);
  });
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const found = renderer.root.findAllByType("button").find((entry) => entry.props.children === label);
  if (!found) throw new Error(`Button "${label}" not found.`);
  return found;
}

/** Flush in-flight fetch().json() chains: the page's handlers are
 * fire-and-forget by design (buttons stay responsive), so tests wait out
 * the workerd async I/O inside an open act scope instead of awaiting a
 * return value the handler never exposes. */
async function flushRequests(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = findButton(renderer, label);
  await act(async () => {
    (button.props.onClick as () => void)();
  });
  await flushRequests();
}

it("issues zero fetches for query-control edits until Refresh is pressed", async () => {
  const calls: string[] = [];
  mockTableRoutes(calls, 7);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/tables/notes"]}>
        <Routes>
          <Route path="/tables/:name" element={<TableDetailView />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flushRequests();
  // Mount auto-loads once per table: detail plus the default rows query.
  expect(calls).toHaveLength(2);
  const root = renderer.root;
  await act(async () => {
    root.findByProps({ id: "rows-filter" }).props.onChange({ target: { value: 'title="hello"' } });
  });
  await act(async () => {
    root.findByProps({ id: "rows-prefix" }).props.onChange({ target: { value: "a" } });
  });
  await act(async () => {
    root.findByProps({ id: "rows-ids" }).props.onChange({ target: { value: "a, b" } });
  });
  await act(async () => {
    root.findByProps({ id: "rows-limit" }).props.onChange({ target: { value: "10" } });
  });
  await act(async () => {
    root.findByProps({ id: "rows-order" }).props.onChange({ target: { value: "desc" } });
  });
  await act(async () => {
    root.findByProps({ id: "rows-skip" }).props.onChange({ target: { checked: true } });
  });
  expect(calls).toHaveLength(2);
  await click(renderer, "Refresh");
  expect(calls).toHaveLength(3);
  const query = calls[2] ?? "";
  expect(query.startsWith("/api/tables/notes/rows?")).toBe(true);
  expect(query).toContain("filter=title%3D%22hello%22");
  expect(query).toContain("prefix=a");
  expect(query).toContain("document_ids=a");
  expect(query).toContain("document_ids=b");
  expect(query).toContain("order=desc");
  expect(query).toContain("limit=10");
  expect(query).toContain("skip_count=true");
  renderer.unmount();
});

it("keeps the create notice when only the list refresh fails", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit)?.method ?? "GET";
    if (url === "/api/tables" && method === "POST") return Response.json({ table: TABLE }, { status: 201 });
    return Response.json({ error: { code: "D1_ERROR", message: "List refresh failed." } }, { status: 500 });
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/tables"]}>
        <Routes>
          <Route path="/tables" element={<TablesList />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flushRequests();
  await act(async () => {
    renderer.root.findByProps({ id: "new-table" }).props.onChange({ target: { value: "notes" } });
  });
  const form = renderer.root
    .findAllByType("form")
    .find((entry) => entry.findAllByProps({ id: "new-table" }).length > 0);
  if (!form) throw new Error("Create form not found.");
  await act(async () => {
    await (form.props.onSubmit as (e: { preventDefault: () => void }) => unknown)({ preventDefault: () => {} });
  });
  await flushRequests();
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("declared. You own it.");
  expect(text).toContain("Table declared, but the list could not refresh:");
  expect(text).toContain("List refresh failed.");
  expect(text).not.toContain("Could not create Table.");
  renderer.unmount();
});

it("ignores a second Insert while the first is still in flight", async () => {
  const puts: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if ((init as RequestInit)?.method === "PUT") puts.push(url);
    if (url.includes("/rows")) return Response.json({ row: ROWS.rows[0] });
    return Response.json({ table: TABLE });
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/tables/notes"]}>
        <Routes>
          <Route path="/tables/:name" element={<TableDetailView initial={TABLE} initialRows={ROWS} />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    renderer.root.findByProps({ id: "row-id" }).props.onChange({ target: { value: "a" } });
  });
  const insert = findButton(renderer, "Insert");
  expect(insert.props.disabled).toBe(false);
  await act(async () => {
    (insert.props.onClick as () => void)();
    (insert.props.onClick as () => void)();
  });
  await flushRequests();
  expect(puts).toEqual(["/api/tables/notes/rows/a"]);
  // The guard resets once the request lands: the button works again.
  await click(renderer, "Insert");
  expect(puts).toEqual(["/api/tables/notes/rows/a", "/api/tables/notes/rows/a"]);
  renderer.unmount();
});

it("lets the last-started rows refresh win when responses overlap", async () => {
  const resolvers: ((page: TablePage) => void)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/tables/notes")) return Response.json({ table: TABLE });
    return new Promise<Response>((resolve) => {
      resolvers.push((page) => resolve(Response.json(page)));
    });
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/tables/notes"]}>
        <Routes>
          <Route path="/tables/:name" element={<TableDetailView />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  expect(resolvers).toHaveLength(1);
  // Let the immediate table fetch land so the rows section (and its
  // Refresh button) renders; the rows request itself stays pending.
  await flushRequests();
  await act(async () => {
    (findButton(renderer, "Refresh").props.onClick as () => void)();
  });
  expect(resolvers).toHaveLength(2);
  await act(async () => {
    resolvers[1]?.({ ...ROWS, total: 222 });
  });
  await flushRequests();
  // NOTE: no trailing period — the page renders the total and "." as
  // sibling text children, which toJSON keeps as separate array items.
  expect(JSON.stringify(renderer.toJSON())).toContain("222 matching rows");
  await act(async () => {
    resolvers[0]?.({ ...ROWS, total: 111 });
  });
  await flushRequests();
  expect(JSON.stringify(renderer.toJSON())).toContain("222 matching rows");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("111 matching rows");
  renderer.unmount();
});

it("Refresh count counts even while Skip count is checked", async () => {
  const calls: string[] = [];
  mockTableRoutes(calls, 7);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={["/tables/notes"]}>
        <Routes>
          <Route path="/tables/:name" element={<TableDetailView initial={TABLE} initialRows={ROWS} />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  expect(calls).toHaveLength(0);
  await act(async () => {
    renderer?.root.findByProps({ id: "rows-skip" }).props.onChange({ target: { checked: true } });
  });
  expect(calls).toHaveLength(0);
  await click(renderer, "Refresh count");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.startsWith("/api/tables/notes/count?")).toBe(true);
  expect(calls[0]).not.toContain("skip_count=true");
  expect(JSON.stringify(renderer.toJSON())).toContain("Count refreshed: 7 matching rows.");
  renderer.unmount();
});
