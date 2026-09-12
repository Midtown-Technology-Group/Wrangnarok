// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170): opt-in Saga tool registry.
//
// Curated tools are the stable business-semantics layer from ADR 022: named,
// Organization-owned capabilities that survive ordinary source edits. A Saga
// becomes a tool only through an explicit enrollment row — the static Saga
// catalog never implies tool exposure, so discovery and execution share one
// gate: disabled rows and stale (unknown/revision-mismatched) rows vanish
// from both paths identically.
//
// Storage: D1 `tool_enrollments` (migration 0024). Every row carries the
// stable Saga identity (id + revision) plus the collision-safe tool name;
// the name is namespaced per Saga at enrollment time, so two Sagas can never
// collide on one name and a renamed tool never hijacks callers.
import { Fault, UUID } from "./domain";
import type { Principal } from "./domain";

export const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const TOOL_DESCRIPTION_MAX = 280;

/** One D1 tool enrollment row (migration 0024). */
export interface ToolEnrollmentRow {
  readonly id: string;
  readonly org_id: string;
  readonly tool_name: string;
  readonly saga_id: string;
  readonly saga_revision: string;
  readonly description: string | null;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Tool discovery shape: stable identity plus the derived invocation schema. */
export interface ToolDescriptor {
  readonly name: string;
  readonly sagaId: string;
  readonly sagaRevision: string;
  /** Distinctive description: stable Saga text plus the tool-name prefix so
   * model callers can tell same-Saga tools apart without guessing. */
  readonly description: string;
  readonly inputSchema: { readonly type: "object" };
  readonly enabled: boolean;
}

export interface ToolCatalogSaga {
  readonly id: string;
  readonly revision: string;
  readonly description: string;
}

export interface ToolRegistry {
  /** Collision-safe tool name derived from the Saga name: lowercase slug,
   * non-alphanumerics folded to underscores, namespaced per Saga. */
  toolNameFor(sagaName: string): string;
  /** Enroll one Saga as a tool for the caller's Organization. */
  enroll(
    db: D1Database,
    caller: Principal,
    saga: { readonly id: string; readonly name: string; readonly revision: string; readonly description: string },
    body: unknown,
  ): Promise<ToolDescriptor>;
  /** List this Organization's live tools: enabled rows whose Saga still
   * exists at the enrolled revision. Disabled and stale rows are omitted
   * from discovery AND execution identically. */
  list(db: D1Database, caller: Principal, catalog: readonly ToolCatalogSaga[]): Promise<readonly ToolDescriptor[]>;
  /** Resolve one tool name for execution through the identical gate as
   * discovery: unknown, foreign-org, disabled, and stale names fail here. */
  resolve(
    db: D1Database,
    caller: Principal,
    toolName: string,
    catalog: readonly ToolCatalogSaga[],
  ): Promise<ToolDescriptor>;
  /** Disable (never delete: the row is the audit trail) one enrollment. */
  disable(db: D1Database, caller: Principal, toolName: string): Promise<ToolDescriptor>;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function parseToolName(value: unknown): string {
  if (typeof value !== "string" || !TOOL_NAME.test(value)) {
    throw invalid(
      "INVALID_TOOL",
      "Provide a tool name of 3-64 chars: lowercase letter first, letters/digits/underscores after.",
    );
  }
  return value;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > TOOL_DESCRIPTION_MAX) {
    throw invalid("INVALID_TOOL", "Tool description must be 1-280 chars when provided.");
  }
  return value;
}

function parseBody(body: unknown): { name?: string; description: string | null } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("INVALID_TOOL", "Provide a tool name and optional description.");
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "name" && key !== "description")) {
    throw invalid("INVALID_TOOL", "Only name and description may be set on a tool enrollment.");
  }
  const out: { name?: string; description: string | null } = { description: parseDescription(record.description) };
  if (record.name !== undefined) out.name = parseToolName(record.name);
  return out;
}

/** Describe one live enrollment row against the static catalog. Pure. The
 * tool name comes from the row (collision-safe at enrollment); the
 * description blends the row name with Saga text. */
function describe(
  row: ToolEnrollmentRow,
  saga: { readonly revision: string; readonly description: string },
): ToolDescriptor {
  const custom = row.description ?? saga.description;
  return Object.freeze({
    name: row.tool_name,
    sagaId: row.saga_id,
    sagaRevision: row.saga_revision,
    description: `[${row.tool_name}] ${custom}`,
    inputSchema: Object.freeze({ type: "object" as const }),
    enabled: row.enabled === 1,
  });
}

async function ownedRow(db: D1Database, orgId: string, toolName: string): Promise<ToolEnrollmentRow | null> {
  try {
    return await db
      .prepare(
        "SELECT id,org_id,tool_name,saga_id,saga_revision,description,enabled,created_at,updated_at FROM tool_enrollments WHERE org_id=? AND tool_name=?",
      )
      .bind(orgId, toolName)
      .first<ToolEnrollmentRow>();
  } catch {
    // Pre-migration databases (no tool_enrollments table): no tools exist.
    return null;
  }
}

