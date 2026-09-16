// SPDX-License-Identifier: AGPL-3.0
// Zone Inventory migration (issues #116 MIG-01, #119 MIG-02): fast unit
// coverage for the Cloudflare Integration Actions and input parsers. The
// replay suite proves end-to-end behavior with mocked vendor HTTP; these
// tests pin every defensive arm directly (missing secrets, bad account
// mappings, endpoint mismatches, vendor fault shapes, timeouts, loose
// payload shapes, parser rejections) so the branch gate never hinges on
// workflow-level incidental coverage. No D1, no Workflows, no live vendor.
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_MAX_ZONES,
  parseCloudflareInventoryInput,
  parseCloudflareVerifyInput,
} from "../src/domain";
import { inventoryZones, requireAccountId, verifyConnection } from "../src/integrations/cloudflare";

const CONNECTION = { endpoint: CLOUDFLARE_API_BASE };
const ACCOUNT = { id: "0123456789abcdef0123456789abcdef", name: "Example MSP" };
const SECRETS = { apiToken: "unit-test-sentinel" };

function mockJson(payload: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json(payload, { status }),
  );
}

function mockText(body: string, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requireAccountId", () => {
  it("accepts a 32-hex mapping", () => {
    expect(requireAccountId(ACCOUNT.id)).toBe(ACCOUNT.id);
  });
  it("fails closed on missing or malformed mappings", () => {
    for (const bad of [null, undefined, "", "short", "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", 42]) {
      expect(() => requireAccountId(bad)).toThrow(expect.objectContaining({ code: "CLOUDFLARE_ACCOUNT_MISSING" }));
    }
  });
});

describe("verifyConnection", () => {
  it("reports healthy for an active token", async () => {
    mockJson({ success: true, result: { status: "active", expires_on: "2027-01-01T00:00:00Z" } });
    const out = await verifyConnection(CONNECTION, SECRETS, ACCOUNT);
    expect(out).toMatchObject({ status: "healthy", apiCalls: 1 });
    expect(out.credential).toMatchObject({ status: "active", expiresOn: "2027-01-01T00:00:00Z", notBefore: null });
  });
  it("reports unhealthy for a non-active token without leaking it", async () => {
    mockJson({ success: true, result: { status: "suspended" } });
    const out = await verifyConnection(CONNECTION, SECRETS, ACCOUNT);
    expect(out.status).toBe("unhealthy");
  });
  it("fails closed without a token", async () => {
    await expect(verifyConnection(CONNECTION, {}, ACCOUNT)).rejects.toMatchObject({
      code: "CLOUDFLARE_NOT_CONFIGURED",
    });
    await expect(verifyConnection(CONNECTION, { apiToken: "" }, ACCOUNT)).rejects.toMatchObject({
      code: "CLOUDFLARE_NOT_CONFIGURED",
    });
  });
  it("fails closed on a bad account mapping", async () => {
    await expect(verifyConnection(CONNECTION, SECRETS, { id: null, name: null })).rejects.toMatchObject({
      code: "CLOUDFLARE_ACCOUNT_MISSING",
    });
  });
  it("fails closed on endpoint mismatch", async () => {
    await expect(
      verifyConnection({ endpoint: "https://evil.example.com/client/v4" }, SECRETS, ACCOUNT),
    ).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
  });
  it("maps vendor 403 to the safe vendor message", async () => {
    mockJson({ success: false, errors: [{ code: 10000, message: "Invalid access token" }] }, 403);
    await expect(verifyConnection(CONNECTION, SECRETS, ACCOUNT)).rejects.toMatchObject({
      code: "CLOUDFLARE_REQUEST_FAILED",
    });
  });
  it("maps malformed vendor bodies without copying content", async () => {
    mockText("upstream response was not JSON", 502);
    const err = await verifyConnection(CONNECTION, SECRETS, ACCOUNT).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "CLOUDFLARE_BAD_RESPONSE" });
    expect(String((err as { message: string }).message)).not.toContain("upstream response was not JSON");
  });
  it("maps transport failures without leaking the token", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const err = await verifyConnection(CONNECTION, SECRETS, ACCOUNT).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "CLOUDFLARE_INTEGRATION_FAILED" });
    expect(String((err as { message: string }).message)).not.toContain("unit-test-sentinel");
  });
  it("surfaces vendor timeouts on slow vendors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return Response.json({ success: true, result: { status: "active" } });
    });
    await expect(verifyConnection(CONNECTION, SECRETS, ACCOUNT, undefined, 50)).rejects.toMatchObject({
      code: "CLOUDFLARE_VENDOR_TIMEOUT",
    });
  }, 10000);
});

