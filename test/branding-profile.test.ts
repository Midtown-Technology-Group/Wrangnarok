// SPDX-License-Identifier: AGPL-3.0
// Organization branding and own profile (UX-01 slice 1, issue #176):
// member-open branding reads, admin-only writes/reset/logo, safe public
// branding reads, caller-scoped profile/avatar, and logo/avatar type/size
// abuse. Proven against real local D1 + real local R2 in workerd; the
// FILES binding is never replaced. Applies migrations 0001 + 0007 + 0034.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { AVATAR_MAX_BYTES, deleteAvatar, profileAvatarKey, putAvatar } from "../src/profile";
import { BRANDING_LOGO_MAX_BYTES, brandingLogoKey, deleteLogo, putLogo, resetBranding } from "../src/branding";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration34 from "../migrations/0034_branding_profile.sql?raw";
import migrationOrg from "../migrations/0007_org_membership.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";
const ADMIN_USER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const STRANGER = "00000000-0000-4000-8000-000000000007";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

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
      LAB_FIXTURE_USER_ID: ADMIN_USER,
      ...(userId ? { LAB_USER_ID: userId } : {}),
    },
  );
}

function putBytes(
  path: string,
  bytes: Uint8Array | null,
  contentType: string | null,
  orgId = ORG,
  userId?: string,
  extra: Record<string, string> = {},
) {
  const requestHeaders: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, ...extra };
  if (contentType !== null) requestHeaders["Content-Type"] = contentType;
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method: "PUT",
      headers: requestHeaders,
      ...(bytes === null ? {} : { body: bytes as Uint8Array<ArrayBuffer> }),
    }),
    {
      ...bindings,
      LAB_ORG_ID: orgId,
      LAB_FIXTURE_USER_ID: ADMIN_USER,
      ...(userId ? { LAB_USER_ID: userId } : {}),
    },
  );
}

/** Minimal magic-valid image bytes per type (headers only + filler). */
function imageBytes(type: string): Uint8Array {
  const filler = new Array(32).fill(7);
  if (type === "image/png") return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...filler]);
  if (type === "image/jpeg") return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...filler]);
  if (type === "image/gif") return Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...filler]);
  if (type === "image/webp")
    return Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, ...filler]);
  throw new Error(`No fixture for ${type}.`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration34);
  await bindings.DB.exec(migrationOrg);
  // AUTH-01 membership gate: the LAB fixture identity bootstraps to admin
  // of ORG inside authenticate on first use. OTHER_USER holds an ordinary
  // membership; STRANGER holds none; OTHER_ORG stays unknown.
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

it("reads default branding for members before any customization", async () => {
  const response = await call("/api/branding", "GET", undefined, ORG, OTHER_USER);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    branding: {
      orgId: ORG,
      appName: "Wrangnarok",
      primaryColor: "#F45D0B",
      accentColor: "#F59E0B",
      logo: null,
      updatedAt: null,
    },
  });
});

