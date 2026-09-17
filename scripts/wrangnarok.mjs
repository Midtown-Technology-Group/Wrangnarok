// SPDX-License-Identifier: AGPL-3.0
// Thin compatibility entrypoint around the historical CLI core. INT-01's
// generate-integration command is kept here so it can share the exact source
// emitter used by src/generate-integration.ts; every other command delegates
// unchanged to wrangnarok-core.mjs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitIntegrationSource } from "../src/generate-integration-source.mjs";
import { convertPostmanCollection } from "../src/postman-convert.mjs";
import { parseContext as coreParseContext, runCommand as coreRunCommand } from "./wrangnarok-core.mjs";

const RISKS = ["read", "mutation", "destructive", "credential", "billing", "security", "tenant-admin"];
const OPERATION_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const SAFE_METHODS = new Set(["get", "head", "options"]);
/** Embedded-spec literal budget mirror (see GENERATOR_EMBED_BYTES_MAX in
 * src/generate-integration.ts): the wrapper cannot import TS, so the bound
 * is duplicated here and pinned equal by the generator parity tests. */
const EMBED_BYTES_MAX = 96 * 1024;
const EMBED_DESCRIPTION_MAX = 280;
/** UUIDv5 namespace mirror (see INTEGRATION_ID_NAMESPACE in src/openapi.ts):
 * duplicated for the same reason; the parity tests pin both. */
const INTEGRATION_ID_NAMESPACE = "7f3a2c1e-9b4d-4f8a-8e6c-1d5a3b9c7e2f";

function sha1Bytes(input) {
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
  const rotl = (value, bits) => (value << bits) | (value >>> (32 - bits));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f;
      let k;
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
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
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

function integrationUuidV5(specDigestHex) {
  if (!/^[a-f0-9]{64}$/.test(specDigestHex)) {
    fail("GENERATOR_INVALID_OPTIONS", "The spec digest must be 64 lowercase hex chars.");
  }
  const namespace = INTEGRATION_ID_NAMESPACE.replace(/-/g, "");
  const name = new TextEncoder().encode(`wrangnarok.integration.v1:${specDigestHex}`);
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) nsBytes[i] = parseInt(namespace.slice(i * 2, i * 2 + 2), 16);
  const input = new Uint8Array(16 + name.length);
  input.set(nsBytes, 0);
  input.set(name, 16);
  const hash = sha1Bytes(input);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stripEmbeddedValue(value) {
  if (Array.isArray(value)) return value.map(stripEmbeddedValue);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "example" || key === "examples") continue;
      if (key.startsWith("x-")) continue;
      if (key === "description" && typeof entry === "string" && entry.length > EMBED_DESCRIPTION_MAX) {
        out[key] = `${entry.slice(0, EMBED_DESCRIPTION_MAX)}…[truncated]`;
        continue;
      }
      out[key] = stripEmbeddedValue(entry);
    }
    return out;
  }
  return value;
}

function oauthGrantsClientCredentials(flows) {
  if (flows === null || typeof flows !== "object" || Array.isArray(flows)) return false;
  const keys = Object.keys(flows);
  if (keys.length === 0) return false;
  return keys.some((key) => ["clientcredentials", "client_credentials", "application"].includes(key.toLowerCase()));
}

function referencedSchemeNames(raw) {
  const names = new Set();
  const collect = (value) => {
    if (!Array.isArray(value)) return;
    for (const requirement of value) {
      if (requirement === null || typeof requirement !== "object" || Array.isArray(requirement)) continue;
      for (const name of Object.keys(requirement)) names.add(name.toLowerCase());
    }
  };
  collect(raw.security);
  const paths = raw.paths;
  if (paths !== null && typeof paths === "object" && !Array.isArray(paths)) {
    for (const methods of Object.values(paths)) {
      if (methods === null || typeof methods !== "object" || Array.isArray(methods)) continue;
      for (const def of Object.values(methods)) {
        if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
        collect(def.security);
      }
    }
  }
  if (names.size === 0) return names;
  return names;
}

/** Mirror of detectGeneratorAuthKind in src/openapi.ts (the wrapper cannot
 * import TS): only referenced schemes select the kind; unresolved,
 * heterogeneous, or unrecognized requirements yield unknown so generation
 * fails closed. */
