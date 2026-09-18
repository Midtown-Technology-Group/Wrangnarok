// SPDX-License-Identifier: AGPL-3.0
// Microsoft Entra / Graph identity Integration (issue #262): portable
// provider code for the Microsoft-native proving binding. Typed Actions over
// the Graph fixture API; auth, retry, and pagination mechanics live here,
// never in the Saga. Vendor OAuth is deliberately out of scope for the
// proof (no client-credentials flow yet — OAUTH-01 owns the lifecycle): the
// fixture endpoints ride mocked HTTPS in tests, and production use needs an
// OAuth slice before it can authenticate.
import { boundedJson, Fault, GRAPH_INTEGRATION_ID, IDENTITY_TIMEOUT_MS } from "../domain";
import { assertSafeEndpoint } from "./index";
export const graphIntegration = Object.freeze({ id: GRAPH_INTEGRATION_ID, name: "graph" });
export interface GraphConnection {
  endpoint: string;
}
export interface GraphSubject {
  readonly givenName: string;
  readonly familyName: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
}
export interface GraphUser {
  readonly id: string;
  readonly userPrincipalName: string;
}
export interface GraphGroupAssignment {
  readonly userId: string;
  readonly assigned: readonly string[];
}
export interface GraphMailbox {
  readonly userId: string;
  readonly mailbox: string;
}
function throwIfGraphTimeout(error: unknown): void {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    throw new Fault(504, "GRAPH_VENDOR_TIMEOUT", "The Graph Integration exceeded its deadline.");
  }
}
async function postGraph(
  connection: GraphConnection,
  path: string,
  body: unknown,
  operationId: string,
  timeoutMs: number,
): Promise<unknown> {
  assertSafeEndpoint("graph", connection.endpoint);
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
      throw new Fault(504, "GRAPH_VENDOR_TIMEOUT", "The Graph Integration exceeded its deadline.");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Fault(502, "GRAPH_VENDOR_FAILED", "The Graph Integration redirected the request.");
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Fault(502, "GRAPH_UNAUTHORIZED", "The Graph Integration rejected the credentials.");
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new Fault(502, "GRAPH_RATE_LIMITED", "The Graph Integration rate-limited the request.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(502, "GRAPH_VENDOR_FAILED", "The Graph Integration did not complete the request.");
    }
    return await boundedJson(response.body, 65536);
  } catch (error) {
    if (error instanceof Fault) throw error;
    throwIfGraphTimeout(error);
    throw new Fault(502, "GRAPH_VENDOR_FAILED", "The Graph Integration did not complete the request.");
  }
}
/** Create one Entra user. Never persists secrets: the proof fixture carries
 * no credential, and the shaped result is the only thing callers keep. */
export async function createGraphUser(
  connection: GraphConnection,
  subject: GraphSubject,
  operationId: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<GraphUser> {
  const value = await postGraph(
    connection,
    "/v1.0/users",
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
    throw new Fault(502, "GRAPH_BAD_RESPONSE", "The Graph Integration returned an unexpected user.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.userPrincipalName !== "string") {
    throw new Fault(502, "GRAPH_BAD_RESPONSE", "The Graph Integration returned an unexpected user.");
  }
  return { id: record.id, userPrincipalName: record.userPrincipalName };
}
/** Assign one user to groups. The fixture takes the set in one call; the
 * real Graph assigns per-group references — the Adapter owns that
 * difference if a production slice ever earns it. */
export async function addGraphUserToGroups(
  connection: GraphConnection,
  userId: string,
  groups: readonly string[],
  operationId: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<GraphGroupAssignment> {
  const value = await postGraph(
    connection,
    "/v1.0/groups:assign",
    { userId, groups: [...groups] },
    operationId,
    timeoutMs,
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(502, "GRAPH_BAD_RESPONSE", "The Graph Integration returned an unexpected assignment.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.assigned) || record.assigned.some((entry) => typeof entry !== "string")) {
    throw new Fault(502, "GRAPH_BAD_RESPONSE", "The Graph Integration returned an unexpected assignment.");
  }
  return { userId, assigned: [...(record.assigned as string[])] };
}
/** Provision one Exchange Online mailbox for the user (fixture shape). */
export async function provisionGraphMailbox(
  connection: GraphConnection,
  userId: string,
  operationId: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<GraphMailbox> {
  const value = await postGraph(connection, "/v1.0/mailbox:provision", { userId }, operationId, timeoutMs);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(502, "GRAPH_BAD_RESPONSE", "The Graph Integration returned an unexpected mailbox.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.mailbox !== "string") {
    throw new Fault(502, "GRAPH_BAD_RESPONSE", "The Graph Integration returned an unexpected mailbox.");
  }
  return { userId, mailbox: record.mailbox };
}
/** Provider-direct escape hatch (ADR TBD §1): an Entra-only licensing call
 * with no shared-contract equivalent. Called directly by Sagas that opt
 * into the Microsoft stack — never through a Capability Adapter. */
export async function assignGraphLicense(
  connection: GraphConnection,
  userId: string,
  sku: string,
  operationId: string,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<boolean> {
  const value = await postGraph(connection, "/v1.0/licenses:assign", { userId, sku }, operationId, timeoutMs);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(502, "GRAPH_BAD_RESPONSE", "The Graph Integration returned an unexpected license result.");
  }
  return (value as Record<string, unknown>).assigned === true;
}
