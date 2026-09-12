// SPDX-License-Identifier: AGPL-3.0
// Generated Artifacts and attachment lifecycles with retention (FILE-02,
// issue #158; ADR 019).
//
// An Artifact is an Organization-scoped record for generated or uploaded
// bytes: stable UUID identity (ADR 002 rules), a human name, MIME claim, byte
// size, an integer version, and an active/deleted status marker. Runtime bytes
// live in the R2 bucket (env.ARTIFACTS, one object key per Artifact version);
// D1 carries identity, ownership, versions, attachment bindings, and the
// retention policy. No Portable bundle embeds runtime bytes (OPS-03 owns the
// encrypted full-backup exception).
//
// Ownership and access (ADR 019 section 3, composed with AUTH-01):
// - Canonical access (metadata, bytes, rename, delete): the Artifact row must
//   sit in the caller's resolved Organization (membership gate first), and
//   the caller must be the creator or an admin. Admin is the resolved
//   CallerCtx: instance admins (ADMIN_USER_IDS) plus Organization admins
//   (membership row). No self-asserted header, no separate role table.
// - Attachment-binding access (CHAT_BINDING_* codes): a binding row names the
//   (scope, refId) the bytes were attached to. Listing bindings answers only
//   the binding triple (artifactId, scope, refId) so a chat reader learns
//   which Artifact backs the attachment without reading the bytes. Reading
//   attachment bytes requires the canonical check above, never the binding.
// - Foreign rows answer 404 (ARTIFACT_NOT_FOUND), never a leak; same-Org
//   non-creator non-admin reads answer 403 (ARTIFACT_FORBIDDEN).
//
// Versions: uploading the same name again appends a new integer version to
// the SAME Artifact row (same stable UUID, same bindings). This is NOT an
// optimistic version-conflict API: there is no If-Match / stale-version 409.
// The current version always wins for preview/download; older bytes stay
// addressable by version number until the Artifact (or its retention) goes.
//
// Retention (ADR 019 section 4): expiry is pinned by Artifact.created_at
// (upstream invariant), never last access. Cleanup is explicit: preview lists
// what WOULD be deleted (no writes), run deletes in one bounded batch and
// reports per-row outcomes plus an interrupted remainder. Deleted rows keep
// their D1 metadata row (status deleted) while the R2 object bytes are
// removed; bindings cascade-delete with the bytes they describe.
import { Fault, UUID } from "./domain";
import type { Principal } from "./domain";

/** R2 object-key layout: one object per Artifact version. */
export function artifactObjectKey(artifactId: string, version: number): string {
  return `artifacts/${artifactId}/v${version}`;
}

export type ArtifactStatus = "active" | "deleted";
export type ArtifactBindingScope = "execution" | "workspace" | "conversation";

export interface ArtifactSummary {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly version: number;
  readonly status: ArtifactStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  readonly orgId: string;
  readonly creatorUserId: string;
  readonly deletedAt: string | null;
  readonly versions: readonly {
    readonly version: number;
    readonly mime: string;
    readonly sizeBytes: number;
    readonly createdAt: string;
  }[];
  readonly bindings: readonly { readonly scope: ArtifactBindingScope; readonly refId: string }[];
}

export interface ArtifactBindingView {
  readonly artifactId: string;
  readonly scope: ArtifactBindingScope;
  readonly refId: string;
}

/** Generated-output format/provider subcapabilities (issue acceptance: track
 * as unchecked subcapabilities, never require Python rendering on Workers). */
export const ARTIFACT_FORMATS = ["pdf", "docx", "xlsx", "csv", "html", "markdown", "json", "text"] as const;
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

export const ARTIFACT_FORMAT_STATUS: Readonly<Record<ArtifactFormat, "deferred">> = Object.freeze({
  pdf: "deferred",
  docx: "deferred",
  xlsx: "deferred",
  csv: "deferred",
  html: "deferred",
  markdown: "deferred",
  json: "deferred",
  text: "deferred",
});

/** Per-surface byte caps, stated explicitly (upstream finding 16: caps are
 * per-surface, not global). */
