// SPDX-License-Identifier: AGPL-3.0
// Signed app embeds (EMBED-01 slice 2, issue #156).
//
// An app embed grant is a revocable external capability distinct from both
// the signed form-embed grant (slice 1, src/embeds.ts) and anonymous
// public-form publication (this slice, src/public-forms.ts): per-org/per-app
// secret material that lets an approved web origin fetch the ACTIVE
// deployment's assets without an operator session. Shape mirrors slice 1 —
// SHA-256 digest storage, show-once raw secret, rotate via digest swap,
// revoke via disable, no readback, exact-match origin allowlist, capability
// fingerprint that fails closed until rotation.
//
// Grant identity: one UUID row in `app_embeds` (migration 0036) binding
// (org, app id, app slug) to a secret digest, an exact-match origin
// allowlist, and a capability fingerprint (SHA-256 over the bound app id
// plus the active deployment content_hash). The raw secret is returned once
// at create/rotate and never again; D1 keeps only the digest (ADR 005 v0
// posture).
//
// Origin binding: asset reads require an exact-match Origin header from the
// allowlist. No wildcards, no suffix matching, no Referer fallback — the
// same upstream pin as slice 1 (`form_runtime.py:358-441`).
//
// Fingerprint rotation: the grant records the deployment fingerprint at
// issue time. A redeploy (new content_hash), or a delete/recreate that
// changes the app id under the same slug, makes the grant stale: asset
// reads answer 409 APP_EMBED_CAPABILITY_CHANGED until the admin rotates,
// which re-fingerprints against the live deployment and mints a fresh
// secret. Fail-closed plus rotate is the whole stale-capability story;
// there is no republish-review queue for signed grants (review belongs to
// the anonymous publication class).
//
// Sessions: app embeds mint no FORM-02 startup handle — there is no form
// submission here, only static asset bytes from the stored bundle. The
// grant re-resolves on every read, so revocation and expiry kill
// outstanding references with no TTL grace (the FILE-01 posture).
//
// The app-embed principal (`appembed:<grantId>`) is distinct from the form
// principal (`embed:<grantId>`) and the anonymous principal
// (`anon:<publicationId>`): the three tables never cross-resolve, so a form
// grant is 404 on the app-asset route exactly as an app grant is stale on
// the form-embed routes. The principal holds no membership, no roles, and
// no grants, so Table-gated app runtime reads deny by absence and a grant
// can never traverse to another app, an unrelated Saga, or another tenant.
//
// What this module is NOT: anonymous publication (every call presents the
// grant secret), form embeds (src/embeds.ts owns that table), or a second
// execution path (asset reads dispatch nothing).
import { Fault, hash, UUID } from "./domain";
import type { Principal } from "./domain";
import { parseAllowedOrigins, parseEmbedGrantId } from "./embeds";

export interface AppEmbedGrantRow {
  id: string;
  org_id: string;
  app_id: string;
  app_slug: string;
  secret_hash: string;
  allowed_origins_json: string;
  capability_fingerprint: string;
  enabled: number;
  expires_at: string | null;
  created_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
}

export interface AppEmbedGrantSummary {
  readonly id: string;
  readonly appSlug: string;
  readonly allowedOrigins: readonly string[];
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface IssuedAppEmbedGrant {
  readonly row: AppEmbedGrantRow;
  /** Raw secret, shown once in the create/rotate response and never again. */
  readonly secret: string;
}

export interface AppLiveDeployment {
  readonly appId: string;
  readonly slug: string;
  readonly deploymentId: string;
  readonly contentHash: string;
}

function invalid(message: string): Fault {
  return new Fault(400, "INVALID_APP_EMBED", message);
}

function parseAppEmbedExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw invalid("expiresAt must be an ISO 8601 date-time, or null.");
  }
  const at = new Date(Date.parse(value)).toISOString();
  if (Date.parse(at) <= Date.now()) throw invalid("expiresAt must be in the future, or null.");
  return at;
}

