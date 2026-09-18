// SPDX-License-Identifier: AGPL-3.0
// Capability-based Connection resolution (issue #262, ADR TBD).
//
// Three relationships stay independently modeled:
//
// - Connection assignment — what credentials/configuration an Organization
//   uses for an Integration (src/connections.ts, unchanged);
// - ExternalEntityMapping — what this Organization is called inside Vendor X;
// - CapabilityAssignment — which Connection satisfies a semantic role such
//   as `identity.primary` for one Organization.
//
// Capabilities are opaque dotted strings in v1 (the name is the whole
// contract); Adapters (src/adapters/identity.ts) own the shared operation
// subset per provider. Resolution is Organization-bound and centrally
// authorized here: every lookup is predicated on the Execution's
// Organization context, never a caller-supplied org id, and there is no API
// shape expressing another Organization's capability. Secret values never
// appear on any path in this module — assignments and mappings carry ids,
// names, and presence only.
import { Fault } from "./domain";
import type { Principal, SafeError } from "./domain";
import { integrationById } from "./integrations";
import type { Connection } from "./integrations";
/** Opaque capability names: dotted, 1-128 chars. The name is the whole
 * contract in v1 — no typed operation lattice yet (ADR TBD §1). */
const CAPABILITY_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,126}[A-Za-z0-9]$/;
/** Parse one capability name. Single-dot names (`identity.primary`) and
 * deeper ones (`mail.primary.shared`) both pass; the separator is what
 * makes the role readable, not a namespace registry. */
export function parseCapabilityName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Fault(400, "INVALID_CAPABILITY", "A capability name must be 1 to 128 characters.");
  }
  if (!value.includes(".") || !CAPABILITY_NAME.test(value)) {
    throw new Fault(400, "INVALID_CAPABILITY", "A capability name must be a dotted role such as identity.primary.");
  }
  return value;
}
export interface CapabilityAssignmentView {
  readonly capability: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationName: string;
  readonly enabled: boolean;
  readonly mappingPresent: boolean;
  readonly updatedAt: string;
}
interface AssignmentRow {
  readonly capability: string;
  readonly connection_id: string;
  readonly enabled: number;
  readonly updated_at: string;
}
interface AssignmentConnectionRow {
  readonly id: string;
  readonly org_id: string;
  readonly integration_id: string;
  readonly endpoint: string;
  readonly display_name: string | null;
  readonly enabled: number | null;
  readonly updated_at: string | null;
}
/** Read the Connection row behind an assignment: exact org + row id, never
 * cross-org. A row that moved orgs (or vanished) reads as missing so the
 * resolver fails closed instead of following a stale pointer. */
async function assignmentConnection(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<AssignmentConnectionRow | null> {
  return await db
    .prepare(
      "SELECT id,org_id,integration_id,endpoint,display_name,enabled,updated_at FROM connections WHERE id=? AND org_id=?",
    )
    .bind(connectionId, orgId)
    .first<AssignmentConnectionRow>();
}
/** True when the capability tables exist. Suites on partial migration
 * chains (pre-0038) degrade list/readiness reads to empty; every other D1
 * failure still throws — a missing table is tolerated, never a real error. */
async function hasCapabilityTables(db: D1Database): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='capability_assignments'")
    .first<{ ok: number }>();
  return found !== null;
}
function toConnection(row: AssignmentConnectionRow): Connection {
  return {
    id: row.id,
    integrationId: row.integration_id,
    orgId: row.org_id,
    endpoint: row.endpoint,
    displayName: row.display_name,
    enabled: (row.enabled ?? 1) === 1,
    managedBy: null,
  };
}
/** Bind one capability to this Organization's Connection for an Integration
 * (upsert). The Connection row must already exist for the caller's
 * Organization — this path never creates Connections and never crosses
 * orgs. Disabling a role binding (enabled=false) stops that capability
 * without disabling the Connection itself (ADR TBD §6 correction 2). */
