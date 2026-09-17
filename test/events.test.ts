// SPDX-License-Identifier: AGPL-3.0
// TRG-03 S1 (issue #139): event-source registry plus durable org-scoped
// event log, end to end on the real local runtime (workerd D1 + local
// Workflow bindings; hello Saga needs no vendor fetch).
//
// Covers the S1 acceptance: source CRUD with exact-org isolation, typed
// topic/event validation, deterministic emit with same-content replay and
// mismatched-content conflict, disable fencing, delete cascading to log
// rows, bounded newest-first history, and best-effort delivery appends from
// endpoint delivery and schedule promotion. Subscriptions, fan-out, and
// operator replay are deferred and untested here by design.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000005";
const LAB = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...LAB },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createSource(
  name: string,
  kind: string,
  extra?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await worker.fetch(authed("/api/event-sources", "POST", { name, kind, ...extra }), bindings);
  return { status: res.status, body: (await res.json()) as unknown };
}

useWorkflowHarness(bindings.DB, {
  setup: () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("event tests must not fetch");
    });
  },
});

it("registers, lists, reads, disables, and deletes sources with exact-org isolation", async () => {
  const created = await createSource("orders", "topic");
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    source: { name: "orders", kind: "topic", refId: null, enabled: true },
  });

  const listed = await worker.fetch(authed("/api/event-sources", "GET"), bindings);
  expect(await listed.json()).toMatchObject({ sources: [{ name: "orders", kind: "topic", enabled: true }] });

  const detail = await worker.fetch(authed("/api/event-sources/orders", "GET"), bindings);
  expect(detail.status).toBe(200);

  const duplicate = await createSource("orders", "topic");
  expect(duplicate.status).toBe(409);
  expect(duplicate.body).toMatchObject({ error: { code: "EVENT_SOURCE_EXISTS" } });

  const badKind = await createSource("bad-kind", "queue");
  expect(badKind.status).toBe(400);
  expect(badKind.body).toMatchObject({ error: { code: "INVALID_EVENT_SOURCE" } });

  const badRef = await createSource("bad-ref", "webhook", { refId: "not-a-uuid" });
  expect(badRef.status).toBe(400);
  expect(badRef.body).toMatchObject({ error: { code: "INVALID_EVENT_SOURCE" } });

  // Unknown name shapes answer 404, never a leak or UNIMPLEMENTED theater.
  expect(await worker.fetch(authed("/api/event-sources/BAD_NAME", "GET"), bindings).then((res) => res.status)).toBe(
    404,
  );
  expect(await worker.fetch(authed("/api/event-sources/missing", "GET"), bindings).then((res) => res.status)).toBe(404);

  // Cross-Organization isolation: a stranger (known user, no membership)
  // cannot reach the inventory or the source — the membership gate answers
  // 404 before any event row is touched.
  const strangerBindings = { ...bindings, LAB_USER_ID: OTHER_USER, LAB_FIXTURE_USER_ID: LAB_USER };
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  expect(await worker.fetch(authed("/api/event-sources", "GET"), strangerBindings).then((res) => res.status)).toBe(404);
  expect(
    await worker.fetch(authed("/api/event-sources/orders", "GET"), strangerBindings).then((res) => res.status),
  ).toBe(404);

  const disabled = await worker.fetch(authed("/api/event-sources/orders/disable", "POST", {}), bindings);
  expect(await disabled.json()).toMatchObject({ source: { name: "orders", enabled: false } });
  const enabled = await worker.fetch(authed("/api/event-sources/orders/enable", "POST", {}), bindings);
  expect(await enabled.json()).toMatchObject({ source: { name: "orders", enabled: true } });

  const deleted = await worker.fetch(authed("/api/event-sources/orders", "DELETE"), bindings);
  expect(await deleted.json()).toEqual({ deleted: true });
  expect(await worker.fetch(authed("/api/event-sources/orders", "GET"), bindings).then((res) => res.status)).toBe(404);
});

it("emits with deterministic identity: same content replays, mismatched content conflicts", async () => {
  expect((await createSource("ledger", "topic")).status).toBe(201);

  const first = await worker.fetch(
    authed("/api/event-sources/ledger/events", "POST", {
      eventId: "evt-001",
      topic: "vendor.order.created",
      payload: { order: 7 },
    }),
    bindings,
  );
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({
    event: { eventId: "evt-001", topic: "vendor.order.created", executionId: null },
    replayed: false,
  });

  const replay = await worker.fetch(
    authed("/api/event-sources/ledger/events", "POST", {
      eventId: "evt-001",
      topic: "vendor.order.created",
      payload: { order: 7 },
    }),
    bindings,
  );
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true });

  const mismatch = await worker.fetch(
    authed("/api/event-sources/ledger/events", "POST", {
      eventId: "evt-001",
      topic: "vendor.order.created",
      payload: { order: 8 },
    }),
    bindings,
  );
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: { code: "EVENT_CONFLICT" } });

  // Topics are dot-namespaced: bare single-segment topics are rejected.
  const bare = await worker.fetch(
    authed("/api/event-sources/ledger/events", "POST", { eventId: "evt-002", topic: "orders", payload: {} }),
    bindings,
  );
  expect(bare.status).toBe(400);
  expect(await bare.json()).toMatchObject({ error: { code: "INVALID_EVENT" } });

  const noId = await worker.fetch(
    authed("/api/event-sources/ledger/events", "POST", { topic: "vendor.order.created", payload: {} }),
    bindings,
  );
  expect(noId.status).toBe(400);

  // Oversized payloads never reach the log: the shared 4096-byte body gate
  // answers 413 first.
  const big = await worker.fetch(
    authed("/api/event-sources/ledger/events", "POST", {
      eventId: "evt-big",
      topic: "vendor.order.created",
      payload: { blob: "x".repeat(5000) },
    }),
    bindings,
  );
  expect(big.status).toBe(413);

  // Emits to unknown or foreign sources answer 404, never a leak.
  expect(
    await worker
      .fetch(authed("/api/event-sources/ghost/events", "POST", { eventId: "e", topic: "a.b", payload: {} }), bindings)
      .then((res) => res.status),
  ).toBe(404);

  // A disabled source fences future emits while history survives.
  await worker.fetch(authed("/api/event-sources/ledger/disable", "POST", {}), bindings);
  const fenced = await worker.fetch(
    authed("/api/event-sources/ledger/events", "POST", { eventId: "evt-003", topic: "a.b", payload: {} }),
    bindings,
  );
  expect(fenced.status).toBe(410);
  expect(await fenced.json()).toMatchObject({ error: { code: "EVENT_SOURCE_DISABLED" } });
  const history = (await (await worker.fetch(authed("/api/event-sources/ledger/events", "GET"), bindings)).json()) as {
    events: { eventId: string }[];
  };
  expect(history.events.map((entry) => entry.eventId)).toEqual(["evt-001"]);

  // Deleting cascades to the log rows.
  await worker.fetch(authed("/api/event-sources/ledger", "DELETE"), bindings);
  const relisted = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
  expect(relisted?.n).toBe(0);
});

