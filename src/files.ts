// SPDX-License-Identifier: AGPL-3.0
// Managed file locations (FILE-01, issue #157; ADR 018).
//
// Author/runtime file storage over one R2 bucket (bytes) plus D1 metadata
// (locations, files, policies, capability tokens). Every object is owned by
// exactly one (org_id, location, path) triple; the R2 key is namespaced
// `<org_id>/<location>/<path>` so keys can never alias across Organizations.
//
// Access has two shapes. Bearer shape: the Organization caller presents the
// standard Authorization header and the route policy-checks per request.
// Capability shape: issuance endpoints mint opaque single-secret tokens
// persisted in file_capabilities; the byte routes accept ?token= and
// re-validate the token row (expiry, single-use consumption for uploads,
// policy still present) on every use. Policy revocation deletes outstanding
// capability rows, so already-issued tokens stop working at revocation time.
//
// Uploads are finalize-after-upload, never trusted: the client takes a slot,
// PUTs bytes to a staging key, then finalizes with asserted metadata. The
// server streams the staged bytes through SHA-256 and compares size, content
// type, and digest against the assertions. Any mismatch answers
// COMPLETION_MISMATCH and deletes the staged bytes plus the pending row.
//
// Single-PUT objects only (location max_bytes, at most 25 MiB). Multipart,
// range GETs, retention sweeping, and content search are explicit non-goals
// (ADR 018 section 7); no such surface ships, so no such fault tests exist.
import { Fault, hash, object } from "./domain";
import type { Principal } from "./domain";

export const LOCATION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const FILE_PATH_MAX = 512;
export const FILE_BATCH_MAX = 100;
export const FILE_EXPIRY_DEFAULT = 600;
export const FILE_EXPIRY_MIN = 1;
export const FILE_EXPIRY_MAX = 7 * 24 * 60 * 60;
export const FILE_MAX_BYTES_CAP = 25 * 1024 * 1024;
export const FILE_MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
export const FILE_CONTENT_TYPE_MAX = 128;
export const FILE_LIST_LIMIT_DEFAULT = 20;
export const FILE_LIST_LIMIT_MAX = 50;
export const FILE_POLICY_ACTIONS = ["read", "write", "delete"] as const;
export type FilePolicyAction = (typeof FILE_POLICY_ACTIONS)[number];

export interface FileLocation {
  readonly name: string;
  readonly maxBytes: number;
  readonly contentTypes: readonly string[];
  readonly sharedRead: boolean;
  readonly createdAt: string;
}

export interface FileMeta {
  readonly location: string;
  readonly path: string;
  readonly version: number;
  readonly size: number;
  readonly contentType: string;
  readonly sha256: string;
  readonly status: "pending" | "ready";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FilePolicy {
  readonly location: string;
  readonly action: FilePolicyAction;
  readonly createdAt: string;
}

export interface IssuedEntry {
  readonly path: string;
  readonly allowed: boolean;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly code?: string;
  readonly message?: string;
}

function fail(status: number, code: string, message: string): Fault {
  return new Fault(status, code, message);
}

/** Fail-closed location names: same slug rule as apps/forms. */
export function parseLocationName(value: unknown): string {
  if (typeof value !== "string" || !LOCATION_NAME.test(value)) {
    throw fail(400, "INVALID_LOCATION", "Location names must be lowercase alphanumerics and dashes, 1 to 64 chars.");
  }
  return value;
}

/** Fail-closed object paths: slash-separated segments, no empty segments, no
 * dot segments, no backslashes. Traversal input is rejected, never
 * normalized into something loadable. */
export function parseFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > FILE_PATH_MAX) {
    throw fail(400, "INVALID_PATH", `File paths must be 1 to ${FILE_PATH_MAX} characters.`);
  }
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//") || value.includes("\\")) {
    throw fail(400, "INVALID_PATH", "File paths must be relative slash-separated segments.");
  }
  for (const segment of value.split("/")) {
    if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw fail(400, "INVALID_PATH", "File paths must not contain empty, dot, or special segments.");
    }
  }
  return value;
}

/** Bounded per-entry expiry in seconds, mirroring upstream (1s to 7d, default 600). */
export function parseExpirySeconds(value: unknown): number {
  if (value === undefined) return FILE_EXPIRY_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < FILE_EXPIRY_MIN || value > FILE_EXPIRY_MAX) {
    throw fail(
      400,
      "INVALID_EXPIRY",
      `Expiry must be an integer from ${FILE_EXPIRY_MIN} to ${FILE_EXPIRY_MAX} seconds.`,
    );
  }
  return value;
}

export function parsePolicyAction(value: unknown): FilePolicyAction {
  if (typeof value !== "string" || !(FILE_POLICY_ACTIONS as readonly string[]).includes(value)) {
    throw fail(400, "INVALID_POLICY_ACTION", "Policy actions are read, write, or delete.");
  }
  return value as FilePolicyAction;
}