export async function assignCapability(
  db: D1Database,
  caller: Principal,
  capability: string,
  integrationId: string,
  enabled = true,
): Promise<CapabilityAssignmentView> {
  const name = parseCapabilityName(capability);
  const def = integrationById(integrationId);
  if (!def) throw new Fault(404, "UNKNOWN_INTEGRATION", "Unknown Integration id.");
  const connection = await db
    .prepare("SELECT id FROM connections WHERE org_id=? AND integration_id=?")
    .bind(caller.orgId, integrationId)
    .first<{ id: string }>();
  if (!connection) {
    throw new Fault(404, "CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.");
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO capability_assignments(org_id,capability,connection_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(org_id,capability) DO UPDATE SET connection_id=excluded.connection_id,enabled=excluded.enabled,updated_at=excluded.updated_at",
    )
    .bind(caller.orgId, name, connection.id, enabled ? 1 : 0, now, now)
    .run();
  return {
    capability: name,
    connectionId: connection.id,
    integrationId,
    integrationName: def.name,
    enabled,
    mappingPresent: await hasPrimaryMapping(db, caller.orgId, connection.id),
    updatedAt: now,
  };
}
/** Remove one capability binding for the caller's Organization. The
 * Connection row itself is untouched — only the role binding goes. */
export async function removeCapability(db: D1Database, caller: Principal, capability: string): Promise<void> {
  const name = parseCapabilityName(capability);
  const removed = await db
    .prepare("DELETE FROM capability_assignments WHERE org_id=? AND capability=?")
    .bind(caller.orgId, name)
    .run();
  if (removed.meta.changes === 0) {
    throw new Fault(404, "CAPABILITY_NOT_BOUND", "This capability is not bound for this Organization.");
  }
}
/** List this Organization's capability bindings, richest first: every row
 * carries its Integration name plus whether a vendor-entity mapping exists.
 * Rows pointing at unknown Integrations or vanished Connections are
 * skipped: the registry and the org predicate stay authoritative. */
export async function listCapabilities(
  db: D1Database,
  caller: Principal,
): Promise<readonly CapabilityAssignmentView[]> {
  if (!(await hasCapabilityTables(db))) return Object.freeze([]);
  const rows = await db
    .prepare(
      "SELECT capability,connection_id,enabled,updated_at FROM capability_assignments WHERE org_id=? ORDER BY capability",
    )
    .bind(caller.orgId)
    .all<AssignmentRow>();
  const views: CapabilityAssignmentView[] = [];
  for (const row of rows.results) {
    const connection = await assignmentConnection(db, caller.orgId, row.connection_id);
    if (!connection) continue;
    const def = integrationById(connection.integration_id);
    if (!def) continue;
    views.push({
      capability: row.capability,
      connectionId: connection.id,
      integrationId: connection.integration_id,
      integrationName: def.name,
      enabled: row.enabled === 1,
      mappingPresent: await hasPrimaryMapping(db, caller.orgId, connection.id),
      updatedAt: row.updated_at,
    });
  }
  return Object.freeze(views);
}
export interface CapabilityPreview {
  readonly capability: string;
  readonly connection: Connection;
  /** The Connection row's updated_at: the config generation marker frozen
   * into Execution metadata (rotation never moves Connection identity, so
   * identity plus this marker pins what the run bound). */
  readonly connectionUpdatedAt: string | null;
  /** The Integration definition name: Integration source is Git-owned code
   * with no separate revision registry (ADR 003 stable UUID identity), so
   * the name pins which definition the binding resolved through. */
  readonly integrationRevision: string;
  readonly mappingId: string | null;
  readonly mappingVersion: string | null;
}
export type CapabilityResolution =
  | { readonly found: true; readonly preview: CapabilityPreview }
  | { readonly found: false; readonly declared: true; readonly error: SafeError }
  | { readonly found: false; readonly declared: false };
/** Resolve one capability against current assignment state without writing
 * anything: the read half of lazy-on-first-use. Disabled assignments and
 * disabled Connections read as missing — declared capabilities fail loud
 * with 424 INTEGRATION_REQUIREMENT_UNSATISFIED (the ADR 003 declared split
 * extended verbatim), undeclared access resolves to None. */
export async function previewCapability(
  db: D1Database,
  orgId: string,
  capability: string,
  required: readonly string[],
): Promise<CapabilityResolution> {
  const name = parseCapabilityName(capability);
  if (await hasCapabilityTables(db)) {
    const row = await db
      .prepare(
        "SELECT capability,connection_id,enabled,updated_at FROM capability_assignments WHERE org_id=? AND capability=?",
      )
      .bind(orgId, name)
      .first<AssignmentRow>();
    if (row && row.enabled === 1) {
      const connection = await assignmentConnection(db, orgId, row.connection_id);
      if (connection && (connection.enabled ?? 1) === 1) {
        const def = integrationById(connection.integration_id);
        if (def) {
          const mapping = await primaryMapping(db, orgId, connection.id);
          return {
            found: true,
            preview: {
              capability: name,
              connection: toConnection(connection),
              connectionUpdatedAt: connection.updated_at,
              integrationRevision: def.name,
              mappingId: mapping?.id ?? null,
              mappingVersion: mapping?.updated_at ?? null,
            },
          };
        }
      }
    }
  }
  if (required.includes(name)) {
    return {
      found: false,
      declared: true,
      error: {
        code: "INTEGRATION_REQUIREMENT_UNSATISFIED",
        message: "This Saga requires a capability binding that is not configured for this Organization.",
      },
    };
  }
  return { found: false, declared: false };
}
export interface FrozenCapabilityBinding {
  readonly capability: string;
  readonly connectionId: string;
  /** The directory endpoint value bound at first use: the running Execution
   * executes against exactly this value. A later endpoint edit fails the
   * run closed instead of executing against un-audited config, while
   * lifecycle toggles (enabled) and secret rotation leave it untouched. */
  readonly endpoint: string;
  readonly integrationId: string;
  readonly connectionUpdatedAt: string | null;
  readonly integrationRevision: string;
  readonly adapterId: string;
  readonly adapterRevision: string;
  readonly transport: string;
  readonly mappingId: string | null;
  readonly mappingVersion: string | null;
  readonly operation: string;
  readonly resolvedAt: string;
}
interface FrozenRow {
  readonly capability: string;
  readonly connection_id: string;
  readonly endpoint: string;
  readonly integration_id: string;
  readonly connection_updated_at: string | null;
  readonly integration_revision: string;
  readonly adapter_id: string;
  readonly adapter_revision: string;
  readonly transport: string;
  readonly mapping_id: string | null;
  readonly mapping_version: string | null;
  readonly operation: string;
  readonly resolved_at: string;
}
function toFrozen(row: FrozenRow): FrozenCapabilityBinding {
  return {
    capability: row.capability,
    connectionId: row.connection_id,
    endpoint: row.endpoint,
    integrationId: row.integration_id,
    connectionUpdatedAt: row.connection_updated_at,
    integrationRevision: row.integration_revision,
    adapterId: row.adapter_id,
    adapterRevision: row.adapter_revision,
    transport: row.transport,
    mappingId: row.mapping_id,
    mappingVersion: row.mapping_version,
    operation: row.operation,
    resolvedAt: row.resolved_at,
  };
}
/** Read the frozen binding for one (Execution, capability), if the run
 * already bound it. Frozen rows are never re-resolved: a running Execution
 * is unaffected by later assignment edits, and auditors replay these rows
 * — not current state — to answer what touched a customer environment. */
export async function loadFrozenBinding(
  db: D1Database,
  executionId: string,
  capability: string,
): Promise<FrozenCapabilityBinding | null> {
  try {
    const row = await db
      .prepare(
        "SELECT capability,connection_id,endpoint,integration_id,connection_updated_at,integration_revision,adapter_id,adapter_revision,transport,mapping_id,mapping_version,operation,resolved_at FROM capability_resolutions WHERE execution_id=? AND capability=?",
      )
      .bind(executionId, capability)
      .first<FrozenRow>();
    return row ? toFrozen(row) : null;
  } catch {
    return null;
  }
}
/** Freeze one first-use resolution: append-only (INSERT OR IGNORE), never
 * updated in place. A concurrent first-use race converges on the first
 * writer; the loser re-reads. Secret values are never part of the record. */
export async function freezeBinding(
  db: D1Database,
  executionId: string,
  preview: CapabilityPreview,
  adapter: { readonly id: string; readonly revision: string; readonly transport: string },
  operation: string,
): Promise<FrozenCapabilityBinding> {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO capability_resolutions(execution_id,capability,connection_id,endpoint,integration_id,connection_updated_at,integration_revision,adapter_id,adapter_revision,transport,mapping_id,mapping_version,operation,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(execution_id,capability) DO NOTHING",
    )
    .bind(
      executionId,
      preview.capability,
      preview.connection.id,
      preview.connection.endpoint,
      preview.connection.integrationId,
      preview.connectionUpdatedAt,
      preview.integrationRevision,
      adapter.id,
      adapter.revision,
      adapter.transport,
      preview.mappingId,
      preview.mappingVersion,
      operation,
      now,
    )
    .run();
  const frozen = await loadFrozenBinding(db, executionId, preview.capability);
  if (!frozen) throw new Fault(500, "CAPABILITY_BINDING_FAILED", "The capability binding could not be recorded.");
  return frozen;
}
/** List every frozen binding for one Execution, oldest first: the audit
 * answer to "what actually touched this customer environment". Pre-0038
 * stores degrade to an empty list. */
export async function listExecutionBindings(
  db: D1Database,
  executionId: string,
): Promise<readonly FrozenCapabilityBinding[]> {
  try {
    const found = await db
      .prepare(
        "SELECT capability,connection_id,endpoint,integration_id,connection_updated_at,integration_revision,adapter_id,adapter_revision,transport,mapping_id,mapping_version,operation,resolved_at FROM capability_resolutions WHERE execution_id=? ORDER BY capability",
      )
      .bind(executionId)
      .all<FrozenRow>();
    return Object.freeze(found.results.map(toFrozen));
  } catch {
    return Object.freeze([]);
  }
}
export interface EntityMappingView {
  readonly id: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly entityId: string;
  readonly displayName: string | null;
  readonly primary: boolean;
  readonly source: "manual" | "sync";
  readonly updatedAt: string;
}
interface MappingRow {
  readonly id: string;
  readonly connection_id: string;
  readonly entity_id: string;
  readonly display_name: string | null;
  readonly is_primary: number;
  readonly source: string;
  readonly updated_at: string;
}
function toMappingView(row: MappingRow, integrationId: string): EntityMappingView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    integrationId,
    entityId: row.entity_id,
    displayName: row.display_name,
    primary: row.is_primary === 1,
    source: row.source === "sync" ? "sync" : "manual",
    updatedAt: row.updated_at,
  };
}
async function hasPrimaryMapping(db: D1Database, orgId: string, connectionId: string): Promise<boolean> {
  try {
    const found = await db
      .prepare("SELECT 1 AS ok FROM external_entity_mappings WHERE org_id=? AND connection_id=? AND is_primary=1")
      .bind(orgId, connectionId)
      .first<{ ok: number }>();
    return found !== null;
  } catch {
    return false;
  }
}
async function primaryMapping(db: D1Database, orgId: string, connectionId: string): Promise<MappingRow | null> {
  try {
    return await db
      .prepare(
        "SELECT id,connection_id,entity_id,display_name,is_primary,source,updated_at FROM external_entity_mappings WHERE org_id=? AND connection_id=? AND is_primary=1",
      )
      .bind(orgId, connectionId)
      .first<MappingRow>();
  } catch {
    return null;
  }
}
export interface MappingWrite {
  readonly entityId?: unknown;
  readonly displayName?: unknown;
  readonly primary?: unknown;
  readonly source?: unknown;
}
function parseEntityId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Fault(400, "INVALID_MAPPING", "A mapping entityId must be 1 to 256 characters.");
  }
  return value;
}
function parseMappingDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Fault(400, "INVALID_MAPPING", "A mapping displayName must be 1 to 256 characters when provided.");
  }
  return value;
}
function parseMappingSource(value: unknown): "manual" | "sync" {
  if (value === undefined) return "manual";
  if (value === "manual" || value === "sync") return value;
  throw new Fault(400, "INVALID_MAPPING", "A mapping source must be manual or sync.");
}
/** Upsert the vendor-entity mapping for this Organization's Connection:
 * what the org/customer/resource is called inside Vendor X. The Connection
 * says how to authenticate, the mapping says which vendor-side entity —
 * separate rows, separate failures. Setting primary clears the flag on
 * sibling rows so exactly one primary stands per (Organization,
 * Connection); one-to-many vendor entities stay as non-primary siblings
 * (the NinjaOne supplemental-entity precedent). */
