// SPDX-License-Identifier: AGPL-3.0
// Lane scope check: verify a lane branch touches only its slice's files.
// Usage: node scripts/lane-scope.mjs <scope-file>
//    or: node scripts/lane-scope.mjs --self-check   (CI mode: the branch diff
//        must be covered by a scopes/*.scope file carried in the branch, or
//        touch only chore paths. Advisory warn when no scope file present.)
// A scope file lists allowed path prefixes, one per line ("#" comments allowed).
// Exit 0 = clean, exit 1 = out-of-scope files staged, unstaged, or committed.
// Compares working tree + index + branch diff vs origin/main.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const eventNameIndex = args.indexOf("--event-name");
const eventName = eventNameIndex >= 0 ? args[eventNameIndex + 1] : process.env.GITHUB_EVENT_NAME || "pull_request";

// Directories lanes must never stage, regardless of scope file.
const NEVER = [".jcode/skills/", ".opencode/skills/", "node_modules/", ".wrangler/", "vendor/"];

function readAllowed(scopeFile) {
  return readFileSync(scopeFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function isAllowed(f, allowed) {
  if (NEVER.some((n) => f.startsWith(n))) return false;
  return allowed.some((a) => f === a || f.startsWith(a.endsWith("/") ? a : a + "/") || f.startsWith(a));
}

function coversAll(diff, allowed) {
  return diff.every((f) => isAllowed(f, allowed));
}

function coveredByUnion(diff, scopeSets) {
  return diff.every((f) => scopeSets.some((allowed) => isAllowed(f, allowed)));
}

function branchDiff() {
  // Issue #373: fail CLOSED when the base ref is unavailable. The old code
  // swallowed the git error and returned [], reporting a tree with arbitrary
  // committed out-of-scope changes as clean (exit 0).
  let out;
  try {
    out = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" });
  } catch {
    console.error("lane-scope: cannot diff origin/main...HEAD (missing base ref? run `git fetch origin main`).");
    process.exit(2);
  }
  return out
    .split("\n")
    .map((l) => l.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

if (args[0] === "--selftest") {
  // Offline selftest (issue #373): no git mutations, no network.
  // Verifies prefix matching and documents the fail-closed contract.
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`lane-scope selftest failed: ${name}`);
    passed += 1;
  };
  check("exact", isAllowed("scripts/a.mjs", ["scripts/a.mjs"]));
  check("prefix dir", isAllowed("scopes/x.scope", ["scopes/"]));
  check("prefix file", isAllowed("scopes/x.scope.bak", ["scopes/x.scope"]));
  check("reject outside", !isAllowed("src/index.ts", ["scripts/"]));
  check("reject never", !isAllowed("node_modules/x", ["node_modules/"]));
  check("reject partial", !isAllowed("scripts2/a.mjs", ["scripts/"]));
  const batchedDiff = ["src/a.ts", "test/b.test.ts", "scopes/a.scope", "scopes/b.scope"];
  const batchedScopes = [
    ["src/a.ts", "scopes/a.scope"],
    ["test/b.test.ts", "scopes/b.scope"],
  ];
  check("single lane cannot claim batch", !batchedScopes.some((allowed) => coversAll(batchedDiff, allowed)));
  check("merge-group union covers batch", coveredByUnion(batchedDiff, batchedScopes));
  check(
    "merge-group union rejects uncovered path",
    !coveredByUnion([...batchedDiff, "src/unclaimed.ts"], batchedScopes),
  );
  // Fail-closed contract: branchDiff() and the committed-diff read must
  // exit 2 (not return empty) when origin/main is unavailable. The live
  // behavior is verified by code inspection plus the CI gate below; this
  // pins the helper surface that enforces it.
  const source = readFileSync(new URL(import.meta.url), "utf8");
  check("fail-closed diff", source.includes("cannot diff origin/main...HEAD"));
  check("no empty fallback", !source.includes("} catch {\n    return [];"));
  console.log(`lane-scope selftest: ${passed} passed.`);
  process.exit(0);
}

if (args[0] === "--self-check") {
  // CI mode.
  const diff = branchDiff();
  const scopeFiles = diff.filter(
    (f) => f.startsWith("scopes/") && f.endsWith(".scope") && f !== "scopes/LANE-RULES.md",
  );
  // Chore paths need no scope file (queue config, CI itself, supervision
  // machinery, migration ledger, ADRs).
  const CHORE = [
    ".mergify.yml",
    ".github/",
    "scripts/lane-scope.mjs",
    "scopes/",
    "docs/migration-ledger.md",
    "docs/architecture/",
  ];
  const isChoreOnly = diff.length > 0 && diff.every((f) => CHORE.some((c) => f === c || f.startsWith(c)));
  if (isChoreOnly && scopeFiles.length === 0) {
    console.log(`lane-scope: clean (chore-only, ${diff.length} files, no scope file required)`);
    process.exit(0);
  }
  if (scopeFiles.length === 0) {
    // Advisory until every active lane adopts its file (see #193 follow-up).
    console.log("lane-scope: WARNING — no scopes/*.scope in this branch; scope enforcement advisory (see #193).");
    process.exit(0);
  }
  // Pass when ANY scope file in the branch covers the full diff (that is
  // the lane's own scope). Other lanes' scope files may be present as data
  // without covering this branch's changes.
  const covering = [];
  const uncoveredReports = [];
  const scopeSets = [];
  for (const scopeFile of scopeFiles) {
    const allowed = readAllowed(scopeFile);
    scopeSets.push(allowed);
    const bad = diff.filter((f) => !isAllowed(f, allowed));
    if (bad.length) {
      uncoveredReports.push({ scopeFile, bad });
    } else {
      covering.push(scopeFile);
      console.log(`lane-scope: clean (${scopeFile} covers ${diff.length} files)`);
    }
  }
  // A pull request must remain wholly owned by one lane. A merge_group is a
  // synthetic aggregate of PRs that already passed that required check, so
  // no single lane should claim the other lanes' files. Require the aggregate
  // to be covered by the union of the scope files carried in the group; this
  // preserves fail-closed coverage without defeating merge-queue batching.
  if (eventName === "merge_group") {
    const bad = diff.filter((f) => !scopeSets.some((allowed) => isAllowed(f, allowed)));
    if (bad.length === 0) {
      console.log(`lane-scope: clean (merge-group union of ${scopeFiles.length} scopes covers ${diff.length} files)`);
      process.exit(0);
    }
    console.error("lane-scope: merge-group scope union does not cover:");
    for (const f of bad) console.error(`  ${f}`);
    process.exit(1);
  }
  if (covering.length === 0) {
    for (const { scopeFile, bad } of uncoveredReports) {
      console.error(`lane-scope: ${scopeFile} does not cover branch diff:`);
      for (const f of bad) console.error(`  ${f}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

const scopeFile = args.find((a) => !a.startsWith("-"));
if (!scopeFile || !existsSync(scopeFile)) {
  console.error("usage: node scripts/lane-scope.mjs <scope-file>");
  process.exit(2);
}

const allowed = readAllowed(scopeFile);

let out;
try {
  // Uncommitted changes (working tree + index).
  const uncommitted = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  // Committed branch changes vs origin/main (fail closed per #373).
  let committed = "";
  try {
    committed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" });
  } catch {
    console.error("lane-scope: cannot diff origin/main...HEAD (missing base ref? run `git fetch origin main`).");
    process.exit(2);
  }
  out =
    uncommitted +
    "\n" +
    committed
      .split("\n")
      .filter(Boolean)
      .map((f) => `M  ${f}`)
      .join("\n");
} catch {
  console.error("lane-scope: git status failed");
  process.exit(2);
}

const files = out
  .split("\n")
  .map((l) =>
    l
      .slice(3)
      .trim()
      .replace(/^"(.*)"$/, "$1"),
  )
  .filter(Boolean)
  // Rename entries ("old -> new"): scope applies to the new path.
  .map((f) =>
    f.includes(" -> ")
      ? f
          .split(" -> ")
          .pop()
          .trim()
          .replace(/^"(.*)"$/, "$1")
      : f,
  );

const bad = files.filter((f) => {
  if (NEVER.some((n) => f.startsWith(n))) return true;
  return !allowed.some((a) => f === a || f.startsWith(a.endsWith("/") ? a : a + "/") || f.startsWith(a));
});

if (bad.length) {
  console.error("lane-scope: out-of-scope files detected:");
  for (const f of bad) console.error(`  ${f}`);
  console.error(`allowed prefixes (${scopeFile}):`);
  for (const a of allowed) console.error(`  ${a}`);
  process.exit(1);
}
console.log(`lane-scope: clean (${files.length} files within scope)`);
