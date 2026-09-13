// SPDX-License-Identifier: AGPL-3.0
// Portable Solution source capture, export, and import (SOL-03, issue #163).
//
// A shareable source package is versioned JSON (`wrangnarok.solution-source`,
// format 1): source identity plus readme/logo/requirements, the v1 install
// manifest, per-Saga module metadata, small text assets, and export metadata.
// It carries declarations only: Saga pins, Integration endpoints, config
// values, and secretsRequired names. It never carries credential values,
// table rows, Execution/Operation state, or runtime artifact bytes.
//
// Intentional JSON-versus-upstream packaging difference (recorded, not
// hidden): upstream ships a zip of `bifrost.solution.yaml` plus
// `.bifrost/*.yaml` declarations. Wrangnarok ships one JSON document because
// Workers parse JSON natively with no YAML or zip dependency, and Sagas stay
// code-first TypeScript in the Git tree the manifest points at. No workflow
// DSL is introduced here: `modules` pins revisions, it never embeds behavior.
//
// Source/install identity mapping: the portable side keeps the stable source
// UUID (`bundle.id`, operator-supplied, survives renames). Each install maps
// it deterministically per Organization and Integration via
// mapSourceToInstall, which MUST match the derivation installBundle uses for
// managed Connection rows (cross-checked by test/solution-export.test.ts).
//
// Separation of duties, enforced by the API shape:
// - previewCaptureSource / captureSource are READ-ONLY over D1 (SELECTs
//   only). Capture never adopts loose rows and never writes managed rows.
// - exportSourcePackage serializes and scans; runExportJob stages files with
//   guaranteed cleanup on failure.
// - importSourcePackage validates and checks the dependency closure. It does
//   NOT install: adoption is installBundle (with its preflight deploy
//   blockers) as a separate explicit operator step.
// - Operational backup/restore (encrypted, with rows and bytes) is tracked
//   separately under OPS-03. Source export is not a data backup.
//
// This module imports only node-safe dependencies (domain, integrations
// index, solutions): it bundles into plain-node runners with esbuild and runs
// in workerd tests without Cloudflare bindings.
import {
  digestSaga,
  echoSaga,
  ECHO_INTEGRATION_ID,
  Fault,
  hash,
  helloSaga,
  helloParentSaga,
  ninjaSaga,
  NINJA_INTEGRATION_ID,
  object,
  smokeSaga,
  UUID,
} from "./domain";
import { INTEGRATION_DEFINITIONS } from "./integrations";
import { parseBundleManifest } from "./solutions";
import type { BundleManifest } from "./solutions";

/** Shareable package envelope tag. Any other tag is rejected, never coerced. */
export const SOURCE_FORMAT = "wrangnarok.solution-source" as const;
/** Only format 1 exists. A higher number means a newer producer: refuse. */
export const SOURCE_FORMAT_VERSION = 1 as const;
/** Whole-package byte cap (UTF-8 JSON): source text only, Free-viable. */
export const SOURCE_PACKAGE_MAX_BYTES = 65536;
export const SOURCE_README_MAX_CHARS = 8192;
export const SOURCE_LOGO_SVG_MAX_CHARS = 16384;
export const SOURCE_ASSET_TEXT_MAX_CHARS = 8192;
export const SOURCE_ASSET_MAX_COUNT = 16;
export const SOURCE_NOTES_MAX_COUNT = 16;
export const SOURCE_NOTE_MAX_CHARS = 280;
/** Upstream baseline this format maps against (informational metadata). */
export const SOURCE_UPSTREAM_BASELINE = "gobifrost/bifrost@3543c7e" as const;

const BUNDLE_NAME = /^[a-z0-9][a-z0-9.-]*$/i;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** Portable asset paths: relative, forward slashes, no escapes. */
const ASSET_PATH = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const ASSET_CONTENT_TYPES = new Set(["text/markdown", "text/plain", "application/json", "image/svg+xml"]);
const GIT_COMMIT = /^[a-f0-9]{7,40}$/i;
const MAX_WALK_DEPTH = 32;
/** Manifests must never carry credential values: any config key shaped like a
 * credential fails validation (same rule as the installer). */
const CREDENTIAL_KEY =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)/i;
/** Legit schema keys that merely contain a credential substring. */
const CREDENTIAL_KEY_ALLOWLIST = new Set(["secretsRequired"]);
/** Tenant/runtime state that shareable source must never contain. */
const FORBIDDEN_KEYS = new Set([
  "tableRows",
  "tableData",
  "rows",
  "executions",
  "operations",
  "operationHistory",
  "executionHistory",
  "artifactBytes",
  "artifacts",
  "files",
  "fileBytes",
  "secrets",
  "secretsEnc",
  "configValues",
  "connectionSecrets",
  "credentials",
  "tokens",
]);
/** Platform requirements a source package may declare. Unknown names fail
 * closed: portable source must not demand unknown platform features. */
