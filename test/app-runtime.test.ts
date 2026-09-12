// SPDX-License-Identifier: AGPL-3.0
// Browser App SDK runtime (APP-02, issue #160; ADR 019): scoped workflows,
// Tables, files and live updates proven against the real local Worker.
//
// Runs in real workerd via @cloudflare/vitest-plugin; D1/Workflow bindings
// are never replaced, only outbound vendor HTTP is intercepted. No production
// deployment. Applies the full migration chain (0001 + 0002 + 0006 + 0022) so
// the runtime schema composes with executions and apps.
//
// Proven here, end to end through HTTP:
// - Author: grants (create/list/revoke + conflict), Tables (declare, hidden
//   vs visible author view), handshake descriptor + version header.
// - Runtime allowed: saga invoke/result via a granted Saga (hello, pure, no
//   vendor), filtered Table read/write/live revision poll, file
//   declare/token/upload/download/delete with finalize-after-upload.
// - Runtime denied: ungranted refs fail 403 even when the name is known;
//   hidden Tables 404 on runtime paths; revoked grants fail immediately
//   (including outstanding token redeem); foreign-Organization apps 404;
//   query-only filters 422; version conflicts 409; token reuse 401.
// - SDK contract: every served APP_* code is in SDK_ERROR_CODES, and the
//   descriptor lists the runtime routes plus the app-runtime capability.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga } from "../src/domain";
import { APP_SDK_VERSION } from "../src/app-runtime";
import { describeContract, SDK_ERROR_CODES } from "../src/sdk";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration22 from "../migrations/0022_app_runtime.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, orgId = ORG, extraHeaders: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: headers(extraHeaders),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: orgId },
  );
}

async function createApp(name = "storefront", slug = "storefront") {
  const response = await call("/api/apps", "POST", { name, slug });
  expect(response.status).toBe(201);
  return ((await response.json()) as { app: { id: string } }).app.id as string;
}

async function grant(appId: string, kind: string, ref: string, permission: string) {
  const response = await call(`/api/apps/${appId}/grants`, "POST", { kind, ref, permission });
  expect(response.status).toBe(201);
  return ((await response.json()) as { grant: { id: string } }).grant;
}

async function declareTable(appId: string, name: string, visibility: "visible" | "hidden" = "visible") {
  const response = await call(`/api/apps/${appId}/tables`, "POST", { name, visibility });
  expect(response.status).toBe(201);
  return (await response.json()) as { table: { revision: number } };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration22);
});

afterEach(async () => {
  await reset();
});

it("serves the handshake descriptor with the version tripwire", async () => {
  const appId = await createApp();
  const response = await call(`/api/apps/${appId}/sdk`);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-App-SDK-Version")).toBe(APP_SDK_VERSION);
  expect(await response.json()).toMatchObject({
    sdk: "wrangnarok.app-runtime",
    version: APP_SDK_VERSION,
    app: { id: appId },
  });
  expect((await call(`/api/apps/${appId}/sdk`, "GET", undefined, OTHER_ORG)).status).toBe(404);
});

it("manages grants: create, list, duplicate conflict, revoke, re-grant conflict", async () => {
  const appId = await createApp();
  const created = await grant(appId, "table", "orders", "read");
  expect(created).toMatchObject({ kind: "table", ref: "orders", permission: "read", revoked: false });
  const listed = await call(`/api/apps/${appId}/grants`);
  expect(await listed.json()).toMatchObject({ grants: [{ ref: "orders", revoked: false }] });
  const duplicate = await call(`/api/apps/${appId}/grants`, "POST", {
    kind: "table",
    ref: "orders",
    permission: "read",
  });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: "APP_GRANT_CONFLICT" } });
  const revoked = await call(`/api/apps/${appId}/grants/${created.id}/revoke`, "POST");
  expect(await revoked.json()).toMatchObject({ grant: { revoked: true } });
  const regrant = await call(`/api/apps/${appId}/grants`, "POST", { kind: "table", ref: "orders", permission: "read" });
  expect(regrant.status).toBe(409);
  const bad = await call(`/api/apps/${appId}/grants`, "POST", { kind: "saga", ref: "nope", permission: "invoke" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: { code: "INVALID_APP_GRANT" } });
});