async function listRows(db: D1Database, orgId: string): Promise<readonly ToolEnrollmentRow[]> {
  try {
    const rows = await db
      .prepare(
        "SELECT id,org_id,tool_name,saga_id,saga_revision,description,enabled,created_at,updated_at FROM tool_enrollments WHERE org_id=? ORDER BY tool_name",
      )
      .bind(orgId)
      .all<ToolEnrollmentRow>();
    return rows.results;
  } catch {
    // Pre-migration databases (no tool_enrollments table): no tools exist.
    return [];
  }
}

function toolNameFor(sagaName: string): string {
  const slug = sagaName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const stem = /^[a-z]/.test(slug) ? slug : `saga_${slug}`;
  return `${stem}_tool`.slice(0, 64);
}

export const toolRegistry: ToolRegistry = {
  toolNameFor,

  async enroll(db, caller, saga, body) {
    if (!UUID.test(saga.id)) throw invalid("UNKNOWN_SAGA", "Unknown Saga id.", 404);
    const parsed = parseBody(body);
    const name = parsed.name ?? toolNameFor(saga.name);
    const existing = await ownedRow(db, caller.orgId, name);
    if (existing) {
      if (existing.saga_id === saga.id && existing.saga_revision === saga.revision && existing.enabled === 1)
        throw invalid("TOOL_EXISTS", `Tool "${name}" is already enrolled for this Organization.`, 409);
      throw invalid("TOOL_EXISTS", `Tool name "${name}" is already taken for this Organization.`, 409);
    }
    const now = new Date().toISOString();
    try {
      await db
        .prepare(
          "INSERT INTO tool_enrollments(id,org_id,tool_name,saga_id,saga_revision,description,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)",
        )
        .bind(
          crypto.randomUUID().toLowerCase(),
          caller.orgId,
          name,
          saga.id,
          saga.revision,
          parsed.description,
          now,
          now,
        )
        .run();
    } catch {
      throw invalid("TOOL_STORE_NOT_MIGRATED", "Tool enrollments are not migrated on this database.", 503);
    }
    const row = await ownedRow(db, caller.orgId, name);
    if (!row) throw invalid("TOOL_NOT_FOUND", "The tool could not be read after enroll.", 500);
    return describe(row, saga);
  },

  async list(db, caller, catalog) {
    const rows = await listRows(db, caller.orgId);
    const tools: ToolDescriptor[] = [];
    for (const row of rows) {
      // One lookup gates everything: disabled rows, unknown Sagas, and
      // stale revisions vanish from discovery and execution identically.
      if (row.enabled === 0) continue;
      const saga = catalog.find((entry) => entry.id === row.saga_id);
      if (!saga || saga.revision !== row.saga_revision) continue;
      tools.push(describe(row, saga));
    }
    return Object.freeze(tools);
  },

  async resolve(db, caller, toolName, catalog) {
    if (!TOOL_NAME.test(toolName)) throw invalid("TOOL_NOT_FOUND", "Unknown tool.", 404);
    const row = await ownedRow(db, caller.orgId, toolName);
    // Foreign-Organization and unknown names answer identically: 404, never a leak.
    if (!row) throw invalid("TOOL_NOT_FOUND", "Unknown tool.", 404);
    if (row.enabled === 0) throw invalid("TOOL_DISABLED", `Tool "${toolName}" is disabled.`, 404);
    const saga = catalog.find((entry) => entry.id === row.saga_id);
    if (!saga || saga.revision !== row.saga_revision) {
      throw invalid(
        "TOOL_STALE",
        `Tool "${toolName}" names a Saga revision that is no longer current; re-enroll it.`,
        409,
      );
    }
    return describe(row, saga);
  },

  async disable(db, caller, toolName) {
    if (!TOOL_NAME.test(toolName)) throw invalid("TOOL_NOT_FOUND", "Unknown tool.", 404);
    const row = await ownedRow(db, caller.orgId, toolName);
    if (!row) throw invalid("TOOL_NOT_FOUND", "Unknown tool.", 404);
    if (row.enabled === 0) throw invalid("TOOL_DISABLED", `Tool "${toolName}" is already disabled.`, 409);
    const now = new Date().toISOString();
    await db
      .prepare("UPDATE tool_enrollments SET enabled=0,updated_at=? WHERE org_id=? AND tool_name=?")
      .bind(now, caller.orgId, toolName)
      .run();
    const next = await ownedRow(db, caller.orgId, toolName);
    if (!next) throw invalid("TOOL_NOT_FOUND", "The tool could not be read after disable.", 500);
    return {
      ...describe(next, { revision: next.saga_revision, description: next.description ?? "" }),
      enabled: false as const,
    };
  },
};
