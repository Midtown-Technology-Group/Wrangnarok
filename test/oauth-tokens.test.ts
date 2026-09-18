// SPDX-License-Identifier: AGPL-3.0
// OAUTH-01 persistence slice 1 (issue #149): encrypted per-Organization,
// per-Connection OAuth token + health rows (migration 0031) reusing the ADR
// 005 envelope/KEK path, with monotonic persisted generation fencing and no
// D1 transaction held across vendor HTTP. Real local D1 via the shared
// harness; only vendor OAuth HTTP is stubbed. Fixture sentinels only — never
// production credentials.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/bindings";
import { NINJA_INTEGRATION_ID } from "../src/domain";
import { createConnection, deleteConnection, getConnection } from "../src/connections";
import { clearOAuthInflight, isTokenUsable, type OAuthFaultTable } from "../src/oauth";
import { OAuthRefreshFence } from "../src/oauth-refresh-fence";
import {
  loadOAuthToken,
  readOAuthTokenState,
  recordOAuthTokenFailure,
  recordOAuthTokenRevoked,
  refreshPersistedOAuthToken,
  replaceOAuthToken,
  revokePersistedOAuthToken,
  storeInitialOAuthToken,
} from "../src/oauth-tokens";
import { clearAllExecutionSecrets, getExecutionSecrets } from "../src/secrets";
import { useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const caller = { orgId: ORG, userId: USER };
const KEK = "test-secrets-kek-sentinel-fixture-only";
const OTHER_KEK = "test-other-kek-sentinel-fixture-only";
const ACCESS = "test-oauth-access-sentinel-alpha";
const ACCESS_NEXT = "test-oauth-access-sentinel-beta";
const REFRESH = "test-oauth-refresh-sentinel-alpha";
const REFRESH_NEXT = "test-oauth-refresh-sentinel-beta";
const CLIENT_ID = "test-oauth-client-id";
const CLIENT_SECRET = "test-oauth-client-secret-sentinel";
const ENDPOINT = "https://oauth-in-test.invalid/api";
const TOKEN_PATH = "/oauth/token";
const REVOKE_PATH = "/oauth/revoke";
const AT = "2026-09-17T10:00:00.000Z";
const LATER = "2026-09-17T10:05:00.000Z";

const FAULTS: OAuthFaultTable = {
  notConfigured: { status: 502, code: "TEST_NOT_CONFIGURED", message: "Test credentials are not configured." },
  redirected: { status: 502, code: "TEST_AUTH_FAILED", message: "Test redirected the token request." },
  unauthorized: { status: 502, code: "TEST_UNAUTHORIZED", message: "Test rejected the credentials." },
  rateLimited: { status: 502, code: "TEST_RATE_LIMITED", message: "Test rate-limited the token request." },
  authFailed: { status: 502, code: "TEST_AUTH_FAILED", message: "Test did not issue a token." },
  badResponse: { status: 502, code: "TEST_BAD_RESPONSE", message: "Test returned an unexpected token response." },
  vendorTimeout: { status: 504, code: "TEST_VENDOR_TIMEOUT", message: "Test exceeded its deadline." },
};

function tokenJson(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface StubCall {
  readonly body: string;
}

/** Vendor stub: records every POST body, answers from a queue. */
function stubVendor(responses: Array<Response | ((body: string) => Response | Promise<Response>) | Error>) {
  const calls: StubCall[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ body });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(body);
    if (next !== undefined) return next;
    throw new Error("Unexpected extra vendor call");
  }) as typeof fetch;
  return { calls, fetchImpl };
}

useWorkflowHarness(bindings.DB);

beforeEach(async () => {
  await bindings.DB.prepare("DELETE FROM oauth_tokens WHERE org_id=?").bind(ORG).run();
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();
});

afterEach(() => {
  clearOAuthInflight();
  clearAllExecutionSecrets();
  vi.restoreAllMocks();
});

async function seedMapping() {
  const view = await createConnection(bindings.DB, caller, NINJA_INTEGRATION_ID, {
    config: { endpoint: "https://ninja-in-test.invalid/api" },
  });
  return view.id;
}

async function storedRows() {
  const found = await bindings.DB.prepare(
    "SELECT connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,refresh_ciphertext,refresh_nonce,refresh_wrapped_dek,key_version,algorithm,generation,scope,expires_at_ms,status,consecutive_failures,last_failure_code,last_success_at,checked_at FROM oauth_tokens",
  ).all<Record<string, unknown>>();
  return found.results;
}

