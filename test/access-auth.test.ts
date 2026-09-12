// SPDX-License-Identifier: AGPL-3.0
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  ACCESS_CERT_FETCH_TIMEOUT_MS,
  clearAccessCertCache,
  setAccessCertFetchTimeoutMs,
  verifyAccess,
} from "../src/access";
import { Fault } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "test-aud-tag";
const ORG = "11111111-1111-4111-8111-111111111111";
const EMAIL = "admin@example.com";
const accessEnv = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ACCESS_ORG_ID: ORG,
  ACCESS_ALLOWED_EMAILS: EMAIL,
};

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
    throw new Error("access-auth tests must not fetch");
  });
}

function validPayload() {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], exp: now + 300, iat: now - 10, email: EMAIL };
}

beforeEach(() => {
  clearAccessCertCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("accepts a valid assertion and maps email plus org", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const token = await mint(privateKey, "k1", validPayload());
  const p = await verifyAccess(token, accessEnv);
  expect(p).toEqual({ userId: EMAIL, orgId: ORG.toLowerCase() });
});

it("rejects wrong aud, expired, bad signature, unknown kid, malformed", async () => {
  const { publicKey, privateKey } = await keypair();
  const other = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, Record<string, unknown>, CryptoKey, string][] = [
    ["wrong-aud", { ...validPayload(), aud: ["nope"] }, privateKey, "k1"],
    ["expired", { ...validPayload(), exp: now - 3600 }, privateKey, "k1"],
    ["bad-sig", validPayload(), other.privateKey, "k1"],
    ["unknown-kid", validPayload(), privateKey, "zz"],
  ];
  for (const [name, payload, key, kid] of cases) {
    const token = await mint(key, kid, payload);
    await expect(verifyAccess(token, accessEnv), name).rejects.toMatchObject({ status: 401 });
  }
  await expect(verifyAccess("not.a.jwt.at.all.parts", accessEnv), "malformed").rejects.toMatchObject({ status: 401 });
  await expect(verifyAccess("abc", accessEnv), "segments").rejects.toMatchObject({ status: 401 });
});

it("denies unlisted email and fails closed when unconfigured", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const token = await mint(privateKey, "k1", { ...validPayload(), email: "intruder@example.com" });
  await expect(verifyAccess(token, accessEnv)).rejects.toMatchObject({ status: 403 });
  const valid = await mint(privateKey, "k1", validPayload());
  await expect(verifyAccess(valid, {})).rejects.toMatchObject({ status: 503 });
});

it("serves the catalog on a valid assertion without LAB configured", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const token = await mint(privateKey, "k1", validPayload());
  const bindings = { ...(env as unknown as Bindings), ...accessEnv };
  delete (bindings as Record<string, unknown>).LAB_ENABLED;
  delete (bindings as Record<string, unknown>).LAB_TOKEN;
  // AUTH-01 (ADR 015): the membership gate covers Access identities too, so
  // the allowlisted email needs a live membership before the catalog serves.
  const db = (env as unknown as Bindings).DB;
  await db.exec(migration1);
  await db.exec(seed);
  await db.exec(migration7);
  await db.exec(migration8);
  const stamp = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,'Access team','active',?,NULL)",
    )
    .bind(ORG.toLowerCase(), stamp)
    .run();
  await db
    .prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(EMAIL.toLowerCase(), stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?, 'member','active','ordinary',?,?)",
    )
    .bind(ORG.toLowerCase(), EMAIL.toLowerCase(), stamp, stamp)
    .run();
  const res = await worker.fetch(
    new Request("http://local.test/api/sagas", { headers: { "Cf-Access-Jwt-Assertion": token } }),
    bindings,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    sagas: expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
  });
});

it("keeps LAB behavior when no assertion header is present", async () => {
  const bindings = { ...(env as unknown as Bindings) };
  delete (bindings as Record<string, unknown>).LAB_ENABLED;
  const res = await worker.fetch(new Request("http://local.test/api/sagas"), bindings);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(new Fault(401, "UNAUTHORIZED", "Unauthorized.").status).toBe(401);
});

it("maps allowlisted service common_name without email", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const now = Math.floor(Date.now() / 1000);
  const token = await mint(privateKey, "k1", {
    aud: [AUD],
    exp: now + 300,
    iat: now - 10,
    common_name: "wrangnarok-machine-final",
  });
  const p = await verifyAccess(token, { ...accessEnv, ACCESS_ALLOWED_SERVICES: "wrangnarok-machine-final" });
  expect(p).toEqual({ userId: "service:wrangnarok-machine-final", orgId: ORG.toLowerCase() });
});

it("denies unlisted service identity", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const now = Math.floor(Date.now() / 1000);
  const token = await mint(privateKey, "k1", {
    aud: [AUD],
    exp: now + 300,
    iat: now - 10,
    common_name: "unknown-machine",
  });
  await expect(
    verifyAccess(token, { ...accessEnv, ACCESS_ALLOWED_SERVICES: "wrangnarok-machine-final" }),
  ).rejects.toMatchObject({ status: 403 });
});

