// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171): Streamable-HTTP dispatch to external MCP servers
// (transport P0 D2: exactly one transport — Streamable HTTP over POST with
// Bearer [REDACTED] from the resolved credential; SSE, stdio, private endpoints,
// and non-HTTP transports are explicit v0 non-support).
//
// One dispatch, one policy: the catalog gate (presence + enabled, disabled
// reason in the denial), then the five-path resolution (`src/mcp-auth.ts`),
// then a single vendor call. Retry discipline (upstream `dispatch.py` pins
// in docs/upstream-spec.md §23): on a post-resolution 401/403 marker the
// layer resolves once more and retries exactly once; at most one inline
// refresh attempt per dispatch (persisted on success through the
// generation-fenced write, falling through to the next path on failure);
// a user token that still fails becomes needs-reauth — never a quiet
// upgrade to service.
//
// Bounds (P0 D2 + ADR 013 posture): per-call timeout, manual-redirect only
// (a redirect never carries the Bearer [REDACTED] a second host), and a ~250 KB
// response cap. Oversize answers MCP_RESPONSE_TOO_LARGE (fail loud, the
// Code Mode precedent — an adaptation of the upstream truncation nudge that
// keeps every envelope bounded). Egress re-validates the effective URL at
// use time (persist-time validation covers new writes; this covers
// overrides and rows that predate it). No silent retries beyond the single
// auth retry: transport failures fail loud.
import { Fault } from "./domain";
import type { Principal } from "./domain";
import { ENVELOPE_KEY_VERSION } from "./envelope";
import { isTokenExpired, OAUTH_EXPIRY_SKEW_MS, refreshRotatingToken, requestClientCredentialsToken } from "./oauth";
import type { OAuthFaultTable, OAuthRefreshFenceBinding, OAuthToken } from "./oauth";
import { mcpResolutionFault, resolveMcpCredential } from "./mcp-auth";
import type { McpCaller } from "./mcp-auth";
import { qualifiedMcpToolName, resolveMcpCatalogTool, syncMcpCatalog } from "./mcp-catalog";
import { resolveDispatchConnection, resolveMcpConnectionClientSecret } from "./mcp-connections";
import {
  loadMcpServiceToken,
  loadMcpUserConsent,
  readMcpServiceTokenState,
  readMcpUserConsent,
  recordMcpServiceTokenOutcome,
  recordMcpUserConsentOutcome,
  replaceMcpServiceToken,
  replaceMcpUserConsentToken,
} from "./mcp-tokens";
import type { McpConsentView } from "./mcp-tokens";
import type { McpTokenState } from "./mcp-tokens";
import { parseMcpServerUrl } from "./mcp-servers";

/** ~250 KB serialized-JSON response cap (upstream §23 pin). */
export const MCP_RESPONSE_BYTES_MAX = 256000;
/** Per-call vendor deadline for tools/call. */
export const MCP_DISPATCH_TIMEOUT_MS = 10000;
/** Vendor deadline for tools/list discovery. */
export const MCP_DISCOVERY_TIMEOUT_MS = 5000;

export interface McpVendorOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Cross-instance refresh fence (`OAUTH_REFRESH_FENCE` binding). Omit in
   * tests and same-isolate callers: the module-local single-flight still
   * fences one isolate. */
  readonly fence?: OAuthRefreshFenceBinding;
}

function invalid(code: string, message: string, status = 400, details?: unknown): Fault {
  return details === undefined ? new Fault(status, code, message) : new Fault(status, code, message, details);
}

/** Use-time egress guard: re-parse the effective server URL before any
 * fetch. Throws 500 MCP_INVALID_CONNECTION with a fixed message — never
 * the raw parse error, never the endpoint value. */
export function assertMcpEndpoint(raw: string): void {
  try {
    parseMcpServerUrl(raw);
  } catch {
    throw invalid("MCP_INVALID_CONNECTION", "The MCP Connection endpoint is not a safe URL.", 500);
  }
}

/** Vendor Fault taxonomy for the MCP token operations. New operator
 * surface, so failures speak generic MCP_* codes with fixed messages —
 * vendor bodies are never copied. */
