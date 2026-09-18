// SPDX-License-Identifier: AGPL-3.0
// Session-owned uploads for external form sessions (EMBED-01 slice 3,
// issue #156): a startup session stages bytes into its form field's
// declared FILE-01 location and submits references to exactly what it
// staged. Proven end to end on the real local runtime (workerd D1 + R2;
// no operator session on any session-upload route). Applies the shared
// harness migrations plus 0035, 0036, and 0040.
//
// Covers the slice acceptance: allowed upload + submit per external
// class, foreign-session and operator-file traversal (422
// FILE_NOT_SESSION_OWNED), unknown origin / wrong secret / unknown grant
// at issuance, revocation killing issuance and finalize with no grace,
// capability drift failing issuance closed until rotation/review,
// replayed tokens, mismatched finalize assertions, field size/type
// bounds, the per-session issuance cap, and cross-class session
// confusion in both directions.
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import { useWorkflowHarness } from "./helpers/workflow-harness";
import {
  assertSessionOwnedFileRefs,
  countSessionUploads,
  loadSessionUploads,
  mintSessionUploadPath,
  parseSessionUploadField,
  recordSessionUpload,
  sessionUploadKey,
  SESSION_UPLOADS_MAX,
} from "../src/session-uploads";
import type { FormField } from "../src/forms";
import migration35 from "../migrations/0035_embeds.sql?raw";
import migration36 from "../migrations/0036_anon_app_embeds.sql?raw";
import migration40 from "../migrations/0040_session_uploads.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const MEMBER = "00000000-0000-4000-8000-000000000003";
const ORG_B = "00000000-0000-4000-8000-000000000009";
const ORIGIN = "https://portal.example.com";
const OTHER_ORIGIN = "https://evil.example.net";

const FILE_FIELDS = [
  { name: "name", type: "text", required: true },
  // Optional so a file-free submit proves session dispatch health (202)
  // while the owned-reference submits prove the file gate itself; FORM-02
  // requiredness is covered by the lifecycle suite.
  { name: "doc", type: "file", required: false, file: { location: "uploads", maxMb: 1, contentTypes: ["text/plain"] } },
];

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

/** Authenticated operator call. The LAB fixture identity bootstraps to admin
 * of ORG; MEMBER holds an ordinary membership. */
