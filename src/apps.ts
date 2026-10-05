// SPDX-License-Identifier: AGPL-3.0
// Authored Applications (APP-01, issue #159; ADR 017).
//
// An Application is an Organization-scoped, author-owned record: stable UUID
// identity (ADR 002 rules), a human name, a route slug unique per
// Organization, an ownership marker, and an active_deployment_id pointer.
//
// Ownership (ADR 017 section 1, same shape as ADR 011 Connections):
// independent rows (managed_by NULL) live through the app API below; the
// trusted author edits source, validates, builds, and deploys with no
// draft/preview/publish step (independent V2 has none). Solution-owned rows
// (managed_by = <bundle_id>@<version>) arrive via bundle install and reject
// live mutation with MANAGED_RESOURCE. Legacy V1 draft/publish is
// documented in ADR 017, never implemented.
//
// Build security (ADR 017 section 6, the gating decision): validation is
// shape-only and the v1 deploy job compiles declarations to a stored bundle
// WITHOUT executing author source or installing packages. Nothing here
// imports, evaluates, or bundles untrusted code; doing so needs its own ADR
// with a venue, an isolation model, and a cost gate.
import { Fault, hash, object, UUID } from "./domain";
import type { FieldFailure, Principal } from "./domain";

export type AppStatus = "created" | "ready" | "building" | "live" | "failed";
export type AppOwnerKind = "independent" | "solution";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface AppFile {
  readonly path: string;
  readonly content: string;
}

export interface AppDependency {
  readonly name: string;
  readonly version: string;
}

export interface AppSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerKind: AppOwnerKind;
  readonly status: AppStatus;
  readonly activeDeploymentId: string | null;
  readonly revision: number | null;
  readonly updatedAt: string;
}

export interface AppRevision {
  readonly revision: number;
  readonly files: readonly AppFile[];
  readonly dependencies: readonly AppDependency[];
  readonly validation: "pending" | "valid" | "invalid";
  readonly failures: readonly FieldFailure[] | null;
  readonly createdAt: string;
}

export interface AppJob {
  readonly id: string;
  readonly revision: number;
  readonly status: JobStatus;
  readonly error: { code: string; message: string } | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface AppDeployment {
  readonly id: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface AppDetail extends AppSummary {
  readonly createdAt: string;
  readonly revisions: readonly AppRevision[];
  readonly jobs: readonly AppJob[];
  readonly activeDeployment: AppDeployment | null;
}

export const APP_NAME_MAX = 128;
export const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const APP_FILE_PATH = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const DEP_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEP_VERSION = /^[a-z0-9][a-z0-9.+_-]{0,31}$/;
export const APP_MAX_FILES = 50;
export const APP_MAX_FILE_BYTES = 4096;
export const APP_MAX_DEPS = 20;

/** Static dependency allowlist (ADR 017 section 3): declared pins resolve
 * here, never against a registry. Anything unlisted fails validation with
 * DEPENDENCY_UNRESOLVED and blocks build. */
export const APP_DEP_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "wrangnarok-ui": Object.freeze(["1.0.0", "1.1.0"]),
  "wrangnarok-charts": Object.freeze(["0.9.0", "1.0.0"]),
});

/** Retained-source exclusion (issue #484 A1): validation-time deny-list so
 * deployed source never retains secrets, build output, version-control, or
 * vendor directories. Segment-based, so nesting (for example
 * `lib/node_modules/x`) is denied exactly like a top-level prefix. Runs
 * before the path-shape check so the whole class reports one stable
 * EXCLUDED_PATH code instead of an incidental BAD_PATH. Validation-time
 * only: existing stored rows are grandfathered, never swept. */
function excludedAppPathReason(path: string): string | null {
  for (const segment of path.toLowerCase().split("/")) {
    if (segment.startsWith(".env")) return "secrets";
    if (segment === "node_modules" || segment === "vendor") return "vendor";
    if (segment === "build" || segment === "dist") return "build output";
    if (segment === ".git" || segment === ".svn" || segment === ".hg") return "version control";
  }
  return null;
}

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return new Fault(status, code, message, details);
}

/** Shape-only check that returns field failures instead of throwing, so the
 * edit path can persist invalid revisions for later inspection. Other
 * malformed-source faults still throw. */
