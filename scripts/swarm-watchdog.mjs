// SPDX-License-Identifier: AGPL-3.0
// Swarm watchdog: detects dead supervision zones and reports fleet health.
// Usage: node scripts/swarm-watchdog.mjs [--json]
// Must run under a shell where gh, git, ssh resolve (Windows: any shell with PATH).
// Signals: open PR merge states, lane worktree count, remote jcode-main counts.
import { execSync } from "node:child_process";

function sh(cmd, timeout = 90000) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout }).trim();
  } catch (e) {
    return `ERROR: ${String(e.stdout ?? e.message).split("\n")[0]}`;
  }
}

const out = { at: new Date().toISOString(), local: {}, remotes: {}, prs: [], alerts: [] };

// Open PRs: number + branch via JSON, merge state per PR
try {
  const listRaw = sh("gh pr list --state open --json number,headRefName");
  const list = JSON.parse(listRaw || "[]");
  for (const pr of list) {
    let state = "UNKNOWN";
    try {
      const d = JSON.parse(sh(`gh pr view ${pr.number} --json mergeable,mergeStateStatus`));
      state = `${d.mergeable} ${d.mergeStateStatus}`;
    } catch {
      state = "VIEW-FAILED";
    }
    out.prs.push({ number: pr.number, branch: pr.headRefName, state });
    if (/CONFLICTING/.test(state)) out.alerts.push(`PR #${pr.number} [${pr.headRefName}] CONFLICTING`);
  }
} catch (e) {
  out.alerts.push(`PR check failed: ${e.message}`);
}

// Lane worktree count (main checkout + lane worktrees)
try {
  const wt = sh("git worktree list --porcelain");
  out.local.worktrees = wt.split("\n").filter((l) => l.startsWith("worktree ")).length;
} catch (e) {
  out.alerts.push(`worktree check failed: ${e.message}`);
}

// Remote workers (direct ssh, no nested shells)
for (const host of ["codex-remote-01", "codex-remote-02"]) {
  const n = sh(`ssh -o ConnectTimeout=10 -o BatchMode=yes ${host} "ps aux | grep jcode-main | grep -v grep | wc -l"`);
  const count = Number(n) || 0;
  out.remotes[host] = { workers: count };
  if (count === 0) out.alerts.push(`${host} has zero jcode-main workers`);
}

if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`watchdog @ ${out.at}`);
  console.log(`local worktrees: ${out.local.worktrees}`);
  for (const [h, r] of Object.entries(out.remotes)) console.log(`${h}: ${r.workers} workers`);
  for (const p of out.prs) console.log(`PR #${p.number} [${p.branch}] ${p.state}`);
  if (out.alerts.length > 0) {
    console.log("ALERTS:");
    for (const a of out.alerts) console.log(` - ${a}`);
    process.exitCode = 2;
  } else console.log("OK: no alerts");
}
