// SPDX-License-Identifier: AGPL-3.0
// TRG-03 S2+S3a (issue #139): branch-coverage companion to
// test/event-subscriptions.test.ts. Unit-level pins for every validation,
// fence, and fallback branch in the S2/S3a slices of src/events.ts that the
// end to-end suite does not force: filter parsing/matching, delivery-key
// shape, registry conflicts, pre-migration fallbacks, fan-out with a
// stubbed submit protocol (order, bound/overflow, gone/disabled races,
// authority and grant fences, misconfigured sagas, invalid input, submit
// faults, cross-org silence, and no-side-effect failures), plus the S3a
// retry surface (event-id/outcome parsing, failed derivation, retry
// eligibility, shared-fence drift, and the per-event bound on replay).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { Fault, helloSaga } from "../src/domain";
import type { Principal } from "../src/domain";
import type { submit } from "../src/executions";
import {
  createEventSource,
  createSubscription,
  deleteEventSource,
  deleteSubscription,
  dispatchEventFanout,
  emitEvent,
  EVENT_FANOUT_LIMIT,
  listFailedDeliveries,
  listSubscriptionDeliveries,
  listSubscriptions,
  loadEventSource,
  loadSubscription,
  matchesTopicFilter,
  parseDeliveryEventId,
  parseDeliveryOutcome,
  parseSubscriptionName,
  parseSubscriptionSagaId,
  parseTopicFilter,
  retrySubscriptionDelivery,
  setSubscriptionEnabled,
  subscriptionDeliveryKey,
  subscriptionSummary,
  type EventSourceRow,
  type SubscriptionRow,
} from "../src/events";
import { parseCallerKey } from "../src/domain";
import { applyFullMigrations } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const CALLER: Principal = { userId: LAB_USER, orgId: ORG };

/** Wrap the test D1 binding so the listed statement methods on statements
 * matching `match` resolve with `value` instead of touching the tables.
 * Used to fabricate scan/re-read races no sequential test can interleave. */
function rowDb(match: (sql: string) => boolean, method: string, value: unknown): D1Database {
  const wrapStatement = (stmt: object): object =>
    new Proxy(stmt, {
      get(statementTarget, property) {
        if (typeof property === "string" && property === method) {
          return () => Promise.resolve(value);
        }
        const entry = (statementTarget as Record<string | symbol, unknown>)[property];
        if (typeof entry !== "function") return entry;
        return (...args: unknown[]) => {
          const out = (entry as (...args: unknown[]) => unknown).apply(statementTarget, args);
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
      const entry = (target as unknown as Record<string | symbol, unknown>)[property];
      return typeof entry === "function" ? (entry as (...args: unknown[]) => unknown).bind(target) : entry;
    },
  });
}

async function makeSource(name: string): Promise<EventSourceRow> {
  await createEventSource(bindings.DB, CALLER, { name, kind: "topic" });
  const row = await loadEventSource(bindings.DB, ORG, name);
  expect(row).not.toBeNull();
  return row as EventSourceRow;
}

function stubSubmit(outcome: (calls: number) => { executionId: string; replayed: boolean } | never): {
  fn: typeof submit;
  calls: () => number;
} {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    const next = outcome(calls);
    return { ...next, statusUrl: `/api/executions/${next.executionId}` };
  }) as typeof submit;
  return { fn, calls: () => calls };
}

const LAB_HEADERS = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