function tryValidate(
  files: unknown,
  deps: unknown,
): { parsed: { files: AppFile[]; deps: AppDependency[] }; failures: FieldFailure[] | null } {
  try {
    return { parsed: validateAppSource(files, deps), failures: null };
  } catch (error) {
    if (error instanceof Fault && error.code === "APP_VALIDATION_FAILED") {
      return {
        parsed: {
          files: Array.isArray(files) ? (files as AppFile[]) : [],
          deps: Array.isArray(deps) ? (deps as AppDependency[]) : [],
        },
        failures: error.details as FieldFailure[],
      };
    }
    throw error;
  }
}

export function parseAppName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > APP_NAME_MAX) {
    throw invalid("INVALID_APP", `App name must be 1 to ${APP_NAME_MAX} chars.`);
  }
  return value;
}

export function parseAppSlug(value: unknown): string {
  if (typeof value !== "string" || !APP_SLUG.test(value)) {
    throw invalid("INVALID_SLUG", "App slug must be lowercase alphanumerics and dashes, 1 to 64 chars.");
  }
  return value;
}

export function parseAppId(value: string): string {
  if (!UUID.test(value)) throw invalid("INVALID_APP_ID", "App lookups need the exact app UUID.", 400);
  return value.toLowerCase();
}

/** Shape-only source validation (ADR 017 section 6): sanitized retained
 * source (issue #484 A1 deny-list), path allowlists, byte bounds,
 * dependency-pin allowlist. Never imports or executes the source. */
export function validateAppSource(files: unknown, deps: unknown): { files: AppFile[]; deps: AppDependency[] } {
  const failures: FieldFailure[] = [];
  const parsedFiles: AppFile[] = [];
  if (!Array.isArray(files) || files.length === 0 || files.length > APP_MAX_FILES) {
    throw invalid("INVALID_SOURCE", `App source must list 1 to ${APP_MAX_FILES} files.`);
  }
  const seen = new Set<string>();
  for (const entry of files) {
    if (!object(entry) || typeof entry.path !== "string" || typeof entry.content !== "string") {
      failures.push({ field: "files", code: "BAD_FILE", message: "Each file needs a path and string content." });
      continue;
    }
    const excluded = excludedAppPathReason(entry.path);
    if (excluded) {
      failures.push({
        field: entry.path,
        code: "EXCLUDED_PATH",
        message: `Retained app source excludes ${excluded} paths.`,
      });
      continue;
    }
    if (!APP_FILE_PATH.test(entry.path)) {
      failures.push({ field: entry.path, code: "BAD_PATH", message: "File paths must be relative slugs." });
      continue;
    }
    if (entry.path.includes("..")) {
      failures.push({ field: entry.path, code: "BAD_PATH", message: "File paths must not escape the app root." });
      continue;
    }
    if (seen.has(entry.path)) {
      failures.push({ field: entry.path, code: "DUPLICATE_PATH", message: "Duplicate file path." });
      continue;
    }
    seen.add(entry.path);
    if (new TextEncoder().encode(entry.content).byteLength > APP_MAX_FILE_BYTES) {
      failures.push({
        field: entry.path,
        code: "FILE_TOO_LARGE",
        message: `At most ${APP_MAX_FILE_BYTES} UTF-8 bytes per file.`,
      });
      continue;
    }
    parsedFiles.push({ path: entry.path, content: entry.content });
  }
  const parsedDeps: AppDependency[] = [];
  if (!Array.isArray(deps) || deps.length > APP_MAX_DEPS) {
    throw invalid("INVALID_SOURCE", `App dependencies must be a list of at most ${APP_MAX_DEPS}.`);
  }
  for (const entry of deps) {
    if (!object(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") {
      failures.push({ field: "dependencies", code: "BAD_DEP", message: "Each dependency needs a name and version." });
      continue;
    }
    if (!DEP_NAME.test(entry.name) || !DEP_VERSION.test(entry.version)) {
      failures.push({
        field: entry.name,
        code: "BAD_DEP",
        message: "Dependency names and versions must be simple slugs.",
      });
      continue;
    }
    const allowed = APP_DEP_ALLOWLIST[entry.name];
    if (!allowed || !allowed.includes(entry.version)) {
      failures.push({
        field: entry.name,
        code: "DEPENDENCY_UNRESOLVED",
        message: `Dependency "${entry.name}@${entry.version}" is not on the allowlist.`,
      });
      continue;
    }
    parsedDeps.push({ name: entry.name, version: entry.version });
  }
  if (parsedFiles.length === 0 && failures.length === 0) {
    throw invalid("INVALID_SOURCE", "App source must list at least one file.");
  }
  if (failures.length > 0) {
    throw invalid("APP_VALIDATION_FAILED", "The app source did not pass validation.", 422, failures);
  }
  return { files: parsedFiles, deps: parsedDeps };
}

interface AppRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  owner_kind: string;
  managed_by: string | null;
  status: string;
  active_deployment_id: string | null;
  created_at: string;
  updated_at: string;
}

