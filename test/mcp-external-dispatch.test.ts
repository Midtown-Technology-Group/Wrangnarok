// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171) S4: consent/service-connect/dispatch against an
// external MCP fixture server. Real local workerd with a real D1 binding
// (full harness chain + migration 0041); ONLY external vendor HTTP is
// stubbed (the fixture below), and every stubbed byte is asserted. Pins
// the OAuth callback/consent/revoke round trip, refresh races through the
// shared single-flight plus generation-fenced writes, the ~250 KB
// response bound with the single 401 retry, tool-list drift, hidden-tool
// denial, namespace collisions, failure/recovery health, ciphertext-only
// D1, and the allowed/denied caller matrix incl. the AUTH-02 viewer
// ceiling and the autonomous service principal (function-level: no route
// mints autonomous callers in v0).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { dispatchMcpTool } from "../src/mcp-dispatch";
import { clearOAuthInflight } from "../src/oauth";
import { useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const MEMBER_USER = "00000000-0000-4000-8000-000000000003";
const VIEWER_USER = "00000000-0000-4000-8000-000000000007";
const ORG_B = "00000000-0000-4000-8000-000000000004";
const FOREIGN_USER = "00000000-0000-4000-8000-000000000006";
const TOKEN = "a".repeat(64);
const SERVER_URL = "https://mcp-fixture.invalid/mcp";
const TOKEN_PATH = "/oauth/token";
const AUTHORIZE_ENDPOINT = "https://login-fixture.invalid/authorize";
const REDIRECT_URI = "http://localhost:3000/callback";
const CLIENT_ID = "test-mcp-client-id";
const CLIENT_SECRET = "test-mcp-client-secret";
const USER_ACCESS = "test-mcp-user-access-alpha";
const USER_REFRESH = "test-mcp-user-refresh-alpha";
const SERVICE_ACCESS = "test-mcp-service-access-alpha";
const SERVICE_REFRESH = "test-mcp-service-refresh-alpha";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function call(path: string, method = "GET", body?: unknown) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function callAs(env: Bindings, path: string, method = "GET", body?: unknown) {
  return worker.fetch(
    new Request(`https://local.test${path}`, {
      method,
      headers: { ...auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

async function jsonOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function asMember(): Bindings {
  return { ...bindings, LAB_USER_ID: MEMBER_USER, LAB_FIXTURE_USER_ID: USER_ADMIN };
}

function asViewer(): Bindings {
  return { ...bindings, LAB_USER_ID: VIEWER_USER, LAB_FIXTURE_USER_ID: USER_ADMIN };
}

function asForeignOrg(): Bindings {
  return { ...bindings, LAB_ORG_ID: ORG_B, LAB_USER_ID: FOREIGN_USER };
}

interface VendorCall {
  readonly url: string;
  readonly auth: string | null;
  readonly body: string;
}

const tokenCalls: VendorCall[] = [];
const rpcCalls: VendorCall[] = [];
const usedCodes = new Set<string>();
let rpcBehavior: (auth: string | null, body: Record<string, unknown>) => Response = () =>
  new Response("no behavior", { status: 500 });

function rpcResult(result: unknown, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: 1, result }, { status });
}

function vendorFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const rawBody = input instanceof Request ? "" : typeof init?.body === "string" ? init.body : "";
  const record: VendorCall = { url, auth: headers.get("Authorization"), body: rawBody };
  if (url === `https://mcp-fixture.invalid${TOKEN_PATH}`) {
    tokenCalls.push(record);
    const form = new URLSearchParams(rawBody);
    const grant = form.get("grant_type");
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
      return Promise.resolve(Response.json({ error: "invalid_client" }, { status: 401 }));
    }
    if (grant === "client_credentials") {
      return Promise.resolve(
        Response.json({
          access_token: SERVICE_ACCESS,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: SERVICE_REFRESH,
        }),
      );
    }
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      if (usedCodes.has(code)) return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
      usedCodes.add(code);
      return Promise.resolve(
        Response.json({
          access_token: USER_ACCESS,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: USER_REFRESH,
        }),
      );
    }
    if (grant === "refresh_token") {
      const submitted = form.get("refresh_token") ?? "";
      if (submitted !== USER_REFRESH && submitted !== SERVICE_REFRESH && !submitted.startsWith("rotated-")) {
        return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
      }
      return Promise.resolve(
        Response.json({
          access_token: `rotated-${submitted.slice(0, 8)}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `rotated-${submitted.slice(0, 8)}-next`,
        }),
      );
    }
    return Promise.resolve(Response.json({ error: "unsupported_grant_type" }, { status: 400 }));
  }
  if (url === SERVER_URL) {
    rpcCalls.push(record);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32700, message: "x" } }));
    }
    return Promise.resolve(rpcBehavior(record.auth, parsed));
  }
  throw new Error(`Unexpected outbound request: ${url}`);
}

useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await bindings.DB.prepare("DELETE FROM mcp_tool_catalog").run();
    await bindings.DB.prepare("DELETE FROM mcp_user_consents").run();
    await bindings.DB.prepare("DELETE FROM mcp_service_tokens").run();
    await bindings.DB.prepare("DELETE FROM mcp_connections").run();
    await bindings.DB.prepare("DELETE FROM mcp_server_templates").run();
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind(ORG_B, "Org B")
      .run();
    const now = new Date().toISOString();
    for (const [userId, role] of [
      [MEMBER_USER, "member"],
      [VIEWER_USER, "viewer"],
    ] as const) {
      await bindings.DB.prepare(
        "INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT DO NOTHING",
      )
        .bind(userId, now)
        .run();
      await bindings.DB.prepare(
        "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,'active','ordinary',?,?) ON CONFLICT DO NOTHING",
      )
        .bind(ORG_A, userId, role, now, now)
        .run();
    }
    tokenCalls.length = 0;
    rpcCalls.length = 0;
    usedCodes.clear();
    rpcBehavior = () => new Response("no behavior", { status: 500 });
    vi.spyOn(globalThis, "fetch").mockImplementation(vendorFetch as typeof fetch);
  },
});

afterEach(() => {
  clearOAuthInflight();
  vi.restoreAllMocks();
});

async function seedTemplate(name: string, flow: string): Promise<string> {
  const response = await worker.fetch(
    call("/api/mcp-servers", "POST", { name, serverUrl: SERVER_URL, providerFlow: flow, orgId: ORG_A }),
    bindings,
  );
  expect(response.status).toBe(201);
  return ((await jsonOf(response)).server as { id: string }).id;
}

async function seedConnection(serverId: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await worker.fetch(
    call("/api/mcp-connections", "POST", { serverId, clientId: CLIENT_ID, tokenPath: TOKEN_PATH, ...body }),
    bindings,
  );
  expect(response.status).toBe(201);
  const id = ((await jsonOf(response)).connection as { id: string }).id;
  const secret = await worker.fetch(
    call(`/api/mcp-connections/${id}/client-secret`, "PUT", { secret: CLIENT_SECRET }),
    bindings,
  );
  expect(secret.status).toBe(200);
  return id;
}

async function serviceConnect(connectionId: string): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    call(`/api/mcp-connections/${connectionId}/service-connect`, "POST", {}),
    bindings,
  );
  expect(response.status).toBe(200);
  return await jsonOf(response);
}

async function userConsent(connectionId: string, env: Bindings = bindings): Promise<void> {
  const authorized = await callAs(env, `/api/mcp-connections/${connectionId}/consent/authorize`, "POST", {
    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    redirectUri: REDIRECT_URI,
    scope: "read",
  });
  expect(authorized.status).toBe(200);
  const session = (await jsonOf(authorized)).authorization as { state: string; codeVerifier: string };
  const done = await callAs(env, `/api/mcp-connections/${connectionId}/consent/callback`, "POST", {
    code: `code-${Math.random().toString(36).slice(2)}`,
    state: session.state,
    expectedState: session.state,
    codeVerifier: session.codeVerifier,
    redirectUri: REDIRECT_URI,
    scope: "read",
  });
  expect(done.status).toBe(200);
}

function listTools(tools: { name: string }[]): (auth: string | null, body: Record<string, unknown>) => Response {
  return (_auth, body) => {
    if (body.method === "tools/list") return rpcResult({ tools });
    return rpcResult({ ok: true });
  };
}

describe("TOOL-02 consent and service connect (S4)", () => {
  it("authorize issues a PKCE S256 URL; callback persists generation 1 with no token values out", async () => {
    const connectionId = await seedConnection(await seedTemplate("consent-roundtrip", "authorization_code"));
    const authorized = await callAs(asMember(), `/api/mcp-connections/${connectionId}/consent/authorize`, "POST", {
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      redirectUri: REDIRECT_URI,
      scope: "read",
    });
    expect(authorized.status).toBe(200);
    const session = (await jsonOf(authorized)).authorization as {
      authorizationUrl: string;
      state: string;
      codeVerifier: string;
    };
    const url = new URL(session.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const done = await callAs(asMember(), `/api/mcp-connections/${connectionId}/consent/callback`, "POST", {
      code: "code-one",
      state: session.state,
      expectedState: session.state,
      codeVerifier: session.codeVerifier,
      redirectUri: REDIRECT_URI,
      scope: "read",
    });
    expect(done.status).toBe(200);
    const consent = (await jsonOf(done)).consent as { generation: number; scope: string };
    expect(consent.generation).toBe(1);
    expect(consent.scope).toBe("read");
    expect(JSON.stringify(consent)).not.toContain(USER_ACCESS);
  });

  it("re-consent rotates to generation 2 with no orphan row; state mismatch fails", async () => {
    const connectionId = await seedConnection(await seedTemplate("consent-rotate", "authorization_code"));
    await userConsent(connectionId, asMember());
    await userConsent(connectionId, asMember());
    const rows = await bindings.DB.prepare("SELECT generation FROM mcp_user_consents WHERE connection_id=?")
      .bind(connectionId)
      .all<{ generation: number }>();
    expect(rows.results.map((row) => row.generation)).toEqual([2]);

    const bad = await callAs(asMember(), `/api/mcp-connections/${connectionId}/consent/callback`, "POST", {
      code: "code-bad",
      state: "wrong",
      expectedState: "right",
      codeVerifier: "verifier",
      redirectUri: REDIRECT_URI,
    });
    expect(bad.status).toBe(400);
    expect(((await jsonOf(bad)).error as { code: string }).code).toBe("OAUTH_STATE_MISMATCH");
  });

  it("client_credentials has no per-user mode; service connect stores generation 1", async () => {
    const connectionId = await seedConnection(await seedTemplate("cc-only", "client_credentials"));
    const userAttempt = await callAs(asMember(), `/api/mcp-connections/${connectionId}/consent/authorize`, "POST", {
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      redirectUri: REDIRECT_URI,
    });
    expect(userAttempt.status).toBe(400);
    expect(((await jsonOf(userAttempt)).error as { code: string }).code).toBe("MCP_USER_CONSENT_UNSUPPORTED");

    const connected = await serviceConnect(connectionId);
    expect((connected.service as { generation: number }).generation).toBe(1);
    expect(JSON.stringify(connected)).not.toContain(SERVICE_ACCESS);
    expect(tokenCalls.filter((entry) => entry.body.includes("grant_type=client_credentials")).length).toBe(1);
  });

  it("disconnect is idempotent; service drop makes refresh-tools loud, never empty", async () => {
    const connectionId = await seedConnection(await seedTemplate("consent-drop", "authorization_code"));
    await userConsent(connectionId, asMember());
    const first = await callAs(asMember(), `/api/mcp-connections/${connectionId}/consent`, "DELETE");
    expect(first.status).toBe(200);
    const second = await callAs(asMember(), `/api/mcp-connections/${connectionId}/consent`, "DELETE");
    expect(second.status).toBe(200);

    const ccId = await seedConnection(await seedTemplate("cc-drop", "client_credentials"));
    await serviceConnect(ccId);
    const dropped = await worker.fetch(call(`/api/mcp-connections/${ccId}/service`, "DELETE"), bindings);
    expect(dropped.status).toBe(200);
    const refresh = await worker.fetch(call(`/api/mcp-connections/${ccId}/refresh-tools`, "POST"), bindings);
    expect(refresh.status).toBe(400);
    expect(((await jsonOf(refresh)).error as { code: string }).code).toBe("MCP_SERVICE_NOT_CONNECTED");
  });
});

describe("TOOL-02 dispatch (S3+S4)", () => {
  async function seedCatalog(connectionId: string, tools: { name: string }[]): Promise<void> {
    // Catalog sync over the service token is the operator path (upstream
    // §23: sync never runs on a per-user token). Authorization-code
    // fixtures seed the same store directly — the sync mechanics are
    // pinned by the client_credentials route tests below.
    const { syncMcpCatalog } = await import("../src/mcp-catalog");
    await syncMcpCatalog(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, connectionId, { tools });
  }

  async function readyConnection(flow: string, name: string, flags: Record<string, unknown> = {}): Promise<string> {
    const connectionId = await seedConnection(await seedTemplate(name, flow), flags);
    if (flow === "client_credentials") {
      await serviceConnect(connectionId);
      rpcBehavior = listTools([{ name: "search" }, { name: "lookup" }]);
      const refresh = await worker.fetch(call(`/api/mcp-connections/${connectionId}/refresh-tools`, "POST"), bindings);
      expect(refresh.status).toBe(200);
    } else {
      await userConsent(connectionId, asMember());
      await seedCatalog(connectionId, [{ name: "search" }, { name: "lookup" }]);
    }
    return connectionId;
  }

  it("user identity dispatches with the user Bearer [REDACTED] provenance", async () => {
    const connectionId = await readyConnection("authorization_code", "dispatch-user", { availableInChat: true });
    rpcBehavior = (authHeader, body) => {
      expect(authHeader).toBe(`Bearer ${USER_ACCESS}`);
      if (body.method === "tools/call") return rpcResult({ hits: ["a"] });
      return rpcResult({ tools: [] });
    };
    const response = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {
      arguments: { q: "a" },
    });
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.result).toEqual({ hits: ["a"] });
    const provenance = body.provenance as Record<string, unknown>;
    expect(provenance.identity).toBe("user");
    expect(provenance.qualifiedTool).toBe(`mcp__${connectionId}__search`);
    expect(JSON.stringify(body)).not.toContain(USER_ACCESS);
  });

  it("service fallback serves chat without consent when the flag allows; needs-reauth otherwise", async () => {
    const connectionId = await seedConnection(await seedTemplate("dispatch-fallback", "client_credentials"), {
      availableInChat: true,
    });
    await serviceConnect(connectionId);
    rpcBehavior = listTools([{ name: "search" }]);
    await worker.fetch(call(`/api/mcp-connections/${connectionId}/refresh-tools`, "POST"), bindings);
    rpcBehavior = (authHeader) => {
      expect(authHeader).toBe(`Bearer ${SERVICE_ACCESS}`);
      return rpcResult({ ok: true });
    };
    // MEMBER_USER never consented: the explicit flag admits the service identity.
    const served = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(served.status).toBe(200);
    expect((await jsonOf(served)).provenance as object).toMatchObject({ identity: "service" });

    const strictId = await seedConnection(await seedTemplate("dispatch-strict", "authorization_code"));
    await seedCatalog(strictId, [{ name: "search" }]);
    const denied = await callAs(asMember(), `/api/mcp-connections/${strictId}/tools/search/call`, "POST", {});
    expect(denied.status).toBe(403);
    const deniedBody = await jsonOf(denied);
    expect((deniedBody.error as { code: string }).code).toBe("MCP_NEEDS_REAUTH");
    expect((deniedBody.error as { details?: { reauthUrl?: string } }).details?.reauthUrl).toContain(
      `/api/mcp-connections/${strictId}/consent/authorize`,
    );
  });

  it("hidden tools 404; drift-disabled tools deny with the reason", async () => {
    const connectionId = await readyConnection("authorization_code", "dispatch-hidden");
    const hidden = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/ghost/call`, "POST", {});
    expect(hidden.status).toBe(404);
    expect(((await jsonOf(hidden)).error as { code: string }).code).toBe("MCP_TOOL_UNKNOWN");

    const { syncMcpCatalog } = await import("../src/mcp-catalog");
    await syncMcpCatalog(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, connectionId, { tools: [] });
    const drifted = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(drifted.status).toBe(404);
    expect(((await jsonOf(drifted)).error as { code: string }).code).toBe("MCP_TOOL_DISABLED");
  });

  it("401 retries once after one refresh; a still-failing user token needs reauth, never service", async () => {
    const connectionId = await readyConnection("authorization_code", "dispatch-retry", { availableInChat: true });
    let calls = 0;
    rpcBehavior = (authHeader, body) => {
      if (body.method === "tools/call") {
        calls += 1;
        if (authHeader === `Bearer ${USER_ACCESS}`) return new Response(null, { status: 401 });
        return new Response(null, { status: 401 });
      }
      return rpcResult({ tools: [] });
    };
    tokenCalls.length = 0;
    const denied = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(denied.status).toBe(403);
    expect(((await jsonOf(denied)).error as { code: string }).code).toBe("MCP_NEEDS_REAUTH");
    // Exactly one refresh attempt and exactly two vendor calls: no quiet
    // upgrade to the healthy service identity, no retry storm.
    expect(tokenCalls.filter((entry) => entry.body.includes("grant_type=refresh_token")).length).toBe(1);
    expect(calls).toBe(2);
    const state = await bindings.DB.prepare(
      "SELECT status,consecutive_failures FROM mcp_user_consents WHERE connection_id=?",
    )
      .bind(connectionId)
      .first<{ status: string; consecutive_failures: number }>();
    expect(state?.status).toBe("failed");
    expect(state?.consecutive_failures).toBe(1);
  });

  it("concurrent expired-credential dispatches share one refresh round", async () => {
    const connectionId = await seedConnection(await seedTemplate("dispatch-race", "client_credentials"), {
      availableInChat: true,
    });
    await serviceConnect(connectionId);
    rpcBehavior = listTools([{ name: "search" }]);
    await worker.fetch(call(`/api/mcp-connections/${connectionId}/refresh-tools`, "POST"), bindings);
    await bindings.DB.prepare("UPDATE mcp_service_tokens SET expires_at_ms=? WHERE connection_id=?")
      .bind(Date.now() - 1000, connectionId)
      .run();
    tokenCalls.length = 0;
    rpcBehavior = (_auth, body) => rpcResult(body.method === "tools/call" ? { ok: true } : { tools: [] });
    const [first, second] = await Promise.all([
      callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {}),
      callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {}),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(tokenCalls.filter((entry) => entry.body.includes("grant_type=refresh_token")).length).toBe(1);
    const generation = await bindings.DB.prepare(
      "SELECT generation,status FROM mcp_service_tokens WHERE connection_id=?",
    )
      .bind(connectionId)
      .first<{ generation: number; status: string }>();
    expect(generation?.generation).toBe(2);
    expect(generation?.status).toBe("healthy");
  });

  it("oversize vendor bodies fail loud under the bound; redirects never carry the Bearer", async () => {
    const connectionId = await readyConnection("authorization_code", "dispatch-bounds");
    rpcBehavior = () => new Response("x".repeat(300_000), { headers: { "Content-Type": "application/json" } });
    const big = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(big.status).toBe(502);
    expect(((await jsonOf(big)).error as { code: string }).code).toBe("MCP_RESPONSE_TOO_LARGE");

    const rpcBefore = rpcCalls.length;
    rpcBehavior = () => new Response(null, { status: 302, headers: { Location: "https://evil.invalid/" } });
    const redirected = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(redirected.status).toBe(502);
    expect(((await jsonOf(redirected)).error as { code: string }).code).toBe("MCP_VENDOR_REDIRECTED");
    // Manual redirect mode: the single POST fails loud instead of
    // following the redirect with the Bearer [REDACTED]
    expect(rpcCalls.length).toBe(rpcBefore + 1);
  });

  it("re-connect recovers a failed service credential at a new generation", async () => {
    const connectionId = await seedConnection(await seedTemplate("dispatch-recover", "client_credentials"), {
      availableInChat: true,
    });
    await serviceConnect(connectionId);
    rpcBehavior = listTools([{ name: "search" }]);
    await worker.fetch(call(`/api/mcp-connections/${connectionId}/refresh-tools`, "POST"), bindings);
    rpcBehavior = () => new Response(null, { status: 401 });
    const failed = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(failed.status).toBe(424);
    const mid = await bindings.DB.prepare("SELECT status FROM mcp_service_tokens WHERE connection_id=?")
      .bind(connectionId)
      .first<{ status: string }>();
    expect(mid?.status).toBe("failed");

    rpcBehavior = listTools([{ name: "search" }]);
    const recovered = await serviceConnect(connectionId);
    // Generation 1 connected, the 401 retry rotated to 2 and marked it
    // failed, so re-connect recovers at 3 with a healthy lifecycle.
    expect((recovered.service as { generation: number; health: { status: string } }).generation).toBe(3);
    expect((recovered.service as { health: { status: string } }).health.status).toBe("healthy");
    const served = await callAs(asMember(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(served.status).toBe(200);
  });

  it("ciphertext-only D1: no token or secret value persists outside envelopes", async () => {
    const connectionId = await readyConnection("authorization_code", "dispatch-secrets");
    for (const table of ["mcp_service_tokens", "mcp_user_consents", "mcp_connection_secrets"]) {
      const rows = await bindings.DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
      const text = JSON.stringify(rows.results);
      for (const sentinel of [USER_ACCESS, USER_REFRESH, SERVICE_ACCESS, SERVICE_REFRESH, CLIENT_SECRET]) {
        expect(text).not.toContain(sentinel);
      }
    }
    expect(connectionId.length).toBe(36);
  });
});

describe("TOOL-02 caller matrix and delegation interplay (S4)", () => {
  it("viewers read but never dispatch; strangers 404; foreign orgs stay invisible", async () => {
    const serverId = await seedTemplate("matrix-server", "client_credentials");
    const connectionId = await seedConnection(serverId, { availableInChat: true });
    await serviceConnect(connectionId);
    rpcBehavior = listTools([{ name: "search" }]);
    await worker.fetch(call(`/api/mcp-connections/${connectionId}/refresh-tools`, "POST"), bindings);

    const viewerRead = await callAs(asViewer(), `/api/mcp-connections/${connectionId}/tools`);
    expect(viewerRead.status).toBe(200);
    const viewerCall = await callAs(asViewer(), `/api/mcp-connections/${connectionId}/tools/search/call`, "POST", {});
    expect(viewerCall.status).toBe(403);
    expect(((await jsonOf(viewerCall)).error as { code: string }).code).toBe("GRANT_REQUIRED");

    const stranger = await callAs(asForeignOrg(), `/api/mcp-connections/${connectionId}`);
    expect(stranger.status).toBe(404);
    const strangerCall = await callAs(
      asForeignOrg(),
      `/api/mcp-connections/${connectionId}/tools/search/call`,
      "POST",
      {},
    );
    expect(strangerCall.status).toBe(404);
  });

  it("autonomous service principal dispatches without user identity; foreign principals misconfigure", async () => {
    const serverId = await seedTemplate("matrix-auto", "client_credentials");
    const created = await worker.fetch(
      call("/api/mcp-connections", "POST", {
        serverId,
        clientId: CLIENT_ID,
        tokenPath: TOKEN_PATH,
        availableToAutonomous: true,
      }),
      bindings,
    );
    const connectionId = ((await jsonOf(created)).connection as { id: string }).id;
    const secret = await worker.fetch(
      call(`/api/mcp-connections/${connectionId}/client-secret`, "PUT", { secret: CLIENT_SECRET }),
      bindings,
    );
    expect(secret.status).toBe(200);
    await serviceConnect(connectionId);
    rpcBehavior = listTools([{ name: "search" }]);
    await worker.fetch(call(`/api/mcp-connections/${connectionId}/refresh-tools`, "POST"), bindings);
    const KEK = "test-secrets-kek-sentinel-fixture-only";
    rpcBehavior = (authHeader) => {
      expect(authHeader).toBe(`Bearer ${SERVICE_ACCESS}`);
      return rpcResult({ ok: true });
    };
    const autonomous = await dispatchMcpTool({
      db: bindings.DB,
      orgId: ORG_A,
      caller: { kind: "autonomous", serviceConnectionId: connectionId },
      connectionId,
      toolName: "search",
      args: {},
      kekMaterial: KEK,
      fetchImpl: vendorFetch as typeof fetch,
    });
    expect(autonomous.provenance.identity).toBe("service");

    const foreign = dispatchMcpTool({
      db: bindings.DB,
      orgId: ORG_A,
      caller: { kind: "autonomous", serviceConnectionId: "00000000-0000-4000-8000-00000000ffff" },
      connectionId,
      toolName: "search",
      args: {},
      kekMaterial: KEK,
      fetchImpl: vendorFetch as typeof fetch,
    });
    await expect(foreign).rejects.toMatchObject({ code: "MCP_MISCONFIGURED" });
  });

  it("two Connections share vendor tool names under disjoint qualified names", async () => {
    const first = await seedConnection(await seedTemplate("collision-one", "client_credentials"), {
      availableInChat: true,
    });
    const second = await seedConnection(await seedTemplate("collision-two", "client_credentials"), {
      availableInChat: true,
    });
    await serviceConnect(first);
    await serviceConnect(second);
    rpcBehavior = listTools([{ name: "search" }]);
    await worker.fetch(call(`/api/mcp-connections/${first}/refresh-tools`, "POST"), bindings);
    await worker.fetch(call(`/api/mcp-connections/${second}/refresh-tools`, "POST"), bindings);
    const rpcBefore = rpcCalls.length;
    rpcBehavior = () => rpcResult({ ok: true });
    const one = await callAs(asMember(), `/api/mcp-connections/${first}/tools/search/call`, "POST", {});
    const two = await callAs(asMember(), `/api/mcp-connections/${second}/tools/search/call`, "POST", {});
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    // Both vendor calls carry the same service Bearer — the qualified
    // names below (not the wire token) keep the Connections apart.
    expect(rpcCalls.slice(rpcBefore).map((entry) => entry.auth)).toEqual([
      `Bearer ${SERVICE_ACCESS}`,
      `Bearer ${SERVICE_ACCESS}`,
    ]);
    expect(((await jsonOf(one)).provenance as { qualifiedTool: string }).qualifiedTool).toBe(`mcp__${first}__search`);
    expect(((await jsonOf(two)).provenance as { qualifiedTool: string }).qualifiedTool).toBe(`mcp__${second}__search`);
  });
});