export async function upsertMapping(
  db: D1Database,
  caller: Principal,
  integrationId: string,
  body: MappingWrite,
): Promise<EntityMappingView> {
  const def = integrationById(integrationId);
  if (!def) throw new Fault(404, "UNKNOWN_INTEGRATION", "Unknown Integration id.");
  const connection = await db
    .prepare("SELECT id FROM connections WHERE org_id=? AND integration_id=?")
    .bind(caller.orgId, integrationId)
    .first<{ id: string }>();
  if (!connection) {
    throw new Fault(404, "CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.");
  }
  const entityId = parseEntityId(body.entityId);
  const displayName = parseMappingDisplayName(body.displayName);
  const source = parseMappingSource(body.source);
  const primary = body.primary === undefined ? false : body.primary === true;
  if (body.primary !== undefined && body.primary !== true && body.primary !== false) {
    throw new Fault(400, "INVALID_MAPPING", "A mapping primary flag must be true or false when provided.");
  }
  const now = new Date().toISOString();
  const existing = await db
    .prepare("SELECT id FROM external_entity_mappings WHERE org_id=? AND connection_id=? AND entity_id=?")
    .bind(caller.orgId, connection.id, entityId)
    .first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO external_entity_mappings(id,org_id,connection_id,entity_id,display_name,is_primary,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,is_primary=excluded.is_primary,source=excluded.source,updated_at=excluded.updated_at",
    )
    .bind(id, caller.orgId, connection.id, entityId, displayName, primary ? 1 : 0, source, now, now)
    .run();
  if (primary) {
    await db
      .prepare("UPDATE external_entity_mappings SET is_primary=0 WHERE org_id=? AND connection_id=? AND id<>?")
      .bind(caller.orgId, connection.id, id)
      .run();
  }
  const row = await db
    .prepare(
      "SELECT id,connection_id,entity_id,display_name,is_primary,source,updated_at FROM external_entity_mappings WHERE id=?",
    )
    .bind(id)
    .first<MappingRow>();
  if (!row) throw new Fault(500, "MAPPING_NOT_READABLE", "The mapping could not be read after write.");
  return toMappingView(row, integrationId);
}
/** List this Organization's vendor-entity mappings for one Integration. */
export async function listMappings(
  db: D1Database,
  caller: Principal,
  integrationId: string,
): Promise<readonly EntityMappingView[]> {
  const def = integrationById(integrationId);
  if (!def) throw new Fault(404, "UNKNOWN_INTEGRATION", "Unknown Integration id.");
  try {
    const found = await db
      .prepare(
        "SELECT m.id,m.connection_id,m.entity_id,m.display_name,m.is_primary,m.source,m.updated_at FROM external_entity_mappings m JOIN connections c ON c.id=m.connection_id WHERE m.org_id=? AND c.integration_id=? ORDER BY m.entity_id",
      )
      .bind(caller.orgId, integrationId)
      .all<MappingRow>();
    return Object.freeze(found.results.map((row) => toMappingView(row, integrationId)));
  } catch {
    return Object.freeze([]);
  }
}
/** Delete one vendor-entity mapping for the caller's Organization. */
export async function deleteMapping(db: D1Database, caller: Principal, mappingId: string): Promise<void> {
  const removed = await db
    .prepare("DELETE FROM external_entity_mappings WHERE id=? AND org_id=?")
    .bind(mappingId, caller.orgId)
    .run();
  if (removed.meta.changes === 0) {
    throw new Fault(404, "MAPPING_NOT_FOUND", "No mapping exists for this Organization and id.");
  }
}
export interface CapabilityReadiness {
  readonly capability: string;
  readonly bound: boolean;
  readonly enabled: boolean;
  readonly connectionId: string | null;
  readonly integrationId: string | null;
  readonly integrationName: string | null;
  readonly mappingPresent: boolean;
  /** Presence booleans plus blockers, secret-safe (the
   * check_integration_readiness.py shape): ids and names only, never
   * credential values, never raw scope identifiers. */
  readonly blockers: readonly string[];
}
/** Readiness for every capability binding in this Organization: which
 * semantic roles resolve, which are disabled or dangling, and what blocks
 * each one. Read-only by construction. */
