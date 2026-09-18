// SPDX-License-Identifier: AGPL-3.0
// Google Workspace identity Integration (issue #262): portable provider
// code for the Google-native proving binding. Typed Actions over the Admin
// SDK fixture API; service-account JWT mechanics (the modules/
// googleworkspace.py precedent) stay a production-slice concern — the proof
// fixture rides mocked HTTPS with no credential, and service-account auth
// needs its own OAuth slice before production use.
import { boundedJson, Fault, GOOGLEWORKSPACE_INTEGRATION_ID, IDENTITY_TIMEOUT_MS } from "../domain";
import { assertSafeEndpoint } from "./index";
export const googleIntegration = Object.freeze({ id: GOOGLEWORKSPACE_INTEGRATION_ID, name: "googleworkspace" });
export interface GoogleConnection {
  endpoint: string;
}
export interface GoogleSubject {
  readonly givenName: string;
  readonly familyName: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
}
export interface GoogleUser {
  readonly id: string;
  readonly userPrincipalName: string;
}
export interface GoogleGroupAssignment {
  readonly userId: string;
  readonly assigned: readonly string[];
}
export interface GoogleMailbox {
  readonly userId: string;
  readonly mailbox: string;
}
function throwIfGoogleTimeout(error: unknown): void {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    throw new Fault(504, "GOOGLEWORKSPACE_VENDOR_TIMEOUT", "The Google Workspace Integration exceeded its deadline.");
  }
}
async function postGoogle(
  connection: GoogleConnection,
  path: string,
  body: unknown,
  operationId: string,
  timeoutMs: number,
): Promise<unknown> {
  assertSafeEndpoint("googleworkspace", connection.endpoint);
  const started = Date.now();
  const timedOut = () => Date.now() - started >= timeoutMs;
  try {
    const response = await fetch(`${connection.endpoint}${path}`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "Idempotency-Key": operationId },
      body: JSON.stringify(body),
    });
    if (timedOut()) {
      await response.body?.cancel();
      throw new Fault(504, "GOOGLEWORKSPACE_VENDOR_TIMEOUT", "The Google Workspace Integration exceeded its deadline.");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Fault(502, "GOOGLEWORKSPACE_VENDOR_FAILED", "The Google Workspace Integration redirected the request.");
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Fault(
        502,
        "GOOGLEWORKSPACE_UNAUTHORIZED",
        "The Google Workspace Integration rejected the credentials.",
      );
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new Fault(
        502,
        "GOOGLEWORKSPACE_RATE_LIMITED",
        "The Google Workspace Integration rate-limited the request.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(502, "GOOGLEWORKSPACE_VENDOR_FAILED", "The Google Workspace Integration did not complete.");
    }
    return await boundedJson(response.body, 65536);
  } catch (error) {
    if (error instanceof Fault) throw error;
    throwIfGoogleTimeout(error);
    throw new Fault(502, "GOOGLEWORKSPACE_VENDOR_FAILED", "The Google Workspace Integration did not complete.");
  }
}
/** Create one Google Workspace user (Admin SDK fixture shape). */
export async function createGoogleUser(
  connection: GoogleConnection,
  subject: GoogleSubject,
  operationId: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<GoogleUser> {
  const value = await postGoogle(
    connection,
    "/admin/directory/v1/users",
    {
      givenName: subject.givenName,
      familyName: subject.familyName,
      userPrincipalName: subject.userPrincipalName,
      displayName: subject.displayName,
    },
    operationId,
    timeoutMs,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(
      502,
      "GOOGLEWORKSPACE_BAD_RESPONSE",
      "The Google Workspace Integration returned an unexpected user.",
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.userPrincipalName !== "string") {
    throw new Fault(
      502,
      "GOOGLEWORKSPACE_BAD_RESPONSE",
      "The Google Workspace Integration returned an unexpected user.",
    );
  }
  return { id: record.id, userPrincipalName: record.userPrincipalName };
}
/** Add one user to groups (fixture batches the set in one call). */
export async function addGoogleUserToGroups(
  connection: GoogleConnection,
  userId: string,
  groups: readonly string[],
  operationId: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<GoogleGroupAssignment> {
  const value = await postGoogle(
    connection,
    "/admin/directory/v1/groups:assign",
    { userId, groups: [...groups] },
    operationId,
    timeoutMs,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(
      502,
      "GOOGLEWORKSPACE_BAD_RESPONSE",
      "The Google Workspace Integration returned an unexpected assignment.",
    );
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.assigned) || record.assigned.some((entry) => typeof entry !== "string")) {
    throw new Fault(
      502,
      "GOOGLEWORKSPACE_BAD_RESPONSE",
      "The Google Workspace Integration returned an unexpected assignment.",
    );
  }
  return { userId, assigned: [...(record.assigned as string[])] };
}
/** Provision one Gmail mailbox for the user (fixture shape). */
export async function provisionGoogleMailbox(
  connection: GoogleConnection,
  userId: string,
  operationId: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<GoogleMailbox> {
  const value = await postGoogle(
    connection,
    "/admin/directory/v1/mailbox:provision",
    { userId },
    operationId,
    timeoutMs,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(
      502,
      "GOOGLEWORKSPACE_BAD_RESPONSE",
      "The Google Workspace Integration returned an unexpected mailbox.",
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.mailbox !== "string") {
    throw new Fault(
      502,
      "GOOGLEWORKSPACE_BAD_RESPONSE",
      "The Google Workspace Integration returned an unexpected mailbox.",
    );
  }
  return { userId, mailbox: record.mailbox };
}
