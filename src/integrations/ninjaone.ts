// SPDX-License-Identifier: AGPL-3.0
import {
  boundedJson,
  Fault,
  NINJA_INTEGRATION_ID,
  NINJA_ORGS_MAX,
  NINJA_ORGS_PATH,
  NINJA_SCOPE,
  NINJA_TIMEOUT_MS,
  NINJA_TOKEN_PATH,
} from "../domain";
import type { NinjaOrgSummary, NinjaOrgsResult } from "../domain";
import { assertSafeEndpoint } from "./index";
import { requestClientCredentialsToken } from "../oauth";
import type { OAuthFaultTable } from "../oauth";
import { registerExecutionSecrets, scrubTextWithSecrets } from "../secrets";
export const ninjaIntegration = Object.freeze({ id: NINJA_INTEGRATION_ID, name: "ninjaone" });
/** NinjaOne token Fault taxonomy (OAUTH-01): the exact codes/messages the
 * existing acceptance pins. Centralizing mechanics never renames them. */
const NINJA_TOKEN_FAULTS: OAuthFaultTable = {
  notConfigured: { status: 502, code: "NINJA_NOT_CONFIGURED", message: "NinjaOne credentials are not configured." },
  redirected: { status: 502, code: "NINJA_AUTH_FAILED", message: "NinjaOne redirected the token request." },
  unauthorized: { status: 502, code: "NINJA_UNAUTHORIZED", message: "NinjaOne rejected the credentials." },
  rateLimited: { status: 502, code: "NINJA_RATE_LIMITED", message: "NinjaOne rate-limited the token request." },
  authFailed: { status: 502, code: "NINJA_AUTH_FAILED", message: "NinjaOne did not issue a token." },
  badResponse: { status: 502, code: "NINJA_BAD_RESPONSE", message: "NinjaOne returned an unexpected token response." },
  vendorTimeout: { status: 504, code: "NINJA_VENDOR_TIMEOUT", message: "NinjaOne exceeded its deadline." },
};
export interface NinjaConnection {
  endpoint: string;
}
export interface NinjaCredentials {
  clientId: string;
  clientSecret: string;
}
/** Credential handle as the Saga sees it: presence is NOT guaranteed. The
 * Action owns the presence check below, so Saga steps never branch on
 * credentials — they pass the handle through the Integration boundary and
 * map the resulting Fault like any other downstream error. */
