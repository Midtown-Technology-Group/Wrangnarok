// SPDX-License-Identifier: AGPL-3.0
// Centralized OAuth token primitive (OAUTH-01, issue #149).
//
// Every Integration token acquisition — inline client-credentials fetch,
// on-demand authorization-code exchange, and rotating refresh-token refresh —
// funnels through this module. Sagas never implement refresh independently
// (ADR 003), and no database transaction is ever held over vendor HTTP: this
// module performs no D1 I/O at all. Token values stay transient
// fetch-and-discard per ADR 005 v0 (SEC-02 stays shut): results are returned
// to the caller, registered with the execution-scoped scrub registry at the
// Action boundary, and dropped. Only non-secret health transitions persist,
// and persistence of those transitions is explicitly out of this slice (it
// awaits the SEC-02 tripwire and its own migration number).
//
// Concurrency fencing (upstream drift 2026-09-13, bifrost PR #741): upstream
// now serializes concurrent SDK refreshes with a row lock held through vendor
// refresh plus replacement persistence, so two simultaneous 401 retries cannot
// both submit the same rotating one-time refresh token. The Cloudflare-native
// equivalent here is per-tenant single-flight: concurrent token requests for
// the same (endpoint, path, tenant, scope) share one in-flight vendor call and
// all waiters receive the same response. The vendor therefore sees exactly one
// refresh POST per rotation, which is the observable invariant PR #741 pins.
// No SQL `FOR UPDATE` is copied; the race behavior is proven by test instead.
//
// Audience/scope correction (upstream-spec section 15): upstream `oauth_scope`
// requests a fresh token for a *different resource audience* (Graph scopes
// replaced by Exchange scopes in the cited test), not a blanket subset of the
// configured scopes. resolveTokenScope implements replacement semantics and
// documents the non-enforcement: a local subset restriction would be a
// deliberate divergence, not an upstream invariant. OAuth resource scopes are
// never Organization authorization scope; confusing the two fails closed.
import { Fault, boundedJson } from "./domain";

/** Confidential-client credential pair. Values are never logged, persisted,
//  or copied into Fault messages on any path in this module. */
export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** One fixed Fault shape: code plus message, both caller-chosen so each
 * provider keeps its exact existing taxonomy (NinjaOne pins NINJA_* codes). */
export interface OAuthFaultText {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function fault(text: OAuthFaultText): Fault {
  return new Fault(text.status, text.code, text.message);
}

/** Vendor token-endpoint Fault taxonomy, supplied by the calling Integration
 * so centralizing mechanics never renames a provider's observable errors. */
export interface OAuthFaultTable {
  /** Deployment credentials missing before any vendor call. */
  readonly notConfigured: OAuthFaultText;
  /** Token endpoint redirected (redirect policy is manual, always). */
  readonly redirected: OAuthFaultText;
  /** Token endpoint answered 401 (unknown client, rejected secret). */
  readonly unauthorized: OAuthFaultText;
  /** Token endpoint answered 429. Exactly one vendor call: never retried. */
  readonly rateLimited: OAuthFaultText;
  /** Any other non-2xx, including exchange invalid_grant. */
  readonly authFailed: OAuthFaultText;
  /** Vendor body is not the shaped token response. Bodies are never copied. */
  readonly badResponse: OAuthFaultText;
  /** Vendor exceeded its deadline (abort fired or merely-late resolve). */
  readonly vendorTimeout: OAuthFaultText;
}

export interface VendorEnv {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Transient token: fetched, used, dropped. The access token and any refresh
 * token must never reach D1, ExecutionHistory, logs, or Workflow state. */
export interface OAuthToken {
  readonly accessToken: string;
  readonly tokenType: string;
  /** Vendor-advertised lifetime in seconds, when the vendor states one. */
  readonly expiresIn?: number;
  /** Local expiry instant derived from expiresIn, when stated. */
  readonly expiresAtMs?: number;
  /** Next refresh token, present only when the vendor rotates one. */
  readonly refreshToken?: string;
}

/** Default expiry skew for isTokenExpired: a token expiring within the next
 * five minutes counts as expired. Local policy, not an upstream pin —
 * upstream refreshes within twenty minutes of expiry on its scheduler cadence;
 * inline callers use a tighter margin so a fetched token survives its call. */
export const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

// --- Single-flight fencing -------------------------------------------------
// Module-level in-flight map keyed by NON-SECRET request identity only
// (endpoint, path, tenant key, scope key). Secret values never enter a key.
const inflight = new Map<string, Promise<unknown>>();

/** Test hook: drop every in-flight entry (suite isolation). Never prod. */
export function clearOAuthInflight(): void {
  inflight.clear();
}

function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing !== undefined) return existing as Promise<T>;
  const task = run();
  inflight.set(key, task as Promise<unknown>);
  const cleanup = (): void => {
    if (inflight.get(key) === (task as Promise<unknown>)) inflight.delete(key);
  };
  // Both settle paths run cleanup; the derived promise cannot reject because
  // cleanup returns void on either path.
  void task.then(cleanup, cleanup);
  return task;
}

