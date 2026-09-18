// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171): MCP service-token and per-user consent credential
// persistence (migration 0041).
//
// Both stores reuse — never duplicate — the ADR 005 envelope path from
// `src/envelope.ts` (AES-GCM-256, per-environment KEK, associated data
// binding org + Connection + field): service tokens bind the Connection,
// per-user consent tokens additionally bind the user id through the field
// segment, so a copied row fails closed on decrypt. Writes are
// generation-fenced (`UPDATE ... WHERE generation=?`, the same Cloudflare-
// native CAS primitive as `src/oauth-tokens.ts`): concurrent refreshers
// serialize on the row and the loser observes MCP_TOKEN_GENERATION_STALE
// instead of overwriting a newer generation. No D1 transaction is ever held
// across vendor HTTP — reads happen before the vendor call, conditional
// writes after it.
//
// Rotation follows the OAUTH-01 adaptation, not the upstream orphan-row
// shape: re-consent replaces the row at generation + 1 (identity survives
// revoke/replace per the OAUTH-01 acceptance), so Connection identity is
// untouched and only the health status moves.
import { Fault } from "./domain";
import {
  decryptConnectionSecret,
  ENVELOPE_ALGORITHM,
  encryptConnectionSecret,
  ENVELOPE_MAX_PLAINTEXT,
} from "./envelope";
import { initialTokenHealth, recordTokenFailure, recordTokenRevoked, recordTokenSuccess } from "./oauth";
import type { TokenHealth } from "./oauth";
import { registerExecutionSecrets } from "./secrets";

const SERVICE_ACCESS_FIELD = "mcp_service_access";
const SERVICE_REFRESH_FIELD = "mcp_service_refresh";
const USER_ACCESS_FIELD = "mcp_user_access";
const USER_REFRESH_FIELD = "mcp_user_refresh";

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return details === undefined ? new Fault(status, code, message) : new Fault(status, code, message, details);
}

async function hasTable(db: D1Database, name: string): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
    .bind(name)
    .first<{ ok: number }>();
  return found !== null;
}

function notMigrated(): Fault {
  return new Fault(503, "MCP_STORE_NOT_MIGRATED", "External MCP storage is not migrated on this database.");
}

/** Non-secret persisted state: safe to audit, log, and return to operators. */
export interface McpTokenState {
  readonly generation: number;
  readonly scope: string;
  readonly expiresAtMs?: number;
  readonly health: TokenHealth;
}

/** Persisted state plus transient plaintext tokens. Register with the
 * execution-scoped scrub registry at the call boundary and drop after use —
 * never D1, logs, or Workflow state. */
export interface McpPersistedToken extends McpTokenState {
  readonly accessToken: string;
  readonly refreshToken?: string;
}

interface TokenRow {
  readonly access_ciphertext: string;
  readonly access_nonce: string;
  readonly access_wrapped_dek: string;
  readonly refresh_ciphertext: string | null;
  readonly refresh_nonce: string | null;
  readonly refresh_wrapped_dek: string | null;
  readonly key_version: number;
  readonly algorithm: string;
  readonly generation: number;
  readonly scope: string;
  readonly expires_at_ms: number | null;
  readonly status: string;
  readonly consecutive_failures: number;
  readonly last_failure_code: string | null;
  readonly last_success_at: string | null;
  readonly checked_at: string;
}

function toHealth(row: TokenRow): TokenHealth {
  // The status domain is guarded by the CHECK constraint on both token
  // tables, so the read casts instead of re-validating: a row that is
  // here has already passed the schema gate.
  return Object.freeze({
    status: row.status as TokenHealth["status"],
    checkedAt: row.checked_at,
    consecutiveFailures: row.consecutive_failures,
    lastFailureCode: row.last_failure_code,
    lastSuccessAt: row.last_success_at,
  });
}

function toState(row: TokenRow): McpTokenState {
  return Object.freeze({
    generation: row.generation,
    scope: row.scope,
    ...(row.expires_at_ms === null ? {} : { expiresAtMs: row.expires_at_ms }),
    health: toHealth(row),
  });
}