export const MCP_TOKEN_FAULTS: OAuthFaultTable = {
  notConfigured: {
    status: 502,
    code: "MCP_NOT_CONFIGURED",
    message: "The MCP client credential is not configured for this Connection.",
  },
  redirected: { status: 502, code: "MCP_VENDOR_REDIRECTED", message: "The vendor redirected the token request." },
  unauthorized: { status: 502, code: "MCP_VENDOR_UNAUTHORIZED", message: "The vendor rejected the MCP credentials." },
  rateLimited: { status: 502, code: "MCP_VENDOR_RATE_LIMITED", message: "The vendor rate-limited the token request." },
  authFailed: { status: 502, code: "MCP_TOKEN_FAILED", message: "The vendor did not issue an MCP token." },
  badResponse: {
    status: 502,
    code: "MCP_VENDOR_BAD_RESPONSE",
    message: "The vendor returned an unexpected token response.",
  },
  vendorTimeout: { status: 504, code: "MCP_VENDOR_TIMEOUT", message: "The vendor exceeded its deadline." },
};

/** Read one vendor JSON body under the response cap. Declared lengths lie,
 * so the stream is measured while reading and aborted at bound + 1: a
 * vendor can never force full buffering past the cap. Oversize throws
 * MCP_RESPONSE_TOO_LARGE; malformed lengths and unparseable bodies throw
 * MCP_VENDOR_UNREADABLE. Fixed messages — unsanitized bytes never reach
 * the caller, so this is also a model/tool-output amplification fence. */
export async function readBoundedMcpBody(response: Response): Promise<unknown> {
  const failUnreadable = (): Fault =>
    invalid("MCP_VENDOR_UNREADABLE", "The MCP server returned an unreadable body.", 502);
  const failTooLarge = (): Fault =>
    invalid("MCP_RESPONSE_TOO_LARGE", "The MCP server returned a body above the response bound.", 502);
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared.trim());
    if (!Number.isSafeInteger(length) || length < 0) {
      await response.body?.cancel();
      throw failUnreadable();
    }
    if (length > MCP_RESPONSE_BYTES_MAX) {
      await response.body?.cancel();
      throw failTooLarge();
    }
  }
  const stream = response.body;
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MCP_RESPONSE_BYTES_MAX) {
        await reader.cancel();
        throw failTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Fault) throw error;
    await reader.cancel().catch(() => undefined);
    throw failUnreadable();
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(merged);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw failUnreadable();
  }
}

interface McpRpcRequest extends McpVendorOptions {
  readonly url: string;
  readonly token: string;
  readonly method: "tools/list" | "tools/call";
  readonly params: Record<string, unknown>;
  readonly id?: string | number;
}

/** One Streamable-HTTP JSON-RPC call. Redirects never carry the Bearer [REDACTED]
 * (manual mode + loud failure); transport faults speak fixed MCP_*
 * messages; JSON-RPC error members become MCP_VENDOR_ERROR without
 * copying vendor prose. */
export async function postMcpRpc(request: McpRpcRequest): Promise<unknown> {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const timeoutMs = request.timeoutMs ?? MCP_DISPATCH_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${request.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id ?? 1, method: request.method, params: request.params }),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw invalid("MCP_VENDOR_TIMEOUT", "The MCP server exceeded its deadline.", 504);
    }
    throw invalid("MCP_VENDOR_UNREACHABLE", "The MCP server could not be reached.", 502);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw invalid("MCP_VENDOR_REDIRECTED", "The MCP server redirected the request.", 502);
  }
  // The 401/403 marker rides the raw status to the caller: dispatch decides
  // the single retry, so this layer never retries on its own.
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw invalid("MCP_VENDOR_UNAUTHORIZED", "The MCP server rejected the credential.", 401, {
      marker: true,
      status: response.status,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw invalid("MCP_VENDOR_ERROR", "The MCP server returned an error.", 502);
  }
  const payload = await readBoundedMcpBody(response);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalid("MCP_VENDOR_UNREADABLE", "The MCP server returned an unreadable body.", 502);
  }
  const record = payload as { error?: unknown; result?: unknown };
  if (record.error !== undefined) {
    throw invalid("MCP_VENDOR_ERROR", "The MCP server returned an error.", 502);
  }
  return record.result ?? null;
}

/** True for the conservative auth marker statuses that earn exactly one
 * resolve-plus-retry (upstream §23: post-resolution 401/403). */
export function isMcpAuthMarker(error: unknown): boolean {
  return (
    error instanceof Fault &&
    error.code === "MCP_VENDOR_UNAUTHORIZED" &&
    (error as Fault & { details?: { marker?: boolean } }).details?.marker === true
  );
}

