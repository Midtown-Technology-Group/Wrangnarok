// SPDX-License-Identifier: AGPL-3.0
// Connection management (CON-01, issue #146): the one authorized boundary
// for non-secret Connection mappings through the Worker API.
//
// The portable Integration definitions live in src/integrations/index.ts
// (schema, defaults, required secret names, health copy). This module owns
// the per-Organization environment rows: create/update/test/disable with
// schema validation, stable identity, managed-versus-loose ownership, and
// secret-free views.
//
// Hard boundaries (SEC-02 tripwire stays shut):
// - Non-secret config only. Secret values are never accepted, persisted,
//   logged, or returned on any path here.
// - Provider-global credential requirements are declared (names + env vars)
//   and presence-checked at test time. A missing requirement fails loud;
//   there is no global Connection fallback, no cross-org lookup, and no
//   per-tenant secret storage.
import { Fault, UUID } from "./domain";
import type { Principal } from "./domain";
import { assertSafeEndpoint, integrationById, validateConnectionConfig } from "./integrations";
import type { ConnectionView } from "./integrations";
import { scrubValueWithDeploymentSecrets } from "./secrets";
import type { HaloCredentials, NinjaCredentials } from "./bindings";

/** Deployment credential surface read by the management test path (CON-01).
 * Required-secret values are presence-checked only — never persisted,
 * logged, or returned. The Worker passes its Bindings straight through
 * (Bindings extends NinjaCredentials); test doubles pass plain records.
 * No index signature: Bindings has none, and required-secret env vars are
 * read through the narrow accessor below. */
export interface SecretEnv extends NinjaCredentials, HaloCredentials {}

function secretValue(env: SecretEnv, name: string): string | undefined {
  const value: unknown = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** D1 Connection row shape (migrations 0001 + 0004 + 0007). Older databases
 * pre-0007 lack display_name/enabled/updated_at; readers tolerate NULL via
 * COALESCE and the 0007 backfill. */
interface ConnectionRow {
  readonly id: string;
  readonly org_id: string;
  readonly integration_id: string;
  readonly endpoint: string;
  readonly managed_by: string | null;
  readonly display_name: string | null;
  readonly enabled: number | null;
  readonly updated_at: string | null;
}

const DISPLAY_NAME_MAX = 128;

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return details === undefined ? new Fault(status, code, message) : new Fault(status, code, message, details);
}

function parseDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > DISPLAY_NAME_MAX) {
    throw invalid("INVALID_CONNECTION", "displayName must be 1-128 chars when provided.");
  }
  return value;
}

/** Shape one D1 row into the secret-free management view. Redaction is by
 * construction: the view carries non-secret config plus required-secret
 * names only — no secret values exist on this path to leak. */
function toView(row: ConnectionRow): ConnectionView {
  const def = integrationById(row.integration_id);
  const config: Record<string, string> = { endpoint: row.endpoint };
  if (def) {
    for (const field of def.configSchema) {
      if (field.name === "endpoint") continue;
      // The MVP D1 row persists endpoint only; extra declared fields resolve
      // to their defaults in the view until a demonstrated requirement earns
      // wider per-field persistence (CON-02 owns that decision).
      if (field.default !== undefined) config[field.name] = field.default;
    }
  }
  const view: ConnectionView = {
    id: row.id,
    integrationId: row.integration_id,
    integrationName: def?.name ?? "unknown",
    orgId: row.org_id,
    displayName: row.display_name,
    endpoint: row.endpoint,
    config: Object.freeze(config),
    enabled: (row.enabled ?? 1) === 1,
    managedBy: row.managed_by,
    ownerKind: row.managed_by === null ? "loose" : "managed",
    secretsRequired: def ? [...def.requiredSecrets] : [],
    updatedAt: row.updated_at,
  };
  return view;
}

/** Read one owned Connection row: exact org + integration, never cross-org.
 * Foreign or unknown mappings answer null so routes render 404, never a leak.
 * Management reads require the 0007 columns (every management suite applies
 * the full chain); the Execution path stays tolerant via resolutionRow. */
