// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171): per-Organization external MCP Connections.
//
// A Connection binds one portable template to one Organization: the org's
// own endpoint override, the OAuth token path, the chat/autonomous
// availability flags, and enablement. One Connection per (server, org).
// This row carries no secret material by schema — service and per-user
// tokens persist as envelopes beside it (`src/mcp-tokens.ts`), so the
// management views below are secret-free by construction and safe to audit,
// log, and return to operators.
//
// Reads are membership-scoped (exact org, cross-org 404); writes ride
// requireManageOrg at the route, matching `src/connections.ts`. Delete is
// a hard cascade (catalog rows plus both token stores, deleted explicitly
// beside the FK cascade, which D1 may not enforce).
import { Fault, UUID } from "./domain";
import type { Principal } from "./domain";
import { decryptConnectionSecret, encryptConnectionSecret, ENVELOPE_MAX_PLAINTEXT } from "./envelope";
import { parseMcpServerUrl, resolveBindableTemplate } from "./mcp-servers";

/** One D1 MCP Connection row (migration 0041). The client id is a public
 * identifier; the client secret is never a column here — it persists as an
 * envelope in `mcp_connection_secrets` (SEC-02 envelope path, field `mcpClientSecret`). */
export interface McpConnectionRow {
  readonly id: string;
  readonly org_id: string;
  readonly server_id: string;
  readonly server_url_override: string | null;
  readonly token_path: string | null;
  readonly client_id: string | null;
  readonly available_in_chat: number;
  readonly available_to_autonomous: number;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Secret-free Connection view: flags and identity only, plus whether the
 * per-Organization client secret is provisioned (names only, never values). */
export interface McpConnectionView {
  readonly id: string;
  readonly orgId: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly effectiveServerUrl: string;
  readonly serverUrlOverride: string | null;
  readonly tokenPath: string | null;
  readonly clientId: string | null;
  readonly clientSecretProvisioned: boolean;
  readonly providerFlow: string;
  readonly availableInChat: boolean;
  readonly availableToAutonomous: boolean;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpConnectionWrite {
  readonly serverId?: unknown;
  readonly serverUrlOverride?: unknown;
  readonly tokenPath?: unknown;
  readonly clientId?: unknown;
  readonly availableInChat?: unknown;
  readonly availableToAutonomous?: unknown;
  readonly enabled?: unknown;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

async function hasConnectionTable(db: D1Database): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='mcp_connections'")
    .first<{ ok: number }>();
  return found !== null;
}

function notMigrated(): Fault {
  return new Fault(503, "MCP_STORE_NOT_MIGRATED", "External MCP storage is not migrated on this database.");
}

/** Same-host token path (mirrors the OAUTH-01 consent posture in
 * `src/oauth-consent.ts`): resolved against the Connection's own server
 * host, so token material only ever travels to the configured MCP server.
 * Absolute URLs are rejected. Pure. */
export function parseMcpTokenPath(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.length > 512
  ) {
    throw invalid("INVALID_MCP_CONNECTION", "The token path must be a same-host path of 1-512 chars.");
  }
  return value;
}

function parseOptionalUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return parseMcpServerUrl(value);
}

function parseFlag(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw invalid("INVALID_MCP_CONNECTION", `${name} must be true or false when provided.`);
  return value;
}

function parseClientId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw invalid("INVALID_MCP_CONNECTION", "clientId must be 1-256 chars when provided.");
  }
  return value;
}

/** A Connection row joined to its bound template. */
/** Declared secret-field name carrying the per-Organization MCP OAuth
 * client secret. The value persists as an envelope in `mcp_connection_secrets`
 * (the SEC-02 envelope path P0 D3.1 names, in an MCP-owned table so the
 * row FK-binds the MCP Connection); views carry only the provisioned flag. */
export const MCP_CLIENT_SECRET_FIELD = "mcpClientSecret";

