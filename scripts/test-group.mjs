// SPDX-License-Identifier: AGPL-3.0
// Focused test-group runner (issues #332/#333).
//
// Usage: node scripts/test-group.mjs <unit|workflow> [-- ...vitest args]
//
// - `unit`: pure TypeScript suites with no Worker runtime surface (no
//   cloudflare:* imports, no worker fetch). Fast feedback for domain rules.
// - `workflow`: suites that drive local Workflow instances (tracked via
//   test/helpers/workflow-harness.ts or legacy introspectWorkflowInstance).
//   These own the engine-telemetry noise the unhandled-rejection guard
//   allowlists; run them in isolation when triaging harness flakes.
//
// Membership is computed from file contents, not a checked-in list, so new
// test files join the right group without a manifest update. These focused
// runs do NOT enforce the 95% coverage floor: the gates stay `npm test`
// (full suite) and `npm run test:coverage` (all four metrics >= 95).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const group = process.argv[2];
if (group !== "unit" && group !== "workflow") {
  console.error("Usage: node scripts/test-group.mjs <unit|workflow> [-- ...vitest args]");
  process.exit(2);
}
const extra = process.argv.slice(3);

const dir = new URL("../test/", import.meta.url);
const files = readdirSync(dir, { recursive: true })
  .filter((name) => /\.test\.(ts|tsx)$/.test(name))
  .map((name) => join("test", name))
  .sort();

function isWorkflow(source) {
  return source.includes("introspectWorkflowInstance") || source.includes("trackWorkflowInstance");
}
function isUnit(source) {
  return (
    !source.includes("cloudflare:") &&
    !source.includes("../src/index") &&
    !source.includes("worker.fetch") &&
    // Production-harness files boot a real local workerd via
    // createTestHarness() (issue #249): no cloudflare:* imports, but not
    // unit — keep the fast group fast.
    !source.includes('from "wrangler"') &&
    !/\bSELF\b/.test(source)
  );
}

const selected = files.filter((file) => {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  return group === "workflow" ? isWorkflow(source) : isUnit(source);
});
if (selected.length === 0) {
  console.error(`test-group: no files selected for group "${group}"`);
  process.exit(1);
}
console.log(`test-group: ${group} (${selected.length} files)`);
execFileSync("npx", ["vitest", "run", ...selected, ...extra], { stdio: "inherit" });
