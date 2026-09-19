// SPDX-License-Identifier: AGPL-3.0
// Local-only baseline validator for the account posture slice (issue #252).
// Plain-node helper (no prod runtime, no Saga logic): structural check of
// docs/posture/baseline.json plus expiry warnings for suppressions. It
// mirrors parsePostureBaseline in src/domain.ts element-for-element — the
// submit path re-validates through the real parser, so a drift between the
// two is a bug: keep the known-ID list, the UTC format, and the field sets
// identical in both places.
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

const TOP_LEVEL_FIELDS = new Set([
  "recordedAt",
  "acknowledgedCriticalIds",
  "suppressions",
  "zoneExpectations",
  "version",
  "note",
]);

const EXPECTATION_FIELDS = new Set([
  "ssl",
  "minTlsVersionMin",
  "alwaysUseHttps",
  "automaticHttpsRewrites",
  "securityHeaderEnabled",
]);

// Same strict UTC instant as parseIsoString in src/domain.ts: suppression
// expiry compares lexicographically against toISOString output.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "docs", "posture", "baseline.json");

const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value, bound) {
  return typeof value === "string" && value.length > 0 && value.length <= bound;
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`baseline unreadable: ${file}: ${error.message}`);
  process.exit(1);
}

if (!isRecord(baseline)) {
  fail("baseline must be a JSON object");
} else {
  for (const key of Object.keys(baseline)) {
    if (!TOP_LEVEL_FIELDS.has(key)) fail(`unknown top-level field "${key}"`);
  }
  if (baseline.version !== 1) fail("version must be 1");
  if (baseline.recordedAt !== null && baseline.recordedAt !== undefined) {
    if (typeof baseline.recordedAt !== "string" || !ISO_UTC.test(baseline.recordedAt)) {
      fail("recordedAt must be null or an ISO-8601 UTC timestamp ending in Z");
    }
  }
  const acknowledged = baseline.acknowledgedCriticalIds ?? [];
  if (!Array.isArray(acknowledged) || acknowledged.length > 200) {
    fail("acknowledgedCriticalIds must be a list of at most 200 IDs");
  } else {
    for (const id of acknowledged) {
      if (!isNonEmptyString(id, 128)) fail("acknowledgedCriticalIds must hold non-empty strings up to 128 characters");
    }
  }
  const suppressions = baseline.suppressions ?? [];
  if (!Array.isArray(suppressions)) {
    fail("suppressions must be a list");
  } else {
    if (suppressions.length > 100) fail("suppressions must hold at most 100 entries");
    const now = new Date().toISOString().slice(0, 10);
    for (const [index, row] of suppressions.entries()) {
      const where = `suppressions[${index}]`;
      if (!isRecord(row)) {
        fail(`${where} must be an object`);
        continue;
      }
      for (const key of Object.keys(row)) {
        if (!["checkId", "reason", "reviewer", "expiresAt"].includes(key)) fail(`${where} has unknown field "${key}"`);
      }
      if (typeof row.checkId !== "string" || row.checkId.length === 0 || row.checkId.length > 64) {
        fail(`${where}.checkId must be a non-empty string up to 64 characters`);
      } else if (!KNOWN_CHECK_IDS.has(row.checkId)) {
        fail(`${where}.checkId "${row.checkId}" is not a known check`);
      }
      if (!isNonEmptyString(row.reason, 300)) fail(`${where}.reason must be a non-empty string up to 300 characters`);
      if (!isNonEmptyString(row.reviewer, 128)) {
        fail(`${where}.reviewer must be a non-empty string up to 128 characters`);
      }
      if (typeof row.expiresAt !== "string" || !ISO_UTC.test(row.expiresAt)) {
        fail(`${where}.expiresAt must be an ISO-8601 UTC timestamp ending in Z`);
      } else if (row.expiresAt <= now) {
        warnings.push(`${where} (${row.checkId}) expired at ${row.expiresAt}; it no longer suppresses`);
      } else {
        const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        if (row.expiresAt <= horizon) warnings.push(`${where} (${row.checkId}) expires soon: ${row.expiresAt}`);
      }
    }
  }
  const expectations = baseline.zoneExpectations ?? {};
  if (!isRecord(expectations)) {
    fail("zoneExpectations must be an object");
  } else {
    for (const key of Object.keys(expectations)) {
      if (!EXPECTATION_FIELDS.has(key)) fail(`zoneExpectations has unknown field "${key}"`);
    }
    if (expectations.ssl !== undefined) {
      if (!Array.isArray(expectations.ssl) || expectations.ssl.length === 0 || expectations.ssl.length > 8) {
        fail("zoneExpectations.ssl must be a non-empty list of at most 8 values when present");
      } else {
        for (const value of expectations.ssl) {
          if (!isNonEmptyString(value, 32))
            fail("zoneExpectations.ssl must hold non-empty strings up to 32 characters");
        }
      }
    }
    for (const field of ["minTlsVersionMin", "alwaysUseHttps", "automaticHttpsRewrites"]) {
      if (expectations[field] !== undefined && !isNonEmptyString(expectations[field], 16)) {
        fail(`zoneExpectations.${field} must be a non-empty string up to 16 characters when present`);
      }
    }
    if (expectations.securityHeaderEnabled !== undefined && typeof expectations.securityHeaderEnabled !== "boolean") {
      fail("zoneExpectations.securityHeaderEnabled must be a boolean when present");
    }
  }
}

for (const warning of warnings) console.log(`warning: ${warning}`);
if (failures.length > 0) {
  for (const message of failures) console.error(`error: ${message}`);
  process.exit(1);
}
if (baseline.recordedAt === null || baseline.recordedAt === undefined) {
  console.log("baseline is unrecorded (recordedAt null): posture verdicts stay advisory.");
} else {
  console.log(`baseline recorded at ${baseline.recordedAt}.`);
}
