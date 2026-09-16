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
// The transport auth shape (HaloPSA OAuth2 client-credentials via the shared
// OAUTH-01 primitive: deployment pair to /auth/token, transient access token
// as the only Bearer credential) mirrors the NinjaOne Action boundary:
// presence-checked inside execution, never persisted to D1, never returned
// through discovery, and scrubbed from every outward Fault.
import { Fault, HALO_INTEGRATION_ID } from "../domain";
import type { Principal } from "../domain";
import {
  authorizeOperation,
  buildProvenance,
  indexOperations,
  inspectOperation,
  pinContract,
  readBoundedVendorBody,
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
import { requestClientCredentialsToken } from "../oauth";
import type { OAuthFaultTable } from "../oauth";
import { scrubTextWithSecrets, scrubValueWithSecrets } from "../secrets";

export { HALO_INTEGRATION_ID };

/** Allowed Halo origin for the lab proof. Production allowlists stay
 * Integration configuration, never spec `servers` entries. */
export const HALO_ALLOWED_ORIGIN = "https://halo-lab.example.com";

/** Pinned lab spec revision for the proof contract. Real pins record the
 * upstream source plus overlay digest; the proof spec is local fixture. */
export const HALO_SPEC_VERSION = "halo-lab-1";

/** HaloPSA OAuth token endpoint (public vendor contract: POST /auth/token on
 * the Halo origin with grant_type=client_credentials; the returned access
 * token rides resource calls as Bearer). Relative so the Connection endpoint
 * origin owns the absolute URL, like NinjaOne's regional token host. */
export const HALO_TOKEN_PATH = "/auth/token";

/** Halo scope requested at the token endpoint. Lab constant: real tenants
 * request the least-privilege scope their Halo application grants. */
export const HALO_SCOPE = "all";

/** Halo vendor deadline (mirrors NinjaOne posture): one shared 5s budget over
 * token acquisition plus the resource call, so the whole vendor interaction
 * stays inside a single explicit bound. */
export const HALO_TIMEOUT_MS = 5000;

/** Halo token Fault taxonomy (TOOL-01): provider-owned codes/messages, so
 * centralizing mechanics never renames the observable errors. */
const HALO_TOKEN_FAULTS: OAuthFaultTable = {
  notConfigured: { status: 502, code: "HALO_NOT_CONFIGURED", message: "Halo credentials are not configured." },
  redirected: { status: 502, code: "HALO_AUTH_FAILED", message: "Halo redirected the token request." },
  unauthorized: { status: 502, code: "HALO_UNAUTHORIZED", message: "Halo rejected the credentials." },
  rateLimited: { status: 502, code: "HALO_RATE_LIMITED", message: "Halo rate-limited the token request." },
  authFailed: { status: 502, code: "HALO_AUTH_FAILED", message: "Halo did not issue a token." },
  badResponse: { status: 502, code: "HALO_BAD_RESPONSE", message: "Halo returned an unexpected token response." },
  vendorTimeout: { status: 504, code: "HALO_VENDOR_TIMEOUT", message: "Halo exceeded its deadline." },
};

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

/** Caller authorization for Code Mode execution (issue #346): the route's
 * resolved CallerCtx answer. Reads execute under any active membership (the
 * route already gated that); mutations additionally require an admin caller
 * (instance or org admin). Deny-by-absence: no admin flag, no mutation. */
export interface HaloAuthCtx {
  readonly isInstanceAdmin: boolean;
  readonly isOrgAdmin: boolean;
}

export function isHaloAdminCaller(ctx: HaloAuthCtx): boolean {
  return ctx.isInstanceAdmin || ctx.isOrgAdmin;
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
  auth: HaloAuthCtx = { isInstanceAdmin: false, isOrgAdmin: false },
): Promise<CodeModeResult> {
  const { clientId, clientSecret } = requireHaloSecrets(secrets);
  // Only genuine absence maps to the 424 operator diagnosis. getConnection
  // answers CONNECTION_NOT_FOUND for a missing mapping; D1/driver/query
  // faults propagate so a backend outage never misdiagnoses as "missing".
  let view;
  try {
    view = await getConnection(db, caller, HALO_INTEGRATION_ID);
  } catch (error) {
    if (error instanceof Fault && error.code === "CONNECTION_NOT_FOUND") {
      throw new Fault(424, "OPENAPI_CONNECTION_MISSING", "No Halo Connection exists for this Organization.");
    }
    throw error;
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
  // Issue #346: the deployment credential is provider-global, so the
  // mutation risk class additionally requires an authorized caller. Reads
  // stay under membership + Connection authority; mutations without an
  // admin caller fail closed before any vendor contact.
  if (operation.risk === "mutation" && !isHaloAdminCaller(auth)) {
    throw new Fault(403, "OPENAPI_OPERATION_FORBIDDEN", "Only an admin may execute Halo mutations.");
  }
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
  // Authentic HaloPSA client-credentials flow (TOOL-01): exchange the
  // deployment pair for a transient access token at the Connection endpoint
  // origin's /auth/token, then send ONLY that token as the Bearer credential.
  // The token stays a transient local (ADR 005 v0): fetched, used, dropped —
  // registered for scrubbing, never persisted, never model-visible. The 5s
  // deadline is shared end to end (NinjaOne posture): token acquisition
  // consumes part of it, so the resource hop spends only what remains and the
  // whole vendor interaction stays inside one explicit bound.
  const started = Date.now();
  const timedOut = (): boolean => Date.now() - started >= HALO_TIMEOUT_MS;
  let token: string;
  try {
    const issued = await requestClientCredentialsToken({
      endpoint: view.endpoint,
      tokenPath: HALO_TOKEN_PATH,
      scope: HALO_SCOPE,
      credentials: { clientId, clientSecret },
      faults: HALO_TOKEN_FAULTS,
      timeoutMs: HALO_TIMEOUT_MS,
      fetchImpl,
    });
    token = issued.accessToken;
  } catch (error) {
    // Token-hop failures stay in stable provider codes (never a caller-error
    // 4xx for a vendor fault, never raw backend text): endpoint answers keep
    // their HALO_* taxonomy; malformed/oversized token bodies enter it as
    // HALO_BAD_RESPONSE; transport failures read as the vendor not answering.
    // A slow or merely-late token endpoint is the actionable deadline.
    const scrubPair = (message: string): string => scrubTextWithSecrets(message, [clientId, clientSecret]);
    if (error instanceof Fault) {
      if (error.code === "INVALID_JSON" || error.code === "BODY_TOO_LARGE") {
        throw new Fault(502, "HALO_BAD_RESPONSE", "Halo returned an unexpected token response.");
      }
      throw new Fault(error.status, error.code, scrubPair(error.message));
    }
    // A slow token endpoint is the actionable deadline; merely-late resolves
    // (transport ignored the abort) read the same way via the clock.
    if (isHaloTimeout(error) || timedOut()) {
      throw new Fault(504, "HALO_VENDOR_TIMEOUT", "Halo exceeded its deadline.");
    }
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", "The Halo API did not answer.");
  }
  const withToken = [clientId, clientSecret, token];
  const cleanToken = (message: string): string => scrubTextWithSecrets(message, withToken);
  const remaining = HALO_TIMEOUT_MS - (Date.now() - started);
  if (remaining <= 0 || timedOut()) {
    throw new Fault(504, "HALO_VENDOR_TIMEOUT", "Halo exceeded its deadline.");
  }
  const hasBody = call.body !== undefined;
  let response: Response;
  try {
    try {
      response = await fetchImpl(url, {
        method: operation.method.toUpperCase(),
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
      });
    } catch (error) {
      if (isHaloTimeout(error)) throw new Fault(504, "HALO_VENDOR_TIMEOUT", "Halo exceeded its deadline.");
      throw error;
    }
    if (timedOut()) {
      await response.body?.cancel();
      throw new Fault(504, "HALO_VENDOR_TIMEOUT", "Halo exceeded its deadline.");
    }
  } catch (error) {
    if (error instanceof Fault) throw new Fault(error.status, error.code, cleanToken(error.message));
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", "The Halo API did not answer.");
  }
  const clean = cleanToken;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean("The Halo API redirected the request."));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean(`The Halo API answered ${response.status}.`));
  }
  // Bounded host read (ADR 022 response-size rule): chunked bodies abort at
  // the bound with the remainder cancelled, so a provider can never force
  // full buffering or amplify model/tool output. Partial unsanitized bytes
  // never reach the caller; oversize and unreadable bodies fail closed.
  const result = await readBoundedVendorBody(response);
  // The transient access token joins the scrub set with the deployment pair:
  // a vendor echoing the token back in a body must still read scrubbed.
  const scrubbed = scrubValueWithSecrets(result, withToken);
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

/** A slow vendor is an actionable deadline, not a generic vendor failure:
 * true for abort/timeout rejections (NinjaOne posture) so callers map them
 * onto HALO_VENDOR_TIMEOUT. Any other transport error maps to the vendor not
 * answering. Pure predicate (no throw) so both hops share one branch shape. */
function isHaloTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
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
