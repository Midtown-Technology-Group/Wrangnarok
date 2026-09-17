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
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { endpointIdempotencyKey, parseWebhookSecrets } from "../src/endpoints";
import { hash, helloSaga, parseCallerKey } from "../src/domain";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const OTHER_USER = "00000000-0000-4000-8000-000000000005";
const LAB = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };
const HOOK_SECRET = "hook-secret-for-tests-0001";

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`https://local.test${path}`, {
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
  return new Request(`https://local.test${extra?.path ?? `/hooks/${name}`}`, {
    method: "POST",
    headers,
    body: raw,
  });
}

function endpointRequest(name: string, payload: unknown, key: string | null, eventId: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers["X-Endpoint-Key"] = key;
  if (eventId !== null) headers["X-Endpoint-Event-Id"] = eventId;
  return new Request(`https://local.test/api/endpoints/${name}`, {
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

useWorkflowHarness(bindings.DB, {
  setup: () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("endpoint deliveries to hello must not fetch");
    });
  },
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
  const { inner: instance } = await trackWorkflowInstance(bindings.HELLO_WORKFLOW, id);
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
    new Request("https://local.test/api/endpoints/greet", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Key": raw, "X-Endpoint-Event-Id": "evt-014" },
      body: JSON.stringify({ input: { name: "x".repeat(5000) } }),
    }),
    bindings,
  );
  expect(big.status).toBe(413);
  expect(await big.json()).toMatchObject({ error: { code: "BODY_TOO_LARGE" } });

  const encoded = new Request("https://local.test/api/endpoints/greet", {
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
  // Track the rotated-key dispatch so the harness drains it before reset:
  // an untracked in-flight instance emits unhandled engine rejections.
  const freshBody = (await fresh.json()) as { executionId: string };
  await trackWorkflowInstance(bindings.HELLO_WORKFLOW, freshBody.executionId);
});

