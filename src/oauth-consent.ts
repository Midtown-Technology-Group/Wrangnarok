// SPDX-License-Identifier: AGPL-3.0
// Operator auth-code consent (OAUTH-01 slice, issue #149): the Worker half of
// the authorization-code flow for one owned Connection.
//
// Upstream pins per-mapping authorize plus an Integration-list health summary
// over the default connection and distinct per-mapping overrides (PR #762).
// Wrangnarok has no provider-config table and no global/default OAuth token
// (ADR 003: exact-org resolution, no global fallback), so consent here is an
// operator-driven admin API with validated operator-supplied vendor
// parameters — no invented per-Integration authorize metadata, no new tables:
//
// - Authorize issuance mints PKCE (S256) plus state and returns the vendor
//   authorization URL. Pure: no D1 writes, no KEK, no vendor contact. The
//   operator holds the consent session (state + verifier) between the calls;
//   the Worker persists nothing until a consented token lands.
// - Callback validates the authorization response (fixed Faults, vendor prose
//   never copied), spends the single-use code in exactly one vendor POST,
//   and persists the issued token through the existing generation-fenced
//   write path (initial store or conditional replacement).
//
// Trust notes (see ADR 005 OAuth section): both routes are admin-only under
// the same caller gate as the /api/connections boundary. The client secret
// is resolved server-side (per-Organization ciphertext first, deployment
// credential second — the one secrets path) and is never accepted in a
// request body. The token endpoint is a same-host path resolved against the
// Connection endpoint, so the exchange POST cannot carry the client secret
// to an operator-chosen host; the authorize endpoint is operator-navigated
// (the Worker never fetches it) and stays an absolute http(s) URL. Callback
// responses carry non-secret persisted state only — token values are never
// returned, logged, or persisted outside the envelope rows.
import { Fault } from "./domain";
import type { Principal } from "./domain";
import { integrationById } from "./integrations";
import { getConnection, resolveConnectionSecrets, type SecretEnv } from "./connections";
import { ENVELOPE_KEY_VERSION } from "./envelope";
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  parseOAuthCallback,
} from "./oauth";
import type { OAuthFaultTable, TokenHealth } from "./oauth";
import { readOAuthTokenState, replaceOAuthToken, storeInitialOAuthToken } from "./oauth-tokens";

/** Deployment surface read by the consent exchange: the per-environment KEK
 * plus the provider-global credential env vars (read through the narrow
 * cast below — Bindings carries no index signature). */
export interface ConsentEnv extends SecretEnv {
  readonly SECRETS_KEK?: string;
}

/** Declared secret-field name carrying the OAuth client secret. Integrations
 * whose credentials are API keys or tokens under other names do not offer
 * authorization-code consent: extending this allowlist is explicit. */
const OAUTH_CLIENT_SECRET_FIELD = "clientSecret";

/** Vendor Fault taxonomy for the consent exchange. This route is a new
 * operator surface with no provider taxonomy to preserve, so failures speak
 * generic OAUTH_* codes with fixed messages — vendor bodies are never
 * copied, matching the centralized primitive's shaping discipline. */
export const OAUTH_CONSENT_FAULTS: OAuthFaultTable = {
  notConfigured: {
    status: 502,
    code: "OAUTH_NOT_CONFIGURED",
    message: "The OAuth client secret is not configured for this Connection.",
  },
  redirected: { status: 502, code: "OAUTH_VENDOR_REDIRECTED", message: "The vendor redirected the token request." },
  unauthorized: {
    status: 502,
    code: "OAUTH_VENDOR_UNAUTHORIZED",
    message: "The vendor rejected the OAuth credentials.",
  },
  rateLimited: {
    status: 502,
    code: "OAUTH_VENDOR_RATE_LIMITED",
    message: "The vendor rate-limited the token request.",
  },
  authFailed: {
    status: 502,
    code: "OAUTH_EXCHANGE_FAILED",
    message: "The vendor did not issue a token for this authorization code.",
  },
  badResponse: {
    status: 502,
    code: "OAUTH_VENDOR_BAD_RESPONSE",
    message: "The vendor returned an unexpected token response.",
  },
  vendorTimeout: { status: 504, code: "OAUTH_VENDOR_TIMEOUT", message: "The vendor exceeded its deadline." },
};

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

function requireField(value: unknown, maxLength: number, code: string, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalid(code, message);
  }
  return value;
}

/** Validate the operator's frontend callback URL: absolute http(s), never
 * credential-bearing. The Worker never fetches it — the vendor redirects
 * the operator's browser there — but garbage fails here, not at the vendor. */
