// SPDX-License-Identifier: AGPL-3.0
// TRG-02 (issue #138, ADR 018): branch-coverage companion to
// test/endpoints.test.ts. Unit-level pins for every validation branch in
// src/endpoints.ts that the end-to-end suite does not force, plus route-level
// fallbacks in src/index.ts (bad names, bad bodies, unknown endpoints,
// cross-kind deliveries, disabled webhook candidates).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  authenticateEndpointKey,
  authenticateWebhook,
  checkEndpointRateLimit,
  createEndpoint,
  endpointIdempotencyKey,
  endpointSummary,
  executeEndpointDelivery,
  findChallengeEndpoint,
  listEndpointEvents,
  listEndpoints,
  loadEndpoint,
  loadEndpointsByName,
  mapEndpointPayload,
  parseEndpointName,
  parseVendorEventId,
  parseWebhookSecrets,
  readWebhookBody,
  resolveEndpointSagaId,
  rotateEndpointCredential,
  updateEndpoint,
  vendorChallenge,
  verifyEndpointKey,
  verifyWebhookSignature,
  type EndpointRow,
} from "../src/endpoints";
import { executionId, Fault, hash, helloSaga, parseHelloInput } from "../src/domain";
import { submit } from "../src/executions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0021_endpoints.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const LAB = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown, query = ""): Request {
  return new Request(`https://local.test${path}${query}`, {
    method,
    headers: { ...LAB },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Wrap the test D1 binding so the listed statement methods on statements
 * matching `match` reject asynchronously with `fault`, exactly like a
 * transient/query-specific D1 failure. Every other method (including the
 * counter UPSERT's `run`) still delegates to the real tables, so the fault
 * proves fail-closed behavior under a fault the missing-table case cannot
 * model. */
function faultingDb(match: (sql: string) => boolean, fault: Error, methods: readonly string[]): D1Database {
  const wrapStatement = (stmt: object): object =>
    new Proxy(stmt, {
      get(statementTarget, property) {
        if (typeof property === "string" && methods.includes(property)) {
          return () => Promise.reject(fault);
        }
        const value = (statementTarget as Record<string | symbol, unknown>)[property];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...args: unknown[]) => unknown).apply(statementTarget, args);
          return typeof out === "object" && out !== null ? wrapStatement(out) : out;
        };
      },
    });
  return new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          const stmt = (target.prepare as (sql: string, ...rest: unknown[]) => object)(sql, ...rest);
          return match(sql) ? wrapStatement(stmt) : stmt;
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function row(overrides: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: "endpoint-id-0001",
    org_id: ORG,
    name: "hook",
    saga_id: helloSaga.id,
    kind: "api-key",
    enabled: 1,
    key_hash: "a".repeat(64),
    key_expires_at: null,
    signature_secret_hash: null,
    challenge: "none",
    rate_limit_per_minute: null,
    created_at: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("endpoint branch tests must not fetch");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("pins name parsing, saga resolution, and the challenge handshake", () => {
  expect(parseEndpointName("ok-name")).toBe("ok-name");
  expect(() => parseEndpointName("BAD")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(resolveEndpointSagaId(row(), [{ id: helloSaga.id }])).toBe(helloSaga.id);
  expect(() => resolveEndpointSagaId(row({ saga_id: "not-a-uuid" }), [{ id: helloSaga.id }])).toThrow(
    expect.objectContaining({ code: "ENDPOINT_MISCONFIGURED" }),
  );
  expect(() => resolveEndpointSagaId(row({ saga_id: helloSaga.id }), [])).toThrow(
    expect.objectContaining({ code: "ENDPOINT_MISCONFIGURED" }),
  );
  const echo = row({ kind: "webhook", challenge: "echo-param" });
  expect(vendorChallenge(echo, new URL("http://x/?challenge=abc"))).toBe("abc");
  expect(vendorChallenge(echo, new URL("http://x/"))).toBeNull();
  expect(vendorChallenge(row(), new URL("http://x/?challenge=abc"))).toBeNull();
  expect(() => vendorChallenge(echo, new URL("http://x/?challenge="))).toThrow(
    expect.objectContaining({ code: "INVALID_CHALLENGE" }),
  );
  expect(() => vendorChallenge(echo, new URL(`http://x/?challenge=${"a".repeat(513)}`))).toThrow(
    expect.objectContaining({ code: "INVALID_CHALLENGE" }),
  );
  expect(() => vendorChallenge(echo, new URL("http://x/?challenge=bad!token"))).toThrow(
    expect.objectContaining({ code: "INVALID_CHALLENGE" }),
  );
  expect(findChallengeEndpoint([row(), echo])).toBe(echo);
  expect(findChallengeEndpoint([row()])).toBeNull();
  expect(findChallengeEndpoint([row({ kind: "webhook", challenge: "echo-param", enabled: 0 })])).toBeNull();
});

it("verifies api-key credentials across every failure branch", async () => {
  const live = row();
  const raw = "test-key-0001";
  const keyed = { ...live, key_hash: await hash(raw) };
  expect((await verifyEndpointKey(keyed, raw)).endpointId).toBe(keyed.id);
  await expect(verifyEndpointKey(row({ enabled: 0 }), raw)).rejects.toMatchObject({ code: "ENDPOINT_DISABLED" });
  await expect(verifyEndpointKey(row({ key_hash: null }), raw)).rejects.toMatchObject({ code: "ENDPOINT_DISABLED" });
  await expect(
    verifyEndpointKey(
      row({ key_hash: await hash(raw), key_expires_at: new Date(Date.now() - 1000).toISOString() }),
      raw,
    ),
  ).rejects.toMatchObject({ code: "ENDPOINT_KEY_EXPIRED" });
  // A future expiry still verifies.
  expect(
    (
      await verifyEndpointKey(
        row({ key_hash: await hash(raw), key_expires_at: new Date(Date.now() + 60000).toISOString() }),
        raw,
      )
    ).endpointName,
  ).toBe("hook");
  await expect(verifyEndpointKey(keyed, null)).rejects.toMatchObject({ code: "ENDPOINT_UNAUTHORIZED" });
  await expect(verifyEndpointKey(keyed, "")).rejects.toMatchObject({ code: "ENDPOINT_UNAUTHORIZED" });
  await expect(verifyEndpointKey(keyed, "x".repeat(257))).rejects.toMatchObject({ code: "ENDPOINT_UNAUTHORIZED" });
  await expect(verifyEndpointKey(keyed, "wrong")).rejects.toMatchObject({ code: "ENDPOINT_UNAUTHORIZED" });
  await expect(verifyEndpointKey(row({ key_hash: "short" }), raw)).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });

  // Cross-candidate authentication: first verifiable key wins; expired
  // surfaces before generic unauthorized; all-disabled answers 410.
  await expect(authenticateEndpointKey([], raw)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const mixed = await authenticateEndpointKey([row({ enabled: 0 }), keyed], raw);
  expect(mixed.endpoint.id).toBe(keyed.id);
  await expect(
    authenticateEndpointKey(
      [row({ key_hash: await hash(raw), key_expires_at: new Date(Date.now() - 1000).toISOString() })],
      raw,
    ),
  ).rejects.toMatchObject({ code: "ENDPOINT_KEY_EXPIRED" });
  await expect(authenticateEndpointKey([row({ enabled: 0 })], raw)).rejects.toMatchObject({
    code: "ENDPOINT_DISABLED",
  });
  await expect(authenticateEndpointKey([keyed], "wrong")).rejects.toMatchObject({ code: "ENDPOINT_UNAUTHORIZED" });
});

it("verifies webhook signatures across every failure branch", async () => {
  const secret = "webhook-secret-0001";
  const digest = await hash(secret);
  const live = row({ kind: "webhook", key_hash: null, signature_secret_hash: digest });
  const rawBody = new TextEncoder().encode(JSON.stringify({ input: { name: "Ada" } }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const sig = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody)));
  const secrets = new Map([[live.id, secret]]);
  expect((await verifyWebhookSignature(live, rawBody, `sha256=${sig}`, secrets)).endpointId).toBe(live.id);
  expect((await verifyWebhookSignature(live, rawBody, sig.toUpperCase(), secrets)).endpointId).toBe(live.id);
  await expect(verifyWebhookSignature(row({ kind: "webhook" }), rawBody, sig, secrets)).rejects.toMatchObject({
    code: "ENDPOINT_DISABLED",
  });
  await expect(verifyWebhookSignature(live, rawBody, null, secrets)).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });
  await expect(verifyWebhookSignature(live, rawBody, "", secrets)).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });
  await expect(verifyWebhookSignature(live, rawBody, "x".repeat(513), secrets)).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });
  await expect(verifyWebhookSignature(live, rawBody, sig, new Map())).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });
  await expect(verifyWebhookSignature(live, rawBody, sig, new Map([[live.id, "other-secret"]]))).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });
  await expect(verifyWebhookSignature(live, rawBody, "not-hex", secrets)).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });
  await expect(verifyWebhookSignature(live, rawBody, `sha256=${"0".repeat(64)}`, secrets)).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });

  // Cross-candidate authentication: empty answers 404, all-disabled 410.
  await expect(authenticateWebhook([], rawBody, sig, secrets)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(authenticateWebhook([row({ kind: "webhook" })], rawBody, sig, secrets)).rejects.toMatchObject({
    code: "ENDPOINT_DISABLED",
  });
  await expect(authenticateWebhook([live], rawBody, "bad", secrets)).rejects.toMatchObject({
    code: "ENDPOINT_UNAUTHORIZED",
  });
});

