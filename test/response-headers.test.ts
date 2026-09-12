// SPDX-License-Identifier: AGPL-3.0
// Baseline defense headers (issue #237): every user-facing response — JSON
// API, Static Assets pass-through, and raw file/byte responses — carries the
// same hardening baseline. Proven against real workerd with real D1.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import migration1 from "../migrations/0001_initial.sql?raw";
import migrationOrg from "../migrations/0007_org_membership.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);

function authed(path: string): Request {
  return new Request(`http://local.test${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

/** The issue #237 baseline every user-facing response must carry. */
function expectBaseline(response: Response, csp: string): void {
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
  expect(response.headers.get("Content-Security-Policy")).toBe(csp);
}

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const ASSET_CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migrationOrg);
});

afterEach(async () => {
  await reset();
});

it("carries the baseline on JSON API responses", async () => {
  const response = await worker.fetch(authed("/api/sagas"), bindings);
  expect(response.status).toBe(200);
  expectBaseline(response, API_CSP);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("carries the baseline on API error responses", async () => {
  const response = await worker.fetch(authed("/api/no-such-route"), bindings);
  expect(response.status).toBe(501);
  expectBaseline(response, API_CSP);
});

it("wraps the Static Assets pass-through with the UI-surface baseline", async () => {
  const asset = new Response("<html></html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  const withAssets = {
    ...bindings,
    ASSETS: { fetch: async () => asset } as unknown as Fetcher,
  };
  const response = await worker.fetch(new Request("http://local.test/"), withAssets);
  expect(response.status).toBe(200);
  expectBaseline(response, ASSET_CSP);
  // Caller-owned content type survives the wrap.
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(await response.text()).toBe("<html></html>");
});

it("never strips caller-owned cache and content headers", async () => {
  const response = await worker.fetch(authed("/api/sagas"), bindings);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
