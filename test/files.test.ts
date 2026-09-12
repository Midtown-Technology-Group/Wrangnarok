// SPDX-License-Identifier: AGPL-3.0
// Managed file locations (FILE-01, issue #157; ADR 018): declared
// locations, policy-checked proxy upload/download, finalize-after-upload
// verification, versioned mutation, revocation, and the bounded shared
// read-only fallback. Proven against real local D1 + real local R2 in
// workerd; the FILES binding is never replaced. Applies migrations 0001 +
// 0019 so the file schema composes with the existing tables.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration19 from "../migrations/0019_files.sql?raw";
import migrationOrg from "../migrations/0007_org_membership.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createLocation(name = "uploads", extra: Record<string, unknown> = {}) {
  const response = await call("/api/file-locations", "POST", { name, ...extra });
  expect(response.status).toBe(201);
  return ((await response.json()) as { location: { name: string } }).location;
}

async function uploadRoundtrip(
  orgId: string,
  location: string,
  path: string,
  content: string,
  contentType = "text/plain",
): Promise<{ size: number; sha256: string; version: number }> {
  const bytes = new TextEncoder().encode(content);
  const digest = await sha256Hex(bytes);
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location, path }] }, orgId);
  expect(slot.status).toBe(200);
  const { entries: slotEntries } = (await slot.json()) as { entries: { token: string }[] };
  const put = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${slotEntries[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": contentType },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    { ...bindings, LAB_ORG_ID: orgId },
  );
  expect(put.status).toBe(200);
  const finalize = await call(
    "/api/files/finalize",
    "POST",
    { location, path, contentType, size: bytes.byteLength, sha256: digest },
    orgId,
  );
  expect(finalize.status).toBe(200);
  const { file } = (await finalize.json()) as {
    file: { size: number; sha256: string; version: number };
  };
  expect(file.size).toBe(bytes.byteLength);
  expect(file.sha256).toBe(digest);
  return { size: file.size, sha256: file.sha256, version: file.version };
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

it("declares a location with minted policies, then lists it", async () => {
  await createLocation("uploads", { maxBytes: 1024, contentTypes: ["text/plain"] });
  const listed = await call("/api/file-locations");
  expect(await listed.json()).toMatchObject({
    locations: [{ name: "uploads", maxBytes: 1024, contentTypes: ["text/plain"], sharedRead: false }],
  });
  const detail = await call("/api/file-locations/uploads");
  expect(await detail.json()).toMatchObject({
    location: { name: "uploads" },
    policies: [{ action: "delete" }, { action: "read" }, { action: "write" }],
  });
  const duplicate = await call("/api/file-locations", "POST", { name: "uploads" });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: "LOCATION_CONFLICT" } });
});

it("runs the slot, PUT, finalize, GET roundtrip on real R2", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  const { size, sha256, version } = await uploadRoundtrip(ORG, "uploads", "notes/hello.txt", "hello files");
  expect(version).toBe(1);
  const get = await call("/api/files/content?location=uploads&path=notes/hello.txt");
  expect(get.status).toBe(200);
  expect(get.headers.get("Content-Type")).toBe("text/plain");
  expect(get.headers.get("Content-Length")).toBe(String(size));
  expect(get.headers.get("ETag")).toBe(`"${sha256}"`);
  expect(get.headers.get("X-File-Version")).toBe("1");
  expect(await get.text()).toBe("hello files");
  // The R2 key is org-namespaced: bytes land under <org>/<location>/<path>.
  const stored = await bindings.FILES.get(`${ORG}/uploads/notes/hello.txt`);
  expect(stored).not.toBeNull();
  expect(await stored!.text()).toBe("hello files");
});

it("rejects completion mismatches and deletes the pending row", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  const bytes = new TextEncoder().encode("actual bytes");
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path: "a.txt" }] });
  const { entries: slotEntries } = (await slot.json()) as { entries: { token: string }[] };
  const put = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${slotEntries[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put.status).toBe(200);
  const wrongDigest = "0".repeat(64);
  const finalize = await call("/api/files/finalize", "POST", {
    location: "uploads",
    path: "a.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: wrongDigest,
  });
  expect(finalize.status).toBe(409);
  expect(await finalize.json()).toMatchObject({ error: { code: "COMPLETION_MISMATCH" } });
  const listed = await call("/api/files?location=uploads");
  expect(await listed.json()).toEqual({ files: [], nextCursor: null });
  const missing = await call("/api/files/content?location=uploads&path=a.txt");
  expect(missing.status).toBe(404);
});