// --- Shared vendor mechanics ------------------------------------------------

/** A slow vendor is an actionable deadline, not a generic vendor failure. */
function throwIfOAuthTimeout(error: unknown, timeout: OAuthFaultText): void {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    throw fault(timeout);
  }
}

/** Resolve the absolute token URL from the Connection endpoint. The endpoint
 * itself is validated by the Integration's safe-URL policy before use; this
 * throws a provider-neutral Fault only for a value that cannot form a URL. */
export function resolveTokenUrl(endpoint: string, tokenPath: string): string {
  try {
    return new URL(tokenPath, endpoint).toString();
  } catch {
    throw new Fault(500, "INVALID_OAUTH_ENDPOINT", "The Connection endpoint cannot form a vendor token URL.");
  }
}

async function readTokenResponse(response: Response, faults: OAuthFaultTable): Promise<OAuthToken> {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw fault(faults.redirected);
  }
  if (response.status === 401) {
    await response.body?.cancel();
    throw fault(faults.unauthorized);
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw fault(faults.rateLimited);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw fault(faults.authFailed);
  }
  // Transport-shape Faults (INVALID_JSON, BODY_TOO_LARGE) propagate for the
  // Action boundary to scrub; they carry no vendor body either way.
  const value: unknown = await boundedJson(response.body);
  return parseTokenBody(value, faults);
}

/** Shape-check the vendor token body. Vendor bodies are never copied into
 * Fault messages: shaping is the guard, scrubbing stays the backstop. */
function parseTokenBody(value: unknown, faults: OAuthFaultTable): OAuthToken {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fault(faults.badResponse);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token.length === 0) {
    throw fault(faults.badResponse);
  }
  const token: {
    accessToken: string;
    tokenType: string;
    expiresIn?: number;
    expiresAtMs?: number;
    refreshToken?: string;
  } = {
    accessToken: record.access_token,
    tokenType: typeof record.token_type === "string" && record.token_type.length > 0 ? record.token_type : "Bearer",
  };
  if (typeof record.expires_in === "number" && Number.isFinite(record.expires_in) && record.expires_in > 0) {
    token.expiresIn = Math.floor(record.expires_in);
    token.expiresAtMs = Date.now() + token.expiresIn * 1000;
  }
  if (typeof record.refresh_token === "string" && record.refresh_token.length > 0) {
    token.refreshToken = record.refresh_token;
  }
  return Object.freeze(token);
}

async function postTokenForm(
  tokenUrl: string,
  form: URLSearchParams,
  faults: OAuthFaultTable,
  vendor: VendorEnv,
): Promise<OAuthToken> {
  const timeoutMs = vendor.timeoutMs ?? 5000;
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
  } catch (error) {
    throwIfOAuthTimeout(error, faults.vendorTimeout);
    throw error;
  }
  return readTokenResponse(response, faults);
}

