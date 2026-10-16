// SPDX-License-Identifier: AGPL-3.0
// Self-host Wrangnarok on celld (ADR 047). Cloudflare remains the hosted
// path (wrangler.jsonc + wrangler); this script is the celld operator path:
//
//   node scripts/deploy-celld.mjs --dry-run   print the plan, run nothing
//   node scripts/deploy-celld.mjs             build UI, deploy, done
//   node scripts/deploy-celld.mjs --migrate   also apply D1 migrations first
//   node scripts/deploy-celld.mjs --migrate-only   migrations only; the
//        fresh-fleet bootstrap (deploy once, then this) because a fleet
//        has no D1 cell until the first deployment exists
//   node scripts/deploy-celld.mjs selftest    offline unit verification
//
// celld has NO secret store (unlike `wrangler secret put`): a deployed
// Worker's vars come only from the deployed config, and celld persists
// that deployment in the fleet bucket. Secrets therefore never live in
// the committed wrangler.celld.jsonc. At deploy time this script merges
// a gitignored dotenv vars file (default .celld.vars, same NAME=value
// shape as .dev.vars) over the committed non-secret vars and writes the
// merged result to the gitignored wrangler.celld.deploy.jsonc, which is
// what `celld deploy` actually receives. Anyone with fleet-bucket access
// can read those vars: protect the bucket like a secret store.
//
// Prerequisites and environment (see docs/self-hosting-celld.md):
//   celld and esbuild on PATH (celld ships Linux/macOS binaries only --
//   on Windows run this under WSL2 or in a Linux container);
//   CELLD_BUCKET (s3://, gs://, or az:// fleet bucket);
//   S3_ENDPOINT / AWS_REGION / AWS_* only for an S3-compatible bucket.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCelldConfig, parseJsonc, renderCelldConfig, SOURCE_PATH, TARGET_PATH } from "./build-celld-config.mjs";
import { createSelftest } from "./selftest-harness.mjs";

/** Fail closed when wrangler.jsonc moved but the committed celld
 * projection was not regenerated: deploys read only the committed file,
 * so without this the fleet silently receives a stale config (CI's
 * check:celld cannot catch a deploy run before the push). */