beforeEach(async () => {
  await applyFullMigrations(bindings.DB, true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("subscription branch tests must not fetch");
  });
  // Direct domain calls never pass the Worker gate, so the fixture
  // Organization/user/membership rows would not exist for the authority
  // resolver. One member-open read bootstraps them like every route does.
  await worker.fetch(
    new Request("https://local.test/api/event-sources", { method: "GET", headers: { ...LAB_HEADERS } }),
    bindings,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("pins subscription-name, topic-filter, and saga parsing", () => {
  expect(parseSubscriptionName("orders-created")).toBe("orders-created");
  try {
    parseSubscriptionName("BAD_NAME");
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
  }

  expect(parseTopicFilter("vendor.order.created")).toBe("vendor.order.created");
  expect(parseTopicFilter("vendor.order.*")).toBe("vendor.order.*");
  expect(parseTopicFilter("vendor.*")).toBe("vendor.*");
  for (const bad of ["orders", "Vendor.Order", "vendor.**", "vendor.*.*", "*", ".*", "", "a".repeat(129), 42, null]) {
    expect(() => parseTopicFilter(bad)).toThrow(expect.objectContaining({ code: "INVALID_SUBSCRIPTION" }));
  }

  expect(parseSubscriptionSagaId(helloSaga.id)).toBe(helloSaga.id);
  for (const bad of ["00000000-0000-4000-8000-ffffffffffff", "", 42, null]) {
    try {
      parseSubscriptionSagaId(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "UNKNOWN_SAGA" });
    }
  }
});

it("evaluates topic filters deterministically", () => {
  expect(matchesTopicFilter("vendor.order.created", "vendor.order.created")).toBe(true);
  expect(matchesTopicFilter("vendor.order.created", "vendor.order.cancelled")).toBe(false);
  expect(matchesTopicFilter("vendor.order.created", "vendor.order.*")).toBe(true);
  expect(matchesTopicFilter("vendor.order.created", "vendor.*")).toBe(true);
  // A namespace filter never matches its own base or a sibling prefix.
  expect(matchesTopicFilter("vendor.order", "vendor.order.*")).toBe(false);
  expect(matchesTopicFilter("vendor.orderx.created", "vendor.order.*")).toBe(false);
  expect(matchesTopicFilter("other.order.created", "vendor.*")).toBe(false);
  // Exact filters never prefix-match.
  expect(matchesTopicFilter("vendor.order.created.extra", "vendor.order.created")).toBe(false);
});

it("derives stable delivery keys in the reserved evt- namespace", async () => {
  const first = await subscriptionDeliveryKey("sub-id", "evt-1");
  expect(first).toMatch(/^evt-[a-f0-9]{64}$/);
  expect(await subscriptionDeliveryKey("sub-id", "evt-1")).toBe(first);
  expect(await subscriptionDeliveryKey("sub-id", "evt-2")).not.toBe(first);
  expect(await subscriptionDeliveryKey("other-sub", "evt-1")).not.toBe(first);
  // Callers can never squat the delivery namespace.
  expect(() => parseCallerKey("evt-abc1234567890123")).toThrow(
    expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }),
  );
});

it("conflicts on duplicate subscription names and hides foreign rows", async () => {
  const source = await makeSource("br2-reg");
  const created = await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  expect(created).toMatchObject({ name: "br2-sub", enabled: true });
  expect(
    subscriptionSummary({ ...((await loadSubscription(bindings.DB, ORG, source.id, "br2-sub")) as SubscriptionRow) }),
  ).toMatchObject({
    name: "br2-sub",
    sagaId: helloSaga.id,
  });
  await expect(
    createSubscription(bindings.DB, CALLER, source, {
      name: "br2-sub",
      topicFilter: "vendor.order.*",
      sagaId: helloSaga.id,
    }),
  ).rejects.toMatchObject({ status: 409, code: "SUBSCRIPTION_EXISTS" });
  for (const bad of ["BAD", "", 42, null]) {
    await expect(
      createSubscription(bindings.DB, CALLER, source, { name: bad, topicFilter: "a.b", sagaId: helloSaga.id }),
    ).rejects.toMatchObject({ code: "INVALID_SUBSCRIPTION" });
  }
  // Same name on another source is a different subscription.
  const other = await makeSource("br2-reg-other");
  expect(
    (
      await createSubscription(bindings.DB, CALLER, other, {
        name: "br2-sub",
        topicFilter: "a.b",
        sagaId: helloSaga.id,
      })
    ).name,
  ).toBe("br2-sub");

  expect(await loadSubscription(bindings.DB, "00000000-0000-4000-8000-00000000ffff", source.id, "br2-sub")).toBeNull();
  expect(await loadSubscription(bindings.DB, ORG, source.id, "br2-ghost")).toBeNull();
  await expect(setSubscriptionEnabled(bindings.DB, CALLER, source, "br2-ghost", false)).rejects.toMatchObject({
    status: 404,
    code: "NOT_FOUND",
  });
  await expect(deleteSubscription(bindings.DB, CALLER, source, "br2-ghost")).rejects.toMatchObject({
    status: 404,
    code: "NOT_FOUND",
  });
});

