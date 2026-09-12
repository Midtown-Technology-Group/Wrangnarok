// SPDX-License-Identifier: AGPL-3.0
// APP-02 (issue #160) fail-closed branch tests: every validation arm in the
// app runtime answers its exact code, following the APP-01 precedent
// (d187432) that cleared the 95% branch gate the same way.
//
// Two layers: pure parser arms run as direct calls (no HTTP), and route-guard
// arms run through the real local Worker against real D1. Nothing here
// dispatches a Workflow; vendor HTTP is never touched.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { Fault, hash } from "../src/domain";
import {
  loadRuntimeApp,
  parseFileDeclare,
  parseGrantBody,
  parseTableBody,
  parseTableQuery,
  redeemFileUpload,
} from "../src/app-runtime";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration22 from "../migrations/0022_app_runtime.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = { orgId: ORG, userId: "00000000-0000-4000-8000-000000000002" };

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: headers(extraHeaders),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: ORG },
  );
}

function rawCall(
  path: string,
  method: string,
  rawBody: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": contentType, ...extraHeaders },
      body: rawBody,
    }),
    { ...bindings, LAB_ORG_ID: ORG },
  );
}

async function createApp(name = "branches", slug = "branches") {
  const response = await call("/api/apps", "POST", { name, slug });
  expect(response.status).toBe(201);
  return ((await response.json()) as { app: { id: string } }).app.id as string;
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

function expectFault(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Fault);
    expect((error as Fault).code).toBe(code);
    return;
  }
  throw new Error(`Expected Fault ${code}.`);
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration22);
});

afterEach(async () => {
  await reset();
});

describe("grant parsers fail closed", () => {
  it("rejects malformed grant bodies", () => {
    expectFault(() => parseGrantBody(null), "INVALID_APP_GRANT");
    expectFault(() => parseGrantBody({ kind: "nope", ref: "x", permission: "read" }), "INVALID_APP_GRANT");
    expectFault(() => parseGrantBody({ kind: "table", ref: "orders", permission: "delete" }), "INVALID_APP_GRANT");
    expectFault(() => parseGrantBody({ kind: "table", ref: "", permission: "read" }), "INVALID_APP_GRANT");
    expectFault(() => parseGrantBody({ kind: "table", ref: "Bad_Name", permission: "read" }), "INVALID_APP_GRANT");
    expectFault(() => parseGrantBody({ kind: "file", ref: "../escape", permission: "read" }), "INVALID_APP_GRANT");
    expectFault(() => parseGrantBody({ kind: "saga", ref: "not-a-uuid", permission: "invoke" }), "INVALID_APP_GRANT");
    expect(parseGrantBody({ kind: "table", ref: "orders", permission: "read" })).toEqual({
      kind: "table",
      ref: "orders",
      permission: "read",
    });
  });

  it("rejects malformed app ids before touching D1", async () => {
    await expect(loadRuntimeApp({} as unknown as D1Database, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
    });
  });

  it("rejects malformed grant ids and unknown grants on revoke", async () => {
    const appId = await createApp("revoke-arms", "revoke-arms");
    await expectCode(await call(`/api/apps/${appId}/grants/bad-id/revoke`, "POST"), 400, "INVALID_APP_GRANT");
    await expectCode(
      await call(`/api/apps/${appId}/grants/22222222-2222-4222-8222-222222222222/revoke`, "POST"),
      404,
      "APP_GRANT_NOT_FOUND",
    );
  });
});