function toSummary(row: AppRow, revision: number | null): AppSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerKind: row.owner_kind as AppOwnerKind,
    status: row.status as AppStatus,
    activeDeploymentId: row.active_deployment_id,
    revision,
    updatedAt: row.updated_at,
  };
}

async function latestRevisionNumber(db: D1Database, appId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT revision FROM app_revisions WHERE app_id=? ORDER BY revision DESC LIMIT 1")
    .bind(appId)
    .first<{ revision: number }>();
  return row?.revision ?? null;
}

/** Load one app for this Organization. Unknown ids (or foreign-Organization
 * ids) resolve to null so routes answer 404, never a cross-tenant leak. */
export async function loadApp(db: D1Database, caller: Principal, id: string): Promise<AppRow | null> {
  const row = await db.prepare("SELECT * FROM apps WHERE id=? AND org_id=?").bind(id, caller.orgId).first<AppRow>();
  return row ?? null;
}

function requireIndependent(row: AppRow): void {
  if (row.owner_kind !== "independent" || row.managed_by !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `App is managed by bundle install ${row.managed_by}: live mutation outside install is rejected.`,
      409,
    );
  }
}

/** Create an independent app. Solution-owned rows arrive via install, never
 * through this path. Slug conflicts fail with SLUG_CONFLICT (409). */
export async function createApp(db: D1Database, caller: Principal, name: unknown, slug: unknown): Promise<AppSummary> {
  const appName = parseAppName(name);
  const appSlug = parseAppSlug(slug);
  const now = new Date().toISOString();
  const org = await db.prepare("SELECT id FROM organizations WHERE id=?").bind(caller.orgId).first<{ id: string }>();
  if (!org) {
    await db.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(caller.orgId, "app-owner").run();
  }
  const id = crypto.randomUUID().toLowerCase();
  try {
    await db
      .prepare(
        "INSERT INTO apps(id, org_id, name, slug, owner_kind, managed_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'independent', NULL, 'created', ?, ?)",
      )
      .bind(id, caller.orgId, appName, appSlug, now, now)
      .run();
  } catch {
    throw invalid("SLUG_CONFLICT", `Slug "${appSlug}" is already claimed in this Organization.`, 409);
  }
  const row = (await loadApp(db, caller, id)) as AppRow;
  return toSummary(row, null);
}

export async function listApps(db: D1Database, caller: Principal): Promise<AppSummary[]> {
  const rows = await db
    .prepare("SELECT * FROM apps WHERE org_id=? ORDER BY updated_at DESC, id DESC")
    .bind(caller.orgId)
    .all<AppRow>();
  const summaries: AppSummary[] = [];
  for (const row of rows.results) {
    summaries.push(toSummary(row, await latestRevisionNumber(db, row.id)));
  }
  return summaries;
}

async function readRevisions(db: D1Database, appId: string): Promise<AppRevision[]> {
  const rows = await db
    .prepare(
      "SELECT revision, files_json, deps_json, validation, failures_json, created_at FROM app_revisions WHERE app_id=? ORDER BY revision ASC",
    )
    .bind(appId)
    .all<{
      revision: number;
      files_json: string;
      deps_json: string;
      validation: string;
      failures_json: string | null;
      created_at: string;
    }>();
  return rows.results.map((row) => ({
    revision: row.revision,
    files: JSON.parse(row.files_json) as AppFile[],
    dependencies: JSON.parse(row.deps_json) as AppDependency[],
    validation: row.validation as AppRevision["validation"],
    failures: row.failures_json ? (JSON.parse(row.failures_json) as FieldFailure[]) : null,
    createdAt: row.created_at,
  }));
}

