// SPDX-License-Identifier: AGPL-3.0
// Account posture slice (issue #252): focused coverage for the three
// read-only posture Sagas. Pure shaping/classification/verdict logic is
// pinned directly; Integration Actions run with mocked vendor fetch (the
// only token in play is the test sentinel); one workerd replay proves the
// Audit Logs Saga persists its shaped summary through the standard
// submit/ExecutionHistory path. No live Cloudflare calls, ever.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_INTEGRATION_ID,
  attributeAuditActor,
  classifyAuditEvent,
  cloudflareAuditSaga,
  cloudflareInsightsSaga,
  cloudflarePostureSaga,
  evaluateInsightsVerdict,
  evaluatePostureChecks,
  executionId,
  normalizeInsightSeverity,
  parseCloudflareAuditInput,
  parseCloudflareInsightsInput,
  parseCloudflarePostureInput,
  parsePostureBaseline,
  postureBoundedText,
  postureManualControls,
  suppressionActive,
  tlsVersionAtLeast,
} from "../src/domain";
import { listAuditLogs, listSecurityInsights, readZoneSettings } from "../src/integrations/cloudflare";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN_SENTINEL = "test-cloudflare-token-sentinel";
const ACCOUNT = { id: "0123456789abcdef0123456789abcdef", name: "Example MSP" };
const CONNECTION = { endpoint: CLOUDFLARE_API_BASE };
const SECRETS = { apiToken: TOKEN_SENTINEL };