function detectAuthKind(doc) {
  const raw = doc;
  const components = raw.components;
  const schemesRaw =
    components !== null && typeof components === "object" && !Array.isArray(components)
      ? components.securitySchemes
      : undefined;
  const schemes = schemesRaw !== null && typeof schemesRaw === "object" && !Array.isArray(schemesRaw) ? schemesRaw : {};
  const referenced = referencedSchemeNames(raw);
  if (referenced.size === 0) return "unknown";
  const lowered = {};
  for (const [key, value] of Object.entries(schemes)) lowered[key.toLowerCase()] = value;
  let sawBearer = false;
  let sawOAuth = false;
  for (const name of referenced) {
    const scheme = lowered[name];
    if (scheme === null || typeof scheme !== "object" || Array.isArray(scheme)) return "unknown";
    const type = typeof scheme.type === "string" ? scheme.type.toLowerCase() : "";
    if (type === "oauth2") {
      if (oauthGrantsClientCredentials(scheme.flows)) sawOAuth = true;
      else return "unknown";
      continue;
    }
    if (type === "http" && typeof scheme.scheme === "string" && scheme.scheme.toLowerCase() === "bearer") {
      sawBearer = true;
      continue;
    }
    if (type === "apikey") {
      sawBearer = true;
      continue;
    }
    if (type === "http" && typeof scheme.scheme === "string" && scheme.scheme.toLowerCase() === "basic") {
      sawBearer = true;
      continue;
    }
    return "unknown";
  }
  if (sawBearer && sawOAuth) return "unknown";
  if (sawBearer) return "apiToken";
  if (sawOAuth) return "clientCredentials";
  return "unknown";
}

function fail(code, message) {
  if (process.argv.includes("--json")) console.error(JSON.stringify({ error: { code, message: String(message) } }));
  else console.error(`WRANGNAROK_CLI ${code}: ${message}`);
  process.exit(code === "USAGE" ? 2 : 1);
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1];
}

function repeated(name) {
  return process.argv
    .flatMap((value, index, argv) => (value === `--${name}` && index + 1 < argv.length ? [argv[index + 1]] : []))
    .filter((value) => typeof value === "string" && value.length > 0);
}

function classificationsFromArgv() {
  const table = {};
  for (const pair of repeated("classify")) {
    const cut = pair.indexOf("=");
    if (cut !== -1) table[pair.slice(0, cut)] = pair.slice(cut + 1);
  }
  return table;
}

export function parseContext(argv = process.argv) {
  return coreParseContext(argv);
}