async function readJobs(db: D1Database, appId: string, one?: string): Promise<AppJob[]> {
  const rows = one
    ? await db
        .prepare(
          "SELECT id, revision, status, error_json, created_at, started_at, finished_at FROM app_jobs WHERE app_id=? AND id=?",
        )
        .bind(appId, one)
        .all<{
          id: string;
          revision: number;
          status: string;
          error_json: string | null;
          created_at: string;
          started_at: string | null;
          finished_at: string | null;
        }>()
    : await db
        .prepare(
          "SELECT id, revision, status, error_json, created_at, started_at, finished_at FROM app_jobs WHERE app_id=? ORDER BY created_at DESC, id DESC LIMIT 50",
        )
        .bind(appId)
        .all<{
          id: string;
          revision: number;
          status: string;
          error_json: string | null;
          created_at: string;
          started_at: string | null;
          finished_at: string | null;
        }>();
  return rows.results.map((row) => ({
    id: row.id,
    revision: row.revision,
    status: row.status as JobStatus,
    error: row.error_json ? (JSON.parse(row.error_json) as { code: string; message: string }) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

async function readActiveDeployment(
  db: D1Database,
  appId: string,
  deploymentId: string | null,
): Promise<AppDeployment | null> {
  if (!deploymentId) return null;
  const row = await db
    .prepare("SELECT id, revision, content_hash, created_at FROM app_deployments WHERE id=? AND app_id=?")
    .bind(deploymentId, appId)
    .first<{ id: string; revision: number; content_hash: string; created_at: string }>();
  if (!row) return null;
  return { id: row.id, revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at };
}

export async function appDetail(db: D1Database, caller: Principal, id: string): Promise<AppDetail> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  const revisions = await readRevisions(db, row.id);
  return {
    ...toSummary(row, revisions.length > 0 ? revisions[revisions.length - 1]!.revision : null),
    createdAt: row.created_at,
    revisions,
    jobs: await readJobs(db, row.id),
    activeDeployment: await readActiveDeployment(db, row.id, row.active_deployment_id),
  };
}

/** Edit source declarations (independent only). Runs shape validation and
 * records the new revision as valid or invalid; invalid revisions carry
 * field-level failures and block build. */
export async function editAppSource(
  db: D1Database,
  caller: Principal,
  id: string,
  body: unknown,
): Promise<AppRevision> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  requireIndependent(row);
  if (!object(body)) throw invalid("INVALID_SOURCE", "App source must be a JSON object with files and dependencies.");
  const { parsed, failures } = tryValidate(body.files, body.dependencies);
  const next = ((await latestRevisionNumber(db, row.id)) ?? 0) + 1;
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO app_revisions(id, app_id, revision, files_json, deps_json, validation, failures_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID().toLowerCase(),
      row.id,
      next,
      JSON.stringify(parsed.files).slice(0, 16384),
      JSON.stringify(parsed.deps).slice(0, 4096),
      failures ? "invalid" : "valid",
      failures ? JSON.stringify(failures) : null,
      now,
    )
    .run();
  const status: AppStatus = failures ? "failed" : row.status === "live" ? "live" : "ready";
  await db.prepare("UPDATE apps SET status=?, updated_at=? WHERE id=?").bind(status, now, row.id).run();
  if (failures) {
    throw invalid("APP_VALIDATION_FAILED", "The app source did not pass validation.", 422, failures);
  }
  const revisions = await readRevisions(db, row.id);
  return revisions[revisions.length - 1] as AppRevision;
}

/** Validate the current revision without editing: returns the revision with
 * its stored validation outcome (invalid carries 422 + field failures). */
export async function validateApp(db: D1Database, caller: Principal, id: string): Promise<AppRevision> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  const revisions = await readRevisions(db, row.id);
  const current = revisions[revisions.length - 1];
  if (!current) throw invalid("NO_REVISION", "This app has no source revision to validate.", 409);
  if (current.validation === "invalid") {
    throw invalid("APP_VALIDATION_FAILED", "The app source did not pass validation.", 422, current.failures);
  }
  return current;
}

/** Start an async deploy job for the current revision (independent only,
 * validate-gated). The job runs synchronously in v1 (shape-only compile, no
 * execution): it re-validates, resolves pins, hashes content, stages the
 * deployment row, and moves active_deployment_id only on success. A failed
 * build leaves the prior pointer untouched (ADR 017 section 5). */
export async function startBuild(db: D1Database, caller: Principal, id: string): Promise<AppJob> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  requireIndependent(row);
  const revisions = await readRevisions(db, row.id);
  const current = revisions[revisions.length - 1];
  if (!current) throw invalid("NO_REVISION", "This app has no source revision to build.", 409);
  if (current.validation !== "valid") {
    throw invalid("REVISION_INVALID", "Only revisions that pass validation may build.", 409);
  }
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO app_jobs(id, app_id, revision, status, created_at, started_at) VALUES (?, ?, ?, 'running', ?, ?)",
    )
    .bind(jobId, row.id, current.revision, now, now)
    .run();
  await db.prepare("UPDATE apps SET status='building', updated_at=? WHERE id=?").bind(now, row.id).run();
  try {
    // Shape-only compile: re-validate declarations, resolve pins against the
    // static allowlist, hash content, stage the bundle. No import, no eval,
    // no package install (ADR 017 section 6).
    const checked = validateAppSource(current.files, current.dependencies);
    const bundle = JSON.stringify({ files: checked.files, dependencies: checked.deps });
    const contentHash = await hash(`wrangnarok.app.v1|${row.id}|${current.revision}|${bundle}`);
    const deploymentId = crypto.randomUUID().toLowerCase();
    await db
      .prepare(
        "INSERT INTO app_deployments(id, app_id, revision, bundle_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(deploymentId, row.id, current.revision, bundle.slice(0, 16384), contentHash, now)
      .run();
    // Activation: move the pointer only on success, fenced on still-building.
    const applied = await db
      .prepare("UPDATE apps SET status='live', active_deployment_id=?, updated_at=? WHERE id=? AND status='building'")
      .bind(deploymentId, now, row.id)
      .run();
    if (applied.meta.changes === 0) {
      throw invalid("BUILD_SUPERSEDED", "A newer build superseded this one.", 409);
    }
    // Upstream parity: superseded compiled artifacts are deleted — keep only
    // the active row. No retained-history rollback UI (ADR 017 section 4).
    await db.prepare("DELETE FROM app_deployments WHERE app_id=? AND id<>?").bind(row.id, deploymentId).run();
    await db
      .prepare("UPDATE app_jobs SET status='succeeded', finished_at=? WHERE id=?")
      .bind(new Date().toISOString(), jobId)
      .run();
  } catch (error) {
    const safe =
      error instanceof Fault
        ? { code: error.code, message: error.message }
        : { code: "BUILD_FAILED", message: "The build could not complete." };
    await db
      .prepare("UPDATE app_jobs SET status='failed', error_json=?, finished_at=? WHERE id=?")
      .bind(JSON.stringify(safe), new Date().toISOString(), jobId)
      .run();
    // Failed builds preserve the prior usable app: restore live when there
    // was one, else ready. The pointer is never cleared here.
    const prior = row.active_deployment_id ? "live" : "ready";
    await db
      .prepare("UPDATE apps SET status=?, updated_at=? WHERE id=?")
      .bind(prior, new Date().toISOString(), row.id)
      .run();
    if (error instanceof Fault && error.code === "BUILD_SUPERSEDED") throw error;
    return (await readJobs(db, row.id, jobId))[0] as AppJob;
  }
  return (await readJobs(db, row.id, jobId))[0] as AppJob;
}