function mockJson(payload: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(payload, { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyAuditEvent", () => {
  it("prioritizes token over membership over zone-config", () => {
    expect(classifyAuditEvent({ actionType: "tokens.create", resourceType: "zone" })).toBe("token");
    expect(classifyAuditEvent({ actionType: "members.add", resourceType: "zone" })).toBe("membership");
    expect(classifyAuditEvent({ actionType: "edit", resourceType: "zone", resourceProduct: "ssl" })).toBe(
      "zone-config",
    );
    expect(classifyAuditEvent({ actionType: "login", resourceType: "session" })).toBe("other");
  });
  it("never drops unknown shapes", () => {
    expect(classifyAuditEvent({})).toBe("other");
    expect(classifyAuditEvent({ actionType: 42, resourceType: null })).toBe("other");
  });
});

describe("attributeAuditActor", () => {
  it("distinguishes service credentials from humans", () => {
    expect(attributeAuditActor({ type: "user", email: "op@example.com" })).toBe("human");
    expect(attributeAuditActor({ type: "user", tokenName: "deploy-token" })).toBe("service");
    expect(attributeAuditActor({ type: "api_token", tokenId: "abc" })).toBe("service");
    expect(attributeAuditActor({ type: "system" })).toBe("service");
  });
  it("answers unknown instead of guessing human", () => {
    expect(attributeAuditActor({})).toBe("unknown");
    expect(attributeAuditActor({ type: "mystery" })).toBe("unknown");
  });
});

describe("insights verdict", () => {
  it("keeps unknown severities out of every known bucket", () => {
    expect(normalizeInsightSeverity("CRITICAL")).toBe("critical");
    expect(normalizeInsightSeverity("paid-only-future")).toBe("unknown");
    expect(normalizeInsightSeverity(null)).toBe("unknown");
  });
  it("stays advisory until a baseline is recorded", () => {
    expect(evaluateInsightsVerdict(["c1"], undefined).verdict).toBe("advisory");
    expect(
      evaluateInsightsVerdict(["c1"], {
        recordedAt: null,
        acknowledgedCriticalIds: [],
        suppressions: [],
        zoneExpectations: {
          ssl: ["strict"],
          minTlsVersionMin: "1.2",
          alwaysUseHttps: "on",
          automaticHttpsRewrites: "on",
          securityHeaderEnabled: true,
        },
      }).verdict,
    ).toBe("advisory");
  });
  it("fails only on new unacknowledged Criticals after a baseline", () => {
    const baseline = {
      recordedAt: "2026-09-19T00:00:00Z",
      acknowledgedCriticalIds: ["known-1"],
      suppressions: [],
      zoneExpectations: {
        ssl: ["strict"],
        minTlsVersionMin: "1.2",
        alwaysUseHttps: "on",
        automaticHttpsRewrites: "on",
        securityHeaderEnabled: true,
      },
    };
    expect(evaluateInsightsVerdict(["known-1"], baseline)).toMatchObject({ verdict: "advisory", newCriticalIds: [] });
    expect(evaluateInsightsVerdict(["known-1", "new-9"], baseline)).toMatchObject({
      verdict: "failing",
      newCriticalIds: ["new-9"],
    });
  });
});

describe("parsePostureBaseline", () => {
  const valid = {
    recordedAt: null,
    acknowledgedCriticalIds: [],
    suppressions: [],
    zoneExpectations: {},
  };
  it("accepts the unrecorded starting baseline with defaults", () => {
    const parsed = parsePostureBaseline(valid);
    expect(parsed.recordedAt).toBeNull();
    expect(parsed.zoneExpectations).toMatchObject({ ssl: ["strict"], minTlsVersionMin: "1.2" });
  });
  it("fails closed on unknown suppression check IDs", () => {
    expect(() =>
      parsePostureBaseline({
        ...valid,
        suppressions: [{ checkId: "typo-check", reason: "x", reviewer: "y", expiresAt: "2027-01-01T00:00:00Z" }],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("fails closed on unknown top-level and suppression fields", () => {
    expect(() => parsePostureBaseline({ ...valid, extra: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() =>
      parsePostureBaseline({
        ...valid,
        suppressions: [
          { checkId: "token-active", reason: "x", reviewer: "y", expiresAt: "2027-01-01T00:00:00Z", extra: 1 },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("ignores expired suppressions", () => {
    const parsed = parsePostureBaseline({
      ...valid,
      suppressions: [
        { checkId: "token-active", reason: "old", reviewer: "steward", expiresAt: "2020-01-01T00:00:00Z" },
      ],
    });
    expect(suppressionActive(parsed.suppressions, "token-active", "2026-09-19T00:00:00Z")).toBeNull();
    expect(
      suppressionActive(
        [{ checkId: "token-active", reason: "ok", reviewer: "steward", expiresAt: "2027-01-01T00:00:00Z" }],
        "token-active",
        "2026-09-19T00:00:00Z",
      ),
    ).toMatchObject({ reviewer: "steward" });
  });
});

describe("tlsVersionAtLeast", () => {
  it("compares numerically, not lexicographically", () => {
    expect(tlsVersionAtLeast("1.2", "1.2")).toBe(true);
    expect(tlsVersionAtLeast("1.3", "1.2")).toBe(true);
    expect(tlsVersionAtLeast("1.10", "1.2")).toBe(true);
    expect(tlsVersionAtLeast("1.0", "1.2")).toBe(false);
    expect(tlsVersionAtLeast("flexible", "1.2")).toBe(false);
  });
});

describe("evaluatePostureChecks", () => {
  const base = {
    verifyStatus: "healthy" as const,
    zoneCount: 2,
    pausedZones: 0,
    developmentModeActive: 0,
    checkedZoneIds: ["z1"],
    settingEvidence: [{ setting: "ssl", zoneId: "z1", ok: true, valueJson: '"strict"', valueText: "strict" }],
    checkedSettings: ["ssl"],
    baseline: undefined,
    nowIso: "2026-09-19T00:00:00Z",
  };
  it("passes clean posture as advisory", () => {
    const { verdict, checks } = evaluatePostureChecks(base);
    expect(verdict).toBe("advisory");
    expect(checks.find((check) => check.id === "token-active")?.status).toBe("pass");
    expect(checks.find((check) => check.id === "zone-setting-ssl")?.status).toBe("pass");
    expect(checks.filter((check) => check.status === "deferred")).toHaveLength(2);
  });
  it("fails closed on development mode and unhealthy tokens", () => {
    const { verdict, checks } = evaluatePostureChecks({ ...base, developmentModeActive: 1, verifyStatus: "unhealthy" });
    expect(verdict).toBe("failing");
    expect(checks.find((check) => check.id === "zone-hygiene")?.status).toBe("fail");
    expect(checks.find((check) => check.id === "token-active")?.status).toBe("fail");
  });
  it("degrades unreadable settings to unknown, not failure", () => {
    const { verdict, checks } = evaluatePostureChecks({ ...base, checkedZoneIds: [], settingEvidence: [] });
    expect(checks.find((check) => check.id === "zone-setting-ssl")?.status).toBe("unknown");
    expect(verdict).toBe("advisory");
  });
  it("applies active suppressions and records them", () => {
    const { verdict, checks } = evaluatePostureChecks({
      ...base,
      developmentModeActive: 3,
      baseline: {
        recordedAt: "2026-09-19T00:00:00Z",
        acknowledgedCriticalIds: [],
        suppressions: [
          {
            checkId: "zone-hygiene",
            reason: "load-test window",
            reviewer: "steward",
            expiresAt: "2027-01-01T00:00:00Z",
          },
        ],
        zoneExpectations: {
          ssl: ["strict"],
          minTlsVersionMin: "1.2",
          alwaysUseHttps: "on",
          automaticHttpsRewrites: "on",
          securityHeaderEnabled: true,
        },
      },
    });
    expect(checks.find((check) => check.id === "zone-hygiene")).toMatchObject({ status: "pass", suppressed: true });
    expect(verdict).toBe("advisory");
  });
  it("lists honestly-manual controls that never fail", () => {
    const manual = postureManualControls(undefined, "2026-09-19T00:00:00Z");
    expect(manual.map((check) => check.id)).toContain("global-api-key-non-use");
    for (const check of manual) expect(check.status).toBe("manual");
  });
});

describe("posture classifier and parser arms", () => {
  it("matches every keyword family", () => {
    expect(classifyAuditEvent({ actionType: "api_key.regenerate" })).toBe("token");
    expect(classifyAuditEvent({ actionType: "apikey.delete" })).toBe("token");
    expect(classifyAuditEvent({ actionType: "secret.rotate" })).toBe("token");
    expect(classifyAuditEvent({ actionType: "invites.send" })).toBe("membership");
    expect(classifyAuditEvent({ actionType: "roles.update" })).toBe("membership");
    expect(classifyAuditEvent({ actionType: "permissions.grant" })).toBe("membership");
    expect(classifyAuditEvent({ resourceType: "dns_record" })).toBe("zone-config");
    expect(classifyAuditEvent({ resourceType: "tls_config" })).toBe("zone-config");
    expect(classifyAuditEvent({ resourceType: "firewall_rule" })).toBe("zone-config");
    expect(classifyAuditEvent({ actionType: "waf.deploy" })).toBe("zone-config");
    expect(classifyAuditEvent({ actionType: "ruleset.publish" })).toBe("zone-config");
    expect(classifyAuditEvent({ actionType: "settings.edit" })).toBe("zone-config");
    expect(classifyAuditEvent({ resourceType: "certificate" })).toBe("zone-config");
    expect(attributeAuditActor({ type: "oauth-client" })).toBe("service");
    expect(attributeAuditActor({ type: "api-key" })).toBe("service");
    expect(attributeAuditActor({ type: "bot" })).toBe("service");
    expect(attributeAuditActor({ type: "superuser" })).toBe("human");
    expect(normalizeInsightSeverity("high")).toBe("high");
    expect(normalizeInsightSeverity("medium")).toBe("medium");
    expect(normalizeInsightSeverity("low")).toBe("low");
    expect(normalizeInsightSeverity("info")).toBe("info");
    expect(tlsVersionAtLeast("v1.3", "1.2")).toBe(true);
    expect(tlsVersionAtLeast("1.2", "junk")).toBe(false);
    expect(tlsVersionAtLeast("junk", "1.2")).toBe(false);
    expect(tlsVersionAtLeast("1.2.0", "1.2")).toBe(true);
  });
  it("rejects every malformed parser arm", () => {
    const bad: Array<() => unknown> = [
      () => parseCloudflareAuditInput({ since: "" }),
      () => parseCloudflareAuditInput({ since: 42 }),
      () => parseCloudflareAuditInput({ limit: 0 }),
      () => parseCloudflareAuditInput({ classes: [] }),
      () => parseCloudflareAuditInput({ classes: ["token", "token", "membership", "zone-config", "other", "x"] }),
      () => parseCloudflareAuditInput("nope"),
      () => parseCloudflareInsightsInput("nope"),
      () => parseCloudflareInsightsInput({ limit: 0 }),
      () => parseCloudflareInsightsInput({ baseline: { recordedAt: 42 } }),
      () => parseCloudflarePostureInput("nope"),
      () => parseCloudflarePostureInput({ maxZones: 0 }),
      () => parseCloudflarePostureInput({ max_zones: 251 }),
      () => parseCloudflarePostureInput({ maxCheckedZones: 0 }),
      () => parseCloudflarePostureInput({ settings: [] }),
      () => parseCloudflarePostureInput({ baseline: { acknowledgedCriticalIds: "x" } }),
      () => parseCloudflarePostureInput({ baseline: { acknowledgedCriticalIds: ["a".repeat(200)] } }),
      () =>
        parsePostureBaseline({
          recordedAt: null,
          acknowledgedCriticalIds: [],
          suppressions: [["not-an-object"]],
          zoneExpectations: {},
        }),
      () =>
        parsePostureBaseline({
          recordedAt: null,
          acknowledgedCriticalIds: [],
          suppressions: [{ checkId: "token-active", reason: "", reviewer: "r", expiresAt: "2027-01-01T00:00:00Z" }],
          zoneExpectations: {},
        }),
      () =>
        parsePostureBaseline({
          recordedAt: null,
          acknowledgedCriticalIds: [],
          suppressions: [{ checkId: "token-active", reason: "r", reviewer: "r", expiresAt: "" }],
          zoneExpectations: {},
        }),
      () =>
        parsePostureBaseline({
          recordedAt: null,
          acknowledgedCriticalIds: [],
          suppressions: new Array(101).fill({
            checkId: "token-active",
            reason: "r",
            reviewer: "r",
            expiresAt: "2027-01-01T00:00:00Z",
          }),
          zoneExpectations: {},
        }),
      () =>
        parsePostureBaseline({
          recordedAt: null,
          acknowledgedCriticalIds: [],
          suppressions: [],
          zoneExpectations: { bogus: 1 },
        }),
      () =>
        parsePostureBaseline({
          recordedAt: null,
          acknowledgedCriticalIds: [],
          suppressions: [],
          zoneExpectations: { ssl: [] },
        }),
      () =>
        parsePostureBaseline({
          recordedAt: null,
          acknowledgedCriticalIds: [],
          suppressions: [],
          zoneExpectations: { securityHeaderEnabled: "yes" },
        }),
      () => parsePostureBaseline(null),
    ];
    for (const probe of bad) {
      expect(probe).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
  it("accepts the checked-in file envelope verbatim", async () => {
    const file = (await import("../docs/posture/baseline.json")).default;
    const parsed = parsePostureBaseline(file);
    expect(parsed.recordedAt).toBeNull();
    expect(parsed.zoneExpectations.ssl).toEqual(["strict"]);
  });
  it("accepts snake_case zones and dedupes settings", () => {
    expect(parseCloudflarePostureInput({ max_zones: 5 })).toMatchObject({ maxZones: 5 });
    expect(parseCloudflarePostureInput({ settings: ["ssl", "ssl"] })).toMatchObject({ settings: ["ssl"] });
    expect(parseCloudflareAuditInput({})).toEqual({});
    expect(
      parsePostureBaseline({
        recordedAt: "2026-09-19T00:00:00Z",
        acknowledgedCriticalIds: ["c1", "c1"],
        suppressions: [
          { checkId: "global-api-key-non-use", reason: "ok", reviewer: "steward", expiresAt: "2027-01-01T00:00:00Z" },
        ],
        zoneExpectations: { ssl: ["strict", "full"] },
      }),
    ).toMatchObject({ recordedAt: "2026-09-19T00:00:00Z", acknowledgedCriticalIds: ["c1"] });
  });
});

describe("evaluatePostureChecks setting arms", () => {
  const zoneId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const base = {
    verifyStatus: "healthy" as const,
    zoneCount: 1,
    pausedZones: 0,
    developmentModeActive: 0,
    checkedZoneIds: [zoneId],
    settingEvidence: [] as Array<{
      setting: string;
      zoneId: string;
      ok: boolean;
      valueJson: string | null;
      valueText: string | null;
    }>,
    checkedSettings: ["ssl", "min_tls_version", "always_use_https", "automatic_https_rewrites", "security_header"],
    baseline: undefined,
    nowIso: "2026-09-19T00:00:00Z",
  };
  const evidenceFor = (setting: string, valueText: string | null, valueJson: string | null = null) => ({
    setting,
    zoneId,
    ok: true,
    valueJson: valueJson ?? (valueText === null ? null : JSON.stringify(valueText)),
    valueText,
  });
  it("fails each drifted setting with the zone list", () => {
    const { verdict, checks } = evaluatePostureChecks({
      ...base,
      settingEvidence: [
        evidenceFor("ssl", "flexible"),
        evidenceFor("min_tls_version", "1.0"),
        evidenceFor("always_use_https", "off"),
        evidenceFor("automatic_https_rewrites", "off"),
        { setting: "security_header", zoneId, ok: true, valueJson: '{"enabled":false}', valueText: null },
      ],
    });
    expect(verdict).toBe("failing");
    for (const id of [
      "zone-setting-ssl",
      "zone-setting-min_tls_version",
      "zone-setting-always_use_https",
      "zone-setting-automatic_https_rewrites",
      "zone-setting-security_header",
    ]) {
      const check = checks.find((row) => row.id === id);
      expect(check?.status).toBe("fail");
      expect(check?.detail).toContain(zoneId);
    }
  });
  it("treats unreadable values as drift and truncates long zone lists", () => {
    const { checks } = evaluatePostureChecks({
      ...base,
      settingEvidence: [
        { setting: "security_header", zoneId, ok: true, valueJson: '{"max_age":100}', valueText: null },
      ],
    });
    const check = checks.find((row) => row.id === "zone-setting-security_header");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("(unreadable)");
    const zones = Array.from({ length: 11 }, (_, index) => `z${index}`);
    const { checks: longChecks } = evaluatePostureChecks({
      ...base,
      checkedZoneIds: zones,
      settingEvidence: zones.map((id) => ({
        setting: "ssl",
        zoneId: id,
        ok: true,
        valueJson: '"flexible"',
        valueText: "flexible",
      })),
    });
    expect(longChecks.find((row) => row.id === "zone-setting-ssl")?.detail).toContain(", …");
    const { checks: unknownChecks } = evaluatePostureChecks({
      ...base,
      settingEvidence: [{ setting: "ssl", zoneId, ok: false, valueJson: null, valueText: null }],
    });
    expect(unknownChecks.find((row) => row.id === "zone-setting-ssl")?.status).toBe("unknown");
  });
  it("honors expired suppressions by ignoring them", () => {
    const { verdict, checks } = evaluatePostureChecks({
      ...base,
      developmentModeActive: 1,
      baseline: {
        recordedAt: "2026-09-19T00:00:00Z",
        acknowledgedCriticalIds: [],
        suppressions: [
          { checkId: "zone-hygiene", reason: "old", reviewer: "steward", expiresAt: "2020-01-01T00:00:00Z" },
        ],
        zoneExpectations: {
          ssl: ["strict"],
          minTlsVersionMin: "1.2",
          alwaysUseHttps: "on",
          automaticHttpsRewrites: "on",
          securityHeaderEnabled: true,
        },
      },
    });
    expect(checks.find((row) => row.id === "zone-hygiene")).toMatchObject({ status: "fail", suppressed: false });
    expect(verdict).toBe("failing");
  });
  it("records accepted exceptions on manual controls", () => {
    const manual = postureManualControls(
      {
        recordedAt: "2026-09-19T00:00:00Z",
        acknowledgedCriticalIds: [],
        suppressions: [
          {
            checkId: "global-api-key-non-use",
            reason: "accepted",
            reviewer: "steward",
            expiresAt: "2027-01-01T00:00:00Z",
          },
        ],
        zoneExpectations: {
          ssl: ["strict"],
          minTlsVersionMin: "1.2",
          alwaysUseHttps: "on",
          automaticHttpsRewrites: "on",
          securityHeaderEnabled: true,
        },
      },
      "2026-09-19T00:00:00Z",
    );
    expect(manual.find((row) => row.id === "global-api-key-non-use")).toMatchObject({
      status: "manual",
      suppressed: true,
    });
  });
});

describe("posture input parsers", () => {
  it("rejects unknown keys and out-of-range limits", () => {
    expect(() => parseCloudflareAuditInput({ bogus: 1 })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => parseCloudflareAuditInput({ limit: 500 })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => parseCloudflareAuditInput({ classes: ["nonsense"] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => parseCloudflareInsightsInput({ includeDismissed: "yes" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => parseCloudflarePostureInput({ settings: ["ssl", "evil"] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() => parseCloudflarePostureInput({ maxCheckedZones: 99 })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
  it("accepts the documented shapes", () => {
    expect(parseCloudflareAuditInput({ limit: 10, classes: ["token", "membership"] })).toMatchObject({ limit: 10 });
    expect(parseCloudflareInsightsInput({ includeDismissed: true })).toMatchObject({ includeDismissed: true });
    expect(parseCloudflarePostureInput({ maxZones: 25, settings: ["ssl"] })).toMatchObject({
      maxZones: 25,
      settings: ["ssl"],
    });
  });
});

describe("listAuditLogs", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    id: "audit-1",
    action: { type: "tokens.create", result: true, time: "2026-09-18T00:00:00Z", description: "API token created" },
    actor: { id: "user-1", email: "op@example.com", type: "user" },
    resource: { id: "tok-1", type: "api_token", scope: "account", product: "tokens" },
    zone: { id: "zone-1", name: "example.com" },
    ...overrides,
  });
  it("shapes entries with class and attribution plus counts", async () => {
    mockJson({
      success: true,
      result: [
        entry(),
        entry({
          id: "audit-2",
          action: { type: "members.add" },
          actor: { type: "user", email: "a@b.c" },
          resource: { id: "m-1", type: "account_member", scope: "account", product: "members" },
        }),
      ],
      result_info: { total_count: 2, total_pages: 1 },
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { since: "2026-09-18", limit: 10 });
    expect(out.entryCount).toBe(2);
    expect(out.classCounts).toMatchObject({ token: 1, membership: 1 });
    expect(out.actorKindCounts).toMatchObject({ human: 2 });
    expect(out.entries[0]).toMatchObject({ eventClass: "token", actorKind: "human", zoneName: "example.com" });
    expect(out.apiCalls).toBe(1);
    expect(JSON.stringify(out)).not.toContain(TOKEN_SENTINEL);
  });
  it("filters client-side by class and marks service actors", async () => {
    mockJson({
      success: true,
      result: [entry(), entry({ id: "audit-3", actor: { type: "api_token", token_id: "tok", token_name: "deploy" } })],
      result_info: { total_count: 2, total_pages: 1 },
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 10, classes: ["token"] });
    expect(out.entries.every((row) => row.eventClass === "token")).toBe(true);
    expect(out.entries.map((row) => row.actorKind)).toContain("service");
  });
  it("fails closed without a token and never leaks it in errors", async () => {
    await expect(listAuditLogs(CONNECTION, {}, ACCOUNT, {})).rejects.toMatchObject({
      code: "CLOUDFLARE_NOT_CONFIGURED",
    });
    mockJson({ success: false, errors: [{ code: 10000, message: "bad token" }] }, 403);
    const err = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, {}).catch((error: Error) => error);
    expect(err).toMatchObject({ code: "CLOUDFLARE_REQUEST_FAILED" });
    expect(String((err as { message: string }).message)).not.toContain(TOKEN_SENTINEL);
  });
  it("follows the second page and shapes sparse entries", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls += 1;
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("page=1")) {
        return Response.json({
          success: true,
          result: [{ id: "a1", action: "login", actor: {}, resource: {}, zone: {} }],
          result_info: { total_count: 2, total_pages: 2 },
        });
      }
      return Response.json({
        success: true,
        result: [
          { id: "a2", action: { type: "dns.edit", result: false, time: "2026-09-18T01:00:00Z" } },
          { nope: true },
          "junk",
        ],
        result_info: { total_count: 2, total_pages: 2 },
      });
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 10 });
    expect(calls).toBe(2);
    expect(out.entryCount).toBe(2);
    expect(out.entries[0]).toMatchObject({ actionType: "login", actorKind: "unknown", eventClass: "other" });
    expect(out.entries[1]).toMatchObject({
      actionType: "dns.edit",
      actionResult: "false",
      actorKind: "unknown",
      eventClass: "zone-config",
    });
  });
  it("prefers the opaque cursor when the vendor sends one", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push(url);
      if (seen.length === 1) {
        return Response.json({
          success: true,
          result: [{ id: "c1", action: { type: "x" }, actor: {}, resource: {}, zone: {} }],
          result_info: { cursor: "opaque-1", total_count: 2 },
        });
      }
      return Response.json({
        success: true,
        result: [{ id: "c2", action: { type: "y" }, actor: {}, resource: {}, zone: {} }],
        result_info: { total_count: 2 },
      });
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 10 });
    expect(seen[1]).toContain("cursor=opaque-1");
    expect(out.entryCount).toBe(2);
    expect(out.apiCalls).toBe(2);
  });
  it("rejects out-of-range limits before any vendor call", async () => {
    const spy = mockJson({ success: true, result: [] });
    await expect(listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 500 })).rejects.toMatchObject({
      code: "CLOUDFLARE_INTEGRATION_FAILED",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("listSecurityInsights", () => {
  const issue = (overrides: Record<string, unknown> = {}) => ({
    id: "insight-1",
    name: "Dangling DNS record",
    class: "exposed_infrastructure",
    type: "insecure_configuration",
    severity: "critical",
    dismissed: false,
    zone_id: "zone-1",
    zone_name: "example.com",
    ...overrides,
  });
  it("counts severities and tracks unresolved Criticals", async () => {
    mockJson({
      success: true,
      result: [issue(), issue({ id: "insight-2", severity: "high" }), issue({ id: "insight-3", severity: "weird" })],
      result_info: { total_count: 3, total_pages: 1 },
    });
    const out = await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, { limit: 10 });
    expect(out.severityCounts).toMatchObject({ critical: 1, high: 1, unknown: 1 });
    expect(out.unresolvedCriticalIds).toEqual(["insight-1"]);
    expect(out.verdict).toBe("advisory");
    expect(JSON.stringify(out)).not.toContain(TOKEN_SENTINEL);
  });
  it("excludes dismissed findings by default", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return Response.json({ success: true, result: [], result_info: { total_count: 0, total_pages: 1 } });
    });
    await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, {});
    expect(seen[0]).toContain("dismissed=false");
  });
  it("shapes aliased fields and honors includeDismissed", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(input instanceof Request ? input.url : String(input));
      return Response.json({
        success: true,
        result: [
          {
            issue_id: "alias-1",
            title: "Aliased",
            issue_class: "email_security",
            issue_type: "compliance_violation",
            severity: "MEDIUM",
            status: "dismissed",
            zone: { id: "z1", name: "example.com" },
          },
          { id: "alias-2", severity: "low", zone_id: "z2", zone_name: "other.com" },
          { nope: true },
        ],
        result_info: { total_pages: 1 },
      });
    });
    const out = await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, { includeDismissed: true });
    expect(seen[0]).not.toContain("dismissed");
    expect(out.issueCount).toBe(2);
    expect(out.totalAvailable).toBeNull();
    expect(out.truncated).toBe(false);
    expect(out.issues[0]).toMatchObject({
      name: "Aliased",
      issueClass: "email_security",
      severity: "medium",
      dismissed: true,
      zoneName: "example.com",
    });
    expect(out.issues[1]).toMatchObject({ issueClass: null, severity: "low", zoneId: "z2" });
    expect(out.unresolvedCriticalIds).toEqual([]);
  });
  it("maps malformed bodies and transport faults without leaking", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not json", { status: 502 }));
    const bad = await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, {}).catch((error: Error) => error);
    expect(bad).toMatchObject({ code: "CLOUDFLARE_BAD_RESPONSE" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("down");
    });
    const down = await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, {}).catch((error: Error) => error);
    expect(down).toMatchObject({ code: "CLOUDFLARE_INTEGRATION_FAILED" });
    expect(String((down as { message: string }).message)).not.toContain(TOKEN_SENTINEL);
  });
});

describe("readZoneSettings", () => {
  const zoneId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  it("rejects non-allowlisted settings before any vendor call", async () => {
    const spy = mockJson({ success: true, result: {} });
    await expect(
      readZoneSettings(CONNECTION, SECRETS, ACCOUNT, { zoneIds: [zoneId], settings: ["evil"] }),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_INTEGRATION_FAILED" });
    expect(spy).not.toHaveBeenCalled();
  });
  it("shapes scalar values and degrades plan-gated settings to evidence", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/settings/ssl")) {
        return Response.json({ success: true, result: { id: "ssl", value: "strict" } });
      }
      return Response.json({ success: false, errors: [{ code: 10000, message: "gated" }] }, { status: 403 });
    });
    const out = await readZoneSettings(CONNECTION, SECRETS, ACCOUNT, {
      zoneIds: [zoneId],
      settings: ["ssl", "security_header"],
    });
    expect(out.apiCalls).toBe(2);
    expect(out.settings).toMatchObject([
      { setting: "ssl", zoneId, ok: true, valueText: "strict" },
      { setting: "security_header", zoneId, ok: false, errorCode: "CLOUDFLARE_REQUEST_FAILED" },
    ]);
    expect(JSON.stringify(out)).not.toContain(TOKEN_SENTINEL);
  });
  it("still fails loud on timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return Response.json({ success: true, result: {} });
    });
    await expect(
      readZoneSettings(CONNECTION, SECRETS, ACCOUNT, { zoneIds: [zoneId], settings: ["ssl"] }, undefined, 50),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_VENDOR_TIMEOUT" });
  });
  it("validates zone IDs and shapes scalar and null values", async () => {
    const spy = mockJson({ success: true, result: {} });
    for (const zoneIds of [[], "nope", new Array(26).fill(zoneId), ["short"], [42]]) {
      await expect(
        readZoneSettings(CONNECTION, SECRETS, ACCOUNT, {
          zoneIds: zoneIds as unknown as string[],
          settings: ["ssl"],
        }),
      ).rejects.toMatchObject({ code: "CLOUDFLARE_INTEGRATION_FAILED" });
    }
    await expect(
      readZoneSettings(CONNECTION, SECRETS, ACCOUNT, { zoneIds: [zoneId], settings: [] }),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_INTEGRATION_FAILED" });
    expect(spy).not.toHaveBeenCalled();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/settings/ssl")) return Response.json({ success: true, result: { id: "ssl", value: null } });
      return Response.json({ success: true, result: { id: "min_tls_version", value: 1.2 } });
    });
    const out = await readZoneSettings(CONNECTION, SECRETS, ACCOUNT, {
      zoneIds: [zoneId],
      settings: ["ssl", "min_tls_version"],
    });
    expect(out.settings).toMatchObject([
      { setting: "ssl", ok: true, valueJson: null, valueText: null },
      { setting: "min_tls_version", ok: true, valueJson: "1.2", valueText: "1.2" },
    ]);
  });
  it("dedupes zones and settings and reports the exact call count", async () => {
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ success: true, result: { id: "ssl", value: "strict" } }));
    const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const out = await readZoneSettings(CONNECTION, SECRETS, ACCOUNT, {
      zoneIds: [zoneId, zoneId, other],
      settings: ["ssl", "ssl"],
    });
    expect(out.zoneIds).toEqual([zoneId, other]);
    expect(out.apiCalls).toBe(2);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

async function seedConnection() {
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind("00000000-0000-4000-8000-000000000202", principal.orgId, CLOUDFLARE_INTEGRATION_ID, CLOUDFLARE_API_BASE)
    .run();
}

useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await seedConnection();
  },
});

