// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): shared source emitter used by both the typed generator
// and the plain-Node CLI. Keep validation/indexing in their native layers;
// this module owns the emitted Integration implementation so the two entry
// points cannot drift into different runtime behavior.
//
// Auth shapes: `apiToken` emits a bearer-token host (Authorization: Bearer
// <token>, apiToken secret); `clientCredentials` emits the OAuth
// client-credentials exchange host (the HaloPSA shape). The emitter never
// guesses: the typed generator and the CLI both resolve the kind from the
// spec's securitySchemes and fail closed on unknown schemes.

function cap(slug) {
  return slug
    .split("_")
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1).toLowerCase()))
    .join("");
}

// INT-01 review (CWE-94): OpenAPI path keys only have to start with `/`, so a
// crafted spec could smuggle CR/LF/U+2028/U+2029 into the emitted `//`
// comment and break out of the comment line. Collapse those separators, the
// same treatment as the version/digest sanitizers, so emitted source stays
// single-line per operation.
function safeCommentFragment(text) {
  return String(text).replace(/[\r\n\u2028\u2029]+/g, " ");
}

function cleanTokenPath(tokenPath) {
  const value = String(tokenPath ?? "/auth/token");
  if (!value.startsWith("/") || value.length > 128) return "/auth/token";
  return value;
}

function cleanScope(scope) {
  const value = String(scope ?? "all");
  return value.length === 0 || value.length > 128 ? "all" : value;
}

function cleanTimeoutMs(timeoutMs) {
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000 ? timeoutMs : 5000;
}

