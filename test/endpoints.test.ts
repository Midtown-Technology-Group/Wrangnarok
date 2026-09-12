// SPDX-License-Identifier: AGPL-3.0
// TRG-02 (issue #138, ADR 018): authenticated webhook and custom HTTP
// execution endpoints, end to end on the real local runtime (workerd D1 +
// local Workflow bindings; hello Saga needs no vendor fetch).
//
// Covers the acceptance: valid/invalid signatures, expired/revoked keys,
// replay and mismatched duplicates, vendor challenge, rate limit, oversized
// body, authorization revocation (disable/rotate), identity smuggling
// rejection, wep- namespace reservation, and 202-vs-receipt separation.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { endpointIdempotencyKey, parseWebhookSecrets } from "../src/endpoints";
import { hash, helloSaga, parseCallerKey } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0021_endpoints.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const OTHER_USER = "00000000-0000-4000-8000-000000000005";
const LAB = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };
const HOOK_SECRET = "hook-secret-for-tests-0001";

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`http://local.test${path}`, {
    method,
    headers: { ...LAB },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function sign(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return `sha256=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function hookRequest(
  name: string,
  payload: unknown,
  secret: string | null,
  eventId: string | null,
  extra?: { path?: string; raw?: string },
): Promise<Request> {
  const raw = extra?.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Webhook-Signature"] = await sign(secret, raw);
  if (eventId !== null) headers["X-Endpoint-Event-Id"] = eventId;
  return new Request(`http://local.test${extra?.path ?? `/hooks/${name}`}`, {
    method: "POST",
    headers,
    body: raw,
  });
}