it("bounds webhook bodies, extracts event IDs, and maps payloads", async () => {
  await expect(readWebhookBody(null)).rejects.toMatchObject({ code: "INVALID_JSON" });
  await expect(readWebhookBody(new Response("{not json").body as ReadableStream<Uint8Array>)).rejects.toMatchObject({
    code: "INVALID_JSON",
  });
  await expect(
    readWebhookBody(
      new Response(JSON.stringify({ input: { name: "x".repeat(5000) } })).body as ReadableStream<Uint8Array>,
    ),
  ).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });

  const headers = (eventId: string | null): Headers => {
    const out = new Headers();
    if (eventId !== null) out.set("X-Endpoint-Event-Id", eventId);
    return out;
  };
  expect(parseVendorEventId(headers("evt-1"), {})).toBe("evt-1");
  expect(parseVendorEventId(new Headers(), { event_id: "evt-2" })).toBe("evt-2");
  expect(parseVendorEventId(new Headers(), { delivery_id: "evt-3" })).toBe("evt-3");
  expect(parseVendorEventId(new Headers(), { id: "evt-4" })).toBe("evt-4");
  const delivery = new Headers();
  delivery.set("X-Webhook-Delivery", "evt-5");
  expect(parseVendorEventId(delivery, {})).toBe("evt-5");
  expect(() => parseVendorEventId(new Headers(), {})).toThrow(
    expect.objectContaining({ code: "ENDPOINT_EVENT_ID_REQUIRED" }),
  );
  expect(() => parseVendorEventId(new Headers(), { event_id: "" })).toThrow(
    expect.objectContaining({ code: "ENDPOINT_EVENT_ID_REQUIRED" }),
  );
  expect(() => parseVendorEventId(new Headers(), { event_id: "x".repeat(129) })).toThrow(
    expect.objectContaining({ code: "ENDPOINT_EVENT_ID_REQUIRED" }),
  );
  expect(() => parseVendorEventId(new Headers(), { event_id: "bad id!" })).toThrow(
    expect.objectContaining({ code: "ENDPOINT_EVENT_ID_REQUIRED" }),
  );
  expect(() => parseVendorEventId(new Headers(), { event_id: 7 })).toThrow(
    expect.objectContaining({ code: "ENDPOINT_EVENT_ID_REQUIRED" }),
  );
  expect(() => parseVendorEventId(new Headers(), ["evt"])).toThrow(
    expect.objectContaining({ code: "ENDPOINT_EVENT_ID_REQUIRED" }),
  );

  expect(() => mapEndpointPayload({ id: helloSaga.id, parse: parseHelloInput } as never, null)).toThrow(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );
  expect(() => mapEndpointPayload({ id: helloSaga.id, parse: parseHelloInput } as never, ["x"])).toThrow(
    expect.objectContaining({ code: "INVALID_INPUT" }),
  );
  for (const field of ["orgId", "org_id", "organizationId", "userId", "user_id", "runAs"]) {
    expect(() => mapEndpointPayload({ id: helloSaga.id, parse: parseHelloInput } as never, { [field]: "x" })).toThrow(
      expect.objectContaining({ code: "ENDPOINT_IDENTITY_FORBIDDEN" }),
    );
  }
});

