// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170) HaloPSA Integration: OpenAPI Code Mode proof provider.
//
// HaloPSA is the motivating first provider from ADR 022: a large vendor API
// the agent discovers progressively instead of through handwritten
// endpoint-shaped wrappers. This definition carries the portable contract
// only — origin allowlist, pinned spec digest/version, overlay digest, and
// the conservative default policy. No endpoint-shaped Actions live here:
// reads and explicitly-enabled mutations execute through the Code Mode host
// below, which resolves the Organization-scoped Connection, injects auth,
// and enforces egress outside model-visible state.
//
// The transport auth shape (client-id/secret OAuth) mirrors the NinjaOne
// Action boundary: presence-checked inside execution, never persisted to D1,
// never returned through discovery, and scrubbed from every outward Fault.
import { Fault, HALO_INTEGRATION_ID } from "../domain";
import type { Principal } from "../domain";
import {
  authorizeOperation,
  buildProvenance,
  indexOperations,
  inspectOperation,
  pinContract,
  resolveRequestUrl,
  searchOperations,
} from "../openapi";
import type {
  CodeModeProvenance,
  ContractOperation,
  OpenApiDocument,
  OperationPolicy,
  OperationRisk,
} from "../openapi";
import { getConnection } from "../connections";
import { scrubTextWithSecrets, scrubValueWithSecrets } from "../secrets";

export { HALO_INTEGRATION_ID };

/** Allowed Halo origin for the lab proof. Production allowlists stay
 * Integration configuration, never spec `servers` entries. */
export const HALO_ALLOWED_ORIGIN = "https://halo-lab.example.com";

/** Pinned lab spec revision for the proof contract. Real pins record the
 * upstream source plus overlay digest; the proof spec is local fixture. */
export const HALO_SPEC_VERSION = "halo-lab-1";

/** Default Code Mode policy for Halo: reads execute under existing
 * Connection authority; one explicitly-authorized non-destructive mutation
 * is enabled; destructive/security/credential/billing/tenant-admin classes
 * stay deny-by-default until an operator enables them per operationId. */
export const HALO_DEFAULT_POLICY: OperationPolicy = {
  enabledOperations: ["Ticket_Get", "Ticket_AddNote"],
  deniedOperations: [],
  enabledRisks: ["mutation"],
};

/** Risk classification for the proof operations. Ticket_Get is a safe read;
 * Ticket_AddNote is an explicitly-authorized non-destructive mutation;
 * Ticket_Delete is the destructive denial proof. Anything unlisted fails
 * closed at execution time. */
export const HALO_CLASSIFICATIONS: Readonly<Record<string, OperationRisk>> = Object.freeze({
  Ticket_Get: "read",
  Ticket_Search: "read",
  Ticket_AddNote: "mutation",
  Ticket_Delete: "destructive",
});

/** Credential handle as Code Mode execution sees it: presence is NOT
 * guaranteed. The host owns the presence check, so agent paths never branch
 * on credentials — they pass the handle through and map the Fault. */
export interface HaloSecrets {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** Require configured Halo credentials inside execution. Throws
 * HALO_NOT_CONFIGURED (never a leak: names only, no values). */
export function requireHaloSecrets(secrets: HaloSecrets): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = secrets;
  if (!clientId || !clientSecret) {
    throw new Fault(502, "HALO_NOT_CONFIGURED", "Halo credentials are not configured.");
  }
  return { clientId, clientSecret };
}

/** Lab proof OpenAPI contract (fixture, not the real HaloPSA spec): four
 * operations covering the proof matrix — safe read, searchable read,
 * explicitly-enabled mutation, and the destructive denial case. */
export function haloLabSpec(): OpenApiDocument {
  return {
    openapi: "3.0.3",
    info: { version: HALO_SPEC_VERSION, title: "HaloPSA lab proof" },
    servers: [{ url: HALO_ALLOWED_ORIGIN }],
    paths: {
      "/api/Tickets/{id}": {
        get: { operationId: "Ticket_Get", summary: "Get one ticket by id." },
        delete: { operationId: "Ticket_Delete", summary: "Delete one ticket (destructive)." },
      },
      "/api/Tickets": {
        get: { operationId: "Ticket_Search", summary: "Search tickets assigned to a team." },
      },
      "/api/Tickets/{id}/Notes": {
        post: { operationId: "Ticket_AddNote", summary: "Add a note to one ticket." },
      },
    },
  };
}

