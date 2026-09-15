// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): OpenAPI-to-Integration generator. Pure emitter:
// validated OpenAPI 3.x JSON in, committed TypeScript Integration source
// out. No fetch, no D1, no secrets — the operator supplies the spec text
// and the generated module plugs into the Integration/Connection contract.
import { Fault } from "./domain";
import { indexOperations, validateContractDocument } from "./openapi";
import type { OpenApiDocument, OperationRisk } from "./openapi";
import { emitIntegrationSource } from "./generate-integration-source.mjs";
import { convertPostmanCollection } from "./postman";

const INTEGRATION_ID = /^[a-z][a-z0-9-]{1,63}$/;
const SPEC_BYTES_MAX = 2 * 1024 * 1024;
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

  const operations = indexOperations(doc, options.classifications ?? {});
  for (const [op, risk] of Object.entries(options.classifications ?? {})) {
    if (typeof risk !== "string" || !RISKS.includes(risk as (typeof RISKS)[number])) {
      throw new Fault(
        400,
        "GENERATOR_INVALID_OPTIONS",
        `Classification for ${JSON.stringify(op)} must be one of ${RISKS.join(", ")}.`,
      );
    }
  }

  const envPrefix = options.secretEnvPrefix ?? `${slugConst(options.id)}_CLIENT`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envPrefix)) {
    throw new Fault(
      400,
      "GENERATOR_INVALID_OPTIONS",
      "secretEnvPrefix must be a valid TypeScript identifier fragment (letters, digits, underscore; not starting with a digit).",
    );
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
  const source = emitIntegrationSource({
    doc,
    operations,
    id: options.id,
    name: options.name,
    allowedOrigins: options.allowedOrigins,
    envPrefix,
    digestHex,
    version,
  });

  return {
    fileName: `${options.id}.ts`,
    source,
    specDigest: digestHex,
    operationCount: operations.length,
  };
}