function secretsOf(value: unknown): string {
  return JSON.stringify(value);
}

describe("initial store and ciphertext discipline (migration 0031)", () => {
  it("stores ciphertext only; state reads carry no secret material", async () => {
    const connectionId = await seedMapping();
    const state = await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      scope: "monitoring",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    expect(state).toMatchObject({ generation: 1, scope: "monitoring", health: { status: "healthy" } });
    // Non-secret state reads need no KEK and carry no values.
    const read = await readOAuthTokenState(bindings.DB, ORG, connectionId);
    expect(read).toMatchObject({ generation: 1, scope: "monitoring", health: { status: "healthy" } });
    expect(secretsOf(read)).not.toContain(ACCESS);
    expect(secretsOf(read)).not.toContain(REFRESH);
    // Decrypt round-trips both tokens for the owning org only.
    const loaded = await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK });
    expect(loaded).toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH, generation: 1 });
    expect(await loadOAuthToken(bindings.DB, OTHER_ORG, connectionId, { 1: KEK })).toBeNull();
    expect(await readOAuthTokenState(bindings.DB, OTHER_ORG, connectionId)).toBeNull();
    // D1 holds ciphertext only: no token value and no KEK anywhere.
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: ORG, key_version: 1, algorithm: "AES-GCM-256", generation: 1 });
    expect(secretsOf(rows)).not.toContain(ACCESS);
    expect(secretsOf(rows)).not.toContain(REFRESH);
    expect(secretsOf(rows)).not.toContain(KEK);
  });

  it("stores access-only tokens when the vendor rotates nothing", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const loaded = await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK });
    expect(loaded?.accessToken).toBe(ACCESS);
    expect(loaded?.refreshToken).toBeUndefined();
  });

  it("rejects a second initial store, bad inputs, and bad targets without writing", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await expect(
      storeInitialOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        accessToken: ACCESS_NEXT,
        kekMaterial: KEK,
        checkedAt: LATER,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_TOKEN_EXISTS" });
    await expect(
      storeInitialOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        accessToken: "",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_REQUEST_INVALID" });
    await expect(
      storeInitialOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        accessToken: ACCESS,
        scope: `x${"y".repeat(1024)}`,
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_SCOPE_INVALID" });
    await expect(
      storeInitialOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        accessToken: ACCESS,
        kekMaterial: undefined,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "SECRET_STORE_NOT_CONFIGURED" });
    await expect(
      storeInitialOAuthToken(bindings.DB, {
        orgId: OTHER_ORG,
        connectionId,
        accessToken: ACCESS,
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    // The one good row stands untouched by every rejected write.
    const loaded = await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK });
    expect(loaded).toMatchObject({ accessToken: ACCESS, generation: 1 });
  });

  it("rejects managed rows", async () => {
    await bindings.DB.prepare(
      "INSERT INTO connections(id,org_id,integration_id,endpoint,managed_by) VALUES (?,?,?,?,'test-bundle@1.0.0')",
    )
      .bind("00000000-0000-4000-8000-000000000311", ORG, NINJA_INTEGRATION_ID, "https://m.managed.invalid/api")
      .run();
    await expect(
      storeInitialOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId: "00000000-0000-4000-8000-000000000311",
        accessToken: ACCESS,
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MANAGED_RESOURCE" });
    expect(await storedRows()).toHaveLength(0);
  });

  it("fails closed on wrong KEK and tampered ciphertext", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await expect(loadOAuthToken(bindings.DB, ORG, connectionId, {})).rejects.toMatchObject({
      code: "OAUTH_TOKEN_UNREADABLE",
    });
    await expect(loadOAuthToken(bindings.DB, ORG, connectionId, { 1: OTHER_KEK })).rejects.toMatchObject({
      code: "OAUTH_TOKEN_UNREADABLE",
    });
    await bindings.DB.prepare(
      "UPDATE oauth_tokens SET access_ciphertext=access_ciphertext || 'AA' WHERE connection_id=?",
    )
      .bind(connectionId)
      .run();
    await expect(loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK })).rejects.toMatchObject({
      code: "OAUTH_TOKEN_UNREADABLE",
    });
  });

  it("treats a half-nulled refresh envelope as corrupt, never partial", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await bindings.DB.prepare("UPDATE oauth_tokens SET refresh_nonce=NULL WHERE connection_id=?")
      .bind(connectionId)
      .run();
    await expect(loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK })).rejects.toMatchObject({
      code: "OAUTH_TOKEN_UNREADABLE",
    });
  });
});

