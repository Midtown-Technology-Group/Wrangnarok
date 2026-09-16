#!/usr/bin/env node
// Local helper: triage Codex Security CSV export into GitHub issues.
// Usage: node scripts/triage-codex-findings.mjs "<csv path>" [--dry-run]
// No prod runtime, no Saga logic. Idempotent: skips titles already present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [, , csvPath, flag] = process.argv;
const DRY = flag === "--dry-run";
if (!csvPath) {
  console.error('USAGE: node scripts/triage-codex-findings.mjs "<csv path>" [--dry-run]');
  process.exit(2);
}

function parseCSV(t) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { if (t[i + 1] === "\n") i++; row.push(field); field = ""; rows.push(row); row = []; }
      else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Labels per finding title for informational items (medium/low default below).
const INFO_LABELS = {
  "OAuth refresh fence does not cross Workflow isolates": ["codex", "security", "priority-low"],
  "Duplicate declaration prevents provider security test execution": ["codex", "testing", "priority-low"],
  "New saga-policy CLI commands cannot receive their arguments": ["codex", "bug", "priority-low"],
  "Global due-row limit enables cross-tenant scheduler starvation": ["codex", "security", "priority-low"],
  "Empty Access header spoofs fixture callers as human": ["codex", "security", "priority-low"],
  "Import accepts manifests with missing module declarations": ["codex", "bug", "priority-low"],
  "Renamed D1 migration is replayed on existing databases": ["codex", "bug", "priority-low"],
  "Renamed migration cannot replay on existing databases": ["codex", "bug", "priority-low"],
  "Renamed D1 migration breaks upgrades from the baseline": ["codex", "bug", "priority-low"],
  "Renamed migration cannot upgrade existing databases": ["codex", "bug", "priority-low"],
  "Renamed migration breaks upgrades on existing D1 databases": ["codex", "bug", "priority-low"],
  "Valid long hello names now fail during log emission": ["codex", "bug", "priority-low"],
  "Lane scope check fails open when the base ref is unavailable": ["codex", "testing", "priority-low"],
  "SDK transmits bearer and Access credentials over plain HTTP": ["codex", "security", "priority-low"],
  "Whole-command regex allows bypassing the Wrangler safety guard": ["codex", "security", "priority-low"],
  "PR code can steal the account-scoped Cloudflare deploy token": ["codex", "security", "priority-low"],
  "Hello fails for accepted names after JSON expansion": ["codex", "bug", "priority-low"],
  "Vault skill instructs agents to disclose secret fragments": ["codex", "security", "priority-low"],
  "Codecov action uses a mutable tag while receiving a secret": ["codex", "security", "priority-low"],
  "Mailbox CLI crosses repository-scoped stores": ["codex", "security", "priority-low"],
  "Cancelling migration fails when operation history exists": ["codex", "bug", "priority-low"],
  "Mailbox aliases can be hijacked to impersonate peer sessions": ["codex", "security", "priority-low"],
  "Unpinned OpenCode plugin allows mutable supply-chain code": ["codex", "security", "priority-low"],
};

function labelsFor(sev, title) {
  if (sev === "medium") return ["codex", "security", "priority-high"];
  if (sev === "low") return ["codex", "security", "priority-medium"];
  return INFO_LABELS[title] ?? ["codex", "priority-low"];
}

const text = fs.readFileSync(csvPath, "utf8");
const rows = parseCSV(text);
const header = rows[0];
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const findings = rows.slice(1).filter((r) => r.length > 1 && r[idx.title]);

console.log(`findings=${findings.length}`);

// Existing codex issues for dedupe.
let existing = [];
try {
  const out = sh("gh", ["issue", "list", "--search", "label:codex", "--state", "all", "--limit", "200", "--json", "number,title"]);
  existing = JSON.parse(out);
} catch (e) {
  console.error("warn: could not list existing issues, proceeding without dedupe");
}
const have = new Set(existing.map((i) => i.title.replace(/^\[codex\]\s*/i, "").trim().toLowerCase()));

const created = [];
const skipped = [];
for (const r of findings) {
  const title = r[idx.title].trim();
  const key = title.toLowerCase();
  const issueTitle = `[codex] ${title}`;
  if (have.has(key)) { skipped.push(title); continue; }
  const sev = r[idx.severity];
  const body = [
    `Codex Security finding triaged from CSV export (${path.basename(csvPath)}).`,
    ``,
    `- Finding: ${r[idx.finding_url]}`,
    `- Severity: ${sev} / Status: ${r[idx.status]}`,
    `- Commit: \`${r[idx.commit_hash]}\` (${r[idx.committed_at]})`,
    `- Relevant paths: \`${r[idx.relevant_paths]}\``,
    `- Detected: ${r[idx.detected_at]}`,
    ``,
    `## Description`,
    ``,
    r[idx.description],
    ``,
    `## Triage next step`,
    ``,
    `Verify against current \`main\`. If already fixed, close with the fixing commit. If accepted risk or false positive, close with rationale. Otherwise fix in a lane with a regression test.`,
  ].join("\n");
  const labels = labelsFor(sev, title);
  if (DRY) { console.log(`DRY ${issueTitle} [${labels.join(",")}]`); continue; }
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-issue-")), "body.md");
  fs.writeFileSync(tmp, body);
  try {
    const out = sh("gh", ["issue", "create", "--title", issueTitle, "--body-file", tmp, "--label", labels.join(",")]);
    created.push({ title: issueTitle, out: out.trim(), labels });
    console.log(`created: ${out.trim()} :: ${issueTitle}`);
  } catch (e) {
    console.error(`FAILED: ${issueTitle}\n${e.stderr ?? e.message}`);
  }
}
console.log(`done: created=${created.length} skipped=${skipped.length}`);
if (skipped.length) console.log("skipped:\n- " + skipped.join("\n- "));
