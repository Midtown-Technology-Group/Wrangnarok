// SPDX-License-Identifier: AGPL-3.0
// OAUTH-01 (issue #149): centralized OAuth token primitive, auth-code/PKCE
// contract, audience/scope replacement semantics, rotating-refresh fencing,
// and the non-secret health lifecycle. Pure unit coverage plus a mocked
// vendor token endpoint — vendor OAuth HTTP is the only seam; no D1, no
// Workflows, no token persistence anywhere (SEC-02 stays shut).
// Fixture secrets only — never production credentials.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Fault } from "../src/domain";
import {
  buildAuthorizationUrl,
  clearOAuthInflight,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  initialTokenHealth,
  isTokenExpired,
  isTokenUsable,
  OAUTH_EXPIRY_SKEW_MS,
  parseOAuthCallback,
  recordTokenFailure,
  recordTokenRevoked,
  recordTokenSuccess,
  refreshRotatingToken,
  requestClientCredentialsToken,
  resolveTokenScope,
  resolveTokenUrl,
  revokeOAuthToken,
} from "../src/oauth";
import type { OAuthFaultTable, OAuthRefreshFenceBinding, OAuthToken, RefreshTokenRequest } from "../src/oauth";
import { OAuthRefreshFence } from "../src/oauth-refresh-fence";

const SECRET_SENTINEL = "test-oauth-client-secret-sentinel";
const CLIENT_ID = "test-oauth-client-id";
const TOKEN_SENTINEL = "test-oauth-access-token-sentinel";
const REFRESH_SENTINEL = "test-oauth-refresh-token-sentinel";
const ENDPOINT = "https://oauth-in-test.invalid/api";
const TOKEN_PATH = "/oauth/token";

const FAULTS: OAuthFaultTable = {
  notConfigured: { status: 502, code: "TEST_NOT_CONFIGURED", message: "Test credentials are not configured." },
  redirected: { status: 502, code: "TEST_AUTH_FAILED", message: "Test redirected the token request." },
  unauthorized: { status: 502, code: "TEST_UNAUTHORIZED", message: "Test rejected the credentials." },
  rateLimited: { status: 502, code: "TEST_RATE_LIMITED", message: "Test rate-limited the token request." },
  authFailed: { status: 502, code: "TEST_AUTH_FAILED", message: "Test did not issue a token." },
  badResponse: { status: 502, code: "TEST_BAD_RESPONSE", message: "Test returned an unexpected token response." },
  vendorTimeout: { status: 504, code: "TEST_VENDOR_TIMEOUT", message: "Test exceeded its deadline." },
};

