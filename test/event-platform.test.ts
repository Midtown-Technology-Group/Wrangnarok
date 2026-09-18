// SPDX-License-Identifier: AGPL-3.0
// TRG-03 S3b (issue #139): built-in platform emissions, end to end on the
// real local runtime (workerd D1 + local Workflow bindings; hello Saga needs
// no vendor fetch).
//
// Covers the S3b acceptance: an operator-registered `platform` topic source
// receives platform.schedule.delivered on schedule promotion and
// platform.webhook.delivered on endpoint delivery, each with Execution
// attribution in both the log row and the descriptive payload, fanning out
// through the shared submit-protocol helper. Silence paths (no source,
// disabled source, wrong-kind row) leave the promotion/delivery untouched;
// redelivery converges on one platform row and one Execution (duplicate
// suppression + restart recovery); foreign callers 404 and org B rows stay
// empty (no cross-org leakage).
//
// Successful-dispatch fan-out itself is proven by the S2 suite over the same
// shared helper: platform payloads are descriptive attribution, not Saga
// input, so the hello subscriber deterministically hits the parse gate
// (INVALID_INPUT skip, no receipt) and stays visible in the derived failed
// set — the same posture S2 pins for any non-conforming payload.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import {
  EVENT_SOURCE_NAME,
  EVENT_TOPIC,
  PLATFORM_SCHEDULE_DELIVERED_TOPIC,
  PLATFORM_SOURCE_NAME,
  PLATFORM_WEBHOOK_DELIVERED_TOPIC,
  platformEventId,
} from "../src/events";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-0000000000b0";
const STRANGER_USER = "00000000-0000-4000-8000-000000000005";
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const LAB = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...LAB },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function asUser(userId: string): Bindings {
  return { ...bindings, LAB_USER_ID: userId, LAB_FIXTURE_USER_ID: LAB_USER };
}

async function executionCount(): Promise<number> {
  return (await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>())?.n ?? -1;
}

async function platformEventCount(sourceOrg: string = ORG): Promise<number> {
  return (
    (
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE source_id=(SELECT id FROM event_sources WHERE org_id=? AND name='platform')",
      )
        .bind(sourceOrg)
        .first<{ n: number }>()
    )?.n ?? -1
  );
}

async function createPlatformSource(kind = "topic"): Promise<number> {
  const res = await worker.fetch(authed("/api/event-sources", "POST", { name: "platform", kind }), bindings);
  expect(res.status).toBe(201);
  return res.status;
}

async function createSub(name: string, topicFilter: string): Promise<void> {
  const res = await worker.fetch(
    authed("/api/event-sources/platform/subscriptions", "POST", {
      name,
      topicFilter,
      sagaId: helloSaga.id,
    }),
    bindings,
  );
  expect(res.status).toBe(201);
}

async function tick(): Promise<void> {
  const cron = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
  await cron.scheduled({ cron: "* * * * *" }, bindings);
}

useWorkflowHarness(bindings.DB, {
  setup: () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("platform tests must not fetch");
    });
  },
});

it("emits platform.schedule.delivered with execution attribution on promotion", async () => {
  await createPlatformSource();
  await createSub("sched-watch", "platform.schedule.*");
  const before = await executionCount();
  const runAt = new Date(Date.now() - 30_000).toISOString();
  expect(
    (
      await worker.fetch(
        authed("/api/schedules", "POST", {
          name: "plat-once",
          sagaId: helloSaga.id,
          kind: "one-off",
          runAt,
          input: { name: "sched" },
        }),
        bindings,
      )
    ).status,
  ).toBe(201);
  await tick();

  // The promotion ran exactly once; platform fan-out hit the hello parse
  // gate (descriptive payload, not Saga input), so no second Execution.
  expect(await executionCount()).toBe(before + 1);
  const promoted = await bindings.DB.prepare(
    "SELECT execution_id AS executionId FROM schedule_deliveries WHERE schedule_id=(SELECT id FROM schedules WHERE org_id=? AND name=?)",
  )
    .bind(ORG, "plat-once")
    .first<{ executionId: string }>();
  expect(promoted?.executionId).toMatch(/^[a-f0-9]{64}$/);

  const listed = await worker.fetch(authed("/api/event-sources/platform/events", "GET"), bindings);
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    events: { eventId: string; topic: string; payload: Record<string, string>; executionId: string | null }[];
  };
  expect(body.events).toHaveLength(1);
  const event = body.events[0];
  expect(event?.topic).toBe(PLATFORM_SCHEDULE_DELIVERED_TOPIC);
  expect(event?.executionId).toBe(promoted?.executionId);
  expect(event?.payload).toMatchObject({
    schedule: "plat-once",
    executionId: promoted?.executionId,
    sagaId: helloSaga.id,
  });
  const windowValue = event?.payload.window;
  expect(typeof windowValue).toBe("string");

  // Deterministic identity: the logged ID is the plat- derivation for this
  // (org, topic, schedule.window) delivery.
  const scheduleId = await bindings.DB.prepare("SELECT id FROM schedules WHERE org_id=? AND name=?")
    .bind(ORG, "plat-once")
    .first<{ id: string }>();
  const expected = await platformEventId(ORG, PLATFORM_SCHEDULE_DELIVERED_TOPIC, `${scheduleId?.id}.${windowValue}`);
  expect(event?.eventId).toBe(expected);

  // The parse-gated subscriber dispatched nothing, so the emission stays
  // visible in the derived failed set with no receipt.
  const failed = await worker.fetch(
    authed("/api/event-sources/platform/subscriptions/sched-watch/deliveries?outcome=failed", "GET"),
    bindings,
  );
  expect(await failed.json()).toMatchObject({
    deliveries: [{ eventId: event?.eventId, executionId: null, outcome: "failed" }],
  });

  // Restart recovery: a second tick replays the spent row and converges on
  // the same single platform row — no duplicate, no second Execution.
  await tick();
  expect(await platformEventCount()).toBe(1);
  expect(await executionCount()).toBe(before + 1);

  const { inner } = await trackWorkflowInstance(bindings.HELLO_WORKFLOW, promoted?.executionId as string);
  await inner.waitForStatus("complete");
}, 25000);