/** Remote tools/list over the service token (catalog sync path). */
export async function listMcpToolsRemote(url: string, token: string, vendor: McpVendorOptions = {}): Promise<unknown> {
  return postMcpRpc({
    url,
    token,
    method: "tools/list",
    params: {},
    ...(vendor.fetchImpl === undefined ? {} : { fetchImpl: vendor.fetchImpl }),
    timeoutMs: vendor.timeoutMs ?? MCP_DISCOVERY_TIMEOUT_MS,
  });
}

export interface McpClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Client-credentials service connect: one synchronous server-to-server
 * exchange. Per-user mode does not exist for this flow (upstream §23) —
 * callers enforce that before reaching here. */
export async function connectMcpClientCredentials(
  endpoint: string,
  tokenPath: string,
  credentials: McpClientCredentials,
  scope: string | undefined,
  vendor: McpVendorOptions = {},
): Promise<OAuthToken> {
  return requestClientCredentialsToken({
    endpoint,
    tokenPath,
    credentials,
    scope: scope ?? "",
    faults: MCP_TOKEN_FAULTS,
    ...(vendor.fetchImpl === undefined ? {} : { fetchImpl: vendor.fetchImpl }),
    ...(vendor.timeoutMs === undefined ? {} : { timeoutMs: vendor.timeoutMs }),
  });
}

interface RefreshOutcome {
  readonly state: McpTokenState;
  readonly accessToken: string;
  readonly refreshToken?: string;
}

interface RefreshTarget {
  readonly connectionId: string;
  readonly tokenPath: string | null;
  readonly clientId: string | null;
  readonly scope: string;
}

