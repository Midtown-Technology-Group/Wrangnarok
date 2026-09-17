// SPDX-License-Identifier: AGPL-3.0
// OAUTH-01 operator surface (issue #149): auth-code consent routes plus the
// Integration-list credential-health aggregate. Real local workerd with a
// real D1 binding (full migration chain via the shared harness); only
// vendor OAuth HTTP is stubbed. Fixture sentinels only — never production
// credentials, and no token value may appear in any response or D1 row
// outside its envelope ciphertext.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { createConnection, putConnectionSecrets } from "../src/connections";
import { ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID } from "../src/domain";
import { clearOAuthInflight } from "../src/oauth";
import { handleOAuthCallback } from "../src/oauth-consent";
import {
  readOAuthTokenState,
  recordOAuthTokenFailure,
  recordOAuthTokenRevoked,
  storeInitialOAuthToken,
} from "../src/oauth-tokens";
import { useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const MEMBER_USER = "00000000-0000-4000-8000-000000000003";
const ORG_B = "00000000-0000-4000-8000-000000000004";
const ORG_C = "00000000-0000-4000-8000-000000000005";
const FOREIGN_USER = "00000000-0000-4000-8000-000000000006";
const TOKEN = "a".repeat(64);
const KEK = "test-secrets-kek-sentinel-fixture-only";
const ENDPOINT = "https://ninja-in-test.invalid/api";
const TOKEN_PATH = "/oauth/token";
const AUTHORIZE_ENDPOINT = "https://login-in-test.invalid/authorize";
const REDIRECT_URI = "http://localhost:3000/callback";
const CLIENT_ID = "test-oauth-client-id";
const SCOPE = "monitoring";
const ACCESS_A = "test-oauth-access-sentinel-alpha";
const REFRESH_A = "test-oauth-refresh-sentinel-alpha";
const ACCESS_B = "test-oauth-access-sentinel-beta";
const REFRESH_B = "test-oauth-refresh-sentinel-beta";
const ACCESS_C = "test-oauth-access-sentinel-gamma";
const PER_ORG_SECRET = "test-per-org-client-secret";
const DEPLOYMENT_SECRET = "test-client-secret-sentinel";
const AT = "2026-09-17T10:00:00.000Z";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function call(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function jsonOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/** Non-admin member of ORG_A: swapped LAB_USER_ID with the fixture identity
 * preserved, so no admin bootstrap runs — membership resolves from the
 * seeded ordinary row. */
function asMember(): Bindings {
  return { ...bindings, LAB_USER_ID: MEMBER_USER, LAB_FIXTURE_USER_ID: USER_ADMIN };
}

/** Admin caller of ORG_B (self-bootstrapped): passes the admin gate, then
 * proves route-level org scoping with 404s. */
function asForeignOrg(): Bindings {
  return { ...bindings, LAB_ORG_ID: ORG_B, LAB_USER_ID: FOREIGN_USER };
}

/** Instance admin: the LAB fixture identity on the deployment admin list. */
function asInstanceAdmin(): Bindings {
  return { ...bindings, LAB_USER_ID: USER_ADMIN, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: USER_ADMIN };
}

function tokenJson(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface VendorCall {
  readonly url: string;
  readonly body: string;
}

const vendorCalls: VendorCall[] = [];
let vendorScript: Response[] = [];
/** Persistent stateful vendor model (e.g. single-use codes). Takes
 * precedence over the queued one-shot Responses while set. */
let vendorHandler: ((body: string) => Response) | undefined;

/** Single-use vendor model: the first presentation of a code succeeds, any
 * replay answers invalid_grant — the vendor owns code single-use, and the
 * Worker must never persist a second generation from a replay. */
function singleUseVendor(first: unknown): (body: string) => Response {
  const seen = new Set<string>();
  return (body: string) => {
    const code = new URLSearchParams(body).get("code") ?? "";
    if (seen.has(code)) return tokenJson({ error: "invalid_grant" }, 400);
    seen.add(code);
    return tokenJson(first);
  };
}

useWorkflowHarness(bindings.DB);

beforeEach(async () => {
  await bindings.DB.prepare("DELETE FROM oauth_tokens").run();
  await bindings.DB.prepare("DELETE FROM connection_secrets").run();
  await bindings.DB.prepare("DELETE FROM connections").run();
  for (const [id, name] of [
    [ORG_B, "Org B"],
    [ORG_C, "Org C"],
  ]) {
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind(id, name)
      .run();
  }
  const now = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT DO NOTHING")
    .bind(MEMBER_USER, now)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'member','active','ordinary',?,?) ON CONFLICT DO NOTHING",
  )
    .bind(ORG_A, MEMBER_USER, now, now)
    .run();
  vendorCalls.length = 0;
  vendorScript = [];
  vendorHandler = undefined;
  // Intercept only outbound vendor OAuth HTTP. Native D1/Workflow bindings
  // are never replaced; any non-vendor fetch fails the test.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://ninja-in-test.invalid/")) {
      throw new Error(`Unexpected outbound request: ${url}`);
    }
    const body = typeof init?.body === "string" ? init.body : "";
    vendorCalls.push({ url, body });
    if (vendorHandler !== undefined) return vendorHandler(body);
    const next = vendorScript.shift();
    if (next !== undefined) return next;
    throw new Error("Unexpected extra vendor call");
  });
});

