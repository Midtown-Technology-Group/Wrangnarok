// SPDX-License-Identifier: AGPL-3.0
// Organization branding (UX-01 slice 1, issue #176): application name,
// colors, and logo with an admin-only write/reset path and a safe public
// read for pre-auth shells and embeds.
//
// Storage mirrors FILE-01 posture without reusing its policy machinery:
// D1 (org_branding, migration 0034) holds metadata only; logo bytes live in
// the FILES R2 bucket under `<orgId>/__branding__/logo`. The `__branding__`
// segment can never collide with a managed file location: LOCATION_NAME
// forbids underscores, so no declared location produces this key. Route
// authorization (membership gate for reads, requireManageOrg for writes) is
// the policy check — there are no file_policies rows to revoke.
//
// Upload limits adopt the upstream pins recorded in docs/upstream-spec.md
// §16: logos 5 MiB (upstream routers/branding.py:28, whose allowlist also
// admits SVG). Raster types verify by magic bytes; SVG verifies by the
// shared inert-markup guard (src/svg-image.ts, UX-01 slice 3) and serves
// under the API default-src-'none' CSP, so stored SVG can never run script.
import { Fault, object } from "./domain";
import type { Principal } from "./domain";
import { sha256Hex } from "./files";
import { SVG_CONTENT_TYPE, validateSvgImage } from "./svg-image";

/** Upstream pin: logos 5 MiB (routers/branding.py:28). */
export const BRANDING_LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const BRANDING_NAME_MAX = 80;

/** Image allowlist: raster types plus sanitized inline SVG (slice 3). */
export const BRANDING_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", SVG_CONTENT_TYPE] as const;
export type BrandingImageType = (typeof BRANDING_IMAGE_TYPES)[number];

/** Static defaults: the shipped Wrangnarok brand (assets/brand/tokens.css).
 * A row that was never customized reads exactly these values. */
export const DEFAULT_BRANDING = {
  appName: "Wrangnarok",
  primaryColor: "#F45D0B",
  accentColor: "#F59E0B",
} as const;

export interface BrandingLogo {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface BrandingView {
  readonly orgId: string;
  readonly appName: string;
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly logo: BrandingLogo | null;
  readonly updatedAt: string | null;
}

export interface BrandingStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket | undefined;
}

/** Reserved R2 key. Org-first like FILE-01 object keys; the `__branding__`
 * segment is undeclareable as a file location (no underscores allowed). */
export function brandingLogoKey(orgId: string): string {
  return `${orgId}/__branding__/logo`;
}

function fail(status: number, code: string, message: string): Fault {
  return new Fault(status, code, message);
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/;

/** Control characters and markup survive trim: reject, never store. An
 * explicit code scan instead of a control-char regex (lint-clean). */
function hasForbiddenChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || ch === "<" || ch === ">" || ch === '"') return true;
  }
  return false;
}

export function parseAppName(value: unknown): string {
  if (typeof value !== "string") throw fail(400, "INVALID_BRANDING", "Application name must be a string.");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > BRANDING_NAME_MAX) {
    throw fail(400, "INVALID_BRANDING", `Application name must be 1 to ${BRANDING_NAME_MAX} characters.`);
  }
  if (hasForbiddenChars(name)) {
    throw fail(400, "INVALID_BRANDING", "Application name must not contain control characters or markup.");
  }
  return name;
}

export function parseBrandColor(value: unknown): string {
  if (typeof value !== "string" || !HEX_COLOR.test(value.trim().toLowerCase())) {
    throw fail(400, "INVALID_BRANDING", "Brand colors must be #rgb, #rrggbb, or #rrggbbaa hex.");
  }
  return value.trim().toLowerCase();
}

export interface BrandingWrite {
  readonly appName?: string;
  readonly primaryColor?: string;
  readonly accentColor?: string;
}

/** Partial-write body: provided fields validate, unknown keys are ignored
 * (forward-compatible like the saga-policy merge), an empty object is a
 * no-op write that still answers the current view. */