function call(path: string, method = "GET", body?: unknown, orgId = ORG, userId?: string) {
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      ...bindings,
      LAB_ORG_ID: orgId,
      LAB_FIXTURE_USER_ID: OWNER,
      ...(userId ? { LAB_USER_ID: userId } : {}),
    },
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Pre-gate signed-embed upload issuance: secret + Origin, no session. */
function issueEmbedUpload(grantId: string, secret: string | null, origin: string | null, body: unknown) {
  const heads: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) heads["X-Embed-Secret"] = secret;
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(
    new Request(`https://local.test/api/embeds/${grantId}/uploads`, {
      method: "POST",
      headers: heads,
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

/** Pre-gate anonymous upload issuance: publication ID only, no session. */
function issuePublicUpload(pubId: string, body: unknown) {
  return worker.fetch(
    new Request(`https://local.test/api/public/${pubId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

/** Pre-gate session byte PUT: the single-use token is the whole credential
 * (deliberately no Authorization header — external hosts hold none). */
function sessionPut(token: string, bytes: Uint8Array, contentType: string, extraQuery = "") {
  return worker.fetch(
    new Request(`https://local.test/api/session-uploads/content?token=${token}${extraQuery}`, {
      method: "PUT",
      headers: { "Content-Type": contentType, Origin: ORIGIN },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    bindings,
  );
}

/** Pre-gate session finalize: handle + assertions, no session. */
function sessionFinalize(body: unknown, origin: string | null = ORIGIN) {
  const heads: Record<string, string> = { "Content-Type": "application/json" };
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(
    new Request("https://local.test/api/session-uploads/finalize", {
      method: "POST",
      headers: heads,
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

/** Pre-gate embed bootstrap + submit (mirrors the slice-1 harness). */
function bootstrap(grantId: string, secret: string | null, origin: string | null, body: unknown = {}) {
  const heads: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) heads["X-Embed-Secret"] = secret;
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(
    new Request(`https://local.test/api/embeds/${grantId}/startup`, {
      method: "POST",
      headers: heads,
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

function embedSubmit(body: unknown, origin: string | null, key: string) {
  const heads: Record<string, string> = { "Content-Type": "application/json", "Idempotency-Key": key };
  if (origin !== null) heads["Origin"] = origin;
  return worker.fetch(
    new Request("https://local.test/api/embeds/submit", { method: "POST", headers: heads, body: JSON.stringify(body) }),
    bindings,
  );
}

function publicStartup(pubId: string, body: unknown = {}) {
  return worker.fetch(
    new Request(`https://local.test/api/public/${pubId}/startup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

function publicSubmit(body: unknown, key: string) {
  return worker.fetch(
    new Request("https://local.test/api/public/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key, Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    bindings,
  );
}

const keyFor = (name: string): string => `session-upload-test-key-${name}`;

async function createForm(name: string, fields: unknown[] = FILE_FIELDS): Promise<void> {
  const response = await call("/api/forms", "POST", { name, sagaId: helloSaga.id, fields });
  expect(response.status).toBe(201);
}

async function createGrant(formName: string): Promise<{ id: string; secret: string }> {
  const response = await call(`/api/forms/${formName}/embeds`, "POST", { allowedOrigins: [ORIGIN] });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { grant: { id: string }; secret: string };
  return { id: body.grant.id, secret: body.secret };
}

async function publish(formName: string): Promise<{ id: string }> {
  const response = await call(`/api/forms/${formName}/publication`, "POST", {});
  expect(response.status).toBe(201);
  return ((await response.json()) as { publication: { id: string } }).publication;
}

async function bootstrapOk(grant: { id: string; secret: string }): Promise<{ handle: string }> {
  const response = await bootstrap(grant.id, grant.secret, ORIGIN);
  expect(response.status).toBe(201);
  return (await response.json()) as { handle: string };
}

interface IssuedSlot {
  location: string;
  path: string;
  token: string;
  expiresAt: string;
  maxBytes: number;
}

async function issueOk(
  issuer: "embed" | "public",
  id: string,
  secret: string | null,
  handle: string,
  location = "uploads",
  maxBytes = 1024 * 1024,
): Promise<IssuedSlot> {
  const response =
    issuer === "embed"
      ? await issueEmbedUpload(id, secret, ORIGIN, { handle, field: "doc" })
      : await issuePublicUpload(id, { handle, field: "doc" });
  expect(response.status).toBe(201);
  const slot = (await response.json()) as IssuedSlot;
  expect(slot.location).toBe(location);
  expect(slot.path.startsWith("session-uploads/")).toBe(true);
  expect(slot.token).toMatch(/^[a-f0-9]{64}$/);
  expect(slot.maxBytes).toBe(maxBytes);
  return slot;
}

async function putOk(slot: IssuedSlot, content: string): Promise<{ size: number; sha256: string }> {
  const bytes = new TextEncoder().encode(content);
  const digest = await sha256Hex(bytes);
  const put = await sessionPut(slot.token, bytes, "text/plain");
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ staged: true, size: bytes.byteLength });
  return { size: bytes.byteLength, sha256: digest };
}

async function finalizeOk(handle: string, slot: IssuedSlot, asserted: { size: number; sha256: string }): Promise<void> {
  const finalize = await sessionFinalize({
    handle,
    location: slot.location,
    path: slot.path,
    contentType: "text/plain",
    size: asserted.size,
    sha256: asserted.sha256,
  });
  expect(finalize.status).toBe(200);
  expect(await finalize.json()).toMatchObject({ finalized: true, location: slot.location, path: slot.path });
}

async function executionCount(): Promise<number> {
  const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
  return row?.n ?? -1;
}

useWorkflowHarness(bindings.DB);

beforeEach(async () => {
  await bindings.DB.exec(migration35);
  await bindings.DB.exec(migration36);
  await bindings.DB.exec(migration40);
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(ORG_B, "Org B")
    .run();
  for (const userId of [MEMBER, OWNER]) {
    await bindings.DB.prepare(
      "INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT DO NOTHING",
    )
      .bind(userId, stamp)
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
  )
    .bind(ORG, MEMBER, "member", "active", "ordinary", stamp, stamp)
    .run();
  // External dispatch must never reach a vendor: any fetch is a traversal bug.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("session-upload dispatch must not fetch");
  });
});

it("parses session-upload fields and keys without touching D1", () => {
  const fields = FILE_FIELDS as unknown as FormField[];
  const parsed = parseSessionUploadField(fields, "doc");
  expect(parsed).toMatchObject({ field: "doc", location: "uploads", maxBytes: 1024 * 1024 });
  expect(parsed.contentTypes).toEqual(["text/plain"]);
  expect(() => parseSessionUploadField(fields, "name")).toThrow(/not an uploadable file field/);
  expect(() => parseSessionUploadField(fields, "missing")).toThrow(/not an uploadable file field/);
  expect(() => parseSessionUploadField(fields, undefined)).toThrow(/name one declared file field/);
  const path = mintSessionUploadPath();
  expect(path.startsWith("session-uploads/")).toBe(true);
  expect(sessionUploadKey("uploads", "a/b")).toBe("uploads a/b");
  // Malformed shapes are the declaration validator's to reject, never
  // ownership-ok: only exact issued triples pass.
  try {
    assertSessionOwnedFileRefs([{ name: "doc", type: "file" }], { doc: { location: "x", path: "y" } }, new Map());
    expect.unreachable("foreign triple must refuse");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const fault = error as { code?: string; details?: { code?: string }[] };
    expect(fault.code).toBe("FORM_VALIDATION_FAILED");
    expect(fault.details?.[0]?.code).toBe("FILE_NOT_SESSION_OWNED");
  }
  assertSessionOwnedFileRefs([{ name: "doc", type: "file" }], { doc: null }, new Map());
  assertSessionOwnedFileRefs([{ name: "doc", type: "file" }], { doc: "garbage" }, new Map());
});

it("records and reloads session claims against D1", async () => {
  const before = await countSessionUploads(bindings.DB, "0".repeat(64));
  expect(before).toBe(0);
  await recordSessionUpload(bindings.DB, {
    sessionHash: "0".repeat(64),
    orgId: ORG,
    field: "doc",
    location: "uploads",
    path: "session-uploads/probe",
    maxBytes: 1024,
    contentTypes: ["text/plain"],
  });
  expect(await countSessionUploads(bindings.DB, "0".repeat(64))).toBe(1);
  const owned = await loadSessionUploads(bindings.DB, "0".repeat(64), ORG);
  expect(owned.get(sessionUploadKey("uploads", "session-uploads/probe"))).toMatchObject({ field: "doc" });
  expect(owned.get(sessionUploadKey("uploads", "session-uploads/other"))).toBeUndefined();
  // Claims never cross Organizations.
  expect((await loadSessionUploads(bindings.DB, "0".repeat(64), ORG_B)).size).toBe(0);
  // Corrupt claim metadata fails loud, never an empty ownership set.
  await bindings.DB.prepare(
    "INSERT INTO form_session_uploads(session_hash,org_id,location,path,field,max_bytes,content_types_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("1".repeat(64), ORG, "uploads", "session-uploads/bad", "doc", 8, "not-json", new Date().toISOString())
    .run();
  await expect(loadSessionUploads(bindings.DB, "1".repeat(64), ORG)).rejects.toThrow(/invalid content-type/);
  await bindings.DB.prepare("DELETE FROM form_session_uploads WHERE session_hash=?").bind("1".repeat(64)).run();
  await bindings.DB.prepare(
    "INSERT INTO form_session_uploads(session_hash,org_id,location,path,field,max_bytes,content_types_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("1".repeat(64), ORG, "uploads", "session-uploads/bad", "doc", 8, '["ok",7]', new Date().toISOString())
    .run();
  await expect(loadSessionUploads(bindings.DB, "1".repeat(64), ORG)).rejects.toThrow(/invalid content-type/);
});

it("signed embed sessions stage and submit the file they own", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);
  const slot = await issueOk("embed", grant.id, grant.secret, started.handle);
  const asserted = await putOk(slot, "session-owned bytes");
  await finalizeOk(started.handle, slot, asserted);

  // The ready, session-owned reference passes the file gate; the hello
  // Saga then refuses the drifted declaration (file fields are not hello
  // inputs): 400 pins the file check ran first and passed, and nothing
  // dispatched.
  const before = await executionCount();
  const submit = await embedSubmit(
    { handle: started.handle, values: { name: "Ada", doc: { location: slot.location, path: slot.path } } },
    ORIGIN,
    keyFor("owned-embed"),
  );
  expect(submit.status).toBe(400);
  expect(await submit.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  expect(await executionCount()).toBe(before);

  // The same session submits file-free and dispatches: session submit
  // itself is healthy, only the Saga gate stood in the way above.
  const started2 = await bootstrapOk(grant);
  const clean = await embedSubmit(
    { handle: started2.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("owned-embed-2"),
  );
  expect(clean.status).toBe(202);
});

it("anonymous sessions stage and submit confirmation-only with no disclosure", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("flyer");
  const pub = await publish("flyer");
  const startup = await publicStartup(pub.id);
  expect(startup.status).toBe(201);
  const { handle } = (await startup.json()) as { handle: string };
  const slot = await issueOk("public", pub.id, null, handle);
  const asserted = await putOk(slot, "public bytes");
  await finalizeOk(handle, slot, asserted);

  const before = await executionCount();
  const submit = await publicSubmit(
    { handle, values: { name: "Bo", doc: { location: slot.location, path: slot.path } } },
    keyFor("owned-public"),
  );
  // Same split as the signed class: the file gate passes, the hello Saga
  // refuses, nothing dispatches — and the 400 carries no execution ID,
  // status URL, or history either way.
  expect(submit.status).toBe(400);
  const failed = (await submit.json()) as { error: { code: string } };
  expect(failed.error.code).toBe("INVALID_INPUT");
  expect(JSON.stringify(failed)).not.toContain("execution");
  expect(await executionCount()).toBe(before);
});

it("refuses foreign-session and operator-staged references on both submit paths", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const first = await createGrant("resume");
  const second = await createGrant("resume");
  const sessionA = await bootstrapOk(first);
  const slotA = await issueOk("embed", first.id, first.secret, sessionA.handle);
  const assertedA = await putOk(slotA, "session A bytes");
  await finalizeOk(sessionA.handle, slotA, assertedA);

  // Sibling session, same form, same org: the triple is real but not ours.
  const sessionB = await bootstrapOk(second);
  const before = await executionCount();
  const cross = await embedSubmit(
    { handle: sessionB.handle, values: { name: "Ada", doc: { location: slotA.location, path: slotA.path } } },
    ORIGIN,
    keyFor("cross-session"),
  );
  expect(cross.status).toBe(422);
  expect(JSON.stringify(await cross.json())).toContain("FILE_NOT_SESSION_OWNED");

  // Operator-staged bytes are real org files but carry no session claim.
  const operatorSlot = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path: "op.txt" }] });
  expect(operatorSlot.status).toBe(200);
  const { entries } = (await operatorSlot.json()) as { entries: { token: string }[] };
  const bytes = new TextEncoder().encode("operator bytes");
  const operatorPut = await worker.fetch(
    new Request(`https://local.test/api/files/content?token=${entries[0]!.token}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: bytes as Uint8Array<ArrayBuffer>,
    }),
    { ...bindings, LAB_ORG_ID: ORG },
  );
  expect(operatorPut.status).toBe(200);
  expect(
    (
      await call("/api/files/finalize", "POST", {
        location: "uploads",
        path: "op.txt",
        contentType: "text/plain",
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      })
    ).status,
  ).toBe(200);
  const operatorRef = await embedSubmit(
    { handle: sessionB.handle, values: { name: "Ada", doc: { location: "uploads", path: "op.txt" } } },
    ORIGIN,
    keyFor("operator-ref"),
  );
  expect(operatorRef.status).toBe(422);
  expect(JSON.stringify(await operatorRef.json())).toContain("FILE_NOT_SESSION_OWNED");

  // Anonymous submit enforces the identical verdict over the same triple.
  await createForm("flyer");
  const pub = await publish("flyer");
  const startup = await publicStartup(pub.id);
  const anonHandle = ((await startup.json()) as { handle: string }).handle;
  const anonDenied = await publicSubmit(
    { handle: anonHandle, values: { name: "Bo", doc: { location: slotA.location, path: slotA.path } } },
    keyFor("anon-cross"),
  );
  expect(anonDenied.status).toBe(422);
  expect(JSON.stringify(await anonDenied.json())).toContain("FILE_NOT_SESSION_OWNED");
  expect(await executionCount()).toBe(before);
});

it("denies issuance without a live grant, origin, session, or file field", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);

  const unknownGrant = "00000000-0000-4000-8000-00000000ffff";
  expect(
    (await issueEmbedUpload(unknownGrant, grant.secret, ORIGIN, { handle: started.handle, field: "doc" })).status,
  ).toBe(404);
  const wrongSecret = await issueEmbedUpload(grant.id, "0".repeat(64), ORIGIN, {
    handle: started.handle,
    field: "doc",
  });
  expect(wrongSecret.status).toBe(401);
  expect(await wrongSecret.json()).toMatchObject({ error: { code: "EMBED_UNAUTHORIZED" } });
  const foreignOrigin = await issueEmbedUpload(grant.id, grant.secret, OTHER_ORIGIN, {
    handle: started.handle,
    field: "doc",
  });
  expect(foreignOrigin.status).toBe(403);
  expect(await foreignOrigin.json()).toMatchObject({ error: { code: "EMBED_ORIGIN_DENIED" } });
  const staleHandle = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: "f".repeat(64), field: "doc" });
  expect(staleHandle.status).toBe(422);
  expect(await staleHandle.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  const textField = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "name" });
  expect(textField.status).toBe(400);
  expect(await textField.json()).toMatchObject({ error: { code: "INVALID_UPLOAD" } });
  const missingField = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, {
    handle: started.handle,
    field: "nope",
  });
  expect(missingField.status).toBe(400);
  // A non-object issuance body presents no session at all.
  const arrayBody = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, ["doc"]);
  expect(arrayBody.status).toBe(422);
  expect(await arrayBody.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  // A deleted form blocks issuance (blocked publication): the grant
  // dangles and issuance answers 404 FORM_NOT_FOUND.
  expect((await call("/api/forms/resume", "DELETE")).status).toBe(200);
  const dangling = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "doc" });
  expect(dangling.status).toBe(404);
  expect(await dangling.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
});

it("fails issuance closed on capability drift until the admin rotates", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);

  const edited = await call("/api/forms/resume", "PUT", {
    sagaId: helloSaga.id,
    fields: [...FILE_FIELDS, { name: "nick", type: "text", required: false }],
  });
  expect(edited.status).toBe(200);
  const drifted = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "doc" });
  expect(drifted.status).toBe(409);
  expect(await drifted.json()).toMatchObject({ error: { code: "EMBED_CAPABILITY_CHANGED" } });

  const rotated = await call(`/api/forms/resume/embeds/${grant.id}/rotate`, "POST", {});
  expect(rotated.status).toBe(200);
  const fresh = ((await rotated.json()) as { secret: string }).secret;
  const healed = await bootstrapOk({ id: grant.id, secret: fresh });
  expect((await issueEmbedUpload(grant.id, fresh, ORIGIN, { handle: healed.handle, field: "doc" })).status).toBe(201);
});

