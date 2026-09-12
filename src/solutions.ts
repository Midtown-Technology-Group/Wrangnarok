// SPDX-License-Identifier: AGPL-3.0
// Solutions install (ADR 011, Accepted): manifest-driven install with
// owned/loose enforcement, staged activation, and a fail-closed execution
// gate.
//
// A bundle is one JSON manifest plus the Git tree it points at. installBundle
// validates the manifest, runs preflight (catalog resolution, revision pins,
// secret-schema membership, secret availability, ownership, downgrade,
// same-version content fencing) before the first write, then reconciles each
// declared row independently: INSERT missing managed rows, UPDATE drifted
// managed rows, DELETE managed absentees scoped to this bundle install, and
// persist the manifest config and saga pins. The activation pointer
// (bundle_active) moves only on full reconcile success through a fenced
// conditional write, so an interrupted or racing install can never advertise
// a complete active version while exposing mixed configuration. Restart
// converges: re-running finishes the reconcile and moves the pointer.
//
// Observable atomicity versus restart convergence (local decision, not an
// upstream claim): D1 gives no cross-service transaction with Workflows and
// no multi-statement atomicity across the awaits in this function. What the
// installer guarantees instead is (a) the pointer only names a fully
// reconciled install, (b) every reconcile write is idempotent per row, and
// (c) a lost race surfaces INSTALL_CONFLICT, never a silent overwrite. An
// interrupted install leaves earlier row writes visible but the pointer still
// names the previous complete version (or nothing); the next run converges.
//
// Owned vs loose: managed rows carry managed_by = <bundle_id>@<version>.
// The installer below is the sole writer of managed rows. Ordinary
// application paths must go through updateConnectionEndpoint, which rejects
// managed-row writes with MANAGED_RESOURCE.
//
// This module imports only node-safe dependencies (domain, integrations
// index): src/sagas/index pulls the cloudflare:workers/workflow runtime, so
// the local runner (scripts/install-local.mjs, plain node) could not bundle
// it. The saga pins below reuse the same domain constants the Saga
// definitions are built from; test/solutions-install.test.ts asserts they
// stay in agreement with the static code Catalog.
import { digestSaga, echoSaga, Fault, hash, helloSaga, ninjaSaga, object, smokeSaga, UUID } from "./domain";
import { integrationById } from "./integrations";
import { scrubTextWithSecrets } from "./secrets";

interface CatalogSaga {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
}

/** Static code Catalog as seen by the installer: the same stable IDs and
 * revision pins the Saga definitions are built from (ADR 002). */
const CODE_SAGAS: readonly CatalogSaga[] = [echoSaga, ninjaSaga, digestSaga, smokeSaga, helloSaga];

export interface ManifestSagaPin {
  readonly id: string;
  readonly revision: string;
}

export interface ManifestConnection {
  readonly org: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secretsRequired: readonly string[];
}

export interface ManifestIntegration {
  readonly id: string;
  readonly connections: readonly ManifestConnection[];
}

export interface ManifestConfigEntry {
  readonly key: string;
  readonly value: string;
}

/** Validated bundle manifest (ADR 011 section 1, v1 slice). Manifests carry
 * declarations only: secretsRequired names, never credential values. */
export interface BundleManifest {
  readonly manifestVersion: 1;
  readonly bundle: { readonly id: string; readonly name: string; readonly version: string };
  readonly sagas: readonly ManifestSagaPin[];
  readonly integrations: readonly ManifestIntegration[];
  readonly config: readonly ManifestConfigEntry[];
}

export interface InstallOptions {
  /** Secret values keyed by secretsRequired name, resolved by the caller
   * from env/Secrets Store per ADR 005. Only presence is checked here;
   * values are never persisted, logged, or returned. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Downgrades (older bundle version over a newer install record) refuse
   * without this flag. Rollback = reinstalling the older manifest with
   * force: true through the same path. */
  readonly force?: boolean;
  /** Plan only: run validation and preflight, return the drift report,
   * write nothing. */
  readonly dryRun?: boolean;
  /** Scope reconciliation to one manifest org name (used by the local
   * runner). Unset installs every declared org. */
  readonly orgName?: string;
  /** Test seam (never production control flow): invoked after each
   * reconcile statement so interruption tests can abort mid-install and
   * prove the activation pointer does not move. */
  readonly internals?: InstallInternals;
}

/** Test-only hooks into the install write path. */
export interface InstallInternals {
  /** Called after every install write; when it throws, the install aborts
   * before activation. Counts completed writes for assertions. */
  readonly afterWrite?: (completedWrites: number) => void;
}

export interface DriftReport {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly deleted: number;
}

export interface InstallResult {
  readonly bundleId: string;
  readonly version: string;
  readonly manifestHash: string;
  readonly orgIds: readonly string[];
  readonly drift: DriftReport;
  readonly dryRun: boolean;
}

const BUNDLE_NAME = /^[a-z0-9][a-z0-9.-]*$/i;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** Manifests must never carry credential values (ADR 011 structural
 * exclusion): any config key shaped like a credential fails validation. */