it("lists newest-first bounded history per source", async () => {
  expect((await createSource("feed", "topic")).status).toBe(201);
  for (const id of ["a-1", "a-2", "a-3"]) {
    const res = await worker.fetch(
      authed("/api/event-sources/feed/events", "POST", { eventId: id, topic: "test.feed", payload: { id } }),
      bindings,
    );
    expect(res.status).toBe(201);
  }
  const history = (await (await worker.fetch(authed("/api/event-sources/feed/events", "GET"), bindings)).json()) as {
    events: { eventId: string; topic: string }[];
  };
  expect(history.events.map((entry) => entry.eventId)).toEqual(["a-3", "a-2", "a-1"]);
  expect(history.events[0]).toMatchObject({ topic: "test.feed" });
});

it("appends endpoint deliveries to an observing source and skips disabled ones", async () => {
  const created = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "order-hook", sagaId: helloSaga.id, kind: "api-key" }),
    bindings,
  );
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { endpoint: { id: string }; apiKey: string };
  const endpoint = createdBody.endpoint;
  const apiKey = createdBody.apiKey;

  const source = await createSource("order-events", "webhook", { refId: endpoint.id });
  expect(source.status).toBe(201);

  const delivery = await worker.fetch(
    new Request("https://local.test/api/endpoints/order-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Key": apiKey, "X-Endpoint-Event-Id": "wh-001" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(delivery.status).toBe(202);
  const { executionId } = (await delivery.json()) as { executionId: string };
  await trackWorkflowInstance(bindings.HELLO_WORKFLOW, executionId);

  const history = (await (
    await worker.fetch(authed("/api/event-sources/order-events/events", "GET"), bindings)
  ).json()) as { events: { eventId: string; topic: string; executionId: string }[] };
  expect(history.events).toMatchObject([{ eventId: "wh-001", topic: "webhook.delivered", executionId }]);

  // Disabling the source fences delivery appends; the delivery itself still
  // succeeds (the log never gates ingress).
  await worker.fetch(authed("/api/event-sources/order-events/disable", "POST", {}), bindings);
  const second = await worker.fetch(
    new Request("https://local.test/api/endpoints/order-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Endpoint-Key": apiKey, "X-Endpoint-Event-Id": "wh-002" },
      body: JSON.stringify({ input: { name: "Ada" } }),
    }),
    bindings,
  );
  expect(second.status).toBe(202);
  const secondId = ((await second.json()) as { executionId: string }).executionId;
  await trackWorkflowInstance(bindings.HELLO_WORKFLOW, secondId);
  const after = (await (
    await worker.fetch(authed("/api/event-sources/order-events/events", "GET"), bindings)
  ).json()) as { events: { eventId: string }[] };
  expect(after.events.map((entry) => entry.eventId)).toEqual(["wh-001"]);
});

it("appends schedule promotion to an observing source via the tick", async () => {
  const runAt = new Date(Date.now() - 30_000).toISOString();
  const created = await worker.fetch(
    authed("/api/schedules", "POST", {
      name: "nightly-sync",
      sagaId: helloSaga.id,
      kind: "one-off",
      runAt,
      input: { name: "sched" },
    }),
    bindings,
  );
  expect(created.status).toBe(201);
  const schedule = ((await created.json()) as { schedule: { id: string } }).schedule;

  const source = await createSource("nightly-events", "schedule", { refId: schedule.id });
  expect(source.status).toBe(201);

  const tick = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
  await tick.scheduled({ cron: "* * * * *" }, bindings);

  const window = (
    (await (await worker.fetch(authed("/api/schedules/nightly-sync", "GET"), bindings)).json()) as {
      schedule: { lastWindow: string };
    }
  ).schedule.lastWindow;
  const delivery = (await (
    await worker.fetch(authed(`/api/schedules/nightly-sync/deliveries?window=${window}`, "GET"), bindings)
  ).json()) as { delivery: { executionId: string } };
  await trackWorkflowInstance(bindings.HELLO_WORKFLOW, delivery.delivery.executionId);

  const history = (await (
    await worker.fetch(authed("/api/event-sources/nightly-events/events", "GET"), bindings)
  ).json()) as { events: { eventId: string; topic: string; executionId: string }[] };
  expect(history.events).toMatchObject([
    { eventId: window, topic: "schedule.delivered", executionId: delivery.delivery.executionId },
  ]);
});