describe("inventoryZones", () => {
  it("stops after the final advertised page", async () => {
    const page = (zones: unknown[], totalPages: number) => ({
      success: true,
      result: zones,
      result_info: { total_pages: totalPages, total_count: zones.length },
    });
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const pageNum = new URL(url).searchParams.get("page");
      return Response.json(pageNum === "2" ? page([{ id: "z2", name: "b" }], 2) : page([{ id: "z1", name: "a" }], 2));
    });
    const out = await inventoryZones(CONNECTION, SECRETS, ACCOUNT, { maxZones: 250 });
    expect(out.zoneCount).toBe(2);
    expect(out.apiCalls).toBe(2);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("caps at maxZones and reports truncation", async () => {
    mockJson({
      success: true,
      result: [
        { id: "z1", name: "a" },
        { id: "z2", name: "b" },
        { id: "z3", name: "c" },
      ],
      result_info: { total_pages: 1, total_count: 3 },
    });
    const out = await inventoryZones(CONNECTION, SECRETS, ACCOUNT, { maxZones: 2 });
    expect(out.zoneCount).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.totalAvailable).toBe(3);
  });
  it("stops on empty batches and tolerates missing result_info", async () => {
    mockJson({ success: true, result: [] });
    const out = await inventoryZones(CONNECTION, SECRETS, ACCOUNT, { maxZones: 10 });
    expect(out.zoneCount).toBe(0);
    expect(out.totalAvailable).toBeNull();
    expect(out.truncated).toBe(false);
  });
  it("shapes loose zone rows with safe defaults", async () => {
    mockJson({
      success: true,
      result: [{}, { id: "z", paused: true, development_mode: 5, plan: {}, name_servers: ["b", "a", 7, ""] }],
      result_info: { total_pages: 1 },
    });
    const out = await inventoryZones(CONNECTION, SECRETS, ACCOUNT, { maxZones: 10 });
    expect(out.zones[0]).toMatchObject({ id: "", status: "unknown", plan: "unknown", nameServers: [] });
    expect(out.zones[1]).toMatchObject({
      paused: true,
      developmentModeActive: true,
      nameServers: ["a", "b"],
    });
    expect(out.summary.paused).toBe(1);
  });
  it("fails closed without token, mapping, or on endpoint mismatch", async () => {
    await expect(inventoryZones(CONNECTION, {}, ACCOUNT, { maxZones: 1 })).rejects.toMatchObject({
      code: "CLOUDFLARE_NOT_CONFIGURED",
    });
    await expect(inventoryZones(CONNECTION, SECRETS, { id: "nope", name: "" }, { maxZones: 1 })).rejects.toMatchObject(
      { code: "CLOUDFLARE_ACCOUNT_MISSING" },
    );
    await expect(
      inventoryZones({ endpoint: "https://evil.example.com/" }, SECRETS, ACCOUNT, { maxZones: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
  });
});

describe("cloudflare input parsers", () => {
  it("verify accepts empty and account-carrying inputs, rejects the rest", () => {
    expect(parseCloudflareVerifyInput({})).toEqual({});
    expect(parseCloudflareVerifyInput({ account: { id: "a", name: "b" } })).toEqual({
      account: { id: "a", name: "b" },
    });
    for (const bad of [null, "x", { name: "extra" }, { account: "nope" }]) {
      expect(() => parseCloudflareVerifyInput(bad)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
  it("inventory validates bounds, defaults, both key shapes, and account", () => {
    expect(parseCloudflareInventoryInput({})).toEqual({ maxZones: CLOUDFLARE_MAX_ZONES });
    expect(parseCloudflareInventoryInput({ max_zones: 75 })).toEqual({ maxZones: 75 });
    expect(parseCloudflareInventoryInput({ maxZones: 75 })).toEqual({ maxZones: 75 });
    expect(parseCloudflareInventoryInput({ max_zones: 3, account: { id: null, name: null } })).toEqual({
      maxZones: 3,
      account: { id: null, name: null },
    });
    for (const bad of [
      null,
      { max_zones: true },
      { max_zones: 0 },
      { max_zones: 251 },
      { max_zones: 1.5 },
      { max_zones: 1, oops: 1 },
      { maxZones: 1, account: 7 },
    ]) {
      expect(() => parseCloudflareInventoryInput(bad)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
  });
});

describe("vendor error shaping", () => {
  it("tolerates malformed error payloads without copying content", async () => {
    // Non-object payload, non-array errors, non-object entries, and
    // schemaless codes/messages all fall back to the safe default.
    for (const payload of [
      null,
      { success: false },
      { success: false, errors: "nope" },
      { success: false, errors: ["nope", { code: "str", message: "" }] },
    ]) {
      mockJson(payload, 500);
      const err = await verifyConnection(CONNECTION, SECRETS, ACCOUNT).catch((e: Error) => e);
      expect(err).toMatchObject({ code: "CLOUDFLARE_REQUEST_FAILED" });
      expect(String((err as { message: string }).message).endsWith("Cloudflare request failed")).toBe(true);
      vi.restoreAllMocks();
    }
  });
  it("rethrows Faults from the transport untouched", async () => {
    const { Fault } = await import("../src/domain");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Fault(502, "CLOUDFLARE_REQUEST_FAILED", "Cloudflare returned HTTP 502: stale.");
    });
    await expect(verifyConnection(CONNECTION, SECRETS, ACCOUNT)).rejects.toMatchObject({
      code: "CLOUDFLARE_REQUEST_FAILED",
    });
  });
  it("shapes non-object results and absences with safe defaults", async () => {
    mockJson({ success: true, result: null });
    const out = await verifyConnection(CONNECTION, SECRETS, { id: ACCOUNT.id, name: 42 });
    expect(out).toMatchObject({ status: "unhealthy", account: { id: ACCOUNT.id, name: "" } });
    expect(out.credential).toMatchObject({ status: "unknown", expiresOn: null, notBefore: null });
  });
  it("inventory tolerates schemaless payloads and stops without total pages", async () => {
    mockJson({ success: true });
    const out = await inventoryZones(CONNECTION, SECRETS, ACCOUNT, { maxZones: 5 });
    expect(out).toMatchObject({ zoneCount: 0, totalAvailable: null, apiCalls: 1 });
  });
  it("caps at the 250-zone hard bound even under large maxZones", async () => {
    const zones = Array.from({ length: 60 }, (_, i) => ({ id: `z${i}`, name: `n${i}` }));
    mockJson({ success: true, result: zones });
    const out = await inventoryZones(CONNECTION, SECRETS, ACCOUNT, { maxZones: 250 });
    // No total_pages and non-empty pages: the loop refetches until the
    // hard bound stops it (60/call, 5 calls, sliced to 250).
    expect(out.zoneCount).toBe(250);
    expect(out.apiCalls).toBe(5);
  });
});
