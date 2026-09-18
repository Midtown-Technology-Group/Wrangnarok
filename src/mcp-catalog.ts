// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171): per-Connection tool catalog with verbatim schemas
// and drift-tolerant sync (`catalog_sync.py` pins in docs/upstream-spec.md
// §23, namespace policy P0 D4).
//
// Naming: LLM-visible names are `mcp__<connectionId>__<tool>` with a
// UUID-validated Connection segment. Malformed names parse to null — they
// route elsewhere, never error — so MCP names stay disjoint from native
// tool names by construction. Descriptions prefer the vendor schema text
// with a generated fallback; argument schemas accept `inputSchema` or
// `input_schema`, else an empty object.
//
// Drift: sync always runs over the service token (catalog is per-Connection,
// never per-user). New tools arrive enabled; vanished tools are flagged
// disabled with a timestamped reason — never deleted, so schemas and agent
// bindings survive; vendor-restored tools auto-re-enable only when the
// previous reason was auto-removal, while manual admin disables survive
// every sync.
import { Fault, UUID } from "./domain";
import type { Principal } from "./domain";

const DESCRIPTION_MAX = 1024;
const SCHEMA_JSON_MAX = 16384;
const QUALIFIED_PREFIX = "mcp__";
/** Vendor tool names: the inbound TOOL_NAME shape plus dashes and dots,
 * which external MCP servers use freely. */
const VENDOR_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const AUTO_REMOVED_PREFIX = "Removed from server catalog at ";
const MANUAL_DISABLE_REASON = "Manually disabled by admin";

/** One discovered vendor tool: name plus its verbatim schema document. */
export interface DiscoveredMcpTool {
  readonly name: string;
  readonly description?: unknown;
  readonly inputSchema?: unknown;
}

/** One D1 catalog row (migration 0041). Schemas persist verbatim. */
export interface McpCatalogRow {
  readonly connection_id: string;
  readonly tool_name: string;
  readonly description: string | null;
  readonly schema_json: string;
  readonly enabled: number;
  readonly auto_disabled_reason: string | null;
  readonly synced_at: string;
  readonly updated_at: string;
}

export interface McpCatalogView {
  readonly connectionId: string;
  readonly toolName: string;
  readonly qualifiedName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly enabled: boolean;
  readonly autoDisabledReason: string | null;
  readonly syncedAt: string;
  readonly updatedAt: string;
}

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return details === undefined ? new Fault(status, code, message) : new Fault(status, code, message, details);
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

/** Qualify one vendor tool name for a Connection. The Connection id segment
 * is a UUID by construction, so qualified names never collide with native
 * tool names. Pure. */
export function qualifiedMcpToolName(connectionId: string, toolName: string): string {
  return `${QUALIFIED_PREFIX}${connectionId.toLowerCase()}__${toolName}`;
}

/** Parse a qualified name back into (connectionId, tool). Returns null for
 * anything malformed — including a non-UUID Connection segment — so
 * malformed names route elsewhere instead of erroring. Pure. */
export function parseQualifiedMcpToolName(
  value: string,
): { readonly connectionId: string; readonly tool: string } | null {
  if (!value.startsWith(QUALIFIED_PREFIX)) return null;
  const rest = value.slice(QUALIFIED_PREFIX.length);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  const connectionId = rest.slice(0, split).toLowerCase();
  const tool = rest.slice(split + 2);
  if (!UUID.test(connectionId) || !VENDOR_TOOL_NAME.test(tool)) return null;
  return { connectionId, tool };
}

/** Vendor description with the generated fallback. Pure. */
export function mcpToolDescription(toolName: string, description: unknown): string {
  if (typeof description === "string" && description.trim().length > 0) {
    return description.trim().slice(0, DESCRIPTION_MAX);
  }
  return `External MCP tool ${toolName}.`;
}

/** Vendor argument schema: `inputSchema` preferred, `input_schema`
 * accepted, empty object otherwise. Persisted verbatim (never normalized
 * beyond the key choice), re-emitted to planners as-is. Pure. */