export function assertCelldConfigFresh(sourceText, committedText) {
  if (renderCelldConfig(sourceText) !== committedText) {
    throw new Error("wrangler.celld.jsonc is stale vs wrangler.jsonc. Run `npm run config:celld` and commit first.");
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEPLOY_CONFIG_PATH = join(root, "wrangler.celld.deploy.jsonc");
const DEFAULT_VARS_FILE = join(root, ".celld.vars");
const BUCKET_SCHEMES = ["s3://", "gs://", "az://"];

/** Parse a dotenv file (NAME=value per line, optional `export ` prefix,
 * `#` comments, optionally quoted values). Mirrors the .dev.vars shape
 * celld dev already reads, so one file can serve both paths. */
export function parseDotenv(text) {
  const vars = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const entry = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = entry.indexOf("=");
    // Error text carries the line NUMBER only: a malformed line may be a
    // pasted credential, and echoing it would leak it to stderr and logs.
    if (eq <= 0) throw new Error(`Invalid vars line ${index + 1} (expected NAME=value).`);
    const name = entry.slice(0, eq).trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Invalid var name on line ${index + 1}.`);
    let value = entry.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    vars[name] = value;
  }
  return vars;
}

/** Build the deploy-time config: committed projection plus operator vars.
 * Operator vars win (e.g. LAB_ENABLED=true for LAB auth on a self-host). */
export function buildDeployConfig(committedText, operatorVars) {
  const config = buildCelldConfig(parseJsonc(committedText));
  config.vars = { ...config.vars, ...operatorVars };
  return config;
}

/** Validate the bucket endpoint/region before they reach celld's
 * credential-bearing S3 client: HTTPS everywhere, HTTP only for a
 * loopback or single-label (Docker/intranet service) host. */
export function validateBucketEnv({ endpoint, region }) {
  if (region !== undefined && region !== "" && !/^[a-z0-9][a-z0-9-]*$/.test(region)) {
    throw new Error(`AWS_REGION looks invalid: ${JSON.stringify(region)}.`);
  }
  if (endpoint === undefined || endpoint === "") return;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`S3_ENDPOINT is not a URL: ${JSON.stringify(endpoint)}.`);
  }
  if (url.protocol === "https:") return;
  const host = url.hostname.toLowerCase();
  if (
    url.protocol === "http:" &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes("."))
  ) {
    return;
  }
  throw new Error(`S3_ENDPOINT must be https (http is allowed only for loopback or single-label hosts): ${endpoint}.`);
}

/** Ordered command plan. Pure, so the selftest and --dry-run share it.
 * Migrations name the merged deploy config as PROJECT so celld reads the
 * celld bindings and `migrations_dir`, never the hosted wrangler.jsonc.
 * A fresh fleet has no D1 cell until the first deployment exists, so
 * first installs deploy first and migrate second (the --migrate-only
 * bootstrap in docs/self-hosting-celld.md); steady-state releases keep
 * the ADR 004 order, migrations before deploy. */
export function planCommands({ config, bucket, migrate, migrateOnly, skipBuild }) {
  const databaseName = config.d1_databases[0].database_name;
  const deployArgs = ["deploy", DEPLOY_CONFIG_PATH, "--bucket", bucket];
  if (process.env.S3_ENDPOINT) deployArgs.push("--endpoint", process.env.S3_ENDPOINT);
  if (process.env.AWS_REGION) deployArgs.push("--region", process.env.AWS_REGION);
  const migrateStep = {
    label: "apply D1 migrations",
    command: "celld",
    args: ["d1", "migrations", "apply", databaseName, DEPLOY_CONFIG_PATH, "--bucket", bucket],
  };
  if (migrateOnly) return [migrateStep];
  const plan = [];
  if (!skipBuild) plan.push({ label: "build UI", command: "npm", args: ["run", "build:ui"] });
  if (migrate) plan.push(migrateStep);
  plan.push({ label: "celld deploy", command: "celld", args: deployArgs });
  return plan;
}

/** Load the operator vars file. A real deploy without one would
 * silently ship the committed posture (LAB_ENABLED=false, no secrets):
 * a dead deployment that looks successful. Fail closed instead;
 * --dry-run may still preview var-less. */
export function loadOperatorVars(varsFile, dryRun) {
  if (!existsSync(varsFile)) {
    if (!dryRun) {
      throw new Error(
        `No vars file at ${varsFile}. Create it from the example in docs/self-hosting-celld.md (or pass --vars-file); refusing to deploy the bare committed config.`,
      );
    }
    console.log(`note: no vars file at ${varsFile}; the real deploy will require one.`);
    return {};
  }
  return parseDotenv(readFileSync(varsFile, "utf8"));
}

function fail(message) {
  console.error(`deploy-celld: ${message}`);
  process.exitCode = 1;
}

function runStep(step) {
  console.log(`\n==> ${step.label}: ${step.command} ${step.args.join(" ")}`);
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw new Error(`${step.label} could not start (${result.error.message}). Is it on PATH?`);
  if (result.status !== 0) throw new Error(`${step.label} failed with exit code ${result.status}.`);
}

function main(argv) {
  if (argv.includes("selftest")) return selftest();
  const dryRun = argv.includes("--dry-run");
  const migrateOnly = argv.includes("--migrate-only");
  const migrate = migrateOnly || argv.includes("--migrate");
  const skipBuild = argv.includes("--skip-build");
  const varsIndex = argv.indexOf("--vars-file");
  const varsFile = varsIndex >= 0 ? argv[varsIndex + 1] : DEFAULT_VARS_FILE;

  if (process.platform === "win32" && !dryRun) {
    return fail(
      "celld ships Linux/macOS binaries only. Run this under WSL2 or in a Linux container (docs/self-hosting-celld.md).",
    );
  }
  const bucket = process.env.CELLD_BUCKET ?? "";
  if (!dryRun && !BUCKET_SCHEMES.some((scheme) => bucket.startsWith(scheme))) {
    return fail("CELLD_BUCKET must be an s3://, gs://, or az:// fleet bucket (see docs/self-hosting-celld.md).");
  }

  let operatorVars;
  let config;
  try {
    operatorVars = loadOperatorVars(varsFile, dryRun);
    validateBucketEnv({ endpoint: process.env.S3_ENDPOINT, region: process.env.AWS_REGION });
    const committed = readFileSync(TARGET_PATH, "utf8");
    assertCelldConfigFresh(readFileSync(SOURCE_PATH, "utf8"), committed);
    config = buildDeployConfig(committed, operatorVars);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const plan = planCommands({ config, bucket: bucket || "s3://YOUR-BUCKET", migrate, migrateOnly, skipBuild });

  if (dryRun) {
    console.log("celld deploy plan (dry run: celld binary, bucket access, and fleet state are NOT checked):");
    for (const step of plan) console.log(`  ${step.label}: ${step.command} ${step.args.join(" ")}`);
    console.log(
      `  vars merged from ${varsFile && existsSync(varsFile) ? varsFile : "(none)"}: ${Object.keys(operatorVars).join(", ") || "(none)"}`,
    );
    return;
  }

  try {
    runPlan(config, plan, migrateOnly);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Write the merged secret-bearing config, run the plan, clean up.
 * The config is gitignored and owner-only where the filesystem honors
 * modes; it is deleted on success and kept (with a printed warning)
 * after a failure, for diagnosis. */
function runPlan(config, plan, migrateOnly) {
  writeFileSync(DEPLOY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote merged deploy config (gitignored, contains secrets): ${DEPLOY_CONFIG_PATH}`);
  const migrated = plan.some((step) => step.args.includes("migrations"));
  try {
    for (const step of plan) runStep(step);
  } catch (error) {
    console.error(`The merged deploy config remains at ${DEPLOY_CONFIG_PATH} for diagnosis; delete it when done.`);
    if (migrated) {
      console.error(
        "If migrations already applied, the schema may be ahead of the deployed code (ADR 004 forward-compatibility covers this); retry with a plain deploy (no --migrate).",
      );
    }
    throw error;
  }
  rmSync(DEPLOY_CONFIG_PATH, { force: true });
  if (migrateOnly) {
    console.log("\ncelld D1 migrations applied. No deployment was changed.");
    return;
  }
  console.log("\ncelld deploy complete. Nodes adopt the deployment in place (CELLD_DEPLOY_POLL_S, default 30s).");
  console.log(
    "Smoke it: node scripts/smoke-preview.mjs --base-url <your-ingress-url> --token <LAB_TOKEN> (see docs/self-hosting-celld.md).",
  );
}

function selftest() {
  const { assert, expect, finish } = createSelftest("deploy-celld selftest");
  expect("parses dotenv with quotes, export, and comments", () => {
    const vars = parseDotenv('# note\nexport LAB_ENABLED=true\nLAB_TOKEN="a b"\nPLAIN=x\n');
    assert(vars.LAB_ENABLED === "true", "export prefix must parse");
    assert(vars.LAB_TOKEN === "a b", "quoted value must unquote");
    assert(vars.PLAIN === "x", "plain value must parse");
  });
  expect("rejects a malformed vars line", () => {
    let threw = false;
    try {
      parseDotenv("NOT_A_PAIR\n");
    } catch {
      threw = true;
    }
    assert(threw, "line without = must throw");
  });
  expect("operator vars override committed vars", () => {
    const committed = JSON.stringify({
      name: "wrangnarok-local",
      main: "src/index.ts",
      vars: { LAB_ENABLED: "false" },
      d1_databases: [{ binding: "DB", database_name: "wrangnarok-local" }],
      r2_buckets: [
        { binding: "FILES", bucket_name: "wrangnarok-local" },
        { binding: "ARTIFACTS", bucket_name: "wrangnarok-artifacts-local" },
      ],
      durable_objects: { bindings: [{ name: "OAUTH_REFRESH_FENCE", class_name: "OAuthRefreshFence" }] },
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
      ].map((binding) => ({ binding, name: "n", class_name: "C" })),
    });
    const config = buildDeployConfig(committed, { LAB_ENABLED: "true", SECRETS_KEK: "k" });
    assert(config.vars.LAB_ENABLED === "true", "operator LAB_ENABLED must win");
    assert(config.vars.SECRETS_KEK === "k", "operator secret var must merge");
    assert(!("env" in config), "deploy config must not carry hosted env blocks");
  });
  expect("plan orders build, migrate, deploy", () => {
    const config = { d1_databases: [{ database_name: "wrangnarok-local" }] };
    const plan = planCommands({ config, bucket: "s3://fleet", migrate: true, skipBuild: false });
    assert(plan.length === 3, "plan must have three steps");
    assert(plan[0].label === "build UI", "UI build must come first (assets are deployed)");
    assert(plan[1].args.includes("migrations"), "migrations must precede deploy when requested");
    assert(plan[2].command === "celld" && plan[2].args[0] === "deploy", "deploy must come last");
  });
  expect("validates bucket endpoint and region", () => {
    validateBucketEnv({ endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto" });
    validateBucketEnv({ endpoint: "http://s3:9000", region: "us-east-1" }); // NOSONAR: intentional http fixture, single-label dev host
    let threw = false;
    try {
      validateBucketEnv({ endpoint: "http://169.254.169.254/latest", region: "us-east-1" });
    } catch {
      threw = true;
    }
    assert(threw, "a public http endpoint must be rejected");
    threw = false;
    try {
      validateBucketEnv({ endpoint: "https://example.com", region: "not a region!" });
    } catch {
      threw = true;
    }
    assert(threw, "a malformed region must be rejected");
  });
  expect("malformed vars errors name the line number, never the line", () => {
    const secret = "ghp_exampletokenvalue123";
    let message = "";
    try {
      parseDotenv(`${secret}\n`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("line 1"), "error must name the line number");
    assert(!message.includes(secret), "error must never echo the line content");
  });
  expect("freshness check passes on the committed pair and rejects a stale one", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    const committed = readFileSync(TARGET_PATH, "utf8");
    assertCelldConfigFresh(source, committed); // must not throw on the real pair
    let staleThrew = false;
    try {
      assertCelldConfigFresh(source, `${committed}\n`);
    } catch {
      staleThrew = true;
    }
    assert(staleThrew, "a stale committed config must throw");
  });
  expect("migrate-only plan is exactly the migration step (fresh-fleet bootstrap)", () => {
    const config = { d1_databases: [{ database_name: "wrangnarok-local" }] };
    const plan = planCommands({ config, bucket: "s3://fleet", migrateOnly: true, skipBuild: false });
    assert(plan.length === 1 && plan[0].args.includes("migrations"), "bootstrap must migrate without redeploying");
    assert(
      plan[0].args.includes(DEPLOY_CONFIG_PATH),
      "migrations must read the merged deploy config, not wrangler.jsonc",
    );
  });
  finish();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
