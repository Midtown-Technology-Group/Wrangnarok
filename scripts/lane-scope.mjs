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

function branchDiff() {
  try {
    return execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
  } catch {
    return [];
  }
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
  for (const scopeFile of scopeFiles) {
    const allowed = readAllowed(scopeFile);
    const bad = diff.filter((f) => !isAllowed(f, allowed));
    if (bad.length) {
      uncoveredReports.push({ scopeFile, bad });
    } else {
      covering.push(scopeFile);
      console.log(`lane-scope: clean (${scopeFile} covers ${diff.length} files)`);
    }
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
  // Committed branch changes vs origin/main.
  let committed = "";
  try {
    committed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" });
  } catch {
    committed = "";
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