describe("replacement and generation fencing", () => {
  it("advances the generation with fresh envelopes and recovers health", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "TEST_UNAUTHORIZED", AT);
    const first = (await storedRows())[0]!;
    const replaced = await replaceOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      expectedGeneration: 1,
      accessToken: ACCESS_NEXT,
      refreshToken: REFRESH_NEXT,
      scope: "monitoring",
      kekMaterial: KEK,
      checkedAt: LATER,
    });
    expect(replaced).toMatchObject({
      generation: 2,
      health: { status: "healthy", consecutiveFailures: 0, lastSuccessAt: LATER },
    });
    const second = (await storedRows())[0]!;
    expect(second.generation).toBe(2);
    expect(second.access_nonce).not.toBe(first.access_nonce);
    expect(second.access_ciphertext).not.toBe(first.access_ciphertext);
    const loaded = await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK });
    expect(loaded).toMatchObject({ accessToken: ACCESS_NEXT, refreshToken: REFRESH_NEXT });
  });

  it("superseded generations cannot overwrite newer tokens", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await replaceOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      expectedGeneration: 1,
      accessToken: ACCESS_NEXT,
      refreshToken: REFRESH_NEXT,
      kekMaterial: KEK,
      checkedAt: LATER,
    });
    // The superseded generation 1 writer fails loud; the newer row stands.
    await expect(
      replaceOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        expectedGeneration: 1,
        accessToken: "test-oauth-stale-sentinel",
        kekMaterial: KEK,
        checkedAt: LATER,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_TOKEN_GENERATION_STALE" });
    const loaded = await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK });
    expect(loaded).toMatchObject({ accessToken: ACCESS_NEXT, generation: 2 });
    expect(secretsOf(await storedRows())).not.toContain("test-oauth-stale-sentinel");
  });

  it("validates replacement inputs before touching D1", async () => {
    const connectionId = await seedMapping();
    await expect(
      replaceOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        expectedGeneration: 0,
        accessToken: ACCESS,
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_REQUEST_INVALID" });
    await expect(
      replaceOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId: "00000000-0000-4000-8000-000000000399",
        expectedGeneration: 1,
        accessToken: ACCESS,
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    // Mapping exists but no token row: honest 404, never a blind insert.
    await expect(
      replaceOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        expectedGeneration: 1,
        accessToken: ACCESS,
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_TOKEN_NOT_FOUND" });
  });
});

describe("persisted health lifecycle", () => {
  it("persists failed, recovered, and revoked transitions honestly", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const failed = await recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "TEST_UNAUTHORIZED", LATER);
    expect(failed).toMatchObject({ status: "failed", consecutiveFailures: 1, lastFailureCode: "TEST_UNAUTHORIZED" });
    const failedAgain = await recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "TEST_RATE_LIMITED", LATER);
    expect(failedAgain).toMatchObject({ consecutiveFailures: 2, lastFailureCode: "TEST_RATE_LIMITED" });
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      health: { status: "failed", consecutiveFailures: 2 },
    });
    // A successful replacement recovers visibly.
    await replaceOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      expectedGeneration: 1,
      accessToken: ACCESS_NEXT,
      refreshToken: REFRESH_NEXT,
      kekMaterial: KEK,
      checkedAt: LATER,
    });
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      health: { status: "healthy", consecutiveFailures: 0, lastSuccessAt: LATER },
    });
    const revoked = await recordOAuthTokenRevoked(bindings.DB, ORG, connectionId, LATER);
    expect(revoked.status).toBe("revoked");
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      health: { status: "revoked" },
    });
    // Health rows carry no token material.
    expect(secretsOf(await storedRows())).not.toContain(ACCESS);
  });

  it("rejects health writes with no token row or bad codes", async () => {
    const connectionId = await seedMapping();
    await expect(
      recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "TEST_UNAUTHORIZED", AT),
    ).rejects.toMatchObject({ code: "OAUTH_TOKEN_NOT_FOUND" });
    await expect(recordOAuthTokenRevoked(bindings.DB, ORG, connectionId, AT)).rejects.toMatchObject({
      code: "OAUTH_TOKEN_NOT_FOUND",
    });
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await expect(recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "", AT)).rejects.toMatchObject({
      code: "OAUTH_REQUEST_INVALID",
    });
  });
});

