// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170) Code Mode engine (ADR 022): progressive
// search/inspect/execute over a pinned Integration OpenAPI contract.
//
// The model never sees credentials and never gets unrestricted fetch. It
// searches the pinned spec (server-side), inspects one operation, then asks
// the host to execute it. The host resolves Organization + Integration +
// Connection, enforces policy + egress, injects auth outside model-visible
// state, and emits sanitized audit/provenance carrying the spec digest.
//
// Fail-closed rules: unknown operations, unclassified writes, and
// deny-by-default risk classes never execute; the allowed origin is the
// Integration-configured allowlist, never the spec's `servers` entries.
import { Fault } from "./domain";

/** Operation risk classes (ADR 022). Reads default open; every write class
 * except explicitly-approved standard mutations is deny-by-default; unknown
 * operations fail closed without a classification. */
export const OPERATION_RISK = [
  "read",
  "mutation",
  "destructive",
  "credential",
  "billing",
  "security",
  "tenant-admin",
] as const;
export type OperationRisk = (typeof OPERATION_RISK)[number];

/** HTTP methods that never mutate by default. Everything else starts as a
 * mutation and needs explicit policy plus classification to execute. */
const SAFE_METHODS = new Set(["get", "head", "options"]);

/** Pinned Integration API contract: the OpenAPI document digest/version the
 * execution host validated, plus the allowed origin allowlist and any local
 * overlay digest used to correct provider-spec defects. */
export interface PinnedContract {
  readonly integrationId: string;
  readonly integrationName: string;
  /** Hex digest of the exact spec bytes validated at pin time. */
  readonly specDigest: string;
  readonly specVersion: string;
  /** Allowed origins; requests outside this list never issue. */
  readonly allowedOrigins: readonly string[];
  /** Digest of the applied local overlay, when one corrected spec defects. */
  readonly overlayDigest: string | null;
  readonly pinnedAt: string;
}

/** One searchable operation distilled from the pinned contract. */
export interface ContractOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly risk: OperationRisk;
  /** True when the spec marks this operation `deprecated: true`. Deprecated
   * operations are excluded from progressive search and execution unless the
   * caller opts in explicitly. */
  readonly deprecated: boolean;
}

export interface OperationPolicy {
  /** Explicitly enabled operationIds (mutations need listing here). */
  readonly enabledOperations: readonly string[];
  /** Explicitly denied operationIds (deny wins over enable). */
  readonly deniedOperations: readonly string[];
  /** Risk classes the operator enabled beyond reads. */
  readonly enabledRisks: readonly OperationRisk[];
}

/** Minimal OpenAPI 3.x shape the host validates before pinning. Only the
 * fields Code Mode reads are modeled; everything else is ignored. */
export interface OpenApiDocument {
  readonly openapi?: unknown;
  readonly info?: { readonly version?: unknown; readonly title?: unknown };
  readonly servers?: readonly { readonly url?: unknown }[];
  readonly paths?: Record<string, Record<string, OperationDef>>;
}

export interface OperationDef {
  readonly operationId?: unknown;
  readonly summary?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
  readonly parameters?: unknown;
  readonly deprecated?: unknown;
}

/** Generator auth kinds (INT-01, issue #229): how the emitted Integration
 * obtains its Authorization header at execution time. `apiToken` sends a
 * bearer token resolved from Connection credentials (`Authorization: Bearer
 * <token>`); `clientCredentials` exchanges a deployment pair for a transient
 * token first (the HaloPSA shape); `unknown` means the spec's securitySchemes
 * declared nothing recognizable and generation must fail closed. */
export type GeneratorAuthKind = "apiToken" | "clientCredentials" | "unknown";

/** Detect the generator auth kind from the spec's `components.securitySchemes`
 * (falling back to any referenced scheme names in top-level or per-operation
 * `security` blocks when components are absent). `http` bearer and `apiKey`
 * schemes yield `apiToken` (bearer ApiToken shape); `oauth2` flows with a
 * clientCredentials-capable grant (`clientCredentials`, `application`, or an
 * empty flows object) yield `clientCredentials`. Anything else — including a
 * spec with no security declarations at all — yields `unknown` so generation
 * fails closed instead of stamping the wrong credential shape. */
