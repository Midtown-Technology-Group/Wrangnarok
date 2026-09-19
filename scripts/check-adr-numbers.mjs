// SPDX-License-Identifier: AGPL-3.0
// ADR number guard (issue #225): fail-closed uniqueness and ledger check.
// Usage: node scripts/check-adr-numbers.mjs [--check]   (validates docs/architecture)
//    or: node scripts/check-adr-numbers.mjs --selftest  (offline unit verification
//        with fixtures proving each failure mode is caught).
// Rules (see docs/architecture/adr-index.md):
// - every docs/architecture/NNN-*.md owns a unique three-digit number;
// - the file H1 must be `# ADR NNN: <title>` matching the filename prefix;
// - the index table must list every numbered file with matching number,
//   filename, and title, and declare Next free as max(number)+1.
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCH_DIR = join(root, "docs", "architecture");
const INDEX_PATH = join(ARCH_DIR, "adr-index.md");

function parseIndex(text) {
  const nextFree = text.match(/^Next free ADR number: (\d+)\.\s*$/m)?.[1] ?? null;
  const rows = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\| (\d{3}) \| ([^|]+?) \| ([^|]+?) \|$/);
    if (m) rows.push({ number: m[1], file: m[2].trim(), title: m[3].trim() });
  }
  return { nextFree, rows };
}

const SENTINEL = "000-steward-checklist.md";

function checkTree(dir, indexText, opts = {}) {
  const errors = [];
  // 000-* is reserved steward tooling (checklist), not an ADR. The sentinel
  // itself must exist: deleting or renaming it fails closed (issue #520).
  if (!opts.skipSentinel && !existsSync(join(dir, SENTINEL))) {
    errors.push(`missing ADR governance sentinel: ${SENTINEL} (see issue #520)`);
  }
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}-.+\.md$/.test(f) && !f.startsWith("000-"))
    .sort();
  const seen = new Map();
  const docs = [];
  for (const f of files) {
    const number = f.slice(0, 3);
    if (seen.has(number)) {
      errors.push(`duplicate ADR number ${number}: ${seen.get(number)} and ${f} (see issue #225)`);
    } else {
      seen.set(number, f);
    }
    const firstLine = (readFileSync(join(dir, f), "utf8").split("\n")[0] ?? "").trim();
    const m = firstLine.match(/^# ADR (\d{3}): (.+)$/);
    if (!m) {
      errors.push(`${f}: first line must be \`# ADR NNN: <title>\`, got: ${firstLine}`);
    } else {
      if (m[1] !== number) errors.push(`${f}: H1 number ADR ${m[1]} != filename prefix ${number}`);
      docs.push({ number, file: f, title: m[2].trim() });
    }
  }
  const { nextFree, rows } = parseIndex(indexText);
  if (rows.length === 0) errors.push(`${INDEX_PATH}: no index table rows parsed`);
  for (const d of docs) {
    const row = rows.find((r) => r.number === d.number && r.file === d.file);
    if (!row) {
      errors.push(`index: missing row for ${d.number} ${d.file}`);
    } else if (row.title !== d.title) {
      errors.push(
        `index: title drift for ${d.number} ${d.file}: index ${JSON.stringify(row.title)} != H1 ${JSON.stringify(d.title)}`,
      );
    }
  }
  for (const r of rows) {
    if (!docs.some((d) => d.number === r.number && d.file === r.file)) {
      errors.push(`index: stale row for ${r.number} ${r.file} (no such file)`);
    }
  }
  const dupRows = rows.map((r) => `${r.number}/${r.file}`).filter((k, i, a) => a.indexOf(k) !== i);
  for (const k of new Set(dupRows)) errors.push(`index: duplicate row ${k}`);
  if (nextFree === null) {
    errors.push("index: missing `Next free ADR number: NNN.` line");
  } else if (docs.length > 0) {
    const max = Math.max(...docs.map((d) => parseInt(d.number, 10)));
    if (parseInt(nextFree, 10) !== max + 1) {
      errors.push(`index: Next free ${nextFree} != max ADR ${String(max).padStart(3, "0")} + 1`);
    }
  }
  // Assigned ADR headings must live in numeric files (issue #520): a
  // TBD-*.md (or any other non-numeric doc) carrying `# ADR 012: ...`
  // fails closed. Digit-scoped, so `# ADR TBD:` and `# ADR index` H1s pass.
  const others = readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !/^\d{3}-.+\.md$/.test(f))
    .sort();
  for (const f of others) {
    const firstLine = (readFileSync(join(dir, f), "utf8").split("\n")[0] ?? "").trim();
    if (/^# ADR \d{3}(?::|\b)/.test(firstLine)) {
      errors.push(`assigned ADR uses a non-numeric filename: ${f} (see issue #520)`);
    }
  }
  return errors;
}