function keksFor(kekMaterial: string): Readonly<Record<number, string>> {
  return { [ENVELOPE_KEY_VERSION]: kekMaterial };
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

/** One rotating-refresh vendor round through the shared single-flight
 * primitive (module-local without `fence`, cross-instance with the
 * `OAUTH_REFRESH_FENCE` binding from the route). Fencing partitions per
 * generation, so a superseded generation reusing a rotated one-time token
 * can never coalesce onto the live rotation's flight. */
async function rotateMcpToken(
  serverUrl: string,
  target: RefreshTarget,
  tenantKey: string,
  state: McpTokenState,
  refreshToken: string,
  clientSecret: string,
  vendor: McpVendorOptions,
): Promise<{ readonly token: OAuthToken; readonly refreshToken: string }> {
  const rotated = await refreshRotatingToken({
    endpoint: serverUrl,
    tokenPath: target.tokenPath as string,
    refreshToken,
    tenantKey,
    generation: String(state.generation),
    scope: target.scope,
    credentials: { clientId: target.clientId as string, clientSecret },
    faults: MCP_TOKEN_FAULTS,
    ...(vendor.fetchImpl === undefined ? {} : { fetchImpl: vendor.fetchImpl }),
    ...(vendor.timeoutMs === undefined ? {} : { timeoutMs: vendor.timeoutMs }),
    ...(vendor.fence === undefined ? {} : { fence: vendor.fence }),
  });
  return Object.freeze({ token: rotated.token, refreshToken: rotated.refreshToken });
}

/** Single inline refresh attempt for the service credential, persisted
 * through the generation-fenced write on success. A superseded writer
 * rereads the winning row instead of overwriting it. Null when no refresh
 * is possible (no token path, client pair, or refresh token) — the caller
 * falls through to the next resolution path. Vendor failures throw the
 * fixed MCP_* Fault for the caller to shape. */
async function refreshServiceCredential(
  db: D1Database,
  orgId: string,
  serverUrl: string,
  target: RefreshTarget,
  state: McpTokenState,
  refreshToken: string | undefined,
  kekMaterial: string,
  vendor: McpVendorOptions,
  checkedAt: string,
): Promise<RefreshOutcome | null> {
  if (refreshToken === undefined || target.tokenPath === null || target.clientId === null) return null;
  const clientSecret = await resolveMcpConnectionClientSecret(db, orgId, target.connectionId, keksFor(kekMaterial));
  if (clientSecret === null) return null;
  const { token, refreshToken: next } = await rotateMcpToken(
    serverUrl,
    target,
    `mcp:${orgId}:${target.connectionId}`,
    state,
    refreshToken,
    clientSecret,
    vendor,
  );
  try {
    const persisted = await replaceMcpServiceToken(db, {
      orgId,
      connectionId: target.connectionId,
      expectedGeneration: state.generation,
      accessToken: token.accessToken,
      ...(next === undefined ? {} : { refreshToken: next }),
      scope: target.scope,
      ...(token.expiresAtMs === undefined ? {} : { expiresAtMs: token.expiresAtMs }),
      kekMaterial,
      checkedAt,
    });
    return { state: persisted, accessToken: token.accessToken, ...(next === undefined ? {} : { refreshToken: next }) };
  } catch (error) {
    if (!(error instanceof Fault) || error.code !== "MCP_TOKEN_GENERATION_STALE") throw error;
    const winner = await readMcpServiceTokenState(db, orgId, target.connectionId);
    if (!winner) throw invalid("MCP_TOKEN_NOT_FOUND", "No service credential is stored for this Connection.", 404);
    const loaded = await loadMcpServiceToken(db, orgId, target.connectionId, keksFor(kekMaterial));
    if (!loaded) throw invalid("MCP_TOKEN_NOT_FOUND", "No service credential is stored for this Connection.", 404);
    return {
      state: winner,
      accessToken: loaded.accessToken,
      ...(loaded.refreshToken === undefined ? {} : { refreshToken: loaded.refreshToken }),
    };
  }
}

export interface McpDispatchProvenance {
  readonly callerKind: "user" | "autonomous";
  readonly identity: "user" | "service";
  readonly orgId: string;
  readonly connectionId: string;
  readonly qualifiedTool: string;
  readonly executedAt: string;
}

export interface McpDispatchRequest extends McpVendorOptions {
  readonly db: D1Database;
  readonly orgId: string;
  readonly caller: McpCaller;
  readonly connectionId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly kekMaterial: string | undefined;
  readonly executionId?: string;
  readonly nowMs?: number;
  /** Server-built reconnect affordance for needs-reauth denials. */
  readonly reauthUrl?: string;
}

export interface McpDispatchResult {
  readonly result: unknown;
  readonly provenance: McpDispatchProvenance;
}

/** Single inline refresh attempt for one user's consent credential.
 * Same fence/write discipline as the service path, partitioned per user. */
async function refreshUserCredential(
  db: D1Database,
  orgId: string,
  serverUrl: string,
  target: RefreshTarget,
  userId: string,
  state: McpTokenState,
  refreshToken: string | undefined,
  kekMaterial: string,
  vendor: McpVendorOptions,
  checkedAt: string,
): Promise<RefreshOutcome | null> {
  if (refreshToken === undefined || target.tokenPath === null || target.clientId === null) return null;
  const clientSecret = await resolveMcpConnectionClientSecret(db, orgId, target.connectionId, keksFor(kekMaterial));
  if (clientSecret === null) return null;
  const { token, refreshToken: next } = await rotateMcpToken(
    serverUrl,
    target,
    `mcp:${orgId}:${target.connectionId}:user:${userId.trim().toLowerCase()}`,
    state,
    refreshToken,
    clientSecret,
    vendor,
  );
  try {
    const persisted = await replaceMcpUserConsentToken(db, {
      orgId,
      connectionId: target.connectionId,
      userId,
      expectedGeneration: state.generation,
      accessToken: token.accessToken,
      ...(next === undefined ? {} : { refreshToken: next }),
      scope: target.scope,
      ...(token.expiresAtMs === undefined ? {} : { expiresAtMs: token.expiresAtMs }),
      kekMaterial,
      checkedAt,
    });
    return {
      state: {
        generation: persisted.generation,
        scope: persisted.scope,
        ...(persisted.expiresAtMs === undefined ? {} : { expiresAtMs: persisted.expiresAtMs }),
        health: persisted.health,
      },
      accessToken: token.accessToken,
      ...(next === undefined ? {} : { refreshToken: next }),
    };
  } catch (error) {
    if (!(error instanceof Fault) || error.code !== "MCP_TOKEN_GENERATION_STALE") throw error;
    const winner = await readMcpUserConsent(db, orgId, target.connectionId, userId);
    if (!winner) throw invalid("MCP_CONSENT_NOT_FOUND", "This user has not consented to this Connection.", 404);
    const loaded = await loadMcpUserConsent(db, orgId, target.connectionId, userId, keksFor(kekMaterial));
    if (!loaded) throw invalid("MCP_CONSENT_NOT_FOUND", "This user has not consented to this Connection.", 404);
    return {
      state: {
        generation: winner.generation,
        scope: winner.scope,
        ...(winner.expiresAtMs === undefined ? {} : { expiresAtMs: winner.expiresAtMs }),
        health: winner.health,
      },
      accessToken: loaded.accessToken,
      ...(loaded.refreshToken === undefined ? {} : { refreshToken: loaded.refreshToken }),
    };
  }
}

function callerPrincipal(caller: McpCaller, orgId: string): Principal {
  return {
    orgId,
    userId:
      caller.kind === "user" ? caller.userId : `service:mcp-connection:${caller.serviceConnectionId.toLowerCase()}`,
  };
}

function consentStateOf(view: McpConsentView | null): McpTokenState | null {
  if (!view) return null;
  return {
    generation: view.generation,
    scope: view.scope,
    ...(view.expiresAtMs === undefined ? {} : { expiresAtMs: view.expiresAtMs }),
    health: view.health,
  };
}

/** Dispatch one external MCP tool call through the catalog gate, the
 * five-path resolution, and a single bounded vendor call. Denials name
 * their owner: unknown/hidden tools 404, disabled tools 404 with the
 * drift reason, needs-reauth 403 with the reconnect affordance,
 * misconfigured 424 for the operator. */
export async function dispatchMcpTool(request: McpDispatchRequest): Promise<McpDispatchResult> {
  const { db, orgId } = request;
  const nowMs = request.nowMs ?? Date.now();
  const kek = requireKek(request.kekMaterial);
  const principal = callerPrincipal(request.caller, orgId);
  if (
    request.args !== undefined &&
    (request.args === null || typeof request.args !== "object" || Array.isArray(request.args))
  ) {
    throw invalid("MCP_INVALID_PARAMS", "The tool arguments must be a JSON object when provided.");
  }
  const args = (request.args ?? {}) as Record<string, unknown>;
  const { row, view } = await resolveDispatchConnection(db, principal, request.connectionId);
  await resolveMcpCatalogTool(db, principal, request.connectionId, request.toolName);
  const serverUrl = view.effectiveServerUrl;
  assertMcpEndpoint(serverUrl);
  const checkedAt = new Date().toISOString();
  const vendor: McpVendorOptions = {
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.fence === undefined ? {} : { fence: request.fence }),
  };
  const connectionInput = {
    id: row.id,
    providerFlow: view.providerFlow as "authorization_code" | "client_credentials" | "none",
    availableInChat: view.availableInChat,
    availableToAutonomous: view.availableToAutonomous,
  };
  const target: RefreshTarget = { connectionId: row.id, tokenPath: row.token_path, clientId: row.client_id, scope: "" };
  const callerUserId = request.caller.kind === "user" ? request.caller.userId : null;
  let serviceState = await readMcpServiceTokenState(db, orgId, row.id);
  let userState = callerUserId ? consentStateOf(await readMcpUserConsent(db, orgId, row.id, callerUserId)) : null;
  const serviceLoaded = serviceState
    ? await loadMcpServiceToken(db, orgId, row.id, keksFor(kek), request.executionId)
    : null;
  const userLoaded =
    callerUserId && userState
      ? await loadMcpUserConsent(db, orgId, row.id, callerUserId, keksFor(kek), request.executionId)
      : null;
  if (serviceState && !serviceLoaded) {
    throw invalid("MCP_MISCONFIGURED", "The service credential could not be read; reconnect it.", 424);
  }
  if (userState && !userLoaded) {
    throw mcpResolutionFault({ kind: "needs-reauth", providerFlow: "authorization_code" }, request.reauthUrl);
  }
  let serviceAccess: string | null = serviceLoaded?.accessToken ?? null;
  let serviceRefresh: string | undefined = serviceLoaded?.refreshToken;
  let userAccess: string | null = userLoaded?.accessToken ?? null;
  let userRefresh: string | undefined = userLoaded?.refreshToken;
  let refreshAttempted = false;

  // Preferred-identity refresh before resolution: an expired credential
  // with a refresh token earns its single inline attempt now; failure
  // nulls that identity so resolution falls through to the next path
  // instead of spending a doomed vendor call.
  async function preferRefresh(): Promise<void> {
    if (refreshAttempted) return;
    if (callerUserId && userState && userRefresh !== undefined) {
      if (isTokenExpired({ expiresAtMs: userState.expiresAtMs }, nowMs, OAUTH_EXPIRY_SKEW_MS)) {
        refreshAttempted = true;
        try {
          const next = await refreshUserCredential(
            db,
            orgId,
            serverUrl,
            { ...target, scope: userState.scope },
            callerUserId,
            userState,
            userRefresh,
            kek,
            vendor,
            checkedAt,
          );
          if (next) {
            userState = next.state;
            userAccess = next.accessToken;
            userRefresh = next.refreshToken;
          } else {
            userState = null;
            userAccess = null;
            userRefresh = undefined;
          }
        } catch {
          userState = null;
          userAccess = null;
          userRefresh = undefined;
        }
        return;
      }
    }
    if (serviceState && serviceRefresh !== undefined) {
      if (isTokenExpired({ expiresAtMs: serviceState.expiresAtMs }, nowMs, OAUTH_EXPIRY_SKEW_MS)) {
        refreshAttempted = true;
        try {
          const next = await refreshServiceCredential(
            db,
            orgId,
            serverUrl,
            { ...target, scope: serviceState.scope },
            serviceState,
            serviceRefresh,
            kek,
            vendor,
            checkedAt,
          );
          if (next) {
            serviceState = next.state;
            serviceAccess = next.accessToken;
            serviceRefresh = next.refreshToken;
          } else {
            serviceState = null;
            serviceAccess = null;
            serviceRefresh = undefined;
          }
        } catch {
          serviceState = null;
          serviceAccess = null;
          serviceRefresh = undefined;
        }
      }
    }
  }

  await preferRefresh();
  const resolution = resolveMcpCredential(request.caller, {
    connection: connectionInput,
    service: serviceState,
    user: userState,
    nowMs,
  });
  if (resolution.kind !== "user" && resolution.kind !== "service") {
    throw mcpResolutionFault(resolution, request.reauthUrl);
  }
  const identity = resolution.kind;
  const activeToken = identity === "user" ? userAccess : serviceAccess;
  const activeRefresh = identity === "user" ? userRefresh : serviceRefresh;
  const activeState = identity === "user" ? userState : serviceState;
  if (!activeToken || !activeState) {
    throw mcpResolutionFault(
      identity === "user"
        ? { kind: "needs-reauth", providerFlow: "authorization_code" }
        : { kind: "misconfigured", reason: "This Connection has no usable service credential." },
      request.reauthUrl,
    );
  }
  const liveState: McpTokenState = activeState;
  const liveToken: string = activeToken;
  const liveRefresh: string | undefined = activeRefresh;

  async function recordOutcome(
    outcome: { readonly kind: "success" } | { readonly kind: "failure"; readonly code: string },
    generation: number = liveState.generation,
  ): Promise<void> {
    try {
      if (identity === "user" && request.caller.kind === "user") {
        await recordMcpUserConsentOutcome(
          db,
          orgId,
          row.id,
          request.caller.userId,
          outcome,
          new Date().toISOString(),
          generation,
        );
      } else if (identity === "service") {
        await recordMcpServiceTokenOutcome(db, orgId, row.id, outcome, new Date().toISOString(), generation);
      }
    } catch (error) {
      // A superseded generation means a newer row already stands: the
      // response in hand stays authoritative and the write is dropped.
      if (!(error instanceof Fault) || error.code !== "MCP_TOKEN_GENERATION_STALE") throw error;
    }
  }

  async function callWith(token: string): Promise<unknown> {
    return postMcpRpc({
      url: serverUrl,
      token,
      method: "tools/call",
      params: { name: request.toolName, arguments: args },
      ...vendor,
    });
  }

  try {
    const result = await callWith(liveToken);
    await recordOutcome({ kind: "success" });
    return {
      result,
      provenance: {
        callerKind: request.caller.kind,
        identity,
        orgId,
        connectionId: row.id,
        qualifiedTool: qualifiedMcpToolName(row.id, request.toolName),
        executedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (!isMcpAuthMarker(error)) throw error;
    // Single resolve-plus-retry: one refresh attempt total per dispatch,
    // then exactly one retry. A user token that still fails becomes
    // needs-reauth — never a quiet upgrade to service.
    let outcomeGeneration = liveState.generation;
    if (!refreshAttempted && liveRefresh !== undefined) {
      refreshAttempted = true;
      try {
        const next =
          identity === "user" && request.caller.kind === "user"
            ? await refreshUserCredential(
                db,
                orgId,
                serverUrl,
                { ...target, scope: liveState.scope },
                request.caller.userId,
                liveState,
                liveRefresh,
                kek,
                vendor,
                checkedAt,
              )
            : await refreshServiceCredential(
                db,
                orgId,
                serverUrl,
                { ...target, scope: liveState.scope },
                liveState,
                liveRefresh,
                kek,
                vendor,
                checkedAt,
              );
        if (next) {
          outcomeGeneration = next.state.generation;
          const retry = await callWith(next.accessToken);
          await recordOutcome({ kind: "success" }, next.state.generation);
          return {
            result: retry,
            provenance: {
              callerKind: request.caller.kind,
              identity,
              orgId,
              connectionId: row.id,
              qualifiedTool: qualifiedMcpToolName(row.id, request.toolName),
              executedAt: new Date().toISOString(),
            },
          };
        }
      } catch (retryError) {
        // A dead refresh (invalid grant, rejected pair) lands on the same
        // denial as a failed retry — the credential is gone either way.
        // Real transport failures (timeout, unreachable) propagate as-is.
        const dead =
          isMcpAuthMarker(retryError) ||
          (retryError instanceof Fault &&
            (retryError.code === "MCP_TOKEN_FAILED" || retryError.code === "MCP_VENDOR_UNAUTHORIZED"));
        if (!dead) throw retryError;
      }
    }
    await recordOutcome({ kind: "failure", code: "MCP_VENDOR_UNAUTHORIZED" }, outcomeGeneration);
    throw mcpResolutionFault(
      identity === "user"
        ? { kind: "needs-reauth", providerFlow: "authorization_code" }
        : { kind: "misconfigured", reason: "The service credential was rejected; reconnect it before retrying." },
      request.reauthUrl,
    );
  }
}

/** Refresh one Connection's catalog over its service token (operator path).
 * No service credential is a loud 400, never an empty catalog (upstream
 * §23). Returns the `{total, enabled, disabled}` summary. */
export async function refreshMcpTools(
  db: D1Database,
  orgId: string,
  connectionId: string,
  kekMaterial: string | undefined,
  vendor: McpVendorOptions = {},
  now = new Date().toISOString(),
): Promise<{ readonly total: number; readonly enabled: number; readonly disabled: number }> {
  const kek = requireKek(kekMaterial);
  const principal: Principal = { orgId, userId: "" };
  const { row, view } = await resolveDispatchConnection(db, principal, connectionId);
  const state = await readMcpServiceTokenState(db, orgId, row.id);
  if (!state) {
    throw invalid("MCP_SERVICE_NOT_CONNECTED", "Connect a service credential before refreshing tools.", 400);
  }
  const loaded = await loadMcpServiceToken(db, orgId, row.id, keksFor(kek));
  if (!loaded) {
    throw invalid("MCP_SERVICE_NOT_CONNECTED", "Connect a service credential before refreshing tools.", 400);
  }
  const serverUrl = view.effectiveServerUrl;
  assertMcpEndpoint(serverUrl);
  let token = loaded.accessToken;
  if (isTokenExpired(loaded, Date.now(), OAUTH_EXPIRY_SKEW_MS) && loaded.refreshToken !== undefined) {
    const next = await refreshServiceCredential(
      db,
      orgId,
      serverUrl,
      { connectionId: row.id, tokenPath: row.token_path, clientId: row.client_id, scope: state.scope },
      state,
      loaded.refreshToken,
      kek,
      vendor,
      now,
    );
    if (next) token = next.accessToken;
  }
  let payload: unknown;
  try {
    payload = await listMcpToolsRemote(serverUrl, token, vendor);
  } catch (error) {
    if (isMcpAuthMarker(error)) {
      try {
        await recordMcpServiceTokenOutcome(
          db,
          orgId,
          row.id,
          { kind: "failure", code: "MCP_VENDOR_UNAUTHORIZED" },
          now,
          state.generation,
        );
      } catch (recordError) {
        if (!(recordError instanceof Fault) || recordError.code !== "MCP_TOKEN_GENERATION_STALE") throw recordError;
      }
      throw invalid("MCP_VENDOR_UNAUTHORIZED", "The MCP server rejected the service credential.", 502);
    }
    throw error;
  }
  return syncMcpCatalog(db, principal, row.id, payload, now);
}