const KNOWN_REQUIREMENTS: Readonly<Record<string, string>> = Object.freeze({
  "wrangnarok.manifest": "1",
  "wrangnarok.source-format": "1",
});

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Static code Saga snapshot (same precedent as solutions.ts CODE_SAGAS):
 * stable IDs and revision pins from domain constants plus the declared
 * Integration requirements from the Saga definitions. test/solution-export
 * asserts this snapshot agrees with the live SAGA_DEFINITIONS. */
export interface CodeSagaPin {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly requiredIntegrations: readonly string[];
}

export interface CodeIntegrationDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly secretFields: readonly string[];
}

export interface SourceCatalogs {
  readonly sagas: readonly CodeSagaPin[];
  readonly integrations: readonly CodeIntegrationDef[];
}

const CODE_SAGAS: readonly CodeSagaPin[] = Object.freeze([
  { ...echoSaga, requiredIntegrations: Object.freeze([ECHO_INTEGRATION_ID]) },
  { ...ninjaSaga, requiredIntegrations: Object.freeze([NINJA_INTEGRATION_ID]) },
  { ...digestSaga, requiredIntegrations: Object.freeze([NINJA_INTEGRATION_ID, ECHO_INTEGRATION_ID]) },
  { ...smokeSaga, requiredIntegrations: Object.freeze([]) },
  { ...helloSaga, requiredIntegrations: Object.freeze([]) },
  { ...helloParentSaga, requiredIntegrations: Object.freeze([]) },
]);

/** Node-safe static catalogs: no Workflows runtime import, so plain-node
 * runners can bundle this module with esbuild. */
export function staticSourceCatalogs(): SourceCatalogs {
  return {
    sagas: CODE_SAGAS,
    integrations: Object.freeze(
      INTEGRATION_DEFINITIONS.map((def) =>
        Object.freeze({ id: def.id, name: def.name, description: def.description, secretFields: def.secretFields }),
      ),
    ),
  };
}

export interface SourceRequirement {
  readonly name: string;
  readonly version: string;
}

export interface SourceLogo {
  readonly contentType: "image/svg+xml";
  readonly svg: string;
}

export interface SourceGit {
  readonly repo?: string;
  readonly commit?: string;
}

export interface SourceInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly readme?: string;
  readonly logo?: SourceLogo;
  readonly requirements: readonly SourceRequirement[];
  readonly git?: SourceGit;
}

export interface SourceModule {
  readonly sagaId: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly requiredIntegrations: readonly string[];
}

export interface SourceAsset {
  readonly path: string;
  readonly contentType: string;
  readonly text: string;
}

export interface SourceMetadata {
  readonly exportedAt: string;
  readonly exporter: string;
  readonly upstream: string;
  readonly notes: readonly string[];
}

export interface SourcePackage {
  readonly format: typeof SOURCE_FORMAT;
  readonly formatVersion: typeof SOURCE_FORMAT_VERSION;
  readonly source: SourceInfo;
  readonly manifest: BundleManifest;
  readonly modules: readonly SourceModule[];
  readonly assets: readonly SourceAsset[];
  readonly metadata: SourceMetadata;
}

/** One capture/import gap: a named, actionable finding. Blocking gaps stop
 * capture and fail import; non-blocking gaps are reported, never silently
 * adopted or dropped. */
export interface SourceGap {
  /** MISSING_MODULE, INTEGRATION_NOT_DECLARED, SECRET_SCHEMA_MISMATCH,
   * MISSING_MANAGED_ROW, DRIFTED_CONNECTION, OWNERSHIP_MISMATCH,
   * LOOSE_RESOURCE_NOT_ADOPTED, ORG_NOT_DECLARED. */
  readonly reason: string;
  readonly detail: string;
  readonly blocking: boolean;
}

export interface CaptureOptions {
  readonly catalogs?: SourceCatalogs;
  /** Scope verification to one manifest org name. Unset verifies every
   * declared org. */
  readonly orgName?: string;
  readonly readme?: string;
  readonly logo?: SourceLogo;
  readonly git?: SourceGit;
  readonly exporter?: string;
}

