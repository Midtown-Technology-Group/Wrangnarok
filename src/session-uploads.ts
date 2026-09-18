// SPDX-License-Identifier: AGPL-3.0
// Session-owned uploads for external form sessions (EMBED-01 slice 3, issue
// #156).
//
// Slices 1-2 refused every caller-supplied file reference on the external
// submit paths (signed form embeds in src/embeds.ts, anonymous publication
// in src/public-forms.ts): with no upload path, no reference could prove
// session ownership. That fail-closed posture made forms with file fields
// unsubmittable from embeds and public links. This module is the upload
// path those postures deferred to: a startup session may stage bytes into
// the form field's declared FILE-01 location and submit references to
// exactly what it staged — nothing else.
//
// Ownership is structural, not advisory. Issuance mints a server-chosen
// path (`session-uploads/<uuid>`) the client cannot pick, records the
// (session hash, org, location, path) claim plus the field's size/type
// bounds, and returns a single-use FILE-01 upload token. The byte PUT and
// the finalize both re-verify against that claim; submit requires every
// presented file reference to name a claimed triple for the submitting
// session. A reference staged by another session, by an operator, or by a
// sibling Organization answers 422 FILE_NOT_SESSION_OWNED — the same code
// the refusal used, so the traversal verdict is unchanged, only the
// session-owned set is no longer empty.
//
// What this module does NOT do: operator uploads (the authed FILE-01
// routes own those), app-embed uploads (asset reads dispatch nothing, so
// there is nothing to attach an upload to), or anti-abuse beyond the
// session binding (single-use tokens, a per-session issuance cap, and the
// 30-minute session TTL that bounds every claim). CAPTCHA/Turnstile stays
// deferred per the slice-2 ADR.
import { Fault } from "./domain";
import type { FormField, FormFilePolicy } from "./forms";

/** Upload slots live 10 minutes: long enough to PUT + finalize, short
 * enough that a leaked token is barely useful. The session TTL (30 min)
 * bounds the claim regardless. */
export const SESSION_UPLOAD_TTL_SECONDS = 600;
/** At most 10 issued uploads per startup session: one per file field with
 * headroom for retries, without letting an anonymous session fill a
 * location one slot at a time. */
export const SESSION_UPLOADS_MAX = 10;
/** Server-minted path namespace for session uploads. Clients never choose
 * paths, so a session cannot alias an operator file and two sessions
 * cannot alias each other. */
export const SESSION_UPLOAD_PATH_PREFIX = "session-uploads/";

export interface SessionUploadField {
  readonly field: string;
  readonly location: string;
  readonly maxBytes: number;
  readonly contentTypes: readonly string[];
}

export interface SessionUploadClaim extends SessionUploadField {
  readonly sessionHash: string;
  readonly orgId: string;
  readonly path: string;
  readonly createdAt: string;
}

interface SessionUploadRow {
  session_hash: string;
  org_id: string;
  location: string;
  path: string;
  field: string;
  max_bytes: number;
  content_types_json: string;
  created_at: string;
}

function toClaim(row: SessionUploadRow): SessionUploadClaim {
  let types: unknown;
  try {
    types = JSON.parse(row.content_types_json);
  } catch {
    throw new Error("Session upload carries invalid content-type metadata.");
  }
  if (!Array.isArray(types) || types.some((entry) => typeof entry !== "string")) {
    throw new Error("Session upload carries invalid content-type metadata.");
  }
  return {
    sessionHash: row.session_hash,
    orgId: row.org_id,
    location: row.location,
    path: row.path,
    field: row.field,
    maxBytes: row.max_bytes,
    contentTypes: types as string[],
    createdAt: row.created_at,
  };
}

/** Resolve one declared file field for session upload: unknown names and
 * non-file fields fail closed with 400 (the declaration, not the session,
 * decides what is uploadable). The returned bounds ride the issuance
 * record so finalize and submit enforce the field policy, not just the
 * location policy. */
export function parseSessionUploadField(fields: readonly FormField[], value: unknown): SessionUploadField {
  if (typeof value !== "string" || value.length === 0) {
    throw new Fault(400, "INVALID_UPLOAD", "Uploads name one declared file field.");
  }
  const field = fields.find((entry) => entry.name === value);
  if (!field || field.type !== "file") {
    throw new Fault(400, "INVALID_UPLOAD", `Field "${value}" is not an uploadable file field.`);
  }
  const policy: FormFilePolicy | undefined = field.file;
  if (!policy) throw new Fault(400, "INVALID_UPLOAD", `Field "${value}" declares no file policy.`);
  return {
    field: field.name,
    location: policy.location,
    maxBytes: (policy.maxMb ?? 25) * 1024 * 1024,
    contentTypes: policy.contentTypes ?? [],
  };
}