export function detectGeneratorAuthKind(doc: OpenApiDocument): GeneratorAuthKind {
  const raw = doc as unknown as Record<string, unknown>;
  const components = raw["components"];
  const schemesRaw =
    components !== null && typeof components === "object" && !Array.isArray(components)
      ? (components as Record<string, unknown>)["securitySchemes"]
      : undefined;
  const schemes: Record<string, unknown> =
    schemesRaw !== null && typeof schemesRaw === "object" && !Array.isArray(schemesRaw)
      ? (schemesRaw as Record<string, unknown>)
      : {};
  const names = Object.keys(schemes);
  // No declared schemes: consult security references (a spec may reference a
  // scheme name without declaring components). Nothing recognizable either
  // way means unknown — never guess bearer from silence.
  if (names.length === 0) {
    return referencesBearerName(raw) ? "apiToken" : "unknown";
  }
  let sawBearer = false;
  let sawOAuth = false;
  for (const name of names) {
    const scheme = schemes[name];
    if (scheme === null || typeof scheme !== "object" || Array.isArray(scheme)) continue;
    const entry = scheme as Record<string, unknown>;
    const type = typeof entry["type"] === "string" ? entry["type"].toLowerCase() : "";
    if (type === "oauth2") {
      if (oauthGrantsClientCredentials(entry["flows"])) sawOAuth = true;
      continue;
    }
    if (type === "http" && typeof entry["scheme"] === "string" && entry["scheme"].toLowerCase() === "bearer") {
      sawBearer = true;
      continue;
    }
    if (type === "apikey") {
      sawBearer = true;
      continue;
    }
    // Basic auth: token rides as a single bearer credential at execution
    // time, so it shares the apiToken shape (never OAuth client fields).
    if (type === "http" && typeof entry["scheme"] === "string" && entry["scheme"].toLowerCase() === "basic") {
      sawBearer = true;
      continue;
    }
  }
  if (sawBearer) return "apiToken";
  if (sawOAuth) return "clientCredentials";
  return referencesBearerName(raw) ? "apiToken" : "unknown";
}

function oauthGrantsClientCredentials(flows: unknown): boolean {
  if (flows === null || typeof flows !== "object" || Array.isArray(flows)) return true;
  const table = flows as Record<string, unknown>;
  const keys = Object.keys(table);
  if (keys.length === 0) return true;
  return keys.some((key) => ["clientcredentials", "client_credentials", "application"].includes(key.toLowerCase()));
}

/** True when any top-level or per-operation `security` block references a
 * name shaped like a bearer/api-token scheme (ApiToken, bearer, apiKey).
 * Structural fallback only: precise typing still comes from securitySchemes. */
function referencesBearerName(raw: Record<string, unknown>): boolean {
  const names = new Set<string>();
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const requirement of value) {
      if (requirement === null || typeof requirement !== "object" || Array.isArray(requirement)) continue;
      for (const name of Object.keys(requirement as Record<string, unknown>)) names.add(name.toLowerCase());
    }
  };
  collect(raw["security"]);
  const paths = raw["paths"];
  if (paths !== null && typeof paths === "object" && !Array.isArray(paths)) {
    for (const methods of Object.values(paths as Record<string, unknown>)) {
      if (methods === null || typeof methods !== "object" || Array.isArray(methods)) continue;
      for (const def of Object.values(methods as Record<string, unknown>)) {
        if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
        collect((def as Record<string, unknown>)["security"]);
      }
    }
  }
  if (names.size === 0) return false;
  return [...names].some((name) => /apitoken|bearer|apikey|api_key|token/.test(name));
}

const OPERATION_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const SPEC_BYTES_MAX = 2 * 1024 * 1024;

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Validate a candidate OpenAPI document before pinning. Returns the
 * operation count. Throws OPENAPI_CONTRACT_INVALID on structural defects:
 * not OpenAPI 3.x, missing info.version, no paths, operations without
 * operationIds, or duplicate operationIds. Spec `servers` entries are
 * recorded for diagnostics only — never trusted as egress authority. */