export async function listJobs(db: D1Database, caller: Principal, id: string): Promise<AppJob[]> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  return readJobs(db, row.id);
}

export async function jobDetail(db: D1Database, caller: Principal, id: string, jobId: string): Promise<AppJob> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  if (!UUID.test(jobId)) throw invalid("INVALID_JOB_ID", "Job lookups need the exact job UUID.", 400);
  const jobs = await readJobs(db, row.id, jobId.toLowerCase());
  const job = jobs[0];
  if (!job) throw invalid("JOB_NOT_FOUND", "Deploy job not found.", 404);
  return job;
}

/** Parked-old-app slug swap recovery (ADR 017 section 4): exchange the slugs
 * of two apps in the same Organization, fenced on both current slugs. A lost
 * race surfaces SLUG_CONFLICT, never a silent double-claim. */
export async function swapSlugs(
  db: D1Database,
  caller: Principal,
  id: string,
  otherId: string,
): Promise<{ app: AppSummary; other: AppSummary }> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  const other = await loadApp(db, caller, parseAppId(otherId));
  if (!other) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  requireIndependent(row);
  requireIndependent(other);
  if (row.id === other.id) throw invalid("INVALID_SWAP", "Swap needs two different apps.", 400);
  const now = new Date().toISOString();
  const slugA = row.slug;
  const slugB = other.slug;
  const parking = `__swap_${row.id.slice(0, 8)}`;
  await db
    .prepare("UPDATE apps SET slug=?, updated_at=? WHERE id=? AND slug=?")
    .bind(parking, now, row.id, slugA)
    .run();
  const takeB = await db
    .prepare("UPDATE apps SET slug=?, updated_at=? WHERE id=? AND slug=?")
    .bind(slugA, now, other.id, slugB)
    .run();
  if (takeB.meta.changes === 0) {
    await db.prepare("UPDATE apps SET slug=?, updated_at=? WHERE id=?").bind(slugA, now, row.id).run();
    throw invalid("SLUG_CONFLICT", "The parked app slug changed under swap.", 409);
  }
  const takeA = await db
    .prepare("UPDATE apps SET slug=?, updated_at=? WHERE id=? AND slug=?")
    .bind(slugB, now, row.id, parking)
    .run();
  if (takeA.meta.changes === 0) {
    throw invalid("SLUG_CONFLICT", "The app slug changed under swap.", 409);
  }
  const freshA = (await loadApp(db, caller, row.id)) as AppRow;
  const freshB = (await loadApp(db, caller, other.id)) as AppRow;
  return {
    app: toSummary(freshA, await latestRevisionNumber(db, freshA.id)),
    other: toSummary(freshB, await latestRevisionNumber(db, freshB.id)),
  };
}