export function normalizeMcpInputSchema(tool: {
  readonly inputSchema?: unknown;
  readonly input_schema?: unknown;
}): unknown {
  if (tool.inputSchema !== undefined && tool.inputSchema !== null) return tool.inputSchema;
  const legacy = (tool as { readonly input_schema?: unknown }).input_schema;
  if (legacy !== undefined && legacy !== null) return legacy;
  return Object.freeze({ type: "object" });
}

function parseVendorTool(tool: unknown): DiscoveredMcpTool {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    throw invalid("MCP_CATALOG_INVALID", "Discovered tools must be objects with a name.");
  }
  const record = tool as Record<string, unknown>;
  if (typeof record.name !== "string" || !VENDOR_TOOL_NAME.test(record.name)) {
    throw invalid("MCP_CATALOG_INVALID", "Discovered tool names must be 1-128 chars: letter first.");
  }
  return Object.freeze({
    name: record.name,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.inputSchema === undefined ? {} : { inputSchema: record.inputSchema }),
    ...((record as { input_schema?: unknown }).input_schema === undefined
      ? {}
      : { inputSchema: (record as { input_schema?: unknown }).input_schema }),
  });
}

/** Parse one tools/list payload into discovered tools. Unknown entries fail
 * the whole sync loud (never a partial catalog); transport envelopes are
 * the dispatch layer's job, not this one. Pure. */
export function parseDiscoveredTools(payload: unknown): readonly DiscoveredMcpTool[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("MCP_CATALOG_INVALID", "The vendor tool list was unreadable.");
  }
  const tools = (payload as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) throw invalid("MCP_CATALOG_INVALID", "The vendor tool list was unreadable.");
  const seen = new Set<string>();
  const out: DiscoveredMcpTool[] = [];
  for (const entry of tools) {
    const parsed = parseVendorTool(entry);
    if (seen.has(parsed.name)) throw invalid("MCP_CATALOG_INVALID", `The vendor listed "${parsed.name}" twice.`);
    seen.add(parsed.name);
    out.push(parsed);
  }
  return Object.freeze(out);
}

export interface CatalogSyncPlan {
  /** Rows to insert (new tools, enabled). */
  readonly insert: readonly McpCatalogRow[];
  /** Rows to auto-disable with a timestamped reason (vanished tools). */
  readonly autoDisable: readonly { readonly toolName: string; readonly reason: string }[];
  /** Rows to restore (vendor-returned tools whose previous reason was
   * auto-removal). Manual disables are absent here by construction. */
  readonly restore: readonly { readonly toolName: string }[];
}

/** Plan one catalog sync from existing rows plus freshly discovered tools.
 * Pure: the store applies the plan, this only decides. Manual disables
 * survive (absent from every list); auto-removed rows restore on return. */
export function planCatalogSync(
  existing: readonly McpCatalogRow[],
  discovered: readonly DiscoveredMcpTool[],
  connectionId: string,
  now: string,
): CatalogSyncPlan {
  const found = new Set(discovered.map((tool) => tool.name));
  const known = new Map(existing.map((row) => [row.tool_name, row]));
  const insert: McpCatalogRow[] = [];
  const autoDisable: { readonly toolName: string; readonly reason: string }[] = [];
  const restore: { readonly toolName: string }[] = [];
  for (const tool of discovered) {
    const current = known.get(tool.name);
    if (!current) {
      const description = mcpToolDescription(tool.name, tool.description);
      const schema = normalizeMcpInputSchema(tool);
      insert.push({
        connection_id: connectionId,
        tool_name: tool.name,
        description,
        schema_json: JSON.stringify(schema).slice(0, SCHEMA_JSON_MAX),
        enabled: 1,
        auto_disabled_reason: null,
        synced_at: now,
        updated_at: now,
      });
    } else if (
      current.enabled === 0 &&
      current.auto_disabled_reason !== null &&
      current.auto_disabled_reason.startsWith(AUTO_REMOVED_PREFIX)
    ) {
      // Vendor-restored tools auto-re-enable only after auto-removal.
      // Manual admin disables carry a different reason and survive.
      restore.push({ toolName: tool.name });
    }
  }
  for (const row of existing) {
    if (!found.has(row.tool_name) && row.enabled === 1) {
      autoDisable.push({ toolName: row.tool_name, reason: `${AUTO_REMOVED_PREFIX}${now}` });
    }
  }
  return Object.freeze({
    insert: Object.freeze(insert),
    autoDisable: Object.freeze(autoDisable),
    restore: Object.freeze(restore),
  });
}

