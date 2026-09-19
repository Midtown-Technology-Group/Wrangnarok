// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171): portable external MCP server templates.
//
// A template is the secretless, portable half of the four-way split
// (upstream `mcp_servers.py`, pins in docs/upstream-spec.md §23): name
// (globally unique), server URL, OAuth provider flow, optional discovery
// metadata, optional Organization scope, and an active flag. No secrets
// live here by construction — the per-Organization client pair and tokens
// live on the Connection and token rows (`src/mcp-connections.ts`,
// `src/mcp-tokens.ts`), so templates stay manifest-friendly and safe to
// audit, log, and return to operators.
//
// Visibility: platform-level templates (`org_id` NULL) are visible to every
// authenticated caller; Organization-scoped templates are visible only to
// members of that Organization. Cross-Organization detail answers 404
// (never a leak), matching the Connection posture in `src/connections.ts`.
// Writes are operator-managed: Organization templates behind requireManageOrg,
// platform templates behind the instance-admin gate — both enforced at the
// route, which passes its verdict in.
import { Fault, UUID } from "./domain";
import type { Principal } from "./domain";

export const MCP_TEMPLATE_NAME = /^[a-z][a-z0-9_-]{2,63}$/;
const TEMPLATE_URL_MAX = 2048;
const DISCOVERY_METADATA_MAX = 4096;

export const MCP_PROVIDER_FLOWS = ["authorization_code", "client_credentials", "none"] as const;
export type McpProviderFlow = (typeof MCP_PROVIDER_FLOWS)[number];

/** One D1 server-template row (migration 0041). Secretless by schema. */
export interface McpServerTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly server_url: string;
  readonly org_id: string | null;
  readonly provider_flow: string;
  readonly discovery_metadata: string | null;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Secret-free template view: the whole row minus nothing, because the row
 * carries no secret columns to redact. */
export interface McpServerTemplateView {
  readonly id: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly orgId: string | null;
  readonly providerFlow: McpProviderFlow;
  readonly discoveryMetadata: unknown;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpTemplateWrite {
  readonly name?: unknown;
  readonly serverUrl?: unknown;
  readonly orgId?: unknown;
  readonly providerFlow?: unknown;
  readonly discoveryMetadata?: unknown;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

/** True when migration 0041 has landed. Explicit existence check, never
 * error-message matching on the write path. */
async function hasTemplateTable(db: D1Database): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='mcp_server_templates'")
    .first<{ ok: number }>();
  return found !== null;
}

function notMigrated(): Fault {
  return new Fault(503, "MCP_STORE_NOT_MIGRATED", "External MCP storage is not migrated on this database.");
}

export function parseMcpTemplateName(value: unknown): string {
  if (typeof value !== "string" || !MCP_TEMPLATE_NAME.test(value)) {
    throw invalid(
      "INVALID_MCP_SERVER",
      "Provide a template name of 3-64 chars: lowercase letter first, letters/digits/dashes/underscores after.",
    );
  }
  return value;
}

/** Validate an external MCP server URL: absolute http(s), never
 * credential-bearing. Loopback http serves the local fixture path (same
 * posture as the echo Integration); every other host requires https on a
 * DNS hostname — literal IPs never serve a template URL. Pure. */
export function parseMcpServerUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > TEMPLATE_URL_MAX) {
    throw invalid("INVALID_MCP_SERVER", "Provide an absolute http(s) server URL of 1-2048 chars.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("INVALID_MCP_SERVER", "The MCP server URL must be an absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("INVALID_MCP_SERVER", "The MCP server URL must use http or https.");
  }
  if (url.username || url.password) {
    throw invalid("INVALID_MCP_SERVER", "The MCP server URL must not embed credentials.");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (loopback && url.protocol !== "http:") {
    throw invalid("INVALID_MCP_SERVER", "The MCP server URL must use http for the local fixture.");
  }
  if (!loopback) {
    if (url.protocol !== "https:") {
      throw invalid("INVALID_MCP_SERVER", "The MCP server URL must use https outside the local fixture.");
    }
    // DNS names only outside the fixture: literal IPs (v4 or v6) never
    // serve a template URL, so internal-address classification cannot be
    // bypassed with an unlisted literal.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
      throw invalid("INVALID_MCP_SERVER", "The MCP server URL must use a DNS hostname outside the local fixture.");
    }
  }
  return value;
}

