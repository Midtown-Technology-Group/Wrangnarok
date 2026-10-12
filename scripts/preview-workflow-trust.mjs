// SPDX-License-Identifier: AGPL-3.0
// Fail-closed contract for the credential-bearing PR preview workflow.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(root, ".github/workflows/preview.yml");

export function checkPreviewWorkflow(text) {
  const errors = [];
  const requireText = (needle, message) => {
    if (!text.includes(needle)) errors.push(message);
  };

  requireText("  workflow_dispatch:\n", "preview must be manually dispatched");
  if (/^\s{2}pull_request(?:_target)?:/m.test(text)) errors.push("preview must not run automatically for PR code");
  requireText("      pr_number:", "preview must require a PR number");
  requireText("      head_sha:", "preview must require an exact reviewed head SHA");
  requireText('[[ "$EXPECTED_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]', "head SHA must be validated as full hex");
  requireText("admin|maintain|write", "dispatcher must have repository write authority");
  requireText('.head.repo.full_name <<<"$PR"', "fork PRs must be rejected");
  requireText('[[ "$ACTUAL_HEAD_SHA" == "$EXPECTED_HEAD_SHA" ]]', "current PR head must match reviewed SHA");
  requireText('echo "merge_sha=$MERGE_SHA"', "validated merge commit must become an output");
  requireText("ref: ${{ steps.pr.outputs.merge_sha }}", "checkout must use the validated immutable merge SHA");
  requireText("environment: preview", "credentialed job must use the preview environment");
  return errors;
}

const workflow = readFileSync(workflowPath, "utf8");
if (process.argv.includes("--selftest")) {
  let passed = 0;
  const check = (name, condition) => {
    if (!condition) throw new Error(`preview workflow selftest failed: ${name}`);
    passed += 1;
  };
  check("current workflow passes", checkPreviewWorkflow(workflow).length === 0);
  for (const [name, from, to] of [
    ["automatic PR trigger", "  workflow_dispatch:\n", "  pull_request:\n"],
    ["missing permission gate", "admin|maintain|write", "admin|maintain"],
    ["missing exact SHA match", '[[ "$ACTUAL_HEAD_SHA" == "$EXPECTED_HEAD_SHA" ]]', "true"],
    ["unvalidated checkout", "ref: ${{ steps.pr.outputs.merge_sha }}", "ref: refs/pull/1/merge"],
    ["missing environment", "environment: preview", "environment: none"],
  ]) {
    check(name, checkPreviewWorkflow(workflow.replace(from, to)).length > 0);
  }
  console.log(`preview workflow selftest: ${passed} passed.`);
  process.exit(0);
}

const errors = checkPreviewWorkflow(workflow);
if (errors.length) {
  for (const error of errors) console.error(`preview workflow: ${error}`);
  process.exit(1);
}
console.log("preview workflow: manual exact-SHA trust boundary holds.");
