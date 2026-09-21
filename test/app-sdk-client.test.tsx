// SPDX-License-Identifier: AGPL-3.0
// Browser App SDK client (APP-02, issue #160; ADR 019): retry rules,
// handshake tripwire, subscriptions, theme, logout, and hook shapes.
//
// Pure client tests with stub fetch: no Worker, no D1. The live Worker proof
// is test/app-runtime.test.ts. Proven here:
// - Handshake asserts sdk name + version before scoped calls (drift is
//   APP_SDK_MISMATCH); every scoped call handshakes first.
// - GET retries bounded on network/503 (then surfaces); mutations never
//   retry blindly (single attempt counted).
// - Token rotation: exactly one 401 refresh + one retry, then 401 surfaces
//   and onAuthFailure runs (no refresh loop).
// - subscribeTable polls the changes feed with table-bound sync tokens,
//   resumes from the token on reconnect, replaces (never merges) rows on
//   the authoritative refetch after a server-side burst, re-lists and
//   resubscribes fresh on RESYNC_REQUIRED, and halts on unsubscribe;
//   subscribeFiles re-emits the authoritative list after an outage.
// - useAppTable returns FLAT rows vs the nested imperative shape;
//   provider covers basename, theme/logout, repeat mount/unmount.
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_SDK_NAME, APP_SDK_VERSION, createAppRuntimeClient } from "../client/src/lib/app-runtime";
import {
  AppRuntimeProvider,
  applyThemeClass,
  flattenAppRow,
  readStoredTheme,
  useAppRuntimeContext,
} from "../client/src/lib/app-provider";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const BASE = "https://worker.test";

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const HANDSHAKE = {
  sdk: APP_SDK_NAME,
  version: APP_SDK_VERSION,
  app: { id: APP_ID, name: "shop", slug: "shop", status: "live" },
};