export function validateContractDocument(value: unknown): { operationCount: number; version: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("OPENAPI_CONTRACT_INVALID", "The OpenAPI contract must be a JSON object.");
  }
  const doc = value as OpenApiDocument;
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw invalid("OPENAPI_CONTRACT_INVALID", "Only OpenAPI 3.x contracts can be pinned.");
  }
  const version =
    doc.info && typeof doc.info === "object" && typeof (doc.info as { version?: unknown }).version === "string"
      ? (doc.info as { version: string }).version.slice(0, 64)
      : "";
  if (!version) throw invalid("OPENAPI_CONTRACT_INVALID", "The OpenAPI contract needs info.version.");
  if (!doc.paths || typeof doc.paths !== "object" || Array.isArray(doc.paths)) {
    throw invalid("OPENAPI_CONTRACT_INVALID", "The OpenAPI contract needs a paths object.");
  }
  const seen = new Set<string>();
  let count = 0;
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (!path.startsWith("/") || methods === null || typeof methods !== "object" || Array.isArray(methods)) {
      throw invalid("OPENAPI_CONTRACT_INVALID", `Contract path ${JSON.stringify(path)} is malformed.`);
    }
    for (const [method, def] of Object.entries(methods)) {
      if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
      const operationId = (def as OperationDef).operationId;
      if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
        throw invalid(
          "OPENAPI_CONTRACT_INVALID",
          `Contract operation ${method.toUpperCase()} ${path} needs a stable operationId.`,
        );
      }
      if (seen.has(operationId)) {
        throw invalid("OPENAPI_CONTRACT_INVALID", `Duplicate operationId ${JSON.stringify(operationId)}.`);
      }
      seen.add(operationId);
      count += 1;
    }
  }
  if (count === 0) throw invalid("OPENAPI_CONTRACT_INVALID", "The OpenAPI contract declares no operations.");
  return { operationCount: count, version };
}

/** Digest arbitrary bytes to lowercase hex (SHA-256). Async: workerd SubtleCrypto. */
export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Digest a UTF-8 string. */
export function digestTextSync(text: string): Promise<string> {
  return digestBytes(new TextEncoder().encode(text));
}

/** Pin a validated contract: digest the exact bytes, record the version and
 * the Integration-configured origin allowlist. Enforces the spec size bound
 * before hashing so oversized specs fail before they cost hashing work. */
export async function pinContract(
  integration: { readonly id: string; readonly name: string },
  specText: string,
  allowedOrigins: readonly string[],
  overlayDigest: string | null = null,
): Promise<PinnedContract> {
  if (new TextEncoder().encode(specText).length > SPEC_BYTES_MAX) {
    throw invalid("OPENAPI_CONTRACT_TOO_LARGE", "The OpenAPI contract exceeds the 2 MiB pin bound.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(specText);
  } catch {
    throw invalid("OPENAPI_CONTRACT_INVALID", "The OpenAPI contract must parse as JSON.");
  }
  const { version } = validateContractDocument(parsed);
  if (allowedOrigins.length === 0) {
    throw invalid("OPENAPI_CONTRACT_INVALID", "Pinning needs at least one allowed origin.");
  }
  for (const origin of allowedOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw invalid("OPENAPI_CONTRACT_INVALID", `Allowed origin ${JSON.stringify(origin)} is not a URL.`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw invalid("OPENAPI_CONTRACT_INVALID", `Allowed origin ${JSON.stringify(origin)} is not an http(s) origin.`);
    }
  }
  return Object.freeze({
    integrationId: integration.id,
    integrationName: integration.name,
    specDigest: await digestTextSync(specText),
    specVersion: version,
    allowedOrigins: Object.freeze([...allowedOrigins]),
    overlayDigest,
    pinnedAt: new Date().toISOString(),
  });
}

/** Distill searchable operations from a validated contract document with
 * per-operation risk. Method-level defaults apply (safe methods read,
 * everything else mutation); the caller-supplied classification map refines
 * individual operationIds. Unknown operationIds without a classification
 * stay at their method default — writes therefore still need policy.
 * Operations marked `deprecated: true` in the spec are excluded unless
 * `includeDeprecated` is true: deprecated endpoints are never callable by
 * default. */
export function indexOperations(
  doc: OpenApiDocument,
  classifications: Readonly<Record<string, OperationRisk>> = {},
  options: { readonly includeDeprecated?: boolean } = {},
): readonly ContractOperation[] {
  const operations: ContractOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    if (methods === null || typeof methods !== "object") continue;
    for (const [method, def] of Object.entries(methods)) {
      if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
      const operationId = (def as OperationDef).operationId;
      if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) continue;
      const deprecated = (def as OperationDef).deprecated === true;
      if (deprecated && options.includeDeprecated !== true) continue;
      const summaryRaw = (def as OperationDef).summary;
      const summary = typeof summaryRaw === "string" ? summaryRaw.slice(0, 280) : "";
      const classified = classifications[operationId];
      const risk: OperationRisk =
        classified !== undefined && (OPERATION_RISK as readonly string[]).includes(classified)
          ? classified
          : SAFE_METHODS.has(method.toLowerCase())
            ? "read"
            : "mutation";
      operations.push(Object.freeze({ operationId, method: method.toLowerCase(), path, summary, risk, deprecated }));
    }
  }
  return Object.freeze(operations);
}