describe("persisted refresh rotation (no D1 across vendor HTTP)", () => {
  it("rotates end to end: one vendor POST, generation advance, recovery", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      scope: "monitoring",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const { calls, fetchImpl } = stubVendor([
      tokenJson({ access_token: ACCESS_NEXT, refresh_token: REFRESH_NEXT, expires_in: 3600 }),
    ]);
    const rotated = await refreshPersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      faults: FAULTS,
      keks: { 1: KEK },
      kekMaterial: KEK,
      executionId: "e".repeat(64),
      fetchImpl,
      checkedAt: LATER,
    });
    expect(rotated).toMatchObject({ rotated: true, refreshToken: REFRESH_NEXT, generation: 2 });
    expect(rotated.health).toMatchObject({ status: "healthy", lastSuccessAt: LATER });
    expect(rotated.token.expiresAtMs).toBeGreaterThan(Date.now());
    // The vendor saw exactly one POST submitting the stored refresh token
    // with the stored scope — the D1 read preceded it and the conditional
    // replacement write followed it, with no transaction across the call.
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH);
    expect(form.get("scope")).toBe("monitoring");
    // The replacement persisted; the old refresh token no longer resolves.
    const loaded = await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK });
    expect(loaded).toMatchObject({ accessToken: ACCESS_NEXT, refreshToken: REFRESH_NEXT, generation: 2 });
    expect(secretsOf(await storedRows())).not.toContain(REFRESH);
    // Transient values registered for write-time scrubbing, then dropped by
    // the caller (afterEach clears; the registry held them during the call).
    expect(getExecutionSecrets("e".repeat(64))).toContain(ACCESS_NEXT);
  });

  it("honors a scope override and the default vendor path", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      scope: "stored-scope",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    // Default vendor (no fetchImpl) rides the patched global fetch.
    const globalStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      expect(new URLSearchParams(body).get("scope")).toBe("override-scope");
      return tokenJson({ access_token: ACCESS_NEXT, refresh_token: REFRESH_NEXT });
    });
    try {
      const rotated = await refreshPersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "override-scope",
        credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        faults: FAULTS,
        keks: { 1: KEK },
        kekMaterial: KEK,
        tenantKey: "explicit-tenant",
      });
      expect(rotated.generation).toBe(2);
      expect(globalStub).toHaveBeenCalledTimes(1);
      expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({ scope: "override-scope" });
    } finally {
      globalStub.mockRestore();
    }
  });

  it("keeps the submitted token when the vendor does not rotate", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const { fetchImpl } = stubVendor([tokenJson({ access_token: ACCESS_NEXT })]);
    const rotated = await refreshPersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      faults: FAULTS,
      keks: { 1: KEK },
      kekMaterial: KEK,
      fetchImpl,
      checkedAt: LATER,
    });
    expect(rotated).toMatchObject({ rotated: false, refreshToken: REFRESH, generation: 2 });
    // No replacement refresh token was issued: the stored refresh envelope
    // is empty and the next rotation answers unavailable.
    expect((await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK }))?.refreshToken).toBeUndefined();
  });

  it("persists vendor Fault failures honestly; transport errors leave health alone", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const { fetchImpl: rejecting } = stubVendor([tokenJson({ error: "invalid_grant" }, 400)]);
    const dumped = JSON.stringify(
      await refreshPersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        faults: FAULTS,
        keks: { 1: KEK },
        kekMaterial: KEK,
        fetchImpl: rejecting,
        checkedAt: LATER,
      }).catch((error: unknown) => ({ code: (error as { code: string }).code })),
    );
    expect(JSON.parse(dumped)).toMatchObject({ code: "TEST_AUTH_FAILED" });
    expect(dumped).not.toContain(REFRESH);
    // The failure lifecycle persisted: failed with the vendor code, counted.
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      health: { status: "failed", consecutiveFailures: 1, lastFailureCode: "TEST_AUTH_FAILED" },
    });
    // A raw transport error is reachability-unknown: it propagates without
    // marking the credential failed. Recover first so the refresh reaches
    // the vendor instead of failing closed on the failed lifecycle above.
    await replaceOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      expectedGeneration: 1,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: LATER,
    });
    const { fetchImpl: broken } = stubVendor([new TypeError("connection reset")]);
    await expect(
      refreshPersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        faults: FAULTS,
        keks: { 1: KEK },
        kekMaterial: KEK,
        fetchImpl: broken,
        checkedAt: LATER,
      }),
    ).rejects.toThrow("connection reset");
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      health: { status: "healthy", consecutiveFailures: 0 },
    });
  });

  it("fails closed without a vendor call when unusable or refresh-less", async () => {
    const connectionId = await seedMapping();
    const { calls, fetchImpl } = stubVendor([]);
    await expect(
      refreshPersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        faults: FAULTS,
        keks: { 1: KEK },
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_TOKEN_NOT_FOUND" });
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await expect(
      refreshPersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        faults: FAULTS,
        keks: { 1: KEK },
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_REFRESH_UNAVAILABLE" });
    await recordOAuthTokenRevoked(bindings.DB, ORG, connectionId, LATER);
    const refused = await refreshPersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      faults: FAULTS,
      keks: { 1: KEK },
      kekMaterial: KEK,
      fetchImpl,
    }).catch((error: unknown) => error as { code: string; details: unknown });
    expect(refused).toMatchObject({ code: "OAUTH_TOKEN_UNUSABLE", details: { status: "revoked" } });
    expect(calls).toHaveLength(0);
  });

  it("serializes concurrent rotations: one vendor POST, loser observes stale", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vendorBodies: string[] = [];
    const { fetchImpl } = stubVendor([
      async (body) => {
        vendorBodies.push(body);
        await gate;
        return tokenJson({ access_token: ACCESS_NEXT, refresh_token: REFRESH_NEXT });
      },
    ]);
    const refresh = (): Promise<{ generation: number }> =>
      refreshPersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        faults: FAULTS,
        keks: { 1: KEK },
        kekMaterial: KEK,
        fetchImpl,
        checkedAt: LATER,
      });
    const pending = [refresh(), refresh()];
    // Both racers load generation 1 before either writes; the shared fence
    // flight submits the one-time token once.
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    const outcomes = await Promise.allSettled(pending);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(vendorBodies).toHaveLength(1);
    expect(new URLSearchParams(vendorBodies[0]).get("refresh_token")).toBe(REFRESH);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "OAUTH_TOKEN_GENERATION_STALE" });
    // The winner's replacement stands; both racers shared the one response
    // so the row holds the rotated pair either way.
    const loaded = await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK });
    expect(loaded).toMatchObject({ accessToken: ACCESS_NEXT, refreshToken: REFRESH_NEXT, generation: 2 });
  });

  it("rotates through the cross-instance fence without sharing across generations", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const namespace = {
      getByName: () => ({
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const url = input instanceof Request ? input.url : String(input);
          const body = input instanceof Request ? await input.text() : "";
          return new OAuthRefreshFence().fetch(new Request(url, { method: "POST", body }));
        },
      }),
    };
    const vendorTokens: string[] = [];
    const vendorStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (!url.startsWith("https://oauth-in-test.invalid/")) throw new Error(`Unexpected vendor call: ${url}`);
      vendorTokens.push(new URLSearchParams(body).get("refresh_token") ?? "");
      return tokenJson({
        access_token: `access-for-${vendorTokens.length}`,
        refresh_token: `next-${vendorTokens.length}`,
      });
    });
    try {
      const rotated = await refreshPersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        faults: FAULTS,
        keks: { 1: KEK },
        kekMaterial: KEK,
        fence: namespace,
        checkedAt: LATER,
      });
      expect(rotated.generation).toBe(2);
      expect(vendorTokens).toEqual([REFRESH]);
      expect(rotated.token.accessToken).toBe("access-for-1");
    } finally {
      vendorStub.mockRestore();
    }
  });
});