afterEach(() => {
  clearOAuthInflight();
  vi.restoreAllMocks();
});

async function seedMapping(orgId: string, userId: string, integrationId = NINJA_INTEGRATION_ID) {
  return createConnection(bindings.DB, { orgId, userId }, integrationId, { config: { endpoint: ENDPOINT } });
}

async function authorize(integrationId = NINJA_INTEGRATION_ID, body: Record<string, unknown> = {}) {
  const response = await worker.fetch(
    call(`/api/connections/${integrationId}/oauth/authorize`, "POST", {
      redirectUri: REDIRECT_URI,
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      clientId: CLIENT_ID,
      scope: SCOPE,
      ...body,
    }),
    bindings,
  );
  return { status: response.status, body: await jsonOf(response) };
}

async function callback(
  integrationId: string,
  body: Record<string, unknown>,
  env: Bindings = bindings,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(call(`/api/connections/${integrationId}/oauth/callback`, "POST", body), env);
  return { status: response.status, body: await jsonOf(response) };
}

function authorizationOf(body: Record<string, unknown>) {
  return body.authorization as { authorizationUrl: string; state: string; codeVerifier: string };
}

describe("consent authorize (OAUTH-01 operator surface)", () => {
  it("issues an authorize URL with PKCE S256 plus state, holding no server-side session", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const { status, body } = await authorize();
    expect(status).toBe(200);
    const issued = authorizationOf(body);
    expect(typeof issued.codeVerifier).toBe("string");
    expect(issued.codeVerifier.length).toBe(43);
    const url = new URL(issued.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(SCOPE);
    expect(url.searchParams.get("state")).toBe(issued.state);
    expect(issued.state.length).toBe(22);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = url.searchParams.get("code_challenge") ?? "";
    expect(challenge.length).toBe(43);
    // S256 proof: the challenge is the base64url SHA-256 of the verifier.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(issued.codeVerifier));
    const bytes = Array.from(new Uint8Array(digest), (entry) => String.fromCharCode(entry)).join("");
    expect(challenge).toBe(btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""));
    // Pure issuance: no vendor contact, no persisted session or token.
    expect(vendorCalls).toHaveLength(0);
    const tokens = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").first<{ n: number }>();
    expect(tokens?.n).toBe(0);
    expect(JSON.stringify(body)).not.toContain(DEPLOYMENT_SECRET);
  });

  it("supports tenant templating and audience passthrough", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const { status, body } = await authorize(NINJA_INTEGRATION_ID, {
      authorizeEndpoint: "https://login-in-test.invalid/{tenant}/authorize",
      tenant: "tenant-1",
      audience: "https://api-in-test.invalid",
    });
    expect(status).toBe(200);
    const url = new URL(authorizationOf(body).authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://login-in-test.invalid/tenant-1/authorize");
    expect(url.searchParams.get("audience")).toBe("https://api-in-test.invalid");
  });

  it("denies non-admin callers and strangers, and answers 404 across orgs without leaking", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const denied = await worker.fetch(
      call(`/api/connections/${NINJA_INTEGRATION_ID}/oauth/authorize`, "POST", {
        redirectUri: REDIRECT_URI,
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        clientId: CLIENT_ID,
        scope: SCOPE,
      }),
      asMember(),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "CONNECTION_FORBIDDEN" } });
    expect(
      (
        await worker.fetch(
          new Request(`https://local.test/api/connections/${NINJA_INTEGRATION_ID}/oauth/authorize`),
          bindings,
        )
      ).status,
    ).toBe(401);
    // The foreign org is admin of its own org yet sees 404 — never the row.
    const foreign = await worker.fetch(
      call(`/api/connections/${NINJA_INTEGRATION_ID}/oauth/authorize`, "POST", {
        redirectUri: REDIRECT_URI,
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        clientId: CLIENT_ID,
        scope: SCOPE,
      }),
      asForeignOrg(),
    );
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as Record<string, unknown>;
    expect(foreignBody).toMatchObject({ error: { code: "CONNECTION_NOT_FOUND" } });
    expect(JSON.stringify(foreignBody)).not.toContain(ORG_A);
  });

  it("answers 404 without a mapping, 409 on managed rows, and 400 where consent is unsupported", async () => {
    const missing = await authorize();
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "CONNECTION_NOT_FOUND" } });
    const unknown = await authorize("00000000-0000-4000-8000-000000000099");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: "UNKNOWN_INTEGRATION" } });
    await seedMapping(ORG_A, USER_ADMIN);
    await bindings.DB.prepare("UPDATE connections SET managed_by='bundle@1' WHERE org_id=?").bind(ORG_A).run();
    const managed = await authorize();
    expect(managed.status).toBe(409);
    expect(managed.body).toMatchObject({ error: { code: "MANAGED_RESOURCE" } });
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG_A).run();
    await createConnection(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, ECHO_INTEGRATION_ID, { config: {} });
    const unsupported = await authorize(ECHO_INTEGRATION_ID);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toMatchObject({ error: { code: "OAUTH_CONSENT_UNSUPPORTED" } });
  });

  it("fails closed on invalid operator parameters", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const bad = [
      { redirectUri: "not a url" },
      { redirectUri: "ftp://files-in-test.invalid/callback" },
      { redirectUri: "https://user:pass@hooks-in-test.invalid/callback" },
      { redirectUri: "" },
      { redirectUri: `https://hooks-in-test.invalid/${"c".repeat(2048)}` },
      { authorizeEndpoint: 42 },
      { authorizeEndpoint: "" },
      { authorizeEndpoint: "not a url" },
      { authorizeEndpoint: "ftp://login-in-test.invalid/authorize" },
      { authorizeEndpoint: "https://user:pass@login-in-test.invalid/authorize" },
      { authorizeEndpoint: "https://login-in-test.invalid/{tenant}/authorize" },
      {
        authorizeEndpoint: "https://login-in-test.invalid/{tenant}/authorize",
        tenant: "../escape",
      },
      { clientId: "" },
      { scope: "" },
    ];
    for (const override of bad) {
      const { status, body } = await authorize(NINJA_INTEGRATION_ID, override);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: { code: "OAUTH_REQUEST_INVALID" } });
    }
    expect(vendorCalls).toHaveLength(0);
  });
});

