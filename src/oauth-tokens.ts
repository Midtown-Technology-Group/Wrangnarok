// SPDX-License-Identifier: AGPL-3.0
// OAuth token + health persistence (OAUTH-01 persistence slice 1, issue #149).
//
// Post-#148 (SEC-02 closed) this module persists per-Organization,
// per-Connection OAuth tokens beside the non-secret Connection mapping.
// It reuses — never duplicates — the ADR 005 envelope path:
//
// - AES-GCM-256 envelopes from `src/envelope.ts`, one per token value with
//   field bindings `oauth_access` / `oauth_refresh`, so associated data binds
//   org_id + Connection id + field: a copied row fails closed on decrypt.
// - The per-environment KEK from Secrets Store (never D1, never logs).
// - The execution-scoped scrub registry from `src/secrets.ts`: decrypted
//   tokens are registered for the calling Execution and dropped after use.
// - The existing refresh fence from `src/oauth.ts`: every rotation funnels
//   through `refreshRotatingToken` with the persisted generation as the fence
//   generation, so concurrent rotations serialize and a superseded generation
//   can never coalesce onto (or overwrite) a newer one.
//
// Ordering invariant (Cloudflare-native equivalent of the upstream PR #741
// row-lock pin): D1 is read BEFORE vendor HTTP and written AFTER it, in
// separate statements with no transaction held across the vendor call.
// Replacement, failure, and revocation writes are all conditional on the
// expected persisted generation (`UPDATE ... WHERE generation=?`): a
// superseded writer observes zero changed rows and fails with
// OAUTH_TOKEN_GENERATION_STALE instead of marking a newer generation failed
// or revoked after vendor HTTP returns. Same-generation ordering (issue
// #451): revoked wins the status, failure diagnostics are preserved, and
// the losing writer records its outcome. The failure write
// compare-and-swaps on the observed health; when a same-generation
// revocation the fence does not serialize lands first, the losing failure
// merges its consecutive count plus vendor code onto the committed row
// without moving its status, then returns the authoritative reread (no new
// outcome code). The revocation write sets only status plus write stamps,
// preserving committed failure diagnostics by construction.
//
// Deliberately out of this slice (stays deferred per the #149 archaeology
// matrix): operator callback routes, per-org consent rows beyond the token
// itself, scheduled refresh, and the Integration-list health aggregate.
// Health here is per-Connection only: failed/recovered/revoked transitions
// persist honestly via the pure lifecycle in `src/oauth.ts`.
import { Fault } from "./domain";
import {
  decryptConnectionSecret,
  ENVELOPE_ALGORITHM,
  encryptConnectionSecret,
  ENVELOPE_MAX_PLAINTEXT,
} from "./envelope";
import {
  initialTokenHealth,
  isTokenUsable,
  recordTokenFailure,
  recordTokenRevoked,
  recordTokenSuccess,
  refreshRotatingToken,
  revokeOAuthToken,
} from "./oauth";
import type {
  OAuthClientCredentials,
  OAuthFaultTable,
  OAuthRefreshFenceBinding,
  OAuthToken,
  RotatedToken,
  TokenHealth,
  TokenHealthStatus,
} from "./oauth";
import { registerExecutionSecrets } from "./secrets";

/** Envelope field bindings for the two stored token values. Distinct fields
 * keep the access and refresh ciphertexts from decrypting under each other. */
const ACCESS_FIELD = "oauth_access";
const REFRESH_FIELD = "oauth_refresh";

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return details === undefined ? new Fault(status, code, message) : new Fault(status, code, message, details);
}

interface OAuthTokenRow {
  readonly connection_id: string;
  readonly org_id: string;
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
  readonly updated_at: string;
}

/** Non-secret persisted state: safe to audit, log, and return to operators. */
export interface OAuthTokenState {
  readonly generation: number;
  readonly scope: string;
  readonly expiresAtMs?: number;
  readonly health: TokenHealth;
}

/** Persisted state plus transient plaintext tokens. Values must be
 * registered with the execution-scoped scrub registry at the call boundary
 * and dropped after use — never written to D1, logs, or Workflow state. */
export interface PersistedOAuthToken extends OAuthTokenState {
  readonly accessToken: string;
  readonly refreshToken?: string;
}

