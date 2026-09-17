// SPDX-License-Identifier: AGPL-3.0
// Signed form embeds (EMBED-01 slice 1, issue #156).
//
// A form embed grant is a revocable external capability: per-org/per-form
// secret material that lets an approved web origin bootstrap FORM-02
// startup/submit sessions without an operator session. Shape mirrors the
// two proven local patterns named in the slice brief — TRG-02 endpoint
// credentials (SHA-256 digest storage, show-once raw secret, rotate via
// digest swap, revoke via disable, no readback) and FORM-02 startup handles
// (hash persistence, expiry, single-use fence, STALE_FORM_HANDLE).
//
// Grant identity: one UUID row in `form_embeds` (migration 0035) binding
// (org, form id, form name) to a secret digest, an exact-match origin
// allowlist, and a capability fingerprint (SHA-256 over the bound Saga id
// plus the canonical declaration bytes). The raw secret is returned once at
// create/rotate and never again; D1 keeps only the digest (ADR 005 v0
// posture).
//
// Origin binding: bootstrap and submit both require an exact-match Origin
// header from the allowlist. No wildcards, no suffix matching, no Referer
// fallback — upstream pins exact-match origins with no wildcards
// (`form_runtime.py:358-441`, see docs/upstream-spec.md §17).
//
// Fingerprint rotation: the grant records the declaration fingerprint at
// issue time. A form edit (or delete/recreate, which changes the form id)
// makes the grant stale: bootstrap answers 409 EMBED_CAPABILITY_CHANGED
// and outstanding sessions answer STALE_FORM_HANDLE at submit. Rotating
// re-fingerprints against the live declaration and mints a fresh secret.
// There is no republish-review queue in slice 1 (deferred on #156);
// fail-closed plus rotate is the whole stale-capability story.
//
// Startup binding: embed sessions ARE FORM-02 sessions. Bootstrap mints a
// standard startup handle bound to (org, `embed:<grantId>`, form) through
// startFormSession, and embed submit runs the shared submit core (peek,
// provider re-resolution, declaration gate, standard submit protocol,
// consume-after-admission). Unknown, expired, foreign, already-used, or
// definition-mismatched handles answer 422 STALE_FORM_HANDLE and dispatch
// nothing — the same contract as the operator path.
//
// Revocation: revoke sets enabled=0. Revoked grants deny bootstrap with
// 410 EMBED_REVOKED, and outstanding handles die at submit with
// STALE_FORM_HANDLE (the grant is re-resolved on every submit, so there is
// no TTL grace — the FILE-01 "revocation deletes outstanding tokens"
// posture). Revoke is terminal in slice 1: there is no re-enable, and
// rotating a revoked grant answers 410. Create a new grant instead.
//
// The embed principal (`embed:<grantId>`) holds no membership, no roles,
// and no grants: Table providers resolve through the same caller-scoped
// gate as the operator path and deny by absence, so a form grant can never
// traverse to Tables, live file bytes, another form, an unrelated Saga, or
// another tenant. File-field values are refused outright in slice 1 (there
// is no embed upload path yet, so no reference can prove session
// ownership); session-owned uploads ride a later slice.
//
// What this module is NOT: anonymous/public-form publication (no anonymous
// route ships here — every external call presents the grant secret),
// anti-abuse/CAPTCHA (deferred), app embeds (deferred to slice 2,
// src/apps.ts untouched), or a second execution path (dispatch always
// enters the standard submit protocol with the Execution row first).
import { Fault, hash, UUID } from "./domain";
import type { Principal } from "./domain";
import { serializeFormDeclaration } from "./forms";
import type { FormDefinition } from "./forms";

/** At most 10 exact-match origins per grant: an allowlist, not a pattern. */
export const EMBED_MAX_ORIGINS = 10;
/** One origin serialization holds at most 256 chars (scheme + host + port). */
export const EMBED_ORIGIN_MAX = 256;
/** Port range for origins carrying an explicit port. */
const ORIGIN_PORT_MAX = 65535;

/** Exact-match origin shape: lowercase http(s) scheme, bare host or bracketed
 * IPv6 literal, optional numeric port. No userinfo, path, query, fragment,
 * or wildcard — anything else fails closed at grant creation, never at
 * request time. Case is normalized by rejection: browsers serialize origins
 * lowercase, so an uppercase registration could never match and is refused
 * loudly instead of stored dead. */
const ORIGIN_RE = /^(http|https):\/\/([A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\])(:[0-9]{1,5})?$/;