/** Capability fingerprint: SHA-256 over the bound app id plus the active
 * deployment content_hash. Any redeploy changes the input, so the stored
 * grant fingerprint stops matching and the grant fails closed until
 * rotated. */
export async function fingerprintAppDeployment(appId: string, contentHash: string): Promise<string> {
  return hash(JSON.stringify([appId.toLowerCase(), contentHash]));
}

/** Resolve the live deployment for one app row: the app must exist in this
 * Organization and carry an active deployment. Unknown, foreign, or
 * undeployed apps answer null so the route answers 404, never a leak. */
export async function loadLiveDeployment(
  db: D1Database,
  orgId: string,
  appId: string,
): Promise<AppLiveDeployment | null> {
  const app = await db
    .prepare("SELECT id, slug, active_deployment_id FROM apps WHERE id=? AND org_id=?")
    .bind(appId.toLowerCase(), orgId)
    .first<{ id: string; slug: string; active_deployment_id: string | null }>();
  if (!app || !app.active_deployment_id) return null;
  const deployment = await db
    .prepare("SELECT content_hash FROM app_deployments WHERE id=? AND app_id=?")
    .bind(app.active_deployment_id, app.id)
    .first<{ content_hash: string }>();
  if (!deployment) return null;
  return {
    appId: app.id,
    slug: app.slug,
    deploymentId: app.active_deployment_id,
    contentHash: deployment.content_hash,
  };
}

/** Load one app grant by ID across Organizations (pre-gate asset route):
 * the ID is a lookup key, never the credential. Unknown IDs answer 404.
 * Form-embed rows never resolve here — the grants are distinct. */
export async function loadAppEmbedGrant(db: D1Database, grantId: string): Promise<AppEmbedGrantRow | null> {
  const row = await db.prepare("SELECT * FROM app_embeds WHERE id=?").bind(grantId).first<AppEmbedGrantRow>();
  return row ?? null;
}

/** Load one grant scoped to its (org, app) admin route: foreign rows
 * resolve to null so the route answers 404, never a cross-tenant signal. */
export async function loadScopedAppGrant(
  db: D1Database,
  orgId: string,
  appId: string,
  grantId: string,
): Promise<AppEmbedGrantRow | null> {
  const row = await loadAppEmbedGrant(db, grantId);
  if (!row || row.org_id !== orgId || row.app_id !== appId.toLowerCase()) return null;
  return row;
}

/** Parse the persisted allowlist of one grant row. Rows are server-written,
 * so a corrupt entry is a server defect (500), never caller input. */
export function readAppAllowedOrigins(row: AppEmbedGrantRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.allowed_origins_json);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error("shape");
    }
    return [...(parsed as string[])];
  } catch {
    throw new Fault(500, "APP_EMBED_MISCONFIGURED", "This app embed grant is not configured correctly.");
  }
}

/** Operator-facing summary: identity, policy, and binding state only.
 * Digests and raw secrets never leave the create/rotate responses. */
export function appEmbedSummary(row: AppEmbedGrantRow): AppEmbedGrantSummary {
  return {
    id: row.id,
    appSlug: row.app_slug,
    allowedOrigins: readAppAllowedOrigins(row),
    fingerprint: row.capability_fingerprint,
    enabled: row.enabled === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    lastUsedAt: row.last_used_at,
  };
}

/** List one app's grants in creation order, summaries only. */
export async function listAppEmbedGrants(
  db: D1Database,
  orgId: string,
  appId: string,
): Promise<AppEmbedGrantSummary[]> {
  const rows = await db
    .prepare("SELECT * FROM app_embeds WHERE org_id=? AND app_id=? ORDER BY created_at,id")
    .bind(orgId, appId.toLowerCase())
    .all<AppEmbedGrantRow>();
  return rows.results.map(appEmbedSummary);
}

function rawAppEmbedSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface CreateAppEmbedInput {
  readonly allowedOrigins: unknown;
  readonly expiresAt?: unknown;
}