export function parseBrandingBody(body: unknown): BrandingWrite {
  if (!object(body)) throw fail(400, "INVALID_BRANDING", "Branding needs an application name and brand colors.");
  const write: { appName?: string; primaryColor?: string; accentColor?: string } = {};
  if (body.appName !== undefined) write.appName = parseAppName(body.appName);
  if (body.primaryColor !== undefined) write.primaryColor = parseBrandColor(body.primaryColor);
  if (body.accentColor !== undefined) write.accentColor = parseBrandColor(body.accentColor);
  return write;
}

interface BrandingRow {
  org_id: string;
  app_name: string;
  primary_color: string;
  accent_color: string;
  logo_content_type: string;
  logo_size: number;
  logo_sha256: string;
  updated_at: string;
}

function toView(orgId: string, row: BrandingRow | null): BrandingView {
  if (!row) {
    return {
      orgId,
      appName: DEFAULT_BRANDING.appName,
      primaryColor: DEFAULT_BRANDING.primaryColor,
      accentColor: DEFAULT_BRANDING.accentColor,
      logo: null,
      updatedAt: null,
    };
  }
  return {
    orgId,
    appName: row.app_name,
    primaryColor: row.primary_color,
    accentColor: row.accent_color,
    logo:
      row.logo_sha256 && row.logo_content_type
        ? { contentType: row.logo_content_type, sizeBytes: row.logo_size, sha256: row.logo_sha256 }
        : null,
    updatedAt: row.updated_at,
  };
}

async function loadRow(db: D1Database, orgId: string): Promise<BrandingRow | null> {
  return db.prepare("SELECT * FROM org_branding WHERE org_id=?").bind(orgId).first<BrandingRow>();
}

/** Member-or-public read: safe fields only (name, colors, logo metadata).
 * No row yet reads as the static defaults with a null logo. */
export async function getBranding(db: D1Database, orgId: string): Promise<BrandingView> {
  return toView(orgId, await loadRow(db, orgId));
}

/** Admin-only write (the route gates with requireManageOrg first): merges
 * the validated partial body over the current row, creating it when the
 * Organization never customized branding. */
export async function updateBranding(db: D1Database, orgId: string, body: unknown): Promise<BrandingView> {
  const write = parseBrandingBody(body);
  const now = new Date().toISOString();
  const current = await loadRow(db, orgId);
  const next = {
    appName: write.appName ?? current?.app_name ?? DEFAULT_BRANDING.appName,
    primaryColor: write.primaryColor ?? current?.primary_color ?? DEFAULT_BRANDING.primaryColor,
    accentColor: write.accentColor ?? current?.accent_color ?? DEFAULT_BRANDING.accentColor,
  };
  await db
    .prepare(
      "INSERT INTO org_branding(org_id,app_name,primary_color,accent_color,logo_content_type,logo_size,logo_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET app_name=excluded.app_name,primary_color=excluded.primary_color,accent_color=excluded.accent_color,updated_at=excluded.updated_at",
    )
    .bind(orgId, next.appName, next.primaryColor, next.accentColor, "", 0, "", now)
    .run();
  const row = await loadRow(db, orgId);
  if (!row) throw new Error("Branding update did not persist.");
  return toView(orgId, row);
}

/** Admin-only reset: removes the custom logo bytes (best-effort) and drops
 * the row, so the next read answers static defaults. Idempotent. */
export async function resetBranding(store: BrandingStore, orgId: string): Promise<BrandingView> {
  if (store.bucket) await store.bucket.delete(brandingLogoKey(orgId)).catch(() => undefined);
  await store.db.prepare("DELETE FROM org_branding WHERE org_id=?").bind(orgId).run();
  return toView(orgId, null);
}

/** Declared Content-Type allowlist check: exact member, no parameters,
 * no sniffing fallback. */
export function parseLogoContentType(value: string | null): BrandingImageType {
  const type = (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(BRANDING_IMAGE_TYPES as readonly string[]).includes(type)) {
    throw fail(415, "UNSUPPORTED_LOGO", "Logos must be PNG, JPEG, GIF, WebP, or SVG images.");
  }
  return type as BrandingImageType;
}