/** Progressive search over the pinned operations: every whitespace-separated
 * token must appear (case-insensitive) somewhere in the operation's
 * operationId, path, or summary. Empty queries match nothing (the model
 * must name what it wants); results are capped so large specs cost context
 * proportional to need, not to spec size. */
export function searchOperations(
  operations: readonly ContractOperation[],
  query = "",
  limit = 10,
): readonly ContractOperation[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.some((token) => token.length > 128)) return Object.freeze([]);
  const capped = Math.max(1, Math.min(limit, 50));
  const hits = operations.filter((entry) => {
    const haystack = `${entry.operationId} ${entry.path} ${entry.summary}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  return Object.freeze(hits.slice(0, capped));
}

/** Inspect one operation: the exact request shape the host will execute.
 * Unknown operationIds fail closed — the model cannot invent endpoints. */
export function inspectOperation(operations: readonly ContractOperation[], operationId: string): ContractOperation {
  const found = operations.find((entry) => entry.operationId === operationId);
  if (!found) throw invalid("OPENAPI_UNKNOWN_OPERATION", `Unknown operation ${JSON.stringify(operationId)}.`, 404);
  return found;
}

const DENY_BY_DEFAULT_RISKS: readonly OperationRisk[] = Object.freeze([
  "destructive",
  "credential",
  "billing",
  "security",
  "tenant-admin",
]);

/** Authorize one operation against the operator policy. Deny-by-default:
 * unknown operations, denied operationIds, deny-by-default risk classes, and
 * mutations outside the enabled list all fail closed with distinct codes so
 * callers can tell "not listed" from "explicitly denied". Reads execute when
 * the caller already has Connection authority and no explicit deny exists. */
export function authorizeOperation(operation: ContractOperation, policy: OperationPolicy): void {
  if (policy.deniedOperations.includes(operation.operationId)) {
    throw invalid(
      "OPENAPI_OPERATION_DENIED",
      `Operation ${JSON.stringify(operation.operationId)} is explicitly denied.`,
      403,
    );
  }
  if ((DENY_BY_DEFAULT_RISKS as readonly string[]).includes(operation.risk)) {
    if (!policy.enabledOperations.includes(operation.operationId)) {
      throw invalid(
        "OPENAPI_OPERATION_DENIED",
        `Operation ${JSON.stringify(operation.operationId)} (${operation.risk}) is deny-by-default until explicitly enabled.`,
        403,
      );
    }
    return;
  }
  if (operation.risk === "mutation") {
    if (!policy.enabledOperations.includes(operation.operationId)) {
      throw invalid(
        "OPENAPI_OPERATION_NOT_ENABLED",
        `Operation ${JSON.stringify(operation.operationId)} is not enabled for Code Mode execution.`,
        403,
      );
    }
    return;
  }
}

/** Resolve a request path against the pinned contract and the allowlist.
 * The allowed origin comes from Integration configuration, never from the
 * spec's `servers` entries or model arguments: crafted specs and path
 * traversals (`..`, absolute URLs, protocol-relative hosts) fail closed. */
export function resolveRequestUrl(
  contract: PinnedContract,
  operation: ContractOperation,
  params: { readonly path?: Readonly<Record<string, string>>; readonly query?: Readonly<Record<string, string>> },
): string {
  let path = operation.path;
  const seen = new Set<string>();
  path = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    seen.add(name);
    const value = params.path?.[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw invalid("OPENAPI_INVALID_PARAMS", `Path parameter ${JSON.stringify(name)} is required.`);
    }
    if (/[/?#]/.test(value))
      throw invalid("OPENAPI_INVALID_PARAMS", `Path parameter ${JSON.stringify(name)} is unsafe.`);
    return encodeURIComponent(value);
  });
  if (!path.startsWith("/")) throw invalid("OPENAPI_INVALID_PARAMS", "The operation path is malformed.");
  if (path.includes("..")) throw invalid("OPENAPI_INVALID_PARAMS", "Path traversal is rejected.");
  const base = contract.allowedOrigins[0];
  if (!base) throw invalid("OPENAPI_ORIGIN_FORBIDDEN", "No allowed origin is configured.", 403);
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw invalid("OPENAPI_INVALID_PARAMS", "The operation path is malformed.");
  }
  const allowed = contract.allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return url.origin === parsed.origin;
    } catch {
      return false;
    }
  });
  if (!allowed) throw invalid("OPENAPI_ORIGIN_FORBIDDEN", "The resolved origin is outside the allowlist.", 403);
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || value.length > 1024) {
        throw invalid("OPENAPI_INVALID_PARAMS", "Query parameters are malformed.");
      }
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
}

/** Maximum vendor response body the Code Mode host will buffer (ADR 022
 * response-size rule, issue #170): large specs stay server-side and results
 * must fit model context anyway, so a provider answering above this bound —
 * chunked or declared — aborts fail-closed before full buffering. */
export const CODEMODE_RESPONSE_BYTES_MAX = 256 * 1024;

/** Read one vendor response body under the Code Mode response bound. A
 * declared Content-Length above the bound fails before any byte is read; an
 * undeclared (chunked) body is streamed and aborted at bound + 1 with the
 * remainder cancelled, so a provider can never force full buffering of an
 * arbitrarily large body. Returns the parsed JSON value (null for empty).
 * Oversized bodies throw OPENAPI_RESPONSE_TOO_LARGE; malformed length
 * headers and unparseable bodies throw OPENAPI_EXECUTION_FAILED. Fault
 * messages are fixed strings — partial unsanitized bytes never reach the
 * caller, so this is also a model/tool-output amplification fence. */
export async function readBoundedVendorBody(response: Response): Promise<unknown> {
  const failUnreadable = (): Fault =>
    invalid("OPENAPI_EXECUTION_FAILED", "The vendor API returned an unreadable body.", 502);
  const failTooLarge = (): Fault =>
    invalid("OPENAPI_RESPONSE_TOO_LARGE", "The vendor API returned a body above the Code Mode response bound.", 502);
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared.trim());
    if (!Number.isSafeInteger(length) || length < 0) {
      await response.body?.cancel();
      throw failUnreadable();
    }
    if (length > CODEMODE_RESPONSE_BYTES_MAX) {
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
      if (total > CODEMODE_RESPONSE_BYTES_MAX) {
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

/** Sanitized provenance for every Code Mode execution: caller, Organization
 * and Connection identity, provider operation, and spec revision — never
 * credential material. */
export interface CodeModeProvenance {
  readonly callerUserId: string;
  readonly orgId: string;
  readonly integrationId: string;
  readonly connectionId: string;
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly specDigest: string;
  readonly specVersion: string;
  readonly executedAt: string;
}

export function buildProvenance(entry: Omit<CodeModeProvenance, "executedAt">): CodeModeProvenance {
  return Object.freeze({ ...entry, executedAt: new Date().toISOString() });
}

/** UUIDv5 namespace for generated Integration IDs (INT-01, issue #229):
 * SHA-1(namespace || name) per RFC 9562 section 6.5. This namespace is a
 * fixed project constant (randomly generated once, never derived from
 * tenant data), so every lane and checkout derives the same ID from the
 * same pinned spec digest. */
export const INTEGRATION_ID_NAMESPACE = "7f3a2c1e-9b4d-4f8a-8e6c-1d5a3b9c7e2f";

/** Deterministic Integration ID for a generated provider (INT-01 fix 2):
 * UUIDv5 over the pinned spec digest hex (lowercase SHA-256 of the exact
 * spec bytes). Same spec bytes yield the same ID across regenerations and
 * checkouts, so Saga identity survives ordinary source edits; any spec byte
 * change yields a different Integration (drift is visible, never silent).
 * Throws on a malformed digest instead of minting an unstable ID. Pure and
 * synchronous so the Node CLI mirror can share the exact algorithm. */
export function integrationUuidV5(specDigestHex: string): string {
  if (!/^[a-f0-9]{64}$/.test(specDigestHex)) {
    throw new Fault(400, "GENERATOR_INVALID_OPTIONS", "The spec digest must be 64 lowercase hex chars.");
  }
  const namespace = INTEGRATION_ID_NAMESPACE.replace(/-/g, "");
  const name = new TextEncoder().encode(`wrangnarok.integration.v1:${specDigestHex}`);
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) nsBytes[i] = parseInt(namespace.slice(i * 2, i * 2 + 2), 16);
  const input = new Uint8Array(16 + name.length);
  input.set(nsBytes, 0);
  input.set(name, 16);
  const hash = sha1(input);
  // RFC 9562 section 6.5: version 5 plus RFC 4122 variant bits.
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Minimal SHA-1 over bytes (RFC 3174) for the UUIDv5 derivation above.
/// Kept local — no new dependency — and shared with the Node CLI mirror.
/// Returns the 20-byte digest. */
function sha1(input: Uint8Array): Uint8Array {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input, 0);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32), false);
  const w = new Uint32Array(80);
  const rotl = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}