function requireKek(kekMaterial: string | undefined): string {
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) {
    throw invalid(
      "SECRET_STORE_NOT_CONFIGURED",
      "The per-Organization secret store is not configured for this environment.",
      502,
    );
  }
  return kekMaterial;
}

function requireTokenValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ENVELOPE_MAX_PLAINTEXT) {
    throw invalid("MCP_CREDENTIAL_INVALID", `The MCP ${name} is invalid.`);
  }
  return value;
}

async function encryptPair(
  orgId: string,
  aadConnectionId: string,
  accessField: string,
  refreshField: string,
  accessToken: string,
  refreshToken: string | undefined,
  kek: string,
): Promise<{
  access: { ciphertext: string; nonce: string; wrappedDek: string; keyVersion: number };
  refresh: { ciphertext: string; nonce: string; wrappedDek: string } | null;
}> {
  const access = await encryptConnectionSecret({
    orgId,
    connectionId: aadConnectionId,
    field: accessField,
    plaintext: accessToken,
    kekMaterial: kek,
  });
  let refresh: { ciphertext: string; nonce: string; wrappedDek: string } | null = null;
  if (refreshToken !== undefined) {
    const envelope = await encryptConnectionSecret({
      orgId,
      connectionId: aadConnectionId,
      field: refreshField,
      plaintext: refreshToken,
      kekMaterial: kek,
    });
    refresh = { ciphertext: envelope.ciphertext, nonce: envelope.nonce, wrappedDek: envelope.wrappedDek };
  }
  return { access, refresh };
}

async function decryptField(
  orgId: string,
  aadConnectionId: string,
  field: string,
  ciphertext: string,
  nonce: string,
  wrappedDek: string,
  keyVersion: number,
  algorithm: string,
  keks: Readonly<Record<number, string>>,
): Promise<string> {
  try {
    return await decryptConnectionSecret({
      orgId,
      connectionId: aadConnectionId,
      field,
      row: { ciphertext, nonce, wrappedDek, keyVersion, algorithm },
      keks,
    });
  } catch {
    throw invalid("MCP_TOKEN_UNREADABLE", "A stored MCP credential could not be decrypted.", 500);
  }
}

async function decryptRow(
  orgId: string,
  aadConnectionId: string,
  accessField: string,
  refreshField: string,
  row: TokenRow,
  keks: Readonly<Record<number, string>>,
  executionId?: string,
): Promise<McpPersistedToken> {
  const state = toState(row);
  const accessToken = await decryptField(
    orgId,
    aadConnectionId,
    accessField,
    row.access_ciphertext,
    row.access_nonce,
    row.access_wrapped_dek,
    row.key_version,
    row.algorithm,
    keks,
  );
  let refreshToken: string | undefined;
  if (row.refresh_ciphertext !== null || row.refresh_nonce !== null || row.refresh_wrapped_dek !== null) {
    if (row.refresh_ciphertext === null || row.refresh_nonce === null || row.refresh_wrapped_dek === null) {
      throw invalid("MCP_TOKEN_UNREADABLE", "A stored MCP credential could not be decrypted.", 500);
    }
    refreshToken = await decryptField(
      orgId,
      aadConnectionId,
      refreshField,
      row.refresh_ciphertext,
      row.refresh_nonce,
      row.refresh_wrapped_dek,
      row.key_version,
      row.algorithm,
      keks,
    );
  }
  if (executionId !== undefined) {
    registerExecutionSecrets(executionId, refreshToken === undefined ? [accessToken] : [accessToken, refreshToken]);
  }
  return Object.freeze({ ...state, accessToken, ...(refreshToken === undefined ? {} : { refreshToken }) });
}

async function connectionOwned(db: D1Database, orgId: string, connectionId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM mcp_connections WHERE org_id=? AND id=?")
    .bind(orgId, connectionId)
    .first<{ id: string }>();
  return row !== null;
}

// --- Service tokens (one row per Connection) -----------------------------------