function requireCredentials(
  credentials: OAuthClientCredentials,
  faults: OAuthFaultTable,
): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = credentials;
  if (!clientId || !clientSecret) {
    throw fault(faults.notConfigured);
  }
  return { clientId, clientSecret };
}

// --- Client credentials ------------------------------------------------------

export interface ClientCredentialsRequest extends VendorEnv {
  readonly endpoint: string;
  readonly tokenPath: string;
  /** Resolved scope for this request (see resolveTokenScope). */
  readonly scope: string;
  readonly credentials: OAuthClientCredentials;
  readonly faults: OAuthFaultTable;
}

/** Centralized inline client-credentials acquisition. Concurrent requests for
 * the same (endpoint, path, client, scope) share one in-flight vendor call;
 * every caller receives the same transient token and the vendor sees one POST.
 * Exactly one vendor call per request otherwise: no retries, no persistence. */
export async function requestClientCredentialsToken(request: ClientCredentialsRequest): Promise<OAuthToken> {
  const { clientId, clientSecret } = requireCredentials(request.credentials, request.faults);
  const tokenUrl = resolveTokenUrl(request.endpoint, request.tokenPath);
  const scope = request.scope;
  const key = `cc|${tokenUrl}|${scope}|${clientId}`;
  return singleFlight(key, () =>
    postTokenForm(
      tokenUrl,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      }),
      request.faults,
      request,
    ),
  );
}

// --- Authorization code with PKCE --------------------------------------------

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** Mint a PKCE pair (RFC 7636 S256). Verifier is 32 random bytes (43 base64url
 * chars, within the 43-128 range); challenge is its SHA-256. Both are secret
 * material: transport only, never persist, never log. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Object.freeze({ verifier, challenge: base64Url(new Uint8Array(digest)) });
}

/** Mint an authorization-request state value (16 random bytes, base64url).
 * The caller binds it to the operator session and echoes it back through
 * parseOAuthCallback; a mismatch fails closed. */
export function createOAuthState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

const OAUTH_REQUEST_INVALID = { status: 400, code: "OAUTH_REQUEST_INVALID", message: "The OAuth request is invalid." };

function requireRequestField(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Fault(OAUTH_REQUEST_INVALID.status, OAUTH_REQUEST_INVALID.code, OAUTH_REQUEST_INVALID.message);
  }
  return value;
}

export interface AuthorizationUrlRequest {
  /** Authorize endpoint, optionally templated with `{tenant}` for providers
   * that scope authorization by entity/tenant path segment. */
  readonly authorizeEndpoint: string;
  /** Entity substituted into `{tenant}` when the endpoint is templated. */
  readonly tenant?: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
  /** Resource audience override (see resolveTokenScope): replaces, not subsets. */
  readonly audience?: string;
}

/** Build the authorization redirect URL (URL/entity templating). Pure: no I/O,
 * no state. Values flow into the URL by construction — the caller redirects
 * the operator there; the URL itself is never persisted. */
export function buildAuthorizationUrl(request: AuthorizationUrlRequest): string {
  let endpoint = request.authorizeEndpoint;
  if (endpoint.includes("{tenant}")) {
    const tenant = requireRequestField(request.tenant, 128);
    if (!/^[A-Za-z0-9._-]+$/u.test(tenant)) {
      throw new Fault(OAUTH_REQUEST_INVALID.status, OAUTH_REQUEST_INVALID.code, OAUTH_REQUEST_INVALID.message);
    }
    endpoint = endpoint.split("{tenant}").join(encodeURIComponent(tenant));
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Fault(500, "INVALID_OAUTH_ENDPOINT", "The Connection endpoint cannot form a vendor authorize URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Fault(500, "INVALID_OAUTH_ENDPOINT", "The Connection endpoint cannot form a vendor authorize URL.");
  }
  const clientId = requireRequestField(request.clientId, 256);
  const redirectUri = requireRequestField(request.redirectUri, 2048);
  const scope = requireRequestField(request.scope, 1024);
  const state = requireRequestField(request.state, 256);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
  });
  if (request.codeChallenge !== undefined) {
    const challenge = requireRequestField(request.codeChallenge, 128);
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", request.codeChallengeMethod ?? "S256");
  }
  if (request.audience !== undefined) {
    params.set("audience", requireRequestField(request.audience, 512));
  }
  url.search = params.toString();
  return url.toString();
}

