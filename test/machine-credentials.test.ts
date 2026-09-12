// SPDX-License-Identifier: AGPL-3.0
// AUTH-03 (issue #144): scoped machine credentials and delegated human
// identity parity, proven against the real local runtime (workerd D1 +
// local Workflow bindings; only the Access certs fetch and no vendor calls
// are stubbed — hello deliveries dispatch no vendor HTTP).
//
// Evidence matrix:
// - credential classes (pure): human/service/fixture/endpoint classification.
// - GET /api/auth/me over LAB: fixture identity, role/kind, deny cases
//   (stranger 404, disabled user 403, revoked/suspended membership 403,
//   foreign-org selection 404), no raw-secret readback, query denial.
// - Access human/service over the Worker: allowlisted email and service
//   common_name verify end to end; unlisted 403; service identities need an
//   onboarded membership row (404 until invited, active on first verified
//   use); expired/wrong-aud/forged assertions fail 401 (the in-Worker half
//   of MFA/SSO session enforcement); unconfigured Access fails 503 and never
//   falls through to LAB; direct-origin callers without an assertion still
//   face LAB.
// - Scoped endpoint credentials (the workflow-key analogue): raw-once
//   issuance, no digest/raw in summaries, rotation invalidates the old key,
//   disable revokes, expiry denies, wrong keys deny, foreign orgs 404, and
//   deliveries run under the endpoint principal (invisible to the operator).
// - SDK/CLI/MCP identity: the typed client reads the same route, so every
//   caller family preserves the same identity.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { credentialClassFor, clearAccessCertCache, isEndpointPrincipal, isServicePrincipal } from "../src/access";
import { describeCaller } from "../src/auth";
import { helloSaga } from "../src/domain";
import { createSdkClient, describeContract, parseCallerIdentity, SdkError, SDK_ERROR_CODES } from "../src/sdk";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration21 from "../migrations/0021_endpoints.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const STRANGER = "00000000-0000-4000-8000-000000000003";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const LAB = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const ACCESS_ORG = "11111111-1111-4111-8111-111111111111";
const EMAIL = "admin@example.com";
const SERVICE = "wrangnarok-machine-final";

function labHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...LAB, ...extra };
}

function call(path: string, init: RequestInit, envOverride: Bindings = bindings): Promise<Response> {
  return worker.fetch(new Request(`http://local.test${path}`, init), envOverride);
}