/** Issue a grant for one live deployment: validate the origin allowlist
 * and expiry, fingerprint the live deployment, persist the secret digest,
 * and return the raw secret once. The route loads the deployment first
 * (unknown, foreign, or undeployed apps answer 404 there). */
export async function createAppEmbedGrant(
  db: D1Database,
  orgId: string,
  live: AppLiveDeployment,
  input: CreateAppEmbedInput,
): Promise<IssuedAppEmbedGrant> {
  const allowedOrigins = parseAllowedOrigins(input.allowedOrigins);
  const expiresAt = parseAppEmbedExpiry(input.expiresAt);
  const fingerprint = await fingerprintAppDeployment(live.appId, live.contentHash);
  const secret = rawAppEmbedSecret();
  const digest = await hash(secret);
  const id = crypto.randomUUID().toLowerCase();
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO app_embeds(id,org_id,app_id,app_slug,secret_hash,allowed_origins_json,capability_fingerprint,enabled,expires_at,created_at,rotated_at,last_used_at) VALUES (?,?,?,?,?,?,?,1,?,?,NULL,NULL)",
    )
    .bind(id, orgId, live.appId, live.slug, digest, JSON.stringify(allowedOrigins), fingerprint, expiresAt, createdAt)
    .run();
  return {
    row: {
      id,
      org_id: orgId,
      app_id: live.appId,
      app_slug: live.slug,
      secret_hash: digest,
      allowed_origins_json: JSON.stringify(allowedOrigins),
      capability_fingerprint: fingerprint,
      enabled: 1,
      expires_at: expiresAt,
      created_at: createdAt,
      rotated_at: null,
      last_used_at: null,
    },
    secret,
  };
}

/** Verify a presented grant secret. Throws 410 on revoked grants, 401 on
 * expired grants and on wrong/missing secrets. The stored value is a
 * SHA-256 hex digest: digest the supplied secret once and compare digests
 * in constant time (never raw secrets, never a double hash). */
export async function verifyAppEmbedSecret(grant: AppEmbedGrantRow, supplied: string | null): Promise<Principal> {
  if (grant.enabled !== 1) {
    throw new Fault(410, "APP_EMBED_REVOKED", "This app embed grant has been revoked.");
  }
  if (grant.expires_at !== null && Date.parse(grant.expires_at) <= Date.now()) {
    throw new Fault(401, "APP_EMBED_SECRET_EXPIRED", "This app embed grant has expired.");
  }
  if (supplied === null || supplied.length === 0 || supplied.length > 256) {
    throw new Fault(401, "APP_EMBED_UNAUTHORIZED", "A valid app embed secret is required.");
  }
  const suppliedHash = await hash(supplied);
  if (suppliedHash.length !== 64 || grant.secret_hash.length !== 64) {
    throw new Fault(401, "APP_EMBED_UNAUTHORIZED", "A valid app embed secret is required.");
  }
  let difference = 0;
  for (let i = 0; i < 64; i++) {
    difference |= suppliedHash.charCodeAt(i) ^ grant.secret_hash.charCodeAt(i);
  }
  if (difference !== 0) throw new Fault(401, "APP_EMBED_UNAUTHORIZED", "A valid app embed secret is required.");
  return { orgId: grant.org_id, userId: `appembed:${grant.id}` };
}

/** Enforce the exact-match origin allowlist. The failure names no allowed
 * origin — the allowlist is admin state, not an error detail. */
export function checkAppEmbedOrigin(grant: AppEmbedGrantRow, origin: string | null): void {
  if (origin === null || !readAppAllowedOrigins(grant).includes(origin)) {
    throw new Fault(403, "APP_EMBED_ORIGIN_DENIED", "This origin is not allowed for this app embed.");
  }
}

/** Enforce the capability binding: the grant names the deployment it was
 * issued (or last rotated) against. A redeploy (new content_hash), or a
 * delete/recreate that changes the app id under the same slug, answers 409
 * so the admin rotates deliberately instead of silently serving a changed
 * app. */