const CREDENTIAL_KEY =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)/i;

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Hand-rolled manifest validator, mirroring the src/saga.ts validation
 * style: explicit checks, descriptive errors, no new dependencies. Throws
 * Faults with machine-readable codes; writes nothing. */
export function parseBundleManifest(value: unknown): BundleManifest {
  if (!object(value)) throw invalid("INVALID_MANIFEST", "The bundle manifest must be a JSON object.");
  if (value.manifestVersion !== 1) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest manifestVersion must be 1.");
  }
  const bundle = value.bundle;
  if (!object(bundle) || typeof bundle.id !== "string" || !UUID.test(bundle.id)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest bundle.id must be a stable UUID.");
  }
  if (!object(bundle) || typeof bundle.name !== "string" || !BUNDLE_NAME.test(bundle.name)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest bundle.name must be a simple slug.");
  }
  if (!object(bundle) || typeof bundle.version !== "string" || !SEMVER.test(bundle.version)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest bundle.version must be major.minor.patch.");
  }
  const sagas = value.sagas;
  if (!Array.isArray(sagas) || sagas.length === 0) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest must declare at least one saga.");
  }
  const pins: ManifestSagaPin[] = sagas.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== "string" || !UUID.test(entry.id)) {
      throw invalid("INVALID_MANIFEST", "Every manifest saga id must be a stable Saga UUID.");
    }
    // ADR 011 section 6 / ADR 010 open question (deliberately unresolved in
    // v1): the manifest pins saga revisions while Saga source declares
    // requiredIntegrations, and the two must agree. Which side is
    // authoritative when they disagree is Phase 3+; v1 only fails closed on
    // revision mismatch and never rewrites requirements.
    const catalog = CODE_SAGAS.find((saga) => saga.id === entry.id);
    if (!catalog) throw invalid("UNKNOWN_SAGA", `Unknown saga id ${entry.id}: not in the static code catalog.`);
    if (typeof entry.revision !== "string" || entry.revision !== catalog.revision) {
      throw invalid(
        "REVISION_MISMATCH",
        `Saga "${catalog.name}" pins revision "${entry.revision}" but deployed code is "${catalog.revision}".`,
        409,
      );
    }
    return { id: entry.id, revision: entry.revision };
  });
  const integrations = value.integrations;
  if (!Array.isArray(integrations)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest integrations must be a list.");
  }
  const declared: ManifestIntegration[] = integrations.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== "string" || !UUID.test(entry.id)) {
      throw invalid("INVALID_MANIFEST", "Every manifest integration id must be a stable Integration UUID.");
    }
    const def = integrationById(entry.id);
    if (!def) {
      throw invalid("UNKNOWN_INTEGRATION", `Unknown integration id ${entry.id}: not in the static code catalog.`);
    }
    if (!Array.isArray(entry.connections) || entry.connections.length === 0) {
      throw invalid("INVALID_MANIFEST", `Integration "${def.name}" must declare at least one connection when listed.`);
    }
    const connections: ManifestConnection[] = entry.connections.map((conn: unknown) => {
      if (!object(conn) || typeof conn.org !== "string" || conn.org.length === 0 || conn.org.length > 128) {
        throw invalid("INVALID_MANIFEST", "Every manifest connection needs an org name of 1-128 chars.");
      }
      if (!object(conn.config)) {
        throw invalid("INVALID_MANIFEST", "Every manifest connection needs a config object.");
      }
      const config: Record<string, string> = {};
      for (const [key, val] of Object.entries(conn.config)) {
        if (CREDENTIAL_KEY.test(key)) {
          throw invalid(
            "CREDENTIAL_IN_MANIFEST",
            `Manifest connection config key "${key}" looks like a credential: manifests carry secretsRequired names only, never values.`,
          );
        }
        if (typeof val !== "string" || val.length === 0) {
          throw invalid("INVALID_MANIFEST", `Manifest connection config "${key}" must be a non-empty string.`);
        }
        config[key] = val;
      }
      if (typeof config.endpoint !== "string") {
        throw invalid("INVALID_MANIFEST", "Every manifest connection config needs a non-secret endpoint string.");
      }
      if (!Array.isArray(conn.secretsRequired) || conn.secretsRequired.some((n) => typeof n !== "string")) {
        throw invalid("INVALID_MANIFEST", "Every manifest connection needs an explicit secretsRequired string list.");
      }
      for (const name of conn.secretsRequired as string[]) {
        if (!def.secretFields.includes(name)) {
          throw invalid(
            "SECRET_SCHEMA_MISMATCH",
            `Secret "${name}" is not in the "${def.name}" Integration secret schema (${def.secretFields.join(", ") || "none"}).`,
          );
        }
      }
      return { org: conn.org, config, secretsRequired: Object.freeze([...(conn.secretsRequired as string[])]) };
    });
    return { id: entry.id, connections: Object.freeze(connections) };
  });
  const config = value.config;
  if (!Array.isArray(config)) {
    throw invalid("INVALID_MANIFEST", "The bundle manifest config must be a list.");
  }
  const entries: ManifestConfigEntry[] = config.map((entry: unknown) => {
    if (!object(entry) || typeof entry.key !== "string" || entry.key.length === 0) {
      throw invalid("INVALID_MANIFEST", "Every manifest config entry needs a non-empty key.");
    }
    if (typeof entry.value !== "string") {
      throw invalid("INVALID_MANIFEST", `Manifest config "${entry.key}" must carry a string value.`);
    }
    if (CREDENTIAL_KEY.test(entry.key)) {
      throw invalid(
        "CREDENTIAL_IN_MANIFEST",
        `Manifest config key "${entry.key}" looks like a credential: manifests never carry values for secrets.`,
      );
    }
    return { key: entry.key, value: entry.value };
  });
  return Object.freeze({
    manifestVersion: 1 as const,
    bundle: Object.freeze({ id: bundle.id as string, name: bundle.name as string, version: bundle.version as string }),
    sagas: Object.freeze(pins),
    integrations: Object.freeze(declared),
    config: Object.freeze(entries),
  });
}

