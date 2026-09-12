// SPDX-License-Identifier: AGPL-3.0
// Integration vs Connection split (ADR 003, Proposed).
//
// An Integration is code: a reusable, typed provider definition with a stable
// machine identifier, discovery metadata, and identification of which config
// fields are secret. It never owns tenant credentials or mutable tokens.
// A Connection is environment state: a configured instance of an Integration
// for one Organization. The D1 row carries the stable IDs plus the
// non-secret endpoint; decrypted material only ever exists transiently
// inside server-side execution (see ADR 005, Proposed).
import { ECHO_INTEGRATION_ID, Fault, NINJA_INTEGRATION_ID, object, UUID } from "../domain";
import type { FieldFailure } from "../domain";

/** One non-secret Connection config field (CON-01). Portable declaration
 * only: names, types, defaults, and bounds — never tenant values. */
export interface IntegrationConfigField {
  readonly name: string;
  /** Only plain strings in the MVP slice: endpoints and display metadata. */
  readonly type: "string";
  /** Required means a value must resolve (explicit or default) at write time. */
  readonly required: boolean;
  /** Non-secret default applied when the writer omits the field. */
  readonly default?: string;
  readonly maxLength?: number;
  readonly description: string;
}

/** Operator-facing health contract (CON-01): how to verify this Integration
 * end to end and where to look first when it fails. Fixed text, no values. */
export interface IntegrationHealth {
  readonly testHint: string;
  readonly remediation: string;
}

/** Reusable provider definition. Source declaration only — never endpoints,
 * credentials, or per-Organization state. */
export interface IntegrationDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Config field names treated as secret (never persisted in plaintext,
   * never logged, never returned through discovery or history APIs). */
  readonly secretFields: readonly string[];
  /** Non-secret Connection config schema: the only keys a Connection mapping
   * may carry for this Integration. */
  readonly configSchema: readonly IntegrationConfigField[];
  /** Declared provider-global credential requirements (ADR 005 v0): names
   * only, resolved from the deployment environment — never per-tenant values.
   * A missing requirement fails loud; there is no fallback. */
  readonly requiredSecrets: readonly string[];
  /** Deployment environment variable carrying each required secret. Names
   * only (e.g. clientSecret -> NINJA_CLIENT_SECRET); values never travel. */
  readonly secretEnvVars: Readonly<Record<string, string>>;
  readonly health: IntegrationHealth;
}

const INTEGRATION_NAME = /^[a-z0-9][a-z0-9.-]*$/i;
const CONFIG_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** Manifest-style structural exclusion (matches src/solutions.ts): config
 * keys shaped like credentials are never non-secret schema. */
const CREDENTIAL_LIKE =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)/i;
/** Management writes carry at most a handful of string fields; the D1 text
 * bound stays the backstop, this is the fail-fast front gate. */
export const CONNECTION_CONFIG_MAX_LENGTH = 512;