describe("audit logs saga replay (issue #252 S1)", () => {
  function request(path: string, method: string, sagaId: string, body: unknown, idempotencyKey: string) {
    return new Request(`https://local.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${"a".repeat(64)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      ...(method === "POST" ? { body: JSON.stringify({ sagaId, input: body }) } : {}),
    });
  }

  it("persists the shaped audit summary through submit/ExecutionHistory", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain(`/accounts/${ACCOUNT.id}/logs/audit`);
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers as HeadersInit);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN_SENTINEL}`);
      expect(url).not.toContain(TOKEN_SENTINEL);
      return Response.json({
        success: true,
        result: [
          {
            id: "audit-9",
            action: { type: "zones.ssl.update", result: true, time: "2026-09-18T12:00:00Z" },
            actor: { id: "user-9", email: "steward@example.com", type: "user" },
            resource: { id: "zone-9", type: "zone", scope: "zone", product: "ssl" },
            zone: { id: "zone-9", name: "example.com" },
          },
        ],
        result_info: { total_count: 1, total_pages: 1 },
      });
    });
    const key = "cf-audit-replay-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_AUDIT_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflareAuditSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name }, since: "2026-09-18", limit: 10 },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const detail = await worker.fetch(
      request(`/api/executions/${id}`, "GET", cloudflareAuditSaga.id, {}, key),
      bindings,
    );
    const payload = (await detail.json()) as {
      status: string;
      result: { entryCount: number; classCounts: Record<string, number>; entries: Array<{ eventClass: string }> };
      operations: Array<{ name: string; status: string }>;
    };
    expect(payload.status).toBe("Succeeded");
    expect(payload.result.entryCount).toBe(1);
    expect(payload.result.classCounts).toMatchObject({ "zone-config": 1 });
    expect(payload.operations).toMatchObject([
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "cloudflare-audit-logs-v1", status: "Succeeded" },
    ]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(payload)).not.toContain(TOKEN_SENTINEL);
    const ops = await bindings.DB.prepare("SELECT result_json,error_json FROM operations WHERE execution_id=?")
      .bind(id)
      .all<{ result_json: string | null; error_json: string | null }>();
    expect(JSON.stringify(ops.results)).not.toContain(TOKEN_SENTINEL);
  });
});