export function parseMcpProviderFlow(value: unknown): McpProviderFlow {
  if (typeof value !== "string" || !(MCP_PROVIDER_FLOWS as readonly string[]).includes(value)) {
    throw invalid("INVALID_MCP_SERVER", "The provider flow must be authorization_code, client_credentials, or none.");
  }
  return value as McpProviderFlow;
}

function parseDiscoveryMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid("INVALID_MCP_SERVER", "Discovery metadata must be a JSON object when provided.");
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > DISCOVERY_METADATA_MAX) {
    throw invalid("INVALID_MCP_SERVER", "Discovery metadata must fit in 4096 chars.");
  }
  return encoded;
}

function toView(row: McpServerTemplateRow): McpServerTemplateView {
  let discoveryMetadata: unknown = null;
  if (row.discovery_metadata !== null) {
    try {
      discoveryMetadata = JSON.parse(row.discovery_metadata) as unknown;
    } catch {
      discoveryMetadata = null;
    }
  }
  return Object.freeze({
    id: row.id,
    name: row.name,
    serverUrl: row.server_url,
    orgId: row.org_id,
    providerFlow: row.provider_flow as McpProviderFlow,
    discoveryMetadata,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Visibility filter: platform templates plus the caller's own Organization.
 * Anything else is invisible (callers render 404, never a leak). */
function visibleTo(row: McpServerTemplateRow, caller: Principal): boolean {
  return row.org_id === null || row.org_id === caller.orgId;
}

async function rowById(db: D1Database, id: string): Promise<McpServerTemplateRow | null> {
  try {
    return await db
      .prepare(
        "SELECT id,name,server_url,org_id,provider_flow,discovery_metadata,is_active,created_at,updated_at FROM mcp_server_templates WHERE id=?",
      )
      .bind(id)
      .first<McpServerTemplateRow>();
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/** List visible templates: platform-level plus the caller's Organization, in
 * name order. `activeOnly` excludes soft-deleted rows (upstream default). */
export async function listMcpServerTemplates(
  db: D1Database,
  caller: Principal,
  activeOnly = true,
): Promise<readonly McpServerTemplateView[]> {
  try {
    const rows = await db
      .prepare(
        "SELECT id,name,server_url,org_id,provider_flow,discovery_metadata,is_active,created_at,updated_at FROM mcp_server_templates WHERE (org_id IS NULL OR org_id=?) AND (?=0 OR is_active=1) ORDER BY name",
      )
      .bind(caller.orgId, activeOnly ? 1 : 0)
      .all<McpServerTemplateRow>();
    return Object.freeze(rows.results.filter((row) => visibleTo(row, caller)).map(toView));
  } catch (error) {
    if (isMissingTable(error)) return Object.freeze([]);
    throw error;
  }
}

/** Read one visible template. Unknown, foreign-Organization, or
 * soft-deleted (unless `includeInactive`) rows answer 404, never a leak. */
export async function getMcpServerTemplate(
  db: D1Database,
  caller: Principal,
  id: string,
  includeInactive = false,
): Promise<McpServerTemplateView> {
  if (!UUID.test(id)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  const row = await rowById(db, id);
  if (!row || !visibleTo(row, caller) || (!includeInactive && row.is_active === 0)) {
    throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  }
  return toView(row);
}

export interface McpTemplateAdmin {
  /** Route verdict: true when the caller may write platform-level rows
   * (instance admin). Organization-row writes always need requireManageOrg
   * at the route; this flag only opens the platform tier. */
  readonly isInstanceAdmin: boolean;
}

function requireWriteScope(caller: Principal, orgId: string | null, admin: McpTemplateAdmin): void {
  if (orgId === null) {
    if (!admin.isInstanceAdmin)
      throw invalid("MCP_ADMIN_ONLY", "Platform-level MCP servers need an instance admin.", 403);
    return;
  }
  if (orgId !== caller.orgId) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
}

/** Create one template. Names are globally unique (409 on collision, even
 * against foreign-Organization rows — the name itself answers, never the
 * row). */
export async function createMcpServerTemplate(
  db: D1Database,
  caller: Principal,
  admin: McpTemplateAdmin,
  body: McpTemplateWrite,
): Promise<McpServerTemplateView> {
  if (!(await hasTemplateTable(db))) throw notMigrated();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("INVALID_MCP_SERVER", "Provide a template name, server URL, and provider flow.");
  }
  const keys = Object.keys(body);
  if (
    keys.some(
      (key) =>
        key !== "name" &&
        key !== "serverUrl" &&
        key !== "orgId" &&
        key !== "providerFlow" &&
        key !== "discoveryMetadata",
    )
  ) {
    throw invalid(
      "INVALID_MCP_SERVER",
      "Only name, serverUrl, orgId, providerFlow, and discoveryMetadata may be set on a template.",
    );
  }
  const name = parseMcpTemplateName(body.name);
  const serverUrl = parseMcpServerUrl(body.serverUrl);
  const providerFlow = parseMcpProviderFlow(body.providerFlow);
  const discoveryMetadata = parseDiscoveryMetadata(body.discoveryMetadata);
  let orgId: string | null = null;
  if (body.orgId !== undefined && body.orgId !== null) {
    if (typeof body.orgId !== "string" || !UUID.test(body.orgId.trim().toLowerCase())) {
      throw invalid("INVALID_MCP_SERVER", "The template Organization must be a UUID or null for platform-level.");
    }
    orgId = body.orgId.trim().toLowerCase();
  }
  requireWriteScope(caller, orgId, admin);
  const existing = await db
    .prepare("SELECT id FROM mcp_server_templates WHERE name=?")
    .bind(name)
    .first<{ id: string }>();
  if (existing) throw invalid("MCP_SERVER_EXISTS", `An MCP server named "${name}" already exists.`, 409);
  const now = new Date().toISOString();
  const id = crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO mcp_server_templates(id,name,server_url,org_id,provider_flow,discovery_metadata,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)",
    )
    .bind(id, name, serverUrl, orgId, providerFlow, discoveryMetadata, now, now)
    .run();
  // The view is built from the just-written values — no re-read: the
  // INSERT above succeeding is the existence proof.
  return toView({
    id,
    name,
    server_url: serverUrl,
    org_id: orgId,
    provider_flow: providerFlow,
    discovery_metadata: discoveryMetadata,
    is_active: 1,
    created_at: now,
    updated_at: now,
  });
}

/** Update one visible template: server URL, flow, and discovery metadata are
 * mutable; name and Organization scope are identity and never move (a rename
 * mints a new template, so qualified tool names can never hijack callers). */
export async function updateMcpServerTemplate(
  db: D1Database,
  caller: Principal,
  admin: McpTemplateAdmin,
  id: string,
  body: McpTemplateWrite,
): Promise<McpServerTemplateView> {
  if (!(await hasTemplateTable(db))) throw notMigrated();
  if (!UUID.test(id)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("INVALID_MCP_SERVER", "Provide a server URL, provider flow, or discovery metadata.");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "serverUrl" && key !== "providerFlow" && key !== "discoveryMetadata")) {
    throw invalid("INVALID_MCP_SERVER", "Only serverUrl, providerFlow, and discoveryMetadata may be updated.");
  }
  const row = await rowById(db, id);
  if (!row || !visibleTo(row, caller)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  requireWriteScope(caller, row.org_id, admin);
  const serverUrl = body.serverUrl === undefined ? row.server_url : parseMcpServerUrl(body.serverUrl);
  const providerFlow =
    body.providerFlow === undefined ? (row.provider_flow as McpProviderFlow) : parseMcpProviderFlow(body.providerFlow);
  const discoveryMetadata =
    body.discoveryMetadata === undefined ? row.discovery_metadata : parseDiscoveryMetadata(body.discoveryMetadata);
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE mcp_server_templates SET server_url=?,provider_flow=?,discovery_metadata=?,updated_at=? WHERE id=?",
    )
    .bind(serverUrl, providerFlow, discoveryMetadata, now, id)
    .run();
  // The view is built from the pre-update row plus the applied values —
  // no re-read: the UPDATE above succeeding on the visible row is the
  // existence proof.
  return toView({
    ...row,
    server_url: serverUrl,
    provider_flow: providerFlow,
    discovery_metadata: discoveryMetadata,
    updated_at: now,
  });
}

/** Flip the active flag (disable/enable). Disabling hides the template
 * from discovery and blocks new bindings while existing Connection and
 * catalog rows keep their bindings; re-enabling restores discovery. */
export async function setMcpServerTemplateActive(
  db: D1Database,
  caller: Principal,
  admin: McpTemplateAdmin,
  id: string,
  active: boolean,
): Promise<McpServerTemplateView> {
  if (!(await hasTemplateTable(db))) throw notMigrated();
  if (!UUID.test(id)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  const row = await rowById(db, id);
  if (!row || !visibleTo(row, caller)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  requireWriteScope(caller, row.org_id, admin);
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE mcp_server_templates SET is_active=?,updated_at=? WHERE id=?")
    .bind(active ? 1 : 0, now, id)
    .run();
  return toView({ ...row, is_active: active ? 1 : 0, updated_at: now });
}

/** Soft-delete (default): flip inactive so existing Connection and catalog
 * rows keep their bindings while discovery hides the template. Hard delete
 * cascades Connections, catalog rows, and consent/token rows (platform
 * tier only, like create). */
export async function deleteMcpServerTemplate(
  db: D1Database,
  caller: Principal,
  admin: McpTemplateAdmin,
  id: string,
  hard = false,
): Promise<{ readonly id: string; readonly hard: boolean }> {
  if (!(await hasTemplateTable(db))) throw notMigrated();
  if (!UUID.test(id)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  const row = await rowById(db, id);
  if (!row || !visibleTo(row, caller)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  requireWriteScope(caller, row.org_id, admin);
  if (!hard) {
    if (row.is_active === 0) throw invalid("MCP_SERVER_DISABLED", "This MCP server is already inactive.", 409);
    await db
      .prepare("UPDATE mcp_server_templates SET is_active=0,updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), id)
      .run();
    return Object.freeze({ id, hard: false as const });
  }
  if (!admin.isInstanceAdmin)
    throw invalid("MCP_ADMIN_ONLY", "Hard-deleting an MCP server needs an instance admin.", 403);
  const secretsTable = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='mcp_connection_secrets'")
    .first<{ ok: number }>();
  const connections = await db
    .prepare("SELECT id FROM mcp_connections WHERE server_id=?")
    .bind(id)
    .all<{ id: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const connection of connections.results) {
    statements.push(db.prepare("DELETE FROM mcp_user_consents WHERE connection_id=?").bind(connection.id));
    statements.push(db.prepare("DELETE FROM mcp_service_tokens WHERE connection_id=?").bind(connection.id));
    statements.push(db.prepare("DELETE FROM mcp_tool_catalog WHERE connection_id=?").bind(connection.id));
    if (secretsTable !== null) {
      statements.push(db.prepare("DELETE FROM mcp_connection_secrets WHERE connection_id=?").bind(connection.id));
    }
  }
  statements.push(db.prepare("DELETE FROM mcp_connections WHERE server_id=?").bind(id));
  statements.push(db.prepare("DELETE FROM mcp_server_templates WHERE id=?").bind(id));
  await db.batch(statements);
  return Object.freeze({ id, hard: true as const });
}

/** Resolve one template for Connection binding: visible and active, else
 * 404/409 with the same posture as the read path. Exported for
 * `src/mcp-connections.ts` so binding and reading share one gate. */
export async function resolveBindableTemplate(
  db: D1Database,
  caller: Principal,
  serverId: string,
): Promise<McpServerTemplateRow> {
  if (!UUID.test(serverId)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  const row = await rowById(db, serverId);
  if (!row || !visibleTo(row, caller)) throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  if (row.is_active === 0) throw invalid("MCP_SERVER_DISABLED", "This MCP server is inactive.", 409);
  return row;
}