export interface OAuthCallbackParams {
  readonly code?: unknown;
  readonly state?: unknown;
  readonly expectedState: string;
  readonly error?: unknown;
  readonly errorDescription?: unknown;
}

/** Validate the authorization callback. Pure: no I/O. Vendor error text is
 * never copied into Faults (fixed messages only), and the code/state values
 * never appear in any message. */
export function parseOAuthCallback(params: OAuthCallbackParams): { readonly code: string } {
  if (typeof params.error === "string" && params.error.length > 0) {
    throw new Fault(400, "OAUTH_AUTHORIZATION_DENIED", "The vendor denied the authorization request.");
  }
  if (typeof params.state !== "string" || params.state.length === 0 || params.state !== params.expectedState) {
    throw new Fault(400, "OAUTH_STATE_MISMATCH", "The authorization state does not match this session.");
  }
  if (typeof params.code !== "string" || params.code.length === 0 || params.code.length > 2048) {
    throw new Fault(400, "OAUTH_CALLBACK_INVALID", "The authorization callback carries no usable code.");
  }
  // errorDescription is vendor prose: acknowledged by the signature, never copied.
  return Object.freeze({ code: params.code });
}

export interface AuthorizationCodeExchangeRequest extends VendorEnv {
  readonly endpoint: string;
  readonly tokenPath: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
  readonly scope?: string;
  readonly credentials: OAuthClientCredentials;
  readonly faults: OAuthFaultTable;
}

/** Redeem a one-time authorization code for transient tokens. Deliberately NOT
 * single-flight: a code is single-use, so coalescing concurrent exchanges
 * would burn one caller's code for another. Each call hits the vendor exactly
 * once; the vendor rejects replays. The issued refresh token (when the vendor
 * rotates one) is returned transiently — persisting it awaits SEC-02. */
export async function exchangeAuthorizationCode(request: AuthorizationCodeExchangeRequest): Promise<OAuthToken> {
  const { clientId, clientSecret } = requireCredentials(request.credentials, request.faults);
  const tokenUrl = resolveTokenUrl(request.endpoint, request.tokenPath);
  const code = requireRequestField(request.code, 2048);
  const redirectUri = requireRequestField(request.redirectUri, 2048);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (request.codeVerifier !== undefined) {
    form.set("code_verifier", requireRequestField(request.codeVerifier, 128));
  }
  if (request.scope !== undefined) {
    form.set("scope", requireRequestField(request.scope, 1024));
  }
  return postTokenForm(tokenUrl, form, request.faults, request);
}

// --- Rotating refresh ----------------------------------------------------------

export interface RefreshTokenRequest extends VendorEnv {
  readonly endpoint: string;
  readonly tokenPath: string;
  readonly refreshToken: string;
  /** Non-secret tenant key (org id or client id) fencing concurrent rotations. */
  readonly tenantKey: string;
  /** Stable non-secret rotation generation (e.g. a persisted token version).
   * When supplied, fences partition per generation: a superseded generation
   * reusing a rotated one-time token can never coalesce onto the live
   * rotation's flight. Omit when the caller holds no generation (v0
   * fetch-and-discard): fencing falls back to (endpoint, path, tenant,
   * scope). Never a token or credential value. */
  readonly generation?: string;
  readonly scope?: string;
  readonly credentials: OAuthClientCredentials;
  readonly faults: OAuthFaultTable;
}

export interface RotatedToken {
  readonly token: OAuthToken;
  /** True when the vendor issued a replacement refresh token: the caller must
   * use the returned refreshToken next and drop the submitted one. False
   * means the vendor kept the submitted token valid for another round. */
  readonly rotated: boolean;
  /** The refresh token to submit next (replacement when rotated). Transient. */
  readonly refreshToken: string;
}

