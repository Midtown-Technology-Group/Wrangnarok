// SPDX-License-Identifier: AGPL-3.0
// Parity ledger guard (issue #132 repair): fail-closed table/detail/owner agreement.
// Usage: node scripts/check-parity-ledger.mjs [--check]   (validates docs/upstream-parity.md)
//    or: node scripts/check-parity-ledger.mjs --selftest  (offline unit verification
//        with fixtures proving each failure mode is caught).
// Rules (see docs/upstream-parity.md):
// - the top capability table is the single current-state authority;
// - the headline `Total: ...` line must recompute from the table rows;
// - every table ID must own a `## ID:` detail section whose `Phase …;
//   **Status**` base token (Implemented/Complete/Partial/Missing/Gated)
//   and existing-issue reference (#NNN or new) agree with the table row;
// - rows reconciled by the #132 repair must point at their canonical owner
//   (OWNERS below); extend the map as further owners are verified via gh.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_PATH = join(root, "docs", "upstream-parity.md");

const STATUSES = ["Implemented", "Complete", "Partial", "Missing", "Gated"];

// Canonical owners verified via `gh issue view` during the #132 repair.
// Only reconciled rows are pinned: every other row just needs table/detail
// agreement (a bare `new` must match a bare `new`).
const OWNERS = {
  "RUN-01": "135",
  "RUN-02": "136",
  "TRG-01": "137",
  "TRG-02": "138",
  "TRG-03": "139",
  "TOOL-01": "170",
  "OPS-02": "173",
  "MIG-02": "119",
};

function baseStatus(cell) {
  const m = cell.trim().match(/^(Implemented|Complete|Partial|Missing|Gated)\b/);
  return m ? m[1] : null;
}

function issueRef(cell) {
  const t = cell.trim();
  const m = t.match(/#(\d+)/);
  if (m) return m[1];
  if (/^new$/i.test(t)) return "new";
  return null;
}

function parseTable(text) {
  const rows = [];
  const errors = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\| ([A-Z]+-\d+) \| ([^|]*?) \| ([^|]*?) \| ([^|]*?) \| ([^|]*?) \| ([^|]*?) \|$/);
    if (!m) continue;
    const [, id, , , statusCell, , issueCell] = m;
    const status = baseStatus(statusCell);
    if (!status) errors.push(`table: ${id} has unparseable status cell ${JSON.stringify(statusCell)}`);
    const issue = issueRef(issueCell);
    if (!issue) errors.push(`table: ${id} has unparseable existing-issue cell ${JSON.stringify(issueCell)}`);
    rows.push({ id, status, issue });
  }
  return { rows, errors };
}

function parseDetails(text) {
  const sections = new Map();
  const errors = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## ([A-Z]+-\d+):/);
    if (!m) continue;
    const id = m[1];
    if (sections.has(id)) {
      errors.push(`detail: duplicate section for ${id}`);
      continue;
    }
    let status = null;
    let issue = null;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) {
      if (status === null) {
        const sm = lines[j].match(/\*\*(Implemented|Complete|Partial|Missing|Gated)\b[^*]*\*\*/);
        if (sm) status = sm[1];
      }
      if (issue === null) {
        const im = lines[j].match(/existing issue:\s*(#(\d+)|new)/i);
        if (im) issue = im[2] ?? "new";
      }
      if (status !== null && issue !== null) break;
    }
    if (status === null) errors.push(`detail: ${id} has no \`Phase …; **Status**\` heading`);
    if (issue === null) errors.push(`detail: ${id} has no existing-issue reference`);
    sections.set(id, { status, issue });
  }
  return { sections, errors };
}

function parseHeadline(text) {
  const m = text.match(/^Total:\s*(\d+) capability rows\s*—\s*(.+)\.\s*$/m);
  if (!m) return { total: null, counts: null, errors: ["headline: missing `Total: N capability rows — ….` line"] };
  const total = parseInt(m[1], 10);
  const counts = {};
  const errors = [];
  for (const s of STATUSES) {
    const cm = m[2].match(new RegExp(`(\\d+)\\s+${s}\\b`));
    if (!cm) errors.push(`headline: missing count for ${s}`);
    else counts[s] = parseInt(cm[1], 10);
  }
  return { total, counts, errors };
}

function checkTree(ledgerText) {
  const errors = [];
  const { rows, errors: tableErrors } = parseTable(ledgerText);
  errors.push(...tableErrors);
  const { sections, errors: detailErrors } = parseDetails(ledgerText);
  errors.push(...detailErrors);

  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.id)) errors.push(`table: duplicate row for ${r.id}`);
    else seen.set(r.id, r);
  }

  for (const r of rows) {
    const d = sections.get(r.id);
    if (!d) {
      errors.push(`ledger: table row ${r.id} has no \`## ${r.id}:\` detail section`);
      continue;
    }
    if (r.status && d.status && r.status !== d.status) {
      errors.push(
        `ledger: ${r.id} status drift: table ${r.status} != detail ${d.status} (table is authoritative — reconcile the detail)`,
      );
    }
    if (r.issue && d.issue && r.issue !== d.issue) {
      errors.push(
        `ledger: ${r.id} owner drift: table ${r.issue === "new" ? "new" : "#" + r.issue} != detail ${d.issue === "new" ? "new" : "#" + d.issue} (table is authoritative — reconcile the detail)`,
      );
    }
    const owner = OWNERS[r.id];
    if (owner && r.issue !== owner) {
      errors.push(`ledger: ${r.id} must point at canonical owner #${owner} (see issue #132)`);
    }
  }
  for (const id of sections.keys()) {
    if (!seen.has(id)) errors.push(`ledger: detail section \`## ${id}:\` has no table row (stale section)`);
  }

  const { total, counts, errors: headlineErrors } = parseHeadline(ledgerText);
  errors.push(...headlineErrors);
  if (total !== null && counts !== null && headlineErrors.length === 0) {
    const actual = {};
    for (const s of STATUSES) actual[s] = 0;
    for (const r of rows) {
      if (r.status) actual[r.status] += 1;
    }
    if (total !== rows.length) {
      errors.push(`headline: Total ${total} != ${rows.length} table rows`);
    }
    for (const s of STATUSES) {
      if (counts[s] !== undefined && counts[s] !== actual[s]) {
        errors.push(`headline: ${s} ${counts[s]} != recomputed ${actual[s]} from table`);
      }
    }
  }
  return errors;
}