function requireRedirectUri(value: unknown): string {
  const uri = requireField(value, 2048, "OAUTH_REQUEST_INVALID", "The OAuth redirect URI is invalid.");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth redirect URI is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth redirect URI is invalid.");
  }
  return uri;
}

/** Validate the operator-supplied authorize endpoint: absolute http(s),
 * never credential-bearing. The `{tenant}` template (if any) is replaced
 * with a placeholder for the shape check — the primitive still owns tenant
 * substitution plus charset validation. Operator input fails here with
 * 400, never as a 500 from the shared primitive. */
function requireAuthorizeEndpoint(value: unknown): string {
  const endpoint = requireField(value, 2048, "OAUTH_REQUEST_INVALID", "The OAuth authorize endpoint is invalid.");
  let url: URL;
  try {
    url = new URL(endpoint.split("{tenant}").join("tenant"));
  } catch {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth authorize endpoint is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth authorize endpoint is invalid.");
  }
  return endpoint;
}

/** Validate the token endpoint as a same-host path: resolved against the
 * Connection endpoint by the exchange primitive, so the client secret only
 * ever travels to the Connection's own vendor host. Absolute URLs are
 * rejected — a separate auth host is a documented non-goal for this slice,
 * matching the existing derived-token-host posture. A second leading slash
 * (protocol-relative URLs change the host) and backslashes (WHATWG URL
 * treats them as slashes for http(s) bases) are rejected for the same
 * reason: with a single leading slash and neither, resolution provably
 * stays on the Connection's host. */
function requireTokenPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.length > 512
  ) {
    throw invalid("OAUTH_REQUEST_INVALID", "The OAuth token path is invalid.");
  }
  return value;
}

function readDeploymentSecret(env: ConsentEnv, envVar: string | undefined): string | undefined {
  if (envVar === undefined) return undefined;
  const value: unknown = (env as Record<string, unknown>)[envVar];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface AuthorizeConsentRequest {
  readonly integrationId: string;
  readonly redirectUri: unknown;
  readonly authorizeEndpoint: unknown;
  readonly clientId: unknown;
  readonly scope: unknown;
  readonly tenant?: unknown;
  readonly audience?: unknown;
}

export interface AuthorizeConsentResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
}

/** Issue the vendor authorization URL for one owned Connection. Pure apart
 * from the ownership read: mints PKCE plus state, builds the URL through
 * the shared primitive, and returns the consent session (state + verifier)
 * for the operator to hold. Unknown or foreign mappings answer 404 through
 * getConnection, managed rows refuse with MANAGED_RESOURCE, and Integrations
 * without an OAuth client secret answer OAUTH_CONSENT_UNSUPPORTED. */
