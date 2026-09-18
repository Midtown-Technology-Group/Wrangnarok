// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171): MCP OAuth consent — per-user authorization-code
// consent plus service credential connect (upstream `mcp_oauth_callback.py`
// + `mcp_connections.py` connect branches, pins in docs/upstream-spec.md
// §23).
//
// The Worker half reuses the OAUTH-01 primitives, never forks them: PKCE,
// state, authorization-URL building, callback validation, and the code
// exchange all run through `src/oauth.ts`. What differs from
// `src/oauth-consent.ts` is only the persistence target (the MCP consent
// and service-token envelopes in `src/mcp-tokens.ts`, keyed by MCP
// Connection instead of Integration mapping).
//
// Rotate on consent: every successful callback replaces the stored
// credential at generation + 1 through the conditional write (the OAUTH-01
// adaptation of the upstream orphan-row insert — Connection identity
// survives, only the health status moves). Disconnect is idempotent and
// deletes the credential row plus its token material; vendor-side
// revocation calls are an explicit non-goal for v0 (no revocation path is
// stored on the Connection — named follow-up in the ADR).
import { Fault, UUID } from "./domain";
import type { Principal } from "./domain";
import { ENVELOPE_KEY_VERSION } from "./envelope";
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  parseOAuthCallback,
} from "./oauth";
import { MCP_TOKEN_FAULTS } from "./mcp-dispatch";
import { resolveMcpConnectionClientSecret } from "./mcp-connections";
import {
  disconnectMcpUserConsent,
  readMcpServiceTokenState,
  readMcpUserConsent,
  replaceMcpServiceToken,
  replaceMcpUserConsentToken,
  storeInitialMcpServiceToken,
  storeInitialMcpUserConsent,
} from "./mcp-tokens";
import type { McpConsentView, McpTokenState } from "./mcp-tokens";
import { connectMcpClientCredentials } from "./mcp-dispatch";

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function requireField(value: unknown, maxLength: number, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalid("MCP_CONSENT_INVALID", message);
  }
  return value;
}

/** Absolute http(s) URL without credentials (operator-navigated authorize
 * endpoint or vendor redirect target — the Worker never fetches either). */
function requireAbsoluteUrl(value: unknown, message: string): string {
  const uri = requireField(value, 2048, message);
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalid("MCP_CONSENT_INVALID", message);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw invalid("MCP_CONSENT_INVALID", message);
  }
  return uri;
}

interface OwnedConnection {
  readonly id: string;
  readonly org_id: string;
  readonly server_url: string;
  readonly token_path: string | null;
  readonly client_id: string | null;
  readonly provider_flow: string;
}

/** Load one owned Connection with its template URL for the consent path.
 * Unknown or foreign ids answer 404, never a leak. */
async function ownedConnection(db: D1Database, caller: Principal, connectionId: string): Promise<OwnedConnection> {
  if (!UUID.test(connectionId)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  const row = await db
    .prepare(
      "SELECT c.id AS id,c.org_id AS org_id,t.server_url AS server_url,c.server_url_override AS server_url_override,c.token_path AS token_path,c.client_id AS client_id,t.provider_flow AS provider_flow FROM mcp_connections c JOIN mcp_server_templates t ON t.id=c.server_id WHERE c.org_id=? AND c.id=?",
    )
    .bind(caller.orgId, connectionId)
    .first<{
      id: string;
      org_id: string;
      server_url: string;
      server_url_override: string | null;
      token_path: string | null;
      client_id: string | null;
      provider_flow: string;
    }>();
  if (!row) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  return {
    id: row.id,
    org_id: row.org_id,
    server_url: row.server_url_override ?? row.server_url,
    token_path: row.token_path,
    client_id: row.client_id,
    provider_flow: row.provider_flow,
  };
}

export interface McpAuthorizeRequest {
  readonly connectionId: string;
  readonly authorizeEndpoint: unknown;
  readonly redirectUri: unknown;
  readonly scope?: unknown;
}

export interface McpAuthorizeResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
}

/** Issue the vendor authorization URL for one user's own consent. Pure
 * apart from the ownership read: mints PKCE plus state through the shared
 * primitives and returns the consent session (state + verifier) for the
 * operator to hold. `client_credentials` Connections answer
 * MCP_USER_CONSENT_UNSUPPORTED — no per-user mode exists for that flow. */