export function defineIntegration(def: IntegrationDefinition): IntegrationDefinition {
  if (!UUID.test(def.id)) {
    throw new Error(
      `Invalid Integration definition "${def.name}": id "${def.id}" must be a stable UUID; changing it mints a different Integration.`,
    );
  }
  if (!INTEGRATION_NAME.test(def.name)) {
    throw new Error(`Invalid Integration definition id ${def.id}: name "${def.name}" must be a simple slug.`);
  }
  if (typeof def.description !== "string" || def.description.length === 0 || def.description.length > 280) {
    throw new Error(`Invalid Integration definition "${def.name}": description must be 1-280 chars.`);
  }
  if (
    !Array.isArray(def.secretFields) ||
    def.secretFields.some((field) => typeof field !== "string" || field.length === 0)
  ) {
    throw new Error(
      `Invalid Integration definition "${def.name}": secretFields must be an explicit list (empty when none).`,
    );
  }
  const secretSet = new Set(def.secretFields);
  if (secretSet.size !== def.secretFields.length) {
    throw new Error(`Invalid Integration definition "${def.name}": secretFields must be unique.`);
  }
  if (!Array.isArray(def.configSchema) || def.configSchema.length === 0) {
    throw new Error(
      `Invalid Integration definition "${def.name}": configSchema must declare at least the endpoint field.`,
    );
  }
  const fieldNames = new Set<string>();
  for (const field of def.configSchema) {
    if (field === null || typeof field !== "object") {
      throw new Error(`Invalid Integration definition "${def.name}": every configSchema entry must be an object.`);
    }
    if (!CONFIG_FIELD_NAME.test(field.name)) {
      throw new Error(
        `Invalid Integration definition "${def.name}": config field "${field.name}" must be 1-64 chars [A-Za-z0-9_], leading letter.`,
      );
    }
    if (fieldNames.has(field.name)) {
      throw new Error(`Invalid Integration definition "${def.name}": duplicate config field "${field.name}".`);
    }
    fieldNames.add(field.name);
    if (field.type !== "string") {
      throw new Error(
        `Invalid Integration definition "${def.name}": config field "${field.name}" type must be "string".`,
      );
    }
    if (typeof field.required !== "boolean") {
      throw new Error(
        `Invalid Integration definition "${def.name}": config field "${field.name}" required must be explicit.`,
      );
    }
    if (CREDENTIAL_LIKE.test(field.name) || secretSet.has(field.name)) {
      throw new Error(
        `Invalid Integration definition "${def.name}": config field "${field.name}" looks like a secret — declare it in secretFields, never in the non-secret schema.`,
      );
    }
    if (field.default !== undefined) {
      if (typeof field.default !== "string" || field.default.length === 0) {
        throw new Error(
          `Invalid Integration definition "${def.name}": config field "${field.name}" default must be a non-empty string.`,
        );
      }
      if (CREDENTIAL_LIKE.test(field.default)) {
        throw new Error(
          `Invalid Integration definition "${def.name}": config field "${field.name}" default looks like credential material.`,
        );
      }
    }
    if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1)) {
      throw new Error(
        `Invalid Integration definition "${def.name}": config field "${field.name}" maxLength must be a positive integer.`,
      );
    }
    if (typeof field.description !== "string" || field.description.length === 0 || field.description.length > 280) {
      throw new Error(
        `Invalid Integration definition "${def.name}": config field "${field.name}" description must be 1-280 chars.`,
      );
    }
  }
  if (!fieldNames.has("endpoint")) {
    throw new Error(`Invalid Integration definition "${def.name}": configSchema must declare the "endpoint" field.`);
  }
  if (
    !Array.isArray(def.requiredSecrets) ||
    def.requiredSecrets.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error(
      `Invalid Integration definition "${def.name}": requiredSecrets must be an explicit list (empty when none).`,
    );
  }
  for (const name of def.requiredSecrets) {
    if (!secretSet.has(name)) {
      throw new Error(
        `Invalid Integration definition "${def.name}": required secret "${name}" must be declared in secretFields.`,
      );
    }
  }
  if (def.secretEnvVars === null || typeof def.secretEnvVars !== "object" || Array.isArray(def.secretEnvVars)) {
    throw new Error(`Invalid Integration definition "${def.name}": secretEnvVars must be an object (empty when none).`);
  }
  for (const name of def.requiredSecrets) {
    const envVar = (def.secretEnvVars as Record<string, unknown>)[name];
    if (typeof envVar !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(envVar)) {
      throw new Error(
        `Invalid Integration definition "${def.name}": required secret "${name}" needs an explicit UPPER_SNAKE env var name.`,
      );
    }
  }
  if (
    def.health === null ||
    typeof def.health !== "object" ||
    typeof (def.health as IntegrationHealth).testHint !== "string" ||
    (def.health as IntegrationHealth).testHint.length === 0 ||
    (def.health as IntegrationHealth).testHint.length > 280 ||
    typeof (def.health as IntegrationHealth).remediation !== "string" ||
    (def.health as IntegrationHealth).remediation.length === 0 ||
    (def.health as IntegrationHealth).remediation.length > 280
  ) {
    throw new Error(`Invalid Integration definition "${def.name}": health needs 1-280 char testHint and remediation.`);
  }
  return Object.freeze({
    ...def,
    secretFields: Object.freeze([...def.secretFields]),
    configSchema: Object.freeze(def.configSchema.map((field) => Object.freeze({ ...field }))),
    requiredSecrets: Object.freeze([...def.requiredSecrets]),
    secretEnvVars: Object.freeze({ ...def.secretEnvVars }),
    health: Object.freeze({ ...def.health }),
  });
}

export const echoIntegrationDef = defineIntegration({
  id: ECHO_INTEGRATION_ID,
  name: "echo",
  description: "Local fixture HTTP echo: POST echoes data without external mutation.",
  secretFields: [],
  configSchema: [
    {
      name: "endpoint",
      type: "string",
      required: true,
      default: "http://127.0.0.1:8788/echo",
      maxLength: CONNECTION_CONFIG_MAX_LENGTH,
      description: "Fixture echo URL. Echo accepts only its local fixture endpoint.",
    },
  ],
  requiredSecrets: [],
  secretEnvVars: {},
  health: {
    testHint: "Run the echo test call and confirm the message round-trips.",
    remediation: "Check the fixture server is running, then confirm the endpoint matches the fixture URL.",
  },
});

export const ninjaIntegrationDef = defineIntegration({
  id: NINJA_INTEGRATION_ID,
  name: "ninjaone",
  description: "Read-only NinjaOne organization census over client-credentials OAuth.",
  secretFields: ["clientSecret"],
  configSchema: [
    {
      name: "endpoint",
      type: "string",
      required: true,
      maxLength: CONNECTION_CONFIG_MAX_LENGTH,
      description: "Regional NinjaOne API origin (for example https://us2.ninjarmm.com/api).",
    },
    {
      name: "clientIdLabel",
      type: "string",
      required: false,
      maxLength: 128,
      description: "Optional non-secret label naming which deployment credential this mapping uses.",
    },
  ],
  requiredSecrets: ["clientSecret"],
  secretEnvVars: { clientSecret: "NINJA_CLIENT_SECRET" },
  health: {
    testHint: "Run the connectivity test, then submit a read-only organization census.",
    remediation: "Confirm the regional endpoint and the deployment credential, then re-test before submitting work.",
  },
});