it("lets admins write branding while members and strangers are denied", async () => {
  const write = await call("/api/branding", "PUT", {
    appName: "Acme Realm",
    primaryColor: "#112233",
    accentColor: "#445566",
  });
  expect(write.status).toBe(200);
  expect(await write.json()).toMatchObject({
    branding: { orgId: ORG, appName: "Acme Realm", primaryColor: "#112233", accentColor: "#445566", logo: null },
  });
  // Partial merge: colors-only keeps the name.
  const merged = await call("/api/branding", "PUT", { primaryColor: "#ABC", accentColor: "#112233AA" });
  expect(merged.status).toBe(200);
  expect(await merged.json()).toMatchObject({
    branding: { appName: "Acme Realm", primaryColor: "#abc", accentColor: "#112233aa" },
  });
  // Empty object is a no-op write answering the current view.
  const noop = await call("/api/branding", "PUT", {});
  expect(noop.status).toBe(200);
  expect(await noop.json()).toMatchObject({ branding: { appName: "Acme Realm" } });
  // Unknown keys are ignored, forward-compatible.
  const extra = await call("/api/branding", "PUT", { appName: "Acme Realm", future: "ignored" });
  expect(extra.status).toBe(200);
  // Ordinary members read but never write.
  const memberRead = await call("/api/branding", "GET", undefined, ORG, OTHER_USER);
  expect(memberRead.status).toBe(200);
  expect(await memberRead.json()).toMatchObject({ branding: { appName: "Acme Realm" } });
  const memberWrite = await call("/api/branding", "PUT", { appName: "Nope" }, ORG, OTHER_USER);
  expect(memberWrite.status).toBe(403);
  expect(await memberWrite.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
  // Strangers and foreign orgs never reach the view.
  const stranger = await call("/api/branding", "GET", undefined, ORG, STRANGER);
  expect(stranger.status).toBe(404);
  const foreign = await call("/api/branding", "GET", undefined, OTHER_ORG, OTHER_USER);
  expect(foreign.status).toBe(404);
  // Unauthenticated callers are challenged, never served.
  const bare = await worker.fetch(new Request("https://local.test/api/branding"), bindings);
  expect(bare.status).toBe(401);
});

it("rejects invalid branding bodies, queries, and content types", async () => {
  for (const body of [
    "not-an-object",
    { appName: 123 },
    { appName: "" },
    { appName: "x".repeat(81) },
    { appName: "Bad <tag>" },
    { appName: "Bad\u0000name" },
    { primaryColor: "red" },
    { primaryColor: "#12345" },
    { accentColor: "#zzzzzz" },
    { accentColor: 123 },
  ]) {
    const response = await call("/api/branding", "PUT", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_BRANDING" } });
  }
  const queried = await worker.fetch(
    new Request("https://local.test/api/branding?org=1", { method: "GET", headers: headers() }),
    bindings,
  );
  expect(queried.status).toBe(400);
  expect(await queried.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  const form = await worker.fetch(
    new Request("https://local.test/api/branding", {
      method: "PUT",
      headers: headers({ "Content-Type": "text/plain" }),
      body: "{}",
    }),
    bindings,
  );
  expect(form.status).toBe(415);
  expect(await form.json()).toMatchObject({ error: { code: "JSON_REQUIRED" } });
});

it("roundtrips a logo upload through real R2 with member-visible bytes", async () => {
  const bytes = imageBytes("image/png");
  const uploaded = await putBytes("/api/branding/logo", bytes, "image/png");
  expect(uploaded.status).toBe(200);
  const digest = await sha256Hex(bytes);
  expect(await uploaded.json()).toMatchObject({
    branding: {
      logo: { contentType: "image/png", sizeBytes: bytes.byteLength, sha256: digest },
    },
  });
  // The R2 key is org-namespaced under the reserved branding segment.
  const stored = await bindings.FILES.get(brandingLogoKey(ORG));
  expect(stored).not.toBeNull();
  expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  // Members proxy the bytes; strangers and foreigners do not.
  const member = await call("/api/branding/logo", "GET", undefined, ORG, OTHER_USER);
  expect(member.status).toBe(200);
  expect(member.headers.get("Content-Type")).toBe("image/png");
  expect(member.headers.get("Content-Length")).toBe(String(bytes.byteLength));
  expect(member.headers.get("ETag")).toBe(`"${digest}"`);
  expect(new Uint8Array(await member.arrayBuffer())).toEqual(bytes);
  const stranger = await call("/api/branding/logo", "GET", undefined, ORG, STRANGER);
  expect(stranger.status).toBe(404);
  const foreign = await call("/api/branding/logo", "GET", undefined, OTHER_ORG, OTHER_USER);
  expect(foreign.status).toBe(404);
  // Re-upload replaces both bytes and metadata.
  const jpeg = imageBytes("image/jpeg");
  const replaced = await putBytes("/api/branding/logo", jpeg, "image/jpeg");
  expect(replaced.status).toBe(200);
  expect(await replaced.json()).toMatchObject({
    branding: { logo: { contentType: "image/jpeg", sizeBytes: jpeg.byteLength } },
  });
});

it("accepts every allowlisted logo type and rejects type/size abuse", async () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const response = await putBytes("/api/branding/logo", imageBytes(type), type);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ branding: { logo: { contentType: type } } });
  }
  // Content-Type parameters are tolerated (media type still allowlisted).
  const param = await putBytes("/api/branding/logo", imageBytes("image/png"), "image/png; charset=binary");
  expect(param.status).toBe(200);
  // Ordinary members never upload.
  const member = await putBytes("/api/branding/logo", imageBytes("image/png"), "image/png", ORG, OTHER_USER);
  expect(member.status).toBe(403);
  expect(await member.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
  // Wrong declared types, including SVG and missing, answer 415.
  for (const type of ["text/plain", "image/svg+xml", "application/octet-stream"]) {
    const response = await putBytes("/api/branding/logo", imageBytes("image/png"), type);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_LOGO" } });
  }
  const missing = await putBytes("/api/branding/logo", imageBytes("image/png"), null);
  expect(missing.status).toBe(415);
  // Magic mismatch: declared PNG over text bytes, and truncated headers.
  const text = new TextEncoder().encode("definitely not an image, just text bytes here....");
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const response = await putBytes("/api/branding/logo", text, type);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_LOGO" } });
  }
  const truncated = await putBytes("/api/branding/logo", Uint8Array.from([0x89, 0x50]), "image/png");
  expect(truncated.status).toBe(415);
  // Oversized (5 MiB + 1 with a valid PNG header) answers 413.
  const huge = new Uint8Array(BRANDING_LOGO_MAX_BYTES + 1);
  huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const tooLarge = await putBytes("/api/branding/logo", huge, "image/png");
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toMatchObject({ error: { code: "LOGO_TOO_LARGE" } });
  // Empty bodies answer 400, with or without a body present.
  const empty = await putBytes("/api/branding/logo", new Uint8Array(0), "image/png");
  expect(empty.status).toBe(400);
  expect(await empty.json()).toMatchObject({ error: { code: "EMPTY_LOGO" } });
  const absent = await putBytes("/api/branding/logo", null, "image/png");
  expect(absent.status).toBe(400);
  // Encoded uploads are rejected before any storage.
  const encoded = await putBytes("/api/branding/logo", imageBytes("image/png"), "image/png", ORG, undefined, {
    "Content-Encoding": "gzip",
  });
  expect(encoded.status).toBe(415);
  expect(await encoded.json()).toMatchObject({ error: { code: "BYTES_REQUIRED" } });
});

