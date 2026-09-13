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
 * stay at their method default — writes therefore still need policy. */
export function indexOperations(
  doc: OpenApiDocument,
  classifications: Readonly<Record<string, OperationRisk>> = {},
): readonly ContractOperation[] {
  const operations: ContractOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    if (methods === null || typeof methods !== "object") continue;
    for (const [method, def] of Object.entries(methods)) {
      if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
      const operationId = (def as OperationDef).operationId;
      if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) continue;
      const summaryRaw = (def as OperationDef).summary;
      const summary = typeof summaryRaw === "string" ? summaryRaw.slice(0, 280) : "";
      const classified = classifications[operationId];
      const risk: OperationRisk =
        classified !== undefined && (OPERATION_RISK as readonly string[]).includes(classified)
          ? classified
          : SAFE_METHODS.has(method.toLowerCase())
            ? "read"
            : "mutation";
      operations.push(Object.freeze({ operationId, method: method.toLowerCase(), path, summary, risk }));
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