export function emitIntegrationSource({
  doc,
  operations,
  id,
  name,
  allowedOrigins,
  envPrefix,
  digestHex,
  version,
  authKind = "clientCredentials",
  integrationUuid,
  tokenPath = "/auth/token",
  scope = "all",
  timeoutMs = 5000,
}) {
  const prefix = id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const cleanVersion = safeCommentFragment(version).slice(0, 64);
  const cleanDigest = digestHex.replace(/[^a-f0-9]/g, "").slice(0, 64);
  const cleanUuid = String(integrationUuid ?? id)
    .toLowerCase()
    .replace(/[^a-f0-9-]/g, "")
    .slice(0, 36);
  // Clamp, never trust: the typed generator and the CLI already validated
  // these, so out-of-band callers get safe output rather than a throw from
  // deep inside the template.
  const kind = authKind === "apiToken" ? "apiToken" : "clientCredentials";
  const tokenPathLiteral = JSON.stringify(cleanTokenPath(tokenPath).slice(0, 128));
  const scopeLiteral = JSON.stringify(cleanScope(scope).slice(0, 128));
  const timeoutMsLiteral = JSON.stringify(cleanTimeoutMs(timeoutMs));
  const opsLiteral = operations
    .map(
      (op) =>
        `    ${JSON.stringify(op.operationId)}: ${JSON.stringify(op.risk)}, // ${safeCommentFragment(op.method.toUpperCase())} ${safeCommentFragment(op.path)}`,
    )
    .join("\n");
  const originsLiteral = allowedOrigins.map((origin) => `  ${JSON.stringify(origin)},`).join("\n");
  const specLiteral = JSON.stringify(doc);
  const integrationName = JSON.stringify(name);
  const typeName = cap(prefix);
  const authComment =
    kind === "apiToken"
      ? "// Auth: bearer ApiToken — the apiToken secret rides as `Authorization: Bearer <token>`."
      : "// Auth: OAuth client-credentials — the deployment pair is exchanged for a transient token first.";

  const identityBlock =
    kind === "apiToken"
      ? `/** Stable Integration identity for this generated provider (deterministic
 * UUIDv5 over the pinned spec digest: same spec bytes, same ID).
${authComment} */
export const ${prefix}_INTEGRATION_ID = ${JSON.stringify(cleanUuid)};`
      : `/** Stable Integration identity for this generated provider (deterministic
 * UUIDv5 over the pinned spec digest: same spec bytes, same ID).
${authComment} */
export const ${prefix}_INTEGRATION_ID = ${JSON.stringify(cleanUuid)};`;

  const secretsBlock =
    kind === "apiToken"
      ? `export interface ${prefix}Secrets {
  readonly apiToken?: string;
}

export function require${typeName}Secrets(secrets: ${prefix}Secrets): { apiToken: string } {
  const { apiToken } = secrets;
  if (!apiToken) {
    throw new Fault(502, "${prefix}_NOT_CONFIGURED", "Integration credentials are not configured.");
  }
  return { apiToken };
}

export interface ${prefix}Env {
  readonly ${envPrefix}?: string;
}`
      : `export interface ${prefix}Secrets {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

export function require${typeName}Secrets(secrets: ${prefix}Secrets): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = secrets;
  if (!clientId || !clientSecret) {
    throw new Fault(502, "${prefix}_NOT_CONFIGURED", "Integration credentials are not configured.");
  }
  return { clientId, clientSecret };
}

export interface ${prefix}Env {
  readonly ${envPrefix}_ID?: string;
  readonly ${envPrefix}_SECRET?: string;
}`;

  const oauthSupportBlock =
    kind === "apiToken"
      ? ""
      : `
/** OAuth token endpoint path for this provider's client-credentials flow,
 * resolved against the Connection endpoint origin (never a spec servers
 * entry). The operator overrides it per provider at generation time when the
 * vendor documents a different token path; HaloPSA uses /auth/token. */
export const ${prefix}_TOKEN_PATH = ${tokenPathLiteral};

/** Vendor token-deadline for this provider (matches the hand-written Halo
 * host posture): one shared bound over token acquisition plus the resource
 * call, so the whole vendor interaction stays inside a single deadline. */
export const ${prefix}_TIMEOUT_MS = ${timeoutMsLiteral};

/** Token Fault taxonomy for this provider: provider-owned codes/messages, so
 * centralizing mechanics never renames the observable errors. The operator
 * renames the PREFIX per provider when forking this template. */
const ${prefix}_TOKEN_FAULTS: OAuthFaultTable = {
  notConfigured: { status: 502, code: "${prefix}_NOT_CONFIGURED", message: "Integration credentials are not configured." },
  redirected: { status: 502, code: "${prefix}_AUTH_FAILED", message: "The vendor redirected the token request." },
  unauthorized: { status: 502, code: "${prefix}_UNAUTHORIZED", message: "The vendor rejected the credentials." },
  rateLimited: { status: 502, code: "${prefix}_RATE_LIMITED", message: "The vendor rate-limited the token request." },
  authFailed: { status: 502, code: "${prefix}_AUTH_FAILED", message: "The vendor did not issue a token." },
  badResponse: { status: 502, code: "${prefix}_BAD_RESPONSE", message: "The vendor returned an unexpected token response." },
  vendorTimeout: { status: 504, code: "${prefix}_VENDOR_TIMEOUT", message: "The vendor exceeded its deadline." },
};
`;

  const oauthImports =
    kind === "apiToken"
      ? ""
      : `import { requestClientCredentialsToken } from "../oauth";
import type { OAuthFaultTable } from "../oauth";
`;

  const executionBlock =
    kind === "apiToken"
      ? `export async function execute${typeName}Operation(
  db: D1Database,
  caller: Principal,
  secrets: ${prefix}Secrets,
  call: CodeModeCall,
  vendor: { readonly fetchImpl?: typeof fetch } = {},
): Promise<CodeModeResult> {
  const { apiToken } = require${typeName}Secrets(secrets);
  // Only genuine absence maps to the 424 operator diagnosis: D1/driver/query
  // faults propagate so a backend outage never misdiagnoses as "missing".
  let view;
  try {
    view = await getConnection(db, caller, ${prefix}_INTEGRATION_ID);
  } catch (error) {
    if (error instanceof Fault && error.code === "CONNECTION_NOT_FOUND") {
      throw new Fault(424, "OPENAPI_CONNECTION_MISSING", "No Connection exists for this Organization.");
    }
    throw error;
  }
  if (!view.enabled) {
    throw new Fault(404, "OPENAPI_CONNECTION_MISSING", "The Connection is disabled.");
  }
  const operations = indexOperations(await pinnedSpec(), ${prefix}_CLASSIFICATIONS);
  const operation: ContractOperation = inspectOperation(operations, call.operationId);
  authorizeOperation(operation, ${prefix}_DEFAULT_POLICY);
  const pinned = await pinnedContract();
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(view.endpoint).origin;
  } catch {
    throw new Fault(403, "OPENAPI_ORIGIN_FORBIDDEN", "The Connection endpoint is not an allowed origin.");
  }
  const allowed = ${prefix}_ALLOWED_ORIGINS.some((origin) => {
    try {
      return new URL(origin).origin === endpointOrigin;
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new Fault(403, "OPENAPI_ORIGIN_FORBIDDEN", "The Connection endpoint is not an allowed origin.");
  }
  const url = resolveRequestUrl({ ...pinned, allowedOrigins: [endpointOrigin] }, operation, { path: call.path, query: call.query });
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  // Bearer ApiToken host: the Connection credential rides directly as
  // \`Authorization: Bearer <token>\`. No token exchange, no client pair.
  const clean = (message: string): string => scrubTextWithSecrets(message, [apiToken]);
  const hasBody = call.body !== undefined;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: operation.method.toUpperCase(),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: {
        Accept: "application/json",
        Authorization: \`Bearer \${apiToken}\`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
    });
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", "The vendor API did not answer.");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean("The vendor API redirected the request."));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean(\`The vendor API answered \${response.status}.\`));
  }
  // Bounded host read: oversized or unreadable vendor bodies fail closed
  // before full buffering; partial unsanitized bytes never reach the caller.
  const result = await readBoundedVendorBody(response);
  const scrubbed = scrubValueWithSecrets(result, [apiToken]);
  const provenance = buildProvenance({
    callerUserId: caller.userId,
    orgId: caller.orgId,
    integrationId: ${prefix}_INTEGRATION_ID,
    connectionId: view.id,
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    specDigest: pinned.specDigest,
    specVersion: pinned.specVersion,
  });
  return { result: scrubbed, provenance };
}`
      : `export async function execute${typeName}Operation(
  db: D1Database,
  caller: Principal,
  secrets: ${prefix}Secrets,
  call: CodeModeCall,
  vendor: { readonly fetchImpl?: typeof fetch } = {},
): Promise<CodeModeResult> {
  const { clientId, clientSecret } = require${typeName}Secrets(secrets);
  // Only genuine absence maps to the 424 operator diagnosis: D1/driver/query
  // faults propagate so a backend outage never misdiagnoses as "missing".
  let view;
  try {
    view = await getConnection(db, caller, ${prefix}_INTEGRATION_ID);
  } catch (error) {
    if (error instanceof Fault && error.code === "CONNECTION_NOT_FOUND") {
      throw new Fault(424, "OPENAPI_CONNECTION_MISSING", "No Connection exists for this Organization.");
    }
    throw error;
  }
  if (!view.enabled) {
    throw new Fault(404, "OPENAPI_CONNECTION_MISSING", "The Connection is disabled.");
  }
  const operations = indexOperations(await pinnedSpec(), ${prefix}_CLASSIFICATIONS);
  const operation: ContractOperation = inspectOperation(operations, call.operationId);
  authorizeOperation(operation, ${prefix}_DEFAULT_POLICY);
  const pinned = await pinnedContract();
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(view.endpoint).origin;
  } catch {
    throw new Fault(403, "OPENAPI_ORIGIN_FORBIDDEN", "The Connection endpoint is not an allowed origin.");
  }
  const allowed = ${prefix}_ALLOWED_ORIGINS.some((origin) => {
    try {
      return new URL(origin).origin === endpointOrigin;
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new Fault(403, "OPENAPI_ORIGIN_FORBIDDEN", "The Connection endpoint is not an allowed origin.");
  }
  const url = resolveRequestUrl({ ...pinned, allowedOrigins: [endpointOrigin] }, operation, { path: call.path, query: call.query });
  const fetchImpl = vendor.fetchImpl ?? globalThis.fetch;
  // Provider client-credentials flow (TOOL-01): exchange the deployment pair
  // for a transient access token at the Connection endpoint origin's token
  // path, then send ONLY that token as the Bearer credential. The token stays
  // transient — fetched, used, dropped, scrubbed — never persisted, never
  // model-visible. One shared deadline covers token plus resource call.
  const started = Date.now();
  const timedOut = () => Date.now() - started >= ${prefix}_TIMEOUT_MS;
  let token;
  try {
    const issued = await requestClientCredentialsToken({
      endpoint: view.endpoint,
      tokenPath: ${prefix}_TOKEN_PATH,
      scope: ${scopeLiteral},
      credentials: { clientId, clientSecret },
      faults: ${prefix}_TOKEN_FAULTS,
      timeoutMs: ${prefix}_TIMEOUT_MS,
      fetchImpl,
    });
    token = issued.accessToken;
  } catch (error) {
    if (error instanceof Fault)
      throw new Fault(error.status, error.code, scrubTextWithSecrets(error.message, [clientId, clientSecret]));
    throw error;
  }
  const withToken = [clientId, clientSecret, token];
  const cleanToken = (message) => scrubTextWithSecrets(message, withToken);
  const remaining = ${prefix}_TIMEOUT_MS - (Date.now() - started);
  if (remaining <= 0 || timedOut()) {
    throw new Fault(504, "${prefix}_VENDOR_TIMEOUT", "The vendor exceeded its deadline.");
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
          Authorization: \`Bearer \${token}\`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Fault(504, "${prefix}_VENDOR_TIMEOUT", "The vendor exceeded its deadline.");
      }
      throw error;
    }
    if (timedOut()) {
      await response.body?.cancel();
      throw new Fault(504, "${prefix}_VENDOR_TIMEOUT", "The vendor exceeded its deadline.");
    }
  } catch (error) {
    if (error instanceof Fault) throw new Fault(error.status, error.code, cleanToken(error.message));
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", "The vendor API did not answer.");
  }
  const clean = cleanToken;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean("The vendor API redirected the request."));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Fault(502, "OPENAPI_EXECUTION_FAILED", clean(\`The vendor API answered \${response.status}.\`));
  }
  // Bounded host read: oversized or unreadable vendor bodies fail closed
  // before full buffering; partial unsanitized bytes never reach the caller.
  // The transient access token joins the scrub set with the deployment pair.
  const result = await readBoundedVendorBody(response);
  const scrubbed = scrubValueWithSecrets(result, withToken);
  const provenance = buildProvenance({
    callerUserId: caller.userId,
    orgId: caller.orgId,
    integrationId: ${prefix}_INTEGRATION_ID,
    connectionId: view.id,
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    specDigest: pinned.specDigest,
    specVersion: pinned.specVersion,
  });
  return { result: scrubbed, provenance };
}`;

  return `// SPDX-License-Identifier: AGPL-3.0
// Generated by \`wrangnarok generate-integration\` (INT-01, issue #229).
// DO NOT EDIT BY HAND: regenerate from the pinned spec instead.
// Spec digest: ${cleanDigest}
// Spec version: ${cleanVersion}
// Operations: ${operations.length}
// Auth kind: ${kind}
import { Fault } from "../domain";
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
import type { CodeModeProvenance, ContractOperation, OpenApiDocument, OperationPolicy, OperationRisk } from "../openapi";
import { getConnection } from "../connections";
${oauthImports}import { scrubTextWithSecrets, scrubValueWithSecrets } from "../secrets";

${identityBlock}

/** Allowed origins for this Integration (operator-configured, never spec servers). */
export const ${prefix}_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
${originsLiteral}
]);

/** Default Code Mode policy: reads execute under Connection authority;
 * mutations need explicit per-operation enablement; destructive and above
 * stay deny-by-default until an operator enables them. */
export const ${prefix}_DEFAULT_POLICY: OperationPolicy = {
  enabledOperations: [],
  deniedOperations: [],
  enabledRisks: [],
};
${oauthSupportBlock}
/** Risk classification per operationId (method defaults refined here). */
export const ${prefix}_CLASSIFICATIONS: Readonly<Record<string, OperationRisk>> = Object.freeze({
${opsLiteral}
});

${secretsBlock}

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

${executionBlock}

/** Pinned spec document embedded at generation time: the generated module
 * is self-contained. Validated before emission, so this literal is always
 * a well-formed OpenAPI 3.x document. Stripped to the embedding budget
 * (no examples, no vendor extensions, descriptions truncated). */
const __GENERATED_SPEC__: OpenApiDocument = ${specLiteral};

async function pinnedSpec(): Promise<OpenApiDocument> {
  return __GENERATED_SPEC__;
}

async function pinnedContract() {
  return pinContract({ id: ${prefix}_INTEGRATION_ID, name: ${integrationName} }, JSON.stringify(__GENERATED_SPEC__), [
    ...${prefix}_ALLOWED_ORIGINS,
  ]);
}

export function search${typeName}Operations(query: string): readonly ContractOperation[] {
  return searchOperations(indexOperations(__GENERATED_SPEC__, ${prefix}_CLASSIFICATIONS), query);
}

export function inspect${typeName}Operation(operationId: string): ContractOperation {
  return inspectOperation(indexOperations(__GENERATED_SPEC__, ${prefix}_CLASSIFICATIONS), operationId);
}
`;
}