it("deletes logos idempotently while keeping name and colors", async () => {
  const missing = await call("/api/branding/logo");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: "LOGO_NOT_FOUND" } });
  await call("/api/branding", "PUT", { appName: "Acme Realm" });
  await putBytes("/api/branding/logo", imageBytes("image/png"), "image/png");
  const memberDelete = await call("/api/branding/logo", "DELETE", undefined, ORG, OTHER_USER);
  expect(memberDelete.status).toBe(403);
  const deleted = await call("/api/branding/logo", "DELETE");
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({ branding: { appName: "Acme Realm", logo: null } });
  expect(await bindings.FILES.get(brandingLogoKey(ORG))).toBeNull();
  const again = await call("/api/branding/logo", "DELETE");
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ branding: { logo: null } });
});

it("resets branding to static defaults, removing the logo", async () => {
  await call("/api/branding", "PUT", { appName: "Acme Realm", primaryColor: "#112233" });
  await putBytes("/api/branding/logo", imageBytes("image/png"), "image/png");
  const memberReset = await worker.fetch(
    new Request("https://local.test/api/branding/reset", { method: "POST", headers: headers() }),
    { ...bindings, LAB_USER_ID: OTHER_USER, LAB_FIXTURE_USER_ID: ADMIN_USER },
  );
  expect(memberReset.status).toBe(403);
  // Reset requires the JSON guard like every other state-changing POST.
  const bare = await worker.fetch(
    new Request("https://local.test/api/branding/reset", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    bindings,
  );
  expect(bare.status).toBe(415);
  const reset = await call("/api/branding/reset", "POST", {});
  expect(reset.status).toBe(200);
  expect(await reset.json()).toEqual({
    branding: {
      orgId: ORG,
      appName: "Wrangnarok",
      primaryColor: "#F45D0B",
      accentColor: "#F59E0B",
      logo: null,
      updatedAt: null,
    },
  });
  expect(await bindings.FILES.get(brandingLogoKey(ORG))).toBeNull();
  const memberRead = await call("/api/branding", "GET", undefined, ORG, OTHER_USER);
  expect(await memberRead.json()).toMatchObject({ branding: { appName: "Wrangnarok", logo: null } });
});

it("serves safe public branding reads without authentication", async () => {
  await call("/api/branding", "PUT", { appName: "Acme Realm", primaryColor: "#112233" });
  const bytes = imageBytes("image/png");
  await putBytes("/api/branding/logo", bytes, "image/png");
  const digest = await sha256Hex(bytes);
  const bare = await worker.fetch(new Request(`https://local.test/api/branding/public/${ORG}`), bindings);
  expect(bare.status).toBe(200);
  expect(await bare.json()).toEqual({
    branding: {
      orgId: ORG,
      appName: "Acme Realm",
      primaryColor: "#112233",
      accentColor: "#F59E0B",
      logo: { contentType: "image/png", sizeBytes: bytes.byteLength, sha256: digest },
      updatedAt: expect.any(String),
    },
  });
  // The public payload carries no caller, membership, or credential material.
  expect(
    JSON.stringify(
      await (await worker.fetch(new Request(`https://local.test/api/branding/public/${ORG}`), bindings)).json(),
    ),
  ).not.toMatch(/userId|user_id|token|secret|email/i);
  const logo = await worker.fetch(new Request(`https://local.test/api/branding/public/${ORG}/logo`), bindings);
  expect(logo.status).toBe(200);
  expect(logo.headers.get("Content-Type")).toBe("image/png");
  expect(logo.headers.get("Cache-Control")).toBe("public, max-age=300");
  expect(new Uint8Array(await logo.arrayBuffer())).toEqual(bytes);
  // Unknown orgs 404; unset logos 404; queries stay rejected.
  const unknown = await worker.fetch(new Request(`https://local.test/api/branding/public/${OTHER_ORG}`), bindings);
  expect(unknown.status).toBe(404);
  await call("/api/branding/logo", "DELETE");
  const unset = await worker.fetch(new Request(`https://local.test/api/branding/public/${ORG}/logo`), bindings);
  expect(unset.status).toBe(404);
  const queried = await worker.fetch(new Request(`https://local.test/api/branding/public/${ORG}?x=1`), bindings);
  expect(queried.status).toBe(400);
  expect(await queried.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  // Non-GET methods on the public path fall through to the auth gate.
  const posted = await worker.fetch(
    new Request(`https://local.test/api/branding/public/${ORG}`, { method: "POST" }),
    bindings,
  );
  expect(posted.status).toBe(401);
});

it("reads half-written image metadata as unset, never partial", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO org_branding(org_id,app_name,primary_color,accent_color,logo_content_type,logo_size,logo_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, "Acme Realm", "#112233", "#445566", "", 41, "f".repeat(64), stamp)
    .run();
  expect(await (await call("/api/branding")).json()).toMatchObject({ branding: { logo: null } });
  await bindings.DB.prepare(
    "INSERT INTO user_profiles(org_id,user_id,display_name,theme,avatar_content_type,avatar_size,avatar_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(ORG, ADMIN_USER, "Ada", "dark", "", 41, "f".repeat(64), stamp)
    .run();
  expect(await (await call("/api/profile")).json()).toMatchObject({ profile: { avatar: null } });
});

it("answers 404 when logo metadata outlives its bytes", async () => {
  await putBytes("/api/branding/logo", imageBytes("image/png"), "image/png");
  await bindings.FILES.delete(brandingLogoKey(ORG));
  const member = await call("/api/branding/logo");
  expect(member.status).toBe(404);
  const bare = await worker.fetch(new Request(`https://local.test/api/branding/public/${ORG}/logo`), bindings);
  expect(bare.status).toBe(404);
});

it("reads and writes the caller's own profile, isolated per user", async () => {
  const initial = await call("/api/profile");
  expect(initial.status).toBe(200);
  expect(await initial.json()).toEqual({
    profile: {
      orgId: ORG,
      userId: ADMIN_USER,
      displayName: "",
      theme: "system",
      avatar: null,
      updatedAt: null,
    },
  });
  const updated = await call("/api/profile", "PUT", { displayName: "  Ada   Lovelace  ", theme: "dark" });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ profile: { displayName: "Ada Lovelace", theme: "dark" } });
  // Partial merge: theme-only keeps the name.
  const merged = await call("/api/profile", "PUT", { theme: "light" });
  expect(await merged.json()).toMatchObject({ profile: { displayName: "Ada Lovelace", theme: "light" } });
  // A second caller sees only their own blank profile: no cross-user read.
  const other = await call("/api/profile", "GET", undefined, ORG, OTHER_USER);
  expect(other.status).toBe(200);
  expect(await other.json()).toMatchObject({ profile: { userId: OTHER_USER, displayName: "", theme: "system" } });
  await call("/api/profile", "PUT", { displayName: "Grace" }, ORG, OTHER_USER);
  const admin = await call("/api/profile");
  expect(await admin.json()).toMatchObject({ profile: { userId: ADMIN_USER, displayName: "Ada Lovelace" } });
  // Strangers never reach a profile; queries and non-JSON stay rejected.
  expect((await call("/api/profile", "GET", undefined, ORG, STRANGER)).status).toBe(404);
  for (const body of [
    "nope",
    { theme: "neon" },
    { theme: 1 },
    { displayName: 123 },
    { displayName: "x".repeat(81) },
    { displayName: "<b>" },
  ]) {
    const response = await call("/api/profile", "PUT", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_PROFILE" } });
  }
  const queried = await worker.fetch(
    new Request("https://local.test/api/profile?x=1", { method: "GET", headers: headers() }),
    bindings,
  );
  expect(queried.status).toBe(400);
  const form = await worker.fetch(
    new Request("https://local.test/api/profile", {
      method: "PUT",
      headers: headers({ "Content-Type": "text/plain" }),
      body: "{}",
    }),
    bindings,
  );
  expect(form.status).toBe(415);
});

it("roundtrips an avatar upload with type/size abuse fenced", async () => {
  const missing = await call("/api/profile/avatar");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: "AVATAR_NOT_FOUND" } });
  const bytes = imageBytes("image/webp");
  const uploaded = await putBytes("/api/profile/avatar", bytes, "image/webp");
  expect(uploaded.status).toBe(200);
  const digest = await sha256Hex(bytes);
  expect(await uploaded.json()).toMatchObject({
    profile: { avatar: { contentType: "image/webp", sizeBytes: bytes.byteLength, sha256: digest } },
  });
  expect(await bindings.FILES.get(profileAvatarKey(ORG, ADMIN_USER))).not.toBeNull();
  const read = await call("/api/profile/avatar");
  expect(read.status).toBe(200);
  expect(read.headers.get("Content-Type")).toBe("image/webp");
  expect(read.headers.get("ETag")).toBe(`"${digest}"`);
  expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
  // Avatars are owner-only: another member reads their own (unset) slot.
  const other = await call("/api/profile/avatar", "GET", undefined, ORG, OTHER_USER);
  expect(other.status).toBe(404);
  // Abuse matrix mirrors the logo fence at the 2 MiB avatar cap.
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    expect((await putBytes("/api/profile/avatar", imageBytes(type), type)).status).toBe(200);
  }
  const text = new TextEncoder().encode("definitely not an image, just text bytes here....");
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const response = await putBytes("/api/profile/avatar", text, type);
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: { code: "UNSUPPORTED_AVATAR" } });
  }
  for (const type of ["text/plain", "image/svg+xml", "application/octet-stream"]) {
    const response = await putBytes("/api/profile/avatar", imageBytes("image/png"), type);
    expect(response.status).toBe(415);
  }
  const nullType = await putBytes("/api/profile/avatar", imageBytes("image/png"), null);
  expect(nullType.status).toBe(415);
  const huge = new Uint8Array(AVATAR_MAX_BYTES + 1);
  huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const tooLarge = await putBytes("/api/profile/avatar", huge, "image/png");
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toMatchObject({ error: { code: "AVATAR_TOO_LARGE" } });
  const empty = await putBytes("/api/profile/avatar", new Uint8Array(0), "image/png");
  expect(empty.status).toBe(400);
  const absent = await putBytes("/api/profile/avatar", null, "image/png");
  expect(absent.status).toBe(400);
  const encoded = await putBytes("/api/profile/avatar", imageBytes("image/png"), "image/png", ORG, undefined, {
    "Content-Encoding": "gzip",
  });
  expect(encoded.status).toBe(415);
  // Removal is idempotent and keeps the name/theme.
  await call("/api/profile", "PUT", { displayName: "Ada", theme: "dark" });
  const deleted = await call("/api/profile/avatar", "DELETE");
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({ profile: { displayName: "Ada", theme: "dark", avatar: null } });
  expect(await bindings.FILES.get(profileAvatarKey(ORG, ADMIN_USER))).toBeNull();
  const again = await call("/api/profile/avatar", "DELETE");
  expect(again.status).toBe(200);
});

it("fails byte writes loudly when R2 is unbound, and degrades reads", async () => {
  const caller = { userId: ADMIN_USER, orgId: ORG };
  const bytes = imageBytes("image/png");
  await expect(putLogo({ db: bindings.DB, bucket: undefined }, caller, "image/png", bytes)).rejects.toMatchObject({
    code: "BRANDING_STORE_NOT_CONFIGURED",
  });
  await expect(putAvatar({ db: bindings.DB, bucket: undefined }, caller, "image/png", bytes)).rejects.toMatchObject({
    code: "PROFILE_STORE_NOT_CONFIGURED",
  });
  // Best-effort removals still converge without a bucket.
  await expect(deleteLogo({ db: bindings.DB, bucket: undefined }, ORG)).resolves.toMatchObject({ logo: null });
  await expect(deleteAvatar({ db: bindings.DB, bucket: undefined }, caller)).resolves.toMatchObject({ avatar: null });
  await expect(resetBranding({ db: bindings.DB, bucket: undefined }, ORG)).resolves.toMatchObject({
    appName: "Wrangnarok",
  });
});
