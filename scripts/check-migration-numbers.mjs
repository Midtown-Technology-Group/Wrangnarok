// SPDX-License-Identifier: AGPL-3.0
// Migration number guard (issue #528): fail-closed reservation provenance
// and ledger↔filesystem bijection.
// Usage: node scripts/check-migration-numbers.mjs [--check] (validates
//        migrations/ against docs/migration-ledger.md plus merge-base
//        reservation provenance for newly added files)
//    or: node scripts/check-migration-numbers.mjs --selftest (offline unit
//        verification with fixtures proving each failure mode is caught).
// Rules (see docs/migration-ledger.md):
// - every migrations/NNNN_*.sql has exactly one Landed row (number+filename
//   match); every Reserved number has no migration file yet; no duplicates;
// - a newly added migration must consume a Reserved row that already existed
//   on merge-base/main for the same issue/lane (the consuming PR moves it to
//   Landed); unreserved, mismatched-owner, or already-consumed numbers fail;
// - narrow break-glass: an Overrides row (number + reason + steward sign-off)
//   in the head ledger. "Next free" prose is not an override.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(root, "migrations");
const LEDGER_PATH = join(root, "docs", "migration-ledger.md");

const LANDED_HEADING = "## Landed on main";
const RESERVED_HEADING = "## Reserved";
const OVERRIDES_HEADING = "## Overrides";

function parseLedger(text) {
  const landed = [];
  const reserved = [];
  const overrides = [];
  let section = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      if (line.startsWith(LANDED_HEADING)) section = "landed";
      else if (line.startsWith(RESERVED_HEADING)) section = "reserved";
      else if (line.startsWith(OVERRIDES_HEADING)) section = "overrides";
      else section = null;
      continue;
    }
    const cells = line.split("|").map((c) => c.trim());
    // cells: ["", number, c2, c3, c4, ""]
    if (cells.length !== 6 || !/^\d{4}$/.test(cells[1]) || !section) continue;
    const row = { number: cells[1], c2: cells[2], c3: cells[3], c4: cells[4] };
    if (section === "landed") landed.push({ number: row.number, file: row.c2, owner: row.c3, content: row.c4 });
    else if (section === "reserved") reserved.push({ number: row.number, lane: row.c2, issue: row.c3 });
    else overrides.push({ number: row.number, issue: row.c2, reason: row.c3, signoff: row.c4 });
  }
  return { landed, reserved, overrides };
}