export async function authorizeMcpUserConsent(
  db: D1Database,
  caller: Principal,
  request: McpAuthorizeRequest,
): Promise<McpAuthorizeResult> {
  const connection = await ownedConnection(db, caller, request.connectionId);
  if (connection.provider_flow !== "authorization_code") {
    throw invalid("MCP_USER_CONSENT_UNSUPPORTED", "This Connection has no per-user consent mode.", 400);
  }
  if (connection.client_id === null) {
    throw invalid("MCP_MISCONFIGURED", "Configure a client ID on this Connection before consent.", 424);
  }
  const authorizeEndpoint = requireAbsoluteUrl(request.authorizeEndpoint, "The authorize endpoint is invalid.");
  const redirectUri = requireAbsoluteUrl(request.redirectUri, "The redirect URI is invalid.");
  const scope = request.scope === undefined ? undefined : requireField(request.scope, 1024, "The scope is invalid.");
  const pair = await createPkcePair();
  const state = createOAuthState();
  const authorizationUrl = buildAuthorizationUrl({
    authorizeEndpoint,
    clientId: connection.client_id,
    redirectUri,
    scope: scope ?? "",
    state,
    codeChallenge: pair.challenge,
    codeChallengeMethod: "S256",
  });
  return Object.freeze({ authorizationUrl, state, codeVerifier: pair.verifier });
}