export interface EmbedGrantRow {
  id: string;
  org_id: string;
  form_id: string;
  form_name: string;
  secret_hash: string;
  allowed_origins_json: string;
  capability_fingerprint: string;
  enabled: number;
  expires_at: string | null;
  created_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
}

export interface EmbedGrantSummary {
  readonly id: string;
  readonly formName: string;
  readonly allowedOrigins: readonly string[];
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly lastUsedAt: string | null;
}

export interface IssuedEmbedGrant {
  readonly row: EmbedGrantRow;
  /** Raw secret, shown once in the create/rotate response and never again. */
  readonly secret: string;
}

function invalid(message: string): Fault {
  return new Fault(400, "INVALID_EMBED", message);
}

/** Parse a grant ID from the route. Unknown shapes answer 404, never a leak. */
export function parseEmbedGrantId(value: string): string {
  if (!UUID.test(value)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return value.toLowerCase();
}

/** Validate one exact-match origin serialization. */
export function parseEmbedOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > EMBED_ORIGIN_MAX) {
    throw invalid("Allowed origins must be 1-256 char origin serializations.");
  }
  if (value !== value.toLowerCase()) {
    throw invalid(`Origin "${value}" must be lowercase: browsers serialize origins lowercase.`);
  }
  if (value.includes("*")) throw invalid(`Origin "${value}" must be exact-match: wildcards are not allowed.`);
  const matched = ORIGIN_RE.exec(value);
  if (!matched) {
    throw invalid(`Origin "${value}" must be http(s)://host[:port] with no path, query, or fragment.`);
  }
  const host = matched[2] as string;
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  // Every dot-separated label is non-empty and never starts or ends with a
  // hyphen (DNS label rule); the whole host is non-empty by construction.
  const labels = host.startsWith("[") ? [bare] : bare.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    throw invalid(`Origin "${value}" names an invalid host.`);
  }
  const port = matched[3];
  if (port !== undefined) {
    const parsed = Number(port.slice(1));
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > ORIGIN_PORT_MAX) {
      throw invalid(`Origin "${value}" names an invalid port.`);
    }
  }
  return value;
}

/** Validate the grant allowlist: 1 to 10 unique exact-match origins. */
export function parseAllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > EMBED_MAX_ORIGINS) {
    throw invalid(`Allowed origins list 1 to ${EMBED_MAX_ORIGINS} exact-match origins.`);
  }
  const parsed = value.map(parseEmbedOrigin);
  if (new Set(parsed).size !== parsed.length) throw invalid("Allowed origins must be unique.");
  return parsed;
}

function parseEmbedExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw invalid("expiresAt must be an ISO 8601 date-time, or null.");
  }
  const at = new Date(Date.parse(value)).toISOString();
  if (Date.parse(at) <= Date.now()) throw invalid("expiresAt must be in the future, or null.");
  return at;
}

/** Parse the persisted allowlist of one grant row. Rows are server-written,
 * so a corrupt entry is a server defect (500), never caller input. */
export function readAllowedOrigins(row: EmbedGrantRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.allowed_origins_json);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error("shape");
    }
    return [...(parsed as string[])];
  } catch {
    throw new Fault(500, "EMBED_MISCONFIGURED", "This embed grant is not configured correctly.");
  }
}

/** Operator-facing summary: identity, policy, and binding state only.
 * Digests and raw secrets never leave the create/rotate responses. */