async function hasSecretsTable(db: D1Database): Promise<boolean> {
  try {
    const found = await db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='mcp_connection_secrets'")
      .first<{ ok: number }>();
    return found !== null;
  } catch {
    return false;
  }
}

async function clientSecretProvisioned(db: D1Database, connectionId: string): Promise<boolean> {
  try {
    if (!(await hasSecretsTable(db))) return false;
    const found = await db
      .prepare("SELECT field FROM mcp_connection_secrets WHERE connection_id=? AND field=?")
      .bind(connectionId, MCP_CLIENT_SECRET_FIELD)
      .first<{ field: string }>();
    return found !== null;
  } catch {
    return false;
  }
}

type JoinedRow = McpConnectionRow & { server_name: string; server_url: string; provider_flow: string };

function toView(row: JoinedRow, secretProvisioned: boolean): McpConnectionView {
  return Object.freeze({
    id: row.id,
    orgId: row.org_id,
    serverId: row.server_id,
    serverName: row.server_name,
    effectiveServerUrl: row.server_url_override ?? row.server_url,
    serverUrlOverride: row.server_url_override,
    tokenPath: row.token_path,
    clientId: row.client_id,
    clientSecretProvisioned: secretProvisioned,
    providerFlow: row.provider_flow,
    availableInChat: row.available_in_chat === 1,
    availableToAutonomous: row.available_to_autonomous === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Read one owned Connection with its template in a single INNER JOIN.
 * Unknown, foreign, or template-less rows resolve to null — callers
 * answer 404, never a half-bound view and never a leak. */
async function rowById(db: D1Database, orgId: string, id: string): Promise<JoinedRow | null> {
  try {
    return await db
      .prepare(
        "SELECT c.id,c.org_id,c.server_id,c.server_url_override,c.token_path,c.client_id,c.available_in_chat,c.available_to_autonomous,c.enabled,c.created_at,c.updated_at,t.name AS server_name,t.server_url AS server_url,t.provider_flow AS provider_flow FROM mcp_connections c JOIN mcp_server_templates t ON t.id=c.server_id WHERE c.org_id=? AND c.id=?",
      )
      .bind(orgId, id)
      .first<JoinedRow>();
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

async function withTemplate(db: D1Database, row: JoinedRow): Promise<McpConnectionView> {
  return toView(row, await clientSecretProvisioned(db, row.id));
}

/** List this Organization's Connections in server-name order. */
export async function listMcpConnections(db: D1Database, caller: Principal): Promise<readonly McpConnectionView[]> {
  try {
    const rows = await db
      .prepare(
        "SELECT c.id,c.org_id,c.server_id,c.server_url_override,c.token_path,c.client_id,c.available_in_chat,c.available_to_autonomous,c.enabled,c.created_at,c.updated_at,t.name AS server_name,t.server_url AS server_url,t.provider_flow AS provider_flow FROM mcp_connections c JOIN mcp_server_templates t ON t.id=c.server_id WHERE c.org_id=? ORDER BY t.name",
      )
      .bind(caller.orgId)
      .all<McpConnectionRow & { server_name: string; server_url: string; provider_flow: string }>();
    const provisioned = new Set<string>();
    if (await hasSecretsTable(db)) {
      const secrets = await db
        .prepare("SELECT connection_id FROM mcp_connection_secrets WHERE org_id=? AND field=?")
        .bind(caller.orgId, MCP_CLIENT_SECRET_FIELD)
        .all<{ connection_id: string }>();
      for (const entry of secrets.results) provisioned.add(entry.connection_id);
    }
    return Object.freeze(rows.results.map((row) => toView(row, provisioned.has(row.id))));
  } catch (error) {
    if (isMissingTable(error)) return Object.freeze([]);
    throw error;
  }
}

/** Read one owned Connection. Foreign or unknown ids answer 404, never a leak. */
export async function getMcpConnection(db: D1Database, caller: Principal, id: string): Promise<McpConnectionView> {
  if (!UUID.test(id)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  const row = await rowById(db, caller.orgId, id);
  if (!row) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  return withTemplate(db, row);
}

/** Bind one template to the caller's Organization. One Connection per
 * (server, org): re-binding answers 409. */
export async function createMcpConnection(
  db: D1Database,
  caller: Principal,
  body: McpConnectionWrite,
): Promise<McpConnectionView> {
  if (!(await hasConnectionTable(db))) throw notMigrated();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("INVALID_MCP_CONNECTION", "Provide a serverId to bind.");
  }
  const keys = Object.keys(body);
  if (
    keys.some(
      (key) =>
        key !== "serverId" &&
        key !== "serverUrlOverride" &&
        key !== "tokenPath" &&
        key !== "clientId" &&
        key !== "availableInChat" &&
        key !== "availableToAutonomous" &&
        key !== "enabled",
    )
  ) {
    throw invalid(
      "INVALID_MCP_CONNECTION",
      "Only serverId, serverUrlOverride, tokenPath, clientId, availableInChat, availableToAutonomous, and enabled may be set.",
    );
  }
  if (typeof body.serverId !== "string" || !UUID.test(body.serverId)) {
    throw invalid("MCP_SERVER_NOT_FOUND", "Unknown MCP server.", 404);
  }
  const template = await resolveBindableTemplate(db, caller, body.serverId);
  const override = parseOptionalUrl(body.serverUrlOverride);
  const tokenPath = parseMcpTokenPath(body.tokenPath);
  const clientId = parseClientId(body.clientId);
  const availableInChat = parseFlag(body.availableInChat, "availableInChat") ?? false;
  const availableToAutonomous = parseFlag(body.availableToAutonomous, "availableToAutonomous") ?? false;
  const enabled = parseFlag(body.enabled, "enabled") ?? true;
  const existing = await db
    .prepare("SELECT id FROM mcp_connections WHERE org_id=? AND server_id=?")
    .bind(caller.orgId, template.id)
    .first<{ id: string }>();
  if (existing) throw invalid("MCP_CONNECTION_EXISTS", "This Organization already bound this MCP server.", 409);
  const now = new Date().toISOString();
  const id = crypto.randomUUID().toLowerCase();
  await db
    .prepare(
      "INSERT INTO mcp_connections(id,org_id,server_id,server_url_override,token_path,client_id,available_in_chat,available_to_autonomous,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      caller.orgId,
      template.id,
      override,
      tokenPath,
      clientId,
      availableInChat ? 1 : 0,
      availableToAutonomous ? 1 : 0,
      enabled ? 1 : 0,
      now,
      now,
    )
    .run();
  // The view is built from the just-written values — no re-read: the
  // INSERT above succeeding is the existence proof, and no secret exists
  // yet for a fresh binding, so the provisioned flag is false.
  return toView(
    {
      id,
      org_id: caller.orgId,
      server_id: template.id,
      server_url_override: override,
      token_path: tokenPath,
      client_id: clientId,
      available_in_chat: availableInChat ? 1 : 0,
      available_to_autonomous: availableToAutonomous ? 1 : 0,
      enabled: enabled ? 1 : 0,
      created_at: now,
      updated_at: now,
      server_name: template.name,
      server_url: template.server_url,
      provider_flow: template.provider_flow,
    },
    false,
  );
}

/** Update one owned Connection: override, token path, flags, and
 * enablement are mutable; the bound template never moves (rebinding mints
 * a new Connection, so qualified tool names keep their meaning). */
export async function updateMcpConnection(
  db: D1Database,
  caller: Principal,
  id: string,
  body: McpConnectionWrite,
): Promise<McpConnectionView> {
  if (!(await hasConnectionTable(db))) throw notMigrated();
  if (!UUID.test(id)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("INVALID_MCP_CONNECTION", "Provide fields to update.");
  }
  const keys = Object.keys(body);
  if (
    keys.some(
      (key) =>
        key !== "serverUrlOverride" &&
        key !== "tokenPath" &&
        key !== "clientId" &&
        key !== "availableInChat" &&
        key !== "availableToAutonomous" &&
        key !== "enabled",
    )
  ) {
    throw invalid(
      "INVALID_MCP_CONNECTION",
      "Only serverUrlOverride, tokenPath, clientId, availableInChat, availableToAutonomous, and enabled may be updated.",
    );
  }
  const row = await rowById(db, caller.orgId, id);
  if (!row) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  const override =
    body.serverUrlOverride === undefined ? row.server_url_override : parseOptionalUrl(body.serverUrlOverride);
  const tokenPath = body.tokenPath === undefined ? row.token_path : parseMcpTokenPath(body.tokenPath);
  const clientId = body.clientId === undefined ? row.client_id : parseClientId(body.clientId);
  const availableInChat = parseFlag(body.availableInChat, "availableInChat") ?? row.available_in_chat === 1;
  const availableToAutonomous =
    parseFlag(body.availableToAutonomous, "availableToAutonomous") ?? row.available_to_autonomous === 1;
  const enabled = parseFlag(body.enabled, "enabled") ?? row.enabled === 1;
  const now = new Date().toISOString();
  await db
    .prepare(
      "UPDATE mcp_connections SET server_url_override=?,token_path=?,client_id=?,available_in_chat=?,available_to_autonomous=?,enabled=?,updated_at=? WHERE org_id=? AND id=?",
    )
    .bind(
      override,
      tokenPath,
      clientId,
      availableInChat ? 1 : 0,
      availableToAutonomous ? 1 : 0,
      enabled ? 1 : 0,
      now,
      caller.orgId,
      id,
    )
    .run();
  // The view is built from the pre-update row plus the applied values —
  // no re-read: the UPDATE above succeeding on the owned row is the
  // existence proof, and the template join is unchanged.
  return toView(
    {
      ...row,
      server_url_override: override,
      token_path: tokenPath,
      client_id: clientId,
      available_in_chat: availableInChat ? 1 : 0,
      available_to_autonomous: availableToAutonomous ? 1 : 0,
      enabled: enabled ? 1 : 0,
      updated_at: now,
    },
    await clientSecretProvisioned(db, row.id),
  );
}

/** Delete one owned Connection with its catalog rows and both token
 * stores (explicit deletes beside the FK cascade, which D1 may not
 * enforce — same belt beside the cascade as `deleteConnection`). */
export async function deleteMcpConnection(
  db: D1Database,
  caller: Principal,
  id: string,
): Promise<{ readonly id: string }> {
  if (!(await hasConnectionTable(db))) throw notMigrated();
  if (!UUID.test(id)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  const row = await rowById(db, caller.orgId, id);
  if (!row) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM mcp_user_consents WHERE connection_id=?").bind(id),
    db.prepare("DELETE FROM mcp_service_tokens WHERE connection_id=?").bind(id),
    db.prepare("DELETE FROM mcp_tool_catalog WHERE connection_id=?").bind(id),
  ];
  if (await hasSecretsTable(db)) {
    statements.push(
      db
        .prepare("DELETE FROM mcp_connection_secrets WHERE connection_id=? AND field=?")
        .bind(id, MCP_CLIENT_SECRET_FIELD),
    );
  }
  statements.push(db.prepare("DELETE FROM mcp_connections WHERE org_id=? AND id=?").bind(caller.orgId, id));
  await db.batch(statements);
  return Object.freeze({ id });
}

/** Resolve one owned, enabled Connection row for the dispatch path. Unknown,
 * foreign, or disabled ids deny here — dispatch never reaches the vendor
 * for a Connection the caller may not use. */
export async function resolveDispatchConnection(
  db: D1Database,
  caller: Principal,
  id: string,
): Promise<{ readonly row: McpConnectionRow; readonly view: McpConnectionView }> {
  if (!UUID.test(id)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  const row = await rowById(db, caller.orgId, id);
  if (!row) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  if (row.enabled === 0) throw invalid("MCP_CONNECTION_DISABLED", "This MCP Connection is disabled.", 404);
  return { row, view: await withTemplate(db, row) };
}

interface ClientSecretRow {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly wrapped_dek: string;
  readonly key_version: number;
  readonly algorithm: string;
}

/** Provision (or rotate) the per-Organization OAuth client secret for one
 * owned Connection. The exclusive path that accepts this value: it
 * encrypts into `mcp_connection_secrets` (ciphertext only) and the returned
 * view carries the provisioned flag, never the value. Empty values preserve
 * existing ciphertext (edit-preserve no-op). */
export async function putMcpConnectionClientSecret(
  db: D1Database,
  caller: Principal,
  id: string,
  secret: unknown,
  kekMaterial: string | undefined,
): Promise<McpConnectionView> {
  if (!(await hasConnectionTable(db))) throw notMigrated();
  if (!UUID.test(id)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  const row = await rowById(db, caller.orgId, id);
  if (!row) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  if (!(await hasSecretsTable(db))) throw notMigrated();
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) {
    throw invalid(
      "SECRET_STORE_NOT_CONFIGURED",
      "The per-Organization secret store is not configured for this environment.",
      502,
    );
  }
  if (secret === undefined || secret === "") return withTemplate(db, row);
  if (typeof secret !== "string" || secret.length > ENVELOPE_MAX_PLAINTEXT) {
    throw invalid("INVALID_MCP_CONNECTION", "The client secret must be a non-empty string.");
  }
  const envelope = await encryptConnectionSecret({
    orgId: caller.orgId,
    connectionId: row.id,
    field: MCP_CLIENT_SECRET_FIELD,
    plaintext: secret,
    kekMaterial,
  });
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO mcp_connection_secrets(connection_id,org_id,field,ciphertext,nonce,wrapped_dek,key_version,algorithm,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,field) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,wrapped_dek=excluded.wrapped_dek,key_version=excluded.key_version,algorithm=excluded.algorithm,updated_at=excluded.updated_at",
    )
    .bind(
      row.id,
      caller.orgId,
      MCP_CLIENT_SECRET_FIELD,
      envelope.ciphertext,
      envelope.nonce,
      envelope.wrappedDek,
      envelope.keyVersion,
      envelope.algorithm,
      now,
      now,
    )
    .run();
  return withTemplate(db, row);
}

/** Decrypt the per-Organization client secret for server-side token use
 * (consent exchange, client-credentials connect, refresh). Exact org +
 * Connection scoping: foreign rows never load. Corrupt rows fail loud —
 * never partial values, never plaintext fallbacks. Returns null when no
 * secret is provisioned. */
export async function resolveMcpConnectionClientSecret(
  db: D1Database,
  orgId: string,
  connectionId: string,
  keks: Readonly<Record<number, string>>,
): Promise<string | null> {
  if (!(await hasSecretsTable(db))) return null;
  const found = await db
    .prepare(
      "SELECT ciphertext,nonce,wrapped_dek,key_version,algorithm FROM mcp_connection_secrets WHERE org_id=? AND connection_id=? AND field=?",
    )
    .bind(orgId, connectionId, MCP_CLIENT_SECRET_FIELD)
    .first<ClientSecretRow>();
  if (!found) return null;
  try {
    return await decryptConnectionSecret({
      orgId,
      connectionId,
      field: MCP_CLIENT_SECRET_FIELD,
      row: {
        ciphertext: found.ciphertext,
        nonce: found.nonce,
        wrappedDek: found.wrapped_dek,
        keyVersion: found.key_version,
        algorithm: found.algorithm,
      },
      keks,
    });
  } catch {
    throw invalid("MCP_SECRET_UNREADABLE", "A stored MCP credential could not be decrypted.", 500);
  }
}