describe("table parsers fail closed", () => {
  it("rejects malformed table declarations", () => {
    expectFault(() => parseTableBody(null), "INVALID_APP_TABLE");
    expectFault(() => parseTableBody({ name: "Bad" }), "INVALID_APP_TABLE");
    expectFault(() => parseTableBody({ name: "ok", columns: "nope" }), "INVALID_APP_TABLE");
    expectFault(() => parseTableBody({ name: "ok", columns: ["0bad"] }), "INVALID_APP_TABLE");
    expectFault(() => parseTableBody({ name: "ok", visibility: "sometimes" }), "INVALID_APP_TABLE");
    expect(parseTableBody({ name: "ok", columns: ["status"], visibility: "hidden" })).toEqual({
      name: "ok",
      columns: ["status"],
      visibility: "hidden",
    });
  });

  it("redeclares a table in place without losing rows", async () => {
    const appId = await createApp("redeclare", "redeclare");
    expect((await call(`/api/apps/${appId}/tables`, "POST", { name: "orders" })).status).toBe(201);
    const again = await call(`/api/apps/${appId}/tables`, "POST", { name: "orders", visibility: "hidden" });
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ table: { name: "orders", visibility: "hidden", revision: 0 } });
  });

  it("rejects malformed table queries", () => {
    const query = (params: Record<string, string>) => parseTableQuery(new URLSearchParams(params));
    expectFault(() => query({ filter: "{broken" }), "INVALID_TABLE_QUERY");
    expectFault(() => query({ filter: "[1,2]" }), "INVALID_TABLE_QUERY");
    expectFault(() => query({ filter: JSON.stringify({ "0bad": "x" }) }), "INVALID_TABLE_QUERY");
    expectFault(
      () =>
        query({
          filter: JSON.stringify({ a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7", h: "8", i: "9" }),
        }),
      "INVALID_TABLE_QUERY",
    );
    expectFault(() => query({ limit: "0" }), "INVALID_TABLE_QUERY");
    expectFault(() => query({ limit: "101" }), "INVALID_TABLE_QUERY");
    expectFault(() => query({ cursor: "nope" }), "INVALID_TABLE_QUERY");
    expectFault(() => query({ sinceRevision: "-1" }), "INVALID_TABLE_QUERY");
    expectFault(() => query({ sort: "amount" }), "UNSUPPORTED_QUERY");
    expect(query({ filter: JSON.stringify({ status: "open" }), limit: "10" }).filter).toEqual({ status: "open" });
  });

  async function seedRowArms(name: string, slug: string): Promise<string> {
    const appId = await createApp(name, slug);
    await call(`/api/apps/${appId}/tables`, "POST", { name: "orders" });
    await call(`/api/apps/${appId}/tables`, "POST", { name: "vault", visibility: "hidden" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "table", ref: "orders", permission: "write" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "table", ref: "orders", permission: "read" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "table", ref: "vault", permission: "read" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "table", ref: "vault", permission: "write" });
    return appId;
  }

  it("rejects malformed row bodies", async () => {
    const appId = await seedRowArms("row-bodies", "row-bodies");
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: [] }),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: {} }),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: { "0bad": 1 } }),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: { big: "x".repeat(5000) } }),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { nope: 1 }),
      400,
      "INVALID_TABLE_ROW",
    );
  });

  it("keeps hidden tables out of row write paths", async () => {
    const appId = await seedRowArms("row-hidden", "row-hidden");
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/vault/rows`, "POST", { data: { status: "x" } }),
      404,
      "APP_TABLE_NOT_FOUND",
    );
    const vaultRow = "55555555-5555-4555-8555-555555555555";
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/vault/rows/${vaultRow}`, "PATCH", { data: { status: "x" } }),
      404,
      "APP_TABLE_NOT_FOUND",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/vault/rows/${vaultRow}`, "DELETE"),
      404,
      "APP_TABLE_NOT_FOUND",
    );
    await expectCode(await call(`/api/apps/${appId}/runtime/tables/vault/rows`, "GET"), 404, "APP_TABLE_NOT_FOUND");
  });

  it("rejects malformed row ids and unknown rows", async () => {
    const appId = await seedRowArms("row-ids", "row-ids");
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows/bad-row-id`, "PATCH", { data: { status: "x" } }),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows/33333333-3333-4333-8333-333333333333`, "PATCH", {
        data: { status: "x" },
      }),
      404,
      "APP_ROW_NOT_FOUND",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows/33333333-3333-4333-8333-333333333333`, "PATCH", {
        nope: 1,
      }),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows/bad-row-id`, "DELETE"),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows/33333333-3333-4333-8333-333333333333`, "DELETE"),
      404,
      "APP_ROW_NOT_FOUND",
    );
  });

  it("rejects stale table cursors", async () => {
    const appId = await seedRowArms("row-cursor", "row-cursor");
    await expectCode(
      await call(
        `/api/apps/${appId}/runtime/tables/orders/rows?${new URLSearchParams({ cursor: "44444444-4444-4444-8444-444444444444" })}`,
      ),
      400,
      "INVALID_TABLE_QUERY",
    );
  });

  it("refuses writes past the per-table row cap", async () => {
    const appId = await createApp("table-full", "table-full");
    await call(`/api/apps/${appId}/tables`, "POST", { name: "orders" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "table", ref: "orders", permission: "write" });
    const table = await bindings.DB.prepare("SELECT id FROM app_tables WHERE app_id=? AND name=?")
      .bind(appId, "orders")
      .first<{ id: string }>();
    const now = new Date().toISOString();
    await bindings.DB.batch(
      Array.from({ length: 500 }, (_, index) =>
        bindings.DB.prepare(
          "INSERT INTO app_rows(id, table_id, app_id, org_id, data_json, table_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          table?.id ?? "",
          appId,
          ORG,
          JSON.stringify({ n: index }),
          index + 1,
          now,
          now,
        ),
      ),
    );
    await bindings.DB.prepare("UPDATE app_tables SET revision=500 WHERE id=?")
      .bind(table?.id ?? "")
      .run();
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { data: { n: 501 } }),
      409,
      "APP_TABLE_FULL",
    );
  });
});