it("denies ungranted runtime refs even when the name is known", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  // No grants at all: the runtime list is empty and every runtime path fails closed.
  const empty = (await (await call(`/api/apps/${appId}/runtime/tables`)).json()) as { tables: unknown[] };
  expect(empty.tables).toEqual([]);
  const read = await call(`/api/apps/${appId}/runtime/tables/orders/rows`);
  expect(read.status).toBe(403);
  expect(await read.json()).toMatchObject({ error: { code: "APP_TABLE_FORBIDDEN" } });
  const write = await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: { status: "open" } });
  expect(write.status).toBe(403);
  const invoke = await call(
    `/api/apps/${appId}/runtime/invoke`,
    "POST",
    { sagaId: helloSaga.id, input: { name: "Al" } },
    ORG,
    {
      "Idempotency-Key": "app-runtime-deny-0001",
    },
  );
  expect(invoke.status).toBe(403);
  expect(await invoke.json()).toMatchObject({ error: { code: "APP_SAGA_FORBIDDEN" } });
  const files = await call(`/api/apps/${appId}/runtime/files`);
  expect(await files.json()).toEqual({ files: [] });
});

it("keeps hidden Tables out of the runtime list and read paths", async () => {
  const appId = await createApp();
  await declareTable(appId, "secret-ledger", "hidden");
  await declareTable(appId, "orders", "visible");
  await grant(appId, "table", "secret-ledger", "read");
  await grant(appId, "table", "orders", "read");
  // Author view shows both with visibility flags.
  const declared = (await (await call(`/api/apps/${appId}/tables`)).json()) as {
    tables: { name: string; visibility: string }[];
  };
  expect(declared.tables.map((entry) => `${entry.name}:${entry.visibility}`).sort()).toEqual([
    "orders:visible",
    "secret-ledger:hidden",
  ]);
  // Runtime list shows visible only, even with a grant on the hidden Table.
  const runtime = (await (await call(`/api/apps/${appId}/runtime/tables`)).json()) as {
    tables: { name: string }[];
  };
  expect(runtime.tables.map((entry) => entry.name)).toEqual(["orders"]);
  // Runtime read of the hidden Table 404s, never leaks.
  const hidden = await call(`/api/apps/${appId}/runtime/tables/secret-ledger/rows`);
  expect(hidden.status).toBe(404);
  expect(await hidden.json()).toMatchObject({ error: { code: "APP_TABLE_NOT_FOUND" } });
});

