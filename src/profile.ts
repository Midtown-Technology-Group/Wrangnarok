// SPDX-License-Identifier: AGPL-3.0
// Own user profile (UX-01 slice 1, issue #176): display name, theme
// preference, and avatar scoped strictly to the caller. No directory, no
// cross-user reads in slice 1: the only reader of a profile row is its
// owner (plus admins only where an explicit admin surface needs it — none
// ships here).
//
// Storage mirrors the branding module: D1 (user_profiles, migration 0034)
// holds metadata only; avatar bytes live in the FILES R2 bucket under
// `<orgId>/__avatars__/<userId>`. Same collision argument as branding
// (`__avatars__` is undeclareable as a file location). Password/security
// settings are deliberately absent: identity is IdP-owned (Access) per
// AUTH-03, and this module must never grow a second credential store.
//
// Upload limits adopt the upstream pins recorded in docs/upstream-spec.md
// §16: avatars 2 MiB (upstream routers/profile.py:27). Raster types verify
// by magic bytes; SVG verifies by the shared inert-markup guard
// (src/svg-image.ts, UX-01 slice 3) and serves under the API
// default-src-'none' CSP, so stored SVG can never run script.
import { Fault, object } from "./domain";
import type { Principal } from "./domain";
import { sha256Hex } from "./files";
import { SVG_CONTENT_TYPE, validateSvgImage } from "./svg-image";

/** Upstream pin: avatars 2 MiB (routers/profile.py:27). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const PROFILE_NAME_MAX = 80;

/** Image allowlist: raster types plus sanitized inline SVG (slice 3),
 * shared semantics with branding. */
export const AVATAR_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", SVG_CONTENT_TYPE] as const;
export type AvatarImageType = (typeof AVATAR_IMAGE_TYPES)[number];

export const PROFILE_THEMES = ["light", "dark", "system"] as const;
export type ProfileTheme = (typeof PROFILE_THEMES)[number];

export interface ProfileAvatar {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ProfileView {
  readonly orgId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly theme: ProfileTheme;
  readonly avatar: ProfileAvatar | null;
  readonly updatedAt: string | null;
}

export interface ProfileStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket | undefined;
}

/** Reserved R2 key. Caller user IDs are Access emails or LAB UUIDs
 * (orgs.parseUserId); both are safe opaque key segments. */
export function profileAvatarKey(orgId: string, userId: string): string {
  return `${orgId}/__avatars__/${userId}`;
}

function fail(status: number, code: string, message: string): Fault {
  return new Fault(status, code, message);
}

/** Control characters and markup survive trim: reject, never store. An
 * explicit code scan instead of a control-char regex (lint-clean). */
function hasForbiddenChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || ch === "<" || ch === ">" || ch === '"') return true;
  }
  return false;
}

export function parseDisplayName(value: unknown): string {
  if (typeof value !== "string") throw fail(400, "INVALID_PROFILE", "Display name must be a string.");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > PROFILE_NAME_MAX) {
    throw fail(400, "INVALID_PROFILE", `Display name must fit ${PROFILE_NAME_MAX} characters.`);
  }
  if (hasForbiddenChars(name)) {
    throw fail(400, "INVALID_PROFILE", "Display name must not contain control characters or markup.");
  }
  return name;
}

export function parseTheme(value: unknown): ProfileTheme {
  if (typeof value !== "string" || !(PROFILE_THEMES as readonly string[]).includes(value)) {
    throw fail(400, "INVALID_PROFILE", "Theme must be light, dark, or system.");
  }
  return value as ProfileTheme;
}

export interface ProfileWrite {
  readonly displayName?: string;
  readonly theme?: ProfileTheme;
}

/** Partial-write body: same forward-compatible merge shape as branding. */
export function parseProfileBody(body: unknown): ProfileWrite {
  if (!object(body)) throw fail(400, "INVALID_PROFILE", "Profile needs a display name and theme preference.");
  const write: { displayName?: string; theme?: ProfileTheme } = {};
  if (body.displayName !== undefined) write.displayName = parseDisplayName(body.displayName);
  if (body.theme !== undefined) write.theme = parseTheme(body.theme);
  return write;
}

interface ProfileRow {
  org_id: string;
  user_id: string;
  display_name: string;
  theme: string;
  avatar_content_type: string;
  avatar_size: number;
  avatar_sha256: string;
  updated_at: string;
}

function toView(orgId: string, userId: string, row: ProfileRow | null): ProfileView {
  if (!row) {
    return { orgId, userId, displayName: "", theme: "system", avatar: null, updatedAt: null };
  }
  if (!(PROFILE_THEMES as readonly string[]).includes(row.theme)) {
    throw new Error("Profile row carries invalid theme.");
  }
  return {
    orgId,
    userId,
    displayName: row.display_name,
    theme: row.theme as ProfileTheme,
    avatar:
      row.avatar_sha256 && row.avatar_content_type
        ? { contentType: row.avatar_content_type, sizeBytes: row.avatar_size, sha256: row.avatar_sha256 }
        : null,
    updatedAt: row.updated_at,
  };
}

async function loadRow(db: D1Database, orgId: string, userId: string): Promise<ProfileRow | null> {
  return db.prepare("SELECT * FROM user_profiles WHERE org_id=? AND user_id=?").bind(orgId, userId).first<ProfileRow>();
}

/** Own-profile read: the route passes the resolved caller, never a
 * caller-supplied user ID, so one caller can never address another's row. */
export async function getProfile(db: D1Database, caller: Principal): Promise<ProfileView> {
  return toView(caller.orgId, caller.userId, await loadRow(db, caller.orgId, caller.userId));
}

