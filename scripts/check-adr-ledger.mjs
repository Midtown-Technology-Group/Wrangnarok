import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const architectureDir = path.join(root, "docs", "architecture");
const ledgerPath = path.join(root, "docs", "adr-ledger.md");
const sentinel = "000-steward-checklist.md";

const entries = await readdir(architectureDir, { withFileTypes: true });
const markdownFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();

if (!markdownFiles.includes(sentinel)) {
  throw new Error(`missing ADR governance sentinel: docs/architecture/${sentinel}`);
}

const numbered = markdownFiles.filter((name) => /^\d{3}-.+\.md$/.test(name) && name !== sentinel);
const errors = [];
const byNumber = new Map();
const ledger = await readFile(ledgerPath, "utf8");

for (const name of numbered) {
  const number = name.slice(0, 3);
  const fullPath = path.join(architectureDir, name);
  const text = await readFile(fullPath, "utf8");
  const firstLine = text.split(/\r?\n/, 1)[0];

  const prior = byNumber.get(number);
  if (prior) {
    errors.push(`duplicate ADR ${number}: ${prior}, ${name}`);
  } else {
    byNumber.set(number, name);
  }

  if (!new RegExp(`^# ADR ${number}(?::|\\b)`).test(firstLine)) {
    errors.push(`ADR filename/header mismatch: ${name} starts with ${JSON.stringify(firstLine)}`);
  }

  const canonicalPath = `docs/architecture/${name}`;
  const escapedPath = canonicalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reservation = new RegExp(`^\\| ${number} \\| \`${escapedPath}\` \\|$`, "m");
  if (!reservation.test(ledger)) {
    errors.push(`ADR ${number} (${canonicalPath}) is not reserved exactly once in docs/adr-ledger.md`);
  }
}

for (const name of markdownFiles.filter((name) => !/^\d{3}-.+\.md$/.test(name))) {
  const text = await readFile(path.join(architectureDir, name), "utf8");
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (/^# ADR \d{3}(?::|\b)/.test(firstLine)) {
    errors.push(`assigned ADR uses a non-numeric filename: ${name} (${firstLine})`);
  }
}

const ledgerRows = [...ledger.matchAll(/^\| (\d{3}) \| `docs\/architecture\/([^`]+)` \|$/gm)];
const ledgerNumbers = new Set();
for (const match of ledgerRows) {
  const [, number, name] = match;
  if (number === "000") {
    errors.push("ADR 000 is reserved for the steward sentinel and must not appear in the ADR reservation table");
  }
  if (ledgerNumbers.has(number)) {
    errors.push(`duplicate reservation for ADR ${number} in docs/adr-ledger.md`);
  }
  ledgerNumbers.add(number);
  const actual = byNumber.get(number);
  if (!actual) {
    errors.push(`ledger reserves ADR ${number} for ${name}, but no numbered architecture file exists`);
  } else if (actual !== name) {
    errors.push(`ledger/file mismatch for ADR ${number}: ledger=${name}, file=${actual}`);
  }
}

if (ledgerRows.length !== numbered.length) {
  errors.push(`ledger/file count mismatch: ${ledgerRows.length} reservations, ${numbered.length} numbered ADR files`);
}

if (errors.length > 0) {
  console.error("ADR ledger validation failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `ADR ledger valid: ${numbered.length} numbered ADRs, all unique and reserved; ${sentinel} is the control sentinel.`,
);