export interface NinjaSecrets {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** Read-only Action: census NinjaOne organizations. Never persists secrets.
 * Credential presence is enforced here, behind the Action boundary: a Saga
 * step passes its secret handle straight through and maps NINJA_NOT_CONFIGURED
 * like any other structured downstream error. */
export async function listOrganizations(
  connection: NinjaConnection,
  secrets: NinjaSecrets,
  executionId?: string,
  timeoutMs?: number,
): Promise<NinjaOrgsResult> {
  const deadline = timeoutMs ?? NINJA_TIMEOUT_MS;
  const { clientId, clientSecret } = secrets;
  if (!clientId || !clientSecret) {
    throw new Fault(502, "NINJA_NOT_CONFIGURED", "NinjaOne credentials are not configured.");
  }
  // Re-parse the persisted endpoint before any fetch: persist-time validation
  // covers new writes, this covers rows that predate it.
  assertSafeEndpoint("ninjaone", connection.endpoint);
  if (executionId !== undefined) registerExecutionSecrets(executionId, [clientId, clientSecret]);
  // Scrub substrings out of every outward Fault message before it can reach a
  // step result, D1 row, or Workflow terminal value. Vendor bodies are still
  // never copied in — shaping is the primary guard, scrubbing the backstop.
  const registered = [clientId, clientSecret];
  const clean = (message: string): string => scrubTextWithSecrets(message, registered);
  // Explicit deadline, same posture as echo: a vendor that is slow (abort
  // fires) or merely late (resolves after the deadline because the transport
  // ignored the abort) surfaces NINJA_VENDOR_TIMEOUT. The clock anchors
  // before token acquisition, so the deadline covers the whole vendor
  // interaction end to end — the centralized token primitive stamps expiry
  // with one Date.now() read, which must never consume the Action's own
  // start tick.
  const started = Date.now();
  const timedOut = () => Date.now() - started >= deadline;
  // Token stays a transient local: fetched, used, dropped. It must never
  // reach D1, ExecutionHistory, logs, or Workflow persisted state.
  let token: string;
  try {
    token = await fetchToken(connection, { clientId, clientSecret }, deadline);
  } catch (error) {
    if (error instanceof Fault) throw new Fault(error.status, error.code, clean(error.message));
    throw error;
  }
  if (executionId !== undefined) registerExecutionSecrets(executionId, [token]);
  const withToken = [...registered, token];
  const cleanToken = (message: string): string => scrubTextWithSecrets(message, withToken);
  let response: Response;
  try {
    try {
      response = await fetch(`${connection.endpoint}${NINJA_ORGS_PATH}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(deadline),
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      throwIfNinjaTimeout(error);
      throw error;
    }
    if (timedOut()) {
      await response.body?.cancel();
      throw new Fault(504, "NINJA_VENDOR_TIMEOUT", "NinjaOne exceeded its deadline.");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Fault(502, "NINJA_VENDOR_FAILED", "NinjaOne redirected the request.");
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Fault(502, "NINJA_UNAUTHORIZED", "NinjaOne rejected the credentials.");
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new Fault(502, "NINJA_RATE_LIMITED", "NinjaOne rate-limited the request.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(502, "NINJA_VENDOR_FAILED", "NinjaOne did not return organizations.");
    }
    // Transport cap is generous: real tenants return tens of KB. What persists
    // is still the shaped summary under the D1 result CHECK bound.
    const value = await boundedJson(response.body, 262144);
    if (!Array.isArray(value))
      throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected organization list.");
    const organizations: NinjaOrgSummary[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected organization list.");
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "number" || typeof record.name !== "string") {
        throw new Fault(502, "NINJA_BAD_RESPONSE", "NinjaOne returned an unexpected organization list.");
      }
      if (organizations.length < NINJA_ORGS_MAX)
        organizations.push({ id: record.id, name: scrubTextWithSecrets(record.name, withToken) });
    }
    return { organizationCount: value.length, organizations };
  } catch (error) {
    // Raw transport errors (timeouts mapped above aside) propagate for the
    // Saga to map — but any secret substring hitching a ride in an Error or
    // vendor-shaped message is scrubbed here, at the boundary.
    if (error instanceof Fault) throw new Fault(error.status, error.code, cleanToken(error.message));
    if (error instanceof Error) {
      const scrubbed = new Error(cleanToken(error.message));
      (scrubbed as { cause?: unknown }).cause = error.cause;
      throw scrubbed;
    }
    throw error;
  }
}

async function fetchToken(
  connection: NinjaConnection,
  credentials: NinjaCredentials,
  timeoutMs = NINJA_TIMEOUT_MS,
): Promise<string> {
  // Regional token host derived from the Connection endpoint, so an EU/OC
  // Connection authenticates against its own region with no code change.
  // Scope is pinned read-only; the M2M app carries nothing broader. The token
  // stays transient (ADR 005 v0): returned to the caller, never persisted.
  const token = await requestClientCredentialsToken({
    endpoint: connection.endpoint,
    tokenPath: NINJA_TOKEN_PATH,
    scope: NINJA_SCOPE,
    credentials,
    faults: NINJA_TOKEN_FAULTS,
    timeoutMs,
  });
  return token.accessToken;
}

/** A slow vendor is an actionable deadline, not a generic vendor failure:
 * map abort/timeout rejections onto NINJA_VENDOR_TIMEOUT so Sagas can route
 * them to the explicit timeout checkpoint. Any other transport error
 * propagates raw and the Saga maps it to NINJA_INTEGRATION_FAILED. */
function throwIfNinjaTimeout(error: unknown): void {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    throw new Fault(504, "NINJA_VENDOR_TIMEOUT", "NinjaOne exceeded its deadline.");
  }
}