it("leaves promotion untouched when no platform source is registered", async () => {
  const before = await executionCount();
  const runAt = new Date(Date.now() - 30_000).toISOString();
  expect(
    (
      await worker.fetch(
        authed("/api/schedules", "POST", {
          name: "plat-quiet",
          sagaId: helloSaga.id,
          kind: "one-off",
          runAt,
          input: { name: "sched" },
        }),
        bindings,
      )
    ).status,
  ).toBe(201);
  await tick();
  expect(await executionCount()).toBe(before + 1);
  expect(await platformEventCount()).toBe(0);
  const sources = (await (await worker.fetch(authed("/api/event-sources", "GET"), bindings)).json()) as {
    sources: { name: string }[];
  };
  // Nothing auto-provisions: the platform never invents its opt-in row.
  expect(sources.sources.map((entry) => entry.name)).not.toContain("platform");
}, 25000);

it("fences platform emission while the platform source is disabled", async () => {
  await createPlatformSource();
  await createSub("sched-muted", "platform.*");
  expect(
    await worker.fetch(authed("/api/event-sources/platform/disable", "POST", {}), bindings).then((res) => res.status),
  ).toBe(200);
  const before = await executionCount();
  const runAt = new Date(Date.now() - 30_000).toISOString();
  expect(
    (
      await worker.fetch(
        authed("/api/schedules", "POST", {
          name: "plat-muted",
          sagaId: helloSaga.id,
          kind: "one-off",
          runAt,
          input: { name: "sched" },
        }),
        bindings,
      )
    ).status,
  ).toBe(201);
  await tick();
  // Promotion succeeds; the disabled source fences the emission.
  expect(await executionCount()).toBe(before + 1);
  expect(await platformEventCount()).toBe(0);
  // Re-enabling after the fact resurrects nothing: the spent window does not
  // promote again and no platform row appears.
  expect(
    await worker.fetch(authed("/api/event-sources/platform/enable", "POST", {}), bindings).then((res) => res.status),
  ).toBe(200);
  await tick();
  expect(await platformEventCount()).toBe(0);
  expect(await executionCount()).toBe(before + 1);
}, 25000);

it("ignores a platform row registered under another kind", async () => {
  await createPlatformSource("webhook");
  const before = await executionCount();
  const runAt = new Date(Date.now() - 30_000).toISOString();
  expect(
    (
      await worker.fetch(
        authed("/api/schedules", "POST", {
          name: "plat-kind",
          sagaId: helloSaga.id,
          kind: "one-off",
          runAt,
          input: { name: "sched" },
        }),
        bindings,
      )
    ).status,
  ).toBe(201);
  await tick();
  expect(await executionCount()).toBe(before + 1);
  expect(
    await worker.fetch(authed("/api/event-sources/platform/events", "GET"), bindings).then((res) => res.json()),
  ).toMatchObject({ events: [] });
}, 25000);

