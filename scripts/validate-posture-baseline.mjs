// SPDX-License-Identifier: AGPL-3.0
// Local-only baseline validator for the account posture slice (issue #252).
// Plain-node helper (no prod runtime, no Saga logic): structural check of
// docs/posture/baseline.json plus expiry warnings for suppressions. The
// authoritative gate is parsePostureBaseline in src/domain.ts, which
// re-validates the same shape at submit time — the known-ID list below must
// match POSTURE_CHECK_IDS + POSTURE_MANUAL_IDS there.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN_CHECK_IDS = new Set([
  "token-active",
  "zone-hygiene",
  "zone-setting-ssl",
  "zone-setting-min_tls_version",
  "zone-setting-always_use_https",
  "zone-setting-automatic_https_rewrites",
  "zone-setting-security_header",
  "insights-no-unresolved-critical",
  "audit-visibility",
  "global-api-key-non-use",
  "token-least-privilege",
  "env-binding-separation",
  "membership-staleness-review",
  "dns-origin-exposure-review",
]);

const EXPECTATION_FIELDS = new Set([
  "ssl",
  "minTlsVersionMin",
  "alwaysUseHttps",
  "automaticHttpsRewrites",
  "securityHeaderEnabled",
]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "docs", "posture", "baseline.json");

const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`baseline unreadable: ${file}: ${error.message}`);
  process.exit(1);
}

if (!isRecord(baseline)) fail("baseline must be a JSON object");
else {
  if (baseline.version !== 1) fail("version must be 1");
  if (baseline.recordedAt !== null && (typeof baseline.recordedAt !== "string" || baseline.recordedAt.length === 0)) {
    fail("recordedAt must be null or a non-empty ISO date string");
  }
  if (!Array.isArray(baseline.acknowledgedCriticalIds)) fail("acknowledgedCriticalIds must be a list");
  if (!Array.isArray(baseline.suppressions)) {
    fail("suppressions must be a list");
  } else {
    if (baseline.suppressions.length > 100) fail("suppressions must hold at most 100 entries");
    const now = new Date().toISOString().slice(0, 10);
    for (const [index, row] of baseline.suppressions.entries()) {
      const where = `suppressions[${index}]`;
      if (!isRecord(row)) {
        fail(`${where} must be an object`);
        continue;
      }
      for (const key of Object.keys(row)) {
        if (!["checkId", "reason", "reviewer", "expiresAt"].includes(key)) fail(`${where} has unknown field "${key}"`);
      }
      if (typeof row.checkId !== "string" || row.checkId.length === 0) fail(`${where}.checkId must be non-empty`);
      else if (!KNOWN_CHECK_IDS.has(row.checkId)) fail(`${where}.checkId "${row.checkId}" is not a known check`);
      for (const field of ["reason", "reviewer", "expiresAt"]) {
        if (typeof row[field] !== "string" || row[field].length === 0) fail(`${where}.${field} must be non-empty`);
      }
      if (typeof row.expiresAt === "string") {
        if (row.expiresAt <= now)
          warnings.push(`${where} (${row.checkId}) expired at ${row.expiresAt}; it no longer suppresses`);
        else {
          const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (row.expiresAt <= horizon) warnings.push(`${where} (${row.checkId}) expires soon: ${row.expiresAt}`);
        }
      }
    }
  }
  const expectations = baseline.zoneExpectations;
  if (!isRecord(expectations)) {
    fail("zoneExpectations must be an object");
  } else {
    for (const key of Object.keys(expectations)) {
      if (!EXPECTATION_FIELDS.has(key)) fail(`zoneExpectations has unknown field "${key}"`);
    }
    if (expectations.ssl !== undefined && (!Array.isArray(expectations.ssl) || expectations.ssl.length === 0)) {
      fail("zoneExpectations.ssl must be a non-empty list when present");
    }
  }
}

for (const warning of warnings) console.log(`warning: ${warning}`);
if (failures.length > 0) {
  for (const message of failures) console.error(`error: ${message}`);
  process.exit(1);
}
if (baseline.recordedAt === null) {
  console.log("baseline is unrecorded (recordedAt null): posture verdicts stay advisory.");
} else {
  console.log(`baseline recorded at ${baseline.recordedAt}.`);
}
