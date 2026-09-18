// SPDX-License-Identifier: AGPL-3.0
// On-prem Active Directory Integration (issue #262, ADR TBD §3): the
// directory is Active Directory; NinjaOne is the Transport that reaches it.
// This module holds the directory configuration shape plus the
// agent-mediated execution mechanics: acquire the NinjaOne client-credentials
// token, POST the directory operation to the Transport, shape the result.
// Local PowerShell/AD work is mediated by the NinjaOne agent, never by
// Wrangnarök itself — the Adapter/Transport seam is what later lets AD move
// to Datto, a dedicated runner, or another mechanism without rewriting
// portable Sagas.
import { boundedJson, AD_INTEGRATION_ID, Fault, IDENTITY_TIMEOUT_MS, NINJA_SCOPE, NINJA_TOKEN_PATH } from "../domain";
import { assertSafeEndpoint } from "./index";
import { requestClientCredentialsToken } from "../oauth";
import type { OAuthFaultTable } from "../oauth";
import { registerExecutionSecrets, scrubTextWithSecrets } from "../secrets";
export const adIntegration = Object.freeze({ id: AD_INTEGRATION_ID, name: "ad" });
/** Directory configuration for one Organization: which on-prem directory
 * this Connection describes. Non-secret only — bind credentials stay with
 * the Transport, never in the directory row. */
export interface AdConnection {
  endpoint: string;
}
/** The NinjaOne Transport endpoint plus the M2M credential handle. Presence
 * is enforced here, behind the Action boundary, so Saga steps never branch
 * on credentials. */
export interface AdTransportSecrets {
  readonly clientId?: string;
  readonly clientSecret?: string;
}
export interface AdSubject {
  readonly givenName: string;
  readonly familyName: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
}
export interface AdUser {
  readonly id: string;
  readonly userPrincipalName: string;
}
export interface AdGroupAssignment {
  readonly userId: string;
  readonly assigned: readonly string[];
}
export interface AdMailbox {
  readonly userId: string;
  readonly mailbox: string;
}
/** Transport token Faults reuse the NinjaOne taxonomy shape with AD-scoped
 * codes so a directory failure never masquerades as a census failure. */
const AD_TOKEN_FAULTS: OAuthFaultTable = {
  notConfigured: {
    status: 502,
    code: "AD_TRANSPORT_NOT_CONFIGURED",
    message: "The AD Transport credentials are not configured.",
  },
  redirected: { status: 502, code: "AD_TRANSPORT_FAILED", message: "The AD Transport redirected the token request." },
  unauthorized: {
    status: 502,
    code: "AD_TRANSPORT_UNAUTHORIZED",
    message: "The AD Transport rejected the credentials.",
  },
  rateLimited: {
    status: 502,
    code: "AD_TRANSPORT_RATE_LIMITED",
    message: "The AD Transport rate-limited the token request.",
  },
  authFailed: { status: 502, code: "AD_TRANSPORT_FAILED", message: "The AD Transport did not issue a token." },
  badResponse: {
    status: 502,
    code: "AD_TRANSPORT_BAD_RESPONSE",
    message: "The AD Transport returned an unexpected token response.",
  },
  vendorTimeout: { status: 504, code: "AD_VENDOR_TIMEOUT", message: "The AD Transport exceeded its deadline." },
};
function throwIfAdTimeout(error: unknown): void {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    throw new Fault(504, "AD_VENDOR_TIMEOUT", "The AD Transport exceeded its deadline.");
  }
}
/** Execute one directory operation through the NinjaOne Transport: the
 * directory Connection says *which* on-prem directory, the Transport carries
 * the agent-mediated execution. The token stays a transient local — fetched,
 * used, dropped — and every outward Fault is scrubbed of credential
 * substrings at this boundary. */