/** Centralized rotating refresh. Concurrent refreshes for the same
 * (endpoint, path, tenant, scope) share one in-flight vendor call, so the
 * one-time refresh token is submitted exactly once no matter how many
 * workflow/SDK 401 retries race — the Cloudflare-native serialization the
 * upstream row lock provides. No D1 read or write happens before, during, or
 * after the vendor call: replacement persistence awaits SEC-02, so v0 callers
 * use the returned token immediately and drop it. */
export async function refreshRotatingToken(request: RefreshTokenRequest): Promise<RotatedToken> {
  const { clientId, clientSecret } = requireCredentials(request.credentials, request.faults);
  const tokenUrl = resolveTokenUrl(request.endpoint, request.tokenPath);
  const submitted = requireRequestField(request.refreshToken, 4096);
  const tenantKey = requireRequestField(request.tenantKey, 256);
  const generation = request.generation === undefined ? "" : requireGeneration(request.generation);
  const scopeKey = request.scope ?? "";
  const key = `rt|${tokenUrl}|${tenantKey}|${generation}|${scopeKey}`;
  return singleFlight(key, async () => {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: submitted,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (request.scope !== undefined) form.set("scope", request.scope);
    const token = await postTokenForm(tokenUrl, form, request.faults, request);
    const next = token.refreshToken ?? submitted;
    return Object.freeze({ token, rotated: token.refreshToken !== undefined, refreshToken: next });
  });
}

// --- Audience / scope overrides --------------------------------------------------

export interface TokenScopeRequest {
  readonly defaultScope: string;
  /** Requested scope override: REPLACES the default for this token request
   * (Graph-to-Exchange style audience change), never intersects it. */
  readonly scope?: string;
  /** Resource audience override (e.g. a SharePoint host scope). */
  readonly audience?: string;
}

export interface ResolvedTokenScope {
  readonly scope: string;
  readonly audience: string | null;
}

/** Resolve the scope for one token request. Replacement semantics per the
 * corrected upstream attribution: requesting a different resource audience
 * yields exactly the requested scope, with no subset enforcement against the
 * configured default — deliberately, with a test pinning the Graph/Exchange/
 * SharePoint-style replacement. This resolves OAuth *resource* scope only and
 * confers no Organization authorization: callers must never treat a broader
 * vendor scope as permission to cross an org boundary. Pure: no I/O. */
export function resolveTokenScope(request: TokenScopeRequest): ResolvedTokenScope {
  const fallback = requireScope("defaultScope", request.defaultScope);
  if (request.scope !== undefined) {
    return Object.freeze({
      scope: requireScope("scope", request.scope),
      audience: request.audience === undefined ? null : requireAudience(request.audience),
    });
  }
  return Object.freeze({
    scope: fallback,
    audience: request.audience === undefined ? null : requireAudience(request.audience),
  });
}

function requireScope(_name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new Fault(400, "OAUTH_SCOPE_INVALID", "The requested OAuth scope is invalid.");
  }
  return value;
}

function requireAudience(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Fault(400, "OAUTH_SCOPE_INVALID", "The requested OAuth audience is invalid.");
  }
  return value;
}

function requireGeneration(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Fault(400, "OAUTH_REQUEST_INVALID", "The OAuth request is invalid.");
  }
  return value;
}

// --- Token expiry ------------------------------------------------------------------

/** True when the token should no longer be used: either past its vendor
 * expiry or inside the skew margin. A token with no vendor-stated expiry is
 * treated as usable (fetch-and-discard callers hold it for one call). Pure. */
export function isTokenExpired(
  token: { readonly expiresAtMs?: number },
  nowMs: number = Date.now(),
  skewMs: number = OAUTH_EXPIRY_SKEW_MS,
): boolean {
  if (token.expiresAtMs === undefined) return false;
  return nowMs + skewMs >= token.expiresAtMs;
}