it("parses secret bindings and checks rate limits without a configured limit", async () => {
  expect(parseWebhookSecrets("[]").size).toBe(0);
  expect(parseWebhookSecrets(JSON.stringify([1, 2])).size).toBe(0);
  expect(parseWebhookSecrets(JSON.stringify({ id: 7 })).size).toBe(0);
  expect(parseWebhookSecrets(JSON.stringify({ id: "" })).size).toBe(0);
  // No limit configured: always passes, even without the rate table.
  await checkEndpointRateLimit(bindings.DB, row({ rate_limit_per_minute: null }));
  // A pre-migration database (no rate table) fails closed on the read miss:
  // a store error is not evidence that the bucket is empty, so the check
  // throws instead of admitting under an invented zero count.
  await bindings.DB.exec('DROP TABLE "endpoint_rate_windows"');
  const limited = row({ rate_limit_per_minute: 5 });
  await expect(checkEndpointRateLimit(bindings.DB, limited)).rejects.toThrow();
});

it("fails the rate-limit check closed when the window read faults while writes would succeed", async () => {
  await createEndpoint(
    bindings.DB,
    ORG,
    { name: "faulty-limit", sagaId: helloSaga.id, kind: "api-key", rateLimitPerMinute: 1 },
    [helloSaga.id],
  );
  const limited = (await loadEndpoint(bindings.DB, ORG, "faulty-limit")) as EndpointRow;
  await checkEndpointRateLimit(bindings.DB, limited);
  // Fault only the window SELECT's async result: the counter UPSERT still
  // delegates to the real table, so a fail-open read would admit an
  // over-limit endpoint here under an invented zero count.
  const readFault = faultingDb(
    (sql) => sql.includes("endpoint_rate_windows") && sql.trimStart().startsWith("SELECT"),
    new Error("injected rate-window read fault"),
    ["first"],
  );
  await expect(checkEndpointRateLimit(readFault, limited)).rejects.toThrow("injected rate-window read fault");
  // The faulted check wrote nothing: a healthy retry still sees the one hit.
  await expect(checkEndpointRateLimit(bindings.DB, limited)).rejects.toMatchObject({
    code: "ENDPOINT_RATE_LIMITED",
  });
});

