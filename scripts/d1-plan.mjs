// SPDX-License-Identifier: AGPL-3.0
// Developer query-plan review (issue #302, Slice B): runs EXPLAIN QUERY
// PLAN for the registered hot-path queries against the local D1 and prints
// a coarse SCAN/SEARCH classification per query.
//
// Usage: node scripts/d1-plan.mjs [--operation <name>]
// Prereq: npm run db:migrate:local (applies migrations/ to the local DB).
//
// Advisory only by design: SQLite documents EQP output as debugging-oriented
// and not a stable machine API, so this script is a human review aid, not a
// CI gate. A mismatch exit code means "human, look at this", and the
// registry's `expect` values are updated deliberately when plans change.
import { execFile } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

// Hot-path registry: the exact SQL the caller runs, representative bind
// values, and the classification a human last confirmed as healthy.
const QUERIES = [
  {
    operation: "saga-policy.load",
    sql: "SELECT policy_json,version,updated_at FROM saga_policies WHERE org_id=? AND saga_id=?",
    params: ["00000000-0000-4000-8000-000000000001", "smoke"],
    expect: "search",
  },
  {
    operation: "executions.admission-count",
    sql: "SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND saga_id=? AND status IN ('Pending','Running','Cancelling') AND id<>?",
    params: ["00000000-0000-4000-8000-000000000001", "smoke", "00000000-0000-4000-8000-000000000003"],
    expect: "search",
  },
];

function literal(value) {
  if (value === null) return "NULL";
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

function classify(details) {
  if (details.length === 0) return "unknown";
  const upper = details.map((d) => d.toUpperCase());
  const scan = upper.some((d) => d.includes("SCAN"));
  const search = upper.some((d) => d.includes("SEARCH"));
  if (scan && search) return "mixed";
  if (scan) return "scan";
  if (search) return "search";
  return "unknown";
}

const only = process.argv.includes("--operation") ? process.argv[process.argv.indexOf("--operation") + 1] : null;

let mismatches = 0;
for (const query of QUERIES) {
  if (only && query.operation !== only) continue;
  let index = 0;
  const inlined = query.sql.replace(/\?/g, () => literal(query.params[index++]));
  const stdout = await runWrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--command",
    `EXPLAIN QUERY PLAN ${inlined}`,
    "--json",
  ]);
  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const rows = first?.results ?? [];
  const details = rows.map((row) => String(row.detail));
  const classification = classify(details);
  const match = classification === query.expect;
  if (!match) mismatches += 1;
  console.log(`[${match ? "OK" : "REVIEW"}] ${query.operation}: ${classification} (expected ${query.expect})`);
  for (const detail of details) console.log(`    ${detail}`);
}
if (mismatches > 0) {
  console.log(
    `${mismatches} quer${mismatches === 1 ? "y needs" : "ies need"} human review; see docs/d1-conventions.md.`,
  );
  process.exit(2);
}