function listMigrations(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function checkTree(dir, ledgerText) {
  const errors = [];
  const { landed, reserved } = parseLedger(ledgerText);
  const files = listMigrations(dir);
  for (const f of files) {
    if (!/^\d{4}_.+\.sql$/.test(f)) {
      errors.push(`migrations/${f}: filename must be NNNN_name.sql (see issue #528)`);
    }
  }
  const numbered = files.filter((f) => /^\d{4}_.+\.sql$/.test(f));
  const seen = new Map();
  for (const f of numbered) {
    const number = f.slice(0, 4);
    if (seen.has(number)) {
      errors.push(`duplicate migration number ${number}: ${seen.get(number)} and ${f} (see issue #528)`);
    } else {
      seen.set(number, f);
    }
    const rows = landed.filter((r) => r.number === number);
    if (rows.length === 0) {
      errors.push(`ledger: missing Landed row for ${f}`);
    } else if (rows.length > 1) {
      errors.push(`ledger: duplicate Landed rows for number ${number}`);
    } else if (rows[0].file !== f) {
      errors.push(`ledger: filename mismatch for ${number}: ledger ${rows[0].file} != file ${f}`);
    }
  }
  for (const r of reserved) {
    if (seen.has(r.number)) {
      errors.push(`ledger: Reserved number ${r.number} already has migration file ${seen.get(r.number)}`);
    }
  }
  const seenLanded = new Map();
  for (const r of landed) {
    const key = `${r.number}/${r.file}`;
    if (seenLanded.has(key)) {
      errors.push(`ledger: duplicate Landed row ${key}`);
    } else {
      seenLanded.set(key, true);
    }
  }
  return errors;
}

function ownershipMatches(baseReserved, headLanded) {
  const haystack = `${headLanded.owner} ${headLanded.content}`;
  const issueTokens = baseReserved.issue.match(/#\d+/g) ?? [];
  // Compare exact issue tokens, not substrings: "#90" must not match a
  // Landed row citing "#902" (issue #528 mismatched-owner rejection).
  if (issueTokens.length > 0) {
    const landedTokens = new Set(haystack.match(/#\d+/g) ?? []);
    return issueTokens.some((t) => landedTokens.has(t));
  }
  const lane = baseReserved.lane.trim();
  return lane.length > 0 && haystack.toLowerCase().includes(lane.toLowerCase());
}

function checkProvenance(addedFiles, baseLedgerText, headLedgerText) {
  const errors = [];
  const base = parseLedger(baseLedgerText);
  const head = parseLedger(headLedgerText);
  const added = addedFiles.map((f) => basename(f)).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  for (const f of added) {
    const number = f.slice(0, 4);
    const override = head.overrides.find((r) => r.number === number);
    if (override) {
      if (!override.reason || override.reason === "-" || !override.signoff || override.signoff === "-") {
        errors.push(`migration ${f}: Override row lacks reason or steward sign-off (see issue #528)`);
      }
      continue;
    }
    const baseRes = base.reserved.find((r) => r.number === number);
    if (!baseRes) {
      const baseLanded = base.landed.some((r) => r.number === number);
      errors.push(
        baseLanded
          ? `migration ${f}: number already consumed on merge-base/main (no Reserved row; see issue #528)`
          : `migration ${f}: unreserved number (no Reserved row on merge-base/main for this lane/issue; see issue #528)`,
      );
      continue;
    }
    const headLanded = head.landed.find((r) => r.number === number);
    if (!headLanded) {
      errors.push(`migration ${f}: reservation ${number} not moved to Landed in this PR (see issue #528)`);
    } else if (headLanded.file !== f) {
      errors.push(`migration ${f}: Landed row filename ${headLanded.file} != added file ${f}`);
    } else if (!ownershipMatches(baseRes, headLanded)) {
      errors.push(
        `migration ${f}: owner mismatch (Reserved on merge-base for ${baseRes.lane} ${baseRes.issue}; see issue #528)`,
      );
    }
  }
  return errors;
}

function branchAddedMigrations() {
  // Issue #373 pattern (see scripts/lane-scope.mjs): fail CLOSED when the
  // base ref is unavailable rather than reporting an unchecked tree clean.
  try {
    const out = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD", "--", "migrations/"], {
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((l) => l.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean);
  } catch {
    console.error(
      "check-migration-numbers: cannot diff origin/main...HEAD (missing base ref? run `git fetch origin main`).",
    );
    process.exit(2);
  }
}

function baseLedgerText() {
  try {
    return execFileSync("git", ["show", "origin/main:docs/migration-ledger.md"], { encoding: "utf8" });
  } catch {
    console.error(
      "check-migration-numbers: cannot read origin/main:docs/migration-ledger.md (run `git fetch origin main`).",
    );
    process.exit(2);
  }
}

if (process.argv.includes("--selftest")) {
  // Offline fixtures: each case must produce (or not produce) errors.
  let passed = 0;
  const check = (name, cond) => {
    if (!cond) throw new Error(`check-migration-numbers selftest failed: ${name}`);
    passed += 1;
  };
  const ledger = (landedRows, reservedRows, overrideRows = []) =>
    `${LANDED_HEADING}\n\n| Number | File | Owner | Content |\n| --- | --- | --- | --- |\n${landedRows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`).join("\n")}\n\n${RESERVED_HEADING}\n\n| Number | Lane | Issue | Planned content |\n| --- | --- | --- | --- |\n${reservedRows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`).join("\n")}\n\n${OVERRIDES_HEADING}\n\n| Number | Issue | Reason | Steward sign-off |\n| --- | --- | --- | --- |\n${overrideRows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`).join("\n")}\n`;
  // Fixtures exercise checkTree against a real temp dir, mirroring
  // check-adr-numbers.mjs.
  const fixtureTree = (files, ledgerText) => {
    const dir = mkdtempSync(join(tmpdir(), "mignum-"));
    try {
      for (const name of files) writeFileSync(join(dir, name), "-- ddl\n");
      return checkTree(dir, ledgerText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const landed = [["0042", "0042_widgets.sql", "WID-01", "widgets (issue #900)"]];
  const reserved = [["0043", "WID-01", "#901", "gadget table"]];
  check("clean tree passes", fixtureTree(["0042_widgets.sql"], ledger(landed, reserved)).length === 0);
  check(
    "file without Landed row fails",
    fixtureTree(["0042_widgets.sql", "0044_sneaky.sql"], ledger(landed, reserved)).some((e) =>
      e.includes("missing Landed row for 0044_sneaky.sql"),
    ),
  );
  check(
    "Reserved number with file present fails",
    fixtureTree(["0042_widgets.sql", "0043_gadgets.sql"], ledger(landed, reserved)).some((e) =>
      e.includes("Reserved number 0043 already has migration file"),
    ),
  );
  check(
    "duplicate numbers fail",
    fixtureTree(["0042_widgets.sql", "0042_other.sql"], ledger(landed, reserved)).some((e) =>
      e.includes("duplicate migration number 0042"),
    ),
  );
  check(
    "filename mismatch fails",
    fixtureTree(
      ["0042_renamed.sql"],
      ledger([["0042", "0042_widgets.sql", "WID-01", "widgets (issue #900)"]], reserved),
    ).some((e) => e.includes("filename mismatch for 0042")),
  );
  // Provenance fixtures: base ledger vs head ledger for added files.
  const baseLedger = ledger(landed, [...reserved, ["0044", "WID-01", "#902", "sprocket table"]]);
  const consumingHead = ledger(
    [...landed, ["0044", "0044_sprockets.sql", "WID-01", "sprockets (issue #902)"]],
    reserved,
  );
  check(
    "allowed reservation-consumption passes",
    checkProvenance(["migrations/0044_sprockets.sql"], baseLedger, consumingHead).length === 0,
  );
  check(
    "self-allocation fails",
    checkProvenance(["migrations/0045_rogue.sql"], baseLedger, consumingHead).some((e) =>
      e.includes("unreserved number"),
    ),
  );
  const thiefHead = ledger([...landed, ["0044", "0044_sprockets.sql", "OTHER-09", "sprockets (issue #999)"]], reserved);
  check(
    "owner mismatch fails",
    checkProvenance(["migrations/0044_sprockets.sql"], baseLedger, thiefHead).some((e) => e.includes("owner mismatch")),
  );
  const prefixBase = ledger(landed, [...reserved, ["0044", "WID-01", "#90", "sprocket table"]]);
  const prefixHead = ledger([...landed, ["0044", "0044_sprockets.sql", "WID-01", "sprockets (issue #902)"]], reserved);
  check(
    "issue-prefix mismatch fails (#90 reservation vs #902 landing)",
    checkProvenance(["migrations/0044_sprockets.sql"], prefixBase, prefixHead).some((e) =>
      e.includes("owner mismatch"),
    ),
  );
  const noMoveHead = ledger(landed, [...reserved, ["0044", "WID-01", "#902", "sprocket table"]]);
  check(
    "reservation not moved to Landed fails",
    checkProvenance(["migrations/0044_sprockets.sql"], baseLedger, noMoveHead).some((e) =>
      e.includes("not moved to Landed"),
    ),
  );
  const consumedBase = ledger([...landed, ["0046", "0046_old.sql", "WID-01", "old (issue #900)"]], reserved);
  check(
    "already-consumed number fails",
    checkProvenance(["migrations/0046_new.sql"], consumedBase, consumedBase).some((e) =>
      e.includes("already consumed"),
    ),
  );
  const glassHead = ledger(landed, reserved, [
    ["0047", "#903", "prod FK repair, no spare Reserved", "steward #528-signoff"],
  ]);
  check(
    "break-glass override passes",
    checkProvenance(["migrations/0047_repair.sql"], baseLedger, glassHead).length === 0,
  );
  const bareGlassHead = ledger(landed, reserved, [["0047", "#903", "-", "-"]]);
  check(
    "override without reason fails",
    checkProvenance(["migrations/0047_repair.sql"], baseLedger, bareGlassHead).some((e) =>
      e.includes("lacks reason or steward sign-off"),
    ),
  );
  console.log(`check-migration-numbers selftest: ${passed} passed.`);
  process.exit(0);
}

const treeErrors = checkTree(MIGRATIONS_DIR, readFileSync(LEDGER_PATH, "utf8"));
const headLedger = readFileSync(LEDGER_PATH, "utf8");
const provErrors = checkProvenance(branchAddedMigrations(), baseLedgerText(), headLedger);
const errors = [...treeErrors, ...provErrors];
if (errors.length > 0) {
  for (const e of errors) console.error(`migration-numbers: ${e}`);
  process.exit(1);
}
console.log("migration-numbers: clean (ledger bijection holds, added files consume reservations).");