it("validates endpoint creation, update, rotation, and event history inputs", async () => {
  const sagaIds = [helloSaga.id];
  await expect(
    createEndpoint(bindings.DB, ORG, { name: "BAD", sagaId: helloSaga.id, kind: "api-key" }, sagaIds),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  await expect(
    createEndpoint(bindings.DB, ORG, { name: "ok", sagaId: "not-a-uuid", kind: "api-key" }, sagaIds),
  ).rejects.toMatchObject({ code: "UNKNOWN_SAGA" });
  await expect(
    createEndpoint(bindings.DB, ORG, { name: "ok", sagaId: helloSaga.id, kind: "nope" as never }, sagaIds),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  await expect(
    createEndpoint(
      bindings.DB,
      ORG,
      { name: "ok", sagaId: helloSaga.id, kind: "webhook", challenge: "bad" as never },
      sagaIds,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  await expect(
    createEndpoint(
      bindings.DB,
      ORG,
      { name: "ok", sagaId: helloSaga.id, kind: "api-key", challenge: "echo-param" },
      sagaIds,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  await expect(
    createEndpoint(
      bindings.DB,
      ORG,
      { name: "ok", sagaId: helloSaga.id, kind: "api-key", rateLimitPerMinute: 0 },
      sagaIds,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  await expect(
    createEndpoint(
      bindings.DB,
      ORG,
      { name: "ok", sagaId: helloSaga.id, kind: "api-key", rateLimitPerMinute: 100001 },
      sagaIds,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  await expect(
    createEndpoint(
      bindings.DB,
      ORG,
      { name: "ok", sagaId: helloSaga.id, kind: "api-key", keyExpiresAt: "not-a-date" },
      sagaIds,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  await expect(
    createEndpoint(
      bindings.DB,
      ORG,
      { name: "ok", sagaId: helloSaga.id, kind: "webhook", keyExpiresAt: new Date().toISOString() },
      sagaIds,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });

  const { row: created } = await createEndpoint(
    bindings.DB,
    ORG,
    { name: "managed", sagaId: helloSaga.id, kind: "api-key" },
    sagaIds,
  );
  expect(endpointSummary(created).name).toBe("managed");
  expect((await listEndpoints(bindings.DB, ORG)).map((entry) => entry.name)).toContain("managed");
  expect(await loadEndpoint(bindings.DB, "00000000-0000-4000-8000-000000000099", "managed")).toBeNull();
  expect((await loadEndpointsByName(bindings.DB, "managed")).map((entry) => entry.id)).toContain(created.id);

  await expect(updateEndpoint(bindings.DB, ORG, "missing", { enabled: false })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(updateEndpoint(bindings.DB, ORG, "managed", { enabled: "yes" as never })).rejects.toMatchObject({
    code: "INVALID_ENDPOINT",
  });
  await expect(updateEndpoint(bindings.DB, ORG, "managed", { rateLimitPerMinute: -1 })).rejects.toMatchObject({
    code: "INVALID_ENDPOINT",
  });
  await expect(updateEndpoint(bindings.DB, ORG, "managed", { keyExpiresAt: "soon" })).rejects.toMatchObject({
    code: "INVALID_ENDPOINT",
  });
  const disabled = await updateEndpoint(bindings.DB, ORG, "managed", { enabled: false });
  expect(disabled.enabled).toBe(0);
  const reenabled = await updateEndpoint(bindings.DB, ORG, "managed", {
    enabled: true,
    rateLimitPerMinute: 10,
    keyExpiresAt: null,
  });
  expect(reenabled.enabled).toBe(1);
  expect(reenabled.rate_limit_per_minute).toBe(10);

  const { row: hooked } = await createEndpoint(
    bindings.DB,
    ORG,
    { name: "hooked", sagaId: helloSaga.id, kind: "webhook" },
    sagaIds,
  );
  await expect(
    updateEndpoint(bindings.DB, ORG, "hooked", { keyExpiresAt: new Date().toISOString() }),
  ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  const rotatedHook = await rotateEndpointCredential(bindings.DB, ORG, "hooked");
  expect(rotatedHook.row.kind).toBe("webhook");
  expect(typeof rotatedHook.rawCredential).toBe("string");
  void hooked;
  await expect(rotateEndpointCredential(bindings.DB, ORG, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });

  // Event history: missing endpoint 404s; a missing table degrades to empty.
  await expect(listEndpointEvents(bindings.DB, ORG, "missing", 50)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await listEndpointEvents(bindings.DB, ORG, "managed", 50)).toEqual([]);
  await bindings.DB.exec('DROP TABLE "endpoint_events"');
  expect(await listEndpointEvents(bindings.DB, ORG, "managed", 50)).toEqual([]);
});

it("propagates mismatched redelivery conflicts and submit Faults", async () => {
  const { row: created } = await createEndpoint(
    bindings.DB,
    ORG,
    { name: "conflict", sagaId: helloSaga.id, kind: "api-key" },
    [helloSaga.id],
  );
  const principal = {
    orgId: ORG,
    userId: `endpoint:${created.id}`,
    endpointId: created.id,
    endpointName: created.name,
  };
  const saga = {
    id: helloSaga.id,
    name: helloSaga.name,
    revision: helloSaga.revision,
    description: "x",
    parse: parseHelloInput,
  };
  const first = await executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, {
    saga,
    eventId: "evt-x",
    payload: { input: { name: "Ada" } },
  });
  expect(first.replayed).toBe(false);
  const replay = await executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, {
    saga,
    eventId: "evt-x",
    payload: { input: { name: "Ada" } },
  });
  expect(replay.eventReplayed).toBe(true);
  await expect(
    executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, {
      saga,
      eventId: "evt-x",
      payload: { input: { name: "Grace" } },
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  // Submit-level Faults (here: unknown Saga input) propagate untouched.
  await expect(
    executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, {
      saga,
      eventId: "evt-y",
      payload: { input: { name: "" } },
    }),
  ).rejects.toBeInstanceOf(Fault);
  // A pre-migration database without endpoint_events still delivers.
  await bindings.DB.exec('DROP TABLE "endpoint_events"');
  const degraded = await executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, {
    saga,
    eventId: "evt-z",
    payload: { input: { name: "Ada" } },
  });
  expect(degraded.replayed).toBe(false);
});

it("accepts Bearer api-key transport alongside X-Endpoint-Key", async () => {
  const created = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "bearer-key", sagaId: helloSaga.id, kind: "api-key" }),
    bindings,
  );
  expect(created.status).toBe(201);
  const { apiKey } = (await created.json()) as { apiKey: string };

  // Bearer transport (no X-Endpoint-Key) verifies the same credential.
  const viaBearer = await worker.fetch(
    new Request("https://local.test/api/endpoints/bearer-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Endpoint-Event-Id": "b-001",
      },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(viaBearer.status).toBe(202);

  // Non-Bearer Authorization values fall through to unauthorized, not a crash.
  const basic = await worker.fetch(
    new Request("https://local.test/api/endpoints/bearer-key", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic abc", "X-Endpoint-Event-Id": "b-002" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(basic.status).toBe(401);
});

it("answers route-level fallbacks: bad bodies, bad names, cross-kind, and unknown endpoints", async () => {
  const create = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "route-key", sagaId: helloSaga.id, kind: "api-key" }),
    bindings,
  );
  expect(create.status).toBe(201);
  const { apiKey } = (await create.json()) as { apiKey: string };

  const nonObject = await worker.fetch(authed("/api/endpoints", "POST", ["x"]), bindings);
  expect(nonObject.status).toBe(400);
  expect(await nonObject.json()).toMatchObject({ error: { code: "INVALID_ENDPOINT" } });

  const badName = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "BAD", sagaId: helloSaga.id, kind: "api-key" }),
    bindings,
  );
  expect(badName.status).toBe(404);

  const badList = await worker.fetch(authed("/api/endpoints/BAD/rotate", "POST", {}), bindings);
  expect(badList.status).toBe(404);

  const unknownGet = await worker.fetch(authed("/api/endpoints/missing", "GET"), bindings);
  expect(unknownGet.status).toBe(404);
  const unknownEvents = await worker.fetch(authed("/api/endpoints/missing/events", "GET"), bindings);
  expect(await unknownEvents.json()).toEqual({ events: [] });
  const unknownRotate = await worker.fetch(authed("/api/endpoints/missing/rotate", "POST", {}), bindings);
  expect(unknownRotate.status).toBe(404);
  const unknownPatchBody = await worker.fetch(authed("/api/endpoints/missing", "PATCH", {}), bindings);
  expect(unknownPatchBody.status).toBe(404);
  const patchNonObject = await worker.fetch(
    new Request("https://local.test/api/endpoints/route-key", {
      method: "PATCH",
      headers: { ...LAB },
      body: JSON.stringify(["x"]),
    }),
    bindings,
  );
  expect(patchNonObject.status).toBe(400);
  const patchQuery = await worker.fetch(authed("/api/endpoints/route-key", "PATCH", {}, "?x=1"), bindings);
  expect(patchQuery.status).toBe(400);
  const getQuery = await worker.fetch(authed("/api/endpoints/route-key", "GET", undefined, "?x=1"), bindings);
  expect(getQuery.status).toBe(400);
  const listQuery = await worker.fetch(authed("/api/endpoints", "GET", undefined, "?x=1"), bindings);
  expect(listQuery.status).toBe(400);
  const eventsQuery = await worker.fetch(authed("/api/endpoints/route-key/events", "GET", undefined, "?x=1"), bindings);
  expect(eventsQuery.status).toBe(400);
  const rotateQuery = await worker.fetch(authed("/api/endpoints/route-key/rotate", "POST", {}, "?x=1"), bindings);
  expect(rotateQuery.status).toBe(400);

  // Codex #352: rotate is a state change behind the JSON-write gate, so a
  // cross-origin form post (simple content type, no preflight) answers 415
  // JSON_REQUIRED and the credential digest is untouched.
  const formRotate = await worker.fetch(
    new Request("https://local.test/api/endpoints/route-key/rotate", {
      method: "POST",
      headers: { Authorization: LAB.Authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: "confirm=yes",
    }),
    bindings,
  );
  expect(formRotate.status).toBe(415);
  expect(await formRotate.json()).toMatchObject({ error: { code: "JSON_REQUIRED" } });

  // Cross-kind: api-key credential against a webhook-only name has no
  // api-key candidates, so it answers 404 (never a cross-kind leak).
  await worker.fetch(
    authed("/api/endpoints", "POST", { name: "route-hook", sagaId: helloSaga.id, kind: "webhook" }),
    bindings,
  );
  const crossKind = await worker.fetch(
    new Request("https://local.test/api/endpoints/route-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Key": apiKey, "X-Endpoint-Event-Id": "evt-cross" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(crossKind.status).toBe(404);
  // Cross-kind the other way: a hooks delivery against an api-key-only
  // name has no webhook candidates, so it answers 404.
  const crossHook = await worker.fetch(
    new Request("https://local.test/hooks/route-key", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Event-Id": "evt-cross" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(crossHook.status).toBe(404);
  // Unknown public names answer 404 on both receivers.
  const unknownApi = await worker.fetch(
    new Request("https://local.test/api/endpoints/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Key": apiKey, "X-Endpoint-Event-Id": "e1" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(unknownApi.status).toBe(404);
  const unknownHook = await worker.fetch(
    new Request("https://local.test/hooks/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Event-Id": "e1" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(unknownHook.status).toBe(404);
  // Disabled-only webhook candidates answer 410.
  const hookSecret = (await (
    await worker.fetch(
      authed("/api/endpoints", "POST", { name: "route-off", sagaId: helloSaga.id, kind: "webhook" }),
      bindings,
    )
  ).json()) as {
    endpoint: { id: string };
    webhookSecret: string;
  };
  await worker.fetch(authed("/api/endpoints/route-off", "PATCH", { enabled: false }), bindings);
  const withSecrets = {
    ...bindings,
    ENDPOINT_WEBHOOK_SECRETS: JSON.stringify({ [hookSecret.endpoint.id]: hookSecret.webhookSecret }),
  };
  const offKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hookSecret.webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const offRaw = JSON.stringify({ input: { name: "Ada" } });
  const offSig = Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", offKey, new TextEncoder().encode(offRaw))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const off = await worker.fetch(
    new Request("https://local.test/hooks/route-off", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `sha256=${offSig}`,
        "X-Endpoint-Event-Id": "e1",
      },
      body: offRaw,
    }),
    withSecrets,
  );
  expect(off.status).toBe(410);
});

const B64ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard-alphabet padded base64 (what a vendor would send). */
function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? (bytes[i + 1] ?? 0) : 0;
    const b2 = has2 ? (bytes[i + 2] ?? 0) : 0;
    out += B64ABC.charAt(b0 >> 2) + B64ABC.charAt(((b0 & 3) << 4) | (b1 >> 4));
    out += has1 ? B64ABC.charAt(((b1 & 15) << 2) | (b2 >> 6)) : "=";
    out += has2 ? B64ABC.charAt(b2 & 63) : "=";
  }
  return out;
}

it("accepts canonical base64 HMAC signatures and rejects ambiguous encodings", async () => {
  const secret = "webhook-secret-0002";
  const live = row({
    id: "endpoint-id-0002",
    kind: "webhook",
    key_hash: null,
    signature_secret_hash: await hash(secret),
  });
  const rawBody = new TextEncoder().encode(JSON.stringify({ input: { name: "Ada" } }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const computed = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const canonical = toBase64(computed);
  expect(canonical).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  const secrets = new Map([[live.id, secret]]);

  // Canonical padded base64 verifies bare, prefixed, and in the HaloPSA
  // spaced-prefix form (surrounding whitespace plus whitespace after the
  // prefix are tolerated).
  for (const signature of [canonical, `sha256=${canonical}`, `  sha256= ${canonical}  `]) {
    expect((await verifyWebhookSignature(live, rawBody, signature, secrets)).endpointId).toBe(live.id);
  }

  // Ambiguous alternate encodings stay rejected: base64url alphabet,
  // unpadded base64, base64-of-hex, and whitespace inside the digest.
  const base64url = canonical.replaceAll("+", "-").replaceAll("/", "_");
  const hexOfDigest = Array.from(computed, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const base64OfHex = toBase64(new TextEncoder().encode(hexOfDigest));
  const tampered = `${canonical[0] === "A" ? "B" : "A"}${canonical.slice(1)}`;
  for (const signature of [
    base64url,
    canonical.replace(/=+$/, ""),
    base64OfHex,
    `${canonical.slice(0, 20)} ${canonical.slice(20)}`,
    tampered,
  ]) {
    await expect(verifyWebhookSignature(live, rawBody, signature, secrets)).rejects.toMatchObject({
      code: "ENDPOINT_UNAUTHORIZED",
    });
  }
});

it("correlates concurrent redeliveries to the exact event created by the request", async () => {
  const { row: created } = await createEndpoint(
    bindings.DB,
    ORG,
    { name: "conc", sagaId: helloSaga.id, kind: "api-key" },
    [helloSaga.id],
  );
  const principal = {
    orgId: ORG,
    userId: `endpoint:${created.id}`,
    endpointId: created.id,
    endpointName: created.name,
  };
  const saga = {
    id: helloSaga.id,
    name: helloSaga.name,
    revision: helloSaga.revision,
    description: "concurrency",
    parse: parseHelloInput,
  };
  const delivery = {
    saga,
    eventId: "evt-conc",
    payload: { input: { name: "Ada" } },
  };
  // Simultaneous arrivals of the same vendor event converge on one
  // Execution: the immutable (endpoint, event) identity travels with each
  // request, never recovered through a latest-for-source lookup.
  const [first, second] = await Promise.all([
    executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, delivery),
    executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, delivery),
  ]);
  expect(first.executionId).toBe(second.executionId);
  const events = await listEndpointEvents(bindings.DB, ORG, "conc", 50);
  expect(events.filter((entry) => entry.eventId === "evt-conc")).toHaveLength(1);
  // Distinct vendor events derive distinct delivery keys.
  const same = await endpointIdempotencyKey(created.id, "evt-conc");
  expect(same).toMatch(/^wep-[a-f0-9]{64}$/);
  expect(await endpointIdempotencyKey(created.id, "evt-other")).not.toBe(same);
});

it("keeps the execution row durable across an unconfirmed dispatch, with no phantom event", async () => {
  const { row: created } = await createEndpoint(
    bindings.DB,
    ORG,
    { name: "ord", sagaId: helloSaga.id, kind: "api-key" },
    [helloSaga.id],
  );
  const principal = {
    orgId: ORG,
    userId: `endpoint:${created.id}`,
    endpointId: created.id,
    endpointName: created.name,
  };
  const saga = {
    id: helloSaga.id,
    name: helloSaga.name,
    revision: helloSaga.revision,
    description: "ordering",
    parse: parseHelloInput,
  };
  const delivery = { saga, eventId: "evt-ord", payload: { input: { name: "Ada" } } };
  // The Workflow dispatch fails after the Execution row write: the delivery
  // answers 503 and the caller must redeliver the same vendor event.
  const dispatchFault = {
    ...bindings,
    HELLO_WORKFLOW: {
      createBatch: async (): Promise<never> => {
        throw new Error("injected dispatch fault");
      },
    },
  } as unknown as Bindings;
  await expect(
    executeEndpointDelivery(bindings.DB, submit, dispatchFault, principal, created, delivery),
  ).rejects.toMatchObject({ code: "DISPATCH_UNCONFIRMED", status: 503 });

  // Durable authoritative state stayed visible: the Execution row persists
  // undispatched, and no event row claims a delivery that never confirmed.
  const key = await endpointIdempotencyKey(created.id, "evt-ord");
  const id = await executionId(principal, key);
  const kept = await bindings.DB.prepare('SELECT dispatched FROM "executions" WHERE id=?')
    .bind(id)
    .first<{ dispatched: number }>();
  expect(kept?.dispatched).toBe(0);
  expect(await listEndpointEvents(bindings.DB, ORG, "ord", 50)).toEqual([]);

  // Caller redelivery of the same event converges on the durable row and
  // records the event exactly once. No business mutation ran twice and no
  // automatic retry invented a second Execution.
  const recovered = await executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, delivery);
  expect(recovered.executionId).toBe(id);
  expect(recovered.replayed).toBe(true);
  expect((await listEndpointEvents(bindings.DB, ORG, "ord", 50)).map((entry) => entry.eventId)).toEqual(["evt-ord"]);

  // Submit-level failures likewise record nothing: an invalid payload leaves
  // no event row behind for the caller to mistake for a delivery.
  await expect(
    executeEndpointDelivery(bindings.DB, submit, bindings, principal, created, {
      saga,
      eventId: "evt-bad",
      payload: { input: { name: "" } },
    }),
  ).rejects.toBeInstanceOf(Fault);
  expect((await listEndpointEvents(bindings.DB, ORG, "ord", 50)).map((entry) => entry.eventId)).toEqual(["evt-ord"]);
});
