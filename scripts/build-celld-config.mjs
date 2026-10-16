// SPDX-License-Identifier: AGPL-3.0
// Derive the celld deployment config (wrangler.celld.jsonc) from the
// Cloudflare source of truth (wrangler.jsonc). celld deploys from a
// Wrangler config but rejects every top-level key it does not list --
// including `routes`, `observability`, `workers_dev`, and `env` -- so the
// hosted config cannot be fed to it directly (see
// https://celld.dev/docs/cloudflare-compat, "Wrangler configuration").
// This generator keeps ONE authored config: wrangler.jsonc stays the
// Cloudflare source, and the committed celld variant is a filtered,
// single-environment projection of its top level. `env.*` blocks are
// Cloudflare-account deployments and never project; self-host operators
// layer their own vars/secrets at deploy time (scripts/deploy-celld.mjs),
// never into the committed file.
//
// Usage: node scripts/build-celld-config.mjs           (write wrangler.celld.jsonc)
//        node scripts/build-celld-config.mjs --check   (fail if the committed file is stale)
//        node scripts/build-celld-config.mjs selftest  (offline unit verification)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSelftest } from "./selftest-harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_PATH = join(root, "wrangler.jsonc");
export const TARGET_PATH = join(root, "wrangler.celld.jsonc");

// Top-level keys celld accepts (celld cloudflare-compat, "Wrangler
// configuration"). Anything else -- routes, observability, workers_dev,
// preview_urls, env -- stops a celld deployment, so it is dropped here.
export const CELLD_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "no_bundle",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "queues",
  "workflows",
  "r2_buckets",
  "worker_loaders",
  "containers",
  "define",
  "rules",
]);

// The assets block accepts only these keys on celld (static-assets docs);
// any other key stops the deployment.
const CELLD_ASSET_KEYS = new Set(["directory", "binding", "html_handling", "not_found_handling", "run_worker_first"]);

// celld name rule: 1-63 lowercase ASCII letters, digits, or internal hyphens.
const CELLD_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Strip JSONC comments and trailing commas in one string-aware pass:
 * `//`, `/*`, and `,}` inside a string literal are data, never syntax
 * (a regex over the whole text would silently rewrite string values
 * such as "x,}" -- probed in review). */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    const afterComment = skipComment(text, i);
    if (afterComment !== i) {
      out += "\n";
      i = afterComment + 1;
      continue;
    }
    if (ch !== "," || !isTrailingComma(text, i)) out += ch;
    i += 1;
  }
  return JSON.parse(out);
}

/** Index just past a // or /* comment starting at i, or i itself. */
function skipComment(text, i) {
  if (text[i] !== "/") return i;
  if (text[i + 1] === "/") {
    let end = i;
    while (end < text.length && text[end] !== "\n") end += 1;
    return end - 1; // leave the newline for the main loop
  }
  if (text[i + 1] === "*") {
    let end = i + 2;
    while (end < text.length && !(text[end] === "*" && text[end + 1] === "/")) end += 1;
    return end + 1;
  }
  return i;
}

/** True when the comma at i is followed (past whitespace/comments) by } or ]. */
function isTrailingComma(text, i) {
  let next = i + 1;
  for (;;) {
    while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
    const afterComment = skipComment(text, next);
    if (afterComment === next) break;
    next = afterComment + 1;
  }
  return text[next] === "}" || text[next] === "]";
}

// Hosted-only top-level keys the projection deliberately drops. Any
// OTHER non-celld key (a new binding type, say `ai`) fails closed here
// instead of vanishing silently -- adding one needs an explicit decision
// in this file, not a quiet green check.
const HOSTED_ONLY_KEYS = new Set(["env", "observability", "workers_dev", "preview_urls", "routes"]);