if (process.argv.includes("--selftest")) {
  // Offline fixtures: each case must produce (or not produce) errors.
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`check-parity-ledger selftest failed: ${name}`);
    passed += 1;
  };
  const ledger = (headline, rows, details) =>
    `# Upstream parity map\n\n${headline}\n\n${rows.join("\n")}\n\n${details.join("\n\n")}\n\n## Checkpoint outcomes\n\nSlot only.\n`;
  const row = (id, status, issue) => `| ${id} | Title ${id} | 2 | ${status} | — | ${issue} |`;
  const detail = (id, status, issue) =>
    `## ${id}: Title ${id}\n\nPhase 2; **${status}**; existing issue: ${issue}\n\nLocal status: prose.`;
  const goodHeadline = "Total: 2 capability rows — 1 Implemented, 0 Complete, 1 Partial, 0 Missing, 0 Gated.";
  const good = ledger(
    goodHeadline,
    [row("RUN-01", "Implemented", "#135"), row("RUN-02", "Partial", "#136")],
    [detail("RUN-01", "Implemented", "#135"), detail("RUN-02", "Partial", "#136")],
  );
  check("clean ledger passes", checkTree(good).length === 0);
  check(
    "headline drift fails",
    checkTree(
      ledger(
        "Total: 2 capability rows — 2 Implemented, 0 Complete, 0 Partial, 0 Missing, 0 Gated.",
        [row("RUN-01", "Implemented", "#135"), row("RUN-02", "Partial", "#136")],
        [detail("RUN-01", "Implemented", "#135"), detail("RUN-02", "Partial", "#136")],
      ),
    ).some((e) => e.includes("recomputed")),
  );
  check(
    "table/detail status drift fails",
    checkTree(
      ledger(
        goodHeadline,
        [row("RUN-01", "Implemented", "#135"), row("RUN-02", "Partial", "#136")],
        [detail("RUN-01", "Implemented", "#135"), detail("RUN-02", "Missing", "#136")],
      ),
    ).some((e) => e.includes("status drift")),
  );
  check(
    "table/detail owner drift fails",
    checkTree(
      ledger(
        goodHeadline,
        [row("RUN-01", "Implemented", "#135"), row("RUN-02", "Partial", "new")],
        [detail("RUN-01", "Implemented", "#135"), detail("RUN-02", "Partial", "#136")],
      ),
    ).some((e) => e.includes("owner drift")),
  );
  check(
    "wrong canonical owner fails",
    checkTree(
      ledger(
        goodHeadline,
        [row("RUN-01", "Implemented", "#135"), row("RUN-02", "Partial", "#999")],
        [detail("RUN-01", "Implemented", "#135"), detail("RUN-02", "Partial", "#999")],
      ),
    ).some((e) => e.includes("canonical owner")),
  );
  check(
    "missing detail section fails",
    checkTree(
      ledger(
        goodHeadline,
        [row("RUN-01", "Implemented", "#135"), row("RUN-02", "Partial", "#136")],
        [detail("RUN-01", "Implemented", "#135")],
      ),
    ).some((e) => e.includes("has no `## RUN-02:`")),
  );
  check(
    "stale detail section fails",
    checkTree(
      ledger(
        goodHeadline,
        [row("RUN-01", "Implemented", "#135"), row("RUN-02", "Partial", "#136")],
        [
          detail("RUN-01", "Implemented", "#135"),
          detail("RUN-02", "Partial", "#136"),
          detail("TOOL-01", "Partial", "#170"),
        ],
      ),
    ).some((e) => e.includes("stale section")),
  );
  check(
    "table/detail parenthetical agreement passes",
    checkTree(
      ledger(
        goodHeadline,
        [row("RUN-01", "Implemented (see detail; #135 reopened)", "#135"), row("RUN-02", "Partial", "#136")],
        [detail("RUN-01", "Implemented (with follow-through)", "#135"), detail("RUN-02", "Partial", "#136")],
      ),
    ).length === 0,
  );
  console.log(`check-parity-ledger selftest: ${passed} passed.`);
  process.exit(0);
}

const errors = checkTree(readFileSync(LEDGER_PATH, "utf8"));
if (errors.length > 0) {
  for (const e of errors) console.error(`parity-ledger: ${e}`);
  process.exit(1);
}
console.log("parity-ledger: clean (headline recomputed, table/detail agree, owners canonical).");