it("rejects traversal, undeclared locations, and mismatched content types", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  for (const path of ["../escape.txt", "a//b.txt", "/abs.txt", "a/./b.txt", "a\\b.txt"]) {
    const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path }] });
    expect(slot.status).toBe(400);
    expect(await slot.json()).toMatchObject({ error: { code: "INVALID_PATH" } });
  }
  const undeclared = await call("/api/files/uploads", "POST", { entries: [{ location: "nope", path: "a.txt" }] });
  expect(undeclared.status).toBe(207);
  expect(await undeclared.json()).toMatchObject({ entries: [{ allowed: false, code: "NOT_FOUND" }] });
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path: "img.bin" }] });
  const { entries: slotEntries } = (await slot.json()) as { entries: { token: string }[] };
  const put = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${slotEntries[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
      body: new TextEncoder().encode("x") as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put.status).toBe(415);
  expect(await put.json()).toMatchObject({ error: { code: "CONTENT_TYPE_REJECTED" } });
});

it("keeps foreign-organization reads at 404 and scoped lists tenant-local", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  await uploadRoundtrip(ORG, "uploads", "secret.txt", "org one bytes");
  const foreign = await call("/api/files/content?location=uploads&path=secret.txt", "GET", undefined, OTHER_ORG);
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  const foreignList = await call("/api/files?location=uploads", "GET", undefined, OTHER_ORG);
  expect(foreignList.status).toBe(404);
  const ownList = await call("/api/files?location=uploads");
  expect(await ownList.json()).toMatchObject({ files: [{ path: "secret.txt", status: "ready" }] });
});

it("serves the bounded shared read-only fallback without leaking enumeration", async () => {
  await createLocation("shared", { contentTypes: ["text/plain"], sharedRead: true });
  await uploadRoundtrip(ORG, "shared", "pub.txt", "shared bytes");
  await createLocation("other", { contentTypes: ["text/plain"] });
  const foreign = await call("/api/files/content?location=shared&path=pub.txt", "GET", undefined, OTHER_ORG);
  // OTHER_ORG has no same-named location and no read policy: still 404.
  expect(foreign.status).toBe(404);
  await call("/api/file-locations", "POST", { name: "shared", contentTypes: ["text/plain"] }, OTHER_ORG, OTHER_USER);
  const sharedRead = await call("/api/files/content?location=shared&path=pub.txt", "GET", undefined, OTHER_ORG);
  expect(sharedRead.status).toBe(200);
  expect(await sharedRead.text()).toBe("shared bytes");
  // Enumeration never crosses: the reader's own list is empty.
  const foreignList = await call("/api/files?location=shared", "GET", undefined, OTHER_ORG);
  expect(await foreignList.json()).toEqual({ files: [], nextCursor: null });
  // Writes never cross: the reader cannot overwrite the shared object.
  const overwrite = await call(
    "/api/files/finalize",
    "POST",
    { location: "shared", path: "pub.txt", contentType: "text/plain", size: 1, sha256: "1".repeat(64) },
    OTHER_ORG,
  );
  expect(overwrite.status).not.toBe(200);
});