// Binding identities src/bindings.ts requires at runtime. The projection
// must carry every one under its exact name; a rename or drop in
// wrangler.jsonc fails generation instead of deploying a Worker that
// only fails when a route touches the missing binding.
const REQUIRED_BINDINGS = {
  d1_databases: ["DB"],
  r2_buckets: ["FILES", "ARTIFACTS"],
  workflows: [
    "ECHO_WORKFLOW",
    "NINJA_WORKFLOW",
    "NINJA_LOOKUP_WORKFLOW",
    "DIGEST_WORKFLOW",
    "SMOKE_WORKFLOW",
    "HELLO_WORKFLOW",
    "HELLO_PARENT_WORKFLOW",
    "CLOUDFLARE_VERIFY_WORKFLOW",
    "CLOUDFLARE_INVENTORY_WORKFLOW",
    "CLOUDFLARE_AUDIT_WORKFLOW",
    "CLOUDFLARE_INSIGHTS_WORKFLOW",
    "CLOUDFLARE_POSTURE_WORKFLOW",
    "ONBOARDING_WORKFLOW",
  ],
};

// Nested keys kept per binding entry; anything else is dropped so an
// unknown nested field cannot ride through to a celld deploy rejection.
const NESTED_KEYS = {
  d1_databases: ["binding", "database_name", "database_id", "migrations_dir", "migrations_table"],
  r2_buckets: ["binding", "bucket_name"],
  workflows: ["binding", "name", "class_name"],
};

// Committed config vars are an allowlist, not a denylist: a new var
// key could be a credential under a name no pattern anticipated, so
// anything not listed here fails closed. Deploy-time operator vars
// (scripts/deploy-celld.mjs) are where secrets and deployment-specific
// values belong; extend this list only for values that are safe to
// commit and publish to every reader of the repo.
const COMMITTED_VAR_ALLOWLIST = new Set(["LAB_ENABLED", "LAB_ORG_ID", "LAB_USER_ID", "ENVIRONMENT"]);

function filterEntries(entries, keys, label) {
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    const filtered = {};
    for (const [key, value] of Object.entries(entry)) {
      if (keys.includes(key)) filtered[key] = value;
    }
    if (typeof filtered.binding !== "string" || filtered.binding.length === 0) {
      throw new Error(`${label}[${index}] requires a string \`binding\`.`);
    }
    return filtered;
  });
}

function requireBindings(entries, required, label) {
  const names = entries.map((entry) => entry.binding);
  if (new Set(names).size !== names.length) throw new Error(`${label} has duplicate binding names.`);
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`${label} is missing required binding ${name} (src/bindings.ts).`);
  }
}

function projectTopLevel(source) {
  const config = {};
  for (const [key, value] of Object.entries(source)) {
    if (HOSTED_ONLY_KEYS.has(key)) continue;
    if (!CELLD_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(
        `Unknown top-level key \`${key}\`: not a celld key and not a known hosted-only key. Decide its celld disposition in scripts/build-celld-config.mjs.`,
      );
    }
    config[key] = value;
  }
  return config;
}

function validateBindingLists(config) {
  for (const [listKey, required] of Object.entries(REQUIRED_BINDINGS)) {
    if (!Array.isArray(config[listKey])) throw new Error(`celld config requires a \`${listKey}\` binding list.`);
    config[listKey] = filterEntries(config[listKey], NESTED_KEYS[listKey], listKey);
    requireBindings(config[listKey], required, listKey);
  }
  const durableBindings = config.durable_objects?.bindings;
  if (!Array.isArray(durableBindings) || durableBindings.length === 0) {
    throw new Error("celld config requires a non-empty `durable_objects.bindings` list.");
  }
  const hasFence = durableBindings.some((entry) => isRecord(entry) && entry.name === "OAUTH_REFRESH_FENCE");
  if (!hasFence) throw new Error("durable_objects.bindings is missing OAUTH_REFRESH_FENCE (src/bindings.ts).");
}

function validateCommittedVars(config) {
  if (config.vars === undefined) return;
  for (const key of Object.keys(config.vars)) {
    if (COMMITTED_VAR_ALLOWLIST.has(key)) continue;
    throw new Error(
      `Committed celld vars are allowlisted and \`${key}\` is not on it; secrets and deployment values belong in the operator vars file, and a genuinely non-secret key extends COMMITTED_VAR_ALLOWLIST deliberately.`,
    );
  }
}