it("covers access config and key edge branches", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  certsStub(pub, "k1");
  const valid = await mint(privateKey, "k1", validPayload());
  // Trailing slashes strip from the team domain (same cert URL either way,
  // so the token still verifies); whitespace-only allowlists parse to empty
  // sets (denied, never open).
  const slashed = { ...accessEnv, ACCESS_TEAM_DOMAIN: `${TEAM}///` };
  await expect(verifyAccess(valid, slashed)).resolves.toEqual({
    userId: EMAIL,
    orgId: ORG.toLowerCase(),
  });
  await expect(verifyAccess(valid, { ...accessEnv, ACCESS_ALLOWED_EMAILS: "  , " })).rejects.toMatchObject({
    status: 403,
  });
  // Malformed assertions fail closed before any key fetch: wrong part count,
  // non-JSON payload, and a bad algorithm all answer 401.
  await expect(verifyAccess("a.b", accessEnv)).rejects.toMatchObject({ status: 401 });
  const head = { alg: "none", kid: "k1", typ: "JWT" };
  const body = validPayload();
  const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await expect(verifyAccess(`${b64(head)}.${b64(body)}.x`, accessEnv)).rejects.toMatchObject({ status: 401 });
  const notJson = `${b64url(new TextEncoder().encode("hi"))}.${b64(body)}.x`;
  await expect(verifyAccess(notJson, accessEnv)).rejects.toMatchObject({ status: 401 });
});

it("evicts stale cert keys by TTL and refetches on next use", async () => {
  const { publicKey, privateKey } = await keypair();
  const pub = await crypto.subtle.exportKey("jwk", publicKey);
  const fetchSpy = certsStub(pub, "k1");
  // Far-future expiry: the clock jumps forward past the 6h entry TTL, and the
  // assertion must stay temporally valid so the test proves cache behavior
  // (a second cert fetch) rather than expiry rejection.
  const farPayload = () => {
    const now = Math.floor(Date.now() / 1000);
    return { aud: [AUD], exp: now + 8 * 60 * 60, iat: now - 10, email: EMAIL };
  };
  const token = await mint(privateKey, "k1", farPayload());
  await expect(verifyAccess(token, accessEnv)).resolves.toMatchObject({ userId: EMAIL });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  // Advance past the entry TTL: the sweep must drop k1, so the next lookup
  // refetches instead of serving the stale key.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 60 * 1000 + 1000);
  const rotated = await mint(privateKey, "k1", farPayload());
  await expect(verifyAccess(rotated, accessEnv)).resolves.toMatchObject({ userId: EMAIL });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it("caps the cert cache so hostile kid churn cannot grow it", async () => {
  // One rotating stub serves whichever single kid the lookup needs (the
  // request kid is the mock's current target). 40 distinct kids each miss
  // once and import; only the newest 32 stay cached. Re-resolving the
  // oldest kid misses again (eviction refetch), while two live kids churn
  // hit-for-hit with no further fetches (LRU recency refresh).
  const pairs = await Promise.all(Array.from({ length: 40 }, () => keypair()));
  const pubs = await Promise.all(pairs.map((p) => crypto.subtle.exportKey("jwk", p.publicKey)));
  let serving = 0;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const pub = pubs[serving];
    if (pub == null) throw new Error("access-auth churn stub: no key served");
    return Response.json({ keys: [{ ...pub, kid: `churn-${serving}`, alg: "RS256" }] });
  });
  const tokenFor = (i: number) => mint(pairs[i]!.privateKey, `churn-${i}`, validPayload());
  async function resolveKid(i: number): Promise<void> {
    serving = i;
    await expect(tokenFor(i).then((token) => verifyAccess(token, accessEnv))).resolves.toMatchObject({
      userId: EMAIL,
    });
  }
  for (let i = 0; i < 40; i += 1) await resolveKid(i);
  expect(fetchSpy).toHaveBeenCalledTimes(40);
  // Kid 0 was evicted by the 8 newer arrivals past the 32-key cap: resolving
  // it again refetches (41st fetch) and still verifies.
  await resolveKid(0);
  expect(fetchSpy).toHaveBeenCalledTimes(41);
  // Kids 0 and 39 are both live now; alternating between them serves purely
  // from cache — no further fetches.
  await resolveKid(39);
  await resolveKid(0);
  await resolveKid(39);
  expect(fetchSpy).toHaveBeenCalledTimes(41);
}, 30000);

it("fails fast with 503 when the cert endpoint hangs, errors, or is malformed", async () => {
  const { privateKey } = await keypair();
  const token = await mint(privateKey, "k-hang", validPayload());
  // Hung endpoint: never settles on its own; it rejects when the abort
  // signal fires, like a real fetch under AbortSignal.timeout. The 50ms
  // budget must therefore fail the check fast with 503.
  setAccessCertFetchTimeoutMs(50);
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        if (signal?.aborted) {
          reject(new DOMException("The operation timed out.", "TimeoutError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.aborted ? new DOMException("The operation timed out.", "TimeoutError") : new Error("down"));
        });
      }),
  );
  const started = Date.now();
  await expect(verifyAccess(token, accessEnv)).rejects.toMatchObject({
    status: 503,
    code: "ACCESS_CERTS_UNAVAILABLE",
  });
  expect(Date.now() - started).toBeLessThan(5000);
  // Network error, non-200, and malformed body all answer the same 503.
  vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("down")).mockRejectedValue(new Error("down"));
  await expect(verifyAccess(token, accessEnv)).rejects.toMatchObject({ status: 503 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 500 }));
  await expect(verifyAccess(token, accessEnv)).rejects.toMatchObject({ status: 503 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ keys: "garbage" }));
  await expect(verifyAccess(token, accessEnv)).rejects.toMatchObject({ status: 503 });
});

it("pins the default cert fetch budget at five seconds", () => {
  expect(ACCESS_CERT_FETCH_TIMEOUT_MS).toBe(5000);
});