async function executeAdViaTransport(
  transportEndpoint: string,
  secrets: AdTransportSecrets,
  directory: AdConnection,
  op: string,
  params: Record<string, unknown>,
  operationId: string,
  executionId: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  assertSafeEndpoint("ninjaone", transportEndpoint);
  assertSafeEndpoint("ad", directory.endpoint);
  const { clientId, clientSecret } = secrets;
  if (!clientId || !clientSecret) {
    throw new Fault(502, "AD_TRANSPORT_NOT_CONFIGURED", "The AD Transport credentials are not configured.");
  }
  if (executionId !== undefined) registerExecutionSecrets(executionId, [clientId, clientSecret]);
  const registered = [clientId, clientSecret];
  const clean = (message: string): string => scrubTextWithSecrets(message, registered);
  const started = Date.now();
  const timedOut = () => Date.now() - started >= timeoutMs;
  let token: string;
  try {
    const issued = await requestClientCredentialsToken({
      endpoint: transportEndpoint,
      tokenPath: NINJA_TOKEN_PATH,
      scope: NINJA_SCOPE,
      credentials: { clientId, clientSecret },
      faults: AD_TOKEN_FAULTS,
      timeoutMs,
    });
    token = issued.accessToken;
  } catch (error) {
    if (error instanceof Fault) throw new Fault(error.status, error.code, clean(error.message));
    throw error;
  }
  if (executionId !== undefined) registerExecutionSecrets(executionId, [token]);
  const withToken = [...registered, token];
  const cleanToken = (message: string): string => scrubTextWithSecrets(message, withToken);
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) {
    throw new Fault(504, "AD_VENDOR_TIMEOUT", "The AD Transport exceeded its deadline.");
  }
  try {
    const response = await fetch(`${transportEndpoint}/v2/ad/execute`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": operationId,
      },
      body: JSON.stringify({ directory: directory.endpoint, op, params }),
    });
    if (timedOut()) {
      await response.body?.cancel();
      throw new Fault(504, "AD_VENDOR_TIMEOUT", "The AD Transport exceeded its deadline.");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Fault(502, "AD_TRANSPORT_FAILED", "The AD Transport redirected the request.");
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Fault(502, "AD_TRANSPORT_UNAUTHORIZED", "The AD Transport rejected the credentials.");
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new Fault(502, "AD_TRANSPORT_RATE_LIMITED", "The AD Transport rate-limited the request.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(502, "AD_TRANSPORT_FAILED", "The AD Transport did not complete the request.");
    }
    return await boundedJson(response.body, 65536);
  } catch (error) {
    if (error instanceof Fault) throw new Fault(error.status, error.code, cleanToken(error.message));
    if (error instanceof Error) {
      throwIfAdTimeout(error);
      const scrubbed = new Error(cleanToken(error.message));
      (scrubbed as { cause?: unknown }).cause = error.cause;
      throw scrubbed;
    }
    throw error;
  }
}
function shapeAdUser(value: unknown): AdUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(502, "AD_BAD_RESPONSE", "The AD Transport returned an unexpected user.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.userPrincipalName !== "string") {
    throw new Fault(502, "AD_BAD_RESPONSE", "The AD Transport returned an unexpected user.");
  }
  return { id: record.id, userPrincipalName: record.userPrincipalName };
}
/** Create one AD user through the Transport. */
export async function createAdUser(
  transportEndpoint: string,
  secrets: AdTransportSecrets,
  directory: AdConnection,
  subject: AdSubject,
  operationId: string,
  executionId?: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<AdUser> {
  return shapeAdUser(
    await executeAdViaTransport(
      transportEndpoint,
      secrets,
      directory,
      "createUser",
      {
        givenName: subject.givenName,
        familyName: subject.familyName,
        userPrincipalName: subject.userPrincipalName,
        displayName: subject.displayName,
      },
      operationId,
      executionId,
      timeoutMs,
    ),
  );
}
/** Assign one AD user to groups through the Transport. */
export async function addAdUserToGroups(
  transportEndpoint: string,
  secrets: AdTransportSecrets,
  directory: AdConnection,
  userId: string,
  groups: readonly string[],
  operationId: string,
  executionId?: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<AdGroupAssignment> {
  const value = await executeAdViaTransport(
    transportEndpoint,
    secrets,
    directory,
    "assignGroups",
    { userId, groups: [...groups] },
    operationId,
    executionId,
    timeoutMs,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(502, "AD_BAD_RESPONSE", "The AD Transport returned an unexpected assignment.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.assigned) || record.assigned.some((entry) => typeof entry !== "string")) {
    throw new Fault(502, "AD_BAD_RESPONSE", "The AD Transport returned an unexpected assignment.");
  }
  return { userId, assigned: [...(record.assigned as string[])] };
}
/** Provision one mailbox for the AD user through the Transport (fixture shape). */
export async function provisionAdMailbox(
  transportEndpoint: string,
  secrets: AdTransportSecrets,
  directory: AdConnection,
  userId: string,
  operationId: string,
  executionId?: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<AdMailbox> {
  const value = await executeAdViaTransport(
    transportEndpoint,
    secrets,
    directory,
    "provisionMailbox",
    { userId },
    operationId,
    executionId,
    timeoutMs,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(502, "AD_BAD_RESPONSE", "The AD Transport returned an unexpected mailbox.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.mailbox !== "string") {
    throw new Fault(502, "AD_BAD_RESPONSE", "The AD Transport returned an unexpected mailbox.");
  }
  return { userId, mailbox: record.mailbox };
}