export const ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;
export const ARTIFACT_NAME_MAX = 256;
export const ARTIFACT_MAX_VERSIONS = 100;
export const ARTIFACT_LIST_LIMIT_DEFAULT = 20;
export const ARTIFACT_LIST_LIMIT_MAX = 50;
export const ARTIFACT_CLEANUP_BATCH_MAX = 100;
/** Default retention window (upstream default): 90 days, range 1-3650. */
export const ARTIFACT_RETENTION_DEFAULT_DAYS = 90;
export const ARTIFACT_RETENTION_MIN_DAYS = 1;
export const ARTIFACT_RETENTION_MAX_DAYS = 3650;

/** MIME allowlist: explicit, boring, no sniffing. */
const ARTIFACT_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const BINDING_SCOPES: readonly ArtifactBindingScope[] = ["execution", "workspace", "conversation"];

/** Printable-text check without control-char regex classes (lint-clean): no
 * C0 controls and no DEL. */
function isPrintableName(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return new Fault(status, code, message, details);
}

export function parseArtifactId(value: string): string {
  if (!UUID.test(value)) throw invalid("INVALID_ARTIFACT_ID", "Artifact lookups need the exact Artifact UUID.", 400);
  return value.toLowerCase();
}

export function parseArtifactName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ARTIFACT_NAME_MAX) {
    throw invalid("INVALID_ARTIFACT", `Artifact name must be 1 to ${ARTIFACT_NAME_MAX} chars.`);
  }
  if (!isPrintableName(value)) throw invalid("INVALID_ARTIFACT", "Artifact name must be printable text.");
  if (value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw invalid("INVALID_ARTIFACT", "Artifact name must not be a path.");
  }
  return value;
}

export function parseArtifactMime(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !ARTIFACT_MIME.test(value.toLowerCase())
  ) {
    throw invalid("INVALID_ARTIFACT", "Artifact MIME must be a type/subtype token.");
  }
  return value.toLowerCase();
}

export function parseArtifactVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ARTIFACT_MAX_VERSIONS) {
    throw invalid("INVALID_VERSION", `Artifact version must be an integer from 1 to ${ARTIFACT_MAX_VERSIONS}.`);
  }
  return value;
}

export function parseBindingScope(value: unknown): ArtifactBindingScope {
  if (typeof value !== "string" || !(BINDING_SCOPES as readonly string[]).includes(value)) {
    throw invalid("INVALID_BINDING", "Binding scope must be execution, workspace, or conversation.");
  }
  return value as ArtifactBindingScope;
}

export function parseBindingRef(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw invalid("INVALID_BINDING", "Binding ref must be 1 to 128 chars.");
  }
  return value;
}

export function parseRetentionDays(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < ARTIFACT_RETENTION_MIN_DAYS ||
    value > ARTIFACT_RETENTION_MAX_DAYS
  ) {
    throw invalid(
      "INVALID_RETENTION",
      `Retention must be an integer from ${ARTIFACT_RETENTION_MIN_DAYS} to ${ARTIFACT_RETENTION_MAX_DAYS} days.`,
    );
  }
  return value;
}

/** Explicit admin bypass (ADR 019 section 3, composed with AUTH-01): the
 * resolved CallerCtx carries the answer. Instance admins (the deployment
 * ADMIN_USER_IDS list, install state never in Git) and Organization admins
 * (the membership row) bypass the creator check. Everything else is
 * deny-by-absence. */
export interface ArtifactAdminCtx {
  readonly isInstanceAdmin: boolean;
  readonly isOrgAdmin: boolean;
}

export function isAdminCaller(ctx: ArtifactAdminCtx): boolean {
  return ctx.isInstanceAdmin || ctx.isOrgAdmin;
}