it("reads empty on pre-migration databases and rethrows real faults", async () => {
  await makeSource("br2-legacy");
  await bindings.DB.exec('DROP TABLE "event_subscriptions"');
  const source = (await loadEventSource(bindings.DB, ORG, "br2-legacy")) as EventSourceRow;
  expect(await listSubscriptions(bindings.DB, ORG, source.id)).toEqual([]);
  expect(
    await dispatchEventFanout(bindings.DB, bindings, stubSubmit(() => ({ executionId: "x", replayed: false })).fn, {
      orgId: ORG,
      sourceId: source.id,
      eventId: "evt-legacy",
      topic: "a.b",
      payload: { name: "Ada" },
    }),
  ).toEqual({ deliveries: [], overflowSkipped: 0 });
});

it("fans out in name order with a stubbed submit protocol", async () => {
  const source = await makeSource("br2-order");
  for (const name of ["z-sub", "a-sub", "m-sub"]) {
    await createSubscription(bindings.DB, CALLER, source, {
      name,
      topicFilter: "vendor.order.*",
      sagaId: helloSaga.id,
    });
  }
  const seen: string[] = [];
  const stub = stubSubmit((calls) => {
    seen.push(`call-${calls}`);
    return { executionId: `exec-${calls}`, replayed: false };
  });
  const result = await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-order-1",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(stub.calls()).toBe(3);
  expect(result.overflowSkipped).toBe(0);
  expect(result.deliveries.map((entry) => entry.subscription)).toEqual(["a-sub", "m-sub", "z-sub"]);
  expect(result.deliveries.every((entry) => entry.status === "dispatched")).toBe(true);
  expect(seen).toEqual(["call-1", "call-2", "call-3"]);
  // Receipts land per subscription for replay visibility.
  expect(
    await listSubscriptionDeliveries(
      bindings.DB,
      ((await loadSubscription(bindings.DB, ORG, source.id, "a-sub")) as SubscriptionRow).id,
      50,
    ),
  ).toMatchObject([{ eventId: "evt-order-1", executionId: "exec-1" }]);
});

it("bounds fan-out per event with explicit overflow", async () => {
  const source = await makeSource("br2-bound");
  for (let index = 0; index < EVENT_FANOUT_LIMIT + 2; index += 1) {
    await createSubscription(bindings.DB, CALLER, source, {
      name: `br2-${String(index).padStart(2, "0")}`,
      topicFilter: "vendor.order.*",
      sagaId: helloSaga.id,
    });
  }
  const stub = stubSubmit((calls) => ({ executionId: `exec-${calls}`, replayed: false }));
  const result = await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-burst",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(stub.calls()).toBe(EVENT_FANOUT_LIMIT);
  expect(result.overflowSkipped).toBe(2);
  expect(result.deliveries).toHaveLength(EVENT_FANOUT_LIMIT);
});

it("skips a subscription deleted between scan and dispatch with zero work", async () => {
  const source = await makeSource("br2-gone");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-gone-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  // The scan observes the row; the pre-dispatch re-read does not.
  const raced = rowDb((sql) => sql.includes("FROM event_subscriptions WHERE org_id="), "all", {
    results: [
      {
        id: "missing-id",
        org_id: ORG,
        source_id: source.id,
        name: "br2-gone-sub",
        saga_id: helloSaga.id,
        topic_filter: "vendor.order.*",
        enabled: 1,
        run_as_user_id: LAB_USER,
        created_at: new Date().toISOString(),
      },
    ],
  });
  const stub = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));
  const result = await dispatchEventFanout(raced, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-gone",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(stub.calls()).toBe(0);
  expect(result.deliveries).toMatchObject([
    { subscription: "br2-gone-sub", status: "skipped", code: "SUBSCRIPTION_GONE" },
  ]);
});