describe("persisted revocation", () => {
  it("revokes on vendor 2xx and keeps the Connection mapping", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const { calls, fetchImpl } = stubVendor([new Response(null, { status: 200 })]);
    const outcome = await revokePersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      revocationPath: REVOKE_PATH,
      keks: { 1: KEK },
      fetchImpl,
      executionId: "f".repeat(64),
      checkedAt: LATER,
    });
    expect(outcome).toMatchObject({ revoked: true, health: { status: "revoked" } });
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(calls[0]?.body ?? "").get("token")).toBe(ACCESS);
    // Revocation moves health only: the mapping and the ciphertext stand.
    expect(await getConnection(bindings.DB, caller, NINJA_INTEGRATION_ID)).toMatchObject({ id: connectionId });
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      health: { status: "revoked" },
    });
    expect(getExecutionSecrets("f".repeat(64))).toContain(ACCESS);
  });

  it("leaves health alone when the vendor rejects revocation", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const { fetchImpl } = stubVendor([tokenJson({ error: "unsupported_token" }, 400)]);
    await expect(
      revokePersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId,
        endpoint: ENDPOINT,
        revocationPath: REVOKE_PATH,
        keks: { 1: KEK },
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_REVOKE_FAILED" });
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      health: { status: "healthy" },
    });
    await expect(
      revokePersistedOAuthToken(bindings.DB, {
        orgId: ORG,
        connectionId: "00000000-0000-4000-8000-000000000399",
        endpoint: ENDPOINT,
        revocationPath: REVOKE_PATH,
        keks: { 1: KEK },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "OAUTH_TOKEN_NOT_FOUND" });
  });
});