it("reads/writes Table rows with filters, pages, and live revision polling", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  await grant(appId, "table", "orders", "read");
  await grant(appId, "table", "orders", "write");
  const first = (await (
    await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: { status: "open", amount: 40 } })
  ).json()) as { row: { id: string; tableRevision: number } };
  const second = (await (
    await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: { status: "shipped", amount: 7 } })
  ).json()) as { row: { id: string; tableRevision: number } };
  expect(second.row.tableRevision).toBe(first.row.tableRevision + 1);
  // Equality filter: only the open order matches.
  const filtered = (await (
    await call(
      `/api/apps/${appId}/runtime/tables/orders/rows?${new URLSearchParams({ filter: JSON.stringify({ status: "open" }), limit: "10" })}`,
    )
  ).json()) as { rows: { id: string }[]; tableRevision: number };
  expect(filtered.rows.map((row) => row.id)).toEqual([first.row.id]);
  expect(filtered.tableRevision).toBe(second.row.tableRevision);
  // Page through newest-first with limit 1 + cursor.
  const pageOne = (await (
    await call(`/api/apps/${appId}/runtime/tables/orders/rows?${new URLSearchParams({ limit: "1" })}`)
  ).json()) as { rows: { id: string }[]; hasMore: boolean; nextCursor: string | null };
  expect(pageOne.rows.map((row) => row.id)).toEqual([second.row.id]);
  expect(pageOne.hasMore).toBe(true);
  const pageTwo = (await (
    await call(
      `/api/apps/${appId}/runtime/tables/orders/rows?${new URLSearchParams({ limit: "1", cursor: pageOne.nextCursor ?? "" })}`,
    )
  ).json()) as { rows: { id: string }[]; hasMore: boolean };
  expect(pageTwo.rows.map((row) => row.id)).toEqual([first.row.id]);
  expect(pageTwo.hasMore).toBe(false);
  // Bounded-poll shortcut: holding the current revision returns empty fast.
  const quiet = (await (
    await call(
      `/api/apps/${appId}/runtime/tables/orders/rows?${new URLSearchParams({ sinceRevision: String(second.row.tableRevision) })}`,
    )
  ).json()) as { rows: unknown[]; tableRevision: number };
  expect(quiet.rows).toEqual([]);
  expect(quiet.tableRevision).toBe(second.row.tableRevision);
  // Patch bumps the revision; delete removes and bumps again.
  const patched = (await (
    await call(`/api/apps/${appId}/runtime/tables/orders/rows/${first.row.id}`, "PATCH", {
      data: { status: "paid", amount: 40 },
    })
  ).json()) as { row: { data: { status: string }; tableRevision: number } };
  expect(patched.row.data.status).toBe("paid");
  const deleted = (await (
    await call(`/api/apps/${appId}/runtime/tables/orders/rows/${second.row.id}`, "DELETE")
  ).json()) as { deleted: boolean; tableRevision: number };
  expect(deleted).toMatchObject({ deleted: true });
  expect(deleted.tableRevision).toBe(patched.row.tableRevision + 1);
  // Query-only operators fail loud, never silently widen.
  const nested = await call(
    `/api/apps/${appId}/runtime/tables/orders/rows?${new URLSearchParams({ filter: JSON.stringify({ amount: { gte: 5 } }) })}`,
  );
  expect(nested.status).toBe(422);
  expect(await nested.json()).toMatchObject({ error: { code: "APP_TABLE_QUERY_UNSUPPORTED" } });
  const stray = await call(`/api/apps/${appId}/runtime/tables/orders/rows?sort=amount`);
  expect(stray.status).toBe(400);
  expect(await stray.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
});

it("fails revoked grants immediately on the next runtime call", async () => {
  const appId = await createApp();
  await declareTable(appId, "orders");
  const created = await grant(appId, "table", "orders", "read");
  expect((await call(`/api/apps/${appId}/runtime/tables/orders/rows`)).status).toBe(200);
  await call(`/api/apps/${appId}/grants/${created.id}/revoke`, "POST");
  const denied = await call(`/api/apps/${appId}/runtime/tables/orders/rows`);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: { code: "APP_TABLE_FORBIDDEN" } });
});

it("invokes a granted Saga end to end and tails scoped activity", async () => {
  const appId = await createApp();
  await grant(appId, "saga", helloSaga.id, "invoke");
  const key = "app-runtime-invoke-0001";
  const id = await executionId({ orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" }, key);
  await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
  const accepted = await call(
    `/api/apps/${appId}/runtime/invoke`,
    "POST",
    { sagaId: helloSaga.id, input: { name: "Ada" } },
    ORG,
    {
      "Idempotency-Key": key,
    },
  );
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ executionId: id, replayed: false });
  await instance.waitForStatus("complete");
  const detail = await call(`/api/executions/${id}`);
  expect(await detail.json()).toMatchObject({ status: "Succeeded", result: { greeting: "Hello, Ada!" } });
  const tail = (await (await call(`/api/apps/${appId}/runtime/executions`)).json()) as {
    executions: { executionId: string; sagaId: string }[];
  };
  expect(tail.executions).toMatchObject([{ executionId: id, sagaId: helloSaga.id }]);
  // Same key replays canonically; a foreign org sees neither app nor tail.
  const replay = await call(
    `/api/apps/${appId}/runtime/invoke`,
    "POST",
    { sagaId: helloSaga.id, input: { name: "Ada" } },
    ORG,
    {
      "Idempotency-Key": key,
    },
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ executionId: id, replayed: true });
  expect((await call(`/api/apps/${appId}/runtime/executions`, "GET", undefined, OTHER_ORG)).status).toBe(404);
});