export function embedSummary(row: EmbedGrantRow): EmbedGrantSummary {
  return {
    id: row.id,
    formName: row.form_name,
    allowedOrigins: readAllowedOrigins(row),
    fingerprint: row.capability_fingerprint,
    enabled: row.enabled === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Capability fingerprint: SHA-256 over the bound Saga id plus the canonical
 * declaration bytes (the same serializer saveForm persists, so a future
 * shape change cannot silently desync fingerprints from declarations). Any
 * designer edit — fields, metadata, prefill opt-in, or a Saga rebind —
 * changes the input, so the stored grant fingerprint stops matching and
 * the grant fails closed until rotated. */
export async function fingerprintFormDef(def: FormDefinition): Promise<string> {
  return hash(JSON.stringify([def.sagaId.toLowerCase(), serializeFormDeclaration(def)]));
}

/** Load one grant by ID across Organizations (pre-gate bootstrap): the ID is
 * a lookup key, never the credential — the secret authenticates, exactly
 * like TRG-02 same-named endpoint resolution. Unknown IDs answer 404. */
export async function loadEmbedGrant(db: D1Database, grantId: string): Promise<EmbedGrantRow | null> {
  const row = await db.prepare("SELECT * FROM form_embeds WHERE id=?").bind(grantId).first<EmbedGrantRow>();
  return row ?? null;
}

/** Load one grant scoped to its (org, form) route: foreign rows resolve to
 * null so the route answers 404, never a cross-tenant signal. */
export async function loadScopedGrant(
  db: D1Database,
  orgId: string,
  formName: string,
  grantId: string,
): Promise<EmbedGrantRow | null> {
  const row = await loadEmbedGrant(db, grantId);
  if (!row || row.org_id !== orgId || row.form_name !== formName) return null;
  return row;
}

/** List one form's grants in creation order, summaries only. */
export async function listEmbedGrants(db: D1Database, orgId: string, formName: string): Promise<EmbedGrantSummary[]> {
  const rows = await db
    .prepare("SELECT * FROM form_embeds WHERE org_id=? AND form_name=? ORDER BY created_at,id")
    .bind(orgId, formName)
    .all<EmbedGrantRow>();
  return rows.results.map(embedSummary);
}

function rawEmbedSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface CreateEmbedInput {
  readonly allowedOrigins: unknown;
  readonly expiresAt?: unknown;
}

/** Issue a grant for one loaded form definition: validate the origin
 * allowlist and expiry, fingerprint the live declaration, persist the
 * secret digest, and return the raw secret once. The route loads the form
 * first (unknown or foreign names answer 404 there). */
export async function createEmbedGrant(
  db: D1Database,
  def: FormDefinition,
  input: CreateEmbedInput,
): Promise<IssuedEmbedGrant> {
  const allowedOrigins = parseAllowedOrigins(input.allowedOrigins);
  const expiresAt = parseEmbedExpiry(input.expiresAt);
  const fingerprint = await fingerprintFormDef(def);
  const secret = rawEmbedSecret();
  const digest = await hash(secret);
  const id = crypto.randomUUID().toLowerCase();
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO form_embeds(id,org_id,form_id,form_name,secret_hash,allowed_origins_json,capability_fingerprint,enabled,expires_at,created_at,rotated_at,last_used_at) VALUES (?,?,?,?,?,?,?,1,?,?,NULL,NULL)",
    )
    .bind(id, def.orgId, def.id, def.name, digest, JSON.stringify(allowedOrigins), fingerprint, expiresAt, createdAt)
    .run();
  return {
    row: {
      id,
      org_id: def.orgId,
      form_id: def.id,
      form_name: def.name,
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
export async function verifyEmbedSecret(grant: EmbedGrantRow, supplied: string | null): Promise<Principal> {
  if (grant.enabled !== 1) {
    throw new Fault(410, "EMBED_REVOKED", "This embed grant has been revoked.");
  }
  if (grant.expires_at !== null && Date.parse(grant.expires_at) <= Date.now()) {
    throw new Fault(401, "EMBED_SECRET_EXPIRED", "This embed grant has expired.");
  }
  if (supplied === null || supplied.length === 0 || supplied.length > 256) {
    throw new Fault(401, "EMBED_UNAUTHORIZED", "A valid embed secret is required.");
  }
  const suppliedHash = await hash(supplied);
  if (suppliedHash.length !== 64 || grant.secret_hash.length !== 64) {
    throw new Fault(401, "EMBED_UNAUTHORIZED", "A valid embed secret is required.");
  }
  let difference = 0;
  for (let i = 0; i < 64; i++) {
    difference |= suppliedHash.charCodeAt(i) ^ grant.secret_hash.charCodeAt(i);
  }
  if (difference !== 0) throw new Fault(401, "EMBED_UNAUTHORIZED", "A valid embed secret is required.");
  return { orgId: grant.org_id, userId: `embed:${grant.id}` };
}

/** Enforce the exact-match origin allowlist. The failure names no allowed
 * origin — the allowlist is admin state, not an error detail. */
export function checkEmbedOrigin(grant: EmbedGrantRow, origin: string | null): void {
  if (origin === null || !readAllowedOrigins(grant).includes(origin)) {
    throw new Fault(403, "EMBED_ORIGIN_DENIED", "This origin is not allowed for this embed.");
  }
}

/** Enforce the capability binding: the grant names the declaration it was
 * issued (or last rotated) against. A form edit, or a delete/recreate that
 * changes the form id under the same name, answers 409 so the admin
 * rotates deliberately instead of silently serving a changed form. */
export function checkEmbedBinding(grant: EmbedGrantRow, live: { formId: string; fingerprint: string }): void {
  if (grant.form_id !== live.formId || grant.capability_fingerprint !== live.fingerprint) {
    throw new Fault(
      409,
      "EMBED_CAPABILITY_CHANGED",
      "This form changed since the grant was issued. Rotate the grant to re-bind it.",
    );
  }
}

/** Rotate a grant: mint a fresh secret (the old one stops verifying) and
 * re-fingerprint against the live declaration. Unknown or foreign grants
 * answer 404; revoked grants answer 410 (revoke is terminal — create a new
 * grant instead). The route loads the form first, so a dangling grant
 * answers 404 there. */
export async function rotateEmbedGrant(
  db: D1Database,
  def: FormDefinition,
  grantId: string,
): Promise<IssuedEmbedGrant> {
  const grant = await loadScopedGrant(db, def.orgId, def.name, grantId);
  if (!grant) throw new Fault(404, "NOT_FOUND", "Not found.");
  if (grant.enabled !== 1) {
    throw new Fault(410, "EMBED_REVOKED", "This embed grant has been revoked.");
  }
  const fingerprint = await fingerprintFormDef(def);
  const secret = rawEmbedSecret();
  const digest = await hash(secret);
  const rotatedAt = new Date().toISOString();
  await db
    .prepare("UPDATE form_embeds SET secret_hash=?,capability_fingerprint=?,form_id=?,rotated_at=? WHERE id=?")
    .bind(digest, fingerprint, def.id, rotatedAt, grantId)
    .run();
  return {
    row: {
      ...grant,
      form_id: def.id,
      secret_hash: digest,
      capability_fingerprint: fingerprint,
      rotated_at: rotatedAt,
    },
    secret,
  };
}

/** Revoke a grant: outstanding secrets stop verifying and outstanding
 * sessions die at submit (no TTL grace). Idempotent — revoking twice
 * answers the same revoked summary. Unknown or foreign grants answer 404. */
export async function revokeEmbedGrant(
  db: D1Database,
  orgId: string,
  formName: string,
  grantId: string,
): Promise<EmbedGrantRow> {
  const grant = await loadScopedGrant(db, orgId, formName, grantId);
  if (!grant) throw new Fault(404, "NOT_FOUND", "Not found.");
  await db.prepare("UPDATE form_embeds SET enabled=0 WHERE id=?").bind(grantId).run();
  return { ...grant, enabled: 0 };
}

/** Record a successful bootstrap for admin hygiene (stale-grant review). */
export async function touchEmbedGrantUse(db: D1Database, grantId: string): Promise<void> {
  await db.prepare("UPDATE form_embeds SET last_used_at=? WHERE id=?").bind(new Date().toISOString(), grantId).run();
}

/** Parse an embed session principal back to its grant ID. Operator user IDs
 * (UUIDs, `endpoint:*`, service subjects) answer null — embed routes and
 * operator routes never accept each other's sessions. */
export function embedGrantIdFromUser(userId: string): string | null {
  if (!userId.startsWith("embed:")) return null;
  const grantId = userId.slice("embed:".length);
  return UUID.test(grantId) ? grantId.toLowerCase() : null;
}

/** Slice-1 file posture: embedded submissions carry no caller-supplied file
 * references. There is no embed upload path yet, so no reference can prove
 * session ownership ("session-owned file uploads only" over an empty
 * session-owned set). Runs on the raw submitted values after the declaration
 * gate (same slot as the operator FILE-01 re-validation): unknown shapes
 * are the validator's to reject, absent or explicitly cleared fields pass,
 * and any presented reference fails closed with 422. Author-declared file
 * defaults are server-side, never caller input, so they are out of scope
 * here and merge normally. */
export function assertNoEmbedFileRefs(
  fields: readonly { readonly name: string; readonly type: string }[],
  values: unknown,
): void {
  if (values === null || typeof values !== "object" || Array.isArray(values)) return;
  const record = values as Record<string, unknown>;
  for (const field of fields) {
    if (field.type !== "file") continue;
    const presented = record[field.name];
    if (presented === undefined || presented === null) continue;
    throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
      {
        field: field.name,
        code: "FILE_NOT_SESSION_OWNED",
        message: "Embedded submissions accept session-owned uploads only.",
      },
    ]);
  }
}