describe("posture remaining arms (issue #252)", () => {
  const zoneId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  it("bounds shaped text and dedupes class filters", () => {
    expect(postureBoundedText(null)).toBeNull();
    expect(postureBoundedText("")).toBeNull();
    expect(postureBoundedText("short")).toBe("short");
    expect(postureBoundedText("a".repeat(400))).toHaveLength(300);
    expect(parseCloudflareAuditInput({ classes: ["token", "token"] })).toMatchObject({ classes: ["token"] });
    expect(attributeAuditActor({ email: "solo@example.com" })).toBe("human");
    expect(tlsVersionAtLeast("1.2", "1.2.0")).toBe(true);
  });
  it("parses the empty baseline to defaults and rejects bad expectations", () => {
    expect(parsePostureBaseline({})).toMatchObject({ recordedAt: null, acknowledgedCriticalIds: [] });
    expect(() => parsePostureBaseline({ zoneExpectations: "x" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(() =>
      parsePostureBaseline({
        acknowledgedCriticalIds: new Array(201).fill("c"),
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => parseCloudflareInsightsInput({ bogus: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(parseCloudflareInsightsInput({ limit: 5 })).toMatchObject({ limit: 5 });
    expect(() => parseCloudflarePostureInput({ bogus: 1 })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
  it("fails scalar settings on null values", () => {
    const args = {
      verifyStatus: "healthy" as const,
      zoneCount: 1,
      pausedZones: 0,
      developmentModeActive: 0,
      checkedZoneIds: [zoneId],
      checkedSettings: ["ssl", "min_tls_version"],
      baseline: undefined,
      nowIso: "2026-09-19T00:00:00Z",
    };
    const { checks } = evaluatePostureChecks({
      ...args,
      settingEvidence: [
        { setting: "ssl", zoneId, ok: true, valueJson: null, valueText: null },
        { setting: "min_tls_version", zoneId, ok: true, valueJson: null, valueText: null },
      ],
    });
    expect(checks.find((row) => row.id === "zone-setting-ssl")?.status).toBe("fail");
    expect(checks.find((row) => row.id === "zone-setting-min_tls_version")?.status).toBe("fail");
  });
  it("fails the setting check on errored-zone evidence", () => {
    const { verdict, checks } = evaluatePostureChecks({
      verifyStatus: "healthy" as const,
      zoneCount: 2,
      pausedZones: 0,
      developmentModeActive: 0,
      checkedZoneIds: [zoneId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      checkedSettings: ["ssl"],
      baseline: undefined,
      nowIso: "2026-09-19T00:00:00Z",
      settingEvidence: [
        { setting: "ssl", zoneId, ok: true, valueJson: '"strict"', valueText: "strict" },
        { setting: "ssl", zoneId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ok: false, valueJson: null, valueText: null },
      ],
    });
    expect(checks.find((row) => row.id === "zone-setting-ssl")?.detail).toContain("(unreadable)");
    expect(verdict).toBe("failing");
  });
  it("rejects non-allowlisted endpoints before vendor contact", async () => {
    const spy = mockJson({ success: true, result: [] });
    await expect(
      listAuditLogs({ endpoint: "https://evil.example.com/client/v4" }, SECRETS, ACCOUNT, {}),
    ).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
    expect(spy).not.toHaveBeenCalled();
  });
  it("shapes entries without action bodies and string results", async () => {
    mockJson({
      success: true,
      result: [
        {
          id: "n1",
          action: {
            result: "success",
            time: "2026-09-18T00:00:00Z",
            description: " did something with a very long tail ",
          },
          actor: { type: "user", email: "u@example.com" },
          resource: { type: "zone", scope: "zone" },
          zone: {},
        },
      ],
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 10 });
    expect(out.totalAvailable).toBeNull();
    expect(out.truncated).toBe(false);
    expect(out.entries[0]).toMatchObject({ actionType: "unknown", actionResult: "success", eventClass: "zone-config" });
  });
  it("truncates long vendor prose in shaped fields", async () => {
    mockJson({
      success: true,
      result: [
        {
          id: "n2",
          action: { type: "tokens.create", description: "d".repeat(500) },
          actor: { type: "user", email: "u@example.com" },
          resource: { type: "api_token" },
          zone: {},
        },
      ],
      result_info: { total_count: 1, total_pages: 1 },
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 10 });
    expect(out.entries[0]?.actionDescription).toHaveLength(300);
  });
  it("stops at the limit and skips empty pages", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          success: true,
          result: [
            { id: "l1", action: { type: "a" }, actor: {}, resource: {}, zone: {} },
            { id: "l2", action: { type: "b" }, actor: {}, resource: {}, zone: {} },
          ],
          result_info: { total_count: 9, total_pages: 5 },
        });
      }
      return Response.json({ success: true, result: [{ nope: 1 }], result_info: { total_pages: 5 } });
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 1 });
    expect(out.entryCount).toBe(1);
    expect(out.truncated).toBe(true);
    expect(calls).toBe(1);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: true, result: [{ nope: 1 }], result_info: {} }),
    );
    const empty = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 5 });
    expect(empty.entryCount).toBe(0);
  });
  it("filters to classes and skips non-object insight rows", async () => {
    mockJson({
      success: true,
      result: [
        { id: "m1", severity: "low", class: "email_security" },
        "junk",
        { id: "m2", severity: "low", class: "email_security" },
      ],
      result_info: { total_count: 3, total_pages: 1 },
    });
    const out = await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, { limit: 10 });
    expect(out.issueCount).toBe(2);
    expect(out.totalAvailable).toBe(3);
    expect(out.truncated).toBe(true);
  });
  it("applies the audit class filter client-side", async () => {
    mockJson({
      success: true,
      result: [
        {
          id: "f1",
          action: { type: "members.add" },
          actor: { type: "user", email: "u@example.com" },
          resource: { type: "account_member" },
          zone: {},
        },
      ],
      result_info: { total_count: 1, total_pages: 1 },
    });
    const out = await listAuditLogs(CONNECTION, SECRETS, ACCOUNT, { limit: 10, classes: ["token"] });
    expect(out.entryCount).toBe(0);
    expect(out.classCounts).toEqual({});
  });
  it("paginates insights and enforces the limit", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls += 1;
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("page=1")) {
        return Response.json({
          success: true,
          result: [{ id: "p1", severity: "high" }],
          result_info: { total_count: 3, total_pages: 2 },
        });
      }
      return Response.json({
        success: true,
        result: [
          { id: "p2", severity: "high" },
          { id: "p3", severity: "high" },
        ],
        result_info: { total_count: 3, total_pages: 2 },
      });
    });
    const one = await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, { limit: 1 });
    expect(one.issueCount).toBe(1);
    expect(calls).toBe(1);
    const all = await listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, { limit: 10 });
    expect(all.issueCount).toBe(3);
    expect(all.truncated).toBe(false);
    await expect(listSecurityInsights(CONNECTION, SECRETS, ACCOUNT, { limit: 500 })).rejects.toMatchObject({
      code: "CLOUDFLARE_INTEGRATION_FAILED",
    });
  });
  it("bounds long setting values and tolerates missing result envelopes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/settings/ssl")) {
        return Response.json({ success: true, result: { id: "ssl", value: "s".repeat(400) } });
      }
      if (url.endsWith("/settings/security_header")) {
        return Response.json({ success: true, result: { id: "security_header", value: { note: "x".repeat(2000) } } });
      }
      return Response.json({ success: true, result: [] });
    });
    const out = await readZoneSettings(CONNECTION, SECRETS, ACCOUNT, {
      zoneIds: [zoneId],
      settings: ["ssl", "security_header", "min_tls_version"],
    });
    expect(out.settings.find((row) => row.setting === "ssl")?.valueText).toHaveLength(300);
    expect(out.settings.find((row) => row.setting === "security_header")?.valueJson).toHaveLength(1024);
    expect(out.settings.find((row) => row.setting === "min_tls_version")).toMatchObject({
      ok: true,
      valueJson: null,
    });
  });
});