/** True when the `oauth_tokens` table exists. Suites on partial migration
 * chains (pre-0031) resolve loads to null and skip the token delete; every
 * other D1 failure still throws. Explicit existence check, never
 * error-message matching. */
async function hasOAuthTokensTable(db: D1Database): Promise<boolean> {
  const found = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='oauth_tokens'")
    .first<{ ok: number }>();
  return found !== null;
}

function toHealth(row: OAuthTokenRow): TokenHealth {
  const status = row.status;
  if (status !== "healthy" && status !== "failed" && status !== "revoked") {
    throw invalid("OAUTH_TOKEN_UNREADABLE", "A stored OAuth token could not be read.", 500);
  }
  const health: TokenHealth = {
    status: status as TokenHealthStatus,
    checkedAt: row.checked_at,
    consecutiveFailures: row.consecutive_failures,
    lastFailureCode: row.last_failure_code,
    lastSuccessAt: row.last_success_at,
  };
  return Object.freeze(health);
}

function toState(row: OAuthTokenRow): OAuthTokenState {
  const state: OAuthTokenState = {
    generation: row.generation,
    scope: row.scope,
    ...(row.expires_at_ms === null ? {} : { expiresAtMs: row.expires_at_ms }),
    health: toHealth(row),
  };
  return Object.freeze(state);
}