// Offline generator entry (INT-01): exported so CLI dispatch can call it
// directly instead of routing through the shared network-result object
// (CodeQL js/http-to-file-access).
export function validateAndGenerate(ctx) {
  const id = ctx.genId;
  if (!id || !/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
    fail("USAGE", "generate-integration needs --id ID (1-64 chars [a-z0-9-], starting with a letter).");
  }
  const rawSpec = ctx.genSpec;
  if (typeof rawSpec !== "string" || rawSpec.length === 0) {
    fail("USAGE", "generate-integration needs --spec JSON|@FILE (OpenAPI 3.x JSON or Postman Collection v2.1 JSON).");
  }
  const specText = rawSpec.startsWith("@") ? readFileSync(rawSpec.slice(1), "utf-8") : rawSpec;
  if (new TextEncoder().encode(specText).length > 2 * 1024 * 1024) {
    fail("GENERATOR_INVALID_SPEC", "The OpenAPI spec exceeds the 2 MiB generator bound.");
  }
  const origins = ctx.genOrigins ?? [];
  if (origins.length === 0)
    fail("USAGE", "generate-integration needs --origin URL (repeatable; never the spec servers entries).");
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      fail("GENERATOR_INVALID_OPTIONS", `Allowed origin ${JSON.stringify(origin)} must be http(s).`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      fail("GENERATOR_INVALID_OPTIONS", `Allowed origin ${JSON.stringify(origin)} must be http(s).`);
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !loopback) {
      fail(
        "GENERATOR_INVALID_OPTIONS",
        `Allowed origin ${JSON.stringify(origin)} must be https (credentials ride the Authorization header).`,
      );
    }
  }

  const classifications = ctx.genClassifications ?? {};
  for (const [op, risk] of Object.entries(classifications)) {
    if (!op || typeof risk !== "string" || !RISKS.includes(risk)) {
      fail(
        "USAGE",
        `generate-integration --classify needs op=CLASS with CLASS one of ${RISKS.join(", ")} (e.g. Ticket_Delete=destructive).`,
      );
    }
  }

  // Auth-kind detection mirrors the typed generator: read securitySchemes,
  // fail closed on unknown schemes, and honor an explicit --auth-kind only
  // when it agrees with the detected kind.
  const rawAuthKind = ctx.genAuthKind;
  if (rawAuthKind !== undefined && rawAuthKind !== "apiToken" && rawAuthKind !== "clientCredentials") {
    fail(
      "USAGE",
      "generate-integration --auth-kind must be apiToken or clientCredentials (omit to detect from securitySchemes).",
    );
  }

  let doc;
  try {
    doc = JSON.parse(specText);
  } catch {
    fail("GENERATOR_INVALID_SPEC", "The OpenAPI spec must parse as JSON (convert YAML to JSON before generating).");
  }
  // Postman Collection v2.1 input: convert to the minimal OpenAPI document
  // before validation so the CLI and the typed generator share one path.
  if (
    doc !== null &&
    typeof doc === "object" &&
    !Array.isArray(doc) &&
    Array.isArray(doc.item) &&
    typeof doc.openapi !== "string"
  ) {
    try {
      doc = convertPostmanCollection(doc).doc;
    } catch (error) {
      fail(
        "GENERATOR_INVALID_SPEC",
        error instanceof Error ? error.message : "The Postman collection could not be converted to OpenAPI.",
      );
    }
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    fail("GENERATOR_INVALID_SPEC", "The OpenAPI contract must be a JSON object.");
  }
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    fail("GENERATOR_INVALID_SPEC", "Only OpenAPI 3.x contracts can be generated.");
  }
  const version =
    doc.info && typeof doc.info === "object" && typeof doc.info.version === "string"
      ? doc.info.version.slice(0, 64)
      : "";
  if (!version) fail("GENERATOR_INVALID_SPEC", "The OpenAPI contract needs info.version.");
  if (!doc.paths || typeof doc.paths !== "object" || Array.isArray(doc.paths)) {
    fail("GENERATOR_INVALID_SPEC", "The OpenAPI contract needs a paths object.");
  }

  const detected = detectAuthKind(doc);
  const authKind =
    rawAuthKind === undefined
      ? detected === "unknown"
        ? fail(
            "GENERATOR_INVALID_OPTIONS",
            "The spec declares no recognized securityScheme (need http/bearer, apiKey, or oauth2 client-credentials); refusing to guess the credential shape.",
          )
        : detected
      : rawAuthKind !== detected
        ? fail(
            "GENERATOR_INVALID_OPTIONS",
            `Auth override ${JSON.stringify(rawAuthKind)} disagrees with the spec's detected ${JSON.stringify(detected)} scheme; refusing to stamp the wrong credential shape.`,
          )
        : rawAuthKind;

  const includeDeprecated = ctx.genIncludeDeprecated === true;
  const seen = new Set();
  const operations = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    if (!path.startsWith("/") || methods === null || typeof methods !== "object" || Array.isArray(methods)) {
      fail("GENERATOR_INVALID_SPEC", `Contract path ${JSON.stringify(path)} is malformed.`);
    }
    for (const [method, def] of Object.entries(methods)) {
      if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
      const operationId = def.operationId;
      if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
        fail(
          "GENERATOR_INVALID_SPEC",
          `Contract operation ${method.toUpperCase()} ${path} needs a stable operationId.`,
        );
      }
      if (seen.has(operationId))
        fail("GENERATOR_INVALID_SPEC", `Duplicate operationId ${JSON.stringify(operationId)}.`);
      seen.add(operationId);
      if (def.deprecated === true && !includeDeprecated) continue;
      const summary = typeof def.summary === "string" ? def.summary.slice(0, 280) : "";
      const classified = classifications[operationId];
      const risk = classified !== undefined ? classified : SAFE_METHODS.has(method.toLowerCase()) ? "read" : "mutation";
      operations.push({ operationId, method: method.toLowerCase(), path, summary, risk });
    }
  }
  if (operations.length === 0) fail("GENERATOR_INVALID_SPEC", "The OpenAPI contract declares no operations.");

  // OAuth-only strategy options: accepted only for the clientCredentials
  // kind, mirroring the typed generator.
  if (
    authKind === "apiToken" &&
    (ctx.genTokenPath !== undefined || ctx.genScope !== undefined || ctx.genTimeoutMs !== undefined)
  ) {
    fail(
      "GENERATOR_INVALID_OPTIONS",
      "tokenPath/scope/timeoutMs apply to OAuth client-credentials specs only; a bearer spec takes none.",
    );
  }
  const tokenPath = ctx.genTokenPath ?? "/auth/token";
  if (typeof tokenPath !== "string" || !tokenPath.startsWith("/") || tokenPath.length > 128) {
    fail(
      "GENERATOR_INVALID_OPTIONS",
      "generate-integration --token-path must be a same-origin absolute path starting with / (1-128 chars).",
    );
  }
  const scope = ctx.genScope ?? "all";
  if (typeof scope !== "string" || scope.length === 0 || scope.length > 128) {
    fail("GENERATOR_INVALID_OPTIONS", "generate-integration --scope must be 1-128 chars.");
  }
  const timeoutMs = ctx.genTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    fail("GENERATOR_INVALID_OPTIONS", "generate-integration --timeout-ms must be an integer 1 to 30000.");
  }

  const digestHex = createHash("sha256").update(specText, "utf-8").digest("hex");
  const integrationUuid = integrationUuidV5(digestHex);
  const strippedDoc = stripEmbeddedValue(doc);
  if (new TextEncoder().encode(JSON.stringify(strippedDoc)).length > EMBED_BYTES_MAX) {
    fail("GENERATOR_INVALID_SPEC", `The stripped embedded spec exceeds the ${EMBED_BYTES_MAX}-byte embedding budget.`);
  }
  const prefix = id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const content = emitIntegrationSource({
    doc: strippedDoc,
    operations,
    id,
    name: ctx.genName ?? id,
    allowedOrigins: origins,
    envPrefix: `${prefix}_CLIENT`,
    digestHex,
    version,
    authKind,
    integrationUuid,
    includeDeprecated,
    tokenPath,
    scope,
    timeoutMs,
  });
  return {
    generated: {
      path: `src/integrations/${id}.ts`,
      content,
      operations: operations.length,
      specDigest: digestHex,
      next: [
        `Commit ${id}.ts under src/integrations/ and register its ID in the Integration inventory.`,
        "Wire the Connection config schema plus secret env vars per ADR 003/005.",
        "Run npm run typecheck plus the generator tests before opening a PR.",
      ],
    },
  };
}