it("skips a subscription disabled between scan and dispatch with zero work", async () => {
  const source = await makeSource("br2-race");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-race-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const live = (await loadSubscription(bindings.DB, ORG, source.id, "br2-race-sub")) as SubscriptionRow;
  // The scan observes an enabled row; the pre-dispatch re-read observes the
  // disable that won the race.
  const raced = rowDb((sql) => sql.includes("FROM event_subscriptions WHERE id="), "first", { ...live, enabled: 0 });
  const stub = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));
  const result = await dispatchEventFanout(raced, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-race",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(stub.calls()).toBe(0);
  expect(result.deliveries).toMatchObject([
    { subscription: "br2-race-sub", status: "skipped", code: "SUBSCRIPTION_DISABLED" },
  ]);
});

it("revalidates run-as authority and grants before every dispatch", async () => {
  const source = await makeSource("br2-auth");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-auth-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const event = {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-auth",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  };
  const quiet = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));

  // Revoked membership fences with the request path's code.
  await bindings.DB.prepare("UPDATE org_memberships SET status='revoked' WHERE org_id=? AND user_id=?")
    .bind(ORG, LAB_USER)
    .run();
  try {
    const revoked = await dispatchEventFanout(bindings.DB, bindings, quiet.fn, event);
    expect(quiet.calls()).toBe(0);
    expect(revoked.deliveries).toMatchObject([
      { subscription: "br2-auth-sub", status: "skipped", code: "MEMBERSHIP_REVOKED" },
    ]);
  } finally {
    await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
      .bind(ORG, LAB_USER)
      .run();
  }

  // A live member with no execute grant fences with GRANT_REQUIRED.
  await bindings.DB.prepare("UPDATE org_memberships SET role='member' WHERE org_id=? AND user_id=?")
    .bind(ORG, LAB_USER)
    .run();
  try {
    const denied = await dispatchEventFanout(bindings.DB, bindings, quiet.fn, event);
    expect(denied.deliveries).toMatchObject([
      { subscription: "br2-auth-sub", status: "skipped", code: "GRANT_REQUIRED" },
    ]);
  } finally {
    await bindings.DB.prepare("UPDATE org_memberships SET role='admin' WHERE org_id=? AND user_id=?")
      .bind(ORG, LAB_USER)
      .run();
  }
  expect(quiet.calls()).toBe(0);
});

it("skips misconfigured sagas and invalid input without side effects", async () => {
  const source = await makeSource("br2-misconfig");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-misconfig-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const stub = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));

  // A Saga removed from the catalog after registration never dispatches.
  await bindings.DB.prepare("UPDATE event_subscriptions SET saga_id=? WHERE org_id=? AND name=?")
    .bind("00000000-0000-4000-8000-ffffffffffff", ORG, "br2-misconfig-sub")
    .run();
  const stale = await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-stale",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(stub.calls()).toBe(0);
  expect(stale.deliveries).toMatchObject([
    { subscription: "br2-misconfig-sub", status: "skipped", code: "SUBSCRIPTION_MISCONFIGURED" },
  ]);
  await bindings.DB.prepare("UPDATE event_subscriptions SET saga_id=? WHERE org_id=? AND name=?")
    .bind(helloSaga.id, ORG, "br2-misconfig-sub")
    .run();

  // Payloads outside the Saga parse gate skip with the parse code.
  const invalid = await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-invalid",
    topic: "vendor.order.created",
    payload: { wrong: "shape" },
  });
  expect(stub.calls()).toBe(0);
  expect(invalid.deliveries).toMatchObject([
    { subscription: "br2-misconfig-sub", status: "skipped", code: "INVALID_INPUT" },
  ]);

  // Submit Faults skip with their code and record no receipt; anything else
  // fails loud so a backend fault never reads as a skip.
  const paused = stubSubmit(() => {
    throw new Fault(409, "SAGA_PAUSED", "Paused for this test.");
  });
  const refused = await dispatchEventFanout(bindings.DB, bindings, paused.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-refused",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(refused.deliveries).toMatchObject([
    { subscription: "br2-misconfig-sub", status: "skipped", code: "SAGA_PAUSED" },
  ]);
  const sub = (await loadSubscription(bindings.DB, ORG, source.id, "br2-misconfig-sub")) as SubscriptionRow;
  expect(await listSubscriptionDeliveries(bindings.DB, sub.id, 50)).toEqual([]);

  const loud = stubSubmit(() => {
    throw new Error("injected submit fault");
  });
  await expect(
    dispatchEventFanout(bindings.DB, bindings, loud.fn, {
      orgId: ORG,
      sourceId: source.id,
      eventId: "evt-loud",
      topic: "vendor.order.created",
      payload: { name: "Ada" },
    }),
  ).rejects.toThrow("injected submit fault");
});