function authed(path: string, method: string, body?: unknown, extra?: Record<string, string>): Promise<Response> {
  return call(
    path,
    { method, headers: labHeaders(extra), ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    bindings,
  );
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair() {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
}

async function mint(priv: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

function certsStub(pubJwk: JsonWebKey, kid: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) === `${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...pubJwk, kid, alg: "RS256" }] });
    }
    throw new Error("machine-credentials tests must not fetch");
  });
}

function accessPayload(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], exp: now + 300, iat: now - 10, email: EMAIL, ...overrides };
}

function accessBindings(extra: Record<string, string> = {}): Bindings {
  const next = {
    ...(bindings as unknown as Record<string, unknown>),
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_ORG_ID: ACCESS_ORG,
    ACCESS_ALLOWED_EMAILS: EMAIL,
    ...extra,
  } as unknown as Bindings;
  delete (next as unknown as Record<string, unknown>).LAB_ENABLED;
  delete (next as unknown as Record<string, unknown>).LAB_TOKEN;
  return next;
}

async function onboardAccessMember(userId: string, status: "invited" | "active" = "active"): Promise<void> {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,'Access team','active',?,NULL)",
  )
    .bind(ACCESS_ORG.toLowerCase(), stamp)
    .run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(userId, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?, 'member',?,'ordinary',?,?)",
  )
    .bind(ACCESS_ORG.toLowerCase(), userId, status, stamp, stamp)
    .run();
}

async function accessRequest(token: string, envOverride?: Bindings): Promise<Response> {
  return worker.fetch(
    new Request("http://local.test/api/auth/me", { headers: { "Cf-Access-Jwt-Assertion": token } }),
    envOverride ?? accessBindings(),
  );
}

beforeEach(async () => {
  clearAccessCertCache();
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration21);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("credential classes (pure, access.ts)", () => {
  it("recognizes service and endpoint principal shapes", () => {
    expect(isServicePrincipal("service:wrangnarok-machine-final")).toBe(true);
    expect(isServicePrincipal("service:")).toBe(false);
    expect(isServicePrincipal("admin@example.com")).toBe(false);
    expect(isEndpointPrincipal("endpoint:0af3c1")).toBe(true);
    expect(isEndpointPrincipal("endpoint:")).toBe(false);
    expect(isEndpointPrincipal("service:x")).toBe(false);
  });

  it("classifies every verified caller into one credential class", () => {
    // Endpoint delivery principals win over every other prefix so a future
    // `service:`-prefixed endpoint id can never read as a service token.
    expect(credentialClassFor("endpoint:abc", true)).toBe("endpoint");
    expect(credentialClassFor("endpoint:abc", false)).toBe("endpoint");
    expect(credentialClassFor("service:ci", true)).toBe("service");
    expect(credentialClassFor("service:ci", false)).toBe("service");
    expect(credentialClassFor("admin@example.com", true)).toBe("human");
    expect(credentialClassFor(LAB_USER, false)).toBe("fixture");
  });

  it("describes the caller from the verified Principal, never request input", () => {
    const human = describeCaller(
      { userId: EMAIL, orgId: ACCESS_ORG },
      new Request("http://local.test/api/auth/me", { headers: { "Cf-Access-Jwt-Assertion": "x" } }),
    );
    expect(human).toEqual({
      userId: EMAIL,
      orgId: ACCESS_ORG,
      credentialClass: "human",
      viaAccess: true,
      fixture: false,
    });
    const fixture = describeCaller(
      { userId: LAB_USER, orgId: ORG },
      new Request("http://local.test/api/auth/me", { headers: labHeaders() }),
    );
    expect(fixture.credentialClass).toBe("fixture");
    expect(fixture.fixture).toBe(true);
    expect(fixture.viaAccess).toBe(false);
  });
});

describe("GET /api/auth/me over the LAB fixture", () => {
  it("reports the fixture identity with membership role and kind", async () => {
    const res = await authed("/api/auth/me", "GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caller: {
        userId: LAB_USER,
        orgId: ORG,
        credentialClass: "fixture",
        viaAccess: false,
        fixture: true,
      },
      role: "admin",
      kind: "ordinary",
    });
  });

  it("carries no raw secrets and denies query strings", async () => {
    const res = await authed("/api/auth/me", "GET");
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
    const queried = await call("/api/auth/me?verbose=1", { method: "GET", headers: labHeaders() });
    expect(queried.status).toBe(400);
    expect(await queried.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  });

  it("denies strangers, disabled users, and revoked or suspended memberships", async () => {
    // Stranger: known user, no membership row — 404, never a leak.
    const stamp = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(STRANGER, stamp)
      .run();
    const strangerEnv = { ...bindings, LAB_USER_ID: STRANGER, LAB_FIXTURE_USER_ID: LAB_USER };
    const stranger = await call("/api/auth/me", { method: "GET", headers: labHeaders() }, strangerEnv);
    expect(stranger.status).toBe(404);
    expect(await stranger.json()).toMatchObject({ error: { code: "ORG_NOT_FOUND" } });

    // Lifecycle denials pin against a non-fixture member: the LAB bootstrap
    // keeps the fixture identity itself an active admin (AUTH-01), so
    // revocation evidence uses an onboarded member. Swapped LAB_USER_ID
    // identities skip the bootstrap (LAB_FIXTURE_USER_ID preserves it).
    const MEMBER = "00000000-0000-4000-8000-000000000006";
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(MEMBER, stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?, 'member','active','ordinary',?,?)",
    )
      .bind(ORG, MEMBER, stamp, stamp)
      .run();
    const memberEnv = { ...bindings, LAB_USER_ID: MEMBER, LAB_FIXTURE_USER_ID: LAB_USER };
    const memberCall = () => call("/api/auth/me", { method: "GET", headers: labHeaders() }, memberEnv);
    const live = await memberCall();
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      caller: { userId: MEMBER, credentialClass: "fixture" },
      role: "member",
    });

    // Revoked membership denies on the next request (no redeploy, no sessions).
    await bindings.DB.prepare("UPDATE org_memberships SET status='revoked' WHERE org_id=? AND user_id=?")
      .bind(ORG, MEMBER)
      .run();
    const revoked = await memberCall();
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ error: { code: "MEMBERSHIP_REVOKED" } });
    await bindings.DB.prepare("UPDATE org_memberships SET status='suspended' WHERE org_id=? AND user_id=?")
      .bind(ORG, MEMBER)
      .run();
    const suspended = await memberCall();
    expect(suspended.status).toBe(403);
    expect(await suspended.json()).toMatchObject({ error: { code: "MEMBERSHIP_SUSPENDED" } });
    await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
      .bind(ORG, MEMBER)
      .run();

    // Disabled users are denied; the bootstrap never resurrects them.
    await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(MEMBER).run();
    const disabled = await memberCall();
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ error: { code: "USER_DISABLED" } });
  });

  it("denies foreign-org scope selection without leaking existence", async () => {
    const stamp = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,'Other','active',?,NULL)",
    )
      .bind(OTHER_ORG, stamp)
      .run();
    const foreign = await authed("/api/auth/me", "GET", undefined, { "X-Organization-Id": OTHER_ORG });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "ORG_NOT_FOUND" } });
  });

  it("rejects bad fixture tokens and answers 404 when LAB is off", async () => {
    const wrong = await call("/api/auth/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${"b".repeat(64)}`, "Content-Type": "application/json" },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    const off = { ...(bindings as unknown as Record<string, unknown>) } as unknown as Bindings;
    delete (off as unknown as Record<string, unknown>).LAB_ENABLED;
    const missing = await worker.fetch(new Request("http://local.test/api/auth/me"), off);
    expect(missing.status).toBe(404);
  });
});