export interface McpCallbackRequest {
  readonly connectionId: string;
  readonly code?: unknown;
  readonly state?: unknown;
  readonly expectedState: unknown;
  readonly error?: unknown;
  readonly errorDescription?: unknown;
  readonly codeVerifier: unknown;
  readonly redirectUri: unknown;
  readonly scope?: unknown;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Validate the authorization response, spend the single-use code in
 * exactly one vendor POST, and persist the consented credential. Ordering
 * mirrors `handleOAuthCallback`: pure validation plus secret/KEK
 * resolution run before the vendor call, so a doomed exchange never burns
 * the operator's single-use code; the token lands through the initial
 * store (first consent) or the generation-fenced replacement (re-consent)
 * with no D1 transaction held across vendor HTTP. */
export async function completeMcpUserConsent(
  db: D1Database,
  caller: Principal,
  request: McpCallbackRequest,
  env: { readonly SECRETS_KEK?: string },
): Promise<McpConsentView> {
  const connection = await ownedConnection(db, caller, request.connectionId);
  if (connection.provider_flow !== "authorization_code") {
    throw invalid("MCP_USER_CONSENT_UNSUPPORTED", "This Connection has no per-user consent mode.", 400);
  }
  if (connection.client_id === null || connection.token_path === null) {
    throw invalid("MCP_MISCONFIGURED", "Configure a client ID and token path on this Connection before consent.", 424);
  }
  const expectedState = requireField(request.expectedState, 256, "The consent session is invalid.");
  const { code } = parseOAuthCallback({
    code: request.code,
    state: request.state,
    expectedState,
    error: request.error,
    errorDescription: request.errorDescription,
  });
  const codeVerifier = requireField(request.codeVerifier, 128, "The consent session is invalid.");
  const redirectUri = requireAbsoluteUrl(request.redirectUri, "The redirect URI is invalid.");
  const scope = request.scope === undefined ? undefined : requireField(request.scope, 1024, "The scope is invalid.");
  const kekMaterial = env.SECRETS_KEK;
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) {
    throw invalid(
      "SECRET_STORE_NOT_CONFIGURED",
      "The per-Organization secret store is not configured for this environment.",
      502,
    );
  }
  const clientSecret = await resolveMcpConnectionClientSecret(db, caller.orgId, connection.id, {
    [ENVELOPE_KEY_VERSION]: kekMaterial,
  });
  if (clientSecret === null) {
    const text = MCP_TOKEN_FAULTS.notConfigured;
    throw new Fault(text.status, text.code, text.message);
  }
  const current = await readMcpUserConsent(db, caller.orgId, connection.id, caller.userId);
  const issued = await exchangeAuthorizationCode({
    endpoint: connection.server_url,
    tokenPath: connection.token_path,
    code,
    redirectUri,
    codeVerifier,
    ...(scope === undefined ? {} : { scope }),
    credentials: { clientId: connection.client_id, clientSecret },
    faults: MCP_TOKEN_FAULTS,
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  const checkedAt = new Date().toISOString();
  const issuedScope = scope ?? "";
  if (current === null) {
    return storeInitialMcpUserConsent(db, {
      orgId: caller.orgId,
      connectionId: connection.id,
      userId: caller.userId,
      accessToken: issued.accessToken,
      ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
      scope: issuedScope,
      ...(issued.expiresAtMs === undefined ? {} : { expiresAtMs: issued.expiresAtMs }),
      kekMaterial,
      checkedAt,
    });
  }
  return replaceMcpUserConsentToken(db, {
    orgId: caller.orgId,
    connectionId: connection.id,
    userId: caller.userId,
    expectedGeneration: current.generation,
    accessToken: issued.accessToken,
    ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
    scope: issuedScope,
    ...(issued.expiresAtMs === undefined ? {} : { expiresAtMs: issued.expiresAtMs }),
    kekMaterial,
    checkedAt,
  });
}

/** Disconnect one user's own consent: idempotent delete of the consent
 * row plus its token material. Missing consent still answers success. */
export async function disconnectMcpUserConsentSelf(
  db: D1Database,
  caller: Principal,
  connectionId: string,
): Promise<{ readonly disconnected: true }> {
  if (!UUID.test(connectionId)) throw invalid("MCP_CONNECTION_NOT_FOUND", "Unknown MCP Connection.", 404);
  return disconnectMcpUserConsent(db, caller.orgId, connectionId, caller.userId);
}

export interface McpServiceConnectRequest {
  readonly connectionId: string;
  readonly scope?: unknown;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Connect the service credential for one owned Connection
 * (`client_credentials` flow only — the synchronous server-to-server
 * exchange; per-user mode does not exist here). First connect stores at
 * generation 1; reconnecting replaces through the fenced write. */
export async function connectMcpServiceCredential(
  db: D1Database,
  caller: Principal,
  request: McpServiceConnectRequest,
  env: { readonly SECRETS_KEK?: string },
): Promise<McpTokenState> {
  const connection = await ownedConnection(db, caller, request.connectionId);
  if (connection.provider_flow !== "client_credentials") {
    throw invalid(
      "MCP_SERVICE_CONNECT_UNSUPPORTED",
      "Service connect needs a client_credentials Connection; per-user consent covers authorization_code.",
      400,
    );
  }
  if (connection.client_id === null || connection.token_path === null) {
    throw invalid("MCP_MISCONFIGURED", "Configure a client ID and token path on this Connection first.", 424);
  }
  const scope = request.scope === undefined ? undefined : requireField(request.scope, 1024, "The scope is invalid.");
  const kekMaterial = env.SECRETS_KEK;
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) {
    throw invalid(
      "SECRET_STORE_NOT_CONFIGURED",
      "The per-Organization secret store is not configured for this environment.",
      502,
    );
  }
  const clientSecret = await resolveMcpConnectionClientSecret(db, caller.orgId, connection.id, {
    [ENVELOPE_KEY_VERSION]: kekMaterial,
  });
  if (clientSecret === null) {
    const text = MCP_TOKEN_FAULTS.notConfigured;
    throw new Fault(text.status, text.code, text.message);
  }
  const issued = await connectMcpClientCredentials(
    connection.server_url,
    connection.token_path,
    {
      clientId: connection.client_id,
      clientSecret,
    },
    scope,
    {
      ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    },
  );
  const checkedAt = new Date().toISOString();
  const issuedScope = scope ?? "";
  const current = await readMcpServiceTokenState(db, caller.orgId, connection.id);
  if (current === null) {
    return storeInitialMcpServiceToken(db, {
      orgId: caller.orgId,
      connectionId: connection.id,
      accessToken: issued.accessToken,
      ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
      scope: issuedScope,
      ...(issued.expiresAtMs === undefined ? {} : { expiresAtMs: issued.expiresAtMs }),
      kekMaterial,
      checkedAt,
    });
  }
  return replaceMcpServiceToken(db, {
    orgId: caller.orgId,
    connectionId: connection.id,
    expectedGeneration: current.generation,
    accessToken: issued.accessToken,
    ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
    scope: issuedScope,
    ...(issued.expiresAtMs === undefined ? {} : { expiresAtMs: issued.expiresAtMs }),
    kekMaterial,
    checkedAt,
  });
}