it("verifies webhook HMAC signatures and rejects invalid ones without an Execution", async () => {
  const { raw, id } = await seedEndpoint("webhook", "vendor");
  const withSecrets = { ...bindings, ENDPOINT_WEBHOOK_SECRETS: JSON.stringify({ [id]: raw }) };

  const payload = { input: { name: "Ada" } };
  const ok = await worker.fetch(await hookRequest("vendor", payload, raw, "wh-001"), withSecrets);
  expect(ok.status).toBe(202);
  const okBody = (await ok.json()) as { replayed?: boolean; executionId?: string };
  expect(okBody).toMatchObject({ replayed: false });
  // Track the webhook dispatch for the harness drain (see above).
  if (okBody.executionId) {
    await trackWorkflowInstance(bindings.HELLO_WORKFLOW, okBody.executionId);
  }

  const wrongSecret = await worker.fetch(await hookRequest("vendor", payload, "wrong-secret", "wh-002"), withSecrets);
  expect(wrongSecret.status).toBe(401);
  expect(await wrongSecret.json()).toMatchObject({ error: { code: "ENDPOINT_UNAUTHORIZED" } });

  const unsigned = await worker.fetch(await hookRequest("vendor", payload, null, "wh-003"), withSecrets);
  expect(unsigned.status).toBe(401);

  const malformed = await worker.fetch(
    new Request("https://local.test/hooks/vendor", {
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
    new Request("https://local.test/hooks/challenged?challenge=abc123", { method: "POST" }),
    bindings,
  );
  expect(challenge.status).toBe(200);
  expect(challenge.headers.get("Content-Type")).toContain("text/plain");
  expect(await challenge.text()).toBe("abc123");

  const badChallenge = await worker.fetch(
    new Request("https://local.test/hooks/challenged?other=1", { method: "POST" }),
    bindings,
  );
  expect(badChallenge.status).toBe(400);
  expect(await badChallenge.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });

  const badToken = await worker.fetch(
    new Request("https://local.test/hooks/challenged?challenge=", { method: "POST" }),
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
  // Track the throttled dispatch for the harness drain (see above).
  const firstBody = (await first.json()) as { executionId: string };
  await trackWorkflowInstance(bindings.HELLO_WORKFLOW, firstBody.executionId);
  const second = await worker.fetch(
    endpointRequest("throttled", { input: { name: "Ada" } }, apiKey, "rl-002"),
    bindings,
  );
  expect(second.status).toBe(429);
  expect(await second.json()).toMatchObject({ error: { code: "ENDPOINT_RATE_LIMITED" } });
});

/** Wrap the test D1 binding so the listed statement methods on statements
 * matching `match` reject asynchronously with `fault`, exactly like a
 * transient/query-specific D1 failure. Every other method (including the
 * counter UPSERT's `run`) still delegates to the real tables, so the fault
 * proves fail-closed behavior rather than a dead database. */
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

it("fails closed when the rate-window read faults: 500, never an invented zero count", async () => {
  const frozenNow = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(frozenNow);
  const created = await worker.fetch(
    authed("/api/endpoints", "POST", {
      name: "throttled-fault",
      sagaId: helloSaga.id,
      kind: "api-key",
      rateLimitPerMinute: 1,
    }),
    bindings,
  );
  expect(created.status).toBe(201);
  const { apiKey } = (await created.json()) as { apiKey: string };

  // Only the window SELECT faults; the counter UPSERT would still succeed,
  // so a fail-open read would admit this delivery under a zero count.
  const faulty = {
    ...bindings,
    DB: faultingDb(
      (sql) => sql.includes("endpoint_rate_windows") && sql.trimStart().startsWith("SELECT"),
      new Error("injected rate-window read fault"),
      ["first"],
    ),
  };
  const faulted = await worker.fetch(
    endpointRequest("throttled-fault", { input: { name: "Ada" } }, apiKey, "rl-fault-001"),
    faulty,
  );
  expect(faulted.status).toBe(500);
  expect(await faulted.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });

  // The faulted check admitted nothing and wrote nothing: a healthy retry
  // of the same vendor event still admits exactly once.
  const retry = await worker.fetch(
    endpointRequest("throttled-fault", { input: { name: "Ada" } }, apiKey, "rl-fault-001"),
    bindings,
  );
  expect(retry.status).toBe(202);
  const retryBody = (await retry.json()) as { executionId: string };
  await trackWorkflowInstance(bindings.HELLO_WORKFLOW, retryBody.executionId);
});

it("fails closed when the endpoint lookup faults: sanitized 5xx on both receivers, never 404", async () => {
  const { raw } = await seedEndpoint("api-key", "greet");
  const faulty = {
    ...bindings,
    DB: faultingDb((sql) => sql.includes('"endpoints"'), new Error("injected endpoints lookup fault"), [
      "all",
      "first",
    ]),
  };
  // A D1/query/schema fault is an infrastructure error, not a missing row:
  // vendors must see a retryable 5xx, never a permanent-looking 404.
  const api = await worker.fetch(endpointRequest("greet", { input: { name: "Ada" } }, raw, "evt-500"), faulty);
  expect(api.status).toBe(500);
  expect(await api.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });

  const hook = await worker.fetch(
    new Request("https://local.test/hooks/greet", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Event-Id": "evt-501" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    faulty,
  );
  expect(hook.status).toBe(500);
  expect(await hook.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
});

it("revokes webhook secrets on rotate: stale secrets fail, fresh secrets verify", async () => {
  const { raw, id } = await seedEndpoint("webhook", "vendor");
  const payload = { input: { name: "Ada" } };

  const before = await worker.fetch(await hookRequest("vendor", payload, raw, "wh-r1"), {
    ...bindings,
    ENDPOINT_WEBHOOK_SECRETS: JSON.stringify({ [id]: raw }),
  });
  expect(before.status).toBe(202);
  const beforeBody = (await before.json()) as { executionId?: string };
  if (beforeBody.executionId) {
    await trackWorkflowInstance(bindings.HELLO_WORKFLOW, beforeBody.executionId);
  }

  const rotated = await worker.fetch(authed("/api/endpoints/vendor/rotate", "POST", {}), bindings);
  expect(rotated.status).toBe(200);
  const { webhookSecret } = (await rotated.json()) as { webhookSecret: string };
  expect(webhookSecret).not.toBe(raw);

  // The old secret no longer verifies even though the binding still plants
  // it; the rotated secret verifies once planted.
  const stale = await worker.fetch(await hookRequest("vendor", payload, raw, "wh-r2"), {
    ...bindings,
    ENDPOINT_WEBHOOK_SECRETS: JSON.stringify({ [id]: raw }),
  });
  expect(stale.status).toBe(401);

  const fresh = await worker.fetch(await hookRequest("vendor", payload, webhookSecret, "wh-r3"), {
    ...bindings,
    ENDPOINT_WEBHOOK_SECRETS: JSON.stringify({ [id]: webhookSecret }),
  });
  expect(fresh.status).toBe(202);
  const freshBody = (await fresh.json()) as { executionId?: string };
  if (freshBody.executionId) {
    await trackWorkflowInstance(bindings.HELLO_WORKFLOW, freshBody.executionId);
  }
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