it("emits platform.webhook.delivered on endpoint delivery and converges on redelivery", async () => {
  await createPlatformSource();
  await createSub("hook-watch", "platform.webhook.*");
  const created = await worker.fetch(
    authed("/api/endpoints", "POST", { name: "plat-hook", sagaId: helloSaga.id, kind: "api-key" }),
    bindings,
  );
  expect(created.status).toBe(201);
  const { apiKey } = (await created.json()) as { apiKey: string };
  const before = await executionCount();

  const deliver = (eventId: string) =>
    worker.fetch(
      new Request("https://local.test/api/endpoints/plat-hook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Endpoint-Key": apiKey, "X-Endpoint-Event-Id": eventId },
        body: JSON.stringify({ input: { name: "Ada" } }),
      }),
      bindings,
    );
  const first = await deliver("plat-evt-1");
  expect(first.status).toBe(202);
  const firstBody = (await first.json()) as { executionId: string; replayed: boolean };
  expect(firstBody.replayed).toBe(false);

  const listed = (await (await worker.fetch(authed("/api/event-sources/platform/events", "GET"), bindings)).json()) as {
    events: { eventId: string; topic: string; payload: Record<string, string>; executionId: string | null }[];
  };
  expect(listed.events).toHaveLength(1);
  const event = listed.events[0];
  expect(event?.topic).toBe(PLATFORM_WEBHOOK_DELIVERED_TOPIC);
  expect(event?.executionId).toBe(firstBody.executionId);
  expect(event?.payload).toMatchObject({
    endpoint: "plat-hook",
    eventId: "plat-evt-1",
    executionId: firstBody.executionId,
    sagaId: helloSaga.id,
  });

  // Vendor redelivery replays the delivery and converges on the same single
  // platform row and Execution: duplicate suppression end to end.
  const replay = await deliver("plat-evt-1");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ executionId: firstBody.executionId, replayed: true });
  expect(await platformEventCount()).toBe(1);
  expect(await executionCount()).toBe(before + 1);

  const { inner } = await trackWorkflowInstance(bindings.HELLO_WORKFLOW, firstBody.executionId);
  await inner.waitForStatus("complete");
}, 25000);

it("keeps platform history inside its own organization", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,'Second org') ON CONFLICT(id) DO NOTHING")
    .bind(ORG_B)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO event_sources(id,org_id,name,kind,ref_id,enabled,created_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(`test-platform-b-${stamp}`, ORG_B, "platform", "topic", null, stamp)
    .run();
  await createPlatformSource();
  await createSub("sched-fence", "platform.*");
  const runAt = new Date(Date.now() - 30_000).toISOString();
  expect(
    (
      await worker.fetch(
        authed("/api/schedules", "POST", {
          name: "plat-fence",
          sagaId: helloSaga.id,
          kind: "one-off",
          runAt,
          input: { name: "sched" },
        }),
        bindings,
      )
    ).status,
  ).toBe(201);
  await tick();

  // Org A observed its own delivery; org B's platform source stayed empty.
  expect(await platformEventCount(ORG)).toBe(1);
  expect(await platformEventCount(ORG_B)).toBe(0);

  // A caller with no membership reaches nothing under the namespace.
  await bindings.DB.prepare(
    "INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT(user_id) DO NOTHING",
  )
    .bind(STRANGER_USER, stamp)
    .run();
  await bindings.DB.prepare("DELETE FROM org_memberships WHERE org_id=? AND user_id=?").bind(ORG, STRANGER_USER).run();
  const stranger = asUser(STRANGER_USER);
  expect(
    await worker.fetch(authed("/api/event-sources/platform/events", "GET"), stranger).then((res) => res.status),
  ).toBe(404);
  expect(
    await worker
      .fetch(authed("/api/event-sources/platform/subscriptions/sched-fence/deliveries", "GET"), stranger)
      .then((res) => res.status),
  ).toBe(404);
}, 25000);

it("derives stable, scoped platform event IDs", async () => {
  const first = await platformEventId(ORG, PLATFORM_SCHEDULE_DELIVERED_TOPIC, "sched-1.once-1");
  const again = await platformEventId(ORG, PLATFORM_SCHEDULE_DELIVERED_TOPIC, "sched-1.once-1");
  expect(again).toBe(first);
  expect(first).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  expect(await platformEventId(ORG, PLATFORM_SCHEDULE_DELIVERED_TOPIC, "sched-1.once-2")).not.toBe(first);
  expect(await platformEventId(ORG, PLATFORM_WEBHOOK_DELIVERED_TOPIC, "sched-1.once-1")).not.toBe(first);
  expect(await platformEventId(ORG_B, PLATFORM_SCHEDULE_DELIVERED_TOPIC, "sched-1.once-1")).not.toBe(first);
  // The well-known names keep the registry and topic shapes by construction.
  expect(PLATFORM_SOURCE_NAME).toMatch(EVENT_SOURCE_NAME);
  expect(PLATFORM_SCHEDULE_DELIVERED_TOPIC).toMatch(EVENT_TOPIC);
  expect(PLATFORM_WEBHOOK_DELIVERED_TOPIC).toMatch(EVENT_TOPIC);
});
