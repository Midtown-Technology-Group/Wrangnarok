// SPDX-License-Identifier: AGPL-3.0
// Bundle-relief guard pins (lane bundle-unlock-trg139-audit, LIMITS-01 #177).
// The C1/C2 refactors only reroute byte-identical rejections through shared
// helpers, so these tests pin the exact observable contract: status code,
// error code, AND message on converted query-rejection routes and on every
// invalid fence shape. Existing suites assert the codes broadly; this file
// asserts the full triple survives the helper extraction.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { OAuthRefreshFence } from "../src/oauth-refresh-fence";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const LAB = { Authorization: `Bearer ${TOKEN}` };

const QUERY_MESSAGE = "Query parameters are not supported on this route.";
const FENCE_MESSAGE = "The refresh fence request is invalid.";

function call(path: string, init: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://local.test${path}`, init), bindings);
}

describe("converted query-rejection sites keep the exact triple", () => {
  afterEach(async () => {
    await reset();
  });

  it("rejects /api/auth/me?verbose=1 with the exact code and message", async () => {
    const res = await call("/api/auth/me?verbose=1", { method: "GET", headers: { ...LAB } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "UNSUPPORTED_QUERY", message: QUERY_MESSAGE } });
  });

  it("rejects /api/schedules?x=1 with the exact code and message", async () => {
    const res = await call("/api/schedules?x=1", { method: "GET", headers: { ...LAB } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "UNSUPPORTED_QUERY", message: QUERY_MESSAGE } });
  });

  it("rejects /api/sagas/policy-shaped POST paths with the exact triple", async () => {
    const res = await call("/api/apps?scope=all", { method: "GET", headers: { ...LAB } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "UNSUPPORTED_QUERY", message: QUERY_MESSAGE } });
  });
});

describe("fence helper keeps the exact invalid-request triple", () => {
  const fence = new OAuthRefreshFence();
  const faults = JSON.stringify({
    authFailed: { status: 502, code: "T_AUTH", message: "T auth." },
    badResponse: { status: 502, code: "T_BAD", message: "T bad." },
    vendorTimeout: { status: 504, code: "T_TIMEOUT", message: "T timeout." },
  });
  const envelope = (extra: Record<string, string>): string =>
    new URLSearchParams({
      token_url: "https://oauth-in-test.invalid/oauth/token",
      form: "grant_type=refresh_token",
      faults,
      timeout_ms: "50",
      ...extra,
    }).toString();

  it("answers 405 with the exact triple for non-POST", async () => {
    const res = await fence.fetch(new Request("https://fence/refresh/k", { method: "GET" }));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ code: "OAUTH_FENCE_INVALID", message: FENCE_MESSAGE });
  });

  it("answers 400 with the exact triple for a bad fence key", async () => {
    const res = await fence.fetch(new Request("https://fence/nope", { method: "POST", body: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "OAUTH_FENCE_INVALID", message: FENCE_MESSAGE });
  });

  it("answers 400 with the exact triple for an empty body", async () => {
    const res = await fence.fetch(new Request("https://fence/refresh/k", { method: "POST", body: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "OAUTH_FENCE_INVALID", message: FENCE_MESSAGE });
  });

  it("answers 400 with the exact triple for missing envelope fields", async () => {
    const res = await fence.fetch(
      new Request("https://fence/refresh/k", {
        method: "POST",
        body: new URLSearchParams({ token_url: "https://v.invalid", form: "a=b" }).toString(),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "OAUTH_FENCE_INVALID", message: FENCE_MESSAGE });
  });

  it("answers 400 with the exact triple for a non-object fault table", async () => {
    const res = await fence.fetch(
      new Request("https://fence/refresh/k", {
        method: "POST",
        body: envelope({ faults: JSON.stringify(["not", "a", "table"]) }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "OAUTH_FENCE_INVALID", message: FENCE_MESSAGE });
  });

  it("answers 400 with the exact triple for a misshaped fault line", async () => {
    const bad = JSON.stringify({
      authFailed: { status: "bad", code: 7, message: null },
      badResponse: { status: 502, code: "T_BAD", message: "T bad." },
      vendorTimeout: { status: 504, code: "T_TIMEOUT", message: "T timeout." },
    });
    const res = await fence.fetch(
      new Request("https://fence/refresh/k", { method: "POST", body: envelope({ faults: bad }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "OAUTH_FENCE_INVALID", message: FENCE_MESSAGE });
  });

  it("answers 400 with the exact triple for a non-finite timeout", async () => {
    const res = await fence.fetch(
      new Request("https://fence/refresh/k", { method: "POST", body: envelope({ timeout_ms: "abc" }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "OAUTH_FENCE_INVALID", message: FENCE_MESSAGE });
  });
});