it("runs the signed file flow: declare, token, upload, download, versioned delete", async () => {
  const appId = await createApp();
  await grant(appId, "file", "docs/report.txt", "write");
  await grant(appId, "file", "docs/report.txt", "read");
  const declared = (await (
    await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "docs/report.txt" })
  ).json()) as { file: { status: string; version: number } };
  expect(declared.file).toMatchObject({ status: "pending", version: 1 });
  const encoder = new TextEncoder();
  const bytes = encoder.encode("hello files");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const content = btoa(binary);
  const uploadToken = (await (
    await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "docs/report.txt", scope: "upload" })
  ).json()) as { token: string };
  const uploaded = (await (
    await call(
      `/api/apps/${appId}/runtime/files/upload`,
      "POST",
      { content, contentType: "text/plain", size: bytes.byteLength, sha256: digest },
      ORG,
      { "X-File-Token": uploadToken.token },
    )
  ).json()) as { file: { status: string; size: number; sha256: string; version: number } };
  expect(uploaded.file).toMatchObject({ status: "ready", size: bytes.byteLength, sha256: digest });
  // Token reuse fails closed: single-use bearer capabilities.
  const reuse = await call(
    `/api/apps/${appId}/runtime/files/upload`,
    "POST",
    { content, contentType: "text/plain", size: bytes.byteLength, sha256: digest },
    ORG,
    { "X-File-Token": uploadToken.token },
  );
  expect(reuse.status).toBe(401);
  expect(await reuse.json()).toMatchObject({ error: { code: "APP_FILE_TOKEN_INVALID" } });
  // Declared-metadata mismatch stores nothing.
  const badToken = (await (
    await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "docs/report.txt", scope: "upload" })
  ).json()) as { token: string };
  const mismatch = await call(
    `/api/apps/${appId}/runtime/files/upload`,
    "POST",
    { content, contentType: "text/plain", size: bytes.byteLength + 1, sha256: digest },
    ORG,
    { "X-File-Token": badToken.token },
  );
  expect(mismatch.status).toBe(422);
  expect(await mismatch.json()).toMatchObject({ error: { code: "APP_FILE_METADATA_MISMATCH" } });
  // Download round-trips the exact bytes; the granted list shows the file.
  const listed = (await (await call(`/api/apps/${appId}/runtime/files`)).json()) as { files: { name: string }[] };
  expect(listed.files.map((file) => file.name)).toEqual(["docs/report.txt"]);
  const downloadToken = (await (
    await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "docs/report.txt", scope: "download" })
  ).json()) as { token: string };
  const downloaded = (await (
    await call(`/api/apps/${appId}/runtime/files/download`, "POST", {}, ORG, { "X-File-Token": downloadToken.token })
  ).json()) as { meta: { sha256: string }; content: string };
  expect(downloaded.meta.sha256).toBe(digest);
  expect(downloaded.content).toBe(content);
  // Stale versions conflict; the fresh version deletes.
  const stale = await call(`/api/apps/${appId}/runtime/files/docs%2Freport.txt?expectedVersion=999`, "DELETE");
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "APP_FILE_VERSION_CONFLICT" } });
  const deleted = await call(
    `/api/apps/${appId}/runtime/files/docs%2Freport.txt?expectedVersion=${uploaded.file.version}`,
    "DELETE",
  );
  expect(await deleted.json()).toEqual({ deleted: true });
});