/** Delete an independent app. Solution-owned rows refuse: uninstall owns
 * that path (SOL-02). Deleting frees the slug; rebuilds are new apps. */
export async function deleteApp(db: D1Database, caller: Principal, id: string): Promise<void> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  requireIndependent(row);
  await db.prepare("DELETE FROM apps WHERE id=?").bind(row.id).run();
}

/** Serve one asset file from the ACTIVE deployment only (ADR 017 section 5).
 * Same Organization caller; foreign rows answer 404. Serves stored bundle
 * data, never platform code. */
export async function serveAsset(
  db: D1Database,
  caller: Principal,
  id: string,
  assetPath: string,
): Promise<{ content: string; contentHash: string }> {
  const row = await loadApp(db, caller, parseAppId(id));
  if (!row) throw invalid("APP_NOT_FOUND", "App not found.", 404);
  if (!row.active_deployment_id) throw invalid("APP_NOT_LIVE", "This app has no active deployment.", 404);
  if (assetPath.length === 0 || assetPath.length > 128 || assetPath.includes("..")) {
    throw invalid("INVALID_ASSET", "Asset paths must be short relative paths.", 400);
  }
  const deployment = await db
    .prepare("SELECT bundle_json, content_hash FROM app_deployments WHERE id=? AND app_id=?")
    .bind(row.active_deployment_id, row.id)
    .first<{ bundle_json: string; content_hash: string }>();
  if (!deployment) throw invalid("APP_NOT_LIVE", "This app has no active deployment.", 404);
  const bundle = JSON.parse(deployment.bundle_json) as { files: AppFile[] };
  const file = bundle.files.find((entry) => entry.path === assetPath);
  if (!file) throw invalid("ASSET_NOT_FOUND", "Asset not found in the active deployment.", 404);
  return { content: file.content, contentHash: deployment.content_hash };
}

/** Parse a swap request body: { otherAppId }. */
export function parseSwapBody(value: unknown): string {
  if (!object(value) || typeof value.otherAppId !== "string" || !UUID.test(value.otherAppId)) {
    throw invalid("INVALID_SWAP", "Swap needs { otherAppId } with the parked app UUID.");
  }
  return (value.otherAppId as string).toLowerCase();
}

/** Parse an app create/update body: { name, slug } / { files, dependencies }. */
export function parseAppBody(value: unknown): { name: unknown; slug: unknown } {
  if (!object(value)) throw invalid("INVALID_APP", "The app body must be a JSON object.");
  return { name: value.name, slug: value.slug };
}