async function ownedRow(db: D1Database, caller: Principal, integrationId: string): Promise<ConnectionRow | null> {
  const row = await db
    .prepare(
      "SELECT id,org_id,integration_id,endpoint,managed_by,display_name,enabled,updated_at FROM connections WHERE org_id=? AND integration_id=?",
    )
    .bind(caller.orgId, integrationId)
    .first<ConnectionRow>();
  return row;
}

/** List this Organization's Connection mappings (CON-01 management read).
 * Rows for unknown Integrations are skipped: the registry is authoritative
 * and a stale row must never shape the admin view. */
export async function listConnections(db: D1Database, caller: Principal): Promise<readonly ConnectionView[]> {
  const rows = await db
    .prepare(
      "SELECT id,org_id,integration_id,endpoint,managed_by,display_name,enabled,updated_at FROM connections WHERE org_id=? ORDER BY integration_id",
    )
    .bind(caller.orgId)
    .all<ConnectionRow>();
  const views: ConnectionView[] = [];
  for (const row of rows.results) {
    if (!integrationById(row.integration_id)) continue;
    views.push(toView(row));
  }
  return Object.freeze(views);
}

/** Read one Connection mapping for this Organization. Foreign or unknown
 * mappings answer CONNECTION_NOT_FOUND (404), never a leak. */
export async function getConnection(db: D1Database, caller: Principal, integrationId: string): Promise<ConnectionView> {
  if (!UUID.test(integrationId)) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const def = integrationById(integrationId);
  if (!def) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const row = await ownedRow(db, caller, integrationId);
  if (!row) throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  return toView(row);
}

export interface ConnectionWrite {
  readonly config?: unknown;
  readonly displayName?: unknown;
  readonly enabled?: unknown;
}

/** Parse the enabled flag on write bodies. Only exact booleans: truthy
 * strings ("false") must never silently disable or enable a mapping. */
function parseEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid("INVALID_CONNECTION", "enabled must be true or false when provided.");
  return value;
}

/** Deployment environment carried into Connection validation (issue #239).
 * Routes pass the Worker's ENVIRONMENT var; unset means local/fixture.
 * Echo endpoints gate on it: the loopback default serves local only. */
export interface ConnectionWriteEnv {
  readonly environment?: string;
}
/** Create a loose Connection mapping for the caller's Organization (CON-01).
 * One mapping per (org, Integration): re-creating answers 409. Managed rows
 * are installer-owned; this path creates loose rows only, and only when no
 * row exists. Secret values are never accepted — validateConnectionConfig
 * plus the manifest-style credential exclusion enforce that before D1. */
export async function createConnection(
  db: D1Database,
  caller: Principal,
  integrationId: string,
  body: ConnectionWrite,
  writeEnv: ConnectionWriteEnv = {},
): Promise<ConnectionView> {
  if (!UUID.test(integrationId)) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const def = integrationById(integrationId);
  if (!def) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  if (body.config === undefined) {
    throw invalid("CONNECTION_SCHEMA_INVALID", "A Connection create needs a config object.");
  }
  const config = validateConnectionConfig(def, body.config, { environment: writeEnv.environment });
  const displayName = parseDisplayName(body.displayName);
  const enabled = parseEnabled(body.enabled) ?? true;
  const existing = await ownedRow(db, caller, integrationId);
  if (existing)
    throw invalid("CONNECTION_EXISTS", "A Connection already exists for this Organization and Integration.", 409);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO connections(id,org_id,integration_id,endpoint,managed_by,display_name,enabled,updated_at) VALUES (?,?,?,?,NULL,?,?,?)",
    )
    .bind(id, caller.orgId, integrationId, config.endpoint as string, displayName, enabled ? 1 : 0, now)
    .run();
  const row = await ownedRow(db, caller, integrationId);
  if (!row) throw invalid("CONNECTION_NOT_FOUND", "The Connection could not be read after create.", 500);
  return toView(row);
}