describe("Access human and service identity over the Worker", () => {
  it("verifies an allowlisted human end to end with membership role", async () => {
    const { publicKey, privateKey } = await keypair();
    certsStub(await crypto.subtle.exportKey("jwk", publicKey), "k1");
    await onboardAccessMember(EMAIL.toLowerCase());
    const res = await accessRequest(await mint(privateKey, "k1", accessPayload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caller: {
        userId: EMAIL,
        orgId: ACCESS_ORG.toLowerCase(),
        credentialClass: "human",
        viaAccess: true,
        fixture: false,
      },
      role: "member",
      kind: "ordinary",
    });
  });

  it("denies unlisted humans without onboarding them", async () => {
    const { publicKey, privateKey } = await keypair();
    certsStub(await crypto.subtle.exportKey("jwk", publicKey), "k1");
    const res = await accessRequest(await mint(privateKey, "k1", accessPayload({ email: "intruder@example.com" })));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("requires service identities to be onboarded, then activates on first verified use", async () => {
    const { publicKey, privateKey } = await keypair();
    certsStub(await crypto.subtle.exportKey("jwk", publicKey), "k1");
    const serviceEnv = accessBindings({ ACCESS_ALLOWED_SERVICES: SERVICE });
    const token = await mint(privateKey, "k1", {
      aud: [AUD],
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000) - 10,
      common_name: SERVICE,
    });
    // No membership row yet: 404, the same closed gate humans face.
    const before = await accessRequest(token, serviceEnv);
    expect(before.status).toBe(404);
    // Invite (external-user onboarding path) then verify: invited flips to
    // active on first verified use and the service class is reported.
    await onboardAccessMember(`service:${SERVICE}`, "invited");
    const after = await accessRequest(token, serviceEnv);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      caller: { userId: `service:${SERVICE}`, credentialClass: "service", viaAccess: true, fixture: false },
      role: "member",
    });
    const row = await bindings.DB.prepare("SELECT status FROM org_memberships WHERE org_id=? AND user_id=?")
      .bind(ACCESS_ORG.toLowerCase(), `service:${SERVICE}`)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("denies unlisted service identities", async () => {
    const { publicKey, privateKey } = await keypair();
    certsStub(await crypto.subtle.exportKey("jwk", publicKey), "k1");
    const res = await accessRequest(
      await mint(privateKey, "k1", {
        aud: [AUD],
        exp: Math.floor(Date.now() / 1000) + 300,
        common_name: "unknown-machine",
      }),
      accessBindings({ ACCESS_ALLOWED_SERVICES: SERVICE }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("treats expired, wrong-audience, and forged assertions as 401 session evidence", async () => {
    const { publicKey, privateKey } = await keypair();
    const other = await keypair();
    certsStub(await crypto.subtle.exportKey("jwk", publicKey), "k1");
    await onboardAccessMember(EMAIL.toLowerCase());
    const now = Math.floor(Date.now() / 1000);
    const expired = await accessRequest(await mint(privateKey, "k1", { ...accessPayload(), exp: now - 3600 }));
    expect(expired.status).toBe(401);
    const wrongAud = await accessRequest(await mint(privateKey, "k1", { ...accessPayload(), aud: ["nope"] }));
    expect(wrongAud.status).toBe(401);
    const forged = await accessRequest(await mint(other.privateKey, "k1", accessPayload()));
    expect(forged.status).toBe(401);
  });

  it("fails closed when Access is unconfigured and keeps the LAB bypass explicit", async () => {
    const { publicKey, privateKey } = await keypair();
    certsStub(await crypto.subtle.exportKey("jwk", publicKey), "k1");
    const token = await mint(privateKey, "k1", accessPayload());
    // An assertion with Access unconfigured answers 503, never LAB fallback.
    const bare = { ...(bindings as unknown as Record<string, unknown>) } as unknown as Bindings;
    delete (bare as unknown as Record<string, unknown>).LAB_ENABLED;
    const unconfigured = await worker.fetch(
      new Request("http://local.test/api/auth/me", { headers: { "Cf-Access-Jwt-Assertion": token } }),
      bare,
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: { code: "ACCESS_NOT_CONFIGURED" } });
    // Direct-origin callers with no assertion still face LAB (documented
    // bypass path): fixture identity when LAB is on, 404 when it is off.
    const direct = await authed("/api/auth/me", "GET");
    expect(await direct.json()).toMatchObject({ caller: { credentialClass: "fixture" } });
  });
});

describe("scoped endpoint credentials (workflow-key analogue)", () => {
  async function createEndpoint(name: string, kind: "api-key" | "webhook" = "api-key") {
    const res = await authed("/api/endpoints", "POST", { name, sagaId: helloSaga.id, kind });
    expect(res.status).toBe(201);
    return (await res.json()) as { endpoint: { id: string; name: string }; apiKey?: string; webhookSecret?: string };
  }

  function deliver(
    name: string,
    key: string | null,
    eventId: string | null,
    payload: unknown = { input: { name: "Ada" } },
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== null) headers["X-Endpoint-Key"] = key;
    if (eventId !== null) headers["X-Endpoint-Event-Id"] = eventId;
    return worker.fetch(
      new Request(`http://local.test/api/endpoints/${name}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }),
      bindings,
    );
  }

  it("issues the raw credential once and never reads it back", async () => {
    const created = await createEndpoint("greet");
    expect(typeof created.apiKey).toBe("string");
    expect((created.apiKey as string).length).toBe(64);
    for (const path of ["/api/endpoints", "/api/endpoints/greet"]) {
      const res = await authed(path, "GET");
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(created.apiKey as string);
      expect(text).not.toContain("key_hash");
      expect(text).not.toContain("apiKey");
    }
    const events = await authed("/api/endpoints/greet/events", "GET");
    expect(events.status).toBe(200);
  });

  it("delivers under the endpoint principal, invisible to the operator session", async () => {
    const { apiKey } = await createEndpoint("greet");
    const first = await deliver("greet", apiKey as string, "evt-001");
    expect(first.status).toBe(202);
    const body = (await first.json()) as { executionId: string; replayed: boolean };
    expect(body.replayed).toBe(false);
    expect(body.executionId).toMatch(/^[a-f0-9]{64}$/);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, body.executionId);
    await instance.waitForStatus("complete");
    // Least privilege: the operator session cannot see endpoint executions.
    const hidden = await authed(`/api/executions/${body.executionId}`, "GET");
    expect(hidden.status).toBe(404);
  });

  it("rotates, disables, and expires credentials with least privilege", async () => {
    const created = await createEndpoint("greet");
    const oldKey = created.apiKey as string;
    const rotated = await authed("/api/endpoints/greet/rotate", "POST", {});
    expect(rotated.status).toBe(200);
    const next = ((await rotated.json()) as { apiKey: string }).apiKey;
    expect(next).not.toBe(oldKey);
    // The old raw value stops verifying immediately (no TTL grace).
    const stale = await deliver("greet", oldKey, "evt-002");
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: { code: "ENDPOINT_UNAUTHORIZED" } });
    const fresh = await deliver("greet", next, "evt-003");
    expect(fresh.status).toBe(202);
    // Revocation: disabling answers 410 on delivery.
    expect((await authed("/api/endpoints/greet", "PATCH", { enabled: false })).status).toBe(200);
    const revoked = await deliver("greet", next, "evt-004");
    expect(revoked.status).toBe(410);
    expect(await revoked.json()).toMatchObject({ error: { code: "ENDPOINT_DISABLED" } });
    // Expiry: re-enable with a past expiry denies with the expiry code.
    expect(
      (await authed("/api/endpoints/greet", "PATCH", { enabled: true, keyExpiresAt: "2000-01-01T00:00:00.000Z" }))
        .status,
    ).toBe(200);
    const expired = await deliver("greet", next, "evt-005");
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: "ENDPOINT_KEY_EXPIRED" } });
  });

  it("rejects wrong keys and foreign-org operators without leaking", async () => {
    await createEndpoint("greet");
    const wrong = await deliver("greet", "wrong-key", "evt-010");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: "ENDPOINT_UNAUTHORIZED" } });
    const stamp = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(STRANGER, stamp)
      .run();
    const strangerEnv = { ...bindings, LAB_USER_ID: STRANGER, LAB_FIXTURE_USER_ID: LAB_USER };
    const foreign = await call("/api/endpoints/greet", { method: "GET", headers: labHeaders() }, strangerEnv);
    expect(foreign.status).toBe(404);
  });
});

describe("SDK, CLI, and MCP clients preserve the same identity", () => {
  function authedFetch(url: string | URL | Request, init?: RequestInit) {
    return worker.fetch(
      new Request(url, { ...(init ?? {}), headers: labHeaders(init?.headers as Record<string, string>) }),
      { ...bindings },
    );
  }

  it("reads the same identity through the typed client", async () => {
    const client = createSdkClient({
      base: "http://local.test",
      token: TOKEN,
      fetchImpl: authedFetch as typeof fetch,
      pollMs: 0,
    });
    const me = await client.whoAmI();
    expect(me).toEqual({
      userId: LAB_USER,
      orgId: ORG,
      credentialClass: "fixture",
      viaAccess: false,
      fixture: true,
      role: "admin",
      kind: "ordinary",
    });
    expect(parseCallerIdentity(JSON.parse(JSON.stringify({ caller: me, role: me.role, kind: me.kind })))).toEqual(me);
  });

  it("hits GET /api/auth/me and rejects drift without network", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(
        JSON.stringify({
          caller: { userId: "u", orgId: "o", credentialClass: "human", viaAccess: true, fixture: false },
          role: "member",
          kind: "ordinary",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl });
    expect((await client.whoAmI()).credentialClass).toBe("human");
    expect(seen).toEqual(["http://local.test/api/auth/me"]);
    expect(() => parseCallerIdentity({ caller: { credentialClass: "robot" } })).toThrow(SdkError);
    expect(() => parseCallerIdentity({})).toThrow(/unexpected shape/);
    // Every credential class parses, including the null role/kind shape the
    // collection gate returns for instance admins.
    for (const credentialClass of ["service", "endpoint"] as const) {
      expect(
        parseCallerIdentity({
          caller: {
            userId: credentialClass === "service" ? "service:ci" : "endpoint:abc",
            orgId: "o",
            credentialClass,
            viaAccess: credentialClass === "service",
            fixture: false,
          },
          role: null,
          kind: null,
        }).credentialClass,
      ).toBe(credentialClass);
    }
    expect(() =>
      parseCallerIdentity({
        caller: { userId: "u", orgId: "o", credentialClass: "human", viaAccess: true, fixture: false },
        role: 7,
        kind: null,
      }),
    ).toThrow(SdkError);
  });

  it("keeps the contract covering the identity route and capability", () => {
    const descriptor = describeContract();
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toContain("GET /api/auth/me");
    expect(descriptor.capabilities.find((entry) => entry.name === "credential-identity")?.status).toBe("supported");
    for (const code of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "UNSUPPORTED_QUERY", "ACCESS_NOT_CONFIGURED"]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
  });
});