describe("stale-generation health/revocation fencing (issue #149)", () => {
  it("a gen1 refresh failure landing after a gen2 replacement leaves gen2 healthy", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { fetchImpl } = stubVendor([
      async () => {
        entered();
        await gate;
        return tokenJson({ error: "invalid_grant" }, 400);
      },
    ]);
    const pending = refreshPersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      faults: FAULTS,
      keks: { 1: KEK },
      kekMaterial: KEK,
      fetchImpl,
      checkedAt: LATER,
    });
    // The gen1 refresh is inside vendor HTTP; land gen2 before it completes.
    await enteredGate;
    await replaceOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      expectedGeneration: 1,
      accessToken: ACCESS_NEXT,
      refreshToken: REFRESH_NEXT,
      kekMaterial: KEK,
      checkedAt: LATER,
    });
    release();
    // The stale failure observes the fencing authority, not the vendor fault;
    // gen2 stands untouched: healthy and usable with the replacement tokens.
    await expect(pending).rejects.toMatchObject({ code: "OAUTH_TOKEN_GENERATION_STALE" });
    const health = (await readOAuthTokenState(bindings.DB, ORG, connectionId))?.health;
    expect(health).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
    expect(health && isTokenUsable(health)).toBe(true);
    expect(await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK })).toMatchObject({
      accessToken: ACCESS_NEXT,
      refreshToken: REFRESH_NEXT,
      generation: 2,
    });
    expect(secretsOf(await storedRows())).not.toContain(REFRESH);
  });

  it("a gen1 vendor revocation landing after a gen2 replacement leaves gen2 usable", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { fetchImpl } = stubVendor([
      async () => {
        entered();
        await gate;
        return new Response(null, { status: 200 });
      },
    ]);
    const pending = revokePersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      revocationPath: REVOKE_PATH,
      keks: { 1: KEK },
      fetchImpl,
      checkedAt: LATER,
    });
    // The gen1 revocation is inside vendor HTTP; land gen2 before it returns.
    // The vendor only confirms revocation of the gen1 token, never gen2.
    await enteredGate;
    await replaceOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      expectedGeneration: 1,
      accessToken: ACCESS_NEXT,
      refreshToken: REFRESH_NEXT,
      kekMaterial: KEK,
      checkedAt: LATER,
    });
    release();
    await expect(pending).rejects.toMatchObject({ code: "OAUTH_TOKEN_GENERATION_STALE" });
    const health = (await readOAuthTokenState(bindings.DB, ORG, connectionId))?.health;
    expect(health).toMatchObject({ status: "healthy", consecutiveFailures: 0 });
    expect(health && isTokenUsable(health)).toBe(true);
    expect(await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK })).toMatchObject({
      accessToken: ACCESS_NEXT,
      generation: 2,
    });
  });

  it("a revoke landing before a concurrent same-generation failure keeps revoked", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshEntered!: () => void;
    const refreshEnteredGate = new Promise<void>((resolve) => {
      refreshEntered = resolve;
    });
    let releaseRevoke!: () => void;
    const revokeGate = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    let revokeEntered!: () => void;
    const revokeEnteredGate = new Promise<void>((resolve) => {
      revokeEntered = resolve;
    });
    const { fetchImpl: refreshFetch } = stubVendor([
      async () => {
        refreshEntered();
        await refreshGate;
        return tokenJson({ error: "invalid_grant" }, 400);
      },
    ]);
    const { fetchImpl: revokeFetch } = stubVendor([
      async () => {
        revokeEntered();
        await revokeGate;
        return new Response(null, { status: 200 });
      },
    ]);
    // Both operations read generation 1 healthy before either vendor call
    // lands: the Durable Object fence serializes refresh flights, not a
    // refresh overlapping a revocation.
    const pendingRefresh = refreshPersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      faults: FAULTS,
      keks: { 1: KEK },
      kekMaterial: KEK,
      fetchImpl: refreshFetch,
      checkedAt: LATER,
    });
    const pendingRevoke = revokePersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      revocationPath: REVOKE_PATH,
      keks: { 1: KEK },
      fetchImpl: revokeFetch,
      checkedAt: LATER,
    });
    await refreshEnteredGate;
    await revokeEnteredGate;
    releaseRevoke();
    await expect(pendingRevoke).resolves.toMatchObject({ revoked: true });
    releaseRefresh();
    // Same generation, so this is a health conflict, not a stale generation:
    // the vendor failure still reports to its own caller, the committed
    // revoked status wins, and the losing failure records its outcome as
    // diagnostic metadata on the revoked row (issue #451).
    await expect(pendingRefresh).rejects.toMatchObject({ code: "TEST_AUTH_FAILED" });
    const health = (await readOAuthTokenState(bindings.DB, ORG, connectionId))?.health;
    expect(health).toMatchObject({
      status: "revoked",
      consecutiveFailures: 1,
      lastFailureCode: "TEST_AUTH_FAILED",
    });
    expect(health && isTokenUsable(health)).toBe(false);
  });

  it("a revoke landing after a concurrent same-generation failure preserves its metadata", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshEntered!: () => void;
    const refreshEnteredGate = new Promise<void>((resolve) => {
      refreshEntered = resolve;
    });
    let releaseRevoke!: () => void;
    const revokeGate = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    let revokeEntered!: () => void;
    const revokeEnteredGate = new Promise<void>((resolve) => {
      revokeEntered = resolve;
    });
    const { fetchImpl: refreshFetch } = stubVendor([
      async () => {
        refreshEntered();
        await refreshGate;
        return tokenJson({ error: "invalid_grant" }, 400);
      },
    ]);
    const { fetchImpl: revokeFetch } = stubVendor([
      async () => {
        revokeEntered();
        await revokeGate;
        return new Response(null, { status: 200 });
      },
    ]);
    const pendingRefresh = refreshPersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      faults: FAULTS,
      keks: { 1: KEK },
      kekMaterial: KEK,
      fetchImpl: refreshFetch,
      checkedAt: LATER,
    });
    const pendingRevoke = revokePersistedOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      endpoint: ENDPOINT,
      revocationPath: REVOKE_PATH,
      keks: { 1: KEK },
      fetchImpl: revokeFetch,
      checkedAt: LATER,
    });
    await refreshEnteredGate;
    await revokeEnteredGate;
    releaseRefresh();
    await expect(pendingRefresh).rejects.toMatchObject({ code: "TEST_AUTH_FAILED" });
    releaseRevoke();
    await expect(pendingRevoke).resolves.toMatchObject({ revoked: true });
    // The vendor confirmed revocation of this generation, so revoked stands —
    // but with the committed failure diagnostics, not the pre-vendor read's.
    const health = (await readOAuthTokenState(bindings.DB, ORG, connectionId))?.health;
    expect(health).toMatchObject({
      status: "revoked",
      consecutiveFailures: 1,
      lastFailureCode: "TEST_AUTH_FAILED",
    });
    expect(health && isTokenUsable(health)).toBe(false);
  });

  it("conditional health writes reject stale generations without touching the row", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await replaceOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      expectedGeneration: 1,
      accessToken: ACCESS_NEXT,
      refreshToken: REFRESH_NEXT,
      kekMaterial: KEK,
      checkedAt: LATER,
    });
    await expect(
      recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "TEST_UNAUTHORIZED", LATER, 1),
    ).rejects.toMatchObject({ code: "OAUTH_TOKEN_GENERATION_STALE" });
    await expect(recordOAuthTokenRevoked(bindings.DB, ORG, connectionId, LATER, 1)).rejects.toMatchObject({
      code: "OAUTH_TOKEN_GENERATION_STALE",
    });
    // The gen2 row stands exactly as the replacement left it.
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      generation: 2,
      health: { status: "healthy", consecutiveFailures: 0 },
    });
  });
});

