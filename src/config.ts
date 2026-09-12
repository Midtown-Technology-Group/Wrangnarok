// SPDX-License-Identifier: AGPL-3.0
// Scoped configuration and secret references (CON-02, issue #147; ADR 020).
//
// A Config declaration is portable source (a key name); a Config value is
// environment state: one D1 `configs` row per (org_id, key) carrying a typed
// value. Types mirror the upstream vocabulary (string/int/bool/json/secret).
// There is no global tier in v1 (ADR 020): resolution is org-only, and any
// future global tier needs its own ADR with explicit lookup/write semantics.
//
// Secret discipline (ADR 005 v0 unchanged): D1 holds no secret values in any
// column. A `secret`-typed row stores a REFERENCE ({ ref } naming a declared
// provider-global deployment secret, or {} when unprovisioned). Provisioning
// presence-checks the named deployment secret; values resolve transiently at
// the Integration Action call boundary and never persist, log, or return.
import { Fault, UUID } from "./domain";
import type { Principal, SafeError } from "./domain";
import { INTEGRATION_DEFINITIONS } from "./integrations";
import { registerExecutionSecrets } from "./secrets";

/** Closed v1 config type set (upstream ConfigType vocabulary). */
export const CONFIG_TYPES = ["string", "int", "bool", "json", "secret"] as const;
export type ConfigType = (typeof CONFIG_TYPES)[number];

/** Upstream list-masking parity: secret values never serialize. */
export const SECRET_MASK = "[SECRET]";

/** Upstream key shape: SetConfigRequest.key pattern. */
export const CONFIG_KEY = /^[A-Za-z0-9_]+$/;
const CONFIG_KEY_MAX = 128;
const CONFIG_STRING_MAX_BYTES = 4096;
const CONFIG_DESCRIPTION_MAX = 280;

/** Credential-shaped names/values must never ride a non-secret config row:
 * secret material belongs in deployment secrets, never in a config value. */
const CREDENTIAL_SHAPE =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)/i;

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > CONFIG_KEY_MAX || !CONFIG_KEY.test(key)) {
    throw invalid(
      "INVALID_CONFIG_KEY",
      "Config keys use 1-128 chars of [A-Za-z0-9_], matching the upstream key shape.",
    );
  }
  return key;
}

export function checkType(type: unknown): ConfigType {
  if (typeof type !== "string" || !(CONFIG_TYPES as readonly string[]).includes(type)) {
    throw invalid("INVALID_CONFIG_TYPE", "Config type must be string, int, bool, json, or secret.");
  }
  return type as ConfigType;
}

function checkDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > CONFIG_DESCRIPTION_MAX) {
    throw invalid("INVALID_CONFIG_DESCRIPTION", "Config descriptions are at most 280 chars.");
  }
  return value.length === 0 ? null : value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Validate a non-secret value for its type and return the canonical stored
 * form. Throws INVALID_CONFIG_VALUE; never touches secrets. */
export function validateConfigValue(type: Exclude<ConfigType, "secret">, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid("INVALID_CONFIG_VALUE", `A ${type} config needs a non-empty string value.`);
  }
  if (CREDENTIAL_SHAPE.test(value) || CREDENTIAL_SHAPE.test(type)) {
    throw invalid(
      "CREDENTIAL_IN_VALUE",
      "That value looks like a credential: secret material belongs in deployment secrets, never in a config row.",
    );
  }
  switch (type) {
    case "string": {
      if (utf8Length(value) > CONFIG_STRING_MAX_BYTES) {
        throw invalid("INVALID_CONFIG_VALUE", "String configs carry at most 4096 UTF-8 bytes.");
      }
      return value;
    }
    case "int": {
      if (!/^-?\d+$/.test(value)) throw invalid("INVALID_CONFIG_VALUE", "Int configs carry canonical integer text.");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < -2147483648 || parsed > 2147483647) {
        throw invalid("INVALID_CONFIG_VALUE", "Int configs carry 32-bit integers.");
      }
      return String(parsed);
    }
    case "bool": {
      if (value !== "true" && value !== "false") {
        throw invalid("INVALID_CONFIG_VALUE", 'Bool configs carry exactly "true" or "false".');
      }
      return value;
    }
    case "json": {
      if (utf8Length(value) > CONFIG_STRING_MAX_BYTES) {
        throw invalid("INVALID_CONFIG_VALUE", "JSON configs carry at most 4096 UTF-8 bytes.");
      }
      try {
        JSON.parse(value);
      } catch {
        throw invalid("INVALID_CONFIG_VALUE", "JSON configs carry parseable JSON text.");
      }
      return value;
    }
  }
}