describe("consent callback (single-use exchange plus fenced persist)", () => {
  it("persists exactly one generation from one vendor POST, with ciphertext-only storage", async () => {
    const mapping = await seedMapping(ORG_A, USER_ADMIN);
    const issued = authorizationOf((await authorize()).body);
    vendorScript = [
      tokenJson({ access_token: ACCESS_A, refresh_token: REFRESH_A, token_type: "Bearer", expires_in: 3600 }),
    ];
    const { status, body } = await callback(NINJA_INTEGRATION_ID, {
      code: "test-auth-code-alpha",
      state: issued.state,
      expectedState: issued.state,
      codeVerifier: issued.codeVerifier,
      redirectUri: REDIRECT_URI,
      tokenPath: TOKEN_PATH,
      scope: SCOPE,
      clientId: CLIENT_ID,
    });
    expect(status).toBe(200);
    const consent = body.consent as {
      connectionId: string;
      generation: number;
      scope: string;
      expiresAtMs: number;
      health: { status: string };
    };
    expect(consent).toMatchObject({
      connectionId: mapping.id,
      generation: 1,
      scope: SCOPE,
      health: { status: "healthy", consecutiveFailures: 0 },
    });
    expect(typeof consent.expiresAtMs).toBe("number");
    // Exactly one vendor POST carrying the code, verifier, and secret.
    expect(vendorCalls).toHaveLength(1);
    expect(vendorCalls[0]?.url).toBe("https://ninja-in-test.invalid/oauth/token");
    const form = new URLSearchParams(vendorCalls[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("test-auth-code-alpha");
    expect(form.get("code_verifier")).toBe(issued.codeVerifier);
    expect(form.get("client_secret")).toBe(DEPLOYMENT_SECRET);
    // No raw-secret readback: neither the response nor any D1 row carries
    // token values outside the envelope ciphertext.
    const text = JSON.stringify(body);
    expect(text).not.toContain(ACCESS_A);
    expect(text).not.toContain(REFRESH_A);
    expect(text).not.toContain(DEPLOYMENT_SECRET);
    const rows = await bindings.DB.prepare("SELECT * FROM oauth_tokens").all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain(ACCESS_A);
    expect(JSON.stringify(rows.results)).not.toContain(REFRESH_A);
    expect(await readOAuthTokenState(bindings.DB, ORG_A, mapping.id)).toMatchObject({ generation: 1 });
  });

  it("rejects bad state, denial, and missing codes before any vendor contact", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const issued = authorizationOf((await authorize()).body);
    const base = {
      code: "test-auth-code-alpha",
      state: issued.state,
      expectedState: issued.state,
      codeVerifier: issued.codeVerifier,
      redirectUri: REDIRECT_URI,
      tokenPath: TOKEN_PATH,
      scope: SCOPE,
      clientId: CLIENT_ID,
    };
    const mismatch = await callback(NINJA_INTEGRATION_ID, { ...base, state: "wrong-state" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ error: { code: "OAUTH_STATE_MISMATCH" } });
    // Vendor prose in the denial never reaches the Fault: fixed text only.
    const denied = await callback(NINJA_INTEGRATION_ID, {
      ...base,
      error: "access_denied",
      errorDescription: `vendor prose naming ${ACCESS_A}`,
    });
    expect(denied.status).toBe(400);
    expect(denied.body).toMatchObject({ error: { code: "OAUTH_AUTHORIZATION_DENIED" } });
    expect(JSON.stringify(denied.body)).not.toContain(ACCESS_A);
    const missing = await callback(NINJA_INTEGRATION_ID, { ...base, code: undefined });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: { code: "OAUTH_CALLBACK_INVALID" } });
    expect(vendorCalls).toHaveLength(0);
    const tokens = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").first<{ n: number }>();
    expect(tokens?.n).toBe(0);
  });

  it("fails replayed codes at the vendor with no second persist", async () => {
    const mapping = await seedMapping(ORG_A, USER_ADMIN);
    const issued = authorizationOf((await authorize()).body);
    vendorHandler = singleUseVendor({ access_token: ACCESS_A, refresh_token: REFRESH_A, token_type: "Bearer" });
    const attempt = (code: string) =>
      callback(NINJA_INTEGRATION_ID, {
        code,
        state: issued.state,
        expectedState: issued.state,
        codeVerifier: issued.codeVerifier,
        redirectUri: REDIRECT_URI,
        tokenPath: TOKEN_PATH,
        clientId: CLIENT_ID,
      });
    // Scope omitted: the exchange omits the parameter and persists "".
    const first = await attempt("test-auth-code-alpha");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ consent: { generation: 1, scope: "" } });
    const replay = await attempt("test-auth-code-alpha");
    expect(replay.status).toBe(502);
    expect(replay.body).toMatchObject({ error: { code: "OAUTH_EXCHANGE_FAILED" } });
    // One vendor POST per attempt; the replay persisted nothing new and the
    // committed generation stays healthy (the failure implicates the spent
    // code, never the stored credential, so no failure write lands).
    expect(vendorCalls).toHaveLength(2);
    expect(await readOAuthTokenState(bindings.DB, ORG_A, mapping.id)).toMatchObject({
      generation: 1,
      health: { status: "healthy" },
    });
  });

  it("re-consents through the generation-fenced replace path", async () => {
    const mapping = await seedMapping(ORG_A, USER_ADMIN);
    vendorScript = [
      tokenJson({ access_token: ACCESS_A, refresh_token: REFRESH_A, token_type: "Bearer", expires_in: 3600 }),
      tokenJson({ access_token: ACCESS_B, refresh_token: REFRESH_B, token_type: "Bearer", expires_in: 1800 }),
      tokenJson({ access_token: ACCESS_C, token_type: "Bearer" }),
    ];
    const attempt = async (code: string, issued: { state: string; codeVerifier: string }, scope?: string) =>
      callback(NINJA_INTEGRATION_ID, {
        code,
        state: issued.state,
        expectedState: issued.state,
        codeVerifier: issued.codeVerifier,
        redirectUri: REDIRECT_URI,
        tokenPath: TOKEN_PATH,
        ...(scope === undefined ? {} : { scope }),
        clientId: CLIENT_ID,
      });
    const stored = await attempt("test-auth-code-alpha", authorizationOf((await authorize()).body), SCOPE);
    expect(stored.status).toBe(200);
    const replaced = await attempt("test-auth-code-beta", authorizationOf((await authorize()).body), SCOPE);
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ consent: { generation: 2, scope: SCOPE } });
    const bare = await attempt("test-auth-code-gamma", authorizationOf((await authorize()).body));
    expect(bare.status).toBe(200);
    expect(bare.body).toMatchObject({ consent: { generation: 3, scope: "" } });
    expect(vendorCalls).toHaveLength(3);
    expect(await readOAuthTokenState(bindings.DB, ORG_A, mapping.id)).toMatchObject({
      generation: 3,
      scope: "",
      health: { status: "healthy" },
    });
  });

  it("prefers the per-Organization client secret over the deployment credential", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    await putConnectionSecrets(
      bindings.DB,
      { orgId: ORG_A, userId: USER_ADMIN },
      NINJA_INTEGRATION_ID,
      { clientSecret: PER_ORG_SECRET },
      KEK,
    );
    const issued = authorizationOf((await authorize()).body);
    vendorScript = [tokenJson({ access_token: ACCESS_C, token_type: "Bearer" })];
    const { status, body } = await callback(NINJA_INTEGRATION_ID, {
      code: "test-auth-code-alpha",
      state: issued.state,
      expectedState: issued.state,
      codeVerifier: issued.codeVerifier,
      redirectUri: REDIRECT_URI,
      tokenPath: TOKEN_PATH,
      clientId: CLIENT_ID,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ consent: { generation: 1, scope: "" } });
    expect(vendorCalls).toHaveLength(1);
    const form = new URLSearchParams(vendorCalls[0]?.body ?? "");
    expect(form.get("client_secret")).toBe(PER_ORG_SECRET);
    expect(vendorCalls[0]?.body).not.toContain(DEPLOYMENT_SECRET);
  });

  it("answers before the vendor call when the secret store or client secret is missing", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const issued = authorizationOf((await authorize()).body);
    const base = {
      code: "test-auth-code-alpha",
      state: issued.state,
      expectedState: issued.state,
      codeVerifier: issued.codeVerifier,
      redirectUri: REDIRECT_URI,
      tokenPath: TOKEN_PATH,
      scope: SCOPE,
      clientId: CLIENT_ID,
    };
    vendorScript = [tokenJson({ access_token: ACCESS_A, token_type: "Bearer" })];
    const noKek = await callback(NINJA_INTEGRATION_ID, base, { ...bindings, SECRETS_KEK: undefined });
    expect(noKek.status).toBe(502);
    expect(noKek.body).toMatchObject({ error: { code: "SECRET_STORE_NOT_CONFIGURED" } });
    const noSecret = await callback(NINJA_INTEGRATION_ID, base, { ...bindings, NINJA_CLIENT_SECRET: undefined });
    expect(noSecret.status).toBe(502);
    expect(noSecret.body).toMatchObject({ error: { code: "OAUTH_NOT_CONFIGURED" } });
    // Neither failure burned the single-use code: no vendor call either way.
    expect(vendorCalls).toHaveLength(0);
  });

  it("denies non-admin callers and scopes callbacks per Organization", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const issued = authorizationOf((await authorize()).body);
    const base = {
      code: "test-auth-code-alpha",
      state: issued.state,
      expectedState: issued.state,
      codeVerifier: issued.codeVerifier,
      redirectUri: REDIRECT_URI,
      tokenPath: TOKEN_PATH,
      scope: SCOPE,
      clientId: CLIENT_ID,
    };
    const denied = await callback(NINJA_INTEGRATION_ID, base, asMember());
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: "CONNECTION_FORBIDDEN" } });
    const foreign = await callback(NINJA_INTEGRATION_ID, base, asForeignOrg());
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ error: { code: "CONNECTION_NOT_FOUND" } });
    expect(JSON.stringify(foreign.body)).not.toContain(ORG_A);
    await bindings.DB.prepare("UPDATE connections SET managed_by='bundle@1' WHERE org_id=?").bind(ORG_A).run();
    const managed = await callback(NINJA_INTEGRATION_ID, base);
    expect(managed.status).toBe(409);
    expect(managed.body).toMatchObject({ error: { code: "MANAGED_RESOURCE" } });
    expect(vendorCalls).toHaveLength(0);
  });

  it("refuses callback consent where the Integration holds no OAuth client secret", async () => {
    await createConnection(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, ECHO_INTEGRATION_ID, { config: {} });
    const { status, body } = await callback(ECHO_INTEGRATION_ID, {
      code: "test-auth-code-alpha",
      state: "state",
      expectedState: "state",
      codeVerifier: "verifier",
      redirectUri: REDIRECT_URI,
      tokenPath: TOKEN_PATH,
      clientId: CLIENT_ID,
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "OAUTH_CONSENT_UNSUPPORTED" } });
    expect(vendorCalls).toHaveLength(0);
  });

  it("fails closed on invalid callback parameters, including absolute token URLs", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    const issued = authorizationOf((await authorize()).body);
    const base = {
      code: "test-auth-code-alpha",
      state: issued.state,
      expectedState: issued.state,
      codeVerifier: issued.codeVerifier,
      redirectUri: REDIRECT_URI,
      tokenPath: TOKEN_PATH,
      scope: SCOPE,
      clientId: CLIENT_ID,
    };
    const bad: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: { ...base, expectedState: undefined }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, codeVerifier: undefined }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, codeVerifier: "v".repeat(129) }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, redirectUri: "ftp://hooks-in-test.invalid/callback" }, code: "OAUTH_REQUEST_INVALID" },
      // Absolute token URLs are rejected: the exchange resolves a
      // same-host path only, so the client secret cannot be steered to an
      // operator-chosen host. Protocol-relative and backslash paths would
      // change the host under WHATWG URL resolution, so they fail too.
      { body: { ...base, tokenPath: "https://evil-in-test.invalid/oauth/token" }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, tokenPath: "//evil-in-test.invalid/oauth/token" }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, tokenPath: "/\\evil-in-test.invalid/oauth/token" }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, tokenPath: "oauth/token" }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, clientId: "" }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, clientId: "c".repeat(257) }, code: "OAUTH_REQUEST_INVALID" },
      { body: { ...base, scope: 42 }, code: "OAUTH_SCOPE_INVALID" },
      { body: { ...base, scope: "s".repeat(1025) }, code: "OAUTH_SCOPE_INVALID" },
    ];
    for (const entry of bad) {
      const { status, body } = await callback(NINJA_INTEGRATION_ID, entry.body);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: { code: entry.code } });
    }
    expect(vendorCalls).toHaveLength(0);
  });

  it("exposes the vendor seam directly for handler-level tests", async () => {
    const mapping = await seedMapping(ORG_A, USER_ADMIN);
    const issued = authorizationOf((await authorize()).body);
    const calls: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push(typeof init?.body === "string" ? init.body : "");
      return tokenJson({ access_token: ACCESS_B, refresh_token: REFRESH_B, token_type: "Bearer" });
    }) as typeof fetch;
    const consented = await handleOAuthCallback(
      bindings.DB,
      { orgId: ORG_A, userId: USER_ADMIN },
      {
        integrationId: NINJA_INTEGRATION_ID,
        code: "test-auth-code-direct",
        state: issued.state,
        expectedState: issued.state,
        codeVerifier: issued.codeVerifier,
        redirectUri: REDIRECT_URI,
        tokenPath: TOKEN_PATH,
        scope: SCOPE,
        clientId: CLIENT_ID,
        fetchImpl,
        timeoutMs: 1000,
      },
      bindings,
    );
    expect(consented).toMatchObject({ connectionId: mapping.id, generation: 1, scope: SCOPE });
    expect(calls).toHaveLength(1);
    // The route-level global fetch mock saw nothing: the seam carried it.
    expect(vendorCalls).toHaveLength(0);
  });
});