// --- Credential health lifecycle ------------------------------------------------------
// Non-secret status metadata per (org, Integration). Transitions are pure so
// every caller — inline, on-demand, and any future justified scheduled path —
// records the same lifecycle: success recovers to healthy, any failure marks
// failed with a consecutive count, revocation marks revoked. Values carry no
// secret material and are safe to audit, but persistence itself (a D1 row per
// Connection) is out of this slice: it needs its own steward migration number
// and rides with the SEC-02 tripwire decision, not ahead of it.

export type TokenHealthStatus = "healthy" | "failed" | "revoked";

export interface TokenHealth {
  readonly status: TokenHealthStatus;
  readonly checkedAt: string;
  readonly consecutiveFailures: number;
  readonly lastFailureCode: string | null;
  readonly lastSuccessAt: string | null;
}

/** Fresh health row: healthy at first check with no history. */
export function initialTokenHealth(checkedAt: string): TokenHealth {
  return Object.freeze({
    status: "healthy",
    checkedAt,
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastSuccessAt: null,
  });
}

/** Record a successful token use: recovers to healthy and resets the failure
 * count, so a failed-then-recovered credential visibly heals. */
export function recordTokenSuccess(_previous: TokenHealth, checkedAt: string): TokenHealth {
  return Object.freeze({
    status: "healthy",
    checkedAt,
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastSuccessAt: checkedAt,
  });
}

/** Record a failed token use: marks failed, keeps the failure code for
 * remediation copy, and counts consecutively for backoff/threshold callers. */
export function recordTokenFailure(previous: TokenHealth, code: string, checkedAt: string): TokenHealth {
  return Object.freeze({
    status: "failed",
    checkedAt,
    consecutiveFailures: previous.consecutiveFailures + 1,
    lastFailureCode: code,
    lastSuccessAt: previous.lastSuccessAt,
  });
}

/** Record an explicit revocation (vendor revoke call or invalid_grant the
 * operator confirms dead): terminal until a fresh authorization succeeds.
 * Connection identity is untouched — only the health status moves. */
export function recordTokenRevoked(previous: TokenHealth, checkedAt: string): TokenHealth {
  return Object.freeze({
    status: "revoked",
    checkedAt,
    consecutiveFailures: previous.consecutiveFailures,
    lastFailureCode: previous.lastFailureCode,
    lastSuccessAt: previous.lastSuccessAt,
  });
}

/** Whether the credential may be used for a vendor call. Failed and revoked
 * credentials fail closed: callers surface the health status instead of
 * spending a vendor call on a known-dead credential. */
export function isTokenUsable(health: TokenHealth): boolean {
  return health.status === "healthy";
}

// --- Revocation --------------------------------------------------------------------------

export interface RevokeTokenRequest extends VendorEnv {
  readonly endpoint: string;
  readonly revocationPath: string;
  readonly token: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** Ask the vendor to invalidate one token. Transient like every token op:
 * the caller records recordTokenRevoked on success. A 2xx (including the
 * common revoke-unknown-token-as-success) revokes; anything else fails loud
 * without copying vendor bodies. */
export async function revokeOAuthToken(request: RevokeTokenRequest): Promise<{ readonly revoked: true }> {
  const token = requireRequestField(request.token, 4096);
  const revocationUrl = resolveTokenUrl(request.endpoint, request.revocationPath);
  const timeoutMs = request.timeoutMs ?? 5000;
  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const form = new URLSearchParams({ token });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (request.clientId !== undefined && request.clientSecret !== undefined) {
    headers.Authorization = `Basic ${btoa(`${request.clientId}:${request.clientSecret}`)}`;
  }
  let response: Response;
  try {
    response = await fetchImpl(revocationUrl, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body: form.toString(),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Fault(504, "OAUTH_REVOKE_TIMEOUT", "The vendor exceeded its revocation deadline.");
    }
    throw error;
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new Fault(502, "OAUTH_REVOKE_FAILED", "The vendor rejected the revocation request.");
  }
  return Object.freeze({ revoked: true as const });
}