/** Zero-delay sleep that still yields to the event loop: a bare resolved
 * promise would let an unstopped poll loop starve the very timers
 * `vi.waitFor` needs when the test stops the poller externally. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stubFetch(scenarios: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const next = scenarios.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("handshakes first and rejects drift with APP_SDK_MISMATCH", async () => {
  const stub = stubFetch([jsonResponse(HANDSHAKE), jsonResponse({ tables: [] })]);
  const client = createAppRuntimeClient({ baseUrl: BASE, token: "tok", appId: APP_ID, fetchImpl: stub.fetch });
  const tables = await client.listTables();
  expect(tables).toEqual([]);
  expect(stub.calls[0]?.url).toBe(`${BASE}/api/apps/${APP_ID}/sdk`);
  expect(stub.calls[1]?.url).toBe(`${BASE}/api/apps/${APP_ID}/runtime/tables`);

  const drifted = stubFetch([jsonResponse({ ...HANDSHAKE, version: "999" })]);
  const driftedClient = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: drifted.fetch,
  });
  const error = await driftedClient.listTables().catch((cause: unknown) => cause);
  expect((error as { code?: string }).code).toBe("APP_SDK_MISMATCH");
});

it("retries GET bounded on network/503 and never retries mutations", async () => {
  // GET: network failure then 503 then success (2 retries, then serve).
  const stub = stubFetch([
    jsonResponse(HANDSHAKE),
    new Error("boom"),
    jsonResponse({ error: { code: "X", message: "busy" } }, 503),
    jsonResponse({ tables: [] }),
  ]);
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: stub.fetch,
    sleep: async () => {},
  });
  expect(await client.listTables()).toEqual([]);
  expect(stub.calls.filter((entry) => entry.url.endsWith("/runtime/tables"))).toHaveLength(3);

  // GET exhausts the ceiling and surfaces.
  const failing = stubFetch([
    jsonResponse(HANDSHAKE),
    new Error("down"),
    new Error("down"),
    new Error("down"),
    new Error("down"),
  ]);
  const failingClient = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: failing.fetch,
    sleep: async () => {},
  });
  await expect(failingClient.listTables()).rejects.toThrow("down");

  // Mutation: one attempt only, even on network failure.
  const mutate = stubFetch([jsonResponse(HANDSHAKE), new Error("nope")]);
  const mutateClient = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: mutate.fetch,
    sleep: async () => {},
  });
  await expect(mutateClient.insertRow("orders", { status: "open" })).rejects.toThrow("nope");
  expect(mutate.calls.filter((entry) => entry.url.endsWith("/rows"))).toHaveLength(1);
});

it("rotates the token exactly once on 401, then surfaces and logs out", async () => {
  let refreshed = 0;
  let failures = 0;
  const stub = stubFetch([
    jsonResponse(HANDSHAKE),
    jsonResponse({ error: { code: "UNAUTHORIZED", message: "stale" } }, 401),
    jsonResponse({ tables: [{ id: "t", name: "orders" }] }),
  ]);
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: "old",
    appId: APP_ID,
    fetchImpl: stub.fetch,
    onRefreshToken: async () => {
      refreshed += 1;
      return "new";
    },
    onAuthFailure: () => {
      failures += 1;
    },
  });
  const tables = await client.listTables();
  expect(tables).toHaveLength(1);
  expect(refreshed).toBe(1);
  expect(failures).toBe(0);
  const authed = stub.calls[2]?.init?.headers as Record<string, string>;
  expect(authed["Authorization"]).toBe("Bearer new");

  // Replay 401 after rotation: surfaces + auth failure, no second rotation.
  let secondRefresh = 0;
  let secondFailure = 0;
  const replay = stubFetch([
    jsonResponse(HANDSHAKE),
    jsonResponse({ error: { code: "UNAUTHORIZED", message: "stale" } }, 401),
    jsonResponse({ error: { code: "UNAUTHORIZED", message: "stale" } }, 401),
  ]);
  const replayClient = createAppRuntimeClient({
    baseUrl: BASE,
    token: "old",
    appId: APP_ID,
    fetchImpl: replay.fetch,
    onRefreshToken: async () => {
      secondRefresh += 1;
      return "new";
    },
    onAuthFailure: () => {
      secondFailure += 1;
    },
  });
  await expect(replayClient.listTables()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(secondRefresh).toBe(1);
  expect(secondFailure).toBe(1);
});

it("polls Table changes, resumes from the sync token, and halts on unsubscribe", async () => {
  const feed = (syncToken: string | null, tableRevision: number, changes: unknown[] = []) => ({
    changes,
    hasMore: false,
    syncToken,
    tableRevision,
  });
  const page = (revision: number) => ({ rows: [], hasMore: false, nextCursor: null, tableRevision: revision });
  const pages: { tableRevision: number }[] = [];
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith("/sdk")) return jsonResponse(HANDSHAKE);
    if (url.includes("/rows")) {
      return jsonResponse(page(calls.filter((entry) => entry.includes("/rows")).length <= 1 ? 1 : 2));
    }
    const seen = calls.filter((entry) => entry.includes("/changes")).length;
    // Second feed poll drops: the reconnect must resume from the token.
    if (seen === 2) throw new Error("transport down");
    if (seen <= 2) return jsonResponse(feed("tok-1", 1));
    // Revision moved with no emitted rows (a delete): still refetches.
    return jsonResponse(feed("tok-1", 2));
  }) as unknown as typeof globalThis.fetch;
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: fetch,
    sleep: tick,
  });
  const stop = client.subscribeTable(
    "orders",
    {},
    (next) => {
      pages.push(next);
      // Unsubscribe after the reconnect lands revision 2.
      if (next.tableRevision === 2) stop();
    },
    () => {
      throw new Error("must not surface a single transport failure");
    },
  );
  await vi.waitFor(() => expect(pages.some((entry) => entry.tableRevision === 2)).toBe(true));
  const feedCalls = calls.filter((entry) => entry.includes("/changes"));
  expect(feedCalls.length).toBeGreaterThanOrEqual(3);
  // The first poll subscribes from an instant; every later poll resumes
  // from the last issued sync token — never a bare re-list.
  expect(feedCalls[0]).toContain("since=");
  expect(feedCalls[0]).not.toContain("sync_token=");
  expect(feedCalls.slice(1).every((entry) => entry.includes("sync_token=tok-1"))).toBe(true);
  const settled = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls.length).toBe(settled);
});

it("replaces poller rows with the authoritative page after a server-side burst", async () => {
  // Upstream v2 delivers one table_invalidated frame per batch commit; this
  // client polls the changes feed instead. A server-side burst (several
  // writes between polls) must surface as one authoritative replacement
  // with no stale rows retained — the poller never merges feed entries.
  const row = (id: string, sku: string, revision: number) => ({
    id,
    data: { sku },
    tableRevision: revision,
    createdAt: "t",
    updatedAt: "t",
  });
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith("/sdk")) return jsonResponse(HANDSHAKE);
    if (url.includes("/rows")) {
      const seen = calls.filter((entry) => entry.includes("/rows")).length;
      if (seen <= 1) {
        return jsonResponse({
          rows: [row("a", "a", 4), row("b", "b", 4)],
          hasMore: false,
          nextCursor: null,
          tableRevision: 4,
        });
      }
      // Burst landed between polls: a deleted, b rewritten, c inserted (rev 7).
      return jsonResponse({
        rows: [row("b", "b", 7), row("c", "c", 7)],
        hasMore: false,
        nextCursor: null,
        tableRevision: 7,
      });
    }
    const seen = calls.filter((entry) => entry.includes("/changes")).length;
    if (seen <= 1) {
      return jsonResponse({
        changes: [
          { id: "a", data: { sku: "a" }, createdAt: "t", updatedAt: "t", change: "upsert" },
          { id: "b", data: { sku: "b" }, createdAt: "t", updatedAt: "t", change: "upsert" },
        ],
        hasMore: false,
        syncToken: "tok-1",
        tableRevision: 4,
      });
    }
    return jsonResponse({
      changes: [
        { id: "b", data: { sku: "b" }, createdAt: "t", updatedAt: "t", change: "upsert" },
        { id: "c", data: { sku: "c" }, createdAt: "t", updatedAt: "t", change: "upsert" },
      ],
      hasMore: false,
      syncToken: "tok-2",
      tableRevision: 7,
    });
  }) as unknown as typeof globalThis.fetch;
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: fetch,
    sleep: tick,
  });
  const pages: { rows: { id: string }[]; tableRevision: number }[] = [];
  const stop = client.subscribeTable(
    "orders",
    {},
    (next) => {
      pages.push(next);
      if (pages.length >= 2) stop();
    },
    (cause) => {
      throw cause;
    },
  );
  await vi.waitFor(() => expect(pages.length).toBeGreaterThanOrEqual(2));
  const feedCalls = calls.filter((entry) => entry.includes("/changes"));
  expect(feedCalls[1]).toContain("sync_token=tok-1");
  expect(pages[1]?.tableRevision).toBe(7);
  expect(pages[1]?.rows.map((entry) => entry.id).sort()).toEqual(["b", "c"]);
});

it("re-lists and resubscribes from a fresh position on RESYNC_REQUIRED", async () => {
  const page = (revision: number) => ({ rows: [], hasMore: false, nextCursor: null, tableRevision: revision });
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.endsWith("/sdk")) return jsonResponse(HANDSHAKE);
    if (url.includes("/rows")) return jsonResponse(page(1));
    const seen = calls.filter((entry) => entry.includes("/changes")).length;
    if (seen <= 1) {
      return jsonResponse({ changes: [], hasMore: false, syncToken: "tok-1", tableRevision: 1 });
    }
    if (seen === 2) {
      // Foreign-table token: the server fails the resume closed.
      return jsonResponse({ error: { code: "RESYNC_REQUIRED", message: "resync" } }, 400);
    }
    return jsonResponse({ changes: [], hasMore: false, syncToken: "tok-2", tableRevision: 1 });
  }) as unknown as typeof globalThis.fetch;
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: fetch,
    sleep: tick,
  });
  const pages: { tableRevision: number }[] = [];
  const stop = client.subscribeTable(
    "orders",
    {},
    (next) => {
      pages.push(next);
    },
    (cause) => {
      throw cause;
    },
  );
  await vi.waitFor(() => expect(calls.filter((entry) => entry.includes("/changes")).length).toBeGreaterThanOrEqual(3));
  stop();
  // RESYNC re-listed the authoritative page (second emit) without surfacing
  // an error, and the resubscribe starts from a fresh instant — the stale
  // token never rides again.
  expect(pages).toHaveLength(2);
  const feedCalls = calls.filter((entry) => entry.includes("/changes"));
  expect(feedCalls[2]).toContain("since=");
  expect(feedCalls[2]).not.toContain("sync_token=");
});

it("re-emits the authoritative file list after an outage", async () => {
  const list = (version: number) => ({
    files: [
      {
        id: "f",
        name: "a.txt",
        contentType: "text/plain",
        size: 1,
        sha256: "x",
        version,
        status: "ready" as const,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
  });
  let polls = 0;
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    polls += 1;
    if (url.endsWith("/sdk")) return jsonResponse(HANDSHAKE);
    if (polls === 2) throw new Error("transport down");
    return jsonResponse(list(3));
  }) as unknown as typeof globalThis.fetch;
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: "tok",
    appId: APP_ID,
    fetchImpl: fetch,
    sleep: async () => {},
  });
  const emissions: number[] = [];
  const stop = client.subscribeFiles(
    (files) => {
      emissions.push(files[0]?.version ?? 0);
      if (emissions.length >= 1) stop();
    },
    () => {
      throw new Error("must not surface a single transport failure");
    },
  );
  await vi.waitFor(() => expect(emissions.length).toBeGreaterThanOrEqual(1));
  expect(emissions[0]).toBe(3);
});

it("uploads with finalize metadata and verifies downloads by sha256", async () => {
  const bytes = new TextEncoder().encode("hello files");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const content = btoa(binary);
  const stub = stubFetch([
    jsonResponse(HANDSHAKE),
    jsonResponse({ file: { name: "a.txt", status: "pending", version: 1 } }),
    jsonResponse({ token: "up-1", expiresAt: "t" }),
    jsonResponse({ file: { name: "a.txt", status: "ready", version: 1, size: bytes.byteLength, sha256: digest } }),
    jsonResponse({ token: "down-1", expiresAt: "t" }),
    jsonResponse({ meta: { name: "a.txt", sha256: digest }, content }),
  ]);
  const client = createAppRuntimeClient({ baseUrl: BASE, token: "tok", appId: APP_ID, fetchImpl: stub.fetch });
  const uploaded = await client.uploadFile("a.txt", bytes, "text/plain");
  expect(uploaded).toMatchObject({ status: "ready", sha256: digest });
  const uploadCall = stub.calls.find((entry) => entry.url.endsWith("/upload"));
  const uploadHeaders = uploadCall?.init?.headers as Record<string, string>;
  expect(uploadHeaders["X-File-Token"]).toBe("up-1");
  const uploadBody = JSON.parse(uploadCall?.init?.body as string) as { size: number; sha256: string };
  expect(uploadBody).toMatchObject({ size: bytes.byteLength, sha256: digest });
  const downloaded = await client.downloadFile("a.txt");
  expect(downloaded.meta.sha256).toBe(digest);
  expect(downloaded.bytes).toEqual(bytes);
});

it("flattens hook rows while the imperative client stays nested", () => {
  const nested = { id: "row-1", data: { status: "open", amount: 3 }, tableRevision: 4, createdAt: "a", updatedAt: "b" };
  expect(flattenAppRow(nested)).toEqual({
    status: "open",
    amount: 3,
    id: "row-1",
    tableRevision: 4,
    createdAt: "a",
    updatedAt: "b",
  });
  // Row id wins over a colliding data field.
  expect(flattenAppRow({ ...nested, data: { id: "spoof", status: "x" } }).id).toBe("row-1");
});

it("provides basename, theme, logout, and repeat mount isolation", () => {
  function Probe() {
    const ctx = useAppRuntimeContext();
    return (
      <div data-basename={ctx.basename} data-theme={ctx.theme} data-supports={String(ctx.supportsTheme)}>
        probe
      </div>
    );
  }
  const first = renderToStaticMarkup(
    <AppRuntimeProvider baseUrl={BASE} token="tok" appId={APP_ID} basename="/shop" theme="dark" supportsTheme>
      <Probe />
    </AppRuntimeProvider>,
  );
  expect(first).toContain('data-basename="/shop"');
  expect(first).toContain('data-theme="dark"');
  expect(first).toContain('data-supports="true"');
  // A second mount with different props renders independently (no shared
  // module-global transport to leak the first mount's context).
  const second = renderToStaticMarkup(
    <AppRuntimeProvider baseUrl={BASE} token="tok" appId={APP_ID} basename="/other">
      <Probe />
    </AppRuntimeProvider>,
  );
  expect(second).toContain('data-basename="/other"');
  expect(second).toContain('data-theme="light"');
  expect(readStoredTheme("dark")).toBe("dark");
  expect(readStoredTheme()).toBe("light");
  applyThemeClass("light");
});
