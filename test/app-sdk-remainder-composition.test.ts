// SPDX-License-Identifier: AGPL-3.0
// APP-02 acceptance remainder (issue #160): the real browser App SDK client
// driven against the real local Worker — no stub fetch.
//
// test/app-runtime.test.ts proves the Worker routes with raw fetch and
// test/app-sdk-client.test.tsx proves client mechanics (retry, rotation,
// subscriptions, hook shapes) with stub fetch. This file closes the loop:
// the actual `createAppRuntimeClient` (handshake gating, method-shaped retry,
// bounded one-401 refresh, nested wire shapes, sha-verified files) composed
// with the actual Worker over real local bindings. No new primitive, no DDL,
// no push transport. Provider-only concerns (basename, theme/logout, repeat
// mount isolation) stay pinned in test/app-sdk-client.test.tsx; the drift
// arm (APP_SDK_MISMATCH on version skew) stays pinned there too, with the
// in-sync handshake proven against the real Worker here.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { APP_SDK_VERSION, createAppRuntimeClient } from "../client/src/lib/app-runtime";
import type { TablePage } from "../client/src/lib/app-runtime";
import { flattenAppRow } from "../client/src/lib/app-provider";
import { executionId, helloSaga } from "../src/domain";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const BASE = "https://local.test";

function authorHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

/** Author-plane call with raw fetch (setup/teardown only; the runtime legs
 * below all go through the real browser client). */
function authorCall(path: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method,
      headers: authorHeaders(extraHeaders),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: ORG },
  );
}

/** fetchImpl adapter: routes the real client at the real Worker in-isolate,
 * forwarding the client's own Authorization header (rotation included). */
function workerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  return worker.fetch(
    new Request(`https://local.test${url.pathname}${url.search}`, {
      method: init?.method ?? "GET",
      headers,
      body: (init?.body ?? undefined) as BodyInit | undefined,
    }),
    { ...bindings, LAB_ORG_ID: ORG },
  );
}

const clientFetch = workerFetch as unknown as typeof globalThis.fetch;

let appSeq = 0;
async function createApp(): Promise<string> {
  appSeq += 1;
  const name = `remainder-${appSeq}`;
  const response = await authorCall("/api/apps", "POST", { name, slug: name });
  expect(response.status).toBe(201);
  return ((await response.json()) as { app: { id: string } }).app.id as string;
}

async function grant(appId: string, kind: string, ref: string, permission: string): Promise<string> {
  const response = await authorCall(`/api/apps/${appId}/grants`, "POST", { kind, ref, permission });
  expect(response.status).toBe(201);
  return ((await response.json()) as { grant: { id: string } }).grant.id as string;
}

async function declareTable(appId: string, name: string, visibility: "visible" | "hidden" = "visible") {
  const response = await authorCall(`/api/apps/${appId}/tables`, "POST", { name, visibility });
  expect(response.status).toBe(201);
}

async function revokeGrant(appId: string, grantId: string) {
  const response = await authorCall(`/api/apps/${appId}/grants/${grantId}/revoke`, "POST");
  expect(response.status).toBe(200);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function waitFor(label: string, ready: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

useWorkflowHarness(bindings.DB);

it("handshakes against the real Worker and reads nested rows the hook flattens", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  await grant(appId, "table", "orders", "read");
  await grant(appId, "table", "orders", "write");

  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
  });
  // In-sync handshake against the real descriptor: sdk name, the exact
  // served version (drift would reject APP_SDK_MISMATCH before any scope).
  const shake = await client.handshake();
  expect(shake.sdk).toBe("wrangnarok.app-runtime");
  expect(shake.version).toBe(APP_SDK_VERSION);
  expect(shake.app.id).toBe(appId);

  // A fresh client handshakes implicitly on its first scoped call.
  const implicit = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
  });
  const written = await implicit.insertRow("orders", { status: "open", amount: 3 });
  expect(written.id).toMatch(/^[0-9a-f-]{36}$/i);
  const page = await implicit.queryTable("orders", { filter: { status: "open" }, limit: 10 });
  expect(page.rows).toHaveLength(1);
  // Imperative shape stays nested: the row carries data under `data`.
  expect(page.rows[0]?.data).toMatchObject({ status: "open", amount: 3 });
  // The hook shape is the flattened twin: fields spread flat, row id wins.
  const flat = flattenAppRow(page.rows[0]!);
  expect(flat).toMatchObject({ status: "open", amount: 3, id: written.id });
  expect(flat.tableRevision).toBe(page.tableRevision);
});