it("fails anonymous issuance closed on drift, disable, and unknown links", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("flyer");
  const pub = await publish("flyer");
  const startup = await publicStartup(pub.id);
  const { handle } = (await startup.json()) as { handle: string };

  expect((await issuePublicUpload("00000000-0000-4000-8000-00000000ffff", { handle, field: "doc" })).status).toBe(404);
  const edited = await call("/api/forms/flyer", "PUT", {
    sagaId: helloSaga.id,
    fields: [...FILE_FIELDS, { name: "nick", type: "text", required: false }],
  });
  expect(edited.status).toBe(200);
  const drifted = await issuePublicUpload(pub.id, { handle, field: "doc" });
  expect(drifted.status).toBe(409);
  expect(await drifted.json()).toMatchObject({ error: { code: "PUBLICATION_STALE" } });

  const reviewed = await call("/api/forms/flyer/publication/review", "POST", { approve: true });
  expect(reviewed.status).toBe(200);
  const healed = await publicStartup(pub.id);
  expect(healed.status).toBe(201);
  const healedHandle = ((await healed.json()) as { handle: string }).handle;
  expect((await issuePublicUpload(pub.id, { handle: healedHandle, field: "doc" })).status).toBe(201);

  const disabled = await call("/api/forms/flyer/publication", "DELETE");
  expect(disabled.status).toBe(200);
  const blocked = await issuePublicUpload(pub.id, { handle: healedHandle, field: "doc" });
  expect(blocked.status).toBe(404);
  expect(await blocked.json()).toMatchObject({ error: { code: "FORM_NOT_PUBLISHED" } });
});