it("fails a revoked file grant at token redeem, not just issue", async () => {
  const appId = await createApp();
  const write = await grant(appId, "file", "docs/late.txt", "write");
  await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "docs/late.txt" });
  const tokened = (await (
    await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "docs/late.txt", scope: "upload" })
  ).json()) as { token: string };
  await call(`/api/apps/${appId}/grants/${write.id}/revoke`, "POST");
  const bytes = new TextEncoder().encode("late");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const redeemed = await call(
    `/api/apps/${appId}/runtime/files/upload`,
    "POST",
    { content: btoa(binary), contentType: "text/plain", size: bytes.byteLength, sha256: digest },
    ORG,
    { "X-File-Token": tokened.token },
  );
  expect(redeemed.status).toBe(403);
  expect(await redeemed.json()).toMatchObject({ error: { code: "APP_FILE_FORBIDDEN" } });
});

it("keeps the SDK contract covering every served app-runtime code and route", async () => {
  const descriptor = describeContract();
  for (const code of [
    "INVALID_APP_GRANT",
    "APP_GRANT_CONFLICT",
    "APP_GRANT_NOT_FOUND",
    "APP_SAGA_FORBIDDEN",
    "APP_TABLE_FORBIDDEN",
    "APP_FILE_FORBIDDEN",
    "INVALID_APP_TABLE",
    "INVALID_TABLE_QUERY",
    "APP_TABLE_QUERY_UNSUPPORTED",
    "APP_TABLE_NOT_FOUND",
    "INVALID_TABLE_ROW",
    "APP_ROW_NOT_FOUND",
    "APP_TABLE_FULL",
    "INVALID_APP_FILE",
    "APP_FILE_NOT_FOUND",
    "APP_FILE_TOKEN_INVALID",
    "APP_FILE_TOKEN_EXPIRED",
    "APP_FILE_METADATA_MISMATCH",
    "APP_FILE_TOO_LARGE",
    "APP_FILE_NOT_READY",
    "APP_FILE_VERSION_CONFLICT",
    "APP_SDK_MISMATCH",
    "UNSUPPORTED_QUERY",
  ]) {
    expect(SDK_ERROR_CODES).toContain(code);
  }
  const paths = descriptor.routes.map((route) => `${route.method} ${route.path}`);
  for (const expected of [
    "GET /api/apps/:id/grants",
    "POST /api/apps/:id/grants",
    "POST /api/apps/:id/grants/:grantId/revoke",
    "GET /api/apps/:id/tables",
    "POST /api/apps/:id/tables",
    "GET /api/apps/:id/sdk",
    "GET /api/apps/:id/runtime/tables",
    "GET /api/apps/:id/runtime/tables/:name/rows",
    "POST /api/apps/:id/runtime/tables/:name/rows",
    "PATCH /api/apps/:id/runtime/tables/:name/rows/:rowId",
    "DELETE /api/apps/:id/runtime/tables/:name/rows/:rowId",
    "POST /api/apps/:id/runtime/invoke",
    "GET /api/apps/:id/runtime/executions",
    "GET /api/apps/:id/runtime/files",
    "POST /api/apps/:id/runtime/files/tokens",
    "POST /api/apps/:id/runtime/files/upload",
    "POST /api/apps/:id/runtime/files/download",
  ]) {
    expect(paths).toContain(expected);
  }
  expect(descriptor.capabilities.find((entry) => entry.name === "app-runtime")?.status).toBe("supported");
  // The served descriptor agrees with the live Worker route.
  const appId = await createApp("sdk-probe", "sdk-probe");
  const served = await call("/api/sdk");
  expect(await served.json()).toEqual(describeContract());
  expect(appId).toMatch(/^[0-9a-f-]{36}$/);
});