async function ownedConnectionId(db: D1Database, orgId: string, connectionId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id, managed_by FROM connections WHERE id=? AND org_id=?")
    .bind(connectionId, orgId)
    .first<{ id: string; managed_by: string | null }>();
  if (!row) return null;
  if (row.managed_by !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Connection is managed by bundle install ${row.managed_by}: live mutation outside install is rejected.`,
      409,
    );
  }
  return row.id;
}

async function decryptField(
  orgId: string,
  connectionId: string,
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
      connectionId,
      field,
      row: { ciphertext, nonce, wrappedDek, keyVersion, algorithm },
      keks,
    });
  } catch {
    throw invalid("OAUTH_TOKEN_UNREADABLE", "A stored OAuth token could not be decrypted.", 500);
  }
}

/** Read the non-secret persisted state for one owned Connection, or null
 * when no token is stored (or the table predates this slice). Never returns
 * secret material and needs no KEK. */
export async function readOAuthTokenState(
  db: D1Database,
  orgId: string,
  connectionId: string,
): Promise<OAuthTokenState | null> {
  if (!(await hasOAuthTokensTable(db))) return null;
  const row = await db
    .prepare(
      "SELECT connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,scope,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at,updated_at FROM oauth_tokens WHERE org_id=? AND connection_id=?",
    )
    .bind(orgId, connectionId)
    .first<OAuthTokenRow>();
  if (!row) return null;
  return toState(row);
}

/** Load and decrypt one owned Connection's tokens. Exact org + Connection
 * scoping: foreign rows resolve to null, never to someone else's tokens.
 * Corrupt rows fail loud (never partial tokens, never plaintext fallbacks).
 * Callers register the returned values with the execution-scoped registry
 * (or pass `executionId` on the high-level paths, which register for them)
 * and drop them after the vendor call. */
export async function loadOAuthToken(
  db: D1Database,
  orgId: string,
  connectionId: string,
  keks: Readonly<Record<number, string>>,
): Promise<PersistedOAuthToken | null> {
  if (!(await hasOAuthTokensTable(db))) return null;
  const row = await db
    .prepare(
      "SELECT connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,scope,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at,updated_at FROM oauth_tokens WHERE org_id=? AND connection_id=?",
    )
    .bind(orgId, connectionId)
    .first<OAuthTokenRow>();
  if (!row) return null;
  const state = toState(row);
  const accessToken = await decryptField(
    orgId,
    connectionId,
    ACCESS_FIELD,
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
      throw invalid("OAUTH_TOKEN_UNREADABLE", "A stored OAuth token could not be decrypted.", 500);
    }
    refreshToken = await decryptField(
      orgId,
      connectionId,
      REFRESH_FIELD,
      row.refresh_ciphertext,
      row.refresh_nonce,
      row.refresh_wrapped_dek,
      row.key_version,
      row.algorithm,
      keks,
    );
  }
  return Object.freeze({ ...state, accessToken, ...(refreshToken === undefined ? {} : { refreshToken }) });
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
    throw invalid("OAUTH_REQUEST_INVALID", `The OAuth ${name} is invalid.`);
  }
  return value;
}

function requireScopeValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 1024) {
    throw invalid("OAUTH_SCOPE_INVALID", "The requested OAuth scope is invalid.");
  }
  return value;
}

export interface StoreOAuthTokenInput {
  readonly orgId: string;
  readonly connectionId: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly expiresAtMs?: number;
  readonly kekMaterial: string | undefined;
  readonly checkedAt: string;
}

/** Persist the first token for one owned Connection as generation 1 with a
 * healthy lifecycle. A second initial store for the same Connection fails
 * with OAUTH_TOKEN_EXISTS: rotation goes through `replaceOAuthToken` with
 * the expected generation, never through a blind overwrite. */
export async function storeInitialOAuthToken(db: D1Database, input: StoreOAuthTokenInput): Promise<OAuthTokenState> {
  const kek = requireKek(input.kekMaterial);
  const accessToken = requireTokenValue(input.accessToken, "access token");
  const refreshToken =
    input.refreshToken === undefined ? undefined : requireTokenValue(input.refreshToken, "refresh token");
  const scope = requireScopeValue(input.scope);
  const owned = await ownedConnectionId(db, input.orgId, input.connectionId);
  if (!owned) throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  const existing = await db
    .prepare("SELECT generation FROM oauth_tokens WHERE org_id=? AND connection_id=?")
    .bind(input.orgId, input.connectionId)
    .first<{ generation: number }>();
  if (existing) throw invalid("OAUTH_TOKEN_EXISTS", "An OAuth token is already stored for this Connection.", 409);
  const access = await encryptConnectionSecret({
    orgId: input.orgId,
    connectionId: input.connectionId,
    field: ACCESS_FIELD,
    plaintext: accessToken,
    kekMaterial: kek,
  });
  let refresh: { ciphertext: string; nonce: string; wrappedDek: string } | null = null;
  if (refreshToken !== undefined) {
    const envelope = await encryptConnectionSecret({
      orgId: input.orgId,
      connectionId: input.connectionId,
      field: REFRESH_FIELD,
      plaintext: refreshToken,
      kekMaterial: kek,
    });
    refresh = { ciphertext: envelope.ciphertext, nonce: envelope.nonce, wrappedDek: envelope.wrappedDek };
  }
  const health = recordTokenSuccess(initialTokenHealth(input.checkedAt), input.checkedAt);
  await db
    .prepare(
      "INSERT INTO oauth_tokens(connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,scope,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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

export interface ReplaceOAuthTokenInput extends StoreOAuthTokenInput {
  /** The generation the caller rotated from. The write lands only when the
   * persisted generation still equals this value; a superseded caller
   * observes OAUTH_TOKEN_GENERATION_STALE and the newer row stands. */
  readonly expectedGeneration: number;
}

/** Persist a rotated replacement and advance the generation by exactly one.
 * Success recovers the lifecycle to healthy. The conditional write is the
 * fencing primitive: no lock, no transaction across vendor HTTP — the D1 row
 * itself arbitrates, and losers fail loud instead of overwriting newer
 * tokens. */
export async function replaceOAuthToken(db: D1Database, input: ReplaceOAuthTokenInput): Promise<OAuthTokenState> {
  const kek = requireKek(input.kekMaterial);
  const accessToken = requireTokenValue(input.accessToken, "access token");
  const refreshToken =
    input.refreshToken === undefined ? undefined : requireTokenValue(input.refreshToken, "refresh token");
  const scope = requireScopeValue(input.scope);
  if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth request is invalid.");
  }
  const owned = await ownedConnectionId(db, input.orgId, input.connectionId);
  if (!owned) throw invalid("CONNECTION_NOT_FOUND", "No Connection exists for this Organization and Integration.", 404);
  const access = await encryptConnectionSecret({
    orgId: input.orgId,
    connectionId: input.connectionId,
    field: ACCESS_FIELD,
    plaintext: accessToken,
    kekMaterial: kek,
  });
  let refresh: { ciphertext: string; nonce: string; wrappedDek: string } | null = null;
  if (refreshToken !== undefined) {
    const envelope = await encryptConnectionSecret({
      orgId: input.orgId,
      connectionId: input.connectionId,
      field: REFRESH_FIELD,
      plaintext: refreshToken,
      kekMaterial: kek,
    });
    refresh = { ciphertext: envelope.ciphertext, nonce: envelope.nonce, wrappedDek: envelope.wrappedDek };
  }
  const health = recordTokenSuccess(initialTokenHealth(input.checkedAt), input.checkedAt);
  const applied = await db
    .prepare(
      "UPDATE oauth_tokens SET access_ciphertext=?,access_nonce=?,access_wrapped_dek=?,refresh_ciphertext=?,refresh_nonce=?,refresh_wrapped_dek=?,key_version=?,algorithm=?,generation=?,scope=?,expires_at_ms=?,status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND generation=?",
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
      .prepare("SELECT generation FROM oauth_tokens WHERE org_id=? AND connection_id=?")
      .bind(input.orgId, input.connectionId)
      .first<{ generation: number }>();
    if (!current) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
    throw invalid("OAUTH_TOKEN_GENERATION_STALE", "A newer OAuth token generation already replaced this one.", 409);
  }
  return Object.freeze({
    generation: input.expectedGeneration + 1,
    scope,
    ...(input.expiresAtMs === undefined ? {} : { expiresAtMs: input.expiresAtMs }),
    health,
  });
}

/** Persist a failed token use: marks failed, counts consecutively, keeps the
 * vendor failure code for remediation copy. Health columns only — ciphertext
 * is untouched, so a later successful rotation still recovers the row.
 *
 * When `expectedGeneration` is supplied the write is a compare-and-swap on
 * the health observed before the vendor call (`UPDATE ... WHERE
 * generation=? AND status=? AND consecutive_failures=? AND
 * last_failure_code IS ?`): an operation that started on generation N but
 * lands after a newer generation replaced it observes
 * OAUTH_TOKEN_GENERATION_STALE and the newer row stands untouched. When the
 * generation still matches but the health moved underneath — a concurrent
 * same-generation revocation the fence does not serialize — the losing
 * failure still records its outcome as diagnostic metadata (issue #451):
 * an atomic generation-guarded increment merges the consecutive count plus
 * the vendor code onto the committed row without moving its status, so
 * revoked stays terminal while the failure evidence is preserved. The
 * committed row is then reread and its health returned: a failure computed
 * from a superseded healthy read must not overwrite a committed revoked
 * state, and callers always observe authoritative committed state rather
 * than a pre-write projection. No new outcome code either way. The compare
 * must run against the pre-vendor observation (`expectedHealth`, carried
 * through from the read before vendor HTTP), never against a write-time
 * re-read that would trivially match its own successor. Vendor-coupled
 * callers (refresh around vendor HTTP) always supply both; direct operator
 * writes with no vendor HTTP in between may omit both, in which case the
 * compare runs against the freshly read row. */
export async function recordOAuthTokenFailure(
  db: D1Database,
  orgId: string,
  connectionId: string,
  code: string,
  checkedAt: string,
  expectedGeneration?: number,
  expectedHealth?: TokenHealth,
): Promise<TokenHealth> {
  if (typeof code !== "string" || code.length === 0 || code.length > 128) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth request is invalid.");
  }
  if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 1)) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth request is invalid.");
  }
  if (
    expectedHealth !== undefined &&
    expectedHealth.status !== "healthy" &&
    expectedHealth.status !== "failed" &&
    expectedHealth.status !== "revoked"
  ) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth request is invalid.");
  }
  const state = await readOAuthTokenState(db, orgId, connectionId);
  if (!state) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
  const next = recordTokenFailure(state.health, code, checkedAt);
  if (expectedGeneration === undefined) {
    await db
      .prepare(
        "UPDATE oauth_tokens SET status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=?",
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
      )
      .run();
    return next;
  }
  const observed = expectedHealth ?? state.health;
  const applied = await db
    .prepare(
      "UPDATE oauth_tokens SET status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND generation=? AND status=? AND consecutive_failures=? AND last_failure_code IS ?",
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
      observed.status,
      observed.consecutiveFailures,
      observed.lastFailureCode,
    )
    .run();
  if (applied.meta.changes === 0) {
    const current = await readOAuthTokenState(db, orgId, connectionId);
    if (!current) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
    if (current.generation !== expectedGeneration) {
      throw invalid("OAUTH_TOKEN_GENERATION_STALE", "A newer OAuth token generation already replaced this one.", 409);
    }
    // Same-generation race (issue #451): revoked wins the status, but the
    // losing failure records its outcome. The merge touches diagnostic
    // columns only — status is never moved, so a committed revoked state
    // survives — and the atomic increment keeps concurrent losers honest
    // without a transaction. A replacement landing between the conflict
    // read and this write matches zero rows on the old generation, and the
    // reread below then observes the newer generation and fails stale, so
    // the fencing authority still wins over the stale vendor outcome.
    await db
      .prepare(
        "UPDATE oauth_tokens SET consecutive_failures=consecutive_failures+1,last_failure_code=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND generation=?",
      )
      .bind(code, checkedAt, checkedAt, orgId, connectionId, expectedGeneration)
      .run();
    const committed = await readOAuthTokenState(db, orgId, connectionId);
    if (!committed) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
    if (committed.generation !== expectedGeneration) {
      throw invalid("OAUTH_TOKEN_GENERATION_STALE", "A newer OAuth token generation already replaced this one.", 409);
    }
    return committed.health;
  }
  return next;
}

/** Persist an explicit revocation: terminal until a fresh authorization (a
 * new initial store or a successful replacement) succeeds. Connection
 * identity is untouched — only the health status moves.
 *
 * When `expectedGeneration` is supplied the write stays conditional on the
 * persisted generation (`UPDATE ... WHERE generation=?`): a revocation that
 * started on generation N but lands after a newer generation replaced it
 * observes OAUTH_TOKEN_GENERATION_STALE and the newer row — whose token the
 * vendor never confirmed revoked — stays healthy and usable. The conditional
 * write sets only the status and write stamps, preserving the committed
 * failure counters, code, and success instant by construction: a revocation
 * computed from a pre-vendor read can never restore stale diagnostics over a
 * concurrently committed failure. The returned health is reread from the
 * committed row. Vendor-coupled callers always supply the generation they
 * read before the vendor call; direct operator writes with no vendor HTTP in
 * between may omit it. */
export async function recordOAuthTokenRevoked(
  db: D1Database,
  orgId: string,
  connectionId: string,
  checkedAt: string,
  expectedGeneration?: number,
): Promise<TokenHealth> {
  if (expectedGeneration !== undefined && (!Number.isInteger(expectedGeneration) || expectedGeneration < 1)) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth request is invalid.");
  }
  const state = await readOAuthTokenState(db, orgId, connectionId);
  if (!state) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
  const next = recordTokenRevoked(state.health, checkedAt);
  if (expectedGeneration === undefined) {
    await db
      .prepare(
        "UPDATE oauth_tokens SET status=?,consecutive_failures=?,last_failure_code=?,last_success_at=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=?",
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
      )
      .run();
    return next;
  }
  const applied = await db
    .prepare(
      "UPDATE oauth_tokens SET status=?,checked_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND generation=?",
    )
    .bind(next.status, checkedAt, checkedAt, orgId, connectionId, expectedGeneration)
    .run();
  if (applied.meta.changes === 0) {
    const current = await db
      .prepare("SELECT generation FROM oauth_tokens WHERE org_id=? AND connection_id=?")
      .bind(orgId, connectionId)
      .first<{ generation: number }>();
    if (!current) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
    throw invalid("OAUTH_TOKEN_GENERATION_STALE", "A newer OAuth token generation already replaced this one.", 409);
  }
  const committed = await readOAuthTokenState(db, orgId, connectionId);
  if (!committed) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
  return committed.health;
}

/** Delete a Connection's stored tokens. Called explicitly beside the
 * Connection delete (belt beside the FK cascade, which D1 may not enforce).
 * Pre-0031 chains skip via the table check. */
export async function deleteOAuthTokens(db: D1Database, connectionId: string): Promise<void> {
  if (!(await hasOAuthTokensTable(db))) return;
  await db.prepare("DELETE FROM oauth_tokens WHERE connection_id=?").bind(connectionId).run();
}

/** Non-secret persisted health for one Connection's token: the aggregate
 * input. No ciphertext columns are selected, so aggregation never observes
 * — let alone decrypts — token material. */
export interface PersistedOAuthHealth {
  readonly connectionId: string;
  readonly status: TokenHealthStatus;
}

/** Read the non-secret health of every persisted OAuth token (OAUTH-01
 * Integration-list aggregate, issue #149). Pre-0031 chains resolve to no
 * rows; an unknown persisted status fails loud (never silently dropped
 * from the counts) exactly like the single-row read. */
export async function readAllOAuthTokenHealth(db: D1Database): Promise<readonly PersistedOAuthHealth[]> {
  if (!(await hasOAuthTokensTable(db))) return Object.freeze([]);
  const found = await db
    .prepare("SELECT connection_id,status FROM oauth_tokens")
    .all<{ connection_id: string; status: string }>();
  const rows: PersistedOAuthHealth[] = [];
  for (const row of found.results) {
    if (row.status !== "healthy" && row.status !== "failed" && row.status !== "revoked") {
      throw invalid("OAUTH_TOKEN_UNREADABLE", "A stored OAuth token could not be read.", 500);
    }
    rows.push({ connectionId: row.connection_id, status: row.status });
  }
  return Object.freeze(rows);
}

export interface RefreshPersistedTokenRequest {
  readonly orgId: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly tokenPath: string;
  /** Scope override for this rotation (replacement, never subset). Defaults
   * to the stored scope; omitted entirely when neither is set. */
  readonly scope?: string;
  readonly credentials: OAuthClientCredentials;
  readonly faults: OAuthFaultTable;
  readonly keks: Readonly<Record<number, string>>;
  readonly kekMaterial: string | undefined;
  /** Non-secret tenant key fencing concurrent rotations. Defaults to orgId. */
  readonly tenantKey?: string;
  readonly fence?: OAuthRefreshFenceBinding;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Execution registering the transient tokens for write-time scrubbing. */
  readonly executionId?: string;
  readonly checkedAt?: string;
}

export interface RefreshedPersistedToken {
  readonly token: OAuthToken;
  readonly rotated: boolean;
  readonly refreshToken: string;
  readonly generation: number;
  readonly health: TokenHealth;
}

/** Rotate a persisted token end to end: D1 read, vendor refresh, D1
 * conditional replacement. No D1 transaction is held across the vendor call —
 * the three phases are separate statements with the vendor HTTP between
 * them, and the final write re-arbitrates on the persisted generation.
 *
 * - Failed or revoked credentials fail closed before any vendor call
 *   (OAUTH_TOKEN_UNUSABLE); a missing refresh token answers
 *   OAUTH_REFRESH_UNAVAILABLE.
 * - A vendor Fault persists the failure lifecycle honestly
 *   (failed + consecutive count + code) and then rethrows. Raw transport
 *   errors propagate without a health write: reachability is unknown, so the
 *   credential must not be marked failed on a network error. The failure
 *   write carries the generation plus the health observed before the vendor
 *   call, so a failure that lands after a newer generation replaced the row
 *   observes OAUTH_TOKEN_GENERATION_STALE instead — the fencing authority
 *   wins over the stale vendor outcome and the newer row stands untouched.
 *   A failure that lands after a same-generation revocation drops its stale
 *   transition and keeps the committed health (authoritative reread).
 * - A superseded racer (its generation already replaced) observes
 *   OAUTH_TOKEN_GENERATION_STALE from the conditional write; the newer row
 *   stands untouched. */
export async function refreshPersistedOAuthToken(
  db: D1Database,
  request: RefreshPersistedTokenRequest,
): Promise<RefreshedPersistedToken> {
  const checkedAt = request.checkedAt ?? new Date().toISOString();
  const loaded = await loadOAuthToken(db, request.orgId, request.connectionId, request.keks);
  if (!loaded) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
  if (!isTokenUsable(loaded.health)) {
    throw invalid("OAUTH_TOKEN_UNUSABLE", "The stored OAuth credential is not usable.", 409, {
      status: loaded.health.status,
    });
  }
  if (loaded.refreshToken === undefined) {
    throw invalid("OAUTH_REFRESH_UNAVAILABLE", "This Connection holds no refresh token to rotate.", 409);
  }
  const submitted = loaded.refreshToken;
  if (request.executionId !== undefined) registerExecutionSecrets(request.executionId, [submitted]);
  const scope = request.scope ?? (loaded.scope === "" ? undefined : loaded.scope);
  let rotated: RotatedToken;
  try {
    rotated = await refreshRotatingToken({
      endpoint: request.endpoint,
      tokenPath: request.tokenPath,
      refreshToken: submitted,
      tenantKey: request.tenantKey ?? request.orgId,
      generation: String(loaded.generation),
      ...(scope === undefined ? {} : { scope }),
      credentials: request.credentials,
      faults: request.faults,
      ...(request.fence === undefined ? {} : { fence: request.fence }),
      ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
  } catch (error) {
    if (error instanceof Fault) {
      await recordOAuthTokenFailure(
        db,
        request.orgId,
        request.connectionId,
        error.code,
        checkedAt,
        loaded.generation,
        loaded.health,
      );
    }
    throw error;
  }
  if (request.executionId !== undefined) {
    registerExecutionSecrets(request.executionId, [
      rotated.token.accessToken,
      ...(rotated.token.refreshToken === undefined ? [] : [rotated.token.refreshToken]),
    ]);
  }
  const stored = await replaceOAuthToken(db, {
    orgId: request.orgId,
    connectionId: request.connectionId,
    expectedGeneration: loaded.generation,
    accessToken: rotated.token.accessToken,
    ...(rotated.token.refreshToken === undefined ? {} : { refreshToken: rotated.token.refreshToken }),
    ...(scope === undefined ? {} : { scope }),
    ...(rotated.token.expiresAtMs === undefined ? {} : { expiresAtMs: rotated.token.expiresAtMs }),
    kekMaterial: request.kekMaterial,
    checkedAt,
  });
  return Object.freeze({
    token: rotated.token,
    rotated: rotated.rotated,
    refreshToken: rotated.refreshToken,
    generation: stored.generation,
    health: stored.health,
  });
}

export interface RevokePersistedTokenRequest {
  readonly orgId: string;
  readonly connectionId: string;
  readonly endpoint: string;
  readonly revocationPath: string;
  readonly keks: Readonly<Record<number, string>>;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly executionId?: string;
  readonly checkedAt?: string;
}

/** Ask the vendor to invalidate the persisted access token, then persist the
 * revoked lifecycle. A vendor revocation failure rethrows without touching
 * health: only a confirmed revoke (or an explicit operator decision via
 * `recordOAuthTokenRevoked`) moves the credential to revoked. The revoked
 * write carries the generation read before the vendor call, so a revocation
 * that lands after a newer generation replaced the row observes
 * OAUTH_TOKEN_GENERATION_STALE instead — the vendor only confirmed
 * revocation of the older token, never the replacement. */
export async function revokePersistedOAuthToken(
  db: D1Database,
  request: RevokePersistedTokenRequest,
): Promise<{ readonly revoked: true; readonly health: TokenHealth }> {
  const checkedAt = request.checkedAt ?? new Date().toISOString();
  const loaded = await loadOAuthToken(db, request.orgId, request.connectionId, request.keks);
  if (!loaded) throw invalid("OAUTH_TOKEN_NOT_FOUND", "No OAuth token is stored for this Connection.", 404);
  if (request.executionId !== undefined) registerExecutionSecrets(request.executionId, [loaded.accessToken]);
  await revokeOAuthToken({
    endpoint: request.endpoint,
    revocationPath: request.revocationPath,
    token: loaded.accessToken,
    ...(request.clientId === undefined ? {} : { clientId: request.clientId }),
    ...(request.clientSecret === undefined ? {} : { clientSecret: request.clientSecret }),
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  const health = await recordOAuthTokenRevoked(db, request.orgId, request.connectionId, checkedAt, loaded.generation);
  return Object.freeze({ revoked: true as const, health });
}