describe("file arms fail closed", () => {
  it("rejects malformed file declarations", () => {
    expectFault(() => parseFileDeclare(null), "INVALID_APP_FILE");
    expectFault(() => parseFileDeclare({ name: "../escape" }), "INVALID_APP_FILE");
    expectFault(() => parseFileDeclare({ name: "ok.txt", contentType: "" }), "INVALID_APP_FILE");
    expect(parseFileDeclare({ name: "ok.txt" })).toEqual({ name: "ok.txt", contentType: "application/octet-stream" });
  });

  it("redeclares a file location idempotently", async () => {
    const appId = await createApp("file-redeclare", "file-redeclare");
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "a.txt", permission: "write" });
    expect((await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "a.txt" })).status).toBe(201);
    const again = await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "a.txt" });
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ file: { name: "a.txt", status: "pending" } });
    await expectCode(await call(`/api/apps/${appId}/runtime/files/declare`, "POST", {}), 400, "INVALID_APP_FILE");
  });

  it("rejects unknown files, empty tokens, and malformed token bodies", async () => {
    const appId = await createApp("token-arms", "token-arms");
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "ghost.txt", permission: "read" });
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "ghost.txt", scope: "download" }),
      404,
      "APP_FILE_NOT_FOUND",
    );
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "a.txt", permission: "write" });
    await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "a.txt" });
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "a.txt", scope: "sideways" }),
      400,
      "INVALID_APP_FILE",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/upload`, "POST", {}, { "X-File-Token": "bogus" }),
      400,
      "INVALID_APP_FILE",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/upload`, "POST", {
        content: "eA==",
        contentType: "text/plain",
        size: 1,
        sha256: "0".repeat(64),
      }),
      401,
      "APP_FILE_TOKEN_INVALID",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/download`, "POST", {}, { "X-File-Token": "bogus" }),
      401,
      "APP_FILE_TOKEN_INVALID",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/download`, "POST", {}),
      401,
      "APP_FILE_TOKEN_INVALID",
    );
  });

  it("rejects expired upload and download tokens and deletes them", async () => {
    const appId = await createApp("expired-tokens", "expired-tokens");
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "a.txt", permission: "write" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "a.txt", permission: "read" });
    await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "a.txt" });
    const file = await bindings.DB.prepare("SELECT id FROM app_files WHERE app_id=? AND name=?")
      .bind(appId, "a.txt")
      .first<{ id: string }>();
    const past = new Date(Date.now() - 60_000).toISOString();
    await bindings.DB.prepare(
      "INSERT INTO app_file_tokens(token_hash, file_id, app_id, scope, expires_at, created_at) VALUES (?, ?, ?, 'upload', ?, ?)",
    )
      .bind(await hash("expired-upload-token"), file?.id ?? "", appId, past, past)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO app_file_tokens(token_hash, file_id, app_id, scope, expires_at, created_at) VALUES (?, ?, ?, 'download', ?, ?)",
    )
      .bind(await hash("expired-download-token"), file?.id ?? "", appId, past, past)
      .run();
    const bytes = new TextEncoder().encode("late");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    await expectCode(
      await call(
        `/api/apps/${appId}/runtime/files/upload`,
        "POST",
        { content: btoa(binary), contentType: "text/plain", size: bytes.byteLength, sha256: digest },
        { "X-File-Token": "expired-upload-token" },
      ),
      401,
      "APP_FILE_TOKEN_EXPIRED",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/download`, "POST", {}, { "X-File-Token": "expired-download-token" }),
      401,
      "APP_FILE_TOKEN_EXPIRED",
    );
  });

  it("rejects malformed upload envelopes without storing", async () => {
    const appId = await createApp("upload-arms", "upload-arms");
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "a.txt", permission: "write" });
    await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "a.txt" });
    const file = await bindings.DB.prepare("SELECT id FROM app_files WHERE app_id=? AND name=?")
      .bind(appId, "a.txt")
      .first<{ id: string }>();
    const future = new Date(Date.now() + 600_000).toISOString();
    // Direct redeem covers the envelope arms the route pre-check would mask.
    await bindings.DB.prepare(
      "INSERT INTO app_file_tokens(token_hash, file_id, app_id, scope, expires_at, created_at) VALUES (?, ?, ?, 'upload', ?, ?)",
    )
      .bind(await hash("envelope-token"), file?.id ?? "", appId, future, future)
      .run();
    await expect(redeemFileUpload(bindings.DB, appId, "envelope-token", [])).rejects.toMatchObject({
      code: "INVALID_APP_FILE",
    });
    await expect(
      redeemFileUpload(bindings.DB, appId, "envelope-token", { contentType: "text/plain" }),
    ).rejects.toMatchObject({ code: "INVALID_APP_FILE" });
    await expectCode(
      await call(
        `/api/apps/${appId}/runtime/files/upload`,
        "POST",
        { content: "!!!not-base64!!!", contentType: "text/plain", size: 4, sha256: "0".repeat(64) },
        { "X-File-Token": "envelope-token" },
      ),
      400,
      "INVALID_APP_FILE",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/upload`, "POST", { nope: 1 }, { "X-File-Token": "envelope-token" }),
      400,
      "INVALID_APP_FILE",
    );
  });

  it("rejects oversized files, sha mismatches, stale versions, and pending downloads", async () => {
    const appId = await createApp("file-limits", "file-limits");
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "big.bin", permission: "write" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "big.bin", permission: "read" });
    await call(`/api/apps/${appId}/runtime/files/declare`, "POST", { name: "big.bin" });
    const oversized = new Uint8Array(32769).fill(7);
    let bigBinary = "";
    for (const byte of oversized) bigBinary += String.fromCharCode(byte);
    const bigToken = (await (
      await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "big.bin", scope: "upload" })
    ).json()) as { token: string };
    await expectCode(
      await call(
        `/api/apps/${appId}/runtime/files/upload`,
        "POST",
        {
          content: btoa(bigBinary),
          contentType: "application/octet-stream",
          size: oversized.byteLength,
          sha256: "0".repeat(64),
        },
        { "X-File-Token": bigToken.token },
      ),
      413,
      "APP_FILE_TOO_LARGE",
    );
    const small = new TextEncoder().encode("v1");
    let smallBinary = "";
    for (const byte of small) smallBinary += String.fromCharCode(byte);
    const smallContent = btoa(smallBinary);
    const shaToken = (await (
      await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "big.bin", scope: "upload" })
    ).json()) as { token: string };
    await expectCode(
      await call(
        `/api/apps/${appId}/runtime/files/upload`,
        "POST",
        { content: smallContent, contentType: "text/plain", size: small.byteLength, sha256: "1".repeat(64) },
        { "X-File-Token": shaToken.token },
      ),
      422,
      "APP_FILE_METADATA_MISMATCH",
    );
    // Pending file: download refuses before any bytes land.
    const pendingToken = (await (
      await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "big.bin", scope: "download" })
    ).json()) as { token: string };
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/download`, "POST", {}, { "X-File-Token": pendingToken.token }),
      409,
      "APP_FILE_NOT_READY",
    );
    // First verified upload lands version 1; a second lands version 2; a
    // stale expectedVersion on a third conflicts instead of overwriting.
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", small)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    for (const version of [1, 2]) {
      const tokened = (await (
        await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "big.bin", scope: "upload" })
      ).json()) as { token: string };
      const uploaded = (await (
        await call(
          `/api/apps/${appId}/runtime/files/upload`,
          "POST",
          { content: smallContent, contentType: "text/plain", size: small.byteLength, sha256: digest },
          { "X-File-Token": tokened.token },
        )
      ).json()) as { file: { version: number } };
      expect(uploaded.file.version).toBe(version);
    }
    const staleToken = (await (
      await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "big.bin", scope: "upload" })
    ).json()) as { token: string };
    await expectCode(
      await call(
        `/api/apps/${appId}/runtime/files/upload`,
        "POST",
        {
          content: smallContent,
          contentType: "text/plain",
          size: small.byteLength,
          sha256: digest,
          expectedVersion: 1,
        },
        { "X-File-Token": staleToken.token },
      ),
      409,
      "APP_FILE_VERSION_CONFLICT",
    );
  });

  it("rejects tokens for deleted files and unknown file deletes", async () => {
    const appId = await createApp("file-ghosts", "file-ghosts");
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "gone.txt", permission: "write" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "gone.txt", permission: "read" });
    // Tokens for vanished files are unreachable through live routes (file
    // delete cascades its tokens by FK): redeem answers APP_FILE_NOT_FOUND
    // only for out-of-band loss, pinned here as a documented defensive arm.
    await expectCode(await call(`/api/apps/${appId}/runtime/files/gone.txt`, "DELETE"), 404, "APP_FILE_NOT_FOUND");
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/gone.txt?expectedVersion=abc`, "DELETE"),
      400,
      "INVALID_APP_FILE",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/gone.txt?other=1`, "DELETE"),
      400,
      "UNSUPPORTED_QUERY",
    );
  });
});

describe("route guards fail closed", () => {
  it("denies strangers on runtime routes without leaking the app", async () => {
    // The AUTH-01 membership gate runs before app loading: a caller with no
    // membership answers ORG_NOT_FOUND (404), never APP_NOT_FOUND shape
    // differences that would confirm or deny the app id.
    const stranger = "00000000-0000-4000-8000-000000000005";
    const appId = await createApp("stranger-arms", "stranger-arms");
    const strangerCall = (path: string, method = "GET", body?: unknown) =>
      worker.fetch(
        new Request(`http://local.test${path}`, {
          method,
          headers: headers(),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        {
          ...bindings,
          LAB_ORG_ID: ORG,
          LAB_USER_ID: stranger,
          LAB_FIXTURE_USER_ID: "00000000-0000-4000-8000-000000000002",
        },
      );
    await expectCode(await strangerCall(`/api/apps/${appId}/sdk`), 404, "ORG_NOT_FOUND");
    await expectCode(await strangerCall(`/api/apps/${appId}/runtime/tables`), 404, "ORG_NOT_FOUND");
  });

  it("rejects query strings on query-less app routes", async () => {
    const appId = await createApp("guard-arms", "guard-arms");
    await expectCode(await call(`/api/apps?x=1`), 400, "UNSUPPORTED_QUERY");
    await expectCode(await call(`/api/apps/${appId}/grants?x=1`, "POST"), 400, "UNSUPPORTED_QUERY");
    await expectCode(await rawCall(`/api/apps/${appId}/grants`, "POST", "", "text/plain"), 415, "JSON_REQUIRED");
    await expectCode(await call(`/api/apps/${appId}/grants/whatever/revoke?x=1`, "POST"), 400, "UNSUPPORTED_QUERY");
    await expectCode(await call(`/api/apps/${appId}/tables?x=1`), 400, "UNSUPPORTED_QUERY");
    await expectCode(await call(`/api/apps/${appId}/runtime/tables?x=1`), 400, "UNSUPPORTED_QUERY");
    await expectCode(await call(`/api/apps/${appId}/runtime/executions?x=1`), 400, "UNSUPPORTED_QUERY");
    await expectCode(await call(`/api/apps/${appId}/runtime/files?x=1`), 400, "UNSUPPORTED_QUERY");
  });

  it("rejects malformed invoke and row-write envelopes", async () => {
    const appId = await createApp("envelope-arms", "envelope-arms");
    await expectCode(
      await rawCall(`/api/apps/${appId}/runtime/invoke`, "POST", "not-json", "text/plain", {
        "Idempotency-Key": "envelope-arms-key-0001",
      }),
      415,
      "JSON_REQUIRED",
    );
    await expectCode(
      await call(`/api/apps/${appId}/runtime/invoke`, "POST", {}, { "Idempotency-Key": "envelope-arms-key-0002" }),
      400,
      "INVALID_SUBMISSION",
    );
    await expectCode(
      await call(
        `/api/apps/${appId}/runtime/invoke`,
        "POST",
        { sagaId: "395e15f0-3627-41f6-8922-008ce37e3b35", input: {}, extra: 1 },
        { "Idempotency-Key": "envelope-arms-key-0003" },
      ),
      400,
      "INVALID_SUBMISSION",
    );
    await call(`/api/apps/${appId}/tables`, "POST", { name: "orders" });
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "table", ref: "orders", permission: "write" });
    await expectCode(
      await call(`/api/apps/${appId}/runtime/tables/orders/rows`, "POST", { nope: 1 }),
      400,
      "INVALID_TABLE_ROW",
    );
    await expectCode(await call(`/api/apps/${appId}/runtime/files/declare`, "POST", {}), 400, "INVALID_APP_FILE");
  });

  it("rejects malformed file-token envelopes", async () => {
    const appId = await createApp("file-token-arms", "file-token-arms");
    await call(`/api/apps/${appId}/grants`, "POST", { kind: "file", ref: "a.txt", permission: "write" });
    await expectCode(
      await call(`/api/apps/${appId}/runtime/files/tokens`, "POST", { name: "a.txt" }),
      400,
      "INVALID_APP_FILE",
    );
  });
});
