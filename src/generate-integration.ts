// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): OpenAPI-to-Integration generator. Pure emitter:
// validated OpenAPI 3.x JSON in, committed TypeScript Integration source
// out. No fetch, no D1, no secrets — the operator supplies the spec text
// and the generated module plugs into the Integration/Connection contract.
import { Fault } from "./domain";
import { detectGeneratorAuthKind, indexOperations, integrationUuidV5, validateContractDocument } from "./openapi";
import type { GeneratorAuthKind, OpenApiDocument, OperationRisk } from "./openapi";
import { emitIntegrationSource } from "./generate-integration-source.mjs";
import type { EmitterAuthKind } from "./generate-integration-source.mjs";
import { convertPostmanCollection } from "./postman";

const INTEGRATION_ID = /^[a-z][a-z0-9-]{1,63}$/;
const SPEC_BYTES_MAX = 2 * 1024 * 1024;
/** Embedded-spec literal budget (INT-01, issue #229): the JSON literal the
 * emitter embeds must stay under this many UTF-8 bytes after stripping
 * (examples, descriptions over the threshold, vendor extensions). Documented
 * in docs/architecture/022-code-mode.md alongside the strip policy. */
export const GENERATOR_EMBED_BYTES_MAX = 96 * 1024;
/** Longest per-operation description text kept in the embedded spec; longer
 * descriptions are truncated with an ellipsis marker. */
export const GENERATOR_EMBED_DESCRIPTION_MAX = 280;
const RISKS = ["read", "mutation", "destructive", "credential", "billing", "security", "tenant-admin"] as const;

function invalid(message: string): Fault {
  return new Fault(400, "GENERATOR_INVALID_SPEC", message);
}

export interface GenerateIntegrationOptions {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly allowedOrigins: readonly string[];
  readonly classifications?: Readonly<Record<string, OperationRisk>>;
  readonly secretEnvPrefix?: string;
  /** OAuth token endpoint path, resolved against the Connection endpoint
   * origin (client-credentials kind only; default /auth/token). Must start
   * with / when provided. */
  readonly tokenPath?: string;
  /** OAuth scope requested at the token endpoint (default all). */
  readonly scope?: string;
  /** Shared vendor deadline ms over token plus resource call (1-30000). */
  readonly timeoutMs?: number;
  /** Explicit auth override: when set, the spec's securitySchemes still
   * detect but the override wins only when it agrees, otherwise generation
   * fails closed (never silently stamp the wrong credential shape). */
  readonly authKind?: GeneratorAuthKind;
  /** Include `deprecated: true` operations in the classification map (default
   * false: deprecated operations stay out and are never callable). */
  readonly includeDeprecated?: boolean;
}

export interface GeneratedIntegration {
  readonly fileName: string;
  readonly source: string;
  readonly specDigest: string;
  readonly operationCount: number;
}