it("never fans out across organizations", async () => {
  const source = await makeSource("br2-xorg");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-xorg-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const stub = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));
  const foreign = await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
    orgId: "00000000-0000-4000-8000-00000000ffff",
    sourceId: source.id,
    eventId: "evt-xorg",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(stub.calls()).toBe(0);
  expect(foreign).toEqual({ deliveries: [], overflowSkipped: 0 });
});

it("lists newest-first bounded delivery history and cascades deletes", async () => {
  const source = await makeSource("br2-hist");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-hist-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const stub = stubSubmit((calls) => ({ executionId: `exec-${calls}`, replayed: false }));
  for (const eventId of ["evt-h1", "evt-h2", "evt-h3"]) {
    const result = await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
      orgId: ORG,
      sourceId: source.id,
      eventId,
      topic: "vendor.order.created",
      payload: { name: "Ada" },
    });
    expect(result.deliveries).toHaveLength(1);
  }
  const sub = (await loadSubscription(bindings.DB, ORG, source.id, "br2-hist-sub")) as SubscriptionRow;
  const page = await listSubscriptionDeliveries(bindings.DB, sub.id, 2);
  expect(page.map((entry) => entry.eventId)).toEqual(["evt-h3", "evt-h2"]);
  expect(await listSubscriptionDeliveries(bindings.DB, sub.id, 5000)).toHaveLength(3);

  // Subscription delete removes receipts; source delete removes the rest.
  await deleteSubscription(bindings.DB, CALLER, source, "br2-hist-sub");
  expect(await listSubscriptionDeliveries(bindings.DB, sub.id, 50)).toEqual([]);
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br2-hist-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-h4",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  await deleteEventSource(bindings.DB, CALLER, "br2-hist");
  expect(await loadEventSource(bindings.DB, ORG, "br2-hist")).toBeNull();
  const subs = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM event_subscriptions WHERE source_id=?")
    .bind(source.id)
    .first<{ n: number }>();
  expect(subs?.n).toBe(0);
});

it("pins delivery event-id and outcome parsing", () => {
  expect(parseDeliveryEventId("evt-1")).toBe("evt-1");
  expect(parseDeliveryEventId("a".repeat(128))).toHaveLength(128);
  for (const bad of ["", "a".repeat(129), "BAD!!", "has space", "slash/no"]) {
    try {
      parseDeliveryEventId(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
  }

  expect(parseDeliveryOutcome(new URLSearchParams())).toBe("all");
  expect(parseDeliveryOutcome(new URLSearchParams("outcome=delivered"))).toBe("delivered");
  expect(parseDeliveryOutcome(new URLSearchParams("outcome=failed"))).toBe("failed");
  expect(parseDeliveryOutcome(new URLSearchParams("outcome=all"))).toBe("all");
  try {
    parseDeliveryOutcome(new URLSearchParams("outcome=bogus"));
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ status: 400, code: "INVALID_OUTCOME" });
  }
  for (const query of ["other=1", "outcome=failed&extra=1"]) {
    try {
      parseDeliveryOutcome(new URLSearchParams(query));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "UNSUPPORTED_QUERY" });
    }
  }
});