function toView(row: McpCatalogRow): McpCatalogView {
  let inputSchema: unknown;
  try {
    inputSchema = JSON.parse(row.schema_json) as unknown;
  } catch {
    inputSchema = Object.freeze({ type: "object" });
  }
  return Object.freeze({
    connectionId: row.connection_id,
    toolName: row.tool_name,
    qualifiedName: qualifiedMcpToolName(row.connection_id, row.tool_name),
    description: row.description ?? mcpToolDescription(row.tool_name, null),
    inputSchema,
    enabled: row.enabled === 1,
    autoDisabledReason: row.auto_disabled_reason,
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
  });
}

async function connectionOwned(db: D1Database, orgId: string, connectionId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT id FROM mcp_connections WHERE org_id=? AND id=?")
      .bind(orgId, connectionId)
      .first<{ id: string }>();
    return row !== null;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

async function rowsFor(db: D1Database, connectionId: string): Promise<readonly McpCatalogRow[]> {
  try {
    const rows = await db
      .prepare(
        "SELECT connection_id,tool_name,description,schema_json,enabled,auto_disabled_reason,synced_at,updated_at FROM mcp_tool_catalog WHERE connection_id=? ORDER BY tool_name",
      )
      .bind(connectionId)
      .all<McpCatalogRow>();
    return rows.results;
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** List one owned Connection's catalog. Foreign Connections answer 404. */
export async function listMcpCatalog(
  db: D1Database,
  caller: Principal,
  connectionId: string,
): Promise<readonly McpCatalogView[]> {
  if (!UUID.test(connectionId)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  if (!(await connectionOwned(db, caller.orgId, connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  return Object.freeze((await rowsFor(db, connectionId)).map(toView));
}

/** Resolve one catalog row for dispatch through the identical gate as
 * discovery: unknown tools 404, disabled tools 404 with the reason so the
 * caller learns whether sync or an admin owns the denial. */
export async function resolveMcpCatalogTool(
  db: D1Database,
  caller: Principal,
  connectionId: string,
  toolName: string,
): Promise<McpCatalogView> {
  if (!UUID.test(connectionId)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  if (!(await connectionOwned(db, caller.orgId, connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  if (!VENDOR_TOOL_NAME.test(toolName)) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
  let row: McpCatalogRow | null;
  try {
    row = await db
      .prepare(
        "SELECT connection_id,tool_name,description,schema_json,enabled,auto_disabled_reason,synced_at,updated_at FROM mcp_tool_catalog WHERE connection_id=? AND tool_name=?",
      )
      .bind(connectionId, toolName)
      .first<McpCatalogRow>();
  } catch (error) {
    if (isMissingTable(error)) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
    throw error;
  }
  // Hidden tools deny exactly like unknown ones at the code level; the
  // message names the denial so operators can tell drift from absence.
  if (!row) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
  if (row.enabled === 0) {
    throw invalid(
      "MCP_TOOL_DISABLED",
      row.auto_disabled_reason ?? "This MCP tool is disabled.",
      404,
      row.auto_disabled_reason === null ? undefined : { reason: row.auto_disabled_reason },
    );
  }
  return toView(row);
}

/** Toggle one catalog row. Disabling records the manual reason so sync
 * never auto-re-enables it; re-enabling clears every auto-disable marker. */
export async function setMcpCatalogToolEnabled(
  db: D1Database,
  caller: Principal,
  connectionId: string,
  toolName: string,
  enabled: boolean,
): Promise<McpCatalogView> {
  if (!UUID.test(connectionId)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  if (!(await connectionOwned(db, caller.orgId, connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  if (!VENDOR_TOOL_NAME.test(toolName)) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
  if (typeof enabled !== "boolean") throw invalid("MCP_CATALOG_INVALID", "enabled must be true or false.");
  const now = new Date().toISOString();
  let changed: D1Result;
  try {
    changed = await db
      .prepare(
        "UPDATE mcp_tool_catalog SET enabled=?,auto_disabled_reason=?,updated_at=? WHERE connection_id=? AND tool_name=?",
      )
      .bind(enabled ? 1 : 0, enabled ? null : MANUAL_DISABLE_REASON, now, connectionId, toolName)
      .run();
  } catch (error) {
    if (isMissingTable(error)) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
    throw error;
  }
  if (changed.meta.changes === 0) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
  return resolveMcpCatalogTool(db, caller, connectionId, toolName).catch((error) => {
    // Re-enabled rows always resolve; a just-disabled row reports through
    // the view instead of the dispatch denial.
    if (error instanceof Fault && error.code === "MCP_TOOL_DISABLED") {
      return listMcpCatalog(db, caller, connectionId).then((rows) => {
        const view = rows.find((row) => row.toolName === toolName);
        if (!view) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
        return view;
      });
    }
    throw error;
  });
}

/** Apply one vendor tools/list payload to the catalog: insert arrivals,
 * auto-disable vanished rows with a timestamped reason, restore
 * vendor-returned auto-removals. Manual disables survive untouched. */
export async function syncMcpCatalog(
  db: D1Database,
  caller: Principal,
  connectionId: string,
  payload: unknown,
  now = new Date().toISOString(),
): Promise<{ readonly total: number; readonly enabled: number; readonly disabled: number }> {
  if (!UUID.test(connectionId)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  if (!(await connectionOwned(db, caller.orgId, connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  const discovered = parseDiscoveredTools(payload);
  const existing = await rowsFor(db, connectionId);
  const plan = planCatalogSync(existing, discovered, connectionId, now);
  const statements: D1PreparedStatement[] = [];
  for (const row of plan.insert) {
    statements.push(
      db
        .prepare(
          "INSERT INTO mcp_tool_catalog(connection_id,tool_name,description,schema_json,enabled,auto_disabled_reason,synced_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          row.connection_id,
          row.tool_name,
          row.description,
          row.schema_json,
          row.enabled,
          row.auto_disabled_reason,
          row.synced_at,
          row.updated_at,
        ),
    );
  }
  for (const entry of plan.autoDisable) {
    statements.push(
      db
        .prepare(
          "UPDATE mcp_tool_catalog SET enabled=0,auto_disabled_reason=?,updated_at=? WHERE connection_id=? AND tool_name=?",
        )
        .bind(entry.reason, now, connectionId, entry.toolName),
    );
  }
  for (const entry of plan.restore) {
    statements.push(
      db
        .prepare(
          "UPDATE mcp_tool_catalog SET enabled=1,auto_disabled_reason=NULL,synced_at=?,updated_at=? WHERE connection_id=? AND tool_name=?",
        )
        .bind(now, now, connectionId, entry.toolName),
    );
  }
  // Touch every surviving row's sync stamp so operators see the last
  // successful refresh even when nothing changed.
  statements.push(db.prepare("UPDATE mcp_tool_catalog SET synced_at=? WHERE connection_id=?").bind(now, connectionId));
  try {
    await db.batch(statements);
  } catch (error) {
    if (isMissingTable(error)) throw invalid("MCP_TOOL_UNKNOWN", "Unknown MCP tool.", 404);
    throw error;
  }
  const next = await rowsFor(db, connectionId);
  return Object.freeze({
    total: next.length,
    enabled: next.filter((row) => row.enabled === 1).length,
    disabled: next.filter((row) => row.enabled === 0).length,
  });
}

/** Manual-disable reason marker, exported so dispatch denials and tests
 * name the same string without duplicating it. */
export function manualDisableReason(): string {
  return MANUAL_DISABLE_REASON;
}

export function vendorToolNamePattern(): RegExp {
  return VENDOR_TOOL_NAME;
}