export async function checkReadiness(db: D1Database, caller: Principal): Promise<readonly CapabilityReadiness[]> {
  if (!(await hasCapabilityTables(db))) return Object.freeze([]);
  const rows = await db
    .prepare("SELECT capability,connection_id,enabled FROM capability_assignments WHERE org_id=? ORDER BY capability")
    .bind(caller.orgId)
    .all<AssignmentRow>();
  const report: CapabilityReadiness[] = [];
  for (const row of rows.results) {
    const blockers: string[] = [];
    const connection = await assignmentConnection(db, caller.orgId, row.connection_id);
    if (!connection) {
      blockers.push("connection-missing");
    } else if ((connection.enabled ?? 1) === 0) {
      blockers.push("connection-disabled");
    }
    if (row.enabled === 0) blockers.push("binding-disabled");
    const def = connection ? integrationById(connection.integration_id) : undefined;
    if (connection && !def) blockers.push("integration-unknown");
    const mappingPresent = connection ? await hasPrimaryMapping(db, caller.orgId, connection.id) : false;
    if (connection && def && row.enabled === 1 && (connection.enabled ?? 1) === 1 && !mappingPresent) {
      blockers.push("mapping-missing");
    }
    report.push({
      capability: row.capability,
      bound: blockers.length === 0,
      enabled: row.enabled === 1,
      connectionId: connection?.id ?? null,
      integrationId: connection?.integration_id ?? null,
      integrationName: def?.name ?? null,
      mappingPresent,
      blockers: Object.freeze(blockers),
    });
  }
  return Object.freeze(report);
}