interface SeenCall {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

function tokenJson(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Vendor stub: records every call, answers token POSTs from a queue. */
function stubVendor(responses: Array<Response | ((call: SeenCall) => Response | Promise<Response>) | Error>) {
  const calls: SeenCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers as HeadersInit).entries()) headers[key] = value;
    }
    const call: SeenCall = { url, body, headers };
    calls.push(call);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(call);
    if (next !== undefined) return next;
    throw new Error(`Unexpected extra vendor call: ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function faultJson(error: unknown): string {
  expect(error).toBeInstanceOf(Fault);
  const fault = error as Fault;
  return JSON.stringify({ status: fault.status, code: fault.code, message: fault.message });
}

afterEach(() => {
  clearOAuthInflight();
  vi.restoreAllMocks();
});

describe("client-credentials token acquisition", () => {
  it("fetches one transient token with the pinned grant shape", async () => {
    const { calls, fetchImpl } = stubVendor([
      tokenJson({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" }),
    ]);
    const token = await requestClientCredentialsToken({
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      scope: "monitoring",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    });
    expect(token.accessToken).toBe(TOKEN_SENTINEL);
    expect(token.tokenType).toBe("Bearer");
    expect(token.expiresIn).toBe(3600);
    expect(token.expiresAtMs).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oauth-in-test.invalid/oauth/token");
    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("scope")).toBe("monitoring");
  });

  it("defaults a missing token type to Bearer", async () => {
    const { fetchImpl } = stubVendor([tokenJson({ access_token: TOKEN_SENTINEL })]);
    const token = await requestClientCredentialsToken({
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      scope: "monitoring",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    });
    expect(token.tokenType).toBe("Bearer");
    expect(token.expiresAtMs).toBeUndefined();
  });

  it("fails closed on missing credentials without touching the vendor", async () => {
    const { calls, fetchImpl } = stubVendor([]);
    const dumped = faultJson(
      await requestClientCredentialsToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: "", clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl,
      }).catch((error: unknown) => error),
    );
    expect(JSON.parse(dumped)).toMatchObject({ status: 502, code: "TEST_NOT_CONFIGURED" });
    expect(calls).toHaveLength(0);
  });

  it("maps 401/429/redirect/generic failures without copying vendor bodies", async () => {
    const cases: Array<{ status: number; code: string; body: unknown }> = [
      { status: 401, code: "TEST_UNAUTHORIZED", body: { error: "invalid_client", hint: SECRET_SENTINEL } },
      { status: 429, code: "TEST_RATE_LIMITED", body: { error: "rate_limited_exotic" } },
      { status: 302, code: "TEST_AUTH_FAILED", body: { relocated: true } },
      { status: 500, code: "TEST_AUTH_FAILED", body: { error: "server_broke" } },
      { status: 400, code: "TEST_AUTH_FAILED", body: { error: "invalid_grant" } },
    ];
    for (const { status, code, body } of cases) {
      const { calls, fetchImpl } = stubVendor([tokenJson(body, status)]);
      const dumped = faultJson(
        await requestClientCredentialsToken({
          endpoint: ENDPOINT,
          tokenPath: TOKEN_PATH,
          scope: "monitoring",
          credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
          faults: FAULTS,
          fetchImpl,
        }).catch((error: unknown) => error),
      );
      expect(JSON.parse(dumped)).toMatchObject({ code });
      expect(dumped).not.toContain(SECRET_SENTINEL);
      expect(dumped).not.toContain("invalid_client");
      expect(dumped).not.toContain("rate_limited_exotic");
      expect(calls).toHaveLength(1);
    }
  });

  it("rejects unshaped token bodies without copying them", async () => {
    for (const body of [[], null, {}, { access_token: "" }, { refresh_token: "orphan" }]) {
      const { fetchImpl } = stubVendor([tokenJson(body)]);
      const dumped = faultJson(
        await requestClientCredentialsToken({
          endpoint: ENDPOINT,
          tokenPath: TOKEN_PATH,
          scope: "monitoring",
          credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
          faults: FAULTS,
          fetchImpl,
        }).catch((error: unknown) => error),
      );
      expect(JSON.parse(dumped)).toMatchObject({ code: "TEST_BAD_RESPONSE" });
      expect(dumped).not.toContain(SECRET_SENTINEL);
    }
  });

  it("rejects non-JSON vendor bodies as transport-shape faults", async () => {
    const { fetchImpl } = stubVendor([tokenJson("not json{{{")]);
    await expect(
      requestClientCredentialsToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_JSON" });
  });

  it("propagates transport-shape faults and raw transport errors", async () => {
    const { fetchImpl: tooLarge } = stubVendor([tokenJson({ access_token: `x${"y".repeat(5000)}` })]);
    await expect(
      requestClientCredentialsToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl: tooLarge,
      }),
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });

    const { fetchImpl: slow } = stubVendor([new DOMException("timed out", "TimeoutError")]);
    await expect(
      requestClientCredentialsToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl: slow,
      }),
    ).rejects.toMatchObject({ status: 504, code: "TEST_VENDOR_TIMEOUT" });

    const { fetchImpl: broken } = stubVendor([new TypeError("connection reset")]);
    await expect(
      requestClientCredentialsToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl: broken,
      }),
    ).rejects.toThrow("connection reset");
  });

  it("rejects an endpoint that cannot form a token URL before any fetch", async () => {
    const { calls, fetchImpl } = stubVendor([]);
    await expect(
      requestClientCredentialsToken({
        endpoint: "not a url at all",
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "INVALID_OAUTH_ENDPOINT" });
    expect(calls).toHaveLength(0);
    expect(resolveTokenUrl(ENDPOINT, TOKEN_PATH)).toBe("https://oauth-in-test.invalid/oauth/token");
  });

  it.each(["//attacker.invalid/token", "///attacker.invalid/token", "/\\\\attacker.invalid/token"])(
    "rejects cross-origin token reference %s before any fetch",
    async (tokenPath) => {
      const { calls, fetchImpl } = stubVendor([]);
      await expect(
        requestClientCredentialsToken({
          endpoint: ENDPOINT,
          tokenPath,
          scope: "monitoring",
          credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
          faults: FAULTS,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: "INVALID_OAUTH_ENDPOINT" });
      expect(calls).toHaveLength(0);
    },
  );
});

describe("single-flight concurrency fencing (upstream PR #741 equivalent)", () => {
  it("coalesces concurrent client-credentials fetches into one vendor POST", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = stubVendor([
      async () => {
        await gate;
        return tokenJson({ access_token: TOKEN_SENTINEL, expires_in: 60 });
      },
    ]);
    const request = (): Promise<OAuthToken> =>
      requestClientCredentialsToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl,
      });
    const pending = [request(), request(), request(), request(), request(), request(), request(), request()];
    await Promise.resolve();
    release();
    const tokens = await Promise.all(pending);
    // The vendor sees exactly one POST; every waiter shares the one response.
    expect(calls).toHaveLength(1);
    for (const token of tokens) expect(token.accessToken).toBe(TOKEN_SENTINEL);
  });

  it("fences by scope and releases the fence after settle", async () => {
    const { calls, fetchImpl } = stubVendor([
      tokenJson({ access_token: "scope-a-token" }),
      tokenJson({ access_token: "scope-b-token" }),
      tokenJson({ access_token: "scope-a-again" }),
    ]);
    const base = {
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    };
    const [first, second] = await Promise.all([
      requestClientCredentialsToken({ ...base, scope: "scope-a" }),
      requestClientCredentialsToken({ ...base, scope: "scope-b" }),
    ]);
    expect(first.accessToken).toBe("scope-a-token");
    expect(second.accessToken).toBe("scope-b-token");
    // Fence released: a later request for scope-a fetches again, not the stale share.
    const third = await requestClientCredentialsToken({ ...base, scope: "scope-a" });
    expect(third.accessToken).toBe("scope-a-again");
    expect(calls).toHaveLength(3);
  });

  it("shares one rejection across racers, then lets the next request retry", async () => {
    const { calls, fetchImpl } = stubVendor([
      tokenJson({ error: "invalid_client" }, 401),
      tokenJson({ access_token: TOKEN_SENTINEL }),
    ]);
    const request = (): Promise<OAuthToken> =>
      requestClientCredentialsToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        scope: "monitoring",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl,
      });
    const outcomes = await Promise.allSettled([request(), request(), request()]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(calls).toHaveLength(1);
    // The failed fence does not poison later requests.
    const recovered = await request();
    expect(recovered.accessToken).toBe(TOKEN_SENTINEL);
    expect(calls).toHaveLength(2);
  });

  it("never evicts a newer fence entry when an older flight settles late", async () => {
    // The cleanup guard (inflight.get(key) identity check) matters when an
    // entry is replaced mid-flight: an older flight settling late must not
    // delete the newer entry. Through the public API plus the suite-isolation
    // hook: start flight A, replace its entry with flight B for the same key,
    // settle A — B must still resolve from its own vendor call.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { calls, fetchImpl } = stubVendor([
      async () => {
        await firstGate;
        return tokenJson({ access_token: "older-flight-token" });
      },
      async () => tokenJson({ access_token: "newer-flight-token" }),
    ]);
    const base = {
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      scope: "evict-same",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    };
    const older = requestClientCredentialsToken(base);
    await Promise.resolve();
    clearOAuthInflight();
    const newer = requestClientCredentialsToken(base);
    const newerToken = await newer;
    expect(newerToken.accessToken).toBe("newer-flight-token");
    releaseFirst();
    const olderToken = await older;
    expect(olderToken.accessToken).toBe("older-flight-token");
    expect(calls).toHaveLength(2);
  });
});

describe("rotating refresh (one-time refresh tokens submit exactly once)", () => {
  it("serializes a five-way 401 retry race into one vendor refresh", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = stubVendor([
      async (call) => {
        await gate;
        expect(new URLSearchParams(call.body).get("refresh_token")).toBe(REFRESH_SENTINEL);
        return tokenJson({ access_token: "rotated-access", refresh_token: "rotated-refresh-next" });
      },
    ]);
    const request = () =>
      refreshRotatingToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        refreshToken: REFRESH_SENTINEL,
        tenantKey: "org-tenant-1",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl,
      });
    const pending = [request(), request(), request(), request(), request()];
    await Promise.resolve();
    release();
    const results = await Promise.all(pending);
    expect(calls).toHaveLength(1);
    for (const result of results) {
      expect(result.rotated).toBe(true);
      expect(result.token.accessToken).toBe("rotated-access");
      expect(result.refreshToken).toBe("rotated-refresh-next");
    }
  });

  it("chains the replacement token on the next round and fences per tenant", async () => {
    const { calls, fetchImpl } = stubVendor([
      tokenJson({ access_token: "round-2-access", refresh_token: "round-3-refresh" }),
      tokenJson({ access_token: "other-tenant-access", refresh_token: "other-tenant-next" }),
    ]);
    const first = await refreshRotatingToken({
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      refreshToken: "round-2-refresh",
      tenantKey: "org-tenant-1",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    });
    // The replacement token is what the next round submits — selection always
    // follows the latest persisted tenant token, never a stale copy.
    expect(new URLSearchParams(calls[0]?.body ?? "").get("refresh_token")).toBe("round-2-refresh");
    const second = await refreshRotatingToken({
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      refreshToken: first.refreshToken,
      tenantKey: "other-tenant-9",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    });
    expect(new URLSearchParams(calls[1]?.body ?? "").get("refresh_token")).toBe("round-3-refresh");
    expect(second.token.accessToken).toBe("other-tenant-access");
    expect(calls).toHaveLength(2);
  });

  it("keeps the submitted token when the vendor does not rotate", async () => {
    const { calls, fetchImpl } = stubVendor([tokenJson({ access_token: TOKEN_SENTINEL })]);
    const result = await refreshRotatingToken({
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      refreshToken: REFRESH_SENTINEL,
      tenantKey: "org-tenant-1",
      scope: "monitoring",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    });
    expect(result.rotated).toBe(false);
    expect(result.refreshToken).toBe(REFRESH_SENTINEL);
    expect(new URLSearchParams(calls[0]?.body ?? "").get("scope")).toBe("monitoring");
  });

  it("fails invalid_grant loud without copying vendor text", async () => {
    const { calls, fetchImpl } = stubVendor([tokenJson({ error: "invalid_grant", detail: SECRET_SENTINEL }, 400)]);
    const dumped = faultJson(
      await refreshRotatingToken({
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        refreshToken: "dead-refresh-token",
        tenantKey: "org-tenant-1",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fetchImpl,
      }).catch((error: unknown) => error),
    );
    expect(JSON.parse(dumped)).toMatchObject({ code: "TEST_AUTH_FAILED" });
    expect(dumped).not.toContain(SECRET_SENTINEL);
    expect(dumped).not.toContain("invalid_grant");
    expect(calls).toHaveLength(1);
  });

  it("validates inputs before any vendor call", async () => {
    const { calls, fetchImpl } = stubVendor([]);
    const base = {
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      tenantKey: "org-tenant-1",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    };
    await expect(refreshRotatingToken({ ...base, refreshToken: "" })).rejects.toMatchObject({
      code: "OAUTH_REQUEST_INVALID",
    });
    await expect(
      refreshRotatingToken({ ...base, refreshToken: REFRESH_SENTINEL, tenantKey: "" }),
    ).rejects.toMatchObject({ code: "OAUTH_REQUEST_INVALID" });
    await expect(
      refreshRotatingToken({
        ...base,
        refreshToken: REFRESH_SENTINEL,
        credentials: { clientId: "", clientSecret: "" },
      }),
    ).rejects.toMatchObject({ code: "TEST_NOT_CONFIGURED" });
    await expect(
      refreshRotatingToken({ ...base, refreshToken: REFRESH_SENTINEL, generation: "../evil" }),
    ).rejects.toMatchObject({ code: "OAUTH_REQUEST_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("partitions concurrent refreshes by rotation generation", async () => {
    // A superseded generation reusing a rotated one-time token must never
    // coalesce onto the live generation's flight: distinct generations are
    // distinct fence keys, so the vendor sees one POST per generation.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = stubVendor([
      async (call) => {
        await gate;
        expect(new URLSearchParams(call.body).get("refresh_token")).toBe("live-refresh-v2");
        return tokenJson({ access_token: "live-access", refresh_token: "live-refresh-v3" });
      },
      async () => tokenJson({ access_token: "stale-access" }),
    ]);
    const base = {
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      tenantKey: "org-tenant-1",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    };
    const livePending = [
      refreshRotatingToken({ ...base, refreshToken: "live-refresh-v2", generation: "v2" }),
      refreshRotatingToken({ ...base, refreshToken: "live-refresh-v2", generation: "v2" }),
    ];
    await Promise.resolve();
    const stale = await refreshRotatingToken({ ...base, refreshToken: "live-refresh-v2", generation: "v1" });
    expect(stale.token.accessToken).toBe("stale-access");
    release();
    const live = await Promise.all(livePending);
    expect(calls).toHaveLength(2);
    for (const result of live) {
      expect(result.rotated).toBe(true);
      expect(result.refreshToken).toBe("live-refresh-v3");
    }
  });
});

describe("cross-instance refresh fence (issue #149 follow-up)", () => {
  /** Namespace double routing every fence key to one shared `OAuthRefreshFence`
   * instance — the test analogue of separate Worker instances resolving one
   * Durable Object stub per fence key. */
  function sharedFenceNamespace(instance: OAuthRefreshFence): OAuthRefreshFenceBinding {
    return {
      getByName: () => ({
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const url = input instanceof Request ? input.url : String(input);
          const body = input instanceof Request ? await input.text() : "";
          return instance.fetch(new Request(url, { method: "POST", body }));
        },
      }),
    };
  }

  it("serializes racers from isolated module copies into one vendor POST", async () => {
    // Regression target: racers must NOT share one module-global map, yet
    // still prove exactly one vendor refresh POST per tenant/generation. Each
    // racer imports its own oauth module copy (distinct `inflight` maps, the
    // separate-isolate analogue) and all copies share one fence object.
    const vendorCalls: SeenCall[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const namespace = sharedFenceNamespace(new OAuthRefreshFence());
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.startsWith("https://oauth-in-test.invalid/")) {
        vendorCalls.push({ url, body, headers: {} });
        await gate;
        return tokenJson({ access_token: "fenced-access", refresh_token: "fenced-refresh-next" });
      }
      throw new Error(`Unexpected fenced vendor call: ${url}`);
    }) as typeof fetch;
    try {
      // Isolated module copies: `vi.resetModules` plus distinct specifiers
      // gives each racer its own oauth module copy with its own module-global
      // `inflight` map — the separate-Worker-instance analogue. The queries
      // are Vite graph keys only; untyped dynamic imports keep tsc on the
      // plain specifier.
      const copyA = "../src/oauth.ts?fence=copy-a";
      const copyB = "../src/oauth.ts?fence=copy-b";
      vi.resetModules();
      const first = (await import(/* @vite-ignore */ copyA)) as typeof import("../src/oauth");
      vi.resetModules();
      const second = (await import(/* @vite-ignore */ copyB)) as typeof import("../src/oauth");
      expect(first.refreshRotatingToken).not.toBe(second.refreshRotatingToken);
      const base = {
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        refreshToken: REFRESH_SENTINEL,
        tenantKey: "org-tenant-fence",
        generation: "v7",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fence: namespace,
      } satisfies RefreshTokenRequest;
      const pending = [
        first.refreshRotatingToken({ ...base }),
        second.refreshRotatingToken({ ...base }),
        first.refreshRotatingToken({ ...base }),
        second.refreshRotatingToken({ ...base }),
        first.refreshRotatingToken({ ...base }),
      ];
      // Every copy cleared its own map mid-flight: without the shared fence
      // each copy would issue its own vendor POST.
      first.clearOAuthInflight();
      second.clearOAuthInflight();
      await Promise.resolve();
      release();
      const results = await Promise.all(pending);
      expect(vendorCalls).toHaveLength(1);
      expect(new URLSearchParams(vendorCalls[0]?.body ?? "").get("refresh_token")).toBe(REFRESH_SENTINEL);
      for (const result of results) {
        expect(result.rotated).toBe(true);
        expect(result.token.accessToken).toBe("fenced-access");
        expect(result.refreshToken).toBe("fenced-refresh-next");
      }
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });

  it("partitions fenced flights by generation and releases between rounds", async () => {
    const vendorCalls: string[] = [];
    const origFetch = globalThis.fetch;
    const namespace = sharedFenceNamespace(new OAuthRefreshFence());
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      vendorCalls.push(new URLSearchParams(body).get("refresh_token") ?? "");
      if (url.startsWith("https://oauth-in-test.invalid/")) {
        return tokenJson({
          access_token: `access-for-${vendorCalls.length}`,
          refresh_token: `next-${vendorCalls.length}`,
        });
      }
      throw new Error(`Unexpected fenced vendor call: ${url}`);
    }) as typeof fetch;
    try {
      const base = {
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fence: namespace,
      };
      const first = await refreshRotatingToken({
        ...base,
        refreshToken: "gen-v1-token",
        tenantKey: "t",
        generation: "v1",
      });
      const second = await refreshRotatingToken({
        ...base,
        refreshToken: "gen-v2-token",
        tenantKey: "t",
        generation: "v2",
      });
      expect(vendorCalls).toEqual(["gen-v1-token", "gen-v2-token"]);
      expect(first.token.accessToken).not.toBe(second.token.accessToken);
      // Fence released after settle: the next round for v1 fetches again.
      const third = await refreshRotatingToken({
        ...base,
        refreshToken: first.refreshToken,
        tenantKey: "t",
        generation: "v1",
      });
      expect(vendorCalls).toHaveLength(3);
      expect(vendorCalls[2]).toBe("next-1");
      expect(third.token.accessToken).toBe("access-for-3");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });

  it("codex #361: isolates concurrent rotations with different tokens", async () => {
    // Same fence key, different refresh bodies: the flights must NOT share
    // one vendor response, or caller B would receive tokens minted from
    // caller A's one-time token. Same body still coalesces (one POST).
    // Exercised at the fence object (the cross-instance unit): the
    // module-local single-flight in oauth.ts already keys on the full
    // (endpoint, tenant, generation, scope) identity, while the fence key
    // carries only (tenant, generation, scope-hash) — so two rotations with
    // different tokens converge on one fence key with different bodies.
    const vendorCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fence = new OAuthRefreshFence();
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.startsWith("https://oauth-in-test.invalid/")) {
        const seenToken = new URLSearchParams(body).get("refresh_token") ?? "";
        vendorCalls.push(seenToken);
        await gate;
        return tokenJson({ access_token: `access-for-${seenToken}`, refresh_token: `next-${seenToken}` });
      }
      throw new Error(`Unexpected fenced vendor call: ${url}`);
    }) as typeof fetch;
    const envelopeFor = (refreshToken: string): string =>
      new URLSearchParams({
        token_url: "https://oauth-in-test.invalid/oauth/token",
        form: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
        faults: JSON.stringify({
          authFailed: FAULTS.authFailed,
          badResponse: FAULTS.badResponse,
          vendorTimeout: FAULTS.vendorTimeout,
        }),
        timeout_ms: "5000",
      }).toString();
    try {
      const pending = [
        fence.fetch(
          new Request("https://fence/refresh/t.v1.00000000", { method: "POST", body: envelopeFor("token-A") }),
        ),
        fence.fetch(
          new Request("https://fence/refresh/t.v1.00000000", { method: "POST", body: envelopeFor("token-B") }),
        ),
        fence.fetch(
          new Request("https://fence/refresh/t.v1.00000000", { method: "POST", body: envelopeFor("token-A") }),
        ),
      ];
      // Let all three racers register their flights before releasing the
      // vendor gate; otherwise the first settles before the others start.
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      const [first, second, third] = await Promise.all(pending);
      expect(vendorCalls.slice().sort()).toEqual(["token-A", "token-B"]);
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error("fence test expected three responses");
      }
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      const firstBody = (await first.json()) as { access_token: string };
      const secondBody = (await second.json()) as { access_token: string };
      const thirdBody = (await third.json()) as { access_token: string };
      expect(firstBody.access_token).toBe("access-for-token-A");
      expect(secondBody.access_token).toBe("access-for-token-B");
      expect(thirdBody.access_token).toBe("access-for-token-A");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });

  it("rejects malformed fence requests without touching the vendor", async () => {
    const fence = new OAuthRefreshFence();
    const vendorSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect((await fence.fetch(new Request("https://fence/refresh/k", { method: "GET" }))).status).toBe(405);
      expect((await fence.fetch(new Request("https://fence/nope", { method: "POST", body: "x" }))).status).toBe(400);
      expect((await fence.fetch(new Request("https://fence/refresh/k", { method: "POST", body: "" }))).status).toBe(
        400,
      );
      expect(
        (
          await fence.fetch(
            new Request("https://fence/refresh/k", {
              method: "POST",
              body: new URLSearchParams({ token_url: "https://v.invalid", form: "a=b" }).toString(),
            }),
          )
        ).status,
      ).toBe(400);
      // Non-object fault table and misshaped fault lines also fail closed.
      const badTable = new URLSearchParams({
        token_url: "https://v.invalid",
        form: "a=b",
        faults: JSON.stringify(["not", "a", "table"]),
        timeout_ms: "50",
      }).toString();
      expect(
        (await fence.fetch(new Request("https://fence/refresh/k", { method: "POST", body: badTable }))).status,
      ).toBe(400);
      const badLine = new URLSearchParams({
        token_url: "https://v.invalid",
        form: "a=b",
        faults: JSON.stringify({
          authFailed: { status: "bad", code: 7, message: null },
          badResponse: FAULTS.badResponse,
          vendorTimeout: FAULTS.vendorTimeout,
        }),
        timeout_ms: "50",
      }).toString();
      expect(
        (await fence.fetch(new Request("https://fence/refresh/k", { method: "POST", body: badLine }))).status,
      ).toBe(400);
      // AbortError (not just TimeoutError) maps to the vendor-timeout fault.
      const aborting = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("aborted", "AbortError"));
      try {
        const aborted = await fence.fetch(
          new Request("https://fence/refresh/abort-key", {
            method: "POST",
            body: new URLSearchParams({
              token_url: "https://oauth-in-test.invalid/oauth/token",
              form: "grant_type=refresh_token",
              faults: JSON.stringify({
                authFailed: FAULTS.authFailed,
                badResponse: FAULTS.badResponse,
                vendorTimeout: FAULTS.vendorTimeout,
              }),
              timeout_ms: "50",
            }).toString(),
          }),
        );
        expect(aborted.status).toBe(504);
        expect(await aborted.json()).toMatchObject({ code: "TEST_VENDOR_TIMEOUT" });
      } finally {
        aborting.mockRestore();
      }
      expect(vendorSpy).not.toHaveBeenCalled();
    } finally {
      vendorSpy.mockRestore();
    }
  });

  it("maps fence relay timeouts to the caller vendor-timeout fault", async () => {
    const fence = new OAuthRefreshFence();
    const slow = vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    try {
      const relayed = await fence.fetch(
        new Request("https://fence/refresh/k", {
          method: "POST",
          body: new URLSearchParams({
            token_url: "https://oauth-in-test.invalid/oauth/token",
            form: "grant_type=refresh_token",
            faults: JSON.stringify({
              authFailed: FAULTS.authFailed,
              badResponse: FAULTS.badResponse,
              vendorTimeout: FAULTS.vendorTimeout,
            }),
            timeout_ms: "50",
          }).toString(),
        }),
      );
      // The fence relays the abort as its mapped fault JSON, not a hang.
      expect(relayed.status).toBe(504);
      expect(await relayed.json()).toMatchObject({ code: "TEST_VENDOR_TIMEOUT" });
    } finally {
      slow.mockRestore();
    }
  });

  it("releases the fence after failures and maps malformed relays", async () => {
    const fence = new OAuthRefreshFence();
    const faultsBody = new URLSearchParams({
      token_url: "https://oauth-in-test.invalid/oauth/token",
      form: "grant_type=refresh_token",
      faults: JSON.stringify({
        authFailed: FAULTS.authFailed,
        badResponse: FAULTS.badResponse,
        vendorTimeout: FAULTS.vendorTimeout,
      }),
      timeout_ms: "50",
    }).toString();
    const post = (key: string, body: string): Request =>
      new Request(`https://fence/refresh/${key}`, { method: "POST", body });

    // Malformed fault table and timeout values fail closed before any fetch.
    const vendorSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const body of [
        new URLSearchParams({
          token_url: "https://v.invalid",
          form: "a=b",
          faults: "not-json",
          timeout_ms: "50",
        }).toString(),
        new URLSearchParams({
          token_url: "https://v.invalid",
          form: "a=b",
          faults: JSON.stringify({ authFailed: FAULTS.authFailed }),
          timeout_ms: "50",
        }).toString(),
        new URLSearchParams({
          token_url: "https://v.invalid",
          form: "a=b",
          faults: "{}",
          timeout_ms: "nope",
        }).toString(),
        new URLSearchParams({
          token_url: "https://v.invalid",
          form: "a=b",
          faults: JSON.stringify({
            authFailed: FAULTS.authFailed,
            badResponse: FAULTS.badResponse,
            vendorTimeout: FAULTS.vendorTimeout,
          }),
          timeout_ms: "99999",
        }).toString(),
        "x".repeat(9000),
      ]) {
        expect((await fence.fetch(post("edge", body))).status).toBe(400);
      }
      expect(vendorSpy).not.toHaveBeenCalled();
    } finally {
      vendorSpy.mockRestore();
    }

    // A raw transport failure propagates (not a fence fault), and the fence
    // releases so the next round fetches again.
    const broken = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection reset"));
    try {
      await expect(fence.fetch(post("flaky", faultsBody))).rejects.toThrow("connection reset");
    } finally {
      broken.mockRestore();
    }
    const recovering = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(tokenJson({ access_token: "recovered-access", refresh_token: "recovered-next" }));
    try {
      const retry = await fence.fetch(post("flaky", faultsBody));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ access_token: "recovered-access" });
    } finally {
      recovering.mockRestore();
    }

    // An oversized vendor body fails closed with the transport bound.
    const huge = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("x".repeat(5000), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    try {
      const oversized = await fence.fetch(post("huge", faultsBody));
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    } finally {
      huge.mockRestore();
    }
  });
});