describe("posture failure legs (issue #252)", () => {
  function request(path: string, method: string, sagaId: string, body: unknown, idempotencyKey: string) {
    return new Request(`https://local.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${"a".repeat(64)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      ...(method === "POST" ? { body: JSON.stringify({ sagaId, input: body }) } : {}),
    });
  }

  async function failedDetail(sagaId: string, key: string) {
    // The execution ID derives from (org, user, key): recompute it.
    const id = await executionId(principal, key);
    const res = await worker.fetch(request(`/api/executions/${id}`, "GET", sagaId, {}, key), bindings);
    return (await res.json()) as { status: string; error: { code: string } };
  }

  it("marks the audit run Failed on vendor rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: "bad" }] }, { status: 403 }),
    );
    const key = "cf-audit-fail-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_AUDIT_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflareAuditSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name } },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("errored");
    const payload = await failedDetail(cloudflareAuditSaga.id, key);
    expect(payload.status).toBe("Failed");
    expect(payload.error.code).toBe("CLOUDFLARE_REQUEST_FAILED");
  });

  it("marks the insights run Failed on vendor rejection", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: "bad" }] }, { status: 403 }),
    );
    const key = "cf-insights-fail-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_INSIGHTS_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflareInsightsSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name } },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("errored");
    const payload = await failedDetail(cloudflareInsightsSaga.id, key);
    expect(payload.status).toBe("Failed");
    expect(payload.error.code).toBe("CLOUDFLARE_REQUEST_FAILED");
  });

  it("marks the benchmark run Failed when inventory is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/user/tokens/verify")) {
        return Response.json({ success: true, result: { status: "active" } });
      }
      return Response.json({ success: false, errors: [{ code: 10000, message: "bad" }] }, { status: 403 });
    });
    const key = "cf-posture-fail-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_POSTURE_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflarePostureSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name }, maxZones: 10, maxCheckedZones: 2 },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("errored");
    const payload = await failedDetail(cloudflarePostureSaga.id, key);
    expect(payload.status).toBe("Failed");
    expect(payload.error.code).toBe("CLOUDFLARE_REQUEST_FAILED");
  });

  it("fails the audit run on a missing account mapping", async () => {
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ success: true, result: [] }));
    const key = "cf-audit-noacct-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_AUDIT_WORKFLOW, id);
    const accepted = await worker.fetch(request("/api/executions", "POST", cloudflareAuditSaga.id, {}, key), bindings);
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("errored");
    const payload = await failedDetail(cloudflareAuditSaga.id, key);
    expect(payload.status).toBe("Failed");
    expect(payload.error.code).toBe("CLOUDFLARE_ACCOUNT_MISSING");
    expect(mock).not.toHaveBeenCalled();
  });

  it("marks the benchmark run Failed when verification is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: "bad" }] }, { status: 403 }),
    );
    const key = "cf-posture-verifyfail-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_POSTURE_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflarePostureSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name } },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("errored");
    const payload = await failedDetail(cloudflarePostureSaga.id, key);
    expect(payload.status).toBe("Failed");
    expect(payload.error.code).toBe("CLOUDFLARE_REQUEST_FAILED");
  });

  it("degrades settings to unknown when every read is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/user/tokens/verify")) {
        return Response.json({ success: true, result: { status: "active" } });
      }
      if (url.includes("/zones?") || url.endsWith("/zones")) {
        return Response.json({
          success: true,
          result: [
            {
              id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              name: "a.example.com",
              status: "active",
              type: "full",
              paused: false,
              account: { id: ACCOUNT.id, name: ACCOUNT.name },
              plan: { name: "Free" },
              name_servers: [],
            },
          ],
          result_info: { total_count: 1, total_pages: 1 },
        });
      }
      return Response.json({ success: false, errors: [{ code: 10000, message: "gated" }] }, { status: 403 });
    });
    const key = "cf-posture-settingsfail-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_POSTURE_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflarePostureSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name }, maxZones: 10, maxCheckedZones: 1 },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const res = await worker.fetch(
      request(`/api/executions/${id}`, "GET", cloudflarePostureSaga.id, {}, key),
      bindings,
    );
    const payload = (await res.json()) as {
      status: string;
      result: { verdict: string; checks: Array<{ id: string; status: string }> };
    };
    expect(payload.status).toBe("Succeeded");
    expect(
      payload.result.checks
        .filter((check) => check.id.startsWith("zone-setting-"))
        .every((check) => check.status === "unknown"),
    ).toBe(true);
  });

  it("degrades every setting check to unknown when no zones exist", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/user/tokens/verify")) {
        return Response.json({ success: true, result: { status: "active" } });
      }
      return Response.json({ success: true, result: [], result_info: { total_count: 0, total_pages: 1 } });
    });
    const key = "cf-posture-empty-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_POSTURE_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflarePostureSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name }, maxZones: 10, maxCheckedZones: 2 },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const res = await worker.fetch(
      request(`/api/executions/${id}`, "GET", cloudflarePostureSaga.id, {}, key),
      bindings,
    );
    const payload = (await res.json()) as {
      status: string;
      result: { verdict: string; apiCalls: number; checks: Array<{ id: string; status: string }> };
    };
    expect(payload.status).toBe("Succeeded");
    expect(payload.result.verdict).toBe("advisory");
    expect(payload.result.apiCalls).toBe(2);
    expect(
      payload.result.checks
        .filter((check) => check.id.startsWith("zone-setting-"))
        .every((check) => check.status === "unknown"),
    ).toBe(true);
  });
});

describe("insights saga replay (issue #252 S2)", () => {
  function request(path: string, method: string, sagaId: string, body: unknown, idempotencyKey: string) {
    return new Request(`https://local.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${"a".repeat(64)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      ...(method === "POST" ? { body: JSON.stringify({ sagaId, input: body }) } : {}),
    });
  }

  it("promotes a new unresolved Critical to failing after a recorded baseline", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain(`/accounts/${ACCOUNT.id}/security-center/insights`);
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers as HeadersInit);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN_SENTINEL}`);
      return Response.json({
        success: true,
        result: [
          { id: "crit-1", name: "Exposed DB", class: "exposed_infrastructure", severity: "critical", dismissed: false },
          { id: "high-1", name: "Weak cipher", severity: "high", dismissed: false },
        ],
        result_info: { total_count: 2, total_pages: 1 },
      });
    });
    const key = "cf-insights-replay-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_INSIGHTS_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflareInsightsSaga.id,
        {
          account: { id: ACCOUNT.id, name: ACCOUNT.name },
          limit: 10,
          includeDismissed: true,
          baseline: {
            recordedAt: "2026-09-19T00:00:00Z",
            acknowledgedCriticalIds: [],
            suppressions: [],
            zoneExpectations: {},
          },
        },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const detail = await worker.fetch(
      request(`/api/executions/${id}`, "GET", cloudflareInsightsSaga.id, {}, key),
      bindings,
    );
    const payload = (await detail.json()) as {
      status: string;
      result: { verdict: string; unresolvedCriticalIds: string[]; severityCounts: Record<string, number> };
    };
    expect(payload.status).toBe("Succeeded");
    expect(payload.result.verdict).toBe("failing");
    expect(payload.result.unresolvedCriticalIds).toEqual(["crit-1"]);
    expect(payload.result.severityCounts).toMatchObject({ critical: 1, high: 1 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(payload)).not.toContain(TOKEN_SENTINEL);
  });
});

describe("benchmark saga replay (issue #252 S3)", () => {
  const zoneA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const zoneB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function zone(id: string, name: string) {
    return {
      id,
      name,
      status: "active",
      type: "full",
      paused: false,
      development_mode: 0,
      account: { id: ACCOUNT.id, name: ACCOUNT.name },
      plan: { name: "Free" },
      name_servers: ["ns1.example.com"],
      activated_on: "2020-01-01T00:00:00Z",
      modified_on: "2026-09-18T00:00:00Z",
    };
  }

  function request(path: string, method: string, sagaId: string, body: unknown, idempotencyKey: string) {
    return new Request(`https://local.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${"a".repeat(64)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      ...(method === "POST" ? { body: JSON.stringify({ sagaId, input: body }) } : {}),
    });
  }

  it("evaluates typed checks over verify, inventory, and zone settings", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers as HeadersInit);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN_SENTINEL}`);
      expect(url).not.toContain(TOKEN_SENTINEL);
      if (url.includes("/user/tokens/verify")) {
        return Response.json({ success: true, result: { status: "active" } });
      }
      if (url.includes("/zones?") || url.endsWith("/zones")) {
        return Response.json({
          success: true,
          result: [zone(zoneA, "a.example.com"), zone(zoneB, "b.example.com")],
          result_info: { total_count: 2, total_pages: 1 },
        });
      }
      const setting = url.split("/settings/")[1];
      const values: Record<string, unknown> = {
        ssl: "strict",
        min_tls_version: "1.2",
        always_use_https: "on",
        automatic_https_rewrites: "on",
        security_header: { enabled: true },
      };
      return Response.json({ success: true, result: { id: setting, value: values[setting ?? ""] ?? null } });
    });
    const key = "cf-posture-replay-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_POSTURE_WORKFLOW, id);
    const accepted = await worker.fetch(
      request(
        "/api/executions",
        "POST",
        cloudflarePostureSaga.id,
        { account: { id: ACCOUNT.id, name: ACCOUNT.name }, maxZones: 10, maxCheckedZones: 2 },
        key,
      ),
      bindings,
    );
    expect(accepted.status).toBe(202);
    await instance.waitForStatus("complete");
    const detail = await worker.fetch(
      request(`/api/executions/${id}`, "GET", cloudflarePostureSaga.id, {}, key),
      bindings,
    );
    const payload = (await detail.json()) as {
      status: string;
      result: {
        verdict: string;
        apiCalls: number;
        checks: Array<{ id: string; status: string }>;
        manual: Array<{ id: string; status: string }>;
        deferred: Array<{ id: string; status: string }>;
      };
    };
    expect(payload.status).toBe("Succeeded");
    expect(payload.result.verdict).toBe("advisory");
    // 1 verify + 1 inventory + 2 zones x 5 settings.
    expect(payload.result.apiCalls).toBe(12);
    expect(payload.result.checks.find((check) => check.id === "token-active")?.status).toBe("pass");
    expect(payload.result.checks.find((check) => check.id === "zone-hygiene")?.status).toBe("pass");
    expect(payload.result.checks.find((check) => check.id === "zone-setting-ssl")?.status).toBe("pass");
    expect(payload.result.checks.filter((check) => check.status === "deferred")).toHaveLength(2);
    expect(payload.result.manual.map((check) => check.id)).toContain("global-api-key-non-use");
    expect(mock).toHaveBeenCalledTimes(12);
    expect(JSON.stringify(payload)).not.toContain(TOKEN_SENTINEL);
  });
});