const SERVICE_COLUMNS =
  "connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,scope,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at,updated_at";

export interface StoreMcpServiceTokenInput {
  readonly orgId: string;
  readonly connectionId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly expiresAtMs?: number;
  readonly kekMaterial: string | undefined;
  readonly checkedAt: string;
}

/** Read the non-secret service-token state, or null when none is stored. */
export async function readMcpServiceTokenState(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<McpTokenState | null> {
  if (!(await hasTable(db, "mcp_service_tokens"))) return null;
  const row = await db
    .prepare(`SELECT ${SERVICE_COLUMNS} FROM mcp_service_tokens WHERE org_id=? AND connection_id=?`)
    .bind(orgId, connectionId)
    .first<TokenRow & { connection_id: string; org_id: string; updated_at: string }>();
  if (!row) return null;
  return toState(row);
}

/** Load and decrypt the service token. Foreign rows resolve to null. */
export async function loadMcpServiceToken(
  db: D1Database,
  orgId: string,
  connectionId: string,
  keks: Readonly<Record<number, string>>,
  executionId?: string,
): Promise<McpPersistedToken | null> {
  if (!(await hasTable(db, "mcp_service_tokens"))) return null;
  const row = await db
    .prepare(`SELECT ${SERVICE_COLUMNS} FROM mcp_service_tokens WHERE org_id=? AND connection_id=?`)
    .bind(orgId, connectionId)
    .first<TokenRow & { connection_id: string; org_id: string; updated_at: string }>();
  if (!row) return null;
  return decryptRow(orgId, connectionId, SERVICE_ACCESS_FIELD, SERVICE_REFRESH_FIELD, row, keks, executionId);
}

/** Persist the first service token at generation 1. A second initial store
 * fails with MCP_TOKEN_EXISTS: rotation goes through `replaceMcpServiceToken`. */
export async function storeInitialMcpServiceToken(
  db: D1Database,
  input: StoreMcpServiceTokenInput,
): Promise<McpTokenState> {
  if (!(await hasTable(db, "mcp_service_tokens"))) throw notMigrated();
  const kek = requireKek(input.kekMaterial);
  const accessToken = requireTokenValue(input.accessToken, "access token");
  const refreshToken =
    input.refreshToken === undefined ? undefined : requireTokenValue(input.refreshToken, "refresh token");
  if (!(await connectionOwned(db, input.orgId, input.connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  const existing = await db
    .prepare("SELECT generation FROM mcp_service_tokens WHERE org_id=? AND connection_id=?")
    .bind(input.orgId, input.connectionId)
    .first<{ generation: number }>();
  if (existing) throw invalid("MCP_TOKEN_EXISTS", "A service credential is already stored for this Connection.", 409);
  const { access, refresh } = await encryptPair(
    input.orgId,
    input.connectionId,
    SERVICE_ACCESS_FIELD,
    SERVICE_REFRESH_FIELD,
    accessToken,
    refreshToken,
    kek,
  );
  const scope = typeof input.scope === "string" ? input.scope : "";
  const health = recordTokenSuccess(initialTokenHealth(input.checkedAt), input.checkedAt);
  await db
    .prepare(
      "INSERT INTO mcp_service_tokens(connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,scope,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      input.connectionId,
      input.orgId,
      access.ciphertext,
      access.nonce,
      access.wrappedDek,
      refresh?.ciphertext ?? null,
      refresh?.nonce ?? null,
      refresh?.wrappedDek ?? null,
      access.keyVersion,
      ENVELOPE_ALGORITHM,
      1,
      scope,
      input.expiresAtMs ?? null,
      health.status,
      health.consecutiveFailures,
      health.lastFailureCode,
      health.lastSuccessAt,
      health.checkedAt,
      input.checkedAt,
    )
    .run();
  return Object.freeze({
    generation: 1,
    scope,
    ...(input.expiresAtMs === undefined ? {} : { expiresAtMs: input.expiresAtMs }),
    health,
  });
}

export interface ReplaceMcpServiceTokenInput extends StoreMcpServiceTokenInput {
  readonly expectedGeneration: number;
}

/** Persist a rotated service token at generation + 1, conditional on the
 * expected generation. Superseded writers observe
 * MCP_TOKEN_GENERATION_STALE and the newer row stands. */
export async function replaceMcpServiceToken(
  db: D1Database,
  input: ReplaceMcpServiceTokenInput,
): Promise<McpTokenState> {
  if (!(await hasTable(db, "mcp_service_tokens"))) throw notMigrated();
  const kek = requireKek(input.kekMaterial);
  const accessToken = requireTokenValue(input.accessToken, "access token");
  const refreshToken =
    input.refreshToken === undefined ? undefined : requireTokenValue(input.refreshToken, "refresh token");
  if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw invalid("MCP_CREDENTIAL_INVALID", "The MCP credential request is invalid.");
  }
  if (!(await connectionOwned(db, input.orgId, input.connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  const { access, refresh } = await encryptPair(
    input.orgId,
    input.connectionId,
    SERVICE_ACCESS_FIELD,
    SERVICE_REFRESH_FIELD,
    accessToken,
    refreshToken,
    kek,
  );
  const scope = typeof input.scope === "string" ? input.scope : "";
  const health = recordTokenSuccess(initialTokenHealth(input.checkedAt), input.checkedAt);
  const applied = await db
    .prepare(
      "UPDATE mcp_service_tokens SET access_ciphertext=?,access_nonce=?,access_wrapped_dek=?,refresh_ciphertext=?,refresh_nonce=?,refresh_wrapped_dek=?,key_version=?,algorithm=?,generation=?,scope=?,expires_at_ms=?,status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND generation=?",
    )
    .bind(
      access.ciphertext,
      access.nonce,
      access.wrappedDek,
      refresh?.ciphertext ?? null,
      refresh?.nonce ?? null,
      refresh?.wrappedDek ?? null,
      access.keyVersion,
      ENVELOPE_ALGORITHM,
      input.expectedGeneration + 1,
      scope,
      input.expiresAtMs ?? null,
      health.status,
      health.consecutiveFailures,
      health.lastFailureCode,
      health.lastSuccessAt,
      health.checkedAt,
      input.checkedAt,
      input.orgId,
      input.connectionId,
      input.expectedGeneration,
    )
    .run();
  if (applied.meta.changes === 0) {
    const current = await db
      .prepare("SELECT generation FROM mcp_service_tokens WHERE org_id=? AND connection_id=?")
      .bind(input.orgId, input.connectionId)
      .first<{ generation: number }>();
    if (!current) throw invalid("MCP_TOKEN_NOT_FOUND", "No service credential is stored for this Connection.", 404);
    throw invalid(
      "MCP_TOKEN_GENERATION_STALE",
      "A newer service credential generation already replaced this one.",
      409,
    );
  }
  return Object.freeze({
    generation: input.expectedGeneration + 1,
    scope,
    ...(input.expiresAtMs === undefined ? {} : { expiresAtMs: input.expiresAtMs }),
    health,
  });
}

/** Record a service-token use outcome, conditional on the observed
 * generation so a superseded writer never marks a newer generation failed
 * or revoked. Health columns only — ciphertext is untouched. */
export async function recordMcpServiceTokenOutcome(
  db: D1Database,
  orgId: string,
  connectionId: string,
  outcome:
    { readonly kind: "success" } | { readonly kind: "failure"; readonly code: string } | { readonly kind: "revoked" },
  checkedAt: string,
  expectedGeneration: number,
): Promise<TokenHealth> {
  if (!(await hasTable(db, "mcp_service_tokens"))) throw notMigrated();
  const current = await db
    .prepare(
      "SELECT status,consecutive_failures,last_failure_code,last_success_at,checked_at,generation FROM mcp_service_tokens WHERE org_id=? AND connection_id=?",
    )
    .bind(orgId, connectionId)
    .first<{
      status: string;
      consecutive_failures: number;
      last_failure_code: string | null;
      last_success_at: string | null;
      checked_at: string;
      generation: number;
    }>();
  if (!current || current.generation !== expectedGeneration) {
    throw invalid(
      "MCP_TOKEN_GENERATION_STALE",
      "A newer service credential generation already replaced this one.",
      409,
    );
  }
  const previous: TokenHealth = Object.freeze({
    status: current.status as TokenHealth["status"],
    checkedAt: current.checked_at,
    consecutiveFailures: current.consecutive_failures,
    lastFailureCode: current.last_failure_code,
    lastSuccessAt: current.last_success_at,
  });
  const next =
    outcome.kind === "success"
      ? recordTokenSuccess(previous, checkedAt)
      : outcome.kind === "revoked"
        ? recordTokenRevoked(previous, checkedAt)
        : recordTokenFailure(previous, outcome.code, checkedAt);
  await db
    .prepare(
      "UPDATE mcp_service_tokens SET status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND generation=?",
    )
    .bind(
      next.status,
      next.consecutiveFailures,
      next.lastFailureCode,
      next.lastSuccessAt,
      next.checkedAt,
      checkedAt,
      orgId,
      connectionId,
      expectedGeneration,
    )
    .run();
  return next;
}

// --- Per-user consent credentials (one row per (Connection, user)) -------------

/** Associated-data Connection id for per-user rows: binds the user into the
 * envelope AAD alongside org + Connection + field, so a row copied to
 * another user fails closed on decrypt. */
function userAadConnection(connectionId: string, userId: string): string {
  return `${connectionId}/user/${userId}`;
}

/** Non-secret consent view: who consented to what, when — never token values. */
export interface McpConsentView {
  readonly connectionId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly scope: string;
  readonly consentGrantedAt: string;
  readonly consentExpiresAt: string | null;
  readonly generation: number;
  readonly expiresAtMs?: number;
  readonly health: TokenHealth;
}

export interface StoreMcpUserConsentInput extends StoreMcpServiceTokenInput {
  readonly userId: string;
  readonly consentExpiresAt?: string;
}

interface ConsentRow extends TokenRow {
  readonly connection_id: string;
  readonly user_id: string;
  readonly org_id: string;
  readonly consent_granted_at: string;
  readonly consent_expires_at: string | null;
}

const CONSENT_COLUMNS =
  "connection_id,user_id,org_id,scope,consent_granted_at,consent_expires_at,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at";

function toConsentView(row: ConsentRow): McpConsentView {
  return Object.freeze({
    connectionId: row.connection_id,
    userId: row.user_id,
    orgId: row.org_id,
    scope: row.scope,
    consentGrantedAt: row.consent_granted_at,
    consentExpiresAt: row.consent_expires_at,
    generation: row.generation,
    ...(row.expires_at_ms === null ? {} : { expiresAtMs: row.expires_at_ms }),
    health: toHealth(row),
  });
}

/** Read one user's non-secret consent view, or null when no consent exists
 * (or the table predates this slice). */
export async function readMcpUserConsent(
  db: D1Database,
  orgId: string,
  connectionId: string,
  userId: string,
): Promise<McpConsentView | null> {
  if (!(await hasTable(db, "mcp_user_consents"))) return null;
  const row = await db
    .prepare(`SELECT ${CONSENT_COLUMNS} FROM mcp_user_consents WHERE org_id=? AND connection_id=? AND user_id=?`)
    .bind(orgId, connectionId, userId)
    .first<ConsentRow>();
  if (!row) return null;
  return toConsentView(row);
}

/** Load and decrypt one user's consent credential. */
export async function loadMcpUserConsent(
  db: D1Database,
  orgId: string,
  connectionId: string,
  userId: string,
  keks: Readonly<Record<number, string>>,
  executionId?: string,
): Promise<(McpPersistedToken & { readonly consentGrantedAt: string; readonly scope: string }) | null> {
  if (!(await hasTable(db, "mcp_user_consents"))) return null;
  const row = await db
    .prepare(`SELECT ${CONSENT_COLUMNS} FROM mcp_user_consents WHERE org_id=? AND connection_id=? AND user_id=?`)
    .bind(orgId, connectionId, userId)
    .first<ConsentRow>();
  if (!row) return null;
  const token = await decryptRow(
    orgId,
    userAadConnection(connectionId, userId),
    USER_ACCESS_FIELD,
    USER_REFRESH_FIELD,
    row,
    keks,
    executionId,
  );
  return Object.freeze({ ...token, consentGrantedAt: row.consent_granted_at, scope: row.scope });
}

/** Record first consent for one (Connection, user): consent metadata plus
 * the first token at generation 1. Re-consent rotates through
 * `replaceMcpUserConsentToken`, never a blind overwrite. */
export async function storeInitialMcpUserConsent(
  db: D1Database,
  input: StoreMcpUserConsentInput,
): Promise<McpConsentView> {
  if (!(await hasTable(db, "mcp_user_consents"))) throw notMigrated();
  const kek = requireKek(input.kekMaterial);
  const accessToken = requireTokenValue(input.accessToken, "access token");
  const refreshToken =
    input.refreshToken === undefined ? undefined : requireTokenValue(input.refreshToken, "refresh token");
  if (!(await connectionOwned(db, input.orgId, input.connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  const normalizedUser = input.userId.trim().toLowerCase();
  if (normalizedUser.length === 0 || normalizedUser.length > 320) {
    throw invalid("MCP_CREDENTIAL_INVALID", "The MCP consent user is invalid.");
  }
  const existing = await db
    .prepare("SELECT generation FROM mcp_user_consents WHERE org_id=? AND connection_id=? AND user_id=?")
    .bind(input.orgId, input.connectionId, normalizedUser)
    .first<{ generation: number }>();
  if (existing) throw invalid("MCP_CONSENT_EXISTS", "This user already consented to this Connection.", 409);
  const { access, refresh } = await encryptPair(
    input.orgId,
    userAadConnection(input.connectionId, normalizedUser),
    USER_ACCESS_FIELD,
    USER_REFRESH_FIELD,
    accessToken,
    refreshToken,
    kek,
  );
  const scope = typeof input.scope === "string" ? input.scope : "";
  const checkedAt = input.checkedAt;
  const health = recordTokenSuccess(initialTokenHealth(checkedAt), checkedAt);
  await db
    .prepare(
      "INSERT INTO mcp_user_consents(connection_id,user_id,org_id,scope,consent_granted_at,consent_expires_at,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      input.connectionId,
      normalizedUser,
      input.orgId,
      scope,
      checkedAt,
      input.consentExpiresAt ?? null,
      access.ciphertext,
      access.nonce,
      access.wrappedDek,
      refresh?.ciphertext ?? null,
      refresh?.nonce ?? null,
      refresh?.wrappedDek ?? null,
      access.keyVersion,
      ENVELOPE_ALGORITHM,
      1,
      input.expiresAtMs ?? null,
      health.status,
      health.consecutiveFailures,
      health.lastFailureCode,
      health.lastSuccessAt,
      health.checkedAt,
      checkedAt,
    )
    .run();
  // The view is built from the just-written values — no re-read: the
  // INSERT above succeeding is the existence proof.
  return toConsentView({
    connection_id: input.connectionId,
    user_id: normalizedUser,
    org_id: input.orgId,
    scope,
    consent_granted_at: checkedAt,
    consent_expires_at: input.consentExpiresAt ?? null,
    access_ciphertext: access.ciphertext,
    access_nonce: access.nonce,
    access_wrapped_dek: access.wrappedDek,
    refresh_ciphertext: refresh?.ciphertext ?? null,
    refresh_nonce: refresh?.nonce ?? null,
    refresh_wrapped_dek: refresh?.wrappedDek ?? null,
    key_version: access.keyVersion,
    algorithm: ENVELOPE_ALGORITHM,
    generation: 1,
    expires_at_ms: input.expiresAtMs ?? null,
    status: health.status,
    consecutive_failures: health.consecutiveFailures,
    last_failure_code: health.lastFailureCode,
    last_success_at: health.lastSuccessAt,
    checked_at: health.checkedAt,
  });
}

export interface ReplaceMcpUserConsentInput extends StoreMcpUserConsentInput {
  readonly expectedGeneration: number;
}

/** Rotate one user's consent credential (re-consent): new consent timestamp
 * plus replacement token at generation + 1, conditional on the expected
 * generation. */
export async function replaceMcpUserConsentToken(
  db: D1Database,
  input: ReplaceMcpUserConsentInput,
): Promise<McpConsentView> {
  if (!(await hasTable(db, "mcp_user_consents"))) throw notMigrated();
  const kek = requireKek(input.kekMaterial);
  const accessToken = requireTokenValue(input.accessToken, "access token");
  const refreshToken =
    input.refreshToken === undefined ? undefined : requireTokenValue(input.refreshToken, "refresh token");
  if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw invalid("MCP_CREDENTIAL_INVALID", "The MCP credential request is invalid.");
  }
  if (!(await connectionOwned(db, input.orgId, input.connectionId))) {
    throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  }
  const normalizedUser = input.userId.trim().toLowerCase();
  const { access, refresh } = await encryptPair(
    input.orgId,
    userAadConnection(input.connectionId, normalizedUser),
    USER_ACCESS_FIELD,
    USER_REFRESH_FIELD,
    accessToken,
    refreshToken,
    kek,
  );
  const scope = typeof input.scope === "string" ? input.scope : "";
  const checkedAt = input.checkedAt;
  const health = recordTokenSuccess(initialTokenHealth(checkedAt), checkedAt);
  const applied = await db
    .prepare(
      "UPDATE mcp_user_consents SET scope=?,consent_granted_at=?,consent_expires_at=?,access_ciphertext=?,access_nonce=?,access_wrapped_dek=?,refresh_ciphertext=?,refresh_nonce=?,refresh_wrapped_dek=?,key_version=?,algorithm=?,generation=?,expires_at_ms=?,status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND user_id=? AND generation=?",
    )
    .bind(
      scope,
      checkedAt,
      input.consentExpiresAt ?? null,
      access.ciphertext,
      access.nonce,
      access.wrappedDek,
      refresh?.ciphertext ?? null,
      refresh?.nonce ?? null,
      refresh?.wrappedDek ?? null,
      access.keyVersion,
      ENVELOPE_ALGORITHM,
      input.expectedGeneration + 1,
      input.expiresAtMs ?? null,
      health.status,
      health.consecutiveFailures,
      health.lastFailureCode,
      health.lastSuccessAt,
      health.checkedAt,
      checkedAt,
      input.orgId,
      input.connectionId,
      normalizedUser,
      input.expectedGeneration,
    )
    .run();
  if (applied.meta.changes === 0) {
    const current = await db
      .prepare("SELECT generation FROM mcp_user_consents WHERE org_id=? AND connection_id=? AND user_id=?")
      .bind(input.orgId, input.connectionId, normalizedUser)
      .first<{ generation: number }>();
    if (!current) throw invalid("MCP_CONSENT_NOT_FOUND", "This user has not consented to this Connection.", 404);
    throw invalid(
      "MCP_TOKEN_GENERATION_STALE",
      "A newer consent credential generation already replaced this one.",
      409,
    );
  }
  // The view is built from the just-replaced values — no re-read: the
  // conditional UPDATE above succeeding is the existence proof.
  return toConsentView({
    connection_id: input.connectionId,
    user_id: normalizedUser,
    org_id: input.orgId,
    scope,
    consent_granted_at: checkedAt,
    consent_expires_at: input.consentExpiresAt ?? null,
    access_ciphertext: access.ciphertext,
    access_nonce: access.nonce,
    access_wrapped_dek: access.wrappedDek,
    refresh_ciphertext: refresh?.ciphertext ?? null,
    refresh_nonce: refresh?.nonce ?? null,
    refresh_wrapped_dek: refresh?.wrappedDek ?? null,
    key_version: access.keyVersion,
    algorithm: ENVELOPE_ALGORITHM,
    generation: input.expectedGeneration + 1,
    expires_at_ms: input.expiresAtMs ?? null,
    status: health.status,
    consecutive_failures: health.consecutiveFailures,
    last_failure_code: health.lastFailureCode,
    last_success_at: health.lastSuccessAt,
    checked_at: health.checkedAt,
  });
}

/** Disconnect the service credential: idempotent delete of the token
 * row. Missing credentials still answer success — disconnect is safe to
 * retry. Connection identity survives; only the credential is gone. */
export async function disconnectMcpServiceCredential(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<{ readonly disconnected: true }> {
  if (!(await hasTable(db, "mcp_service_tokens"))) return Object.freeze({ disconnected: true as const });
  await db.prepare("DELETE FROM mcp_service_tokens WHERE org_id=? AND connection_id=?").bind(orgId, connectionId).run();
  return Object.freeze({ disconnected: true as const });
}

/** Disconnect one user's consent: idempotent delete of the credential row
 * plus its token material (one row holds both). Missing consent still
 * answers success — disconnect is safe to retry. */
export async function disconnectMcpUserConsent(
  db: D1Database,
  orgId: string,
  connectionId: string,
  userId: string,
): Promise<{ readonly disconnected: true }> {
  if (!(await hasTable(db, "mcp_user_consents"))) return Object.freeze({ disconnected: true as const });
  await db
    .prepare("DELETE FROM mcp_user_consents WHERE org_id=? AND connection_id=? AND user_id=?")
    .bind(orgId, connectionId, userId.trim().toLowerCase())
    .run();
  return Object.freeze({ disconnected: true as const });
}

/** Record one user's consent-token use outcome, conditional on the observed
 * generation. Revoked stays terminal until a fresh consent succeeds. */
export async function recordMcpUserConsentOutcome(
  db: D1Database,
  orgId: string,
  connectionId: string,
  userId: string,
  outcome:
    { readonly kind: "success" } | { readonly kind: "failure"; readonly code: string } | { readonly kind: "revoked" },
  checkedAt: string,
  expectedGeneration: number,
): Promise<TokenHealth> {
  if (!(await hasTable(db, "mcp_user_consents"))) throw notMigrated();
  const normalizedUser = userId.trim().toLowerCase();
  const current = await db
    .prepare(
      "SELECT status,consecutive_failures,last_failure_code,last_success_at,checked_at,generation FROM mcp_user_consents WHERE org_id=? AND connection_id=? AND user_id=?",
    )
    .bind(orgId, connectionId, normalizedUser)
    .first<{
      status: string;
      consecutive_failures: number;
      last_failure_code: string | null;
      last_success_at: string | null;
      checked_at: string;
      generation: number;
    }>();
  if (!current || current.generation !== expectedGeneration) {
    throw invalid(
      "MCP_TOKEN_GENERATION_STALE",
      "A newer consent credential generation already replaced this one.",
      409,
    );
  }
  const previous: TokenHealth = Object.freeze({
    status: current.status as TokenHealth["status"],
    checkedAt: current.checked_at,
    consecutiveFailures: current.consecutive_failures,
    lastFailureCode: current.last_failure_code,
    lastSuccessAt: current.last_success_at,
  });
  const next =
    outcome.kind === "success"
      ? recordTokenSuccess(previous, checkedAt)
      : outcome.kind === "revoked"
        ? recordTokenRevoked(previous, checkedAt)
        : recordTokenFailure(previous, outcome.code, checkedAt);
  await db
    .prepare(
      "UPDATE mcp_user_consents SET status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND user_id=? AND generation=?",
    )
    .bind(
      next.status,
      next.consecutiveFailures,
      next.lastFailureCode,
      next.lastSuccessAt,
      next.checkedAt,
      checkedAt,
      orgId,
      connectionId,
      normalizedUser,
      expectedGeneration,
    )
    .run();
  return next;
}