function slugConst(id: string): string {
  return id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function generateIntegrationModule(
  specText: string,
  options: GenerateIntegrationOptions,
  digestHex: string,
): GeneratedIntegration {
  if (new TextEncoder().encode(specText).length > SPEC_BYTES_MAX) {
    throw invalid("The OpenAPI spec exceeds the 2 MiB generator bound.");
  }
  if (!INTEGRATION_ID.test(options.id)) {
    throw new Fault(
      400,
      "GENERATOR_INVALID_OPTIONS",
      "The Integration id must be 1-64 chars [a-z0-9-], starting with a letter.",
    );
  }
  if (options.allowedOrigins.length === 0) {
    throw new Fault(
      400,
      "GENERATOR_INVALID_OPTIONS",
      "At least one allowed origin is required (never the spec servers entries).",
    );
  }
  for (const origin of options.allowedOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Fault(400, "GENERATOR_INVALID_OPTIONS", `Allowed origin ${JSON.stringify(origin)} is not a URL.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Fault(400, "GENERATOR_INVALID_OPTIONS", `Allowed origin ${JSON.stringify(origin)} must be http(s).`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(specText);
  } catch {
    throw invalid("The OpenAPI spec must parse as JSON (convert YAML to JSON before generating).");
  }
  // Postman Collection v2.1 input: convert to the minimal OpenAPI document
  // before validation so both sources share one validation/emission path.
  // Detection is structural (item array without an openapi marker), never
  // content-sniffed; converter failures surface as GENERATOR_INVALID_SPEC.
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as Record<string, unknown>)["item"]) &&
    typeof (parsed as Record<string, unknown>)["openapi"] !== "string"
  ) {
    try {
      const converted = convertPostmanCollection(parsed);
      parsed = converted.doc;
    } catch (error) {
      throw invalid(
        error instanceof Error ? error.message : "The Postman collection could not be converted to OpenAPI.",
      );
    }
  }
  let doc: OpenApiDocument;
  try {
    validateContractDocument(parsed);
    doc = parsed as OpenApiDocument;
  } catch (error) {
    if (error instanceof Fault) throw new Fault(400, "GENERATOR_INVALID_SPEC", error.message);
    throw error;
  }

  const includeDeprecated = options.includeDeprecated ?? false;
  const operations = indexOperations(doc, options.classifications ?? {}, { includeDeprecated });
  for (const [op, risk] of Object.entries(options.classifications ?? {})) {
    if (typeof risk !== "string" || !RISKS.includes(risk as (typeof RISKS)[number])) {
      throw new Fault(
        400,
        "GENERATOR_INVALID_OPTIONS",
        `Classification for ${JSON.stringify(op)} must be one of ${RISKS.join(", ")}.`,
      );
    }
  }

  // Auth-kind detection (INT-01 fix 1): read the spec's securitySchemes and
  // emit the matching credential shape. Detected `unknown` fails closed here
  // with a loud options error; an explicit override must agree with the
  // detected kind, so a bearer spec can never silently stamp OAuth fields.
  const detected = detectGeneratorAuthKind(doc);
  const authKind: EmitterAuthKind =
    options.authKind === undefined
      ? detected === "unknown"
        ? failClosedAuth()
        : detected
      : options.authKind !== detected
        ? failClosedAuth(detected, options.authKind)
        : options.authKind === "unknown"
          ? failClosedAuth()
          : options.authKind;

  const envPrefix = options.secretEnvPrefix ?? `${slugConst(options.id)}_CLIENT`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envPrefix)) {
    throw new Fault(
      400,
      "GENERATOR_INVALID_OPTIONS",
      "secretEnvPrefix must be a valid TypeScript identifier fragment (letters, digits, underscore; not starting with a digit).",
    );
  }

  // OAuth-only strategy options: tokenPath/scope/timeoutMs are accepted only
  // for the clientCredentials kind. A bearer spec carrying them is a caller
  // error, not silently ignored configuration.
  const tokenPath = options.tokenPath ?? "/auth/token";
  if (
    authKind === "apiToken" &&
    (options.tokenPath !== undefined || options.scope !== undefined || options.timeoutMs !== undefined)
  ) {
    throw new Fault(
      400,
      "GENERATOR_INVALID_OPTIONS",
      "tokenPath/scope/timeoutMs apply to OAuth client-credentials specs only; a bearer spec takes none.",
    );
  }
  if (!tokenPath.startsWith("/") || tokenPath.length > 128) {
    throw new Fault(
      400,
      "GENERATOR_INVALID_OPTIONS",
      "tokenPath must be a same-origin absolute path starting with / (1-128 chars).",
    );
  }
  const scope = options.scope ?? "all";
  if (scope.length === 0 || scope.length > 128) {
    throw new Fault(400, "GENERATOR_INVALID_OPTIONS", "scope must be 1-128 chars.");
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new Fault(400, "GENERATOR_INVALID_OPTIONS", "timeoutMs must be an integer 1 to 30000.");
  }

  for (const origin of options.allowedOrigins) {
    const url = new URL(origin);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !loopback) {
      throw new Fault(
        400,
        "GENERATOR_INVALID_OPTIONS",
        `Allowed origin ${JSON.stringify(origin)} must be https (credentials ride the Authorization header).`,
      );
    }
  }

  const version =
    doc.info && typeof doc.info === "object" && typeof (doc.info as { version?: unknown }).version === "string"
      ? (doc.info as { version: string }).version.slice(0, 64)
      : "unversioned";
  // Stable Integration identity (INT-01 fix 2): deterministic UUIDv5 derived
  // from the pinned spec digest (see integrationUuidV5 in src/openapi.ts).
  const integrationId = integrationUuidV5(digestHex);
  // Embedding budget (INT-01 fix 4): strip examples/descriptions/vendor
  // extensions before embedding; fail closed when the stripped literal still
  // exceeds GENERATOR_EMBED_BYTES_MAX.
  const strippedDoc = stripEmbeddedSpec(doc);
  const strippedBytes = new TextEncoder().encode(JSON.stringify(strippedDoc)).length;
  if (strippedBytes > GENERATOR_EMBED_BYTES_MAX) {
    throw new Fault(
      400,
      "GENERATOR_INVALID_SPEC",
      `The stripped embedded spec is ${strippedBytes} bytes, above the ${GENERATOR_EMBED_BYTES_MAX}-byte embedding budget.`,
    );
  }
  const source = emitIntegrationSource({
    doc: strippedDoc,
    operations,
    id: options.id,
    name: options.name,
    allowedOrigins: options.allowedOrigins,
    envPrefix,
    digestHex,
    version,
    authKind,
    integrationUuid: integrationId,
    includeDeprecated,
    tokenPath,
    scope,
    timeoutMs,
  });

  return {
    fileName: `${options.id}.ts`,
    source,
    specDigest: digestHex,
    operationCount: operations.length,
  };
}

/** Fail closed on unrecognized or mismatched auth: the operator must fix the
 * spec or the explicit override, never ship a wrong credential shape. */
function failClosedAuth(detected?: GeneratorAuthKind, override?: GeneratorAuthKind): never {
  throw new Fault(
    400,
    "GENERATOR_INVALID_OPTIONS",
    override === undefined
      ? "The spec declares no recognized securityScheme (need http/bearer, apiKey, or oauth2 client-credentials); refusing to guess the credential shape."
      : `Auth override ${JSON.stringify(override)} disagrees with the spec's detected ${JSON.stringify(detected)} scheme; refusing to stamp the wrong credential shape.`,
  );
}

/** Strip the embedded spec literal to the embedding budget policy: drop
 * examples and vendor extensions, truncate descriptions over
 * GENERATOR_EMBED_DESCRIPTION_MAX chars. Pure: never mutates the input. */
export function stripEmbeddedSpec(doc: OpenApiDocument): OpenApiDocument {
  return stripValue(doc) as OpenApiDocument;
}

function stripValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "example" || key === "examples") continue;
      if (key.startsWith("x-")) continue;
      if (key === "description" && typeof entry === "string" && entry.length > GENERATOR_EMBED_DESCRIPTION_MAX) {
        out[key] = `${entry.slice(0, GENERATOR_EMBED_DESCRIPTION_MAX)}…[truncated]`;
        continue;
      }
      out[key] = stripValue(entry);
    }
    return out;
  }
  return value;
}