/** Parse a stored non-secret row back to its typed value. Corrupt rows are a
 * server defect (500), never caller input. */
export function parseStoredValue(type: ConfigType, stored: string): unknown {
  try {
    switch (type) {
      case "string":
        return stored;
      case "int": {
        const parsed = Number(stored);
        if (!Number.isSafeInteger(parsed)) throw new Error("bad int");
        return parsed;
      }
      case "bool": {
        if (stored !== "true" && stored !== "false") throw new Error("bad bool");
        return stored === "true";
      }
      case "json":
        return JSON.parse(stored) as unknown;
      case "secret":
        throw new Error("secret rows carry references, not values");
    }
  } catch {
    throw new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
  }
}

export interface ConfigRow {
  readonly id: string;
  readonly orgId: string;
  readonly key: string;
  readonly type: ConfigType;
  /** Stored form: canonical value text for non-secret rows; JSON reference
   * ({ ref } or {}) for secret rows. Never a secret value. */
  readonly stored: string;
  readonly description: string | null;
  readonly managedBy: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

interface ConfigDbRow {
  id: string;
  org_id: string;
  key: string;
  type: string;
  value_json: string;
  description: string | null;
  managed_by: string | null;
  updated_at: string;
  updated_by: string;
}

function toConfigRow(row: ConfigDbRow): ConfigRow {
  return {
    id: row.id,
    orgId: row.org_id,
    key: row.key,
    type: checkType(row.type),
    stored: row.value_json,
    description: row.description,
    managedBy: row.managed_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Operator/list shape: typed value for non-secret rows, SECRET_MASK for
 * secret rows. The reference target is never serialized. */
export interface ConfigEntry {
  readonly id: string;
  readonly key: string;
  readonly type: ConfigType;
  readonly value: unknown;
  readonly description: string | null;
  readonly managedBy: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export function toConfigEntry(row: ConfigRow): ConfigEntry {
  return {
    id: row.id,
    key: row.key,
    type: row.type,
    value: row.type === "secret" ? SECRET_MASK : parseStoredValue(row.type, row.stored),
    description: row.description,
    managedBy: row.managedBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function loadConfigRow(db: D1Database, orgId: string, key: string): Promise<ConfigRow | null> {
  const row = await db
    .prepare(
      "SELECT id,org_id,key,type,value_json,description,managed_by,updated_at,updated_by FROM configs WHERE org_id = ? AND key = ?",
    )
    .bind(orgId, key)
    .first<ConfigDbRow>();
  return row ? toConfigRow(row) : null;
}

export async function loadConfigById(db: D1Database, caller: Principal, id: string): Promise<ConfigRow> {
  if (!UUID.test(id)) throw invalid("INVALID_CONFIG_ID", "Config lookups need the exact config UUID.", 400);
  const row = await db
    .prepare(
      "SELECT id,org_id,key,type,value_json,description,managed_by,updated_at,updated_by FROM configs WHERE id = ? AND org_id = ?",
    )
    .bind(id, caller.orgId)
    .first<ConfigDbRow>();
  // Foreign rows 404, mirroring Execution/Connection scoping: a foreign
  // requester learns nothing about the row.
  if (!row) throw invalid("CONFIG_NOT_FOUND", "No config with that id in this Organization.", 404);
  return toConfigRow(row);
}

export async function listConfigs(db: D1Database, caller: Principal): Promise<readonly ConfigEntry[]> {
  const rows = await db
    .prepare(
      "SELECT id,org_id,key,type,value_json,description,managed_by,updated_at,updated_by FROM configs WHERE org_id = ? ORDER BY key",
    )
    .bind(caller.orgId)
    .all<ConfigDbRow>();
  return Object.freeze(rows.results.map((row: ConfigDbRow) => toConfigEntry(toConfigRow(row))));
}

/** Deployment-secret availability for provisioning secret references.
 * Presence-checked only; values never persist, log, or return. */
export interface DeploymentSecrets {
  readonly [name: string]: string | undefined;
}

/** Resolve a declared secret reference name to its deployment value.
 * Reference names are Integration `secretFields` entries (e.g.
 * `clientSecret`); the deployment binding carries the vendor credential
 * (e.g. `NINJA_CLIENT_SECRET`). Both the declared name and the
 * conventional `NINJA_`-prefixed env name resolve, so provisioning and Saga
 * reads never fail closed on a naming mismatch. Values stay transient. */
export function resolveDeploymentSecret(secrets: DeploymentSecrets, ref: string): string | undefined {
  const direct = secrets[ref];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const conventional = secrets[`NINJA_${ref.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`];
  if (typeof conventional === "string" && conventional.length > 0) return conventional;
  const upper = secrets[ref.toUpperCase()];
  if (typeof upper === "string" && upper.length > 0) return upper;
  return undefined;
}

/** All declared provider-global secret names across Integration definitions
 * (ADR 005 v0: secretFields stay the provisioning vocabulary). */
export function declaredSecretNames(): readonly string[] {
  const names: string[] = [];
  for (const def of INTEGRATION_DEFINITIONS) {
    for (const field of def.secretFields) names.push(field);
  }
  return Object.freeze(names);
}

/** Parse and validate a secret reference body: { ref } naming a declared
 * provider-global secret, or absent/empty to leave the reference
 * unprovisioned. Throws SECRET_SCHEMA_MISMATCH for undeclared names. */
export function parseSecretRef(value: unknown): { ref: string } | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("INVALID_CONFIG_VALUE", "Secret configs carry a { ref } reference, never a value.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  if (keys.length !== 1 || typeof record.ref !== "string" || (record.ref as string).length === 0) {
    throw invalid("INVALID_CONFIG_VALUE", "Secret configs carry exactly { ref: <declared secret name> }.");
  }
  const ref = record.ref as string;
  // Every Integration declares its secretFields, so the join below always
  // names at least one provisionable secret.
  if (!declaredSecretNames().includes(ref)) {
    throw invalid(
      "SECRET_SCHEMA_MISMATCH",
      `Secret "${ref}" is not a declared provider-global secret (${declaredSecretNames().join(", ")}).`,
    );
  }
  return { ref };
}

/** Provisioning gate: the named deployment secret must exist and be
 * non-empty, or the install/operator write fails closed with
 * SECRET_NOT_CONFIGURED so a half-credentialed declaration never resolves. */
export function requireProvisionedSecret(secrets: DeploymentSecrets, ref: string): void {
  if (resolveDeploymentSecret(secrets, ref) === undefined) {
    throw invalid(
      "SECRET_NOT_CONFIGURED",
      `Secret "${ref}" has no deployment value available: refusing a half-credentialed config.`,
    );
  }
}

export interface SetConfigInput {
  readonly key: unknown;
  readonly type: unknown;
  readonly value?: unknown;
  readonly description?: unknown;
}

/** Set (upsert by natural key (org_id, key)) a config row for the caller's
 * own Organization. Non-secret types validate and store the canonical value;
 * secret types provision a reference ({ ref } or empty). Managed rows reject
 * with MANAGED_RESOURCE; only the installer writes them. */
export async function setConfig(
  db: D1Database,
  caller: Principal,
  input: SetConfigInput,
  secrets: DeploymentSecrets,
): Promise<ConfigEntry> {
  const key = checkKey(input.key);
  const type = checkType(input.type);
  const description = checkDescription(input.description);
  const existing = await loadConfigRow(db, caller.orgId, key);
  if (existing && existing.managedBy !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Config "${key}" is managed by bundle install ${existing.managedBy}: live mutation outside install is rejected.`,
      409,
    );
  }
  let stored: string;
  if (type === "secret") {
    const ref = parseSecretRef(input.value);
    if (ref) requireProvisionedSecret(secrets, ref.ref);
    stored = JSON.stringify(ref ?? {});
  } else {
    stored = validateConfigValue(type, input.value);
  }
  const now = new Date().toISOString();
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await db
      .prepare(
        "UPDATE configs SET type = ?, value_json = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = ? AND org_id = ?",
      )
      .bind(type, stored, description, now, caller.userId, id, caller.orgId)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO configs(id, org_id, key, type, value_json, description, managed_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .bind(id, caller.orgId, key, type, stored, description, now, caller.userId)
      .run();
  }
  const row = await loadConfigRow(db, caller.orgId, key);
  if (!row) throw new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
  return toConfigEntry(row);
}

export interface UpdateConfigInput {
  readonly key?: unknown;
  readonly type?: unknown;
  readonly value?: unknown;
  readonly description?: unknown;
  readonly hasDescription: boolean;
}

/** Parse an update body: every field optional. For secret rows, an absent or
 * empty-string value preserves the existing reference (upstream
 * partial-update parity); a new { ref } re-provisions it. */
export function parseUpdateConfigInput(body: unknown): UpdateConfigInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("INVALID_CONFIG_UPDATE", "Config updates carry an object of optional fields.");
  }
  const record = body as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!["key", "type", "value", "description"].includes(field)) {
      throw invalid("INVALID_CONFIG_UPDATE", `Unknown config field ${JSON.stringify(field)}.`);
    }
  }
  return {
    ...(record.key === undefined ? {} : { key: record.key }),
    ...(record.type === undefined ? {} : { type: record.type }),
    ...(record.value === undefined ? {} : { value: record.value }),
    ...(record.description === undefined ? {} : { description: record.description as unknown }),
    hasDescription: record.description !== undefined,
  };
}

/** Update one row by ID within the caller's Organization. Type changes
 * re-validate the supplied value against the new type (a value is required
 * unless the row is a secret keeping its reference). */
export async function updateConfig(
  db: D1Database,
  caller: Principal,
  id: string,
  input: UpdateConfigInput,
  secrets: DeploymentSecrets,
): Promise<ConfigEntry> {
  const row = await loadConfigById(db, caller, id);
  if (row.managedBy !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Config "${row.key}" is managed by bundle install ${row.managedBy}: live mutation outside install is rejected.`,
      409,
    );
  }
  const key = input.key === undefined ? row.key : checkKey(input.key);
  const type = input.type === undefined ? row.type : checkType(input.type);
  const description = !input.hasDescription ? row.description : checkDescription(input.description);
  let stored = row.stored;
  if (type === "secret") {
    if (input.value === undefined || input.value === "") {
      // Preserve the existing reference; a type change onto secret with no
      // value leaves the row unprovisioned rather than inventing one.
      stored = row.type === "secret" ? row.stored : JSON.stringify({});
    } else {
      const ref = parseSecretRef(input.value);
      if (ref) requireProvisionedSecret(secrets, ref.ref);
      stored = JSON.stringify(ref ?? {});
    }
  } else if (input.value !== undefined) {
    stored = validateConfigValue(type, input.value);
  } else if (type !== row.type) {
    throw invalid("INVALID_CONFIG_VALUE", `Changing to ${type} needs a value validated against the new type.`);
  }
  const now = new Date().toISOString();
  const applied = await db
    .prepare(
      "UPDATE configs SET key = ?, type = ?, value_json = ?, description = ?, updated_at = ?, updated_by = ? WHERE id = ? AND org_id = ?",
    )
    .bind(key, type, stored, description, now, caller.userId, id, caller.orgId)
    .run();
  if (applied.meta.changes === 0) {
    throw invalid("CONFIG_CONFLICT", "Config changed under update: refusing silent overwrite.", 409);
  }
  const updated = await loadConfigById(db, caller, id);
  return toConfigEntry(updated);
}

export async function deleteConfig(db: D1Database, caller: Principal, id: string): Promise<void> {
  const row = await loadConfigById(db, caller, id);
  if (row.managedBy !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Config "${row.key}" is managed by bundle install ${row.managedBy}: live mutation outside install is rejected.`,
      409,
    );
  }
  await db.prepare("DELETE FROM configs WHERE id = ? AND org_id = ?").bind(id, caller.orgId).run();
}

// --- Saga resolution --------------------------------------------------------
// A Saga resolves config only inside step.do() through its own Organization
// context (ADR 020). Declared-but-missing without a default fails loud with
// CONFIG_REQUIREMENT_UNSATISFIED (the config analogue of
// INTEGRATION_REQUIREMENT_UNSATISFIED); undeclared access with a default
// resolves to the default and never throws. Secret references resolve
// transiently against the deployment secrets and register with the
// execution-scoped registry so write-time scrubbing covers every egress.

export type ConfigResolution =
  | { readonly found: true; readonly value: unknown; readonly type: ConfigType }
  | { readonly found: false; readonly declared: true; readonly error: SafeError }
  | { readonly found: false; readonly declared: false; readonly value: unknown };

export interface ConfigResolverEnv {
  readonly db: D1Database;
  readonly orgId: string;
  readonly executionId?: string;
  readonly secrets: DeploymentSecrets;
}

/** Resolve one config key for a Saga Execution. `declared` names the keys
 * the Saga declares (a miss fails loud); `defaults` supplies undeclared
 * fallbacks (a miss resolves to the default). */
export async function resolveConfig(
  env: ConfigResolverEnv,
  key: unknown,
  declared: readonly string[] = [],
  defaults: Readonly<Record<string, unknown>> = {},
): Promise<ConfigResolution> {
  const name = checkKey(key);
  const row = await loadConfigRow(env.db, env.orgId, name);
  if (!row) {
    if (name in defaults) return { found: false, declared: false, value: defaults[name] };
    if (declared.includes(name)) {
      return {
        found: false,
        declared: true,
        error: {
          code: "CONFIG_REQUIREMENT_UNSATISFIED",
          message: `This Saga requires config "${name}" that is not set for this Organization.`,
        },
      };
    }
    return { found: false, declared: false, value: null };
  }
  if (row.type === "secret") {
    let ref: { ref?: string };
    try {
      ref = JSON.parse(row.stored) as { ref?: string };
    } catch {
      throw new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
    }
    if (typeof ref.ref !== "string" || ref.ref.length === 0) {
      if (name in defaults) return { found: false, declared: false, value: defaults[name] };
      if (declared.includes(row.key)) {
        return {
          found: false,
          declared: true,
          error: {
            code: "SECRET_NOT_CONFIGURED",
            message: `Config "${name}" names no provisioned secret: refusing an uncredentialed read.`,
          },
        };
      }
      return { found: false, declared: false, value: null };
    }
    const value = resolveDeploymentSecret(env.secrets, ref.ref);
    if (value === undefined) {
      if (name in defaults) return { found: false, declared: false, value: defaults[name] };
      if (declared.includes(row.key)) {
        return {
          found: false,
          declared: true,
          error: {
            code: "SECRET_NOT_CONFIGURED",
            message: `Config "${name}" has no deployment value available: refusing an uncredentialed read.`,
          },
        };
      }
      return { found: false, declared: false, value: null };
    }
    if (env.executionId !== undefined) registerExecutionSecrets(env.executionId, [value]);
    return { found: true, value, type: "secret" };
  }
  return { found: true, value: parseStoredValue(row.type, row.stored), type: row.type };
}

/** Saga author handle: boring typed reads over resolveConfig. `get` returns
 * the value or the default; `require` fails loud on a declared-but-missing
 * key. Usable only inside step.do() (determinism gate in src/saga.ts). */
export interface SagaConfigHandle {
  get(key: string, defaultValue?: unknown): Promise<unknown>;
  require(key: string): Promise<unknown>;
}

export function bindSagaConfig(
  env: ConfigResolverEnv,
  declared: readonly string[] = [],
  defaults: Readonly<Record<string, unknown>> = {},
): SagaConfigHandle {
  return {
    async get(key: string, defaultValue?: unknown): Promise<unknown> {
      const merged = defaultValue === undefined ? defaults : { ...defaults, [key]: defaultValue };
      const resolved = await resolveConfig(env, key, declared, merged);
      if (resolved.found) return resolved.value;
      if (!resolved.declared) return resolved.value;
      throw new Fault(424, resolved.error.code, resolved.error.message);
    },
    async require(key: string): Promise<unknown> {
      // key is appended to declared, so a miss is always the declared
      // variant: surface it loud. The undeclared fallthrough below is
      // defensive — resolveConfig cannot produce it here by construction.
      const resolved = await resolveConfig(env, key, [...declared, key], defaults);
      if (resolved.found) return resolved.value;
      if (resolved.declared) throw new Fault(424, resolved.error.code, resolved.error.message);
      throw new Fault(
        424,
        "CONFIG_REQUIREMENT_UNSATISFIED",
        `This Saga requires config "${key}" that is not set for this Organization.`,
      );
    },
  };
}

/** Managed-row reconciliation hook for the Solution installer (ADR 011
 * owned/loose contract): reconcile manifest-declared config pins in the
 * `bundle_config` table, delete pins the manifest dropped, never touch loose
 * rows or rows owned by another bundle. Returns the per-key drift counts
 * merged into the install drift report by the caller.
 *
 * This is deliberately separate from the operator `configs` table: manifest
 * pins are bundle-owned install state (one row per bundle/org/key), while
 * operator rows are environment state (one row per org/key). Saga resolution
 * reads the operator table; the installer owns the pins table. A future ADR
 * may promote a pin into an operator row at install time — that promotion is
 * not authorized here. */
export interface ConfigDrift {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly deleted: number;
}

export async function reconcileManagedConfigs(
  db: D1Database,
  bundleId: string,
  orgId: string,
  marker: string,
  desired: ReadonlyMap<string, string>,
): Promise<ConfigDrift> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let deleted = 0;
  const rows = await db
    .prepare(
      "SELECT config_key AS key, config_value AS value, managed_by FROM bundle_config WHERE bundle_id = ? AND org_id = ?",
    )
    .bind(bundleId, orgId)
    .all<{ key: string; value: string; managed_by: string }>();
  const byKey = new Map<string, { key: string; value: string; managed_by: string }>(
    rows.results.map((row: { key: string; value: string; managed_by: string }) => [row.key, row]),
  );
  for (const [key, value] of desired) {
    const current = byKey.get(key);
    if (!current) {
      await db
        .prepare(
          "INSERT INTO bundle_config(bundle_id, org_id, config_key, config_value, managed_by) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(bundleId, orgId, key, value, marker)
        .run();
      created += 1;
    } else if (!current.managed_by.startsWith(`${bundleId}@`)) {
      throw invalid(
        "INSTALL_CONFLICT",
        `Config "${key}" is managed by a different bundle (${current.managed_by}): hijack by reinstall is refused.`,
        409,
      );
    } else if (current.value === value && current.managed_by === marker) {
      skipped += 1;
    } else {
      const applied = await db
        .prepare(
          "UPDATE bundle_config SET config_value = ?, managed_by = ? WHERE bundle_id = ? AND org_id = ? AND config_key = ? AND managed_by = ?",
        )
        .bind(value, marker, bundleId, orgId, key, current.managed_by)
        .run();
      if (applied.meta.changes === 0) {
        throw invalid("INSTALL_CONFLICT", "Config changed under install: refusing silent overwrite.", 409);
      }
      updated += 1;
    }
  }
  for (const [key, current] of byKey) {
    if (!desired.has(key)) {
      const applied = await db
        .prepare("DELETE FROM bundle_config WHERE bundle_id = ? AND org_id = ? AND config_key = ? AND managed_by = ?")
        .bind(bundleId, orgId, key, current.managed_by)
        .run();
      if (applied.meta.changes === 0) {
        throw invalid("INSTALL_CONFLICT", "Managed config changed under install: refusing silent delete.", 409);
      }
      deleted += 1;
    }
  }
  return { created, updated, skipped, deleted };
}

/** Export exclusion (OPS-03/SOL-03 boundary): exports carry declarations
 * (keys, types, managed_by markers) only — never values. There is no secret
 * material to exclude because none is ever stored. */
export interface ConfigExportEntry {
  readonly key: string;
  readonly type: ConfigType;
  readonly managedBy: string | null;
}

export async function exportConfigDeclarations(db: D1Database, orgId: string): Promise<readonly ConfigExportEntry[]> {
  const rows = await db
    .prepare("SELECT key,type,managed_by FROM configs WHERE org_id = ? ORDER BY key")
    .bind(orgId)
    .all<{ key: string; type: string; managed_by: string | null }>();
  return Object.freeze(
    rows.results.map((row: { key: string; type: string; managed_by: string | null }) => ({
      key: row.key,
      type: checkType(row.type),
      managedBy: row.managed_by,
    })),
  );
}

/** Validate one manifest config entry the Solutions way (string values,
 * credential-shaped keys rejected). Shared by install preflight and the
 * manifest validator. */
export function validateManifestConfigValue(key: string, value: string): void {
  checkKey(key);
  if (typeof value !== "string" || value.length === 0) {
    throw invalid("INVALID_MANIFEST", `Manifest config "${key}" must carry a non-empty string value.`);
  }
  if (CREDENTIAL_SHAPE.test(key)) {
    throw invalid(
      "CREDENTIAL_IN_MANIFEST",
      `Manifest config key "${key}" looks like a credential: manifests never carry values for secrets.`,
    );
  }
}

/** Provisioned Integration secret names available for secret-reference checks. */
export function secretSchemaNames(): readonly string[] {
  return declaredSecretNames();
}