it("derives failed deliveries from the log minus receipts", async () => {
  const source = await makeSource("br3-failed");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br3-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const sub = (await loadSubscription(bindings.DB, ORG, source.id, "br3-sub")) as SubscriptionRow;
  await emitEvent(bindings.DB, CALLER, "br3-failed", {
    eventId: "evt-f1",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  await emitEvent(bindings.DB, CALLER, "br3-failed", {
    eventId: "evt-f2",
    topic: "customer.created",
    payload: { name: "Bo" },
  });
  await emitEvent(bindings.DB, CALLER, "br3-failed", {
    eventId: "evt-f3",
    topic: "vendor.order.cancelled",
    payload: { name: "Cy" },
  });

  // Newest first; the filter miss never appears; failed entries name no
  // Execution.
  expect(await listFailedDeliveries(bindings.DB, sub, 50)).toMatchObject([
    { eventId: "evt-f3", outcome: "failed", executionId: null },
    { eventId: "evt-f1", outcome: "failed", executionId: null },
  ]);
  expect((await listFailedDeliveries(bindings.DB, sub, 1)).map((entry) => entry.eventId)).toEqual(["evt-f3"]);
  expect(await listFailedDeliveries(bindings.DB, sub, 5000)).toHaveLength(2);

  // A dispatched event leaves the failed set for receipts.
  const stub = stubSubmit((calls) => ({ executionId: `exec-${calls}`, replayed: false }));
  await dispatchEventFanout(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    sourceId: source.id,
    eventId: "evt-f1",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect((await listFailedDeliveries(bindings.DB, sub, 50)).map((entry) => entry.eventId)).toEqual(["evt-f3"]);
  expect(await listSubscriptionDeliveries(bindings.DB, sub.id, 50)).toMatchObject([
    { eventId: "evt-f1", outcome: "delivered", executionId: "exec-1" },
  ]);
});

it("reads failed empty and retries honestly on pre-migration databases", async () => {
  const source = await makeSource("br3-legacy");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br3-legacy-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const sub = (await loadSubscription(bindings.DB, ORG, source.id, "br3-legacy-sub")) as SubscriptionRow;
  await emitEvent(bindings.DB, CALLER, "br3-legacy", {
    eventId: "evt-old",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });

  // A database without the receipt table reports no failures and retries
  // past the missing bound count (zero dispatched); the receipt write
  // stays best-effort like fan-out.
  await bindings.DB.exec('DROP TABLE "event_deliveries"');
  expect(await listFailedDeliveries(bindings.DB, sub, 50)).toEqual([]);
  const stub = stubSubmit(() => ({ executionId: "exec-old", replayed: false }));
  const retried = await retrySubscriptionDelivery(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    source,
    subscription: sub,
    eventId: "evt-old",
  });
  expect(retried).toMatchObject({ eventId: "evt-old", executionId: "exec-old", replayed: false });
  expect(stub.calls()).toBe(1);

  // A database without the log has nothing logged and nothing to retry.
  await bindings.DB.exec('DROP TABLE "events"');
  expect(await listFailedDeliveries(bindings.DB, sub, 50)).toEqual([]);
  await expect(
    retrySubscriptionDelivery(bindings.DB, bindings, stub.fn, {
      orgId: ORG,
      source,
      subscription: sub,
      eventId: "evt-old",
    }),
  ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  expect(stub.calls()).toBe(1);
});

it("retries through the shared disable, delete, and authority fences", async () => {
  const source = await makeSource("br3-rfence");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br3-rfence-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const live = (await loadSubscription(bindings.DB, ORG, source.id, "br3-rfence-sub")) as SubscriptionRow;
  await emitEvent(bindings.DB, CALLER, "br3-rfence", {
    eventId: "evt-rf",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  const attempt = (db: D1Database, calls: ReturnType<typeof stubSubmit>) =>
    retrySubscriptionDelivery(db, bindings, calls.fn, {
      orgId: ORG,
      source,
      subscription: live,
      eventId: "evt-rf",
    });

  // A delete that lands after route resolution wins the race here.
  const gone = rowDb((sql) => sql.includes("FROM event_subscriptions WHERE id="), "first", null);
  const goneStub = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));
  await expect(attempt(gone, goneStub)).rejects.toMatchObject({ status: 404, code: "SUBSCRIPTION_GONE" });
  expect(goneStub.calls()).toBe(0);

  // A disable that lands after route resolution wins the race here.
  const raced = rowDb((sql) => sql.includes("FROM event_subscriptions WHERE id="), "first", {
    ...live,
    enabled: 0,
  });
  const raceStub = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));
  await expect(attempt(raced, raceStub)).rejects.toMatchObject({ status: 409, code: "SUBSCRIPTION_DISABLED" });
  expect(raceStub.calls()).toBe(0);

  // Revoked run-as authority fails closed with the request path's code.
  await bindings.DB.prepare("UPDATE org_memberships SET status='revoked' WHERE org_id=? AND user_id=?")
    .bind(ORG, LAB_USER)
    .run();
  try {
    const revokedStub = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));
    await expect(attempt(bindings.DB, revokedStub)).rejects.toMatchObject({
      status: 403,
      code: "MEMBERSHIP_REVOKED",
    });
    expect(revokedStub.calls()).toBe(0);
  } finally {
    await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
      .bind(ORG, LAB_USER)
      .run();
  }
});