it("revocation kills issuance and finalize with no grace", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);
  const slot = await issueOk("embed", grant.id, grant.secret, started.handle);
  const asserted = await putOk(slot, "doomed bytes");

  expect((await call(`/api/forms/resume/embeds/${grant.id}/revoke`, "POST", {})).status).toBe(200);
  const revokedIssue = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "doc" });
  expect(revokedIssue.status).toBe(410);
  expect(await revokedIssue.json()).toMatchObject({ error: { code: "EMBED_REVOKED" } });
  const revokedFinalize = await sessionFinalize({
    handle: started.handle,
    location: slot.location,
    path: slot.path,
    contentType: "text/plain",
    size: asserted.size,
    sha256: asserted.sha256,
  });
  expect(revokedFinalize.status).toBe(422);
  expect(await revokedFinalize.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  const revokedSubmit = await embedSubmit(
    { handle: started.handle, values: { name: "Ada" } },
    ORIGIN,
    keyFor("revoked-submit"),
  );
  expect(revokedSubmit.status).toBe(422);
});

it("fails replayed tokens, mismatched assertions, and field bounds closed", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);
  const slot = await issueOk("embed", grant.id, grant.secret, started.handle);
  const bytes = new TextEncoder().encode("five!");
  const digest = await sha256Hex(bytes);

  // Garbage tokens never authenticate; the single-use token works once.
  expect((await sessionPut("0".repeat(64), bytes, "text/plain")).status).toBe(401);
  expect((await sessionPut(`${slot.token.slice(0, 63)}g`, bytes, "text/plain")).status).toBe(401);
  expect((await sessionPut(slot.token, bytes, "text/plain", "&other=1")).status).toBe(400);
  expect((await sessionPut(slot.token, bytes, "text/plain")).status).toBe(200);
  expect((await sessionPut(slot.token, bytes, "text/plain")).status).toBe(401);

  // A wrong digest fails finalize-after-upload verification, never a
  // promotion; the field bound (1 MB) rejects oversized assertions first.
  const tampered = await sessionFinalize({
    handle: started.handle,
    location: slot.location,
    path: slot.path,
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: "1".repeat(64),
  });
  expect(tampered.status).toBe(409);
  expect(await tampered.json()).toMatchObject({ error: { code: "COMPLETION_MISMATCH" } });
  const oversized = await sessionFinalize({
    handle: started.handle,
    location: slot.location,
    path: slot.path,
    contentType: "text/plain",
    size: 2 * 1024 * 1024,
    sha256: digest,
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({ error: { code: "FILE_TOO_LARGE" } });

  // Finalizing a triple this session never issued is traversal, not a
  // missing file — even when the triple names a real ready file.
  const foreign = await sessionFinalize({
    handle: started.handle,
    location: "uploads",
    path: "op.txt",
    contentType: "text/plain",
    size: 1,
    sha256: digest,
  });
  expect(foreign.status).toBe(422);
  expect(JSON.stringify(await foreign.json())).toContain("FILE_NOT_SESSION_OWNED");

  // Malformed finalize bodies never reach the claim check.
  expect((await sessionFinalize({ handle: started.handle })).status).toBe(400);
  // A well-formed claim without a handle presents no session; a foreign
  // origin fails the grant fence before any claim resolves.
  const handleless = await sessionFinalize({
    location: slot.location,
    path: slot.path,
    contentType: "text/plain",
    size: bytes.byteLength,
    sha256: digest,
  });
  expect(handleless.status).toBe(422);
  expect(await handleless.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  const foreignOrigin = await sessionFinalize(
    {
      handle: started.handle,
      location: slot.location,
      path: slot.path,
      contentType: "text/plain",
      size: bytes.byteLength,
      sha256: digest,
    },
    OTHER_ORIGIN,
  );
  expect(foreignOrigin.status).toBe(403);
  expect(await foreignOrigin.json()).toMatchObject({ error: { code: "EMBED_ORIGIN_DENIED" } });
});

it("rejects field type drift at finalize and staged-only refs at submit", async () => {
  expect(
    (
      await call("/api/file-locations", "POST", {
        name: "gallery",
        contentTypes: ["text/plain", "image/png"],
      })
    ).status,
  ).toBe(201);
  await createForm("typed", [
    { name: "name", type: "text", required: true },
    { name: "doc", type: "file", required: true, file: { location: "gallery", contentTypes: ["image/png"] } },
  ]);
  const grant = await createGrant("typed");
  const started = await bootstrapOk(grant);
  const issued = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "doc" });
  expect(issued.status).toBe(201);
  const slot = (await issued.json()) as IssuedSlot;
  const asserted = await putOk(slot, "png bytes, allegedly");
  // text/plain passes the location allowlist but not the field policy.
  const typed = await sessionFinalize({
    handle: started.handle,
    location: slot.location,
    path: slot.path,
    contentType: "text/plain",
    size: asserted.size,
    sha256: asserted.sha256,
  });
  expect(typed.status).toBe(415);
  expect(await typed.json()).toMatchObject({ error: { code: "CONTENT_TYPE_REJECTED" } });

  // A staged-but-never-finalized upload is not ready: the shared FILE-01
  // readiness check still fires past the ownership check.
  const started2 = await bootstrapOk(grant);
  const slot2 = await issueOk("embed", grant.id, grant.secret, started2.handle, "gallery", 25 * 1024 * 1024);
  await putOk(slot2, "pending bytes");
  const pending = await embedSubmit(
    { handle: started2.handle, values: { name: "Ada", doc: { location: slot2.location, path: slot2.path } } },
    ORIGIN,
    keyFor("pending-ref"),
  );
  expect(pending.status).toBe(422);
  expect(JSON.stringify(await pending.json())).toContain("FILE_NOT_READY");

  // The byte PUT enforces its own shape: wrong location types answer 415
  // and empty bodies answer 400 before anything stages.
  expect((await call("/api/file-locations", "POST", { name: "strict", contentTypes: ["text/plain"] })).status).toBe(
    201,
  );
  await createForm("strictform", [
    { name: "name", type: "text", required: true },
    { name: "doc", type: "file", required: false, file: { location: "strict" } },
  ]);
  const strictGrant = await createGrant("strictform");
  const strictStarted = await bootstrapOk(strictGrant);
  const strictSlot = await issueOk(
    "embed",
    strictGrant.id,
    strictGrant.secret,
    strictStarted.handle,
    "strict",
    25 * 1024 * 1024,
  );
  const strictBytes = new TextEncoder().encode("png bytes");
  expect((await sessionPut(strictSlot.token, strictBytes, "image/png")).status).toBe(415);
  const strictSlot2 = await issueOk(
    "embed",
    strictGrant.id,
    strictGrant.secret,
    strictStarted.handle,
    "strict",
    25 * 1024 * 1024,
  );
  const emptyPut = await worker.fetch(
    new Request(`https://local.test/api/session-uploads/content?token=${strictSlot2.token}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain", Origin: ORIGIN },
    }),
    bindings,
  );
  expect(emptyPut.status).toBe(400);
  expect(await emptyPut.json()).toMatchObject({ error: { code: "EMPTY_UPLOAD" } });
});

it("fails finalize and issuance closed when the form vanishes mid-flow", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);
  const slot = await issueOk("embed", grant.id, grant.secret, started.handle);
  await putOk(slot, "orphaned bytes");
  expect((await call("/api/forms/resume", "DELETE")).status).toBe(200);
  // Outstanding finalizes die stale (no grant re-bind possible); new
  // issuance names the dangling grant with 404.
  const orphaned = await sessionFinalize({
    handle: started.handle,
    location: slot.location,
    path: slot.path,
    contentType: "text/plain",
    size: 14,
    sha256: "3".repeat(64),
  });
  expect(orphaned.status).toBe(422);
  expect(await orphaned.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });

  await createForm("flyer");
  const pub = await publish("flyer");
  const startup = await publicStartup(pub.id);
  const anonHandle = ((await startup.json()) as { handle: string }).handle;
  const anonSlot = await issueOk("public", pub.id, null, anonHandle);
  await putOk(anonSlot, "orphaned public bytes");
  expect((await call("/api/forms/flyer", "DELETE")).status).toBe(200);
  const anonOrphaned = await sessionFinalize({
    handle: anonHandle,
    location: anonSlot.location,
    path: anonSlot.path,
    contentType: "text/plain",
    size: 21,
    sha256: "4".repeat(64),
  });
  expect(anonOrphaned.status).toBe(422);
  expect(await anonOrphaned.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  const anonIssuance = await issuePublicUpload(pub.id, { handle: anonHandle, field: "doc" });
  expect(anonIssuance.status).toBe(404);
  expect(await anonIssuance.json()).toMatchObject({ error: { code: "FORM_NOT_PUBLISHED" } });
});

it("caps issuance per session and never accepts foreign handle classes", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);
  for (let attempt = 0; attempt < SESSION_UPLOADS_MAX; attempt++) {
    const issued = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "doc" });
    expect(issued.status).toBe(201);
  }
  const capped = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "doc" });
  expect(capped.status).toBe(429);
  expect(await capped.json()).toMatchObject({ error: { code: "SESSION_UPLOAD_LIMIT" } });

  // Cross-class confusion in both directions: an anonymous handle is
  // stale on the signed finalize, and a signed handle is stale on the
  // anonymous finalize — the classes never accept each other's sessions.
  await createForm("flyer");
  const pub = await publish("flyer");
  const startup = await publicStartup(pub.id);
  const anonHandle = ((await startup.json()) as { handle: string }).handle;
  const anonSlot = await issuePublicUpload(pub.id, { handle: anonHandle, field: "doc" });
  expect(anonSlot.status).toBe(201);
  const anonTriple = (await anonSlot.json()) as IssuedSlot;
  const signedFinalizeOfAnon = await sessionFinalize({
    handle: started.handle,
    location: anonTriple.location,
    path: anonTriple.path,
    contentType: "text/plain",
    size: 1,
    sha256: "2".repeat(64),
  });
  expect(signedFinalizeOfAnon.status).toBe(422);
  expect(JSON.stringify(await signedFinalizeOfAnon.json())).toContain("FILE_NOT_SESSION_OWNED");
  const anonFinalizeOfSigned = await sessionFinalize(
    {
      handle: anonHandle,
      location: "uploads",
      path: "session-uploads/nowhere",
      contentType: "text/plain",
      size: 1,
      sha256: "2".repeat(64),
    },
    null,
  );
  expect(anonFinalizeOfSigned.status).toBe(422);
});

it("answers issuance preflights and stops slots when policy revokes", async () => {
  expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
  await createForm("resume");
  const grant = await createGrant("resume");
  const started = await bootstrapOk(grant);

  const preflight = await worker.fetch(
    new Request(`https://local.test/api/embeds/${grant.id}/uploads`, { method: "OPTIONS" }),
    bindings,
  );
  expect(preflight.status).toBe(204);
  const putPreflight = await worker.fetch(
    new Request("https://local.test/api/session-uploads/content", { method: "OPTIONS" }),
    bindings,
  );
  expect(putPreflight.status).toBe(204);

  // Revoking the location's write policy stops new issuance (403, the
  // FILE-01 verdict) and outstanding byte PUTs: revocation deletes the
  // outstanding capability rows, so the consumed token answers 401 — the
  // FILE-01 revocation posture, through a session slot.
  const slot = await issueOk("embed", grant.id, grant.secret, started.handle);
  expect((await call("/api/file-policies", "DELETE", { location: "uploads", action: "write" })).status).toBe(200);
  const denied = await issueEmbedUpload(grant.id, grant.secret, ORIGIN, { handle: started.handle, field: "doc" });
  expect(denied.status).toBe(403);
  const bytes = new TextEncoder().encode("late bytes");
  expect((await sessionPut(slot.token, bytes, "text/plain")).status).toBe(401);
});