describe("Integration-list credential health (OAUTH-01 aggregate)", () => {
  async function seedToken(orgId: string, userId: string, access: string) {
    const mapping = await seedMapping(orgId, userId);
    await storeInitialOAuthToken(bindings.DB, {
      orgId,
      connectionId: mapping.id,
      accessToken: access,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    return mapping.id;
  }

  function entryOf(body: Record<string, unknown>, integrationId: string) {
    const entries = body.integrations as Array<Record<string, unknown>>;
    const found = entries.find((entry) => entry.integrationId === integrationId);
    if (!found) throw new Error("missing aggregate entry");
    return found;
  }

  it("reports Degraded over a mixed-health effective set with mapping count separate", async () => {
    await seedToken(ORG_A, USER_ADMIN, ACCESS_A);
    const failedId = await seedToken(ORG_B, FOREIGN_USER, ACCESS_B);
    await recordOAuthTokenFailure(bindings.DB, ORG_B, failedId, "OAUTH_EXCHANGE_FAILED", AT);
    const revokedId = await seedToken(ORG_C, FOREIGN_USER, ACCESS_C);
    await recordOAuthTokenRevoked(bindings.DB, ORG_C, revokedId, AT);
    // A bare mapping with no token shapes mappingCount alone, never health.
    await createConnection(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, ECHO_INTEGRATION_ID, { config: {} });
    const response = await worker.fetch(call("/api/integrations/health"), asInstanceAdmin());
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(entryOf(body, NINJA_INTEGRATION_ID)).toEqual({
      integrationId: NINJA_INTEGRATION_ID,
      integrationName: "ninjaone",
      mappingCount: 3,
      connectedCount: 1,
      needsReconnectionCount: 2,
      connectionStatusCounts: { healthy: 1, failed: 1, revoked: 1 },
      status: "Degraded",
    });
    expect(entryOf(body, ECHO_INTEGRATION_ID)).toMatchObject({
      mappingCount: 1,
      connectedCount: 0,
      needsReconnectionCount: 0,
      connectionStatusCounts: {},
      status: "None",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(ACCESS_A);
    expect(text).not.toContain(ACCESS_B);
    expect(text).not.toContain(ACCESS_C);
    expect(text).not.toContain(DEPLOYMENT_SECRET);
    expect(text).not.toContain(ORG_A);
    expect(vendorCalls).toHaveLength(0);
  });

  it("reports Connected, Failed, and None exactly", async () => {
    const healthyId = await seedToken(ORG_A, USER_ADMIN, ACCESS_A);
    const failedId = await seedToken(ORG_B, FOREIGN_USER, ACCESS_B);
    await recordOAuthTokenFailure(bindings.DB, ORG_B, failedId, "OAUTH_EXCHANGE_FAILED", AT);
    const admin = asInstanceAdmin();
    const mixed = await jsonOf(await worker.fetch(call("/api/integrations/health"), admin));
    expect(entryOf(mixed, NINJA_INTEGRATION_ID)).toMatchObject({ status: "Degraded" });
    await recordOAuthTokenFailure(bindings.DB, ORG_A, healthyId, "OAUTH_EXCHANGE_FAILED", AT);
    const failed = await jsonOf(await worker.fetch(call("/api/integrations/health"), admin));
    expect(entryOf(failed, NINJA_INTEGRATION_ID)).toEqual({
      integrationId: NINJA_INTEGRATION_ID,
      integrationName: "ninjaone",
      mappingCount: 2,
      connectedCount: 0,
      needsReconnectionCount: 2,
      connectionStatusCounts: { failed: 2 },
      status: "Failed",
    });
    await bindings.DB.prepare("DELETE FROM oauth_tokens").run();
    const none = await jsonOf(await worker.fetch(call("/api/integrations/health"), admin));
    // Mappings without tokens: health None, mappingCount intact.
    expect(entryOf(none, NINJA_INTEGRATION_ID)).toMatchObject({
      mappingCount: 2,
      connectedCount: 0,
      needsReconnectionCount: 0,
      status: "None",
    });
    await bindings.DB.prepare("DELETE FROM connections").run();
    const empty = await jsonOf(await worker.fetch(call("/api/integrations/health"), admin));
    expect(entryOf(empty, NINJA_INTEGRATION_ID)).toMatchObject({ mappingCount: 0, status: "None" });
    expect(entryOf(empty, ECHO_INTEGRATION_ID)).toMatchObject({ mappingCount: 0, status: "None" });
  });

  it("restricts the cross-org aggregate to instance admins", async () => {
    await seedMapping(ORG_A, USER_ADMIN);
    // The LAB fixture caller is an org admin but not an instance admin.
    const orgAdmin = await worker.fetch(call("/api/integrations/health"), bindings);
    expect(orgAdmin.status).toBe(403);
    expect(await orgAdmin.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
    const member = await worker.fetch(call("/api/integrations/health"), asMember());
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
    expect((await worker.fetch(new Request("https://local.test/api/integrations/health"), bindings)).status).toBe(401);
    const queried = await worker.fetch(call("/api/integrations/health?scope=all"), asInstanceAdmin());
    expect(queried.status).toBe(400);
    expect(await queried.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  });

  it("skips unknown-integration rows and answers None on pre-0031 chains", async () => {
    await seedToken(ORG_A, USER_ADMIN, ACCESS_A);
    // A stale row for a retired Integration plus garbage-ciphertext health
    // the aggregate must never attempt to decrypt.
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000901", ORG_A, "00000000-0000-4000-8000-000000000099", ENDPOINT)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO oauth_tokens(connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,key_version,algorithm,generation,scope,status,consecutive_failures,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000000000901",
        ORG_A,
        "not-ciphertext",
        "not-a-nonce",
        "not-a-dek",
        1,
        "AES-GCM-256",
        1,
        "",
        "failed",
        3,
        AT,
        AT,
      )
      .run();
    const admin = asInstanceAdmin();
    const body = await jsonOf(await worker.fetch(call("/api/integrations/health"), admin));
    expect(entryOf(body, NINJA_INTEGRATION_ID)).toMatchObject({
      mappingCount: 1,
      connectedCount: 1,
      needsReconnectionCount: 0,
      status: "Connected",
    });
    // Pre-0031 chain: the table is gone, every Integration answers None.
    await bindings.DB.exec("DROP TABLE oauth_tokens");
    const dropped = await jsonOf(await worker.fetch(call("/api/integrations/health"), admin));
    expect(entryOf(dropped, NINJA_INTEGRATION_ID)).toMatchObject({
      mappingCount: 1,
      connectedCount: 0,
      needsReconnectionCount: 0,
      connectionStatusCounts: {},
      status: "None",
    });
  });
});