describe("same-generation health-write ordering (issue #451)", () => {
  async function seedHealthy() {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    return connectionId;
  }

  it("a failure losing to committed revoked merges diagnostics and keeps revoked", async () => {
    const connectionId = await seedHealthy();
    // Both writers read generation 1 healthy before either lands.
    const observed = (await readOAuthTokenState(bindings.DB, ORG, connectionId))?.health;
    expect(observed).toMatchObject({ status: "healthy" });
    // Revocation lands first: terminal status, no diagnostics to preserve yet.
    const revoked = await recordOAuthTokenRevoked(bindings.DB, ORG, connectionId, LATER, 1);
    expect(revoked).toMatchObject({ status: "revoked", consecutiveFailures: 0 });
    // The stale failure lands second on the same generation: revoked wins
    // the status, but the loser records its outcome as diagnostics and the
    // authoritative reread is returned (no new outcome, no stale throw).
    const merged = await recordOAuthTokenFailure(
      bindings.DB,
      ORG,
      connectionId,
      "TEST_AUTH_FAILED",
      LATER,
      1,
      observed,
    );
    expect(merged).toMatchObject({
      status: "revoked",
      consecutiveFailures: 1,
      lastFailureCode: "TEST_AUTH_FAILED",
    });
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      generation: 1,
      health: { status: "revoked", consecutiveFailures: 1, lastFailureCode: "TEST_AUTH_FAILED" },
    });
    expect(isTokenUsable(merged)).toBe(false);
  });

  it("a revocation landing after a failure preserves its counters and code", async () => {
    const connectionId = await seedHealthy();
    await recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "TEST_AUTH_FAILED", LATER, 1);
    // Same generation, so the revocation applies: terminal status with the
    // committed failure diagnostics preserved, never restored over.
    const revoked = await recordOAuthTokenRevoked(bindings.DB, ORG, connectionId, LATER, 1);
    expect(revoked).toMatchObject({
      status: "revoked",
      consecutiveFailures: 1,
      lastFailureCode: "TEST_AUTH_FAILED",
    });
    expect(isTokenUsable(revoked)).toBe(false);
  });

  it("concurrent same-generation failures accumulate instead of dropping", async () => {
    const connectionId = await seedHealthy();
    const observed = (await readOAuthTokenState(bindings.DB, ORG, connectionId))?.health;
    const first = await recordOAuthTokenFailure(bindings.DB, ORG, connectionId, "TEST_AUTH_FAILED", LATER, 1, observed);
    expect(first).toMatchObject({ status: "failed", consecutiveFailures: 1 });
    // Second failure computed from the same superseded healthy read: the
    // status is already failed, so the loser merges its count and code.
    const second = await recordOAuthTokenFailure(
      bindings.DB,
      ORG,
      connectionId,
      "TEST_RATE_LIMITED",
      LATER,
      1,
      observed,
    );
    expect(second).toMatchObject({
      status: "failed",
      consecutiveFailures: 2,
      lastFailureCode: "TEST_RATE_LIMITED",
    });
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toMatchObject({
      generation: 1,
      health: { status: "failed", consecutiveFailures: 2, lastFailureCode: "TEST_RATE_LIMITED" },
    });
  });
});

describe("token lifecycle beside the Connection lifecycle", () => {
  it("deletes stored tokens with the mapping", async () => {
    const connectionId = await seedMapping();
    await storeInitialOAuthToken(bindings.DB, {
      orgId: ORG,
      connectionId,
      accessToken: ACCESS,
      refreshToken: REFRESH,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    expect(await storedRows()).toHaveLength(1);
    await deleteConnection(bindings.DB, caller, NINJA_INTEGRATION_ID);
    expect(await storedRows()).toHaveLength(0);
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toBeNull();
  });

  it("tolerates pre-0031 chains: loads resolve null, deletes skip", async () => {
    const connectionId = await seedMapping();
    await bindings.DB.exec("DROP TABLE oauth_tokens");
    expect(await loadOAuthToken(bindings.DB, ORG, connectionId, { 1: KEK })).toBeNull();
    expect(await readOAuthTokenState(bindings.DB, ORG, connectionId)).toBeNull();
    await deleteConnection(bindings.DB, caller, NINJA_INTEGRATION_ID);
    await expect(getConnection(bindings.DB, caller, NINJA_INTEGRATION_ID)).rejects.toMatchObject({
      code: "CONNECTION_NOT_FOUND",
    });
  });
});
