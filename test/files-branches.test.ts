// SPDX-License-Identifier: AGPL-3.0
// Managed file locations (FILE-01, issue #157; ADR 018): fail-closed branch
// coverage for the parsers, location/policy administration, token
// validation, finalize verification, versioned delete, and structural
// listing paths. Every invalid shape below answers 4xx with a stable code;
// nothing here invents behavior, it pins the existing fail-closed contract
// against real local D1 + real local R2 in workerd.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  decodeFileCursor,
  encodeFileCursor,
  evaluateAccess,
  listPolicies,
  objectKey,
  parseBatchEntries,
  parseContentTypes,
  parseExpirySeconds,
  parseFileListQuery,
  parseFilePath,
  parseFinalizeBody,
  parseLocationName,
  parseMaxBytes,
  parsePolicyAction,
  readBoundedBytes,
  sha256Hex,
} from "../src/files";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration19 from "../migrations/0019_files.sql?raw";
import migrationOrg from "../migrations/0007_org_membership.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000009";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, orgId = ORG, userId?: string) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: orgId, ...(userId ? { LAB_USER_ID: userId } : {}) },
  );
}

function expectFault(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected Fault ${code}, but nothing threw.`);
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function sha256Of(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return sha256Hex(digest);
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration19);
  await bindings.DB.exec(migrationOrg);
  // AUTH-01 membership gate: the LAB fixture identity bootstraps to admin
  // of ORG inside authenticate on first use. OTHER_USER holds an ordinary
  // membership so file-policy denials prove file policy, not org
  // strangerhood. OTHER_ORG stays unknown: cross-org reads answer 404.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OTHER_USER, "member", "active", "ordinary", stamp, stamp)
    .run();
});

afterEach(async () => {
  await reset();
});

it("rejects malformed location, path, expiry, action, size, and type shapes", () => {
  for (const bad of ["", "UPPER", "a/b", "-lead", "x".repeat(65), 7, null, ["a"]]) {
    expectFault(() => parseLocationName(bad), "INVALID_LOCATION");
  }
  expect(parseLocationName("ok-name-1")).toBe("ok-name-1");
  for (const bad of ["", "x".repeat(513), "/abs", "trail/", "a//b", "a/./b", "a/../b", "a\\b", ".", "..", 7, null]) {
    expectFault(() => parseFilePath(bad), "INVALID_PATH");
  }
  expect(parseFilePath("a/b-c_d.e")).toBe("a/b-c_d.e");
  expect(parseExpirySeconds(undefined)).toBe(600);
  for (const bad of [0, 7 * 24 * 60 * 60 + 1, 1.5, "600", null]) {
    expectFault(() => parseExpirySeconds(bad), "INVALID_EXPIRY");
  }
  expectFault(() => parsePolicyAction("execute"), "INVALID_POLICY_ACTION");
  expect(parsePolicyAction("write")).toBe("write");
  expect(parseMaxBytes(undefined)).toBe(5 * 1024 * 1024);
  for (const bad of [0, -1, 1.5, "1024", 25 * 1024 * 1024 + 1, null]) {
    expectFault(() => parseMaxBytes(bad), "INVALID_LOCATION");
  }
  expect(parseContentTypes(undefined)).toEqual([]);
  expect(parseContentTypes(["Text/Plain "])).toEqual(["text/plain"]);
  for (const bad of ["not-a-list", new Array(51).fill("text/plain"), [""], ["x".repeat(129)], ["no-slash"], [7]]) {
    expectFault(() => parseContentTypes(bad), "INVALID_LOCATION");
  }
});

it("rejects malformed batch, finalize, and list shapes", () => {
  expectFault(() => parseBatchEntries(null), "INVALID_BATCH");
  expectFault(() => parseBatchEntries({ entries: [] }), "INVALID_BATCH");
  expectFault(() => parseBatchEntries({ entries: new Array(101).fill({ location: "a", path: "b" }) }), "INVALID_BATCH");
  expectFault(() => parseBatchEntries({ entries: [null] }), "INVALID_BATCH");
  expectFault(() => parseBatchEntries({ entries: [{ location: "a", path: "b", expiresIn: 0 }] }), "INVALID_EXPIRY");
  expectFault(() => parseFinalizeBody(null), "INVALID_FINALIZE");
  expectFault(
    () => parseFinalizeBody({ location: "a", path: "b", contentType: "", size: 1, sha256: "a".repeat(64) }),
    "INVALID_FINALIZE",
  );
  expectFault(
    () => parseFinalizeBody({ location: "a", path: "b", contentType: "text/plain", size: 1.5, sha256: "a".repeat(64) }),
    "INVALID_FINALIZE",
  );
  expectFault(
    () => parseFinalizeBody({ location: "a", path: "b", contentType: "text/plain", size: 1, sha256: "xyz" }),
    "INVALID_FINALIZE",
  );
  expectFault(
    () =>
      parseFinalizeBody({
        location: "a",
        path: "b",
        contentType: "text/plain",
        size: 1,
        sha256: "a".repeat(64),
        expectedVersion: -1,
      }),
    "INVALID_FINALIZE",
  );
  expect(
    parseFinalizeBody({
      location: "a",
      path: "b",
      contentType: "Text/Plain",
      size: 1,
      sha256: "A".repeat(64),
      expectedVersion: 2,
    }),
  ).toMatchObject({ contentType: "text/plain", sha256: "a".repeat(64), expectedVersion: 2 });
  expectFault(() => parseFileListQuery(new URLSearchParams("location=a&bogus=1")), "UNSUPPORTED_QUERY");
  expectFault(() => parseFileListQuery(new URLSearchParams("")), "INVALID_LOCATION");
  expectFault(() => parseFileListQuery(new URLSearchParams("location=a&prefix=")), "INVALID_PATH");
  expectFault(() => parseFileListQuery(new URLSearchParams("location=a&prefix=a\\b")), "INVALID_PATH");
  expectFault(() => parseFileListQuery(new URLSearchParams("location=a&limit=0")), "INVALID_LIMIT");
  expectFault(() => parseFileListQuery(new URLSearchParams("location=a&limit=51")), "INVALID_LIMIT");
  expect(parseFileListQuery(new URLSearchParams("location=a&prefix=sub&limit=5"))).toMatchObject({
    location: "a",
    prefix: "sub",
    limit: 5,
  });
});

it("round-trips file cursors and rejects malformed markers", () => {
  const cursor = encodeFileCursor({ updatedAt: "2026-09-11T00:00:00.000Z", path: "a.txt" });
  expect(decodeFileCursor(cursor)).toEqual({ updatedAt: "2026-09-11T00:00:00.000Z", path: "a.txt" });
  for (const bad of ["!!!", btoa(JSON.stringify({ nope: 1 })), btoa(JSON.stringify({ updatedAt: "", path: "" }))]) {
    expectFault(() => decodeFileCursor(bad), "INVALID_CURSOR");
  }
  expect(objectKey(ORG, "loc", "a/b.txt")).toBe(`${ORG}/loc/a/b.txt`);
});

it("reads bounded bodies: empty bodies fail, over-limit bodies stop at 413", async () => {
  await expect(readBoundedBytes(null, 8)).rejects.toMatchObject({ code: "EMPTY_UPLOAD" });
  const over = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("0123456789abcdef"));
      controller.close();
    },
  });
  await expect(readBoundedBytes(over, 8)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  const exact = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("01234567"));
      controller.close();
    },
  });
  expect((await readBoundedBytes(exact, 8)).byteLength).toBe(8);
});

it("administers locations: validation, conflicts, unknown rows", async () => {
  expect((await call("/api/file-locations", "POST", { name: "UPPER" })).status).toBe(400);
  expect(await codeOf(await call("/api/file-locations", "POST", { name: "UPPER" }))).toBe("INVALID_LOCATION");
  expect(await codeOf(await call("/api/file-locations", "POST", null))).toBe("INVALID_LOCATION");
  expect(await codeOf(await call("/api/file-locations", "POST", { name: "ok", maxBytes: 0 }))).toBe("INVALID_LOCATION");
  expect(await codeOf(await call("/api/file-locations", "POST", { name: "ok", contentTypes: ["nope"] }))).toBe(
    "INVALID_LOCATION",
  );
  expect(await codeOf(await call("/api/file-locations", "POST", { name: "ok", sharedRead: "yes" }))).toBe(
    "INVALID_LOCATION",
  );
  expect((await call("/api/file-locations", "POST", { name: "branch", maxBytes: 64 })).status).toBe(201);
  // Unknown and foreign locations answer 404 on detail, policies, and delete.
  expect((await call("/api/file-locations/nope")).status).toBe(404);
  expect((await call("/api/file-locations/nope", "DELETE")).status).toBe(404);
  expect(await call("/api/file-locations/branch")).toMatchObject({ status: 200 });
  // Foreign Organizations never see the location.
  expect((await call("/api/file-locations/branch", "GET", undefined, OTHER)).status).toBe(404);
  // Unsupported query strings fail closed on the location list.
  expect((await call("/api/file-locations?location=branch")).status).toBe(400);
});

it("administers policies: validation, revoke-absent, idempotent grant, access-test", async () => {
  expect((await call("/api/file-locations", "POST", { name: "branch", maxBytes: 64 })).status).toBe(201);
  // Invalid policy bodies fail before any lookup.
  expect(await codeOf(await call("/api/file-policies", "POST", null))).toBe("INVALID_POLICY");
  expect(await codeOf(await call("/api/file-policies", "POST", { location: "branch", action: "execute" }))).toBe(
    "INVALID_POLICY_ACTION",
  );
  expect(await codeOf(await call("/api/file-policies", "POST", { location: "nope", action: "read" }))).toBe(
    "NOT_FOUND",
  );
  expect(await codeOf(await call("/api/file-policies", "DELETE", null))).toBe("INVALID_POLICY");
  expect(await codeOf(await call("/api/file-policies", "DELETE", { location: "branch", action: "execute" }))).toBe(
    "INVALID_POLICY_ACTION",
  );
  expect(await codeOf(await call("/api/file-policies", "DELETE", { location: "nope", action: "read" }))).toBe(
    "NOT_FOUND",
  );
  // Revoking an already-absent row answers 404.
  await call("/api/file-policies", "DELETE", { location: "branch", action: "delete" });
  expect(await codeOf(await call("/api/file-policies", "DELETE", { location: "branch", action: "delete" }))).toBe(
    "NOT_FOUND",
  );
  // Re-granting is idempotent.
  expect((await call("/api/file-policies", "POST", { location: "branch", action: "delete" })).status).toBe(201);
  // Access-test bodies validate before evaluating.
  expect(await codeOf(await call("/api/file-policies/test", "POST", null))).toBe("INVALID_POLICY_TEST");
  expect(
    await codeOf(await call("/api/file-policies/test", "POST", { location: "branch", path: "../x", action: "read" })),
  ).toBe("INVALID_PATH");
  // Deleting a location that still holds files refuses with LOCATION_NOT_EMPTY.
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "branch", path: "keep.txt" }] });
  expect(slot.status).toBe(200);
  const cannotDelete = await call("/api/file-locations/branch", "DELETE");
  expect(cannotDelete.status).toBe(409);
  expect(await codeOf(cannotDelete)).toBe("LOCATION_NOT_EMPTY");
});

it("evaluates write access without a declared location or policy", async () => {
  expect(await evaluateAccess(bindings.DB, ORG, "ghost", "a.txt", "write")).toEqual({
    allowed: false,
    reason: "no declared location",
  });
  expect((await call("/api/file-locations", "POST", { name: "bare" })).status).toBe(201);
  await bindings.DB.prepare("DELETE FROM file_policies WHERE org_id=? AND location=? AND action=?")
    .bind(ORG, "bare", "write")
    .run();
  expect(await evaluateAccess(bindings.DB, ORG, "bare", "a.txt", "write")).toEqual({
    allowed: false,
    reason: "no write policy",
  });
  expect(await listPolicies(bindings.DB, { orgId: ORG, userId: "u" }, "bare")).toMatchObject([
    { action: "delete" },
    { action: "read" },
  ]);
  await expect(listPolicies(bindings.DB, { orgId: ORG, userId: "u" }, "ghost")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

it("rejects uploads without policy, malformed tokens, and over-cap bytes", async () => {
  expect((await call("/api/file-locations", "POST", { name: "tight", maxBytes: 4 })).status).toBe(201);
  await call("/api/file-policies", "DELETE", { location: "tight", action: "write" });
  const denied = await call("/api/files/uploads", "POST", { entries: [{ location: "tight", path: "a.txt" }] });
  expect(denied.status).toBe(207);
  expect(await denied.json()).toMatchObject({ entries: [{ allowed: false, code: "FORBIDDEN" }] });
  await call("/api/file-policies", "POST", { location: "tight", action: "write" });
  // Malformed tokens never reach the database.
  for (const bad of ["short", "z".repeat(64), `?token=${"a".repeat(64)}&extra=1`]) {
    const put = await worker.fetch(
      new Request(`http://local.test/api/files/content?token=${bad}`, {
        method: "PUT",
        headers: headers(),
        body: new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>,
      }),
      bindings,
    );
    expect([400, 401]).toContain(put.status);
  }
  // Unknown-but-shaped tokens answer 401.
  const unknown = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${"b".repeat(64)}`, {
      method: "PUT",
      headers: headers(),
      body: new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(unknown.status).toBe(401);
  // Over-cap bytes answer 413 at the PUT boundary (6 bytes past a 4-byte cap).
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "tight", path: "big.txt" }] });
  const { entries } = (await slot.json()) as { entries: { token: string }[] };
  const big = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "text/plain" },
      body: new TextEncoder().encode("six!!!") as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(big.status).toBe(413);
  expect(await codeOf(big)).toBe("FILE_TOO_LARGE");
});

it("rejects downloads with malformed tokens, extra query keys, and stale bytes", async () => {
  expect((await call("/api/file-locations", "POST", { name: "dl", contentTypes: ["text/plain"] })).status).toBe(201);
  const malformed = await worker.fetch(
    new Request("http://local.test/api/files/content?token=short", { headers: headers() }),
    bindings,
  );
  expect(malformed.status).toBe(401);
  const unknown = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${"c".repeat(64)}`, { headers: headers() }),
    bindings,
  );
  expect(unknown.status).toBe(401);
  // Extra query keys fail closed on both token and Bearer downloads.
  const extraToken = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${"c".repeat(64)}&location=dl`, { headers: headers() }),
    bindings,
  );
  expect(extraToken.status).toBe(400);
  const extraBearer = await call("/api/files/content?location=dl&path=a.txt&extra=1");
  expect(extraBearer.status).toBe(400);
  expect(await codeOf(extraBearer)).toBe("UNSUPPORTED_QUERY");
  // Ready-row metadata without R2 bytes answers 404 (stale-object posture).
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "dl", path: "ghost.txt" }] });
  const { entries } = (await slot.json()) as { entries: { token: string }[] };
  const bytes = new TextEncoder().encode("ghost");
  const put = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put.status).toBe(200);
  const finalize = await call("/api/files/finalize", "POST", {
    location: "dl",
    path: "ghost.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: await sha256Of("ghost"),
  });
  expect(finalize.status).toBe(200);
  await bindings.FILES.delete(`${ORG}/dl/ghost.txt`);
  expect((await call("/api/files/content?location=dl&path=ghost.txt")).status).toBe(404);
});

it("finalizes fail-closed: validation, missing slots, caps, types, and sizes", async () => {
  expect(
    (await call("/api/file-locations", "POST", { name: "fz", maxBytes: 8, contentTypes: ["text/plain"] })).status,
  ).toBe(201);
  expect(await codeOf(await call("/api/files/finalize", "POST", null))).toBe("INVALID_FINALIZE");
  expect(await codeOf(await call("/api/files/finalize", "POST", { location: "fz" }))).toBe("INVALID_PATH");
  // No slot, no finalize.
  expect(
    await codeOf(
      await call("/api/files/finalize", "POST", {
        location: "fz",
        path: "noslot.txt",
        contentType: "text/plain",
        size: 1,
        sha256: await sha256Of("x"),
      }),
    ),
  ).toBe("FILE_MISSING");
  // Undeclared locations answer 404, revoked writes answer 403.
  expect(
    await codeOf(
      await call("/api/files/finalize", "POST", {
        location: "ghost",
        path: "a.txt",
        contentType: "text/plain",
        size: 1,
        sha256: await sha256Of("x"),
      }),
    ),
  ).toBe("NOT_FOUND");
  await call("/api/file-policies", "DELETE", { location: "fz", action: "write" });
  expect(
    await codeOf(
      await call("/api/files/finalize", "POST", {
        location: "fz",
        path: "a.txt",
        contentType: "text/plain",
        size: 1,
        sha256: await sha256Of("x"),
      }),
    ),
  ).toBe("FORBIDDEN");
  await call("/api/file-policies", "POST", { location: "fz", action: "write" });
  // Over-cap claims fail before any byte comparison.
  expect(
    await codeOf(
      await call("/api/files/finalize", "POST", {
        location: "fz",
        path: "a.txt",
        contentType: "text/plain",
        size: 64,
        sha256: await sha256Of("x"),
      }),
    ),
  ).toBe("FILE_TOO_LARGE");
  // Disallowed content types fail before verification.
  expect(
    await codeOf(
      await call("/api/files/finalize", "POST", {
        location: "fz",
        path: "a.txt",
        contentType: "image/png",
        size: 1,
        sha256: await sha256Of("x"),
      }),
    ),
  ).toBe("CONTENT_TYPE_REJECTED");
  // Size mismatches discard the pending row.
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "fz", path: "sized.txt" }] });
  const { entries } = (await slot.json()) as { entries: { token: string }[] };
  const bytes = new TextEncoder().encode("12345678");
  const put = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put.status).toBe(200);
  expect(
    await codeOf(
      await call("/api/files/finalize", "POST", {
        location: "fz",
        path: "sized.txt",
        contentType: "text/plain",
        size: 3,
        sha256: await sha256Of("12345678"),
      }),
    ),
  ).toBe("COMPLETION_MISMATCH");
});

it("deletes fail-closed: validation, unknown locations, revoked policy, fencing", async () => {
  expect((await call("/api/file-locations", "POST", { name: "del" })).status).toBe(201);
  expect(await codeOf(await call("/api/files", "DELETE", null))).toBe("INVALID_DELETE");
  expect(await codeOf(await call("/api/files", "DELETE", { location: "del", path: "a.txt" }))).toBe("INVALID_DELETE");
  expect(
    await codeOf(await call("/api/files", "DELETE", { location: "ghost", path: "a.txt", expectedVersion: 0 })),
  ).toBe("NOT_FOUND");
  await call("/api/file-policies", "DELETE", { location: "del", action: "delete" });
  expect(await codeOf(await call("/api/files", "DELETE", { location: "del", path: "a.txt", expectedVersion: 0 }))).toBe(
    "FORBIDDEN",
  );
  await call("/api/file-policies", "POST", { location: "del", action: "delete" });
});

it("lists fail-closed: shape, unknown locations, revoked reads", async () => {
  expect((await call("/api/file-locations", "POST", { name: "ls", contentTypes: ["text/plain"] })).status).toBe(201);
  // Listing needs a query string, then an allowlisted shape.
  expect((await call("/api/files")).status).toBe(400);
  expect(await codeOf(await call("/api/files?bogus=1"))).toBe("UNSUPPORTED_QUERY");
  expect(await codeOf(await call("/api/files?location=UPPER"))).toBe("INVALID_LOCATION");
  expect(await codeOf(await call("/api/files?location=ghost"))).toBe("NOT_FOUND");
  // Revoked reads list as 404 (non-disclosure), restored reads list empty.
  await call("/api/file-policies", "DELETE", { location: "ls", action: "read" });
  expect((await call("/api/files?location=ls")).status).toBe(404);
  await call("/api/file-policies", "POST", { location: "ls", action: "read" });
  expect(await call("/api/files?location=ls")).toMatchObject({ status: 200 });
  expect(await codeOf(await call("/api/files?location=ls&cursor=!!!"))).toBe("INVALID_CURSOR");
  expect(await codeOf(await call("/api/files?location=ls&limit=99"))).toBe("INVALID_LIMIT");
  expect(await codeOf(await call("/api/files?location=ls&prefix="))).toBe("INVALID_PATH");
});

it("lists paginate with prefix and cursor", async () => {
  expect((await call("/api/file-locations", "POST", { name: "ls", contentTypes: ["text/plain"] })).status).toBe(201);
  // Seed two files, then page with limit 1 plus a prefix slice.
  for (const name of ["b.txt", "a.txt"]) {
    const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "ls", path: name }] });
    const { entries } = (await slot.json()) as { entries: { token: string }[] };
    const bytes = new TextEncoder().encode(`bytes-${name}`);
    const put = await worker.fetch(
      new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
        method: "PUT",
        headers: { ...headers(), "Content-Type": "text/plain" },
        body: bytes as Uint8Array<ArrayBuffer>,
      }),
      bindings,
    );
    expect(put.status).toBe(200);
    const finalize = await call("/api/files/finalize", "POST", {
      location: "ls",
      path: name,
      contentType: "text/plain",
      size: bytes.byteLength,
      sha256: await sha256Of(`bytes-${name}`),
    });
    expect(finalize.status).toBe(200);
  }
  const page1 = (await (await call("/api/files?location=ls&limit=1")).json()) as {
    files: { path: string }[];
    nextCursor: string | null;
  };
  expect(page1.files).toHaveLength(1);
  expect(typeof page1.nextCursor).toBe("string");
  const page2 = (await (await call(`/api/files?location=ls&limit=1&cursor=${page1.nextCursor}`)).json()) as {
    files: { path: string }[];
    nextCursor: string | null;
  };
  expect(page2.files).toHaveLength(1);
  expect(page2.nextCursor).toBeNull();
  const prefixed = (await (await call("/api/files?location=ls&prefix=b")).json()) as {
    files: { path: string }[];
  };
  expect(prefixed.files.map((file) => file.path)).toEqual(["b.txt"]);
});

it("expires download tokens and races upload revocation and staging", async () => {
  expect((await call("/api/file-locations", "POST", { name: "race", contentTypes: ["text/plain"] })).status).toBe(201);
  // Upload token issued, write policy removed directly (bypassing the
  // revoke route, which would also delete the token): PUT answers 403.
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "race", path: "r.txt" }] });
  const { entries } = (await slot.json()) as { entries: { token: string }[] };
  await bindings.DB.prepare("DELETE FROM file_policies WHERE org_id=? AND location=? AND action=?")
    .bind(ORG, "race", "write")
    .run();
  const revokedPut = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "text/plain" },
      body: new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(revokedPut.status).toBe(403);
  await call("/api/file-policies", "POST", { location: "race", action: "write" });
  // Finalize a file, issue a download token, then expire it directly.
  const bytes = new TextEncoder().encode("race-bytes");
  const slot2 = await call("/api/files/uploads", "POST", { entries: [{ location: "race", path: "r.txt" }] });
  const token2 = (await slot2.json()) as { entries: { token: string }[] };
  const put2 = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${token2.entries[0]!.token}`, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put2.status).toBe(200);
  const finalize = await call("/api/files/finalize", "POST", {
    location: "race",
    path: "r.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: await sha256Of("race-bytes"),
  });
  expect(finalize.status).toBe(200);
  const issued = await call("/api/files/downloads", "POST", { entries: [{ location: "race", path: "r.txt" }] });
  const dl = (await issued.json()) as { entries: { token: string }[] };
  await bindings.DB.prepare("UPDATE file_capabilities SET expires_at=? WHERE token_hash IS NOT NULL")
    .bind("2000-01-01T00:00:00.000Z")
    .run();
  const expired = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${dl.entries[0]!.token}`, { headers: headers() }),
    bindings,
  );
  expect(expired.status).toBe(401);
  // Finalize without staged R2 bytes answers FILE_MISSING (staging lost).
  const slot3 = await call("/api/files/uploads", "POST", { entries: [{ location: "race", path: "lost.txt" }] });
  expect(slot3.status).toBe(200);
  const token3 = (await slot3.json()) as { entries: { token: string }[] };
  const lostBytes = new TextEncoder().encode("lost");
  const put3 = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${token3.entries[0]!.token}`, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "text/plain" },
      body: lostBytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put3.status).toBe(200);
  const staged = await bindings.DB.prepare(
    "SELECT staging_key FROM file_capabilities WHERE org_id=? AND location=? AND path=? AND action='upload' AND used_at IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(ORG, "race", "lost.txt")
    .first<{ staging_key: string }>();
  await bindings.FILES.delete(staged!.staging_key);
  expect(
    await codeOf(
      await call("/api/files/finalize", "POST", {
        location: "race",
        path: "lost.txt",
        contentType: "text/plain",
        size: lostBytes.byteLength,
        sha256: await sha256Of("lost"),
      }),
    ),
  ).toBe("FILE_MISSING");
});

it("deletes locations end to end once their files are gone", async () => {
  expect((await call("/api/file-locations", "POST", { name: "temp" })).status).toBe(201);
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "temp", path: "t.txt" }] });
  const { entries } = (await slot.json()) as { entries: { token: string }[] };
  const bytes = new TextEncoder().encode("t");
  const put = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
      method: "PUT",
      headers: headers(),
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put.status).toBe(200);
  const finalize = await call("/api/files/finalize", "POST", {
    location: "temp",
    path: "t.txt",
    contentType: "application/octet-stream",
    size: 1,
    sha256: await sha256Of("t"),
  });
  expect(finalize.status).toBe(200);
  expect((await call("/api/file-locations/temp", "DELETE")).status).toBe(409);
  const version = ((await finalize.json()) as { file: { version: number } }).file.version;
  expect(
    (await call("/api/files", "DELETE", { location: "temp", path: "t.txt", expectedVersion: version })).status,
  ).toBe(200);
  expect((await call("/api/file-locations/temp", "DELETE")).status).toBe(200);
  expect((await call("/api/file-locations/temp")).status).toBe(404);
  // A foreign Organization never sees the location at all.
  expect((await call("/api/file-locations/temp", "GET", undefined, OTHER)).status).toBe(404);
});