it("rejects query-only filters through the real client, never widening", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  await grant(appId, "table", "orders", "read");
  await grant(appId, "table", "orders", "write");
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
  });
  await client.insertRow("orders", { status: "open" });

  // Nested operators are a TABLE-02 follow-up, not a scan.
  await expect(
    client.queryTable("orders", {
      filter: { status: { $neq: "open" } } as unknown as Record<string, string | number | boolean>,
    }),
  ).rejects.toMatchObject({ code: "APP_TABLE_QUERY_UNSUPPORTED" });
  // Nine equality clauses exceed the bound of 8.
  const wide: Record<string, string> = {};
  for (let index = 0; index < 9; index += 1) wide[`field${index}`] = "x";
  await expect(client.queryTable("orders", { filter: wide })).rejects.toMatchObject({
    code: "INVALID_TABLE_QUERY",
  });
  // Limits stay inside 1..100.
  await expect(client.queryTable("orders", { limit: 101 })).rejects.toMatchObject({
    code: "INVALID_TABLE_QUERY",
  });
  // The supported read still serves after the rejections.
  const page = await client.queryTable("orders", { filter: { status: "open" } });
  expect(page.rows).toHaveLength(1);
});

it("delivers a post-subscribe write to the real client subscription and halts on unsubscribe", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  await grant(appId, "table", "orders", "read");
  await grant(appId, "table", "orders", "write");
  let fetchCount = 0;
  const counting = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCount += 1;
    return workerFetch(input, init);
  }) as unknown as typeof globalThis.fetch;
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: counting,
    pollMs: 50,
  });
  await client.insertRow("orders", { status: "open", n: 1 });

  const seen: TablePage[] = [];
  const errors: Error[] = [];
  const stop = client.subscribeTable(
    "orders",
    { filter: { status: "open" } },
    (page) => {
      seen.push(page);
    },
    (error) => {
      errors.push(error);
    },
  );
  try {
    // First emission is the authoritative snapshot with exactly the seed row;
    // only then does the live write land, so the second emission proves the
    // poll loop detected a post-subscribe change (not snapshot timing).
    await waitFor("initial snapshot", () => seen.length >= 1);
    expect(seen[seen.length - 1]?.rows).toHaveLength(1);
    await client.insertRow("orders", { status: "open", n: 2 });
    await waitFor("live second emission", () => seen.some((page) => page.rows.length === 2));
    expect(errors).toEqual([]);
    // The authoritative page is newest-first; the live proof is the set.
    const live = (seen[seen.length - 1]?.rows ?? []).map((row) => row.data);
    expect(live).toHaveLength(2);
    expect(live.map((data) => (data as { n: number }).n).sort()).toEqual([1, 2]);
    expect(live.every((data) => (data as { status: string }).status === "open")).toBe(true);
  } finally {
    stop();
  }
  // Unsubscribe halts all further fetches: the poll loop is quiescent.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const settled = fetchCount;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(fetchCount).toBe(settled);
});

it("invokes a granted Saga and tails the result through the real client", async () => {
  const appId = await createApp();
  await grant(appId, "saga", helloSaga.id, "invoke");
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
  });
  // The execution id derives from the caller key, so the harness can track
  // the instance before the client submits (same shape as the raw proof).
  const key = "app-sdk-remainder-invoke-0001";
  const id = await executionId({ orgId: ORG, userId: USER }, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.HELLO_WORKFLOW, id);
  const receipt = await client.invokeSaga(helloSaga.id, { name: "Ada" }, key);
  expect(receipt.executionId).toBe(id);
  expect(receipt.replayed).toBe(false);
  await instance.waitForStatus("complete");
  // The client polls the standard Execution detail path to a terminal status.
  const settled = await client.pollExecution(receipt.executionId, { timeoutMs: 12000 });
  expect(settled.status).toBe("Succeeded");
  expect(settled.result).toMatchObject({ greeting: "Hello, Ada!" });
  // Scoped activity tail lists this install's linkage only.
  const tail = await client.listExecutions();
  expect(tail).toMatchObject([{ executionId: id, sagaId: helloSaga.id }]);
  // Same caller key replays canonically through the client too.
  const replay = await client.invokeSaga(helloSaga.id, { name: "Ada" }, key);
  expect(replay).toMatchObject({ executionId: id, replayed: true });
});