/** Mint a server-chosen upload path. The UUID is unguessable, so knowing
 * another session's path is never a traversal input — and the submit
 * check would still refuse it without a matching ownership claim. */
export function mintSessionUploadPath(): string {
  return `${SESSION_UPLOAD_PATH_PREFIX}${crypto.randomUUID().toLowerCase()}`;
}

/** Record one issued session upload claim. The (session, location, path)
 * triple is unique by construction (fresh UUID path per issuance). */
export async function recordSessionUpload(
  db: D1Database,
  claim: { sessionHash: string; orgId: string } & SessionUploadField & { path: string },
): Promise<SessionUploadClaim> {
  const createdAt = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO form_session_uploads(session_hash,org_id,location,path,field,max_bytes,content_types_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(
      claim.sessionHash,
      claim.orgId,
      claim.location,
      claim.path,
      claim.field,
      claim.maxBytes,
      JSON.stringify(claim.contentTypes),
      createdAt,
    )
    .run();
  return {
    sessionHash: claim.sessionHash,
    orgId: claim.orgId,
    location: claim.location,
    path: claim.path,
    field: claim.field,
    maxBytes: claim.maxBytes,
    contentTypes: claim.contentTypes,
    createdAt,
  };
}

/** Count live claims for one session (per-session issuance cap). */
export async function countSessionUploads(db: D1Database, sessionHash: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM form_session_uploads WHERE session_hash=?")
    .bind(sessionHash)
    .first<{ total: number }>()
    .catch(() => null);
  return row?.total ?? 0;
}

/** Ownership-map key for one (location, path) triple. Locations exclude
 * spaces by grammar (lowercase alphanumerics and dashes) and paths
 * exclude them by segment rule, so the join is unambiguous. Exported so
 * routes and the submit core key the map identically. */
export function sessionUploadKey(location: string, path: string): string {
  return `${location} ${path}`;
}

/** Load one session's claims in this Organization, keyed by
 * {@link sessionUploadKey} for the submit ownership check. */
export async function loadSessionUploads(
  db: D1Database,
  sessionHash: string,
  orgId: string,
): Promise<Map<string, SessionUploadClaim>> {
  const rows = await db
    .prepare("SELECT * FROM form_session_uploads WHERE session_hash=? AND org_id=?")
    .bind(sessionHash, orgId)
    .all<SessionUploadRow>()
    .catch(() => ({ results: [] as SessionUploadRow[] }));
  const owned = new Map<string, SessionUploadClaim>();
  for (const row of rows.results) {
    owned.set(sessionUploadKey(row.location, row.path), toClaim(row));
  }
  return owned;
}

/** Session file posture for the external submit paths: every presented
 * file value must name a (location, path) triple this session issued.
 * Absent or explicitly cleared fields pass; malformed shapes are the
 * declaration validator's to reject (skipped here, never ownership-ok);
 * anything else fails closed with 422 FILE_NOT_SESSION_OWNED — the same
 * envelope the slice-1 refusal used, so existing traversal verdicts keep
 * their shape. Author-declared file defaults are server-side, never
 * caller input, so they merge past this raw-values check exactly as
 * before and re-validate against the live FILE-01 rows downstream. */
export function assertSessionOwnedFileRefs(
  fields: readonly { readonly name: string; readonly type: string }[],
  values: unknown,
  owned: ReadonlyMap<string, SessionUploadClaim>,
): void {
  if (values === null || typeof values !== "object" || Array.isArray(values)) return;
  const record = values as Record<string, unknown>;
  for (const field of fields) {
    if (field.type !== "file") continue;
    const presented = record[field.name];
    if (presented === undefined || presented === null) continue;
    if (
      typeof presented !== "object" ||
      Array.isArray(presented) ||
      typeof (presented as Record<string, unknown>).location !== "string" ||
      typeof (presented as Record<string, unknown>).path !== "string"
    ) {
      continue;
    }
    const ref = presented as { location: string; path: string };
    if (!owned.has(sessionUploadKey(ref.location, ref.path))) {
      throw new Fault(422, "FORM_VALIDATION_FAILED", "The form submission did not pass validation.", [
        {
          field: field.name,
          code: "FILE_NOT_SESSION_OWNED",
          message: "Embedded submissions accept session-owned uploads only.",
        },
      ]);
    }
  }
}