/** All Integration definitions, in canonical order. Add new Integrations here. */
export const INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[] = Object.freeze([
  echoIntegrationDef,
  ninjaIntegrationDef,
]);

export function integrationById(id: string): IntegrationDefinition | undefined {
  return INTEGRATION_DEFINITIONS.find((entry) => entry.id === id);
}

export function integrationByName(name: string): IntegrationDefinition | undefined {
  return INTEGRATION_DEFINITIONS.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

/** Validate one non-secret Connection config object against the Integration
 * schema (CON-01). Applies declared defaults, rejects unknown keys,
 * credential-shaped keys, missing required fields, and overlong values.
 * Throws Fault 400 CONNECTION_SCHEMA_INVALID with per-field details (FORM-01
 * details channel shape: { field, code, message }[]). Pure: no D1, no env. */
export function validateConnectionConfig(def: IntegrationDefinition, value: unknown): Record<string, string> {
  const failures: FieldFailure[] = [];
  if (!object(value)) {
    throw new Fault(400, "CONNECTION_SCHEMA_INVALID", "The Connection config must be a JSON object.", [
      { field: "", code: "NOT_OBJECT", message: "The Connection config must be a JSON object." },
    ]);
  }
  const declared = new Map(def.configSchema.map((field) => [field.name, field]));
  for (const key of Object.keys(value)) {
    const field = declared.get(key);
    if (!field) {
      failures.push({
        field: key,
        code: "UNKNOWN_FIELD",
        message: `Unknown config field "${key}" for the "${def.name}" Integration.`,
      });
      continue;
    }
    void field;
  }
  const resolved: Record<string, string> = {};
  for (const field of def.configSchema) {
    const raw = (value as Record<string, unknown>)[field.name];
    if (raw === undefined) {
      if (field.default !== undefined) {
        resolved[field.name] = field.default;
      } else if (field.required) {
        failures.push({
          field: field.name,
          code: "REQUIRED",
          message: `Config field "${field.name}" is required for the "${def.name}" Integration.`,
        });
      }
      continue;
    }
    if (typeof raw !== "string" || raw.length === 0) {
      failures.push({
        field: field.name,
        code: "INVALID_TYPE",
        message: `Config field "${field.name}" must be a non-empty string.`,
      });
      continue;
    }
    const bound = field.maxLength ?? CONNECTION_CONFIG_MAX_LENGTH;
    if (raw.length > bound) {
      failures.push({
        field: field.name,
        code: "TOO_LONG",
        message: `Config field "${field.name}" exceeds ${bound} chars.`,
      });
      continue;
    }
    if (CREDENTIAL_LIKE.test(raw) && field.name !== "endpoint") {
      failures.push({
        field: field.name,
        code: "CREDENTIAL_LIKE_VALUE",
        message: `Config field "${field.name}" looks like credential material: Connections carry names only, never values.`,
      });
      continue;
    }
    resolved[field.name] = raw;
  }
  if (failures.length > 0) {
    throw new Fault(400, "CONNECTION_SCHEMA_INVALID", "The Connection config failed schema validation.", failures);
  }
  return resolved;
}

/** Discovery shape for GET /api/integrations (CON-01): portable definitions
 * with schema/defaults/health — never endpoints, credentials, or org state. */
export function describeIntegrations(): readonly IntegrationDefinition[] {
  return INTEGRATION_DEFINITIONS;
}

/** Configured instance of an Integration for one Organization. Environment
 * state, never portable source: IDs plus non-secret config only. Secret
 * material is referenced transiently at execution time, never stored here. */
export interface Connection {
  readonly id: string;
  readonly integrationId: string;
  readonly orgId: string;
  readonly endpoint: string;
  /** Optional non-secret display label (CON-01 management field). */
  readonly displayName: string | null;
  /** Disabled mappings resolve as missing-required in the Execution path. */
  readonly enabled: boolean;
  /** NULL for loose rows; <bundle_id>@<version> for installer-owned rows. */
  readonly managedBy: string | null;
}

/** Management/API view of a Connection (CON-01): stable IDs, non-secret
 * config, ownership, health — secret values never appear. */
export interface ConnectionView {
  readonly id: string;
  readonly integrationId: string;
  readonly integrationName: string;
  readonly orgId: string;
  readonly displayName: string | null;
  readonly endpoint: string;
  readonly config: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly managedBy: string | null;
  readonly ownerKind: "managed" | "loose";
  readonly secretsRequired: readonly string[];
  readonly updatedAt: string | null;
}