export interface HaloEnv {
  readonly HALO_CLIENT_ID?: string;
  readonly HALO_CLIENT_SECRET?: string;
}

export interface CodeModeCall {
  readonly operationId: string;
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface CodeModeResult {
  readonly result: unknown;
  readonly provenance: CodeModeProvenance;
}

/** Host-mediated Code Mode execution for Halo (ADR 022 section: the host
 * request path). Resolves the caller's own Organization Connection (never
 * cross-org), validates against the pinned contract, applies policy,
 * enforces the origin allowlist, injects credentials outside model-visible
 * state, and returns sanitized results with provenance.
 *
 * Secrets is the deployment credential pair (presence-checked here); fetch
 * is injectable so tests intercept only vendor HTTP, never D1/Workflows. */
export async function executeHaloOperation(
  db: D1Database,
  caller: Principal,
  secrets: HaloSecrets,
  call: CodeModeCall,
  vendor: { readonly fetchImpl?: typeof fetch } = {},
): Promise<CodeModeResult> {
  const { clientId, clientSecret } = requireHaloSecrets(secrets);
  const view = await getConnection(db, caller, HALO_INTEGRATION_ID).catch(() => null);
  if (!view) {
    throw new Fault(424, "OPENAPI_CONNECTION_MISSING", "No Halo Connection exists for this Organization.");
  }
  if (!view.enabled) {
    throw new Fault(404, "OPENAPI_CONNECTION_MISSING", "The Halo Connection is disabled.");
  }
  const spec = haloLabSpec();
  const pinned = await pinContract({ id: HALO_INTEGRATION_ID, name: "halo" }, JSON.stringify(spec), [
    HALO_ALLOWED_ORIGIN,
  ]);
  const operations = indexOperations(spec, HALO_CLASSIFICATIONS);
  const operation: ContractOperation = inspectOperation(operations, call.operationId);
  authorizeOperation(operation, HALO_DEFAULT_POLICY);
  const url = resolveRequestUrl(pinned, operation, { path: call.path, query: call.query });
  // Belt and braces: the Connection endpoint origin must equal the pinned
  // allowlist origin, so a remapped Connection cannot smuggle egress out.
  // Trailing slashes and case never hide a mismatch: compare URL origins.
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(view.endpoint).origin;
  } catch {
    throw new Fault(403, "OPENAPI_ORIGIN_FORBIDDEN", "The Connection endpoint is not an allowed Halo origin.");
  }
  if (endpointOrigin !== new URL(HALO_ALLOWED_ORIGIN).origin) {
    throw new Fault(403, "OPENAPI_ORIGIN_FORBIDDEN", "The Connection endpoint is not an allowed Halo origin.");
  }
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  const hasBody = call.body !== undefined;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: operation.method.toUpperCase(),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${clientId}:${clientSecret}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
    });
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", "The Halo API did not answer.");
  }
  const clean = (message: string): string => scrubTextWithSecrets(message, [clientId, clientSecret]);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean("The Halo API redirected the request."));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean(`The Halo API answered ${response.status}.`));
  }
  let result: unknown;
  try {
    const text = await response.text();
    result = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", "The Halo API returned an unreadable body.");
  }
  const scrubbed = scrubValueWithSecrets(result, [clientId, clientSecret]);
  const provenance = buildProvenance({
    callerUserId: caller.userId,
    orgId: caller.orgId,
    integrationId: HALO_INTEGRATION_ID,
    connectionId: view.id,
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    specDigest: pinned.specDigest,
    specVersion: pinned.specVersion,
  });
  return { result: scrubbed, provenance };
}

/** Progressive discovery entry points over the pinned lab contract: search
 * narrows by free text, inspect returns one exact operation. Both are pure
 * over the fixture spec; the route layer adds auth + Connection scoping. */
export function searchHaloOperations(query: string): readonly ContractOperation[] {
  return searchOperations(indexOperations(haloLabSpec(), HALO_CLASSIFICATIONS), query);
}

export function inspectHaloOperation(operationId: string): ContractOperation {
  return inspectOperation(indexOperations(haloLabSpec(), HALO_CLASSIFICATIONS), operationId);
}