interface ArtifactRow {
  id: string;
  org_id: string;
  creator_user_id: string;
  name: string;
  mime: string;
  size_bytes: number;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    version: row.version,
    status: row.status as ArtifactStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadRow(db: D1Database, orgId: string, id: string): Promise<ArtifactRow | null> {
  return db.prepare("SELECT * FROM artifacts WHERE id=? AND org_id=?").bind(id, orgId).first<ArtifactRow>();
}

/** Canonical gate: same-Organization row (else 404), then creator-or-admin
 * (else 403). Deleted rows answer 404 to non-admins, 410 to admins so
 * operators can distinguish "gone" from "never existed". */
async function requireCanonical(db: D1Database, caller: Principal, id: string, admin: boolean): Promise<ArtifactRow> {
  const row = await loadRow(db, caller.orgId, id);
  if (!row) throw invalid("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
  if (row.status === "deleted" && !admin) throw invalid("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
  if (row.status === "deleted" && admin) throw invalid("ARTIFACT_GONE", "Artifact is deleted.", 410);
  if (row.creator_user_id !== caller.userId && !admin) {
    throw invalid("ARTIFACT_FORBIDDEN", "Only the creator or an admin may access this Artifact.", 403);
  }
  return row;
}

async function readVersions(db: D1Database, artifactId: string) {
  const rows = await db
    .prepare("SELECT version, mime, size_bytes, created_at FROM artifact_versions WHERE artifact_id=? ORDER BY version")
    .bind(artifactId)
    .all<{ version: number; mime: string; size_bytes: number; created_at: string }>();
  return rows.results.map((row) => ({
    version: row.version,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }));
}

async function readBindings(db: D1Database, artifactId: string) {
  const rows = await db
    .prepare("SELECT scope, ref_id FROM artifact_bindings WHERE artifact_id=? ORDER BY scope, ref_id")
    .bind(artifactId)
    .all<{ scope: string; ref_id: string }>();
  return rows.results.map((row) => ({ scope: row.scope as ArtifactBindingScope, refId: row.ref_id }));
}

export interface ArtifactStore {
  readonly db: D1Database;
  readonly bucket: R2Bucket | undefined;
}

function requireBucket(store: ArtifactStore): R2Bucket {
  if (!store.bucket) throw invalid("ARTIFACT_STORE_NOT_CONFIGURED", "Artifact byte storage is not configured.", 503);
  return store.bucket;
}

/** Same-filename versioning (issue acceptance): uploading the same name
 * again appends a new integer version to the SAME Artifact row (same stable
 * UUID, same bindings). This is not an optimistic version-conflict API: no
 * If-Match, no stale-version 409 on re-upload; the current version pointer
 * always advances. Lookup is (org, creator, name) so one creator's names
 * never collide with another's. */
export async function createOrVersionArtifact(
  store: ArtifactStore,
  caller: Principal,
  body: { name: unknown; mime: unknown; bytes: Uint8Array },
): Promise<{ artifact: ArtifactDetail; created: boolean }> {
  const name = parseArtifactName(body.name);
  const existing = await store.db
    .prepare("SELECT id FROM artifacts WHERE org_id=? AND creator_user_id=? AND name=? AND status='active'")
    .bind(caller.orgId, caller.userId, name)
    .first<{ id: string }>();
  if (!existing) {
    return { artifact: await createArtifact(store, caller, body), created: true };
  }
  return { artifact: await uploadArtifactVersion(store, caller, existing.id, false, body), created: false };
}

/** Create an Artifact row plus its first version row plus the R2 object.
 * Upload completion is verified: the bytes are written BEFORE the version
 * row commits, and a failed R2 write deletes the Artifact row so no orphan
 * metadata survives (failed-write cleanup). */
export async function createArtifact(
  store: ArtifactStore,
  caller: Principal,
  body: { name: unknown; mime: unknown; bytes: Uint8Array },
): Promise<ArtifactDetail> {
  const name = parseArtifactName(body.name);
  const mime = parseArtifactMime(body.mime);
  if (body.bytes.byteLength === 0) throw invalid("EMPTY_ARTIFACT", "Artifact bytes must not be empty.");
  if (body.bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw invalid("ARTIFACT_TOO_LARGE", `Artifact bytes must fit ${ARTIFACT_MAX_BYTES} bytes.`, 413);
  }
  const bucket = requireBucket(store);
  const id = crypto.randomUUID().toLowerCase();
  const now = new Date().toISOString();
  await store.db
    .prepare(
      "INSERT INTO artifacts(id,org_id,creator_user_id,name,mime,size_bytes,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(id, caller.orgId, caller.userId, name, mime, body.bytes.byteLength, 1, now, now)
    .run();
  try {
    await bucket.put(artifactObjectKey(id, 1), body.bytes.slice().buffer as ArrayBuffer, {
      httpMetadata: { contentType: mime },
    });
  } catch {
    // Failed-write cleanup: the R2 write failed, so remove the metadata row.
    await store.db.prepare("DELETE FROM artifacts WHERE id=?").bind(id).run();
    throw invalid("ARTIFACT_WRITE_FAILED", "Artifact bytes could not be stored.", 503);
  }
  await store.db
    .prepare("INSERT INTO artifact_versions(id,artifact_id,version,mime,size_bytes,created_at) VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID().toLowerCase(), id, 1, mime, body.bytes.byteLength, now)
    .run();
  const row = (await loadRow(store.db, caller.orgId, id)) as ArtifactRow;
  return {
    ...toSummary(row),
    orgId: row.org_id,
    creatorUserId: row.creator_user_id,
    deletedAt: null,
    versions: await readVersions(store.db, id),
    bindings: [],
  };
}

/** Upload a new version to the SAME Artifact row (same stable UUID). Same
 * filename versioning, not an optimistic version-conflict API: no If-Match,
 * no stale-version 409; the current version pointer always advances. */
export async function uploadArtifactVersion(
  store: ArtifactStore,
  caller: Principal,
  id: string,
  admin: boolean,
  body: { mime: unknown; bytes: Uint8Array },
): Promise<ArtifactDetail> {
  const row = await requireCanonical(store.db, caller, parseArtifactId(id), admin);
  const mime = parseArtifactMime(body.mime);
  if (body.bytes.byteLength === 0) throw invalid("EMPTY_ARTIFACT", "Artifact bytes must not be empty.");
  if (body.bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw invalid("ARTIFACT_TOO_LARGE", `Artifact bytes must fit ${ARTIFACT_MAX_BYTES} bytes.`, 413);
  }
  if (row.version >= ARTIFACT_MAX_VERSIONS) {
    throw invalid("VERSION_LIMIT", `Artifacts keep at most ${ARTIFACT_MAX_VERSIONS} versions.`, 409);
  }
  const bucket = requireBucket(store);
  const next = row.version + 1;
  const now = new Date().toISOString();
  try {
    await bucket.put(artifactObjectKey(row.id, next), body.bytes.slice().buffer as ArrayBuffer, {
      httpMetadata: { contentType: mime },
    });
  } catch {
    throw invalid("ARTIFACT_WRITE_FAILED", "Artifact bytes could not be stored.", 503);
  }
  await store.db
    .prepare("INSERT INTO artifact_versions(id,artifact_id,version,mime,size_bytes,created_at) VALUES (?,?,?,?,?,?)")
    .bind(crypto.randomUUID().toLowerCase(), row.id, next, mime, body.bytes.byteLength, now)
    .run();
  // Fenced on the pre-write version: a lost race surfaces VERSION_RACE (409),
  // never a silent fork. The orphan R2 object for the loser is reclaimed by
  // retention cleanup (unreferenced keys are never served).
  const applied = await store.db
    .prepare("UPDATE artifacts SET mime=?, size_bytes=?, version=?, updated_at=? WHERE id=? AND version=?")
    .bind(mime, body.bytes.byteLength, next, now, row.id, row.version)
    .run();
  if (applied.meta.changes === 0) {
    await bucket.delete(artifactObjectKey(row.id, next));
    throw invalid("VERSION_RACE", "Artifact version changed under upload: retry the version upload.", 409);
  }
  const fresh = (await loadRow(store.db, caller.orgId, row.id)) as ArtifactRow;
  return {
    ...toSummary(fresh),
    orgId: fresh.org_id,
    creatorUserId: fresh.creator_user_id,
    deletedAt: fresh.deleted_at,
    versions: await readVersions(store.db, row.id),
    bindings: await readBindings(store.db, row.id),
  };
}

export async function listArtifacts(
  db: D1Database,
  caller: Principal,
  query: { limit?: number; includeDeleted?: boolean },
): Promise<{ artifacts: ArtifactSummary[]; hasMore: boolean }> {
  const limit = query.limit ?? ARTIFACT_LIST_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_LIST_LIMIT_MAX) {
    throw invalid("INVALID_LIMIT", `Limit must be an integer from 1 to ${ARTIFACT_LIST_LIMIT_MAX}.`);
  }
  const statusFilter = query.includeDeleted === true ? "" : "AND status='active'";
  const rows = await db
    .prepare(`SELECT * FROM artifacts WHERE org_id=? ${statusFilter} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(caller.orgId, limit + 1)
    .all<ArtifactRow>();
  const page = rows.results.slice(0, limit);
  return { artifacts: page.map(toSummary), hasMore: rows.results.length > limit };
}

export async function artifactDetail(
  db: D1Database,
  caller: Principal,
  id: string,
  admin: boolean,
): Promise<ArtifactDetail> {
  const row = await requireCanonical(db, caller, parseArtifactId(id), admin);
  return {
    ...toSummary(row),
    orgId: row.org_id,
    creatorUserId: row.creator_user_id,
    deletedAt: row.deleted_at,
    versions: await readVersions(db, row.id),
    bindings: await readBindings(db, row.id),
  };
}

/** Preview bytes WITHOUT moving any pointer: returns the bytes plus their
 * content type for the current version, or one addressed older version. */
export async function previewArtifact(
  store: ArtifactStore,
  caller: Principal,
  id: string,
  admin: boolean,
  version?: number,
): Promise<{ bytes: Uint8Array; mime: string; version: number }> {
  const row = await requireCanonical(store.db, caller, parseArtifactId(id), admin);
  const want = version ?? row.version;
  parseArtifactVersion(want);
  const bucket = requireBucket(store);
  const object = await bucket.get(artifactObjectKey(row.id, want));
  if (!object) throw invalid("ARTIFACT_BYTES_MISSING", "Artifact metadata exists but the stored bytes are gone.", 404);
  const meta = await dbVersionMime(store.db, row.id, want);
  return { bytes: new Uint8Array(await object.arrayBuffer()), mime: meta ?? row.mime, version: want };
}

async function dbVersionMime(db: D1Database, artifactId: string, version: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT mime FROM artifact_versions WHERE artifact_id=? AND version=?")
    .bind(artifactId, version)
    .first<{ mime: string }>();
  return row?.mime ?? null;
}

/** Download is the same byte path as preview with an explicit filename
 * disposition decided by the route, not the store. Kept separate so the
 * route can set Content-Disposition without changing byte semantics. */
export async function downloadArtifact(
  store: ArtifactStore,
  caller: Principal,
  id: string,
  admin: boolean,
  version?: number,
): Promise<{ bytes: Uint8Array; mime: string; name: string; version: number }> {
  const row = await requireCanonical(store.db, caller, parseArtifactId(id), admin);
  const preview = await previewArtifact(store, caller, row.id, admin, version);
  return { ...preview, name: row.name };
}

/** Rename (upstream chat.py:388-432 evidence: rename is a metadata write on
 * the canonical record, not a version event and not a byte move). */
export async function renameArtifact(
  db: D1Database,
  caller: Principal,
  id: string,
  admin: boolean,
  name: unknown,
): Promise<ArtifactSummary> {
  const row = await requireCanonical(db, caller, parseArtifactId(id), admin);
  const next = parseArtifactName(name);
  const now = new Date().toISOString();
  await db.prepare("UPDATE artifacts SET name=?, updated_at=? WHERE id=?").bind(next, now, row.id).run();
  const fresh = (await loadRow(db, caller.orgId, row.id)) as ArtifactRow;
  return toSummary(fresh);
}

/** Soft delete: the D1 metadata row survives (status deleted) so listings
 * can distinguish gone from never-existed; the R2 object bytes for EVERY
 * version are removed and bindings cascade. R2 goes first: an interruption
 * between the byte deletes and the D1 marker leaves an active row the next
 * cleanup run picks up (R2 deletes are idempotent), never a deleted marker
 * over surviving bytes. */
export async function deleteArtifact(
  store: ArtifactStore,
  caller: Principal,
  id: string,
  admin: boolean,
): Promise<void> {
  const row = await requireCanonical(store.db, caller, parseArtifactId(id), admin);
  const bucket = requireBucket(store);
  const versions = await readVersions(store.db, row.id);
  try {
    for (const entry of versions) {
      await bucket.delete(artifactObjectKey(row.id, entry.version));
    }
  } catch {
    throw invalid("ARTIFACT_WRITE_FAILED", "Artifact bytes could not be removed.", 503);
  }
  const now = new Date().toISOString();
  await store.db
    .prepare("UPDATE artifacts SET status='deleted', updated_at=?, deleted_at=? WHERE id=?")
    .bind(now, now, row.id)
    .run();
  await store.db.prepare("DELETE FROM artifact_bindings WHERE artifact_id=?").bind(row.id).run();
  await store.db.prepare("DELETE FROM artifact_versions WHERE artifact_id=?").bind(row.id).run();
}

/** Attach bytes to a (scope, refId): the binding names which conversation /
 * workspace / execution the Artifact backs. The attachment reader learns the
 * triple only; byte reads still need the canonical gate. */
export async function bindAttachment(
  db: D1Database,
  caller: Principal,
  id: string,
  admin: boolean,
  binding: { scope: unknown; refId: unknown },
): Promise<ArtifactBindingView> {
  const row = await requireCanonical(db, caller, parseArtifactId(id), admin);
  const scope = parseBindingScope(binding.scope);
  const refId = parseBindingRef(binding.refId);
  const bindingId = crypto.randomUUID().toLowerCase();
  const now = new Date().toISOString();
  const inserted = await db
    .prepare(
      "INSERT INTO artifact_bindings(id,artifact_id,org_id,scope,ref_id,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(artifact_id,scope,ref_id) DO NOTHING",
    )
    .bind(bindingId, row.id, caller.orgId, scope, refId, now)
    .run();
  if (inserted.meta.changes === 0) {
    throw invalid("BINDING_EXISTS", "This Artifact is already bound to that reference.", 409);
  }
  return { artifactId: row.id, scope, refId };
}

/** List attachment bindings for one reference. Answers the triple only —
 * never bytes, never canonical metadata — so a chat reader can resolve which
 * Artifact backs an attachment without gaining byte access. */
export async function bindingsForRef(
  db: D1Database,
  caller: Principal,
  binding: { scope: unknown; refId: unknown },
): Promise<{ bindings: ArtifactBindingView[] }> {
  const scope = parseBindingScope(binding.scope);
  const refId = parseBindingRef(binding.refId);
  const rows = await db
    .prepare(
      "SELECT artifact_id, scope, ref_id FROM artifact_bindings WHERE org_id=? AND scope=? AND ref_id=? ORDER BY artifact_id",
    )
    .bind(caller.orgId, scope, refId)
    .all<{ artifact_id: string; scope: string; ref_id: string }>();
  return {
    bindings: rows.results.map((row) => ({
      artifactId: row.artifact_id,
      scope: row.scope as ArtifactBindingScope,
      refId: row.ref_id,
    })),
  };
}

export async function unbindAttachment(
  db: D1Database,
  caller: Principal,
  id: string,
  admin: boolean,
  binding: { scope: unknown; refId: unknown },
): Promise<void> {
  const row = await requireCanonical(db, caller, parseArtifactId(id), admin);
  const scope = parseBindingScope(binding.scope);
  const refId = parseBindingRef(binding.refId);
  const removed = await db
    .prepare("DELETE FROM artifact_bindings WHERE artifact_id=? AND scope=? AND ref_id=?")
    .bind(row.id, scope, refId)
    .run();
  if (removed.meta.changes === 0) throw invalid("BINDING_NOT_FOUND", "No such attachment binding.", 404);
}

export async function getRetention(db: D1Database, orgId: string): Promise<{ maxAgeDays: number }> {
  const row = await db
    .prepare("SELECT max_age_days FROM artifact_retention WHERE org_id=?")
    .bind(orgId)
    .first<{ max_age_days: number }>();
  return { maxAgeDays: row?.max_age_days ?? ARTIFACT_RETENTION_DEFAULT_DAYS };
}

export async function setRetention(
  db: D1Database,
  caller: Principal,
  admin: boolean,
  maxAgeDays: unknown,
): Promise<{ maxAgeDays: number }> {
  // Retention policy is operator-owned: only the admin bypass may change it.
  if (!admin) throw invalid("RETENTION_FORBIDDEN", "Only an admin may change the retention policy.", 403);
  const days = parseRetentionDays(maxAgeDays);
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO artifact_retention(org_id,max_age_days,updated_at) VALUES (?,?,?) ON CONFLICT(org_id) DO UPDATE SET max_age_days=?, updated_at=?",
    )
    .bind(caller.orgId, days, now, days, now)
    .run();
  return { maxAgeDays: days };
}

export interface CleanupCandidate {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly ageDays: number;
}

/** Retention preview: list what cleanup WOULD delete (no writes). Expiry is
 * pinned by Artifact.created_at (upstream invariant), never last access. */
export async function previewCleanup(
  db: D1Database,
  caller: Principal,
  nowMs: number,
): Promise<{ maxAgeDays: number; candidates: CleanupCandidate[]; truncated: boolean }> {
  const { maxAgeDays } = await getRetention(db, caller.orgId);
  const cutoff = new Date(nowMs - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      "SELECT id, name, created_at FROM artifacts WHERE org_id=? AND status='active' AND created_at < ? ORDER BY created_at, id LIMIT ?",
    )
    .bind(caller.orgId, cutoff, ARTIFACT_CLEANUP_BATCH_MAX + 1)
    .all<{ id: string; name: string; created_at: string }>();
  const candidates = rows.results.slice(0, ARTIFACT_CLEANUP_BATCH_MAX).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    ageDays: Math.floor((nowMs - Date.parse(row.created_at)) / (24 * 60 * 60 * 1000)),
  }));
  return { maxAgeDays, candidates, truncated: rows.results.length > ARTIFACT_CLEANUP_BATCH_MAX };
}

/** Retention run: delete one bounded batch (at most 100). Each entry is
 * attempted independently; per-row outcomes are reported and an interrupted
 * remainder (R2 failure, crash between rows) is simply still-active rows the
 * next run picks up — never a silent success. */
export async function runCleanup(
  store: ArtifactStore,
  caller: Principal,
  admin: boolean,
  nowMs: number,
): Promise<{ maxAgeDays: number; deleted: string[]; failed: { id: string; code: string }[]; remaining: number }> {
  if (!admin) throw invalid("RETENTION_FORBIDDEN", "Only an admin may run retention cleanup.", 403);
  const preview = await previewCleanup(store.db, caller, nowMs);
  const deleted: string[] = [];
  const failed: { id: string; code: string }[] = [];
  for (const candidate of preview.candidates) {
    try {
      // Re-gate each row through the canonical path so a concurrent rename
      // or delete surfaces a structured code, never a silent skip.
      await deleteArtifact(store, caller, candidate.id, true);
      deleted.push(candidate.id);
    } catch (error) {
      failed.push({ id: candidate.id, code: error instanceof Fault ? error.code : "CLEANUP_FAILED" });
    }
  }
  const after = await previewCleanup(store.db, caller, nowMs);
  return {
    maxAgeDays: preview.maxAgeDays,
    deleted,
    failed,
    remaining: after.candidates.length + (after.truncated ? 1 : 0),
  };
}

/** Portable export manifest: metadata only, NEVER runtime bytes. OPS-03 owns
 * the explicitly encrypted full-backup exception; this function cannot emit
 * bytes by construction (its return type has no byte field). */
export async function exportManifest(
  db: D1Database,
  caller: Principal,
  id: string,
  admin: boolean,
): Promise<{ artifact: ArtifactDetail; bytesIncluded: false }> {
  const artifact = await artifactDetail(db, caller, id, admin);
  return { artifact, bytesIncluded: false as const };
}

/** Retention policy: operator-owned, per-Organization, in days. */