/** Own-profile write: upserts the caller's row, preserving avatar metadata. */
export async function updateProfile(db: D1Database, caller: Principal, body: unknown): Promise<ProfileView> {
  const write = parseProfileBody(body);
  const now = new Date().toISOString();
  const current = await loadRow(db, caller.orgId, caller.userId);
  await db
    .prepare(
      "INSERT INTO user_profiles(org_id,user_id,display_name,theme,avatar_content_type,avatar_size,avatar_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET display_name=excluded.display_name,theme=excluded.theme,updated_at=excluded.updated_at",
    )
    .bind(
      caller.orgId,
      caller.userId,
      write.displayName ?? current?.display_name ?? "",
      write.theme ?? current?.theme ?? "system",
      "",
      0,
      "",
      now,
    )
    .run();
  const row = await loadRow(db, caller.orgId, caller.userId);
  if (!row) throw new Error("Profile update did not persist.");
  return toView(caller.orgId, caller.userId, row);
}

export function parseAvatarContentType(value: string | null): AvatarImageType {
  const type = (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(AVATAR_IMAGE_TYPES as readonly string[]).includes(type)) {
    throw fail(415, "UNSUPPORTED_AVATAR", "Avatars must be PNG, JPEG, GIF, WebP, or SVG images.");
  }
  return type as AvatarImageType;
}

/** Byte verification, same discipline as logo bytes: magic bytes for
 * raster, the inert-markup guard for SVG. */
export function verifyAvatarBytes(contentType: AvatarImageType, bytes: Uint8Array): void {
  if (contentType === SVG_CONTENT_TYPE) {
    try {
      validateSvgImage(bytes);
    } catch (error) {
      throw fail(415, "UNSUPPORTED_AVATAR", error instanceof Error ? error.message : "Avatar SVG is not allowed.");
    }
    return;
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const startsWith = (magic: number[]): boolean =>
    bytes.byteLength >= magic.length && magic.every((byte, index) => bytes[index] === byte);
  let ok = false;
  if (contentType === "image/png") ok = startsWith(png);
  else if (contentType === "image/jpeg")
    ok = bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  else if (contentType === "image/gif")
    ok = startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  else if (contentType === "image/webp")
    ok =
      bytes.byteLength >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
  if (!ok) throw fail(415, "UNSUPPORTED_AVATAR", "Avatar bytes do not match the declared image type.");
}

/** Own-avatar upload: R2 first, then D1 metadata (failed-write order). */
export async function putAvatar(
  store: ProfileStore,
  caller: Principal,
  contentType: string | null,
  bytes: Uint8Array,
): Promise<ProfileView> {
  const type = parseAvatarContentType(contentType);
  if (bytes.byteLength === 0) throw fail(400, "EMPTY_AVATAR", "Avatar bytes must not be empty.");
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    throw fail(413, "AVATAR_TOO_LARGE", `Avatar bytes must fit ${AVATAR_MAX_BYTES} bytes.`);
  }
  verifyAvatarBytes(type, bytes);
  if (!store.bucket) throw fail(503, "PROFILE_STORE_NOT_CONFIGURED", "Avatar byte storage is not configured.");
  const sha256 = sha256Hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  await store.bucket.put(profileAvatarKey(caller.orgId, caller.userId), bytes as Uint8Array<ArrayBuffer>, {
    httpMetadata: { contentType: type },
  });
  const now = new Date().toISOString();
  const current = await loadRow(store.db, caller.orgId, caller.userId);
  await store.db
    .prepare(
      "INSERT INTO user_profiles(org_id,user_id,display_name,theme,avatar_content_type,avatar_size,avatar_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET avatar_content_type=excluded.avatar_content_type,avatar_size=excluded.avatar_size,avatar_sha256=excluded.avatar_sha256,updated_at=excluded.updated_at",
    )
    .bind(
      caller.orgId,
      caller.userId,
      current?.display_name ?? "",
      current?.theme ?? "system",
      type,
      bytes.byteLength,
      sha256,
      now,
    )
    .run();
  const row = await loadRow(store.db, caller.orgId, caller.userId);
  if (!row) throw new Error("Avatar upload did not persist.");
  return toView(caller.orgId, caller.userId, row);
}

/** Own-avatar removal: idempotent, keeps display name and theme. */
export async function deleteAvatar(store: ProfileStore, caller: Principal): Promise<ProfileView> {
  if (store.bucket) await store.bucket.delete(profileAvatarKey(caller.orgId, caller.userId)).catch(() => undefined);
  await store.db
    .prepare(
      "UPDATE user_profiles SET avatar_content_type='',avatar_size=0,avatar_sha256='',updated_at=? WHERE org_id=? AND user_id=?",
    )
    .bind(new Date().toISOString(), caller.orgId, caller.userId)
    .run();
  return toView(caller.orgId, caller.userId, await loadRow(store.db, caller.orgId, caller.userId));
}

export interface AvatarBytes {
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** Own-avatar byte read: caller-resolved only, metadata without bytes 404s. */
export async function readAvatarBytes(store: ProfileStore, caller: Principal): Promise<AvatarBytes | null> {
  const row = await loadRow(store.db, caller.orgId, caller.userId);
  if (!row?.avatar_sha256 || !row.avatar_content_type || !store.bucket) return null;
  const object = await store.bucket.get(profileAvatarKey(caller.orgId, caller.userId));
  if (!object) return null;
  return {
    contentType: row.avatar_content_type,
    bytes: new Uint8Array(await object.arrayBuffer()),
    sha256: row.avatar_sha256,
  };
}