export async function authorizeOAuthConsent(
  db: D1Database,
  caller: Principal,
  request: AuthorizeConsentRequest,
): Promise<AuthorizeConsentResult> {
  const view = await getConnection(db, caller, request.integrationId);
  if (view.managedBy !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Connection is managed by bundle install ${view.managedBy}: live mutation outside install is rejected.`,
      409,
    );
  }
  const def = integrationById(view.integrationId);
  if (!def || !def.secretFields.includes(OAUTH_CLIENT_SECRET_FIELD)) {
    throw invalid("OAUTH_CONSENT_UNSUPPORTED", "This Integration does not support authorization-code consent.");
  }
  const redirectUri = requireRedirectUri(request.redirectUri);
  const authorizeEndpoint = requireAuthorizeEndpoint(request.authorizeEndpoint);
  const pair = await createPkcePair();
  const state = createOAuthState();
  const authorizationUrl = buildAuthorizationUrl({
    authorizeEndpoint,
    ...(request.tenant === undefined ? {} : { tenant: request.tenant as string }),
    clientId: request.clientId as string,
    redirectUri,
    scope: request.scope as string,
    state,
    codeChallenge: pair.challenge,
    codeChallengeMethod: "S256",
    ...(request.audience === undefined ? {} : { audience: request.audience as string }),
  });
  return Object.freeze({ authorizationUrl, state, codeVerifier: pair.verifier });
}

export interface CallbackConsentRequest extends VendorOptions {
  readonly integrationId: string;
  readonly code?: unknown;
  readonly state?: unknown;
  readonly expectedState: unknown;
  readonly error?: unknown;
  readonly errorDescription?: unknown;
  readonly codeVerifier: unknown;
  readonly redirectUri: unknown;
  readonly tokenPath: unknown;
  readonly scope?: unknown;
  readonly clientId: unknown;
}

export interface VendorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Non-secret persisted state for the consented token: safe to audit, log,
 * and return to operators. Token values are never present. */
export interface ConsentedTokenState {
  readonly connectionId: string;
  readonly generation: number;
  readonly scope: string;
  readonly expiresAtMs?: number;
  readonly health: TokenHealth;
}

/** Validate the authorization response, spend the single-use code in exactly
 * one vendor POST, and persist the issued token. Ordering is deliberate: the
 * pure callback validation runs before any D1 I/O; the persisted generation
 * is read and the client secret plus KEK are resolved before the vendor
 * call, so a doomed exchange never burns the operator's single-use code;
 * the token lands through the existing conditional write (initial store for
 * first consent, generation-fenced replacement for re-consent) with no D1
 * transaction held across the vendor HTTP. */
export async function handleOAuthCallback(
  db: D1Database,
  caller: Principal,
  request: CallbackConsentRequest,
  env: ConsentEnv,
): Promise<ConsentedTokenState> {
  const view = await getConnection(db, caller, request.integrationId);
  if (view.managedBy !== null) {
    throw invalid(
      "MANAGED_RESOURCE",
      `Connection is managed by bundle install ${view.managedBy}: live mutation outside install is rejected.`,
      409,
    );
  }
  const def = integrationById(view.integrationId);
  if (!def || !def.secretFields.includes(OAUTH_CLIENT_SECRET_FIELD)) {
    throw invalid("OAUTH_CONSENT_UNSUPPORTED", "This Integration does not support authorization-code consent.");
  }
  const expectedState = requireField(
    request.expectedState,
    256,
    "OAUTH_REQUEST_INVALID",
    "The OAuth consent session is invalid.",
  );
  const { code } = parseOAuthCallback({
    code: request.code,
    state: request.state,
    expectedState,
    error: request.error,
    errorDescription: request.errorDescription,
  });
  const codeVerifier = requireField(
    request.codeVerifier,
    128,
    "OAUTH_REQUEST_INVALID",
    "The OAuth consent session is invalid.",
  );
  const redirectUri = requireRedirectUri(request.redirectUri);
  const tokenPath = requireTokenPath(request.tokenPath);
  const clientId = requireField(request.clientId, 256, "OAUTH_REQUEST_INVALID", "The OAuth client ID is invalid.");
  if (request.scope !== undefined) {
    requireField(request.scope, 1024, "OAUTH_SCOPE_INVALID", "The requested OAuth scope is invalid.");
  }
  const scope = request.scope as string | undefined;
  // Resolve everything the persist needs before the single-use code is
  // spent: the persisted generation, the per-Organization-or-deployment
  // client secret, and the envelope KEK. Any failure here answers before
  // the vendor call, so the code stays unburned for a corrected retry.
  const current = await readOAuthTokenState(db, caller.orgId, view.id);
  const kekMaterial = env.SECRETS_KEK;
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) {
    throw invalid(
      "SECRET_STORE_NOT_CONFIGURED",
      "The per-Organization secret store is not configured for this environment.",
      502,
    );
  }
  const perOrg = await resolveConnectionSecrets(db, caller.orgId, view.id, { [ENVELOPE_KEY_VERSION]: kekMaterial });
  const clientSecret =
    perOrg[OAUTH_CLIENT_SECRET_FIELD] ?? readDeploymentSecret(env, def.secretEnvVars[OAUTH_CLIENT_SECRET_FIELD]);
  if (clientSecret === undefined) {
    const text = OAUTH_CONSENT_FAULTS.notConfigured;
    throw new Fault(text.status, text.code, text.message);
  }
  const issued = await exchangeAuthorizationCode({
    endpoint: view.endpoint,
    tokenPath,
    code,
    redirectUri,
    codeVerifier,
    ...(scope === undefined ? {} : { scope }),
    credentials: { clientId, clientSecret },
    faults: OAUTH_CONSENT_FAULTS,
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  const checkedAt = new Date().toISOString();
  const stored =
    current === null
      ? await storeInitialOAuthToken(db, {
          orgId: caller.orgId,
          connectionId: view.id,
          accessToken: issued.accessToken,
          ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
          ...(scope === undefined ? {} : { scope }),
          ...(issued.expiresAtMs === undefined ? {} : { expiresAtMs: issued.expiresAtMs }),
          kekMaterial,
          checkedAt,
        })
      : await replaceOAuthToken(db, {
          orgId: caller.orgId,
          connectionId: view.id,
          expectedGeneration: current.generation,
          accessToken: issued.accessToken,
          ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
          ...(scope === undefined ? {} : { scope }),
          ...(issued.expiresAtMs === undefined ? {} : { expiresAtMs: issued.expiresAtMs }),
          kekMaterial,
          checkedAt,
        });
  return Object.freeze({
    connectionId: view.id,
    generation: stored.generation,
    scope: stored.scope,
    ...(stored.expiresAtMs === undefined ? {} : { expiresAtMs: stored.expiresAtMs }),
    health: stored.health,
  });
}