if (process.argv.includes("--selftest")) {
  // Offline fixtures: each case must produce (or not produce) errors.
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`check-adr-numbers selftest failed: ${name}`);
    passed += 1;
  };
  // Fixture dirs carry no sentinel file, so the pre-existing cases opt
  // out of the sentinel assertion (issue #520); dedicated fixtures below
  // exercise it with default options.
  const NO_SENTINEL = { skipSentinel: true };
  const fixture = (files, indexText, opts = NO_SENTINEL) => {
    const dir = mkdtempSync(join(tmpdir(), "adr-"));
    try {
      for (const [name, h1] of files) writeFileSync(join(dir, name), `${h1}\n\nbody\n`);
      return checkTree(dir, indexText, opts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const idx = (nextFree, rows) =>
    `Next free ADR number: ${nextFree}.\n\n| Number | File | Title |\n| --- | --- | --- |\n${rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join("\n")}\n`;
  const good = [
    ["015-form-binding.md", "# ADR 015: Forms"],
    ["034-org-lifecycle.md", "# ADR 034: Orgs"],
  ];
  check(
    "clean tree passes",
    fixture(
      good,
      idx("035", [
        ["015", "015-form-binding.md", "Forms"],
        ["034", "034-org-lifecycle.md", "Orgs"],
      ]),
    ).length === 0,
  );
  const dupe = fixture(
    [...good, ["015-org-lifecycle.md", "# ADR 015: Orgs"]],
    idx("035", [
      ["015", "015-form-binding.md", "Forms"],
      ["034", "034-org-lifecycle.md", "Orgs"],
    ]),
  );
  check(
    "duplicate number fails",
    dupe.some((e) => e.includes("duplicate ADR number 015")),
  );
  const h1 = fixture(
    [["034-org-lifecycle.md", "# ADR 015: Orgs"]],
    idx("035", [["034", "034-org-lifecycle.md", "Orgs"]]),
  );
  check(
    "H1/filename mismatch fails",
    h1.some((e) => e.includes("!= filename prefix")),
  );
  const missing = fixture(good, idx("035", [["015", "015-form-binding.md", "Forms"]]));
  check(
    "missing index row fails",
    missing.some((e) => e.includes("missing row")),
  );
  const stale = fixture(
    [good[0]],
    idx("035", [
      ["015", "015-form-binding.md", "Forms"],
      ["034", "034-org-lifecycle.md", "Orgs"],
    ]),
  );
  check(
    "stale index row fails",
    stale.some((e) => e.includes("stale row")),
  );
  const drift = fixture(
    good,
    idx("035", [
      ["015", "015-form-binding.md", "Forms!"],
      ["034", "034-org-lifecycle.md", "Orgs"],
    ]),
  );
  check(
    "title drift fails",
    drift.some((e) => e.includes("title drift")),
  );
  const next = fixture(
    good,
    idx("099", [
      ["015", "015-form-binding.md", "Forms"],
      ["034", "034-org-lifecycle.md", "Orgs"],
    ]),
  );
  check(
    "wrong next-free fails",
    next.some((e) => e.includes("Next free")),
  );
  const nonNumeric = fixture(
    [...good, ["TBD-sneaky.md", "# ADR 012: Sneaky"]],
    idx("035", [
      ["015", "015-form-binding.md", "Forms"],
      ["034", "034-org-lifecycle.md", "Orgs"],
    ]),
  );
  check(
    "numbered H1 in non-numeric file fails",
    nonNumeric.some((e) => e.includes("assigned ADR uses a non-numeric filename: TBD-sneaky.md")),
  );
  check(
    "TBD and index H1s pass",
    fixture(
      [
        ...good,
        ["TBD-future.md", "# ADR TBD: Future"],
        ["adr-index.md", "# ADR index and number ledger"],
        ["worker-authority-boundaries.md", "# ADR TBD: Split Workers by authority boundary"],
      ],
      idx("035", [
        ["015", "015-form-binding.md", "Forms"],
        ["034", "034-org-lifecycle.md", "Orgs"],
      ]),
    ).length === 0,
  );
  check(
    "missing sentinel fails",
    fixture(
      good,
      idx("035", [
        ["015", "015-form-binding.md", "Forms"],
        ["034", "034-org-lifecycle.md", "Orgs"],
      ]),
      {},
    ).some((e) => e.includes("missing ADR governance sentinel")),
  );
  check(
    "present sentinel passes",
    fixture(
      [...good, [SENTINEL, "# Steward checklist"]],
      idx("035", [
        ["015", "015-form-binding.md", "Forms"],
        ["034", "034-org-lifecycle.md", "Orgs"],
      ]),
      {},
    ).length === 0,
  );
  console.log(`check-adr-numbers selftest: ${passed} passed.`);
  process.exit(0);
}

const errors = checkTree(ARCH_DIR, readFileSync(INDEX_PATH, "utf8"));
if (errors.length > 0) {
  for (const e of errors) console.error(`adr-numbers: ${e}`);
  process.exit(1);
}
console.log("adr-numbers: clean (unique numbers, H1s match, index in sync).");