export async function runCommand(ctx, deps = {}) {
  if (ctx.command === "generate-integration") return validateAndGenerate(ctx);
  return coreRunCommand(ctx, deps);
}

function writeGenerated(result, json) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  const outPath = arg("out") ?? result.generated.path;
  const force = process.argv.includes("--force");
  if (force) writeFileSync(outPath, result.generated.content, "utf-8");
  else {
    try {
      writeFileSync(outPath, result.generated.content, { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      if (error && error.code === "EEXIST") {
        fail("GENERATOR_EXISTS", `Refusing to overwrite ${outPath} without --force (regeneration must be explicit).`);
      }
      throw error;
    }
  }
  console.log(`generated ${outPath} (${result.generated.operations} operations)`);
  console.log(`spec: ${result.generated.specDigest.slice(0, 12)}`);
  for (const step of result.generated.next) console.log(`next: ${step}`);
}

async function main() {
  if (process.argv[2] !== "generate-integration") {
    const core = fileURLToPath(new URL("./wrangnarok-core.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [core, ...process.argv.slice(2)], { stdio: "inherit" });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  // Direct dispatch (not via runCommand): the offline generator result must
  // never share an object with network results (CodeQL js/http-to-file-access).
  const result = await validateAndGenerate({
    command: "generate-integration",
    genId: arg("id"),
    genSpec: arg("spec"),
    genName: arg("name"),
    genOrigins: repeated("origin"),
    genClassifications: classificationsFromArgv(),
    genTokenPath: arg("token-path"),
    genScope: arg("scope"),
    genTimeoutMs: arg("timeout-ms") === undefined ? undefined : Number(arg("timeout-ms")),
    genAuthKind: arg("auth-kind"),
    genIncludeDeprecated: process.argv.includes("--include-deprecated"),
  });
  writeGenerated(result, process.argv.includes("--json"));
}

const invokedAsCli = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (invokedAsCli) {
  try {
    await main();
  } catch (error) {
    console.error(`WRANGNAROK_CLI FAILED: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