it("versions overwrites and deletes with conflict fencing", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  const first = await uploadRoundtrip(ORG, "uploads", "doc.txt", "version one");
  expect(first.version).toBe(1);
  // Finalizing an overwrite without a version fences with VERSION_CONFLICT.
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path: "doc.txt" }] });
  const { entries: slotEntries } = (await slot.json()) as { entries: { token: string }[] };
  const bytes = new TextEncoder().encode("version two");
  const put = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${slotEntries[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put.status).toBe(200);
  const unversioned = await call("/api/files/finalize", "POST", {
    location: "uploads",
    path: "doc.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  });
  expect(unversioned.status).toBe(409);
  expect(await unversioned.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
  const slot2 = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path: "doc.txt" }] });
  const { entries: slotEntries2 } = (await slot2.json()) as { entries: { token: string }[] };
  const put2 = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${slotEntries2[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(put2.status).toBe(200);
  const stale = await call("/api/files/finalize", "POST", {
    location: "uploads",
    path: "doc.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    expectedVersion: 7,
  });
  expect(stale.status).toBe(409);
  const overwrite = await call("/api/files/finalize", "POST", {
    location: "uploads",
    path: "doc.txt",
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    expectedVersion: 1,
  });
  expect(overwrite.status).toBe(200);
  expect(await overwrite.json()).toMatchObject({ file: { version: 2 } });
  const get = await call("/api/files/content?location=uploads&path=doc.txt");
  expect(await get.text()).toBe("version two");
  // Deletes fence on the version: stale expectations conflict, missing rows
  // answer FILE_MISSING, and the R2 bytes are removed on success.
  const staleDelete = await call("/api/files", "DELETE", {
    location: "uploads",
    path: "doc.txt",
    expectedVersion: 1,
  });
  expect(staleDelete.status).toBe(409);
  expect(await staleDelete.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
  const gone = await call("/api/files", "DELETE", { location: "uploads", path: "nope.txt", expectedVersion: 0 });
  expect(gone.status).toBe(409);
  expect(await gone.json()).toMatchObject({ error: { code: "FILE_MISSING" } });
  const deleted = await call("/api/files", "DELETE", { location: "uploads", path: "doc.txt", expectedVersion: 2 });
  expect(deleted.status).toBe(200);
  expect(await bindings.FILES.get(`${ORG}/uploads/doc.txt`)).toBeNull();
  expect((await call("/api/files/content?location=uploads&path=doc.txt")).status).toBe(404);
});

it("refuses new URLs after policy revocation and invalidates issued tokens", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  await uploadRoundtrip(ORG, "uploads", "rev.txt", "revocable");
  const issued = await call("/api/files/downloads", "POST", { entries: [{ location: "uploads", path: "rev.txt" }] });
  const { entries: issuedEntries } = (await issued.json()) as { entries: { token: string }[] };
  const before = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${issuedEntries[0]!.token}`, {
      headers: headers(),
    }),
    bindings,
  );
  expect(before.status).toBe(200);
  const revoked = await call("/api/file-policies", "DELETE", { location: "uploads", action: "read" });
  expect(revoked.status).toBe(200);
  // The already-issued token stops working at revocation time, not at
  // expiry. Revocation deletes the token row, so the token is unknown (401),
  // never a bearer leak or a disclosed distinguisher.
  const after = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${issuedEntries[0]!.token}`, {
      headers: headers(),
    }),
    bindings,
  );
  expect(after.status).toBe(401);
  // New issuance refuses immediately, and Bearer reads go 404 too.
  const reissue = await call("/api/files/downloads", "POST", { entries: [{ location: "uploads", path: "rev.txt" }] });
  expect(reissue.status).toBe(207);
  expect(await reissue.json()).toMatchObject({ entries: [{ allowed: false }] });
  expect((await call("/api/files/content?location=uploads&path=rev.txt")).status).toBe(404);
  // The access-test endpoint reports the same denial without issuing anything.
  const tested = await call("/api/file-policies/test", "POST", {
    location: "uploads",
    path: "rev.txt",
    action: "read",
  });
  expect(await tested.json()).toEqual({ access: { allowed: false, reason: "no read policy" } });
  // Re-granting restores access.
  const granted = await call("/api/file-policies", "POST", { location: "uploads", action: "read" });
  expect(granted.status).toBe(201);
  expect((await call("/api/files/content?location=uploads&path=rev.txt")).status).toBe(200);
});

it("issues bounded batches with per-path allow/deny and bounded expiry", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  const batch = await call("/api/files/uploads", "POST", {
    entries: [
      { location: "uploads", path: "ok.txt" },
      { location: "missing", path: "no.txt" },
    ],
  });
  expect(batch.status).toBe(207);
  expect(await batch.json()).toMatchObject({
    entries: [
      { path: "ok.txt", allowed: true },
      { path: "no.txt", allowed: false, code: "NOT_FOUND" },
    ],
  });
  const badExpiry = await call("/api/files/uploads", "POST", {
    entries: [{ location: "uploads", path: "ok.txt", expiresIn: 1_000_000 }],
  });
  expect(badExpiry.status).toBe(400);
  expect(await badExpiry.json()).toMatchObject({ error: { code: "INVALID_EXPIRY" } });
  const empty = await call("/api/files/uploads", "POST", { entries: [] });
  expect(empty.status).toBe(400);
  expect(await empty.json()).toMatchObject({ error: { code: "INVALID_BATCH" } });
});

it("single-use upload tokens reject replays and bare Bearer PUTs", async () => {
  await createLocation("uploads", { contentTypes: ["text/plain"] });
  const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path: "once.txt" }] });
  const { entries: slotEntries } = (await slot.json()) as { entries: { token: string }[] };
  const first = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${slotEntries[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: new TextEncoder().encode("one") as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(first.status).toBe(200);
  const replay = await worker.fetch(
    new Request(`http://local.test/api/files/content?token=${slotEntries[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: new TextEncoder().encode("two") as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(replay.status).toBe(401);
  const bare = await worker.fetch(
    new Request("http://local.test/api/files/content", {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: new TextEncoder().encode("three") as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
  expect(bare.status).toBe(400);
});