it("round-trips file bytes through the real client and fails revoked reads on redeem", async () => {
  const appId = await createApp();
  await grant(appId, "file", "docs/report.txt", "write");
  const readGrantId = await grant(appId, "file", "docs/report.txt", "read");
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
  });
  const bytes = new TextEncoder().encode("hello remainder files");
  const digest = await sha256Hex(bytes);
  const uploaded = await client.uploadFile("docs/report.txt", bytes, "text/plain");
  expect(uploaded).toMatchObject({ name: "docs/report.txt", status: "ready", sha256: digest });
  // Download verifies sha256 inside the client before returning bytes.
  const { meta, bytes: round } = await client.downloadFile("docs/report.txt");
  expect(meta.sha256).toBe(digest);
  expect(new TextDecoder().decode(round)).toBe("hello remainder files");
  expect(await sha256Hex(round)).toBe(digest);

  // Revocation bites at redeem: the token path re-checks the live grant.
  await revokeGrant(appId, readGrantId);
  await expect(client.downloadFile("docs/report.txt")).rejects.toMatchObject({
    code: "APP_FILE_FORBIDDEN",
  });
});

it("denies hidden and revoked refs through the real client even when granted rows are visible", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  await declareTable(appId, "vault", "hidden");
  const ordersRead = await grant(appId, "table", "orders", "read");
  await grant(appId, "table", "orders", "write");
  await grant(appId, "table", "vault", "read");
  const client = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
  });
  // Hidden Tables stay out of the runtime list; the granted row is
  // discoverable via listGrants, yet the runtime read answers 404, never a leak.
  const tables = await client.listTables();
  expect(tables.map((table) => table.name)).not.toContain("vault");
  const grants = await client.listGrants();
  expect(grants.filter((entry) => entry.ref === "vault")).not.toHaveLength(0);
  await expect(client.queryTable("vault")).rejects.toMatchObject({ code: "APP_TABLE_NOT_FOUND" });

  // Revocation fails the very next runtime call through the client.
  await revokeGrant(appId, ordersRead);
  await expect(client.queryTable("orders")).rejects.toMatchObject({ code: "APP_TABLE_FORBIDDEN" });

  // Ungranted Sagas fail before input parsing, even with a known Saga id.
  await expect(client.invokeSaga(helloSaga.id, { name: "Al" }, "app-sdk-remainder-deny-0001")).rejects.toMatchObject({
    code: "APP_SAGA_FORBIDDEN",
  });
  const sagaGrant = await grant(appId, "saga", helloSaga.id, "invoke");
  await revokeGrant(appId, sagaGrant);
  await expect(client.invokeSaga(helloSaga.id, { name: "Al" }, "app-sdk-remainder-deny-0002")).rejects.toMatchObject({
    code: "APP_SAGA_FORBIDDEN",
  });
});

it("retries one faulted GET and rotates a stale token exactly once against the real Worker", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  await grant(appId, "table", "orders", "read");
  await grant(appId, "table", "orders", "write");

  // Method-shaped retry: a single network fault on the tables GET is
  // absorbed (bounded retry) and the real Worker then serves.
  let faults = 1;
  let tableAttempts = 0;
  const flaky = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href.endsWith("/runtime/tables")) {
      tableAttempts += 1;
      if (faults > 0) {
        faults -= 1;
        throw new Error("boom");
      }
    }
    return workerFetch(input, init);
  }) as unknown as typeof globalThis.fetch;
  const resilient = createAppRuntimeClient({
    baseUrl: BASE,
    token: TOKEN,
    appId,
    fetchImpl: flaky,
    pollMs: 50,
    sleep: async () => {},
  });
  expect(await resilient.listTables()).not.toHaveLength(0);
  expect(tableAttempts).toBe(2);

  // Bounded one-401 refresh: a stale Bearer [REDACTED] against the real Worker, one
  // rotation, one retry, then success — refresh runs exactly once.
  let refreshed = 0;
  let failures = 0;
  const stale = createAppRuntimeClient({
    baseUrl: BASE,
    token: "b".repeat(64),
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
    sleep: async () => {},
    onRefreshToken: async () => {
      refreshed += 1;
      return TOKEN;
    },
    onAuthFailure: () => {
      failures += 1;
    },
  });
  expect(await stale.listTables()).not.toHaveLength(0);
  expect(refreshed).toBe(1);
  expect(failures).toBe(0);

  // Replay 401 after rotation surfaces with auth-failure handling, no loop.
  let replayRefresh = 0;
  let replayFailure = 0;
  const hopeless = createAppRuntimeClient({
    baseUrl: BASE,
    token: "b".repeat(64),
    appId,
    fetchImpl: clientFetch,
    pollMs: 50,
    sleep: async () => {},
    onRefreshToken: async () => {
      replayRefresh += 1;
      return "c".repeat(64);
    },
    onAuthFailure: () => {
      replayFailure += 1;
    },
  });
  await expect(hopeless.listTables()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(replayRefresh).toBe(1);
  expect(replayFailure).toBe(1);
});