it("fails retries closed on eligibility, config, input, and submit faults", async () => {
  const source = await makeSource("br3-rclosed");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br3-rclosed-sub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const sub = (await loadSubscription(bindings.DB, ORG, source.id, "br3-rclosed-sub")) as SubscriptionRow;
  await emitEvent(bindings.DB, CALLER, "br3-rclosed", {
    eventId: "evt-rc",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  await emitEvent(bindings.DB, CALLER, "br3-rclosed", {
    eventId: "evt-rc-bad",
    topic: "vendor.order.created",
    payload: { wrong: "shape" },
  });
  await emitEvent(bindings.DB, CALLER, "br3-rclosed", {
    eventId: "evt-rc-other",
    topic: "customer.created",
    payload: { name: "Bo" },
  });
  const attempt = (eventId: string, fn: typeof submit) =>
    retrySubscriptionDelivery(bindings.DB, bindings, fn, { orgId: ORG, source, subscription: sub, eventId });
  const quiet = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));

  // Unknown events and filter misses are not failed deliveries of this
  // subscription: 404, never a dispatch.
  await expect(attempt("evt-rc-ghost", quiet.fn)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  await expect(attempt("evt-rc-other", quiet.fn)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  expect(quiet.calls()).toBe(0);

  // A Saga removed from the catalog after registration never dispatches.
  await bindings.DB.prepare("UPDATE event_subscriptions SET saga_id=? WHERE org_id=? AND name=?")
    .bind("00000000-0000-4000-8000-ffffffffffff", ORG, "br3-rclosed-sub")
    .run();
  await expect(attempt("evt-rc", quiet.fn)).rejects.toMatchObject({
    status: 409,
    code: "SUBSCRIPTION_MISCONFIGURED",
  });
  await bindings.DB.prepare("UPDATE event_subscriptions SET saga_id=? WHERE org_id=? AND name=?")
    .bind(helloSaga.id, ORG, "br3-rclosed-sub")
    .run();
  expect(quiet.calls()).toBe(0);

  // Payloads outside the Saga parse gate refuse with the parse code.
  await expect(attempt("evt-rc-bad", quiet.fn)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(quiet.calls()).toBe(0);

  // Submit Faults refuse with their code and record no receipt; anything
  // else fails loud so a backend fault never reads as a refusal.
  const paused = stubSubmit(() => {
    throw new Fault(409, "SAGA_PAUSED", "Paused for this test.");
  });
  await expect(attempt("evt-rc", paused.fn)).rejects.toMatchObject({ status: 409, code: "SAGA_PAUSED" });
  expect(await listSubscriptionDeliveries(bindings.DB, sub.id, 50)).toEqual([]);

  const loud = stubSubmit(() => {
    throw new Error("injected submit fault");
  });
  await expect(attempt("evt-rc", loud.fn)).rejects.toThrow("injected submit fault");
});

it("dispatches a retry and records the receipt", async () => {
  const source = await makeSource("br3-rok");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br3-ok-sub",
    topicFilter: "vendor.order.created",
    sagaId: helloSaga.id,
  });
  const sub = (await loadSubscription(bindings.DB, ORG, source.id, "br3-ok-sub")) as SubscriptionRow;
  await emitEvent(bindings.DB, CALLER, "br3-rok", {
    eventId: "evt-ok",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  const stub = stubSubmit(() => ({ executionId: "exec-ok", replayed: false }));
  const result = await retrySubscriptionDelivery(bindings.DB, bindings, stub.fn, {
    orgId: ORG,
    source,
    subscription: sub,
    eventId: "evt-ok",
  });
  expect(result).toEqual({ subscription: "br3-ok-sub", eventId: "evt-ok", executionId: "exec-ok", replayed: false });
  expect(stub.calls()).toBe(1);
  expect(await listSubscriptionDeliveries(bindings.DB, sub.id, 50)).toMatchObject([
    { eventId: "evt-ok", executionId: "exec-ok", outcome: "delivered" },
  ]);
  expect(await listFailedDeliveries(bindings.DB, sub, 50)).toEqual([]);
});

it("refuses retries past the per-event bound, scoped to this source", async () => {
  const source = await makeSource("br3-rbound");
  await createSubscription(bindings.DB, CALLER, source, {
    name: "br3-rsub",
    topicFilter: "vendor.order.*",
    sagaId: helloSaga.id,
  });
  const sub = (await loadSubscription(bindings.DB, ORG, source.id, "br3-rsub")) as SubscriptionRow;
  await emitEvent(bindings.DB, CALLER, "br3-rbound", {
    eventId: "evt-rb",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  const attempt = (fn: typeof submit) =>
    retrySubscriptionDelivery(bindings.DB, bindings, fn, {
      orgId: ORG,
      source,
      subscription: sub,
      eventId: "evt-rb",
    });

  // Ten receipts for the same event-id string under another source do not
  // count toward this source's bound. (Receipts only record successful
  // submits, so direct inserts stand in for dispatched siblings here;
  // fan-out covers the dispatch itself.)
  const other = await makeSource("br3-rbound-other");
  const stamp = new Date().toISOString();
  for (let index = 0; index < EVENT_FANOUT_LIMIT; index += 1) {
    const sib = await createSubscription(bindings.DB, CALLER, other, {
      name: `br3-osib-${String(index).padStart(2, "0")}`,
      topicFilter: "vendor.order.*",
      sagaId: helloSaga.id,
    });
    await bindings.DB.prepare(
      "INSERT INTO event_deliveries(subscription_id,event_id,org_id,topic,execution_id,created_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(sib.id, "evt-rb", ORG, "vendor.order.created", `exec-other-${index}`, stamp)
      .run();
  }
  const allowed = stubSubmit(() => ({ executionId: "exec-rb", replayed: false }));
  await expect(attempt(allowed.fn)).resolves.toMatchObject({ executionId: "exec-rb", replayed: false });
  expect(allowed.calls()).toBe(1);

  // Ten receipts under this source's own siblings refuse the retry.
  for (let index = 0; index < EVENT_FANOUT_LIMIT; index += 1) {
    const sib = await createSubscription(bindings.DB, CALLER, source, {
      name: `br3-sib-${String(index).padStart(2, "0")}`,
      topicFilter: "vendor.order.*",
      sagaId: helloSaga.id,
    });
    await bindings.DB.prepare(
      "INSERT INTO event_deliveries(subscription_id,event_id,org_id,topic,execution_id,created_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(sib.id, "evt-rb", ORG, "vendor.order.created", `exec-sib-${index}`, stamp)
      .run();
  }
  const refused = stubSubmit(() => ({ executionId: "exec-x", replayed: false }));
  await expect(attempt(refused.fn)).rejects.toMatchObject({ status: 409, code: "DELIVERY_BOUND_EXCEEDED" });
  expect(refused.calls()).toBe(0);
});