/** Numeric major.minor.patch compare with a boring prerelease rule (release
 * beats prerelease, prereleases compare lexically). Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { core: number[]; pre: string | null } => {
    const dash = v.indexOf("-");
    const core = (dash === -1 ? v : v.slice(0, dash)).split(".").map((n) => {
      const parsed = Number(n);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { core, pre: dash === -1 ? null : v.slice(dash + 1) };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

function managedBy(bundleId: string, version: string): string {
  return `${bundleId}@${version}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Deterministic managed Connection identity (ADR 011 section 3): derived
 * from install + manifest identity so reinstalls converge instead of
 * forking duplicates. */
async function managedConnectionId(bundleId: string, orgId: string, integrationId: string): Promise<string> {
  const hex = await hash(JSON.stringify(["wrangnarok.connection.v1", bundleId, orgId, integrationId]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface DesiredConnection {
  readonly integrationId: string;
  readonly org: string;
  /** Full non-secret config: endpoint drives the Connection row, and the
   * canonical whole-config JSON is persisted beside it so sibling-key drift
   * reconciles instead of skipping silently. */
  readonly config: Readonly<Record<string, string>>;
  readonly secretsRequired: readonly string[];
}

interface PlannedConnection extends DesiredConnection {
  readonly orgId: string | null;
  readonly action: "create" | "update" | "skip";
  /** Previously persisted managed_by marker, for the fenced reconcile write. */
  readonly expectedManagedBy: string | null;
}

interface PlannedConfig {
  readonly org: string;
  readonly orgId: string | null;
  readonly key: string;
  readonly value: string;
  readonly action: "create" | "update" | "skip";
  readonly expectedManagedBy: string | null;
}

interface PlannedSagaPin {
  readonly org: string;
  readonly orgId: string | null;
  readonly sagaId: string;
  readonly revision: string;
  readonly action: "create" | "update" | "skip";
  readonly expectedManagedBy: string | null;
}

/** True when the activation schema (migration 0005) is present. Older/local
 * databases without it predate activation: installs there reconcile
 * Connection endpoints only, advertise no active version, and execution
 * treats every org as loose development. */
async function activationTablesPresent(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bundle_active'")
    .bind()
    .first<{ name: string }>();
  return row !== null;
}

async function latestLedger(
  db: D1Database,
  bundleId: string,
  orgId: string,
): Promise<{ version: string; manifestHash: string } | null> {
  return db
    .prepare(
      "SELECT version, manifest_hash AS manifestHash FROM bundle_installs WHERE bundle_id = ? AND org_id = ? ORDER BY installed_at DESC, id DESC LIMIT 1",
    )
    .bind(bundleId, orgId)
    .first<{ version: string; manifestHash: string }>();
}

/**
 * Manifest-driven install with owned/loose enforcement, scoped absentee
 * deletion, and staged activation (ADR 011 SOL-01 slice): validate, run
 * every preflight check before the first write, record one immutable ledger
 * row per Organization, reconcile each declared row independently, then move
 * the per-org activation pointer through a fenced conditional write.
 * Returns a drift report.
 *
 * Saga-only bundles (no integrations) still derive org installs from the
 * requested org scope: every manifest saga pin is persisted per org so the
 * execution gate has an applicable active install/revision to check.
 */
export async function installBundle(db: D1Database, raw: unknown, opts: InstallOptions = {}): Promise<InstallResult> {
  const manifest = parseBundleManifest(raw);
  const secrets = opts.secrets ?? {};
  const bundleId = manifest.bundle.id;
  const version = manifest.bundle.version;
  const afterWrite = opts.internals?.afterWrite;
  let completedWrites = 0;
  const wrote = (): void => {
    completedWrites += 1;
    afterWrite?.(completedWrites);
  };

  const desired: DesiredConnection[] = [];
  for (const integration of manifest.integrations) {
    for (const conn of integration.connections) {
      if (opts.orgName !== undefined && conn.org !== opts.orgName) continue;
      desired.push({
        integrationId: integration.id,
        org: conn.org,
        config: conn.config,
        secretsRequired: conn.secretsRequired,
      });
    }
  }
  // The org set an install derives: every in-scope connection org, plus the
  // requested orgName for saga-only bundles (no connections to infer from).
  // A scoped org with no connections in a bundle that declares integrations
  // is rejected: silently installing nothing would advertise completeness.
  const orgNames = [...new Set(desired.map((conn) => conn.org))];
  if (orgNames.length === 0) {
    if (opts.orgName !== undefined && manifest.integrations.length === 0) {
      orgNames.push(opts.orgName);
    } else if (opts.orgName !== undefined) {
      throw invalid("ORG_NOT_DECLARED", `Org "${opts.orgName}" declares no connections in this manifest.`);
    } else {
      throw invalid("INVALID_MANIFEST", "The bundle manifest declares no org installations.");
    }
  }

  // Preflight: every secretsRequired name has a value available (env/Secrets
  // Store). Values are presence-checked only — never persisted, logged, or
  // returned (First-Acorn-must-not per ADR 005).
  for (const conn of desired) {
    for (const name of conn.secretsRequired) {
      if (typeof secrets[name] !== "string" || (secrets[name] as string).length === 0) {
        throw invalid(
          "SECRET_NOT_CONFIGURED",
          `Secret "${name}" is required by this manifest but has no value available: refusing a half-credentialed install.`,
        );
      }
    }
  }

  const manifestHash = await hash(canonical(manifest));

  // Preflight reads (no writes yet): resolve org rows, the active install
  // pointer, and current Connection ownership. The downgrade and
  // same-version fences compare against the activation pointer (the last
  // fully reconciled install), never the newest ledger row: ledger rows are
  // immutable evidence of attempts, and an interrupted install leaves a
  // newer ledger row behind while the pointer still names the previous
  // complete version (restart convergence, ADR 011 section 2; #161).
  const orgIds = new Map<string, string>();
  for (const name of orgNames) {
    const row = await db.prepare("SELECT id FROM organizations WHERE name = ?").bind(name).first<{ id: string }>();
    if (row) orgIds.set(name, row.id);
  }
  const activationPresent = await activationTablesPresent(db);
  const activeVersions = new Map<string, { version: string; manifestHash: string }>();
  if (activationPresent) {
    for (const name of orgNames) {
      const orgId = orgIds.get(name);
      if (orgId === undefined) continue;
      const active = await activeInstallFor(db, bundleId, orgId);
      if (active) activeVersions.set(name, { version: active.version, manifestHash: active.manifestHash });
    }
  }
  for (const name of orgNames) {
    const orgId = orgIds.get(name);
    if (orgId === undefined) continue;
    const active = activeVersions.get(name);
    // No pointer yet: fall back to the newest ledger row so a first install
    // still fences same-version forks (and pre-activation databases keep the
    // legacy downgrade posture until the pointer exists).
    const latest = active
      ? { version: active.version, manifestHash: active.manifestHash }
      : await latestLedger(db, bundleId, orgId);
    if (!latest) continue;
    if (compareVersions(version, latest.version) < 0 && opts.force !== true) {
      throw invalid(
        "DOWNGRADE_REFUSED",
        `Bundle version ${version} is older than installed ${latest.version}: pass force to roll back.`,
        409,
      );
    }
    if (compareVersions(version, latest.version) === 0 && latest.manifestHash !== manifestHash) {
      // Same version, divergent content: refuse to silently fork the
      // managed rows that already carry this version marker. Bump the
      // bundle version and reinstall so the marker moves with the content
      // it names.
      throw invalid(
        "INSTALL_CONFLICT",
        `Bundle version ${version} is already installed with different content: bump the bundle version instead of reusing it.`,
        409,
      );
    }
  }
  const marker = managedBy(bundleId, version);
  // Desired Connection state compares the full non-secret config on
  // activation-schema databases (flag read in preflight above); older
  // databases keep the endpoint-only comparison and write path below.
  const plan: PlannedConnection[] = [];
  for (const conn of desired) {
    const orgId = orgIds.get(conn.org) ?? null;
    if (orgId === null) {
      plan.push({ ...conn, orgId: null, action: "create", expectedManagedBy: null });
      continue;
    }
    const current = activationPresent
      ? await db
          .prepare(
            "SELECT endpoint, config_json AS configJson, managed_by FROM connections WHERE org_id = ? AND integration_id = ?",
          )
          .bind(orgId, conn.integrationId)
          .first<{ endpoint: string; configJson: string | null; managed_by: string | null }>()
      : await db
          .prepare("SELECT endpoint, managed_by FROM connections WHERE org_id = ? AND integration_id = ?")
          .bind(orgId, conn.integrationId)
          .first<{ endpoint: string; managed_by: string | null }>()
          .then((row) => (row ? { ...row, configJson: canonical({ endpoint: row.endpoint }) } : null));
    if (!current) {
      plan.push({ ...conn, orgId, action: "create", expectedManagedBy: null });
    } else if (current.managed_by === null) {
      throw invalid(
        "INSTALL_CONFLICT",
        "A loose Connection already exists for this Organization and Integration: the installer never adopts managed_by-NULL rows.",
        409,
      );
    } else if (!current.managed_by.startsWith(`${bundleId}@`)) {
      // Portable install record: scrub caller-supplied secrets before the
      // marker text leaves (defense-in-depth; markers are IDs, not secrets).
      const marker = scrubTextWithSecrets(current.managed_by, Object.values(secrets));
      throw invalid(
        "INSTALL_CONFLICT",
        `Connection is managed by a different bundle (${marker}): hijack by reinstall is refused.`,
        409,
      );
    } else if (
      current.endpoint === conn.config.endpoint &&
      current.configJson === canonical(conn.config) &&
      current.managed_by === marker
    ) {
      // Content already matches AND the marker names this version: a true
      // no-op. Same content under an older marker reconciles (update)
      // so the marker always names the version that wrote the row.
      plan.push({ ...conn, orgId, action: "skip", expectedManagedBy: current.managed_by });
    } else {
      plan.push({ ...conn, orgId, action: "update", expectedManagedBy: current.managed_by });
    }
  }

  // Saga-pin plan and manifest config plan live behind the activation
  // schema (above); older databases keep the endpoint-only behavior.
  const configPlan: PlannedConfig[] = [];
  if (activationPresent) {
    for (const name of orgNames) {
      const orgId = orgIds.get(name) ?? null;
      for (const entry of manifest.config) {
        if (orgId === null) {
          configPlan.push({
            org: name,
            orgId: null,
            key: entry.key,
            value: entry.value,
            action: "create",
            expectedManagedBy: null,
          });
          continue;
        }
        const current = await db
          .prepare(
            "SELECT config_value AS value, managed_by FROM bundle_config WHERE bundle_id = ? AND org_id = ? AND config_key = ?",
          )
          .bind(bundleId, orgId, entry.key)
          .first<{ value: string; managed_by: string | null }>();
        if (!current) {
          configPlan.push({
            org: name,
            orgId,
            key: entry.key,
            value: entry.value,
            action: "create",
            expectedManagedBy: null,
          });
        } else if (current.managed_by === null || !current.managed_by.startsWith(`${bundleId}@`)) {
          throw invalid(
            "INSTALL_CONFLICT",
            `Config "${entry.key}" is managed by a different bundle (${current.managed_by}): hijack by reinstall is refused.`,
            409,
          );
        } else if (current.value === entry.value && current.managed_by === marker) {
          configPlan.push({
            org: name,
            orgId,
            key: entry.key,
            value: entry.value,
            action: "skip",
            expectedManagedBy: current.managed_by,
          });
        } else {
          configPlan.push({
            org: name,
            orgId,
            key: entry.key,
            value: entry.value,
            action: "update",
            expectedManagedBy: current.managed_by,
          });
        }
      }
    }
  }

  // Saga-pin plan: persisted per org so execution can fail closed against
  // the applicable active install/revision.
  const sagaPlan: PlannedSagaPin[] = [];
  if (activationPresent) {
    for (const name of orgNames) {
      const orgId = orgIds.get(name) ?? null;
      for (const pin of manifest.sagas) {
        if (orgId === null) {
          sagaPlan.push({
            org: name,
            orgId: null,
            sagaId: pin.id,
            revision: pin.revision,
            action: "create",
            expectedManagedBy: null,
          });
          continue;
        }
        const current = await db
          .prepare("SELECT revision, managed_by FROM bundle_sagas WHERE bundle_id = ? AND org_id = ? AND saga_id = ?")
          .bind(bundleId, orgId, pin.id)
          .first<{ revision: string; managed_by: string | null }>();
        if (!current) {
          sagaPlan.push({
            org: name,
            orgId,
            sagaId: pin.id,
            revision: pin.revision,
            action: "create",
            expectedManagedBy: null,
          });
        } else if (current.managed_by === null || !current.managed_by.startsWith(`${bundleId}@`)) {
          throw invalid(
            "INSTALL_CONFLICT",
            `Saga pin is managed by a different bundle (${current.managed_by}): hijack by reinstall is refused.`,
            409,
          );
        } else if (current.revision === pin.revision && current.managed_by === marker) {
          sagaPlan.push({
            org: name,
            orgId,
            sagaId: pin.id,
            revision: pin.revision,
            action: "skip",
            expectedManagedBy: current.managed_by,
          });
        } else {
          sagaPlan.push({
            org: name,
            orgId,
            sagaId: pin.id,
            revision: pin.revision,
            action: "update",
            expectedManagedBy: current.managed_by,
          });
        }
      }
    }
  }

  // Absentee plan: managed rows this bundle owns in D1 but no longer
  // declares. Scoped to (bundle_id prefix, org): never touches loose rows
  // or rows owned by another bundle. Connections are keyed by
  // integration; config pins and saga pins by their keys.
  const absenteeConnections: { org: string; orgId: string; integrationId: string; expectedManagedBy: string }[] = [];
  const absenteeConfig: { org: string; orgId: string; key: string; expectedManagedBy: string }[] = [];
  const absenteeSagas: { org: string; orgId: string; sagaId: string; expectedManagedBy: string }[] = [];
  for (const name of orgNames) {
    const orgId = orgIds.get(name);
    if (orgId === undefined) continue;
    const declaredIntegrations = new Set(desired.filter((d) => d.org === name).map((d) => d.integrationId));
    const owned = await db
      .prepare(
        "SELECT integration_id AS integrationId, managed_by FROM connections WHERE org_id = ? AND managed_by LIKE ?",
      )
      .bind(orgId, `${bundleId}@%`)
      .all<{ integrationId: string; managed_by: string }>();
    for (const row of owned.results) {
      if (!declaredIntegrations.has(row.integrationId)) {
        absenteeConnections.push({
          org: name,
          orgId,
          integrationId: row.integrationId,
          expectedManagedBy: row.managed_by,
        });
      }
    }
    if (activationPresent) {
      const declaredKeys = new Set(manifest.config.map((e) => e.key));
      const ownedConfig = await db
        .prepare("SELECT config_key AS key, managed_by FROM bundle_config WHERE bundle_id = ? AND org_id = ?")
        .bind(bundleId, orgId)
        .all<{ key: string; managed_by: string }>();
      for (const row of ownedConfig.results) {
        if (!declaredKeys.has(row.key)) {
          absenteeConfig.push({ org: name, orgId, key: row.key, expectedManagedBy: row.managed_by });
        }
      }
      const declaredSagas = new Set(manifest.sagas.map((p) => p.id));
      const ownedSagas = await db
        .prepare("SELECT saga_id AS sagaId, managed_by FROM bundle_sagas WHERE bundle_id = ? AND org_id = ?")
        .bind(bundleId, orgId)
        .all<{ sagaId: string; managed_by: string }>();
      for (const row of ownedSagas.results) {
        if (!declaredSagas.has(row.sagaId)) {
          absenteeSagas.push({ org: name, orgId, sagaId: row.sagaId, expectedManagedBy: row.managed_by });
        }
      }
    }
  }

  const drift: DriftReport = {
    created:
      plan.filter((p) => p.action === "create").length +
      configPlan.filter((p) => p.action === "create").length +
      sagaPlan.filter((p) => p.action === "create").length,
    updated:
      plan.filter((p) => p.action === "update").length +
      configPlan.filter((p) => p.action === "update").length +
      sagaPlan.filter((p) => p.action === "update").length,
    skipped:
      plan.filter((p) => p.action === "skip").length +
      configPlan.filter((p) => p.action === "skip").length +
      sagaPlan.filter((p) => p.action === "skip").length,
    deleted: absenteeConnections.length + absenteeConfig.length + absenteeSagas.length,
  };
  if (opts.dryRun === true) {
    return { bundleId, version, manifestHash, orgIds: [...orgIds.values()], drift, dryRun: true };
  }

  // Reconcile: ensure org rows, append one immutable ledger row per org,
  // then apply each planned write independently. Restart-safe by
  // construction — re-running converges (creates become skips, updates
  // already match, deletes already gone) and the fenced activation below
  // moves the pointer only when the full reconcile lands.
  const installedAt = new Date().toISOString();
  for (const name of orgNames) {
    if (!orgIds.has(name)) {
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(id, name).run();
      wrote();
      orgIds.set(name, id);
    }
  }
  // Immutable install evidence: one ledger row per org, read back for the
  // activation pointer (D1 run metadata is not relied upon for identity).
  // The pointer (bundle_active) moves only after every reconcile write
  // below lands.
  const installIds = new Map<string, number>();
  for (const name of orgNames) {
    const orgId = orgIds.get(name) as string;
    await db
      .prepare(
        "INSERT INTO bundle_installs(bundle_id, version, org_id, manifest_hash, installed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(bundleId, version, orgId, manifestHash, installedAt)
      .run();
    wrote();
    const evidence = await db
      .prepare(
        "SELECT id FROM bundle_installs WHERE bundle_id = ? AND org_id = ? AND installed_at = ? ORDER BY id DESC LIMIT 1",
      )
      .bind(bundleId, orgId, installedAt)
      .first<{ id: number }>();
    installIds.set(name, evidence?.id ?? -1);
  }
  for (const item of plan) {
    const orgId = orgIds.get(item.org) as string;
    if (item.action === "create") {
      const id = await managedConnectionId(bundleId, orgId, item.integrationId);
      if (activationPresent) {
        await db
          .prepare(
            "INSERT INTO connections(id, org_id, integration_id, endpoint, config_json, managed_by) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(id, orgId, item.integrationId, item.config.endpoint, canonical(item.config), marker)
          .run();
      } else {
        await db
          .prepare("INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, ?)")
          .bind(id, orgId, item.integrationId, item.config.endpoint, marker)
          .run();
      }
      wrote();
    } else if (item.action === "update") {
      // Fenced on the preflight marker: a lost race surfaces
      // INSTALL_CONFLICT, never a silent overwrite (ADR 011 section 4).
      // The fence also bumps a stale same-bundle marker (identical
      // content under an older managed_by), so the marker always names
      // the version that wrote the row.
      const applied = activationPresent
        ? await db
            .prepare(
              "UPDATE connections SET endpoint = ?, config_json = ?, managed_by = ? WHERE org_id = ? AND integration_id = ? AND managed_by = ?",
            )
            .bind(
              item.config.endpoint,
              canonical(item.config),
              marker,
              orgId,
              item.integrationId,
              item.expectedManagedBy,
            )
            .run()
        : await db
            .prepare(
              "UPDATE connections SET endpoint = ?, managed_by = ? WHERE org_id = ? AND integration_id = ? AND managed_by = ?",
            )
            .bind(item.config.endpoint, marker, orgId, item.integrationId, item.expectedManagedBy)
            .run();
      if (applied.meta.changes === 0) {
        throw invalid("INSTALL_CONFLICT", "Connection changed under install: refusing silent overwrite.", 409);
      }
      wrote();
    }
  }
  for (const item of configPlan) {
    const orgId = orgIds.get(item.org) as string;
    if (item.action === "create") {
      await db
        .prepare(
          "INSERT INTO bundle_config(bundle_id, org_id, config_key, config_value, managed_by) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(bundleId, orgId, item.key, item.value, marker)
        .run();
      wrote();
    } else if (item.action === "update") {
      const applied = await db
        .prepare(
          "UPDATE bundle_config SET config_value = ?, managed_by = ? WHERE bundle_id = ? AND org_id = ? AND config_key = ? AND managed_by = ?",
        )
        .bind(item.value, marker, bundleId, orgId, item.key, item.expectedManagedBy)
        .run();
      if (applied.meta.changes === 0) {
        throw invalid("INSTALL_CONFLICT", "Config changed under install: refusing silent overwrite.", 409);
      }
      wrote();
    }
  }
  for (const item of sagaPlan) {
    const orgId = orgIds.get(item.org) as string;
    if (item.action === "create") {
      await db
        .prepare("INSERT INTO bundle_sagas(bundle_id, org_id, saga_id, revision, managed_by) VALUES (?, ?, ?, ?, ?)")
        .bind(bundleId, orgId, item.sagaId, item.revision, marker)
        .run();
      wrote();
    } else if (item.action === "update") {
      const applied = await db
        .prepare(
          "UPDATE bundle_sagas SET revision = ?, managed_by = ? WHERE bundle_id = ? AND org_id = ? AND saga_id = ? AND managed_by = ?",
        )
        .bind(item.revision, marker, bundleId, orgId, item.sagaId, item.expectedManagedBy)
        .run();
      if (applied.meta.changes === 0) {
        throw invalid("INSTALL_CONFLICT", "Saga pin changed under install: refusing silent overwrite.", 409);
      }
      wrote();
    }
  }
  // Managed absentees: delete rows this bundle owns but no longer declares,
  // fenced on the preflight marker so a concurrent writer wins loudly.
  for (const gone of absenteeConnections) {
    const applied = await db
      .prepare("DELETE FROM connections WHERE org_id = ? AND integration_id = ? AND managed_by = ?")
      .bind(gone.orgId, gone.integrationId, gone.expectedManagedBy)
      .run();
    if (applied.meta.changes === 0) {
      throw invalid("INSTALL_CONFLICT", "Managed connection changed under install: refusing silent delete.", 409);
    }
    wrote();
  }
  for (const gone of absenteeConfig) {
    const applied = await db
      .prepare("DELETE FROM bundle_config WHERE bundle_id = ? AND org_id = ? AND config_key = ? AND managed_by = ?")
      .bind(bundleId, gone.orgId, gone.key, gone.expectedManagedBy)
      .run();
    if (applied.meta.changes === 0) {
      throw invalid("INSTALL_CONFLICT", "Managed config changed under install: refusing silent delete.", 409);
    }
    wrote();
  }
  for (const gone of absenteeSagas) {
    const applied = await db
      .prepare("DELETE FROM bundle_sagas WHERE bundle_id = ? AND org_id = ? AND saga_id = ? AND managed_by = ?")
      .bind(bundleId, gone.orgId, gone.sagaId, gone.expectedManagedBy)
      .run();
    if (applied.meta.changes === 0) {
      throw invalid("INSTALL_CONFLICT", "Managed saga pin changed under install: refusing silent delete.", 409);
    }
    wrote();
  }

  // Staged activation: the pointer moves only after the full reconcile
  // above lands. A lost race (same-version divergent content, or a newer
  // version that landed first) surfaces INSTALL_CONFLICT; the ledger row
  // already appended stays as immutable evidence of the attempt.
  if (activationPresent) {
    for (const name of orgNames) {
      const orgId = orgIds.get(name) as string;
      const installId = installIds.get(name) as number;
      const activatedAt = new Date().toISOString();
      const pointer = await db
        .prepare("SELECT version, manifest_hash AS manifestHash FROM bundle_active WHERE bundle_id = ? AND org_id = ?")
        .bind(bundleId, orgId)
        .first<{ version: string; manifestHash: string }>();
      if (pointer && pointer.version === version && pointer.manifestHash === manifestHash) {
        // Idempotent re-run: the pointer already names this exact
        // install. No write, no conflict.
        continue;
      }
      if (!pointer) {
        await db
          .prepare(
            "INSERT INTO bundle_active(bundle_id, org_id, version, manifest_hash, install_id, activated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(bundleId, orgId, version, manifestHash, installId, activatedAt)
          .run();
        wrote();
        continue;
      }
      if (pointer.version === version) {
        throw invalid(
          "INSTALL_CONFLICT",
          `Bundle version ${version} is active with different content: bump the bundle version instead of reusing it.`,
          409,
        );
      }
      // Fenced on the pre-read pointer: a concurrent install that moved
      // it first wins, and this attempt fails closed instead of silently
      // overwriting the newer activation.
      const moved = await db
        .prepare(
          "UPDATE bundle_active SET version = ?, manifest_hash = ?, install_id = ?, activated_at = ? WHERE bundle_id = ? AND org_id = ? AND version = ? AND manifest_hash = ?",
        )
        .bind(version, manifestHash, installId, activatedAt, bundleId, orgId, pointer.version, pointer.manifestHash)
        .run();
      if (moved.meta.changes === 0) {
        throw invalid("INSTALL_CONFLICT", "Activation moved under install: refusing silent overwrite.", 409);
      }
      wrote();
    }
  }
  return { bundleId, version, manifestHash, orgIds: [...orgIds.values()], drift, dryRun: false };
}

/** Active install pointer for one bundle install in one org. */
export interface ActiveInstall {
  readonly bundleId: string;
  readonly orgId: string;
  readonly version: string;
  readonly manifestHash: string;
}

/** Read the activation pointer. Returns null when nothing is active —
 * never throws for missing rows. */
export async function activeInstallFor(db: D1Database, bundleId: string, orgId: string): Promise<ActiveInstall | null> {
  const present = await activationTablesPresent(db);
  if (!present) return null;
  const row = await db
    .prepare(
      "SELECT bundle_id AS bundleId, org_id AS orgId, version, manifest_hash AS manifestHash FROM bundle_active WHERE bundle_id = ? AND org_id = ?",
    )
    .bind(bundleId, orgId)
    .first<{ bundleId: string; orgId: string; version: string; manifestHash: string }>();
  return row ?? null;
}

/**
 * Fail-closed execution gate (ADR 011 section 4, local decision): an
 * Execution for a Saga covered by a bundle install runs only against the
 * applicable active install/revision. Throws NO_ACTIVE_INSTALL when no
 * install is active for this org + saga, STALE_INSTALL_REVISION when the
 * active pin disagrees with deployed code.
 *
 * Explicit local/loose development exception: orgs with no install rows at
 * all (fresh local D1, seed-only fixtures, pre-activation databases) keep
 * working — mirroring upstream's legacy-repo exception. The boundary is
 * data, not configuration: the first install for an org engages the gate.
 */
export async function requireActiveInstall(
  db: D1Database,
  sagaId: string,
  sagaRevision: string,
  orgId: string,
): Promise<ActiveInstall | null> {
  const present = await activationTablesPresent(db);
  if (!present) return null;
  const anyInstall = await db
    .prepare("SELECT id FROM bundle_installs WHERE org_id = ? LIMIT 1")
    .bind(orgId)
    .first<{ id: number }>();
  if (!anyInstall) return null;
  const pin = await db
    .prepare(
      "SELECT s.bundle_id AS bundleId, s.revision AS revision, a.version AS version, a.manifest_hash AS manifestHash " +
        "FROM bundle_sagas s JOIN bundle_active a ON a.bundle_id = s.bundle_id AND a.org_id = s.org_id " +
        "WHERE s.org_id = ? AND s.saga_id = ?",
    )
    .bind(orgId, sagaId)
    .first<{ bundleId: string; revision: string; version: string; manifestHash: string }>();
  if (!pin) {
    throw invalid(
      "NO_ACTIVE_INSTALL",
      "No active bundle install covers this Saga for this Organization: install the bundle before executing.",
      409,
    );
  }
  if (pin.revision !== sagaRevision) {
    throw invalid(
      "STALE_INSTALL_REVISION",
      `Active install pins revision "${pin.revision}" but deployed code is "${sagaRevision}": reinstall the bundle before executing.`,
      409,
    );
  }
  return { bundleId: pin.bundleId, orgId, version: pin.version, manifestHash: pin.manifestHash };
}

/**
 * Ordinary application/API Connection write path. Managed rows reject with
 * MANAGED_RESOURCE — only the installer writes them. Loose rows
 * (managed_by NULL, created outside install) stay freely writable.
 */
export async function updateConnectionEndpoint(
  db: D1Database,
  orgId: string,
  integrationId: string,
  endpoint: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT managed_by FROM connections WHERE org_id = ? AND integration_id = ?")
    .bind(orgId, integrationId)
    .first<{ managed_by: string | null }>();
  if (!row) throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  if (row.managed_by !== null) {
    // Marker is a bundle ID, not a secret: no secret list exists on this
    // path, so the scrub is a no-op pin keeping exports secret-free.
    throw invalid(
      "MANAGED_RESOURCE",
      `Connection is managed by bundle install ${row.managed_by}: live mutation outside install is rejected.`,
      409,
    );
  }
  await db
    .prepare("UPDATE connections SET endpoint = ? WHERE org_id = ? AND integration_id = ?")
    .bind(endpoint, orgId, integrationId)
    .run();
}