/** Byte verification: the declared type must match the actual bytes. Raster
 * types verify by magic bytes; SVG verifies by the inert-markup guard. A
 * renamed executable or SVG-with-PNG-type answers 415, never storage. */
export function verifyLogoBytes(contentType: BrandingImageType, bytes: Uint8Array): void {
  if (contentType === SVG_CONTENT_TYPE) {
    try {
      validateSvgImage(bytes);
    } catch (error) {
      throw fail(415, "UNSUPPORTED_LOGO", error instanceof Error ? error.message : "Logo SVG is not allowed.");
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
  if (!ok) throw fail(415, "UNSUPPORTED_LOGO", "Logo bytes do not match the declared image type.");
}

/** Admin-only logo upload: bytes land in R2 BEFORE the D1 metadata row
 * commits, so a failed write leaves no metadata pointing at missing bytes
 * (same failed-write order as createArtifact). Re-upload replaces. */
export async function putLogo(
  store: BrandingStore,
  caller: Principal,
  contentType: string | null,
  bytes: Uint8Array,
): Promise<BrandingView> {
  const type = parseLogoContentType(contentType);
  if (bytes.byteLength === 0) throw fail(400, "EMPTY_LOGO", "Logo bytes must not be empty.");
  if (bytes.byteLength > BRANDING_LOGO_MAX_BYTES) {
    throw fail(413, "LOGO_TOO_LARGE", `Logo bytes must fit ${BRANDING_LOGO_MAX_BYTES} bytes.`);
  }
  verifyLogoBytes(type, bytes);
  if (!store.bucket) throw fail(503, "BRANDING_STORE_NOT_CONFIGURED", "Logo byte storage is not configured.");
  const sha256 = sha256Hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  await store.bucket.put(brandingLogoKey(caller.orgId), bytes as Uint8Array<ArrayBuffer>, {
    httpMetadata: { contentType: type },
  });
  const now = new Date().toISOString();
  const current = await loadRow(store.db, caller.orgId);
  await store.db
    .prepare(
      "INSERT INTO org_branding(org_id,app_name,primary_color,accent_color,logo_content_type,logo_size,logo_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET logo_content_type=excluded.logo_content_type,logo_size=excluded.logo_size,logo_sha256=excluded.logo_sha256,updated_at=excluded.updated_at",
    )
    .bind(
      caller.orgId,
      current?.app_name ?? DEFAULT_BRANDING.appName,
      current?.primary_color ?? DEFAULT_BRANDING.primaryColor,
      current?.accent_color ?? DEFAULT_BRANDING.accentColor,
      type,
      bytes.byteLength,
      sha256,
      now,
    )
    .run();
  const row = await loadRow(store.db, caller.orgId);
  if (!row) throw new Error("Logo upload did not persist.");
  return toView(caller.orgId, row);
}

/** Admin-only logo removal: deletes bytes (best-effort) and clears the
 * metadata, keeping name/colors. Idempotent: no logo still answers 200. */
export async function deleteLogo(store: BrandingStore, orgId: string): Promise<BrandingView> {
  if (store.bucket) await store.bucket.delete(brandingLogoKey(orgId)).catch(() => undefined);
  await store.db
    .prepare("UPDATE org_branding SET logo_content_type='',logo_size=0,logo_sha256='',updated_at=? WHERE org_id=?")
    .bind(new Date().toISOString(), orgId)
    .run();
  return toView(orgId, await loadRow(store.db, orgId));
}

export interface LogoBytes {
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** Policy-checked byte read: the route proves membership (or public-routes
 * it) before calling. Metadata without bytes answers 404 like unset. */
export async function readLogoBytes(store: BrandingStore, orgId: string): Promise<LogoBytes | null> {
  const row = await loadRow(store.db, orgId);
  if (!row?.logo_sha256 || !row.logo_content_type || !store.bucket) return null;
  const object = await store.bucket.get(brandingLogoKey(orgId));
  if (!object) return null;
  return {
    contentType: row.logo_content_type,
    bytes: new Uint8Array(await object.arrayBuffer()),
    sha256: row.logo_sha256,
  };
}