/** Update a loose Connection mapping (CON-01). Managed rows reject with
 * MANAGED_RESOURCE (installer-only writes, same code as src/solutions.ts);
 * missing rows 404. The write is partial: omitted config keys keep their
 * current values, omitted displayName/enabled keep theirs. */
export async function updateConnection(
  db: D1Database,
  caller: Principal,
  integrationId: string,
  body: ConnectionWrite,
  writeEnv: ConnectionWriteEnv = {},
): Promise<ConnectionView> {
  if (!UUID.test(integrationId)) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const def = integrationById(integrationId);
  if (!def) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const row = await ownedRow(db, caller, integrationId);
  if (!row) throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  if (row.managed_by !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Connection is managed by bundle install ${row.managed_by}: live mutation outside install is rejected.`,
      409,
    );
  }
  // Partial update: merge the persisted endpoint over the schema, then
  // validate the merged object so omitted keys keep current values while
  // unknown keys and credential-shaped input still fail.
  const merged: Record<string, unknown> =
    body.config === undefined
      ? { endpoint: row.endpoint }
      : { endpoint: row.endpoint, ...(body.config as Record<string, unknown>) };
  const config = validateConnectionConfig(def, merged, { environment: writeEnv.environment });
  const displayName = body.displayName === undefined ? row.display_name : parseDisplayName(body.displayName);
  const enabled = parseEnabled(body.enabled) ?? (row.enabled ?? 1) === 1;
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE connections SET endpoint=?,display_name=?,enabled=?,updated_at=? WHERE org_id=? AND integration_id=?",
    )
    .bind(config.endpoint as string, displayName, enabled ? 1 : 0, now, caller.orgId, integrationId)
    .run();
  const next = await ownedRow(db, caller, integrationId);
  if (!next) throw invalid("CONNECTION_NOT_FOUND", "The Connection could not be read after update.", 500);
  return toView(next);
}

/** Delete a loose Connection mapping (CON-01). Managed rows reject with
 * MANAGED_RESOURCE; missing rows 404. Deleting the last mapping for a
 * required Integration is allowed here — the Execution path fails loud
 * (424) on next use, which is the observable contract. */
export async function deleteConnection(db: D1Database, caller: Principal, integrationId: string): Promise<void> {
  if (!UUID.test(integrationId)) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const def = integrationById(integrationId);
  if (!def) throw invalid("UNKNOWN_INTEGRATION", "Unknown Integration id.", 404);
  const row = await ownedRow(db, caller, integrationId);
  if (!row) throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  if (row.managed_by !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Connection is managed by bundle install ${row.managed_by}: live mutation outside install is rejected.`,
      409,
    );
  }
  await db
    .prepare("DELETE FROM connections WHERE org_id=? AND integration_id=?")
    .bind(caller.orgId, integrationId)
    .run();
}

export type ConnectionTestOutcome =
  | { readonly ok: true; readonly checkedAt: string; readonly detail: string }
  | { readonly ok: false; readonly checkedAt: string; readonly code: string; readonly detail: string };

interface VendorEnv {
  readonly fetchImpl?: typeof fetch;
}

/** Test a Connection mapping without dispatching work (CON-01 health check).
 * Read-only by construction: no D1 writes, no Workflow dispatch, no vendor
 * mutation. The ladder is explicit:
 * 1. Unknown/disabled/missing mapping -> CONNECTION_NOT_FOUND/DISABLED or
 *    the declared 424 requirement failure shape (Execution parity).
 * 2. Missing declared provider-global credential -> SECRET_NOT_CONFIGURED
 *    (fail loud, no fallback, no per-tenant values consulted).
 * 3. Vendor probe: echo round-trips a fixed message; ninjaone fetches only
 *    the OAuth token endpoint (no org listing) so the test proves
 *    connectivity without persisting anything.
 * Secret substrings are scrubbed from every outward detail before return. */