function projectAssets(config) {
  if (config.assets === undefined) return;
  if (!isRecord(config.assets) || config.assets.binding !== "ASSETS") {
    throw new Error("celld assets require binding ASSETS (src/bindings.ts).");
  }
  const assets = {};
  for (const [key, value] of Object.entries(config.assets)) {
    if (CELLD_ASSET_KEYS.has(key)) assets[key] = value;
  }
  if (typeof assets.directory !== "string") throw new Error("celld assets require a `directory`.");
  config.assets = assets;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Project the parsed hosted config onto the celld-accepted shape.
 * Pure: throws on anything that would make the projection invalid. */
export function buildCelldConfig(source) {
  if (!isRecord(source)) throw new Error("wrangler.jsonc must contain a JSON object.");
  const config = projectTopLevel(source);
  if (typeof config.name !== "string" || !CELLD_NAME.test(config.name)) {
    throw new Error(`celld requires a 1-63 char lowercase name, got ${JSON.stringify(config.name)}.`);
  }
  if (typeof config.main !== "string" || config.main.length === 0) {
    throw new Error("celld config requires a `main` Worker entrypoint.");
  }
  validateBindingLists(config);
  validateCommittedVars(config);
  projectAssets(config);
  return config;
}

const HEADER = `// GENERATED by scripts/build-celld-config.mjs from wrangler.jsonc -- do not edit.
// Regenerate: npm run config:celld   Verify: npm run check:celld
// celld (https://celld.dev) deploys this file; Cloudflare deploys wrangler.jsonc.
// Only non-secret vars live here. Operator secrets are merged at deploy time
// from a gitignored vars file (scripts/deploy-celld.mjs); celld has no secret
// store and persists config vars in the fleet bucket.
`;

export function renderCelldConfig(sourceText) {
  const config = buildCelldConfig(parseJsonc(sourceText));
  return `${HEADER}${JSON.stringify(config, null, 2)}\n`;
}

function main(argv) {
  if (argv.includes("selftest")) return selftest();
  const rendered = renderCelldConfig(readFileSync(SOURCE_PATH, "utf8"));
  if (argv.includes("--check")) {
    let current;
    try {
      current = readFileSync(TARGET_PATH, "utf8");
    } catch {
      current = "";
    }
    if (current !== rendered) {
      console.error("wrangler.celld.jsonc is stale. Run `npm run config:celld` and commit the result.");
      process.exitCode = 1;
      return;
    }
    console.log("wrangler.celld.jsonc is in sync with wrangler.jsonc.");
    return;
  }
  writeFileSync(TARGET_PATH, rendered);
  console.log("Wrote wrangler.celld.jsonc from wrangler.jsonc.");
}

function selftest() {
  const { assert, expect, finish } = createSelftest("celld config selftest");
  const sample = `{
    // hosted comment
    "name": "wrangnarok-local",
    "main": "src/index.ts",
    "compatibility_date": "2026-09-09",
    "compatibility_flags": ["nodejs_compat"],
    "observability": { "enabled": true },
    "workers_dev": false,
    "routes": [],
    "assets": { "directory": "./client/dist/", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"], "bogus": 1 },
    "vars": { "LAB_ENABLED": "false", "LAB_ORG_ID": "https://example.test//not-a-comment" },
    "d1_databases": [{ "binding": "DB", "database_name": "wrangnarok-local", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "migrations", }],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "wrangnarok-local" }, { "binding": "ARTIFACTS", "bucket_name": "wrangnarok-artifacts-local", "bogus": 1 }],
    "durable_objects": { "bindings": [{ "name": "OAUTH_REFRESH_FENCE", "class_name": "OAuthRefreshFence" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["OAuthRefreshFence"] }],
    "workflows": [{ "binding": "ECHO_WORKFLOW", "name": "wrangnarok-echo-v1", "class_name": "EchoWorkflow" }, { "binding": "NINJA_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "NINJA_LOOKUP_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "DIGEST_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "SMOKE_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "HELLO_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "HELLO_PARENT_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "CLOUDFLARE_VERIFY_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "CLOUDFLARE_INVENTORY_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "CLOUDFLARE_AUDIT_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "CLOUDFLARE_INSIGHTS_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "CLOUDFLARE_POSTURE_WORKFLOW", "name": "n", "class_name": "C" }, { "binding": "ONBOARDING_WORKFLOW", "name": "n", "class_name": "C" }],
    "env": { "dev": { "name": "wrangnarok-dev" } },
  }`;
  expect("projects only celld-accepted top-level keys", () => {
    const config = buildCelldConfig(parseJsonc(sample));
    assert(!("observability" in config), "observability must be dropped");
    assert(!("workers_dev" in config), "workers_dev must be dropped");
    assert(!("routes" in config), "routes must be dropped");
    assert(!("env" in config), "env must never project");
    assert(config.name === "wrangnarok-local", "name must survive");
  });
  expect("keeps string data that looks like a comment", () => {
    const config = buildCelldConfig(parseJsonc(sample));
    assert(config.vars.LAB_ORG_ID === "https://example.test//not-a-comment", "string // must survive");
  });
  expect("filters assets to celld-accepted keys", () => {
    const config = buildCelldConfig(parseJsonc(sample));
    assert(!("bogus" in config.assets), "unknown assets key must be dropped");
    assert(config.assets.binding === "ASSETS", "assets binding must survive");
  });
  expect("rejects a name celld would refuse", () => {
    let threw = false;
    try {
      buildCelldConfig({ ...buildCelldConfig(parseJsonc(sample)), name: "Wrangnarok_Local" });
    } catch {
      threw = true;
    }
    assert(threw, "uppercase/underscore name must throw");
  });
  expect("rejects a projection missing Workflows", () => {
    const parsed = parseJsonc(sample);
    delete parsed.workflows;
    let threw = false;
    try {
      buildCelldConfig(parsed);
    } catch {
      threw = true;
    }
    assert(threw, "missing workflows must throw");
  });
  expect("preserves string data that looks like a trailing comma", () => {
    const parsed = parseJsonc(String.raw`{"a":"x,}","b":"y, ] z","c":"w,\n}"}`);
    assert(parsed.a === "x,}", "comma-brace inside a string must survive");
    assert(parsed.b === "y, ] z", "comma-bracket inside a string must survive");
    assert(parsed.c === "w,\n}", "escaped newline plus comma-brace must survive");
    assert(parseJsonc(`{"a":1, /* note */}`).a === 1, "trailing comma before a comment must be dropped");
  });
  expect("rejects a renamed required binding", () => {
    const parsed = parseJsonc(sample);
    parsed.d1_databases[0].binding = "WRONG";
    let threw = false;
    try {
      buildCelldConfig(parsed);
    } catch {
      threw = true;
    }
    assert(threw, "renamed DB binding must throw");
  });
  expect("rejects a secret-shaped committed var", () => {
    const parsed = parseJsonc(sample);
    parsed.vars = { LAB_TOKEN: "x" };
    let threw = false;
    try {
      buildCelldConfig(parsed);
    } catch {
      threw = true;
    }
    assert(threw, "LAB_TOKEN in committed vars must throw");
  });
  expect("rejects an unknown top-level key instead of dropping it", () => {
    const parsed = parseJsonc(sample);
    parsed.ai = { binding: "AI" };
    let threw = false;
    try {
      buildCelldConfig(parsed);
    } catch {
      threw = true;
    }
    assert(threw, "unknown key `ai` must throw");
  });
  expect("filters unknown nested binding keys", () => {
    const config = buildCelldConfig(parseJsonc(sample));
    const artifacts = config.r2_buckets.find((entry) => entry.binding === "ARTIFACTS");
    assert(artifacts && !("bogus" in artifacts), "nested bogus key must be dropped");
  });
  expect("rendered output has no hosted-only keys", () => {
    const rendered = renderCelldConfig(sample);
    assert(!rendered.includes("observability"), "rendered config must not carry observability");
    assert(rendered.startsWith("// GENERATED"), "rendered config must carry the generated header");
  });
  finish();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
