// SPDX-License-Identifier: AGPL-3.0
// Local solutions installer (ADR 011 v1 slice): reconciles a bundle manifest
// against the LOCAL D1 database through the real installBundle
// implementation (src/solutions.ts), not a reimplementation.
//
// Usage: node scripts/install-local.mjs <manifest> <org> [--dry-run] [--force]
//
// - <manifest>: path to a solution.manifest.json file.
// - <org>: manifest org name to install (must declare connections).
// - --dry-run: validate + preflight, print the drift plan, write nothing.
// - --force: allow downgrades (rollback = reinstalling an older manifest).
//
// Secrets: for every secretsRequired name in scope, the runner reads the
// UPPER_SNAKE env var (clientSecret -> CLIENT_SECRET) and passes values to
// installBundle for presence-checking only. Values are never printed,
// persisted, or embedded in SQL. Fixture secrets come from env, per scope.
//
// Prerequisites: npm ci, then npm run db:migrate:local (the runner refuses
// when the bundle_installs table is missing).
//
// Deviations from workerd (documented, not hidden):
// - D1 goes through `wrangler d1 execute --local`, whose --json meta omits
//   `changes`. The fenced-update lost-race checks (INSTALL_CONFLICT on
//   changes === 0: reconcile writes, absentee deletes, activation moves)
//   therefore never fire here; they are proven in workerd tests instead.
//   Reads/writes are otherwise the same statements.
// - src/solutions.ts is bundled with the repo's own esbuild so the runner
//   stays dependency-free and exercises the exact source tests cover.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const ESBUILD = join(ROOT, "node_modules", "esbuild", "bin", "esbuild");

function usage() {
  console.error("Usage: node scripts/install-local.mjs <manifest> <org> [--dry-run] [--force]");
}

function secretEnvKey(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot inline a non-finite number into SQL.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value !== "string") throw new Error("Cannot inline a non-scalar into SQL.");
  return `'${value.replaceAll("'", "''")}'`;
}

function runWrangler(args) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [WRANGLER, ...args],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolvePromise(stdout);
      },
    );
  });
}

// Minimal D1Database-compatible shim over `wrangler d1 execute --local`.
// installBundle only uses prepare().bind().first()/run(), so only those
// are implemented. One statement per call: --json then yields a single
// result object whose results/meta shape mirrors workerd D1.
function localDb() {
  async function exec(sql) {
    const stdout = await runWrangler(["d1", "execute", "DB", "--local", "--command", sql, "--json"]);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Unexpected wrangler output: ${stdout.slice(0, 200)}`);
    }
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!first || first.success !== true) throw new Error(`D1 statement failed: ${sql.slice(0, 120)}`);
    return first;
  }
  return {
    prepare(sql) {
      return {
        bind(...params) {
          let index = 0;
          const inlined = sql.replace(/\?/g, () => {
            if (index >= params.length) throw new Error("Not enough bind parameters for statement.");
            return literal(params[index++]);
          });
          if (index !== params.length) throw new Error("Too many bind parameters for statement.");
          return {
            async first() {
              const result = await exec(inlined);
              return result.results.length > 0 ? result.results[0] : null;
            },
            async all() {
              const result = await exec(inlined);
              return { results: result.results };
            },
            async run() {
              const result = await exec(inlined);
              return { meta: result.meta ?? {} };
            },
          };
        },
      };
    },
  };
}

function bundleSources() {
  return new Promise((resolvePromise, reject) => {
    const out = join(tmpdir(), `wrangnarok-solutions-${process.pid}.mjs`);
    execFile(
      process.execPath,
      [
        ESBUILD,
        join(ROOT, "src", "solutions.ts"),
        "--bundle",
        "--platform=node",
        "--format=esm",
        `--outfile=${out}`,
        "--log-level=error",
      ],
      { cwd: ROOT },
      (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolvePromise(out)),
    );
  });
}

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith("--"));
const orgArg = args.filter((a) => !a.startsWith("--"))[1];
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const unknown = args.filter((a) => a.startsWith("--") && a !== "--dry-run" && a !== "--force");
if (!manifestPath || !orgArg || unknown.length > 0) {
  usage();
  process.exit(2);
}
if (!existsSync(WRANGLER)) {
  console.error("Wrangler is not installed. Run npm ci first.");
  process.exit(1);
}
if (!existsSync(ESBUILD)) {
  console.error("esbuild is not installed. Run npm ci first.");
  process.exit(1);
}

let bundled;
try {
  const raw = await readFile(resolve(ROOT, manifestPath), "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    console.error("INVALID_MANIFEST: the manifest file is not valid JSON.");
    process.exit(1);
  }
  bundled = await bundleSources();
  const solutions = await import(pathToFileURL(bundled).href);
  const parsed = solutions.parseBundleManifest(manifest);
  const names = new Set();
  for (const integration of parsed.integrations) {
    for (const conn of integration.connections) {
      if (conn.org === orgArg) for (const name of conn.secretsRequired) names.add(name);
    }
  }
  const secrets = {};
  for (const name of names) {
    const key = secretEnvKey(name);
    if (typeof process.env[key] === "string" && process.env[key].length > 0) secrets[name] = process.env[key];
    else console.error(`Secret "${name}" has no value in $${key}.`);
  }
  const db = localDb();
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bundle_installs'")
    .bind()
    .first();
  if (!tables) {
    console.error("bundle_installs table is missing. Run npm run db:migrate:local first.");
    process.exit(1);
  }
  const result = await solutions.installBundle(db, manifest, { secrets, force, dryRun, orgName: orgArg });
  console.log(
    JSON.stringify(
      {
        bundle: result.bundleId,
        version: result.version,
        manifestHash: result.manifestHash,
        orgIds: result.orgIds,
        drift: result.drift,
        dryRun: result.dryRun,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const code = error && typeof error.code === "string" ? error.code : "INSTALL_FAILED";
  console.error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  if (bundled) await unlink(bundled).catch(() => {});
}