export interface ExportOptions {
  readonly catalogs?: SourceCatalogs;
  /** Secret values available to the caller (env/Secrets Store): the export
   * fails closed when any value appears in the serialized package. Names
   * are reported, values never. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly exporter?: string;
}

/** Walk raw untrusted input before schema validation: reject prototype
 * pollution keys, tenant-state sections, and credential-shaped keys
 * anywhere in the document, at any depth. */
function scanUntrusted(value: unknown, depth = 0, path = "$"): void {
  if (depth > MAX_WALK_DEPTH) {
    throw invalid("INVALID_SOURCE", `The source document nests too deeply at ${path}: refusing to walk it.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanUntrusted(entry, depth + 1, `${path}[${index}]`));
    return;
  }
  if (!object(value)) return;
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw invalid(
        "INVALID_SOURCE",
        `The source document carries a forbidden key "${key}" at ${path}: refusing to adopt it.`,
      );
    }
    if (FORBIDDEN_KEYS.has(key)) {
      throw invalid(
        "TENANT_STATE_EXCLUDED",
        `The source document carries "${key}" at ${path}: table rows, execution state, artifact bytes, and credential values are never shareable source.`,
      );
    }
    if (CREDENTIAL_KEY.test(key) && !CREDENTIAL_KEY_ALLOWLIST.has(key)) {
      throw invalid(
        "CREDENTIAL_IN_SOURCE",
        `The source document carries a credential-shaped key "${key}" at ${path}: portable source carries secretsRequired names only, never values.`,
      );
    }
    scanUntrusted((value as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
  }
}

function checkSlug(value: unknown, what: string): string {
  if (typeof value !== "string" || !BUNDLE_NAME.test(value)) {
    throw invalid("INVALID_SOURCE", `${what} must be a simple slug.`);
  }
  return value;
}

function validateRequirements(raw: unknown): SourceRequirement[] {
  if (!Array.isArray(raw)) throw invalid("INVALID_SOURCE", "The source requirements must be a list.");
  return raw.map((entry: unknown) => {
    if (!object(entry) || typeof entry.name !== "string" || typeof entry.version !== "string") {
      throw invalid("INVALID_SOURCE", "Every source requirement needs a string name and version.");
    }
    const expected = KNOWN_REQUIREMENTS[entry.name];
    if (expected === undefined) {
      throw invalid(
        "REQUIREMENT_UNSATISFIED",
        `Source requirement "${entry.name}" is unknown to this platform: refusing to adopt source that demands unknown features.`,
      );
    }
    if (entry.version !== expected) {
      throw invalid(
        "REQUIREMENT_UNSATISFIED",
        `Source requirement "${entry.name}" wants version "${entry.version}" but this platform supports "${expected}".`,
      );
    }
    return { name: entry.name, version: entry.version };
  });
}

function validateLogo(raw: unknown): SourceLogo {
  if (!object(raw)) throw invalid("INVALID_SOURCE", "The source logo must be an object.");
  if (raw.contentType !== "image/svg+xml") {
    throw invalid(
      "INVALID_SOURCE",
      "The source logo must be inline SVG (contentType image/svg+xml): no remote logo URLs.",
    );
  }
  if (typeof raw.svg !== "string" || raw.svg.length === 0 || raw.svg.length > SOURCE_LOGO_SVG_MAX_CHARS) {
    throw invalid(
      "INVALID_SOURCE",
      `The source logo SVG must be 1 to ${SOURCE_LOGO_SVG_MAX_CHARS} chars of inline markup.`,
    );
  }
  const head = raw.svg.slice(0, 200).toLowerCase();
  if (!head.includes("<svg")) {
    throw invalid("INVALID_SOURCE", "The source logo SVG must be inline SVG markup, not a reference.");
  }
  const lowered = raw.svg.toLowerCase();
  if (lowered.includes("<script") || lowered.includes("http://") || lowered.includes("https://")) {
    throw invalid("INVALID_SOURCE", "The source logo SVG must be self-contained: no scripts and no remote references.");
  }
  return { contentType: "image/svg+xml", svg: raw.svg };
}

function validateGit(raw: unknown): SourceGit {
  if (!object(raw)) throw invalid("INVALID_SOURCE", "The source git pointer must be an object.");
  const out: { repo?: string; commit?: string } = {};
  if (raw.repo !== undefined) {
    if (typeof raw.repo !== "string" || raw.repo.length > 256 || !/^https:\/\/[^\s@]+$/.test(raw.repo)) {
      throw invalid(
        "INVALID_SOURCE",
        "The source git repo must be an https URL without embedded credentials: it is informational, never authoritative.",
      );
    }
    out.repo = raw.repo;
  }
  if (raw.commit !== undefined) {
    if (typeof raw.commit !== "string" || !GIT_COMMIT.test(raw.commit)) {
      throw invalid("INVALID_SOURCE", "The source git commit must be 7 to 40 hex chars.");
    }
    out.commit = raw.commit;
  }
  return out;
}

function validateSourceInfo(raw: unknown, manifest: BundleManifest): SourceInfo {
  if (!object(raw)) throw invalid("INVALID_SOURCE", "The source identity must be an object.");
  if (typeof raw.id !== "string" || !UUID.test(raw.id)) {
    throw invalid("INVALID_SOURCE", "The source id must be a stable UUID.");
  }
  const name = checkSlug(raw.name, "The source name");
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) {
    throw invalid("INVALID_SOURCE", "The source version must be major.minor.patch.");
  }
  if (raw.id !== manifest.bundle.id || name !== manifest.bundle.name || raw.version !== manifest.bundle.version) {
    throw invalid(
      "SOURCE_MANIFEST_MISMATCH",
      "The source identity must match the manifest bundle id, name, and version: a package never mixes identities.",
      409,
    );
  }
  let readme: string | undefined;
  if (raw.readme !== undefined) {
    if (typeof raw.readme !== "string" || raw.readme.length === 0 || raw.readme.length > SOURCE_README_MAX_CHARS) {
      throw invalid("INVALID_SOURCE", `The source readme must be 1 to ${SOURCE_README_MAX_CHARS} chars of markdown.`);
    }
    readme = raw.readme;
  }
  const requirements = validateRequirements(raw.requirements);
  return {
    id: raw.id,
    name,
    version: raw.version,
    ...(readme === undefined ? {} : { readme }),
    ...(raw.logo === undefined ? {} : { logo: validateLogo(raw.logo) }),
    requirements: Object.freeze(requirements),
    ...(raw.git === undefined ? {} : { git: validateGit(raw.git) }),
  };
}

function validateAsset(raw: unknown, seen: Set<string>): SourceAsset {
  if (!object(raw)) throw invalid("INVALID_SOURCE", "Every source asset must be an object.");
  if (typeof raw.path !== "string" || !ASSET_PATH.test(raw.path)) {
    throw invalid(
      "INVALID_ASSET_PATH",
      "Every source asset path must be relative, forward-slash separated, and free of escapes.",
    );
  }
  const segments = raw.path.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw invalid(
      "INVALID_ASSET_PATH",
      `Source asset path "${raw.path}" escapes its directory: "..", ".", and empty segments are refused.`,
    );
  }
  if (seen.has(raw.path)) {
    throw invalid("DUPLICATE_ASSET_PATH", `Source asset path "${raw.path}" appears twice.`, 409);
  }
  seen.add(raw.path);
  if (typeof raw.contentType !== "string" || !ASSET_CONTENT_TYPES.has(raw.contentType)) {
    throw invalid(
      "INVALID_SOURCE",
      `Source asset "${raw.path}" carries contentType "${typeof raw.contentType === "string" ? raw.contentType : "?"}": only small text types are portable.`,
    );
  }
  if (typeof raw.text !== "string" || raw.text.length > SOURCE_ASSET_TEXT_MAX_CHARS) {
    throw invalid(
      "INVALID_SOURCE",
      `Source asset "${raw.path}" must carry at most ${SOURCE_ASSET_TEXT_MAX_CHARS} chars of inline text.`,
    );
  }
  return { path: raw.path, contentType: raw.contentType, text: raw.text };
}

function validateMetadata(raw: unknown, exporter: string): SourceMetadata {
  if (!object(raw)) throw invalid("INVALID_SOURCE", "The source metadata must be an object.");
  if (typeof raw.exportedAt !== "string" || Number.isNaN(Date.parse(raw.exportedAt))) {
    throw invalid("INVALID_SOURCE", "The source metadata needs an ISO exportedAt instant.");
  }
  if (typeof exporter !== "string" || exporter.length === 0 || exporter.length > 64) {
    throw invalid("INVALID_SOURCE", "The source exporter must be 1 to 64 chars.");
  }
  if (typeof raw.upstream !== "string" || !raw.upstream.startsWith("gobifrost/bifrost@") || raw.upstream.length > 128) {
    throw invalid("INVALID_SOURCE", "The source metadata must name its gobifrost/bifrost baseline.");
  }
  if (!Array.isArray(raw.notes) || raw.notes.length > SOURCE_NOTES_MAX_COUNT) {
    throw invalid("INVALID_SOURCE", `The source metadata notes hold at most ${SOURCE_NOTES_MAX_COUNT} entries.`);
  }
  for (const note of raw.notes) {
    if (typeof note !== "string" || note.length === 0 || note.length > SOURCE_NOTE_MAX_CHARS) {
      throw invalid("INVALID_SOURCE", "Every source metadata note must be 1 to 280 chars.");
    }
  }
  return {
    exportedAt: raw.exportedAt,
    exporter,
    upstream: raw.upstream,
    notes: Object.freeze([...(raw.notes as string[])]),
  };
}

/** Default notes recorded on every capture: the JSON-versus-upstream
 * packaging difference and the not-a-backup boundary, stated in the package
 * itself so reviewers see them without opening the ADR. */
export function defaultSourceNotes(): readonly string[] {
  return Object.freeze([
    "Packaging: single versioned JSON document. Upstream ships a zip of bifrost.solution.yaml plus .bifrost/*.yaml; this package parses with the Worker JSON runtime and no YAML or zip dependency. Same ideology (source plus declarations only).",
    "Sagas stay code-first TypeScript in the Git tree the manifest points at. Module entries pin revisions; they never embed behavior and introduce no workflow DSL.",
    "Portable source only, not a data backup: no table rows, no execution state, no artifact bytes, no credential values. Encrypted operational backup and restore are tracked separately under OPS-03.",
  ]);
}

/** Dependency-closure check over an assembled package: every Saga resolves
 * against the code catalog with a matching revision, every Saga requirement
 * is declared by the manifest, and every secretsRequired name exists in the
 * Integration secret schema. Returns gaps; blocking gaps fail import. */
export function checkClosure(
  manifest: BundleManifest,
  modules: readonly SourceModule[],
  catalogs: SourceCatalogs,
): SourceGap[] {
  const gaps: SourceGap[] = [];
  const declaredIntegrations = new Set(manifest.integrations.map((entry) => entry.id));
  for (const module of modules) {
    const catalog = catalogs.sagas.find((entry) => entry.id === module.sagaId);
    if (!catalog) {
      gaps.push({
        reason: "MISSING_MODULE",
        detail: `Saga ${module.sagaId} ("${module.name}") is not in the code catalog: install the module or drop the pin before sharing.`,
        blocking: true,
      });
      continue;
    }
    if (catalog.revision !== module.revision) {
      gaps.push({
        reason: "REVISION_MISMATCH",
        detail: `Saga "${catalog.name}" pins revision "${module.revision}" but deployed code is "${catalog.revision}".`,
        blocking: true,
      });
    }
    for (const required of module.requiredIntegrations) {
      if (!declaredIntegrations.has(required)) {
        const def = catalogs.integrations.find((entry) => entry.id === required);
        gaps.push({
          reason: "INTEGRATION_NOT_DECLARED",
          detail: `Saga "${catalog.name}" requires Integration "${def?.name ?? required}" (${required}) but the manifest declares no connection for it.`,
          blocking: true,
        });
      }
    }
  }
  for (const integration of manifest.integrations) {
    const def = catalogs.integrations.find((entry) => entry.id === integration.id);
    if (!def) {
      gaps.push({
        reason: "UNKNOWN_INTEGRATION",
        detail: `Integration ${integration.id} is not in the code catalog.`,
        blocking: true,
      });
      continue;
    }
    for (const conn of integration.connections) {
      for (const name of conn.secretsRequired) {
        if (!def.secretFields.includes(name)) {
          gaps.push({
            reason: "SECRET_SCHEMA_MISMATCH",
            detail: `Secret "${name}" is not in the "${def.name}" Integration secret schema.`,
            blocking: true,
          });
        }
      }
    }
  }
  return gaps;
}

/** Deterministic source-to-install identity mapping (ADR 011 section 3):
 * the managed Connection id for one source bundle installed into one
 * Organization. MUST match the derivation installBundle uses; the round-trip
 * test proves it against a real install row. */
export async function mapSourceToInstall(bundleId: string, orgId: string, integrationId: string): Promise<string> {
  if (!UUID.test(bundleId) || !UUID.test(orgId) || !UUID.test(integrationId)) {
    throw invalid("INVALID_SOURCE", "Source-to-install mapping needs stable UUIDs for bundle, org, and integration.");
  }
  const hex = await hash(JSON.stringify(["wrangnarok.connection.v1", bundleId, orgId, integrationId]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildModules(
  manifest: BundleManifest,
  catalogs: SourceCatalogs,
): { modules: SourceModule[]; gaps: SourceGap[] } {
  const modules: SourceModule[] = [];
  const gaps: SourceGap[] = [];
  for (const pin of manifest.sagas) {
    const catalog = catalogs.sagas.find((entry) => entry.id === pin.id);
    if (!catalog) {
      gaps.push({
        reason: "MISSING_MODULE",
        detail: `Saga ${pin.id} is pinned by the manifest but missing from the code catalog: install the module first.`,
        blocking: true,
      });
      continue;
    }
    modules.push({
      sagaId: catalog.id,
      name: catalog.name,
      revision: pin.revision,
      description: catalog.description,
      requiredIntegrations: [...catalog.requiredIntegrations],
    });
  }
  for (const gap of checkClosure(manifest, modules, catalogs)) gaps.push(gap);
  return { modules, gaps };
}

/** Verify declared Connections against live D1 state (SELECTs only). Managed
 * rows owned by this bundle must exist and match; loose rows are reported
 * and never adopted; drift and foreign ownership block capture. */
async function verifyLiveState(
  db: D1Database,
  manifest: BundleManifest,
  opts: { orgName?: string },
): Promise<SourceGap[]> {
  const gaps: SourceGap[] = [];
  const bundleId = manifest.bundle.id;
  const wanted = new Map<string, { endpoint: string; integrationName: string }>();
  for (const integration of manifest.integrations) {
    for (const conn of integration.connections) {
      if (opts.orgName !== undefined && conn.org !== opts.orgName) continue;
      wanted.set(`${conn.org}::${integration.id}`, {
        endpoint: conn.config.endpoint as string,
        integrationName: integration.id,
      });
    }
  }
  if (opts.orgName !== undefined && wanted.size === 0) {
    gaps.push({
      reason: "ORG_NOT_DECLARED",
      detail: `Org "${opts.orgName}" declares no connections in this manifest.`,
      blocking: true,
    });
    return gaps;
  }
  const orgIds = new Map<string, string>();
  for (const key of wanted.keys()) {
    const org = key.slice(0, key.lastIndexOf("::"));
    if (orgIds.has(org)) continue;
    const row = await db.prepare("SELECT id FROM organizations WHERE name = ?").bind(org).first<{ id: string }>();
    if (row) orgIds.set(org, row.id);
  }
  for (const [key, desired] of wanted) {
    const org = key.slice(0, key.lastIndexOf("::"));
    const integrationId = key.slice(key.lastIndexOf("::") + 2);
    const orgId = orgIds.get(org);
    if (orgId === undefined) {
      gaps.push({
        reason: "MISSING_MANAGED_ROW",
        detail: `Org "${org}" has no row for a declared connection: install the bundle before capturing source from it.`,
        blocking: true,
      });
      continue;
    }
    const current = await db
      .prepare("SELECT endpoint, managed_by FROM connections WHERE org_id = ? AND integration_id = ?")
      .bind(orgId, integrationId)
      .first<{ endpoint: string; managed_by: string | null }>();
    if (!current) {
      gaps.push({
        reason: "MISSING_MANAGED_ROW",
        detail: `Org "${org}" has no Connection for Integration ${integrationId}: install the bundle before capturing.`,
        blocking: true,
      });
      continue;
    }
    if (current.managed_by === null) {
      gaps.push({
        reason: "LOOSE_RESOURCE_NOT_ADOPTED",
        detail: `Org "${org}" holds a loose Connection for Integration ${integrationId} (managed_by NULL): capture leaves it out. Adopt it with an explicit install, never by capture.`,
        blocking: false,
      });
      gaps.push({
        reason: "MISSING_MANAGED_ROW",
        detail: `Org "${org}" has no managed Connection for Integration ${integrationId}: the loose row is not adopted.`,
        blocking: true,
      });
      continue;
    }
    if (!current.managed_by.startsWith(`${bundleId}@`)) {
      gaps.push({
        reason: "OWNERSHIP_MISMATCH",
        detail: `Org "${org}" Connection for Integration ${integrationId} is managed by ${current.managed_by}, not this bundle: capture across ownership boundaries is refused.`,
        blocking: true,
      });
      continue;
    }
    if (current.endpoint !== desired.endpoint) {
      gaps.push({
        reason: "DRIFTED_CONNECTION",
        detail: `Org "${org}" Connection for Integration ${integrationId} serves "${current.endpoint}" but the manifest declares "${desired.endpoint}": reconcile with install before capturing.`,
        blocking: true,
      });
    }
  }
  return gaps;
}

/**
 * Preview what capture would package: assemble the shareable source from the
 * manifest plus the code catalog, verify it against live D1 state, and
 * report gaps. READ-ONLY: runs SELECTs only, writes nothing, adopts nothing.
 */
export async function previewCaptureSource(
  db: D1Database,
  manifestRaw: unknown,
  opts: CaptureOptions = {},
): Promise<{ package: SourcePackage; gaps: SourceGap[] }> {
  const catalogs = opts.catalogs ?? staticSourceCatalogs();
  const manifest = parseBundleManifest(manifestRaw);
  if (opts.readme !== undefined && (typeof opts.readme !== "string" || opts.readme.length === 0)) {
    throw invalid("INVALID_SOURCE", "The capture readme must be a non-empty string when supplied.");
  }
  const { modules, gaps } = buildModules(manifest, catalogs);
  const source: SourceInfo = {
    id: manifest.bundle.id,
    name: manifest.bundle.name,
    version: manifest.bundle.version,
    ...(opts.readme === undefined ? {} : { readme: opts.readme }),
    ...(opts.logo === undefined ? {} : { logo: validateLogo(opts.logo) }),
    requirements: Object.freeze(Object.entries(KNOWN_REQUIREMENTS).map(([name, version]) => ({ name, version }))),
    ...(opts.git === undefined ? {} : { git: validateGit(opts.git) }),
  };
  const validatedSource = validateSourceInfo(
    {
      ...source,
      requirements: [...source.requirements],
      ...(source.git === undefined ? {} : { git: { ...source.git } }),
    },
    manifest,
  );
  // The readme cap is enforced by validateSourceInfo above: reaching here
  // with an oversized readme is impossible, so no second check.
  const metadata: SourceMetadata = {
    exportedAt: new Date().toISOString(),
    exporter: opts.exporter ?? "wrangnarok-export",
    upstream: SOURCE_UPSTREAM_BASELINE,
    notes: defaultSourceNotes(),
  };
  const live = await verifyLiveState(db, manifest, {
    ...(opts.orgName === undefined ? {} : { orgName: opts.orgName }),
  });
  return {
    package: {
      format: SOURCE_FORMAT,
      formatVersion: SOURCE_FORMAT_VERSION,
      source: validatedSource,
      manifest,
      modules: Object.freeze(modules),
      assets: Object.freeze([]),
      metadata,
    },
    gaps: [...gaps, ...live],
  };
}

/**
 * Capture shareable source, failing closed: throws CAPTURE_BLOCKED (with the
 * blocking gaps as details) when verification finds anything capture must
 * not silently absorb. Still READ-ONLY over D1.
 */
export async function captureSource(
  db: D1Database,
  manifestRaw: unknown,
  opts: CaptureOptions = {},
): Promise<{ package: SourcePackage; gaps: SourceGap[] }> {
  const preview = await previewCaptureSource(db, manifestRaw, opts);
  const blocking = preview.gaps.filter((gap) => gap.blocking);
  if (blocking.length > 0) {
    throw new Fault(
      409,
      "CAPTURE_BLOCKED",
      `Source capture is blocked by ${blocking.length} finding(s): ${blocking.map((gap) => gap.reason).join(", ")}.`,
      blocking,
    );
  }
  return preview;
}

function validateEnvelope(raw: unknown): asserts raw is Record<string, unknown> {
  if (!object(raw)) throw invalid("INVALID_SOURCE", "The source package must be a JSON object.");
  if (raw.format !== SOURCE_FORMAT) {
    throw invalid(
      "INVALID_SOURCE",
      `The source package format must be "${SOURCE_FORMAT}": this is portable Solution source, nothing else.`,
    );
  }
  if (raw.formatVersion !== SOURCE_FORMAT_VERSION) {
    throw invalid(
      "INVALID_SOURCE",
      `The source package formatVersion must be ${SOURCE_FORMAT_VERSION}: newer producers are refused, never coerced.`,
    );
  }
}

/**
 * Validate a full package document (shared by export and import): envelope,
 * source identity, manifest, modules, assets, metadata, and the dependency
 * closure. Returns the validated package; throws precise Faults otherwise.
 */
async function validatePackage(raw: unknown, catalogs: SourceCatalogs, exporter: string): Promise<SourcePackage> {
  scanUntrusted(raw);
  validateEnvelope(raw);
  const doc = raw as Record<string, unknown>;
  const manifest = parseBundleManifest(doc.manifest);
  const source = validateSourceInfo(doc.source, manifest);
  if (!Array.isArray(doc.modules) || doc.modules.length === 0) {
    throw invalid("INVALID_SOURCE", "The source package must carry at least one module.");
  }
  const modules: SourceModule[] = (doc.modules as unknown[]).map((entry: unknown) => {
    if (!object(entry)) throw invalid("INVALID_SOURCE", "Every source module must be an object.");
    if (typeof entry.sagaId !== "string" || !UUID.test(entry.sagaId)) {
      throw invalid("INVALID_SOURCE", "Every source module needs a stable sagaId UUID.");
    }
    const catalog = catalogs.sagas.find((saga) => saga.id === entry.sagaId);
    if (!catalog) {
      throw invalid(
        "MISSING_MODULE",
        `Saga ${entry.sagaId} is not in the code catalog: install the module or drop the pin before sharing.`,
      );
    }
    if (typeof entry.revision !== "string" || entry.revision !== catalog.revision) {
      throw invalid(
        "REVISION_MISMATCH",
        `Saga "${catalog.name}" pins revision "${typeof entry.revision === "string" ? entry.revision : "?"}" but deployed code is "${catalog.revision}".`,
        409,
      );
    }
    const pin = manifest.sagas.find((saga) => saga.id === entry.sagaId);
    if (!pin || pin.revision !== entry.revision) {
      throw invalid(
        "SOURCE_MANIFEST_MISMATCH",
        `Source module "${catalog.name}" does not match the manifest saga pin: a package never mixes revisions.`,
        409,
      );
    }
    if (typeof entry.name !== "string" || entry.name !== catalog.name) {
      throw invalid("INVALID_SOURCE", `Source module ${entry.sagaId} must carry the catalog name "${catalog.name}".`);
    }
    if (typeof entry.description !== "string" || entry.description !== catalog.description) {
      throw invalid("INVALID_SOURCE", `Source module "${catalog.name}" must carry the catalog description verbatim.`);
    }
    if (
      !Array.isArray(entry.requiredIntegrations) ||
      entry.requiredIntegrations.length !== catalog.requiredIntegrations.length ||
      entry.requiredIntegrations.some((id, index) => id !== catalog.requiredIntegrations[index])
    ) {
      throw invalid(
        "INVALID_SOURCE",
        `Source module "${catalog.name}" must carry the catalog requiredIntegrations verbatim: dependency edits are code changes, not packaging edits.`,
      );
    }
    return {
      sagaId: catalog.id,
      name: catalog.name,
      revision: catalog.revision,
      description: catalog.description,
      requiredIntegrations: [...catalog.requiredIntegrations],
    };
  });
  const closure = checkClosure(manifest, modules, catalogs);
  const blocking = closure.filter((gap) => gap.blocking);
  if (blocking.length > 0) {
    const first = blocking[0] as SourceGap;
    const status = first.reason === "REVISION_MISMATCH" ? 409 : 400;
    throw new Fault(status, first.reason, first.detail);
  }
  if (!Array.isArray(doc.assets)) throw invalid("INVALID_SOURCE", "The source package assets must be a list.");
  if (doc.assets.length > SOURCE_ASSET_MAX_COUNT) {
    throw invalid("INVALID_SOURCE", `The source package holds at most ${SOURCE_ASSET_MAX_COUNT} assets.`);
  }
  const seen = new Set<string>();
  const assets = (doc.assets as unknown[]).map((entry: unknown) => validateAsset(entry, seen));
  const metadata = validateMetadata(doc.metadata, exporter);
  return {
    format: SOURCE_FORMAT,
    formatVersion: SOURCE_FORMAT_VERSION,
    source,
    manifest,
    modules: Object.freeze(modules),
    assets: Object.freeze(assets),
    metadata,
  };
}

export interface ExportedFile {
  readonly name: string;
  readonly json: string;
  readonly bytes: number;
}

export interface ExportResult {
  readonly files: readonly ExportedFile[];
  readonly sha256: string;
}

/**
 * Serialize a validated package into its shareable files (canonical key
 * order, 2-space JSON): `solution.source.json` plus the extracted
 * `solution.manifest.json` for the installer. Fails closed on oversized
 * packages and on any caller-known secret value appearing in the bytes.
 */
export async function exportSourcePackage(raw: unknown, opts: ExportOptions = {}): Promise<ExportResult> {
  const catalogs = opts.catalogs ?? staticSourceCatalogs();
  const validated = await validatePackage(raw, catalogs, opts.exporter ?? "wrangnarok-export");
  const canonical: Record<string, unknown> = {
    format: validated.format,
    formatVersion: validated.formatVersion,
    source: validated.source,
    manifest: validated.manifest,
    modules: validated.modules,
    assets: validated.assets,
    metadata: validated.metadata,
  };
  const json = JSON.stringify(canonical, null, 2);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > SOURCE_PACKAGE_MAX_BYTES) {
    throw invalid(
      "SOURCE_TOO_LARGE",
      `The source package is ${bytes} bytes: shareable source is capped at ${SOURCE_PACKAGE_MAX_BYTES} bytes.`,
      413,
    );
  }
  for (const [name, value] of Object.entries(opts.secrets ?? {})) {
    if (typeof value === "string" && value.length > 0 && json.includes(value)) {
      throw invalid(
        "CREDENTIAL_IN_SOURCE",
        `The exported package embeds the value of secret "${name}": portable source carries secretsRequired names only, never values.`,
      );
    }
  }
  const manifestJson = JSON.stringify(validated.manifest, null, 2);
  const files: readonly ExportedFile[] = Object.freeze([
    { name: "solution.source.json", json, bytes },
    {
      name: "solution.manifest.json",
      json: manifestJson,
      bytes: new TextEncoder().encode(manifestJson).length,
    },
  ]);
  return { files, sha256: await hash(json) };
}

export interface ImportReport {
  readonly modules: number;
  readonly integrations: number;
  readonly assets: number;
  readonly requirements: readonly string[];
}

/**
 * Import (validate) a shareable package without touching D1 and without
 * installing: envelope, forbidden sections, identity match, module pins,
 * assets, metadata, and the dependency closure. Adoption stays an explicit
 * installBundle step with its own preflights.
 */
export async function importSourcePackage(
  raw: unknown,
  catalogs: SourceCatalogs = staticSourceCatalogs(),
): Promise<{ package: SourcePackage; manifest: BundleManifest; report: ImportReport }> {
  const validated = await validatePackage(raw, catalogs, "wrangnarok-import");
  return {
    package: validated,
    manifest: validated.manifest,
    report: {
      modules: validated.modules.length,
      integrations: validated.manifest.integrations.length,
      assets: validated.assets.length,
      requirements: validated.source.requirements.map((req) => `${req.name}@${req.version}`),
    },
  };
}

export interface ExportSink {
  readonly writeTemp: (name: string, content: string) => Promise<void> | void;
  readonly commit: () => Promise<void> | void;
  readonly cleanup: () => Promise<void> | void;
}

/**
 * Staged export job: validate and serialize, stage each file through the
 * sink, then commit. Any failure runs cleanup exactly once and preserves the
 * original Fault; sink transport failures surface as EXPORT_JOB_FAILED.
 */
export async function runExportJob(raw: unknown, sink: ExportSink, opts: ExportOptions = {}): Promise<ExportResult> {
  const result = await exportSourcePackage(raw, opts).catch(async (error: unknown) => {
    await sink.cleanup();
    throw error;
  });
  try {
    for (const file of result.files) {
      await sink.writeTemp(file.name, file.json);
    }
    await sink.commit();
  } catch (error: unknown) {
    await sink.cleanup();
    if (error instanceof Fault) throw error;
    throw new Fault(
      500,
      "EXPORT_JOB_FAILED",
      `The export job failed mid-stage and its temp files were cleaned up: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return result;
}