export async function testConnection(
  db: D1Database,
  caller: Principal,
  integrationId: string,
  env: SecretEnv,
  vendor: VendorEnv = {},
): Promise<ConnectionTestOutcome> {
  if (!UUID.test(integrationId)) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      code: "UNKNOWN_INTEGRATION",
      detail: "Unknown Integration id.",
    };
  }
  const def = integrationById(integrationId);
  if (!def) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      code: "UNKNOWN_INTEGRATION",
      detail: "Unknown Integration id.",
    };
  }
  const checkedAt = new Date().toISOString();
  const row = await ownedRow(db, caller, integrationId);
  if (!row) {
    return {
      ok: false,
      checkedAt,
      code: "INTEGRATION_REQUIREMENT_UNSATISFIED",
      detail: "This Saga requires an Integration Connection that is not configured for this Organization.",
    };
  }
  if ((row.enabled ?? 1) === 0) {
    return {
      ok: false,
      checkedAt,
      code: "CONNECTION_DISABLED",
      detail: "This Connection is disabled: enable it before submitting work.",
    };
  }
  for (const name of def.requiredSecrets) {
    const envVar = def.secretEnvVars[name] as string;
    if (secretValue(env, envVar) === undefined) {
      return {
        ok: false,
        checkedAt,
        code: "SECRET_NOT_CONFIGURED",
        detail: `Deployment credential ${envVar} is not configured: refusing a half-credentialed test.`,
      };
    }
  }
  // Re-parse the persisted endpoint before any probe fetch: rows written
  // before #236 or outside the validated paths fail closed here as invalid
  // configuration, never as a vendor fetch to an unsafe target.
  try {
    assertSafeEndpoint(def.name, row.endpoint);
  } catch {
    return {
      ok: false,
      checkedAt,
      code: "INVALID_CONNECTION",
      detail: "This Connection endpoint is not a safe URL: update it before testing.",
    };
  }
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  try {
    if (def.name === "echo") {
      const response = await fetchImpl(row.endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", "Idempotency-Key": `connection-test-${row.id}` },
        body: JSON.stringify({ message: "connection-test" }),
      });
      await response.body?.cancel();
      if (!response.ok) {
        return { ok: false, checkedAt, code: "CONNECTION_TEST_FAILED", detail: def.health.remediation };
      }
      return { ok: true, checkedAt, detail: "The echo test call round-tripped." };
    }
    // HaloPSA Code Mode (TOOL-01): origin-reachability probe only, mirroring
    // the NinjaOne posture (token host answers 200/401 either way proves
    // reachability; no listing, no persistence). The pinned-contract search/
    // inspect/execute path stays on the Code Mode routes.
    if (def.name === "halo") {
      const probeUrl = new URL("/api/Tickets", row.endpoint).toString();
      const response = await fetchImpl(probeUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      });
      await response.body?.cancel();
      if (response.status >= 500) {
        return { ok: false, checkedAt, code: "CONNECTION_TEST_FAILED", detail: def.health.remediation };
      }
      return { ok: true, checkedAt, detail: "The Halo origin answered." };
    }
    // NinjaOne: token-endpoint probe only. No org listing, no persistence —
    // a 200/401 from the token host proves reachability either way (401
    // means the host answered; credential validity is the submit path).
    const tokenUrl = new URL("/oauth/token", row.endpoint).toString();
    const clientId = env.NINJA_CLIENT_ID ?? "";
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: "probe",
        scope: "monitoring",
      }).toString(),
    });
    await response.body?.cancel();
    if (response.status >= 500) {
      return { ok: false, checkedAt, code: "CONNECTION_TEST_FAILED", detail: def.health.remediation };
    }
    return { ok: true, checkedAt, detail: "The token endpoint answered." };
  } catch {
    return { ok: false, checkedAt, code: "CONNECTION_TEST_FAILED", detail: def.health.remediation };
  }
}

/** Scrub a management payload with the deployment secrets before it leaves
 * the Worker (CON-01 redaction pin): views carry no secret values by
 * construction, but caller echoes and remediation copy pass through here. */
export function scrubConnectionPayload<T>(value: T, env: SecretEnv): T {
  return scrubValueWithDeploymentSecrets(value, env);
}
