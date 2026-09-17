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

  // Auth strategy is explicit, never silently assumed: mirrors the typed
  // generator's GENERATOR_INVALID_OPTIONS checks so both entry points reject
  // the same bad inputs (the shared emitter only clamps for safety).
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
      const summary = typeof def.summary === "string" ? def.summary.slice(0, 280) : "";
      const classified = classifications[operationId];
      const risk = classified !== undefined ? classified : SAFE_METHODS.has(method.toLowerCase()) ? "read" : "mutation";
      operations.push({ operationId, method: method.toLowerCase(), path, summary, risk });
    }
  }
  if (operations.length === 0) fail("GENERATOR_INVALID_SPEC", "The OpenAPI contract declares no operations.");

  const digestHex = createHash("sha256").update(specText, "utf-8").digest("hex");
  const prefix = id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const content = emitIntegrationSource({
    doc,
    operations,
    id,
    name: ctx.genName ?? id,
    allowedOrigins: origins,
    envPrefix: `${prefix}_CLIENT`,
    digestHex,
    version,
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
