// SPDX-License-Identifier: AGPL-3.0
// CI topology contract (issue #448): deterministic, dependency-free check
// that the parallel Runtime split preserves every gate and that the single
// required `Validate` aggregator fails closed on any skipped/failed shard.
// Usage: node scripts/ci-topology.mjs --check     (validates .github/workflows/ci.yml)
//    or: node scripts/ci-topology.mjs --selftest  (offline unit verification,
//        including negative fixtures proving a weakened gate fails the check).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CI_PATH = join(root, ".github/workflows/ci.yml");

// Every pre-existing gate must appear exactly once (issue #448 acceptance:
// represented exactly once unless proven redundant — none is).
const EXACT_ONCE = [
  "npm run typecheck",
  "npm run test:coverage",
  "test/smoke.test.ts",
  "npm run build:ui",
  "wrangler deploy --dry-run --env dev",
  "npm run check:bundle",
  "db:migrate:local",
];

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function checkYaml(text) {
  const errors = [];
  const has = (re) => re.test(text);

  // Job topology: static + two runtime shards + aggregator, no monolith.
  for (const job of ["static:", "runtime-test:", "runtime-build:", "validate:"]) {
    if (!has(new RegExp(`^  ${job}$`, "m"))) errors.push(`missing job \`${job}\``);
  }
  if (has(/^ {2}runtime:$/m))
    errors.push("monolithic `runtime:` job must be gone (split into runtime-test/runtime-build)");

  // Validate aggregation: always runs, needs every shard, fails closed.
  if (!has(/needs:\s*\[static,\s*runtime-test,\s*runtime-build\]/)) {
    errors.push("Validate must need [static, runtime-test, runtime-build]");
  }
  if (!has(/^\s+if:\s+always\(\)\s*$/m)) errors.push("Validate must run `if: always()`");
  for (const shard of ["static", "runtime-test", "runtime-build"]) {
    if (!has(new RegExp(`needs\\.${shard}\\.result`))) {
      errors.push(`Validate must assert needs.${shard}.result == "success" (fail closed on skip/cancel)`);
    }
  }

  // Events, concurrency, permissions preserved.
  for (const token of ["pull_request:", "merge_group:", "workflow_dispatch:", "branches:\n      - main"]) {
    if (!text.includes(token)) errors.push(`missing trigger \`${token.split(":")[0]}\``);
  }
  if (!text.includes("cancel-in-progress: true")) errors.push("missing concurrency cancel-in-progress");
  if (!text.includes("contents: read")) errors.push("missing `contents: read` permissions");

  // Pinned actions: every `uses:` must pin a full 40-hex commit SHA.
  const usesLines = text.split("\n").filter((l) => l.trim().startsWith("uses:"));
  if (usesLines.length === 0) errors.push("no `uses:` lines found");
  for (const line of usesLines) {
    if (!/@[0-9a-f]{40}\b/.test(line)) errors.push(`unpinned action: ${line.trim()}`);
  }

  // Every gate exactly once; Codecov stays conditional-fail-closed.
  for (const gate of EXACT_ONCE) {
    const n = countOccurrences(text, gate);
    if (n !== 1) errors.push(`gate \`${gate}\` appears ${n}x (must be exactly once)`);
  }
  if (!text.includes("fail_ci_if_error: true")) errors.push("Codecov must keep fail_ci_if_error: true");
  if (!text.includes("HAS_CODECOV_TOKEN")) errors.push("Codecov conditional token guard must be preserved");

  // Node toolchain pinned; every job bounded.
  if (!text.includes("node-version: 22")) errors.push("Node version must stay pinned to 22");
  const jobOrder = ["static", "runtime-test", "runtime-build", "validate"];
  const positions = jobOrder.map((job) => ({ job, at: text.indexOf(`\n  ${job}:`) }));
  positions.forEach(({ job, at }, k) => {
    if (at < 0) return; // missing job already reported above
    const later = positions
      .slice(k + 1)
      .map((p) => p.at)
      .filter((i) => i > at);
    const end = later.length ? Math.min(...later) : text.length;
    if (!/timeout-minutes:\s*\d+/.test(text.slice(at, end))) {
      errors.push(`job ${job} must declare timeout-minutes`);
    }
  });

  // The contract itself must be wired into CI so aggregation cannot drift.
  if (!text.includes("scripts/ci-topology.mjs --check")) {
    errors.push("static job must run `node scripts/ci-topology.mjs --check`");
  }
  return errors;
}

if (process.argv[2] === "--selftest") {
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`ci-topology selftest failed: ${name}`);
    passed += 1;
  };
  const good = readFileSync(CI_PATH, "utf8");
  check("current ci.yml passes", checkYaml(good).length === 0);

  // Negative fixtures: each weakening must fail the check.
  const mutate = (from, to) => {
    const mutated = to === null ? good.replace(from, "") : good.split(from).join(to);
    check(`mutation detected: ${from.slice(0, 42)}`, checkYaml(mutated).length > 0);
  };
  mutate("needs: [static, runtime-test, runtime-build]", "needs: [static, runtime-test]");
  mutate("if: always()", null);
  mutate('test "${{ needs.runtime-build.result }}" == "success"', null);
  mutate(
    "npm run test:coverage",
    "npm run test:coverage\n      - name: Test with coverage again\n        run: npm run test:coverage",
  );
  mutate("fail_ci_if_error: true", "fail_ci_if_error: false");
  mutate("uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5", "uses: actions/checkout@v5");
  mutate("merge_group:", null);
  mutate("cancel-in-progress: true", null);
  mutate("  runtime-build:", "  runtime:");
  check("exact-once counts duplication", checkYaml(good + "\n        run: npm run check:bundle\n").length > 0);
  console.log(`ci-topology selftest: ${passed} passed.`);
  process.exit(0);
}

const errors = checkYaml(readFileSync(CI_PATH, "utf8"));
if (errors.length) {
  for (const e of errors) console.error(`ci-topology: ${e}`);
  process.exit(1);
}
console.log("ci-topology: contract holds (static + runtime-test + runtime-build -> fail-closed Validate).");