describe("authorization-code exchange with PKCE", () => {
  it("mints a verifiable S256 PKCE pair and distinct states", async () => {
    const pair = await createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pair.verifier));
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const expected = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
    expect(pair.challenge).toBe(expected);
    expect(createOAuthState()).not.toBe(createOAuthState());
    expect(createOAuthState()).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it("templates the tenant entity and PKCE into the authorize URL", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizeEndpoint: "https://login-in-test.invalid/{tenant}/oauth/authorize",
        tenant: "contoso-tenant",
        clientId: CLIENT_ID,
        redirectUri: "https://app-in-test.invalid/oauth/callback",
        scope: "User.Read",
        state: "state-value-1",
        codeChallenge: "challenge-value-1",
        codeChallengeMethod: "S256",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://login-in-test.invalid/contoso-tenant/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value-1");
  });

  it("passes plain values through and pins the audience override", () => {
    // A PKCE challenge without an explicit method defaults to S256; an
    // audience without a scope override still resolves against the default.
    const pkceUrl = new URL(
      buildAuthorizationUrl({
        authorizeEndpoint: "https://login-in-test.invalid/oauth/authorize",
        clientId: CLIENT_ID,
        redirectUri: "https://app-in-test.invalid/oauth/callback",
        scope: "User.Read",
        state: "state-pkce-default",
        codeChallenge: "challenge-default-method",
      }),
    );
    expect(pkceUrl.searchParams.get("code_challenge")).toBe("challenge-default-method");
    expect(pkceUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(resolveTokenScope({ defaultScope: "User.Read", audience: "https://x-in-test.invalid" })).toMatchObject({
      scope: "User.Read",
    });
    const url = new URL(
      buildAuthorizationUrl({
        authorizeEndpoint: "https://login-in-test.invalid/oauth/authorize",
        clientId: CLIENT_ID,
        redirectUri: "https://app-in-test.invalid/oauth/callback",
        scope: "Mail.Read",
        state: "state-value-2",
        audience: "https://exchange-in-test.invalid",
      }),
    );
    expect(url.searchParams.get("scope")).toBe("Mail.Read");
    expect(url.searchParams.get("audience")).toBe("https://exchange-in-test.invalid");
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  it("rejects unsafe templating and malformed endpoints", () => {
    const base = {
      authorizeEndpoint: "https://login-in-test.invalid/{tenant}/oauth/authorize",
      clientId: CLIENT_ID,
      redirectUri: "https://app-in-test.invalid/oauth/callback",
      scope: "User.Read",
      state: "state-value-3",
    };
    expect(() => buildAuthorizationUrl({ ...base, tenant: "../escape" })).toThrow(
      expect.objectContaining({ code: "OAUTH_REQUEST_INVALID" }),
    );
    expect(() => buildAuthorizationUrl({ ...base })).toThrow(
      expect.objectContaining({ code: "OAUTH_REQUEST_INVALID" }),
    );
    expect(() => buildAuthorizationUrl({ ...base, authorizeEndpoint: "not a url", tenant: "t" })).toThrow(
      expect.objectContaining({ code: "INVALID_OAUTH_ENDPOINT" }),
    );
    expect(() =>
      buildAuthorizationUrl({ ...base, authorizeEndpoint: "ftp://files-in-test.invalid/auth", tenant: "t" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_OAUTH_ENDPOINT" }));
    expect(() => buildAuthorizationUrl({ ...base, tenant: "t", clientId: "" })).toThrow(
      expect.objectContaining({ code: "OAUTH_REQUEST_INVALID" }),
    );
  });

  it("validates the callback: denial, state, and code", () => {
    expect(parseOAuthCallback({ code: "code-1", state: "s1", expectedState: "s1" })).toMatchObject({ code: "code-1" });
    expect(() => parseOAuthCallback({ state: "s1", expectedState: "s1", error: "access_denied" })).toThrow(
      expect.objectContaining({ code: "OAUTH_AUTHORIZATION_DENIED" }),
    );
    expect(() => parseOAuthCallback({ code: "code-1", state: "other", expectedState: "s1" })).toThrow(
      expect.objectContaining({ code: "OAUTH_STATE_MISMATCH" }),
    );
    expect(() => parseOAuthCallback({ code: "code-1", expectedState: "s1" })).toThrow(
      expect.objectContaining({ code: "OAUTH_STATE_MISMATCH" }),
    );
    expect(() => parseOAuthCallback({ state: "s1", expectedState: "s1" })).toThrow(
      expect.objectContaining({ code: "OAUTH_CALLBACK_INVALID" }),
    );
    // Vendor prose never enters the Fault: fixed messages only.
    try {
      parseOAuthCallback({
        state: "s1",
        expectedState: "s1",
        error: "access_denied",
        errorDescription: `user said ${SECRET_SENTINEL}`,
      });
      expect.unreachable();
    } catch (error) {
      expect(faultJson(error)).not.toContain(SECRET_SENTINEL);
    }
  });

  it("exchanges a code once per call: concurrent exchanges never coalesce", async () => {
    const { calls, fetchImpl } = stubVendor([
      tokenJson({ access_token: "exchange-a", refresh_token: "exchange-refresh-a" }),
      tokenJson({ access_token: "exchange-b" }),
    ]);
    const base = {
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      redirectUri: "https://app-in-test.invalid/oauth/callback",
      codeVerifier: "verifier-value-1",
      scope: "User.Read",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    };
    const [first, second] = await Promise.all([
      exchangeAuthorizationCode({ ...base, code: "code-aaa" }),
      exchangeAuthorizationCode({ ...base, code: "code-bbb" }),
    ]);
    // A code is single-use: one vendor POST per exchange, never one shared call.
    expect(calls).toHaveLength(2);
    expect(first.accessToken).toBe("exchange-a");
    expect(first.refreshToken).toBe("exchange-refresh-a");
    expect(second.accessToken).toBe("exchange-b");
    const form = new URLSearchParams(calls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("verifier-value-1");
    expect(form.get("scope")).toBe("User.Read");
  });

  it("rejects exchange inputs before any vendor call", async () => {
    // A scope-less exchange omits the scope form field entirely.
    const { calls: minimalCalls, fetchImpl: minimal } = stubVendor([tokenJson({ access_token: "minimal-exchange" })]);
    const minimalToken = await exchangeAuthorizationCode({
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      code: "code-minimal",
      redirectUri: "https://app-in-test.invalid/oauth/callback",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl: minimal,
    });
    expect(minimalToken.accessToken).toBe("minimal-exchange");
    expect(new URLSearchParams(minimalCalls[0]?.body ?? "").has("scope")).toBe(false);
    expect(new URLSearchParams(minimalCalls[0]?.body ?? "").has("code_verifier")).toBe(false);
    const { calls, fetchImpl } = stubVendor([]);
    const base = {
      endpoint: ENDPOINT,
      tokenPath: TOKEN_PATH,
      redirectUri: "https://app-in-test.invalid/oauth/callback",
      credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
      faults: FAULTS,
      fetchImpl,
    };
    await expect(exchangeAuthorizationCode({ ...base, code: "" })).rejects.toMatchObject({
      code: "OAUTH_REQUEST_INVALID",
    });
    await expect(exchangeAuthorizationCode({ ...base, code: "code-1", redirectUri: "" })).rejects.toMatchObject({
      code: "OAUTH_REQUEST_INVALID",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("audience and scope overrides (corrected upstream attribution)", () => {
  it("resolves the configured default when nothing is overridden", () => {
    expect(resolveTokenScope({ defaultScope: "User.Read Mail.Read" })).toMatchObject({
      scope: "User.Read Mail.Read",
      audience: null,
    });
  });

  it("replaces the scope for a different resource audience, never subsets it", () => {
    // Upstream cli.py + auto_refresh test: Graph scopes replaced by Exchange
    // scopes for the new audience. The configured default is untouched and no
    // subset relation is enforced.
    const resolved = resolveTokenScope({
      defaultScope: "User.Read Mail.Read",
      scope: "https://exchange-in-test.invalid/Mail.Read",
      audience: "https://exchange-in-test.invalid",
    });
    expect(resolved.scope).toBe("https://exchange-in-test.invalid/Mail.Read");
    expect(resolved.audience).toBe("https://exchange-in-test.invalid");
  });

  it("resolves a scope override with no audience as scope-only", () => {
    expect(resolveTokenScope({ defaultScope: "User.Read", scope: "Mail.Read" })).toMatchObject({
      scope: "Mail.Read",
      audience: null,
    });
  });

  it("resolves a SharePoint-style audience without a scope override", () => {
    const resolved = resolveTokenScope({
      defaultScope: "User.Read",
      audience: "https://contoso-in-test.invalid/sites/audience",
    });
    expect(resolved).toMatchObject({ scope: "User.Read", audience: "https://contoso-in-test.invalid/sites/audience" });
  });

  it("rejects empty or overlong scope and audience values", () => {
    expect(() => resolveTokenScope({ defaultScope: "" })).toThrow(
      expect.objectContaining({ code: "OAUTH_SCOPE_INVALID" }),
    );
    expect(() => resolveTokenScope({ defaultScope: "ok", scope: "" })).toThrow(
      expect.objectContaining({ code: "OAUTH_SCOPE_INVALID" }),
    );
    expect(() => resolveTokenScope({ defaultScope: "ok", audience: "" })).toThrow(
      expect.objectContaining({ code: "OAUTH_SCOPE_INVALID" }),
    );
    expect(() => resolveTokenScope({ defaultScope: "ok", scope: `x${"y".repeat(1024)}` })).toThrow(
      expect.objectContaining({ code: "OAUTH_SCOPE_INVALID" }),
    );
  });
});

describe("token expiry", () => {
  it("treats unstated expiry as usable and honors skew", () => {
    expect(isTokenExpired({})).toBe(false);
    const now = Date.now();
    expect(isTokenExpired({ expiresAtMs: now - 1000 }, now)).toBe(true);
    expect(isTokenExpired({ expiresAtMs: now + OAUTH_EXPIRY_SKEW_MS - 1000 }, now)).toBe(true);
    expect(isTokenExpired({ expiresAtMs: now + OAUTH_EXPIRY_SKEW_MS + 60_000 }, now)).toBe(false);
    expect(isTokenExpired({ expiresAtMs: now + 1000 }, now, 0)).toBe(false);
  });
});

describe("credential health lifecycle (non-secret status only)", () => {
  const AT = "2026-09-13T12:00:00.000Z";
  const LATER = "2026-09-13T12:05:00.000Z";

  it("starts healthy, counts failures, and recovers visibly", () => {
    const fresh = initialTokenHealth(AT);
    expect(fresh).toMatchObject({ status: "healthy", consecutiveFailures: 0, lastFailureCode: null });
    expect(isTokenUsable(fresh)).toBe(true);

    const failed = recordTokenFailure(fresh, "TEST_UNAUTHORIZED", LATER);
    expect(failed).toMatchObject({ status: "failed", consecutiveFailures: 1, lastFailureCode: "TEST_UNAUTHORIZED" });
    expect(isTokenUsable(failed)).toBe(false);

    const failedAgain = recordTokenFailure(failed, "TEST_RATE_LIMITED", LATER);
    expect(failedAgain.consecutiveFailures).toBe(2);
    expect(failedAgain.lastFailureCode).toBe("TEST_RATE_LIMITED");

    // Failed-then-recovered heals: status returns to healthy, count resets.
    const recovered = recordTokenSuccess(failedAgain, LATER);
    expect(recovered).toMatchObject({
      status: "healthy",
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastSuccessAt: LATER,
    });
    expect(isTokenUsable(recovered)).toBe(true);
  });

  it("marks revocation terminal without changing Connection identity", () => {
    const failed = recordTokenFailure(initialTokenHealth(AT), "TEST_UNAUTHORIZED", LATER);
    const revoked = recordTokenRevoked(failed, LATER);
    expect(revoked).toMatchObject({ status: "revoked", consecutiveFailures: 1, lastFailureCode: "TEST_UNAUTHORIZED" });
    expect(isTokenUsable(revoked)).toBe(false);
    // A success after re-authorization still heals a revoked credential: the
    // health status moves, the Connection identity never does.
    expect(recordTokenSuccess(revoked, LATER).status).toBe("healthy");
  });

  it("carries no token material: health holds only fixed status fields", () => {
    const transitions = [
      initialTokenHealth(AT),
      recordTokenFailure(initialTokenHealth(AT), "TEST_UNAUTHORIZED", LATER),
      recordTokenSuccess(initialTokenHealth(AT), LATER),
      recordTokenRevoked(initialTokenHealth(AT), LATER),
    ];
    // Tokens never flow through health: the signature admits status, codes,
    // and timestamps only, so no token value can reach a health row.
    expect(JSON.stringify(transitions)).not.toContain(TOKEN_SENTINEL);
    for (const health of transitions) {
      expect(Object.keys(health).sort()).toEqual([
        "checkedAt",
        "consecutiveFailures",
        "lastFailureCode",
        "lastSuccessAt",
        "status",
      ]);
      expect(Object.isFrozen(health)).toBe(true);
    }
  });
});

describe("token revocation", () => {
  it("revokes on 2xx and sends the token opaquely", async () => {
    const { calls, fetchImpl } = stubVendor([new Response(null, { status: 200 })]);
    const outcome = await revokeOAuthToken({
      endpoint: ENDPOINT,
      revocationPath: "/oauth/revoke",
      token: TOKEN_SENTINEL,
      fetchImpl,
    });
    expect(outcome).toMatchObject({ revoked: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oauth-in-test.invalid/oauth/revoke");
    expect(new URLSearchParams(calls[0]?.body ?? "").get("token")).toBe(TOKEN_SENTINEL);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("authenticates the revocation call when client credentials are given", async () => {
    const { calls, fetchImpl } = stubVendor([new Response(null, { status: 200 })]);
    await revokeOAuthToken({
      endpoint: ENDPOINT,
      revocationPath: "/oauth/revoke",
      token: TOKEN_SENTINEL,
      clientId: CLIENT_ID,
      clientSecret: SECRET_SENTINEL,
      fetchImpl,
    });
    expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:${SECRET_SENTINEL}`)}`);
  });

  it("fails loud on vendor rejection and timeout without copying bodies", async () => {
    const { fetchImpl: rejecting } = stubVendor([tokenJson({ error: "unsupported_token" }, 400)]);
    const dumped = faultJson(
      await revokeOAuthToken({
        endpoint: ENDPOINT,
        revocationPath: "/oauth/revoke",
        token: TOKEN_SENTINEL,
        fetchImpl: rejecting,
      }).catch((error: unknown) => error),
    );
    expect(JSON.parse(dumped)).toMatchObject({ code: "OAUTH_REVOKE_FAILED" });
    expect(dumped).not.toContain("unsupported_token");

    const { calls, fetchImpl: slow } = stubVendor([new DOMException("timed out", "TimeoutError")]);
    await expect(
      revokeOAuthToken({ endpoint: ENDPOINT, revocationPath: "/oauth/revoke", token: TOKEN_SENTINEL, fetchImpl: slow }),
    ).rejects.toMatchObject({ code: "OAUTH_REVOKE_TIMEOUT" });
    expect(calls).toHaveLength(1);

    const { calls: none, fetchImpl: unused } = stubVendor([]);
    await expect(
      revokeOAuthToken({ endpoint: ENDPOINT, revocationPath: "/oauth/revoke", token: "", fetchImpl: unused }),
    ).rejects.toMatchObject({ code: "OAUTH_REQUEST_INVALID" });
    expect(none).toHaveLength(0);

    // Raw transport errors propagate for the caller to map — only aborts and
    // timeouts become OAUTH_REVOKE_TIMEOUT.
    const { calls: rawCalls, fetchImpl: raw } = stubVendor([new TypeError("connection reset")]);
    await expect(
      revokeOAuthToken({ endpoint: ENDPOINT, revocationPath: "/oauth/revoke", token: TOKEN_SENTINEL, fetchImpl: raw }),
    ).rejects.toThrow("connection reset");
    expect(rawCalls).toHaveLength(1);

    // Default vendor (no fetchImpl/timeout given) rides global fetch.
    const globalStub = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 200 }));
    const defaulted = await revokeOAuthToken({
      endpoint: ENDPOINT,
      revocationPath: "/oauth/revoke",
      token: TOKEN_SENTINEL,
    });
    expect(defaulted).toMatchObject({ revoked: true });
    expect(globalStub).toHaveBeenCalledTimes(1);
  });
});

describe("fence scope-collision regression (issue #149, 32-bit hash pair)", () => {
  // Exact collision pair from the follow-up: both scopes digest to 4f518f45
  // through the 32-bit FNV-1a fence routing hash, so both rotations route to
  // the same fence object under the same path key. The fence separates
  // flights by SHA-256 of the posted body (which carries the scope), so the
  // two rotations serialize as independent flights — never coalesce onto one
  // shared vendor response bearing the wrong scope's token.
  const SCOPE_A = "scope-Wgz/7hZZIX/5";
  const SCOPE_B = "scope- Hq.yRqcqqKb";

  function sharedFenceNamespace(instance: OAuthRefreshFence): OAuthRefreshFenceBinding {
    return {
      getByName: () => ({
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const url = input instanceof Request ? input.url : String(input);
          const body = input instanceof Request ? await input.text() : "";
          return instance.fetch(new Request(url, { method: "POST", body }));
        },
      }),
    };
  }

  function fencedVendor(
    vendorCalls: string[],
    gate: Promise<void>,
  ): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.startsWith("https://oauth-in-test.invalid/")) {
        const scope = new URLSearchParams(body).get("scope") ?? "";
        vendorCalls.push(scope);
        await gate;
        return tokenJson({ access_token: `access-for-${scope}`, refresh_token: `next-for-${scope}` });
      }
      throw new Error(`Unexpected fenced vendor call: ${url}`);
    }) as typeof fetch;
  }

  it("keeps colliding scopes on independent flights with scope-correct tokens", async () => {
    const vendorCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const namespace = sharedFenceNamespace(new OAuthRefreshFence());
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fencedVendor(vendorCalls, gate);
    try {
      // Isolated module copies: racers share no module-global single-flight
      // map (the separate-Worker-instance analogue); only the fence is shared.
      const copyA = "../src/oauth.ts?scope-collision=copy-a";
      const copyB = "../src/oauth.ts?scope-collision=copy-b";
      vi.resetModules();
      const first = (await import(/* @vite-ignore */ copyA)) as typeof import("../src/oauth");
      vi.resetModules();
      const second = (await import(/* @vite-ignore */ copyB)) as typeof import("../src/oauth");
      expect(first.refreshRotatingToken).not.toBe(second.refreshRotatingToken);
      const base = {
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        refreshToken: REFRESH_SENTINEL,
        tenantKey: "org-tenant-collision",
        generation: "v3",
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fence: namespace,
      };
      const pending = [
        first.refreshRotatingToken({ ...base, scope: SCOPE_A }),
        second.refreshRotatingToken({ ...base, scope: SCOPE_B }),
      ];
      // Let both racers register their flights before releasing the vendor
      // gate; otherwise the first settles before the other starts.
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      const [tokenA, tokenB] = await Promise.all(pending);
      // Independent flights: one vendor POST per scope, each caller holding
      // the token minted for its own scope — never one shared response.
      expect(vendorCalls.slice().sort()).toEqual([SCOPE_A, SCOPE_B].sort());
      expect(tokenA?.token.accessToken).toBe(`access-for-${SCOPE_A}`);
      expect(tokenB?.token.accessToken).toBe(`access-for-${SCOPE_B}`);
      expect(tokenA?.refreshToken).toBe(`next-for-${SCOPE_A}`);
      expect(tokenB?.refreshToken).toBe(`next-for-${SCOPE_B}`);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });

  it("still coalesces same-scope racers into exactly one vendor POST", async () => {
    const vendorCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const namespace = sharedFenceNamespace(new OAuthRefreshFence());
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fencedVendor(vendorCalls, gate);
    try {
      const copyA = "../src/oauth.ts?scope-collision=same-a";
      const copyB = "../src/oauth.ts?scope-collision=same-b";
      vi.resetModules();
      const first = (await import(/* @vite-ignore */ copyA)) as typeof import("../src/oauth");
      vi.resetModules();
      const second = (await import(/* @vite-ignore */ copyB)) as typeof import("../src/oauth");
      const base = {
        endpoint: ENDPOINT,
        tokenPath: TOKEN_PATH,
        refreshToken: REFRESH_SENTINEL,
        tenantKey: "org-tenant-same-scope",
        generation: "v3",
        scope: SCOPE_A,
        credentials: { clientId: CLIENT_ID, clientSecret: SECRET_SENTINEL },
        faults: FAULTS,
        fence: namespace,
      };
      const pending = [
        first.refreshRotatingToken({ ...base }),
        second.refreshRotatingToken({ ...base }),
        first.refreshRotatingToken({ ...base }),
      ];
      first.clearOAuthInflight();
      second.clearOAuthInflight();
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      const results = await Promise.all(pending);
      expect(vendorCalls).toEqual([SCOPE_A]);
      for (const result of results) {
        expect(result?.token.accessToken).toBe(`access-for-${SCOPE_A}`);
        expect(result?.refreshToken).toBe(`next-for-${SCOPE_A}`);
      }
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });
});