function endpointRequest(name: string, payload: unknown, key: string | null, eventId: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers["X-Endpoint-Key"] = key;
  if (eventId !== null) headers["X-Endpoint-Event-Id"] = eventId;
  return new Request(`http://local.test/api/endpoints/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function seedEndpoint(kind: "api-key" | "webhook", name: string): Promise<{ raw: string; id: string }> {
  const create = await worker.fetch(authed("/api/endpoints", "POST", { name, sagaId: helloSaga.id, kind }), bindings);
  expect(create.status).toBe(201);
  const body = (await create.json()) as { endpoint: { id: string }; apiKey?: string; webhookSecret?: string };
  return { raw: (body.apiKey ?? body.webhookSecret) as string, id: body.endpoint.id };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("endpoint deliveries to hello must not fetch");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("creates, lists, reads, updates, rotates, and isolates endpoints per Organization", async () => {
  const created = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "greet", sagaId: helloSaga.id, kind: "api-key" }),
    bindings,
  );
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { endpoint: { name: string; sagaId: string }; apiKey: string };
  expect(createdBody.endpoint.name).toBe("greet");
  expect(createdBody.endpoint.sagaId).toBe(helloSaga.id);
  expect(typeof createdBody.apiKey).toBe("string");

  const listed = await worker.fetch(authed("/api/endpoints", "GET"), bindings);
  expect(await listed.json()).toMatchObject({ endpoints: [{ name: "greet", kind: "api-key", enabled: true }] });

  const duplicate = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "greet", sagaId: helloSaga.id, kind: "api-key" }),
    bindings,
  );
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: "ENDPOINT_EXISTS" } });

  const patched = await worker.fetch(authed("/api/endpoints/greet", "PATCH", { rateLimitPerMinute: 60 }), bindings);
  expect(await patched.json()).toMatchObject({ endpoint: { rateLimitPerMinute: 60 } });

  const rotated = await worker.fetch(authed("/api/endpoints/greet/rotate", "POST", {}), bindings);
  const rotatedBody = (await rotated.json()) as { apiKey: string };
  expect(rotatedBody.apiKey).not.toBe(createdBody.apiKey);

  // Cross-Organization isolation: a stranger (known user, no membership)
  // cannot reach the inventory or the endpoint — the membership gate
  // answers 404 before any endpoint row is touched.
  const strangerBindings = { ...bindings, LAB_USER_ID: OTHER_USER, LAB_FIXTURE_USER_ID: LAB_USER };
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  const foreignList = await worker.fetch(authed("/api/endpoints", "GET"), strangerBindings);
  expect(foreignList.status).toBe(404);
  const foreignRead = await worker.fetch(authed("/api/endpoints/greet", "GET"), strangerBindings);
  expect(foreignRead.status).toBe(404);
  expect(await worker.fetch(authed("/api/endpoints/BAD_NAME", "GET"), bindings).then((res) => res.status)).toBe(404);

  const unknownSaga = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "lost", sagaId: "395e15f0-3627-41f6-8922-008ce37e3000", kind: "api-key" }),
    bindings,
  );
  expect(unknownSaga.status).toBe(400);
  expect(await unknownSaga.json()).toMatchObject({ error: { code: "UNKNOWN_SAGA" } });
});

it("delivers an api-key endpoint end to end: 202 receipt, redelivery replays, mismatch conflicts", async () => {
  const { raw } = await seedEndpoint("api-key", "greet");
  const payload = { input: { name: "Ada" } };

  const first = await worker.fetch(endpointRequest("greet", payload, raw, "evt-001"), bindings);
  expect(first.status).toBe(202);
  const firstBody = (await first.json()) as { executionId: string; replayed: boolean; statusUrl: string };
  expect(firstBody.replayed).toBe(false);
  expect(first.headers.get("Location")).toBe(firstBody.statusUrl);
  expect(first.headers.get("X-Endpoint-Replayed")).toBeNull();

  // The synchronous HTTP response is a receipt, never inline results.
  expect("result" in firstBody).toBe(false);
  const expectedKey = await endpointIdempotencyKey(
    (
      (await bindings.DB.prepare("SELECT id FROM endpoints WHERE name=?").bind("greet").first<{ id: string }>()) as {
        id: string;
      }
    ).id,
    "evt-001",
  );
  expect(expectedKey.startsWith("wep-")).toBe(true);

  const replay = await worker.fetch(endpointRequest("greet", payload, raw, "evt-001"), bindings);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    executionId: firstBody.executionId,
    replayed: true,
    eventReplayed: true,
  });
  expect(replay.headers.get("X-Endpoint-Replayed")).toBe("true");

  const mismatch = await worker.fetch(endpointRequest("greet", { input: { name: "Grace" } }, raw, "evt-001"), bindings);
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });

  // The Execution itself ran the bound hello Saga under the endpoint
  // principal, so the operator session cannot see it (404, never a leak).
  const id = firstBody.executionId;
  await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(authed(`/api/executions/${id}`, "GET"), bindings);
  expect(detail.status).toBe(404);

  const events = await worker.fetch(authed("/api/endpoints/greet/events", "GET"), bindings);
  expect(await events.json()).toMatchObject({ events: [{ eventId: "evt-001", executionId: id }] });
});

it("rejects bad keys, missing events, identity smuggling, and oversized bodies on api-key routes", async () => {
  const { raw } = await seedEndpoint("api-key", "greet");

  const wrong = await worker.fetch(
    endpointRequest("greet", { input: { name: "Ada" } }, "wrong-key", "evt-010"),
    bindings,
  );
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toMatchObject({ error: { code: "ENDPOINT_UNAUTHORIZED" } });

  const missing = await worker.fetch(endpointRequest("greet", { input: { name: "Ada" } }, null, "evt-011"), bindings);
  expect(missing.status).toBe(401);

  const unknown = await worker.fetch(
    endpointRequest("no-such-hook", { input: { name: "Ada" } }, raw, "evt-012"),
    bindings,
  );
  expect(unknown.status).toBe(404);

  const noEvent = await worker.fetch(endpointRequest("greet", { input: { name: "Ada" } }, raw, null), bindings);
  expect(noEvent.status).toBe(400);
  expect(await noEvent.json()).toMatchObject({ error: { code: "ENDPOINT_EVENT_ID_REQUIRED" } });

  const smuggled = await worker.fetch(
    endpointRequest("greet", { input: { name: "Ada" }, orgId: OTHER_ORG }, raw, "evt-013"),
    bindings,
  );
  expect(smuggled.status).toBe(400);
  expect(await smuggled.json()).toMatchObject({ error: { code: "ENDPOINT_IDENTITY_FORBIDDEN" } });

  const big = await worker.fetch(
    new Request("http://local.test/api/endpoints/greet", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Key": raw, "X-Endpoint-Event-Id": "evt-014" },
      body: JSON.stringify({ input: { name: "x".repeat(5000) } }),
    }),
    bindings,
  );
  expect(big.status).toBe(413);
  expect(await big.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });

  const encoded = new Request("http://local.test/api/endpoints/greet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "X-Endpoint-Key": raw,
      "X-Endpoint-Event-Id": "evt-015",
    },
    body: JSON.stringify({ input: { name: "Ada" } }),
  });
  expect((await worker.fetch(encoded, bindings)).status).toBe(415);
});

it("enforces expiry, disable revocation, and rotation on api-key endpoints", async () => {
  const { raw } = await seedEndpoint("api-key", "greet");

  const expiring = await worker.fetch(
    authed("/api/endpoints/greet", "PATCH", { keyExpiresAt: new Date(Date.now() - 1000).toISOString() }),
    bindings,
  );
  expect(expiring.status).toBe(200);
  const expired = await worker.fetch(endpointRequest("greet", { input: { name: "Ada" } }, raw, "evt-020"), bindings);
  expect(expired.status).toBe(401);
  expect(await expired.json()).toMatchObject({ error: { code: "ENDPOINT_KEY_EXPIRED" } });

  await worker.fetch(authed("/api/endpoints/greet", "PATCH", { keyExpiresAt: null, enabled: false }), bindings);
  const disabled = await worker.fetch(endpointRequest("greet", { input: { name: "Ada" } }, raw, "evt-021"), bindings);
  expect(disabled.status).toBe(410);
  expect(await disabled.json()).toMatchObject({ error: { code: "ENDPOINT_DISABLED" } });

  await worker.fetch(authed("/api/endpoints/greet", "PATCH", { enabled: true }), bindings);
  const rotated = (await (await worker.fetch(authed("/api/endpoints/greet/rotate", "POST", {}), bindings)).json()) as {
    apiKey: string;
  };
  const stale = await worker.fetch(endpointRequest("greet", { input: { name: "Ada" } }, raw, "evt-022"), bindings);
  expect(stale.status).toBe(401);
  const fresh = await worker.fetch(
    endpointRequest("greet", { input: { name: "Ada" } }, rotated.apiKey, "evt-022"),
    bindings,
  );
  expect(fresh.status).toBe(202);
});

it("verifies webhook HMAC signatures and rejects invalid ones without an Execution", async () => {
  const { raw, id } = await seedEndpoint("webhook", "vendor");
  const withSecrets = { ...bindings, ENDPOINT_WEBHOOK_SECRETS: JSON.stringify({ [id]: raw }) };

  const payload = { input: { name: "Ada" } };
  const ok = await worker.fetch(await hookRequest("vendor", payload, raw, "wh-001"), withSecrets);
  expect(ok.status).toBe(202);
  expect(await ok.json()).toMatchObject({ replayed: false });

  const wrongSecret = await worker.fetch(await hookRequest("vendor", payload, "wrong-secret", "wh-002"), withSecrets);
  expect(wrongSecret.status).toBe(401);
  expect(await wrongSecret.json()).toMatchObject({ error: { code: "ENDPOINT_UNAUTHORIZED" } });

  const unsigned = await worker.fetch(await hookRequest("vendor", payload, null, "wh-003"), withSecrets);
  expect(unsigned.status).toBe(401);

  const malformed = await worker.fetch(
    new Request("http://local.test/hooks/vendor", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": "not-hex",
        "X-Endpoint-Event-Id": "wh-004",
      },
      body: JSON.stringify(payload),
    }),
    withSecrets,
  );
  expect(malformed.status).toBe(401);

  const noBinding = await worker.fetch(await hookRequest("vendor", payload, raw, "wh-005"), bindings);
  expect(noBinding.status).toBe(401);

  const unknown = await worker.fetch(await hookRequest("no-such-hook", payload, raw, "wh-006"), withSecrets);
  expect(unknown.status).toBe(404);
});

it("answers vendor challenges with plaintext and no Execution", async () => {
  await seedEndpoint("webhook", "vendor");
  await worker.fetch(
    authed("/api/endpoints", "POST", {
      name: "challenged",
      sagaId: helloSaga.id,
      kind: "webhook",
      challenge: "echo-param",
    }),
    bindings,
  );

  const challenge = await worker.fetch(
    new Request("http://local.test/hooks/challenged?challenge=abc123", { method: "POST" }),
    bindings,
  );
  expect(challenge.status).toBe(200);
  expect(challenge.headers.get("Content-Type")).toContain("text/plain");
  expect(await challenge.text()).toBe("abc123");

  const badChallenge = await worker.fetch(
    new Request("http://local.test/hooks/challenged?other=1", { method: "POST" }),
    bindings,
  );
  expect(badChallenge.status).toBe(400);
  expect(await badChallenge.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });

  const badToken = await worker.fetch(
    new Request("http://local.test/hooks/challenged?challenge=", { method: "POST" }),
    bindings,
  );
  expect(badToken.status).toBe(400);
  expect(await badToken.json()).toMatchObject({ error: { code: "INVALID_CHALLENGE" } });
});

it("rate-limits a second delivery in the same minute window with 429", async () => {
  // Freeze wall-clock so both deliveries land in the same minute bucket:
  // without this the pair can straddle a real minute boundary and the
  // second delivery would legitimately pass (202) in a fresh window.
  // Restored by the suite afterEach (vi.restoreAllMocks).
  const frozenNow = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(frozenNow);
  const created = await worker.fetch(
    authed("/api/endpoints", "POST", {
      name: "throttled",
      sagaId: helloSaga.id,
      kind: "api-key",
      rateLimitPerMinute: 1,
    }),
    bindings,
  );
  expect(created.status).toBe(201);
  const { apiKey } = (await created.json()) as { apiKey: string };

  const first = await worker.fetch(
    endpointRequest("throttled", { input: { name: "Ada" } }, apiKey, "rl-001"),
    bindings,
  );
  expect(first.status).toBe(202);
  const second = await worker.fetch(
    endpointRequest("throttled", { input: { name: "Ada" } }, apiKey, "rl-002"),
    bindings,
  );
  expect(second.status).toBe(429);
  expect(await second.json()).toMatchObject({ error: { code: "ENDPOINT_RATE_LIMITED" } });
});

it("reserves the wep- namespace for endpoint keys and keeps unit helpers pure", async () => {
  expect(() => parseCallerKey("wep-abc1234567890123")).toThrow(/reserved/);
  expect(parseCallerKey("caller-key-00000001")).toBe("caller-key-00000001");
  expect(parseWebhookSecrets(undefined).size).toBe(0);
  expect(parseWebhookSecrets("not json").size).toBe(0);
  expect(parseWebhookSecrets(JSON.stringify({ id: HOOK_SECRET })).get("id")).toBe(HOOK_SECRET);
  const derived = await endpointIdempotencyKey("endpoint-id", "event-id");
  expect(derived).toMatch(/^wep-[a-f0-9]{64}$/);
  expect(await hash("abc")).toHaveLength(64);
});