export async function checkAppEmbedBinding(grant: AppEmbedGrantRow, live: AppLiveDeployment): Promise<void> {
  if (grant.app_id !== live.appId || grant.app_slug !== live.slug) {
    throw new Fault(
      409,
      "APP_EMBED_CAPABILITY_CHANGED",
      "This app changed since the grant was issued. Rotate the grant to re-bind it.",
    );
  }
  const fingerprint = await fingerprintAppDeployment(live.appId, live.contentHash);
  if (grant.capability_fingerprint !== fingerprint) {
    throw new Fault(
      409,
      "APP_EMBED_CAPABILITY_CHANGED",
      "This app changed since the grant was issued. Rotate the grant to re-bind it.",
    );
  }
}

/** Rotate a grant: mint a fresh secret (the old one stops verifying) and
 * re-fingerprint against the live deployment. Unknown or foreign grants
 * answer 404; revoked grants answer 410 (revoke is terminal — create a new
 * grant instead). The route loads the deployment first, so a dangling
 * grant answers 404 there. */
export async function rotateAppEmbedGrant(
  db: D1Database,
  orgId: string,
  live: AppLiveDeployment,
  grantId: string,
): Promise<IssuedAppEmbedGrant> {
  const grant = await loadScopedAppGrant(db, orgId, live.appId, grantId);
  if (!grant) throw new Fault(404, "NOT_FOUND", "Not found.");
  if (grant.enabled !== 1) {
    throw new Fault(410, "APP_EMBED_REVOKED", "This app embed grant has been revoked.");
  }
  const fingerprint = await fingerprintAppDeployment(live.appId, live.contentHash);
  const secret = rawAppEmbedSecret();
  const digest = await hash(secret);
  const rotatedAt = new Date().toISOString();
  await db
    .prepare("UPDATE app_embeds SET secret_hash=?,capability_fingerprint=?,app_id=?,app_slug=?,rotated_at=? WHERE id=?")
    .bind(digest, fingerprint, live.appId, live.slug, rotatedAt, grantId)
    .run();
  return {
    row: {
      ...grant,
      app_id: live.appId,
      app_slug: live.slug,
      secret_hash: digest,
      capability_fingerprint: fingerprint,
      rotated_at: rotatedAt,
    },
    secret,
  };
}

/** Revoke a grant: outstanding secrets stop verifying and outstanding
 * references die on the next read (no TTL grace). Idempotent — revoking
 * twice answers the same revoked summary. Unknown or foreign grants
 * answer 404. */
export async function revokeAppEmbedGrant(
  db: D1Database,
  orgId: string,
  appId: string,
  grantId: string,
): Promise<AppEmbedGrantRow> {
  const grant = await loadScopedAppGrant(db, orgId, appId, grantId);
  if (!grant) throw new Fault(404, "NOT_FOUND", "Not found.");
  await db.prepare("UPDATE app_embeds SET enabled=0 WHERE id=?").bind(grantId).run();
  return { ...grant, enabled: 0 };
}

/** Record a successful asset read for admin hygiene (stale-grant review). */
export async function touchAppEmbedGrantUse(db: D1Database, grantId: string): Promise<void> {
  await db.prepare("UPDATE app_embeds SET last_used_at=? WHERE id=?").bind(new Date().toISOString(), grantId).run();
}

/** Parse an app-embed session principal back to its grant ID. Form-embed
 * (`embed:*`), anonymous (`anon:*`), operator, and service subjects answer
 * null — the three external classes never accept each other's sessions. */
export function appEmbedGrantIdFromUser(userId: string): string | null {
  if (!userId.startsWith("appembed:")) return null;
  const grantId = userId.slice("appembed:".length);
  return UUID.test(grantId) ? grantId.toLowerCase() : null;
}

/** Re-export the grant-ID parser so routes share one unknown-shape rule:
 * unknown shapes answer 404, never a leak. */
export { parseEmbedGrantId as parseAppEmbedGrantId };
