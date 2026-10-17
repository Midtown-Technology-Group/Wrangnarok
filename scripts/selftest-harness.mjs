// SPDX-License-Identifier: AGPL-3.0
// Shared harness for the celld scripts' `selftest` modes, so the check
// bookkeeping exists exactly once. Usage:
//   const t = createSelftest("deploy-celld selftest");
//   t.expect("label", () => { t.assert(cond, "message"); });
//   t.finish(); // sets process.exitCode = 1 on any failure
export function createSelftest(name) {
  const failures = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const expect = (label, fn) => {
    try {
      fn();
      console.log(`ok - ${label}`);
    } catch (error) {
      failures.push(label);
      console.error(`FAIL - ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const finish = () => {
    if (failures.length > 0) {
      console.error(`${name}: ${failures.length} failure(s).`);
      process.exitCode = 1;
      return;
    }
    console.log(`${name}: all checks passed.`);
  };
  return { assert, expect, finish };
}