export function parseMaxBytes(value: unknown): number {
  if (value === undefined) return FILE_MAX_BYTES_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > FILE_MAX_BYTES_CAP) {
    throw fail(400, "INVALID_LOCATION", `maxBytes must be an integer from 1 to ${FILE_MAX_BYTES_CAP}.`);
  }
  return value;
}

export function parseContentTypes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw fail(400, "INVALID_LOCATION", "contentTypes must be a list of at most 50 media types.");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > FILE_CONTENT_TYPE_MAX) {
      throw fail(400, "INVALID_LOCATION", "Each content type must be 1 to 128 characters.");
    }
    const normalized = entry.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(normalized)) {
      throw fail(400, "INVALID_LOCATION", `Content type "${entry}" is not a media-type shape.`);
    }
    return normalized;
  });
}

function parseSharedRead(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw fail(400, "INVALID_LOCATION", "sharedRead must be true or omitted/false.");
  return value;
}

interface LocationRow {
  org_id: string;
  name: string;
  max_bytes: number;
  content_types_json: string;
  shared_read: number;
  created_at: string;
}

interface FileRow {
  org_id: string;
  location: string;
  path: string;
  version: number;
  size: number;
  content_type: string;
  sha256: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PolicyRow {
  location: string;
  action: string;
  created_at: string;
}

interface CapabilityRow {
  id: string;
  org_id: string;
  source_org_id: string;
  location: string;
  path: string;
  action: string;
  staging_key: string | null;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

function toLocation(row: LocationRow): FileLocation {
  let types: unknown;
  try {
    types = JSON.parse(row.content_types_json);
  } catch {
    throw new Error("File location carries invalid content-type metadata.");
  }
  if (!Array.isArray(types) || types.some((entry) => typeof entry !== "string")) {
    throw new Error("File location carries invalid content-type metadata.");
  }
  return {
    name: row.name,
    maxBytes: row.max_bytes,
    contentTypes: types as string[],
    sharedRead: row.shared_read === 1,
    createdAt: row.created_at,
  };
}

function toMeta(row: FileRow): FileMeta {
  if (row.status !== "pending" && row.status !== "ready") throw new Error("File row carries invalid status.");
  return {
    location: row.location,
    path: row.path,
    version: row.version,
    size: row.size,
    contentType: row.content_type,
    sha256: row.sha256,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** R2 object key. Namespaced by Organization so keys can never alias across
 * tenants even if a policy check is bypassed in a future refactor. Defense
 * in depth, not the authorization boundary: SQL org scoping is the boundary. */
export function objectKey(orgId: string, location: string, path: string): string {
  return `${orgId}/${location}/${path}`;
}

function stagingKey(capabilityId: string): string {
  return `__staging__/${capabilityId}`;
}

async function ensureOrg(db: D1Database, orgId: string): Promise<void> {
  const org = await db.prepare("SELECT id FROM organizations WHERE id=?").bind(orgId).first<{ id: string }>();
  if (!org) await db.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(orgId, "file-owner").run();
}

export async function loadLocation(db: D1Database, orgId: string, name: string): Promise<FileLocation | null> {
  const row = await db
    .prepare(
      "SELECT org_id,name,max_bytes,content_types_json,shared_read,created_at FROM file_locations WHERE org_id=? AND name=?",
    )
    .bind(orgId, name)
    .first<LocationRow>();
  return row ? toLocation(row) : null;
}

/** Declare a write location. Creation mints read/write/delete allow rows for
 * the owning Organization so the declaration is usable immediately;
 * revocation is deleting the policy row. */
export async function createLocation(db: D1Database, caller: Principal, body: unknown): Promise<FileLocation> {
  if (!object(body)) throw fail(400, "INVALID_LOCATION", "Location needs a name and optional limits.");
  const name = parseLocationName(body.name);
  const maxBytes = parseMaxBytes(body.maxBytes);
  const contentTypes = parseContentTypes(body.contentTypes);
  const sharedRead = parseSharedRead(body.sharedRead);
  await ensureOrg(db, caller.orgId);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        "INSERT INTO file_locations(org_id,name,max_bytes,content_types_json,shared_read,created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(caller.orgId, name, maxBytes, JSON.stringify(contentTypes), sharedRead ? 1 : 0, now)
      .run();
  } catch {
    throw fail(409, "LOCATION_CONFLICT", `Location "${name}" already exists in this Organization.`);
  }
  for (const action of FILE_POLICY_ACTIONS) {
    await db
      .prepare("INSERT INTO file_policies(org_id,location,action,created_at) VALUES (?,?,?,?)")
      .bind(caller.orgId, name, action, now)
      .run();
  }
  const created = await loadLocation(db, caller.orgId, name);
  if (!created) throw new Error("File location insert did not persist.");
  return created;
}

export async function listLocations(db: D1Database, caller: Principal): Promise<FileLocation[]> {
  const rows = await db
    .prepare(
      "SELECT org_id,name,max_bytes,content_types_json,shared_read,created_at FROM file_locations WHERE org_id=? ORDER BY name ASC",
    )
    .bind(caller.orgId)
    .all<LocationRow>();
  return rows.results.map(toLocation);
}

/** Delete a location declaration. Refuses while file rows exist
 * (LOCATION_NOT_EMPTY); removes policies and outstanding capability rows so
 * revocation semantics hold (ADR 018 section 4). */
export async function deleteLocation(db: D1Database, caller: Principal, name: string): Promise<void> {
  const existing = await loadLocation(db, caller.orgId, name);
  if (!existing) throw fail(404, "NOT_FOUND", "Not found.");
  const files = await db
    .prepare("SELECT path FROM files WHERE org_id=? AND location=? LIMIT 1")
    .bind(caller.orgId, name)
    .first<{ path: string }>();
  if (files) throw fail(409, "LOCATION_NOT_EMPTY", `Location "${name}" still holds files.`);
  await db.prepare("DELETE FROM file_capabilities WHERE org_id=? AND location=?").bind(caller.orgId, name).run();
  await db.prepare("DELETE FROM file_policies WHERE org_id=? AND location=?").bind(caller.orgId, name).run();
  await db.prepare("DELETE FROM file_locations WHERE org_id=? AND name=?").bind(caller.orgId, name).run();
}

export async function hasPolicy(
  db: D1Database,
  orgId: string,
  location: string,
  action: FilePolicyAction,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT action FROM file_policies WHERE org_id=? AND location=? AND action=?")
    .bind(orgId, location, action)
    .first<{ action: string }>();
  return row !== null;
}

export async function listPolicies(db: D1Database, caller: Principal, location: string): Promise<FilePolicy[]> {
  const existing = await loadLocation(db, caller.orgId, location);
  if (!existing) throw fail(404, "NOT_FOUND", "Not found.");
  const rows = await db
    .prepare("SELECT location,action,created_at FROM file_policies WHERE org_id=? AND location=? ORDER BY action ASC")
    .bind(caller.orgId, location)
    .all<PolicyRow>();
  return rows.results.map((row) => ({
    location: row.location,
    action: row.action as FilePolicyAction,
    createdAt: row.created_at,
  }));
}

/** Grant one policy row (idempotent: re-granting answers 200 with the row). */
export async function grantPolicy(db: D1Database, caller: Principal, body: unknown): Promise<FilePolicy> {
  if (!object(body)) throw fail(400, "INVALID_POLICY", "Policy grants need a location and an action.");
  const location = parseLocationName(body.location);
  const action = parsePolicyAction(body.action);
  const existing = await loadLocation(db, caller.orgId, location);
  if (!existing) throw fail(404, "NOT_FOUND", "Not found.");
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO file_policies(org_id,location,action,created_at) VALUES (?,?,?,?) ON CONFLICT(org_id,location,action) DO NOTHING",
    )
    .bind(caller.orgId, location, action, now)
    .run();
  const row = await db
    .prepare("SELECT location,action,created_at FROM file_policies WHERE org_id=? AND location=? AND action=?")
    .bind(caller.orgId, location, action)
    .first<PolicyRow>();
  if (!row) throw new Error("Policy grant did not persist.");
  return { location: row.location, action: row.action as FilePolicyAction, createdAt: row.created_at };
}

/** Revoke one policy row. Outstanding capability rows for the triple are
 * deleted so already-issued tokens stop working at revocation time, not at
 * expiry (ADR 018 section 4). Bearer-shape access checks policy per request,
 * so revocation is immediate there by construction. */
export async function revokePolicy(db: D1Database, caller: Principal, body: unknown): Promise<void> {
  if (!object(body)) throw fail(400, "INVALID_POLICY", "Policy revocation needs a location and an action.");
  const location = parseLocationName(body.location);
  const action = parsePolicyAction(body.action);
  const existing = await loadLocation(db, caller.orgId, location);
  if (!existing) throw fail(404, "NOT_FOUND", "Not found.");
  const capAction = action === "read" ? "download" : action === "write" ? "upload" : null;
  if (capAction) {
    await db
      .prepare("DELETE FROM file_capabilities WHERE org_id=? AND location=? AND action=?")
      .bind(caller.orgId, location, capAction)
      .run();
  }
  const removed = await db
    .prepare("DELETE FROM file_policies WHERE org_id=? AND location=? AND action=?")
    .bind(caller.orgId, location, action)
    .run();
  if (removed.meta.changes === 0) throw fail(404, "NOT_FOUND", "Not found.");
}

export interface AccessVerdict {
  readonly allowed: boolean;
  readonly reason: string;
  readonly sourceOrgId?: string;
}

/** Pure-policy evaluator shared by the access-test endpoint and every
 * issuance path, so the tested behavior is the enforced behavior. Reads tier
 * existence-first: the caller's own ready row wins; otherwise a same-named
 * shared location in another Organization may satisfy the read when the
 * caller holds a read allow row for their own same-named location. */
export async function evaluateAccess(
  db: D1Database,
  callerOrgId: string,
  location: string,
  path: string,
  action: FilePolicyAction,
): Promise<AccessVerdict> {
  if (action !== "read") {
    const declared = await loadLocation(db, callerOrgId, location);
    if (!declared) return { allowed: false, reason: "no declared location" };
    if (!(await hasPolicy(db, callerOrgId, location, action))) {
      return { allowed: false, reason: `no ${action} policy` };
    }
    return { allowed: true, reason: "declared location with policy", sourceOrgId: callerOrgId };
  }
  const own = await db
    .prepare("SELECT status FROM files WHERE org_id=? AND location=? AND path=?")
    .bind(callerOrgId, location, path)
    .first<{ status: string }>();
  if (own?.status === "ready") {
    if (!(await hasPolicy(db, callerOrgId, location, "read"))) {
      return { allowed: false, reason: "no read policy" };
    }
    return { allowed: true, reason: "own ready file with policy", sourceOrgId: callerOrgId };
  }
  if (!(await hasPolicy(db, callerOrgId, location, "read"))) {
    return { allowed: false, reason: "no read policy" };
  }
  const shared = await db
    .prepare(
      "SELECT f.org_id FROM files f JOIN file_locations l ON l.org_id=f.org_id AND l.name=f.location WHERE f.location=? AND f.path=? AND f.status='ready' AND f.org_id!=? AND l.shared_read=1 ORDER BY f.updated_at ASC LIMIT 1",
    )
    .bind(location, path, callerOrgId)
    .first<{ org_id: string }>();
  if (!shared) return { allowed: false, reason: own ? "file not finalized" : "no such file" };
  return { allowed: true, reason: "shared read-only fallback", sourceOrgId: shared.org_id };
}

/** Policy access-test: evaluates a hypothetical triple, issuing nothing. */
export async function testAccess(db: D1Database, caller: Principal, body: unknown): Promise<AccessVerdict> {
  if (!object(body)) throw fail(400, "INVALID_POLICY_TEST", "Access tests need a location, a path, and an action.");
  const location = parseLocationName(body.location);
  const path = parseFilePath(body.path);
  const action = parsePolicyAction(body.action);
  return evaluateAccess(db, caller.orgId, location, path, action);
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Slot {
  readonly token: string;
  readonly expiresAt: string;
}

/** Mint an upload slot: a pending metadata row plus a single-use upload
 * capability. Requires a declared location and a write allow row. */
export async function issueUploadSlot(
  db: D1Database,
  caller: Principal,
  location: string,
  path: string,
  expiresIn: number,
): Promise<Slot> {
  const verdict = await evaluateAccess(db, caller.orgId, location, path, "write");
  if (!verdict.allowed) {
    const declared = await loadLocation(db, caller.orgId, location);
    if (!declared) throw fail(404, "NOT_FOUND", "Not found.");
    throw fail(403, "FORBIDDEN", "Forbidden.");
  }
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const token = newToken();
  const id = crypto.randomUUID().toLowerCase();
  const existing = await db
    .prepare("SELECT version,status FROM files WHERE org_id=? AND location=? AND path=?")
    .bind(caller.orgId, location, path)
    .first<{ version: number; status: string }>();
  const version = existing ? existing.version : 0;
  if (!existing) {
    await db
      .prepare(
        "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,0,'','','pending',?,?)",
      )
      .bind(caller.orgId, location, path, version, now, now)
      .run();
  } else if (existing.status === "pending") {
    await db
      .prepare("UPDATE files SET updated_at=? WHERE org_id=? AND location=? AND path=? AND status='pending'")
      .bind(now, caller.orgId, location, path)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO file_capabilities(id,org_id,source_org_id,location,path,action,staging_key,token_hash,expires_at,used_at,created_at) VALUES (?,?,?,?,?,?,?, ?,?,NULL,?)",
    )
    .bind(id, caller.orgId, caller.orgId, location, path, "upload", stagingKey(id), await hash(token), expiresAt, now)
    .run();
  return { token, expiresAt };
}

/** Mint a download capability after the existence-first read tier resolves.
 * Unknown, unfinalized, and foreign non-shared objects all deny without
 * disclosing which; the route answers 404 for every denied read. */
export async function issueDownloadSlot(
  db: D1Database,
  caller: Principal,
  location: string,
  path: string,
  expiresIn: number,
): Promise<Slot> {
  const verdict = await evaluateAccess(db, caller.orgId, location, path, "read");
  if (!verdict.allowed || !verdict.sourceOrgId) throw fail(404, "NOT_FOUND", "Not found.");
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const now = new Date().toISOString();
  const token = newToken();
  const id = crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO file_capabilities(id,org_id,source_org_id,location,path,action,staging_key,token_hash,expires_at,used_at,created_at) VALUES (?,?,?,?,?,'download',NULL,?,?,NULL,?)",
    )
    .bind(id, caller.orgId, verdict.sourceOrgId, location, path, await hash(token), expiresAt, now)
    .run();
  return { token, expiresAt };
}

export interface BatchEntry {
  readonly location: string;
  readonly path: string;
  readonly expiresIn: number;
}

export function parseBatchEntries(body: unknown): BatchEntry[] {
  if (!object(body) || !Array.isArray(body.entries)) {
    throw fail(400, "INVALID_BATCH", `Batch issuance takes 1 to ${FILE_BATCH_MAX} entries.`);
  }
  if (body.entries.length === 0 || body.entries.length > FILE_BATCH_MAX) {
    throw fail(400, "INVALID_BATCH", `Batch issuance takes 1 to ${FILE_BATCH_MAX} entries.`);
  }
  return body.entries.map((entry) => {
    if (!object(entry)) throw fail(400, "INVALID_BATCH", "Each entry needs a location and a path.");
    return {
      location: parseLocationName(entry.location),
      path: parseFilePath(entry.path),
      expiresIn: parseExpirySeconds(entry.expiresIn),
    };
  });
}

/** Bounded batch issuance with per-path allow/deny results (upstream shape).
 * Upload denials distinguish unknown locations (404) from revoked policy
 * (403); download denials always collapse to 404 (non-disclosure). */
export async function issueUploadBatch(
  db: D1Database,
  caller: Principal,
  entries: readonly BatchEntry[],
): Promise<IssuedEntry[]> {
  const results: IssuedEntry[] = [];
  for (const entry of entries) {
    try {
      const slot = await issueUploadSlot(db, caller, entry.location, entry.path, entry.expiresIn);
      results.push({ path: entry.path, allowed: true, token: slot.token, expiresAt: slot.expiresAt });
    } catch (error) {
      if (error instanceof Fault && (error.status === 404 || error.status === 403)) {
        results.push({ path: entry.path, allowed: false, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
  }
  return results;
}

export async function issueDownloadBatch(
  db: D1Database,
  caller: Principal,
  entries: readonly BatchEntry[],
): Promise<IssuedEntry[]> {
  const results: IssuedEntry[] = [];
  for (const entry of entries) {
    try {
      const slot = await issueDownloadSlot(db, caller, entry.location, entry.path, entry.expiresIn);
      results.push({ path: entry.path, allowed: true, token: slot.token, expiresAt: slot.expiresAt });
    } catch (error) {
      if (error instanceof Fault && error.status === 404) {
        results.push({ path: entry.path, allowed: false, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
  }
  return results;
}

async function loadCapability(db: D1Database, token: string): Promise<CapabilityRow | null> {
  const row = await db
    .prepare("SELECT * FROM file_capabilities WHERE token_hash=?")
    .bind(await hash(token))
    .first<CapabilityRow>();
  return row ?? null;
}

export interface UploadConsumption {
  readonly orgId: string;
  readonly location: string;
  readonly path: string;
  readonly staging: string;
  readonly capabilityId: string;
}

/** Validate and single-use-consume an upload token. The consumption write is
 * fenced on used_at IS NULL so a replayed PUT fails closed. Returns the
 * staging target; policy is re-checked so revocation stops outstanding
 * tokens (ADR 018 section 4). */
export async function consumeUploadToken(db: D1Database, token: string): Promise<UploadConsumption> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw fail(401, "UNAUTHORIZED", "Unauthorized.");
  const cap = await loadCapability(db, token);
  if (!cap || cap.action !== "upload" || cap.staging_key === null) {
    throw fail(401, "UNAUTHORIZED", "Unauthorized.");
  }
  if (cap.expires_at <= new Date().toISOString() || cap.used_at !== null) {
    throw fail(401, "UNAUTHORIZED", "Unauthorized.");
  }
  if (!(await hasPolicy(db, cap.org_id, cap.location, "write"))) {
    throw fail(403, "FORBIDDEN", "Forbidden.");
  }
  const consumed = await db
    .prepare("UPDATE file_capabilities SET used_at=? WHERE id=? AND used_at IS NULL")
    .bind(new Date().toISOString(), cap.id)
    .run();
  if (consumed.meta.changes === 0) throw fail(401, "UNAUTHORIZED", "Unauthorized.");
  return {
    orgId: cap.org_id,
    location: cap.location,
    path: cap.path,
    staging: cap.staging_key,
    capabilityId: cap.id,
  };
}

export interface DownloadResolution {
  readonly sourceOrgId: string;
  readonly location: string;
  readonly path: string;
}

/** Resolve a download token: expiry plus policy re-checked on every use, so
 * revocation stops outstanding tokens. Failures collapse to 404/401 without
 * disclosing which check fired. */
export async function resolveDownloadToken(db: D1Database, token: string): Promise<DownloadResolution> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw fail(401, "UNAUTHORIZED", "Unauthorized.");
  const cap = await loadCapability(db, token);
  if (!cap || cap.action !== "download") throw fail(401, "UNAUTHORIZED", "Unauthorized.");
  if (cap.expires_at <= new Date().toISOString()) throw fail(401, "UNAUTHORIZED", "Unauthorized.");
  if (!(await hasPolicy(db, cap.org_id, cap.location, "read"))) {
    throw fail(404, "NOT_FOUND", "Not found.");
  }
  const verdict = await evaluateAccess(db, cap.org_id, cap.location, cap.path, "read");
  if (!verdict.allowed || verdict.sourceOrgId !== cap.source_org_id) {
    throw fail(404, "NOT_FOUND", "Not found.");
  }
  return { sourceOrgId: cap.source_org_id, location: cap.location, path: cap.path };
}

/** Resolve a Bearer-shape read: own ready row first, then the bounded shared
 * fallback. Missing, unfinalized, foreign, and policy-denied reads all
 * answer 404 (non-disclosure). */
export async function resolveBearerRead(
  db: D1Database,
  caller: Principal,
  location: string,
  path: string,
): Promise<DownloadResolution> {
  const verdict = await evaluateAccess(db, caller.orgId, location, path, "read");
  if (!verdict.allowed || !verdict.sourceOrgId) throw fail(404, "NOT_FOUND", "Not found.");
  return { sourceOrgId: verdict.sourceOrgId, location, path };
}

/** Read a request body as bounded bytes. Bodies past the limit fail with 413
 * before buffering further. */
export async function readBoundedBytes(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (body === null) throw fail(400, "EMPTY_UPLOAD", "The upload body must not be empty.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw fail(413, "FILE_TOO_LARGE", `The object exceeds ${limit} bytes.`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function sha256Hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface FinalizeClaim {
  readonly location: string;
  readonly path: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly expectedVersion?: number;
}

export function parseFinalizeBody(body: unknown): FinalizeClaim {
  if (!object(body))
    throw fail(400, "INVALID_FINALIZE", "Finalize needs location, path, contentType, size, and sha256.");
  const location = parseLocationName(body.location);
  const path = parseFilePath(body.path);
  if (typeof body.contentType !== "string" || body.contentType.length === 0 || body.contentType.length > 128) {
    throw fail(400, "INVALID_FINALIZE", "Finalize needs a contentType of 1 to 128 characters.");
  }
  if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 0) {
    throw fail(400, "INVALID_FINALIZE", "Finalize needs an integer size.");
  }
  if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(body.sha256)) {
    throw fail(400, "INVALID_FINALIZE", "Finalize needs a 64-hex sha256 digest.");
  }
  let expectedVersion: number | undefined;
  if (body.expectedVersion !== undefined) {
    if (
      typeof body.expectedVersion !== "number" ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 0
    ) {
      throw fail(400, "INVALID_FINALIZE", "expectedVersion must be a non-negative integer.");
    }
    expectedVersion = body.expectedVersion;
  }
  return {
    location,
    path,
    contentType: body.contentType.trim().toLowerCase(),
    size: body.size,
    sha256: body.sha256.toLowerCase(),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

/** Finalize-after-upload verification. The completion metadata is a claim to
 * check, not a fact to store: the server streams the staged bytes through
 * SHA-256 and compares actual size and digest against the assertions, checks
 * the content type against the location allowlist, and fences the version.
 * Any mismatch deletes the staged bytes plus the pending row and never
 * promotes to ready. */
export async function finalizeUpload(
  db: D1Database,
  bucket: R2Bucket,
  caller: Principal,
  claim: FinalizeClaim,
): Promise<FileMeta> {
  const declared = await loadLocation(db, caller.orgId, claim.location);
  if (!declared) throw fail(404, "NOT_FOUND", "Not found.");
  if (!(await hasPolicy(db, caller.orgId, claim.location, "write"))) {
    throw fail(403, "FORBIDDEN", "Forbidden.");
  }
  if (claim.size > declared.maxBytes) {
    throw fail(413, "FILE_TOO_LARGE", `The object exceeds the location limit of ${declared.maxBytes} bytes.`);
  }
  if (declared.contentTypes.length > 0 && !declared.contentTypes.includes(claim.contentType)) {
    throw fail(415, "CONTENT_TYPE_REJECTED", `Content type "${claim.contentType}" is not allowed in this location.`);
  }
  const row = await db
    .prepare("SELECT * FROM files WHERE org_id=? AND location=? AND path=?")
    .bind(caller.orgId, claim.location, claim.path)
    .first<FileRow>();
  if (!row) throw fail(409, "FILE_MISSING", "No pending upload exists for this path.");
  if (row.status === "ready" && claim.expectedVersion === undefined) {
    throw fail(409, "VERSION_CONFLICT", "The file already exists: finalize an overwrite with expectedVersion.");
  }
  if (row.status === "ready" && claim.expectedVersion !== row.version) {
    throw fail(409, "VERSION_CONFLICT", "The file changed since the expected version.");
  }
  if (row.status !== "pending" && row.status !== "ready") {
    throw new Error("File row carries invalid status.");
  }
  const stagedKey = await findStagingKey(db, caller, claim);
  if (!stagedKey) throw fail(409, "FILE_MISSING", "No pending upload exists for this path.");
  const stored = await bucket.get(stagedKey);
  if (!stored) throw fail(409, "FILE_MISSING", "No pending upload exists for this path.");
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if (bytes.byteLength !== claim.size) {
    await discardPending(db, bucket, caller, claim, stagedKey);
    throw fail(409, "COMPLETION_MISMATCH", "The uploaded bytes do not match the asserted size.");
  }
  const digest = sha256Hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  if (digest !== claim.sha256) {
    await discardPending(db, bucket, caller, claim, stagedKey);
    throw fail(409, "COMPLETION_MISMATCH", "The uploaded bytes do not match the asserted digest.");
  }
  const nextVersion = row.status === "ready" ? row.version + 1 : 1;
  const now = new Date().toISOString();
  await bucket.put(objectKey(caller.orgId, claim.location, claim.path), bytes, {
    httpMetadata: { contentType: claim.contentType },
  });
  await bucket.delete(stagedKey);
  await db
    .prepare(
      "UPDATE files SET version=?,size=?,content_type=?,sha256=?,status='ready',updated_at=? WHERE org_id=? AND location=? AND path=?",
    )
    .bind(nextVersion, bytes.byteLength, claim.contentType, digest, now, caller.orgId, claim.location, claim.path)
    .run();
  const updated = await db
    .prepare("SELECT * FROM files WHERE org_id=? AND location=? AND path=?")
    .bind(caller.orgId, claim.location, claim.path)
    .first<FileRow>();
  if (!updated) throw new Error("File finalize did not persist.");
  return toMeta(updated);
}

async function findStagingKey(db: D1Database, caller: Principal, claim: FinalizeClaim): Promise<string | null> {
  const cap = await db
    .prepare(
      "SELECT staging_key FROM file_capabilities WHERE org_id=? AND location=? AND path=? AND action='upload' AND used_at IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .bind(caller.orgId, claim.location, claim.path)
    .first<{ staging_key: string | null }>();
  return cap?.staging_key ?? null;
}

async function discardPending(
  db: D1Database,
  bucket: R2Bucket,
  caller: Principal,
  claim: FinalizeClaim,
  stagedKey: string,
): Promise<void> {
  await bucket.delete(stagedKey);
  const row = await db
    .prepare("SELECT status FROM files WHERE org_id=? AND location=? AND path=?")
    .bind(caller.orgId, claim.location, claim.path)
    .first<{ status: string }>();
  if (row?.status === "pending") {
    await db
      .prepare("DELETE FROM files WHERE org_id=? AND location=? AND path=? AND status='pending'")
      .bind(caller.orgId, claim.location, claim.path)
      .run();
  }
}

/** Version/conflict-aware delete. Missing files answer 409 FILE_MISSING and
 * stale versions answer 409 VERSION_CONFLICT (the caller already holds a
 * versioned handle); unauthorized callers never reach this distinguisher. */
export async function deleteFile(db: D1Database, bucket: R2Bucket, caller: Principal, body: unknown): Promise<void> {
  if (!object(body)) throw fail(400, "INVALID_DELETE", "Delete needs a location, a path, and an expectedVersion.");
  const location = parseLocationName(body.location);
  const path = parseFilePath(body.path);
  if (typeof body.expectedVersion !== "number" || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) {
    throw fail(400, "INVALID_DELETE", "Delete needs an integer expectedVersion.");
  }
  const declared = await loadLocation(db, caller.orgId, location);
  if (!declared) throw fail(404, "NOT_FOUND", "Not found.");
  if (!(await hasPolicy(db, caller.orgId, location, "delete"))) {
    throw fail(403, "FORBIDDEN", "Forbidden.");
  }
  const row = await db
    .prepare("SELECT version,status FROM files WHERE org_id=? AND location=? AND path=?")
    .bind(caller.orgId, location, path)
    .first<{ version: number; status: string }>();
  if (!row) throw fail(409, "FILE_MISSING", "The file does not exist.");
  if (row.version !== body.expectedVersion) {
    throw fail(409, "VERSION_CONFLICT", "The file changed since the expected version.");
  }
  await bucket.delete(objectKey(caller.orgId, location, path));
  await db
    .prepare("DELETE FROM files WHERE org_id=? AND location=? AND path=? AND version=?")
    .bind(caller.orgId, location, path, row.version)
    .run();
}

export interface FileListQuery {
  readonly location: string;
  readonly prefix?: string;
  readonly limit: number;
  readonly cursor?: { updatedAt: string; path: string };
}

export function parseFileListQuery(params: URLSearchParams): FileListQuery {
  for (const key of params.keys()) {
    if (!["location", "prefix", "limit", "cursor"].includes(key)) {
      throw fail(400, "UNSUPPORTED_QUERY", "Only location, prefix, limit, and cursor are supported here.");
    }
  }
  const rawLocation = params.get("location");
  if (rawLocation === null) throw fail(400, "INVALID_LOCATION", "Listing needs a location.");
  const location = parseLocationName(rawLocation);
  let prefix: string | undefined;
  const rawPrefix = params.get("prefix");
  if (rawPrefix !== null) {
    if (rawPrefix.length === 0 || rawPrefix.length > FILE_PATH_MAX) {
      throw fail(400, "INVALID_PATH", "The prefix must be 1 to 512 characters.");
    }
    if (rawPrefix.includes("\\") || rawPrefix.includes("..")) {
      throw fail(400, "INVALID_PATH", "The prefix must not contain backslashes or dot segments.");
    }
    prefix = rawPrefix;
  }
  let limit = FILE_LIST_LIMIT_DEFAULT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > FILE_LIST_LIMIT_MAX) {
      throw fail(400, "INVALID_LIMIT", `Limit must be an integer from 1 to ${FILE_LIST_LIMIT_MAX}.`);
    }
    limit = Number(rawLimit);
  }
  const rawCursor = params.get("cursor");
  return {
    location,
    ...(prefix === undefined ? {} : { prefix }),
    limit,
    ...(rawCursor === null ? {} : { cursor: decodeFileCursor(rawCursor) }),
  };
}

export function encodeFileCursor(cursor: { updatedAt: string; path: string }): string {
  return btoa(JSON.stringify({ updatedAt: cursor.updatedAt, path: cursor.path }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodeFileCursor(value: string): { updatedAt: string; path: string } {
  let cursor: unknown;
  try {
    cursor = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    throw fail(400, "INVALID_CURSOR", "The file cursor is not a valid page marker.");
  }
  if (
    !object(cursor) ||
    typeof cursor.updatedAt !== "string" ||
    cursor.updatedAt.length === 0 ||
    typeof cursor.path !== "string" ||
    cursor.path.length === 0
  ) {
    throw fail(400, "INVALID_CURSOR", "The file cursor is not a valid page marker.");
  }
  return { updatedAt: cursor.updatedAt, path: cursor.path };
}

/** Organization-scoped structural listing: only the caller's own rows, never
 * shared rows, so enumeration cannot cross the tenant boundary. */
export async function listFiles(
  db: D1Database,
  caller: Principal,
  query: FileListQuery,
): Promise<{ files: FileMeta[]; nextCursor: string | null }> {
  const declared = await loadLocation(db, caller.orgId, query.location);
  if (!declared) throw fail(404, "NOT_FOUND", "Not found.");
  if (!(await hasPolicy(db, caller.orgId, query.location, "read"))) {
    throw fail(404, "NOT_FOUND", "Not found.");
  }
  const prefixFilter = query.prefix === undefined ? "" : "AND path LIKE ? ESCAPE '\\'";
  const cursorFilter = query.cursor ? "AND (updated_at < ? OR (updated_at = ? AND path < ?))" : "";
  const binds: (string | number)[] = [caller.orgId, query.location];
  if (query.prefix !== undefined)
    binds.push(`${query.prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  if (query.cursor) binds.push(query.cursor.updatedAt, query.cursor.updatedAt, query.cursor.path);
  binds.push(query.limit + 1);
  const rows = await db
    .prepare(
      `SELECT * FROM files WHERE org_id=? AND location=? ${prefixFilter} ${cursorFilter} ORDER BY updated_at DESC, path DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<FileRow>();
  const page = rows.results.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    files: page.map(toMeta),
    nextCursor:
      rows.results.length > query.limit && last
        ? encodeFileCursor({ updatedAt: last.updated_at, path: last.path })
        : null,
  };
}
