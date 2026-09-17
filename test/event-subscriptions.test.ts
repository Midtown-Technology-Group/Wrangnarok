// SPDX-License-Identifier: AGPL-3.0
// TRG-03 S2 (issue #139): scoped subscriptions plus bounded fan-out, end to
// end on the real local runtime (workerd D1 + local Workflow bindings;
// hello Saga needs no vendor fetch).
//
// Covers the S2 acceptance: subscription CRUD with admin/operator lifecycle
// gates and exact-org hidden 404s, one accepted event fanning out through
// the existing submit protocol to all eligible subscribers with stable
// idempotency keys, deterministic filter match/miss/order, same-content
// replay convergence vs mismatched-content conflict, disable/revoke/delete
// fencing with zero dispatch, the per-event fan-out bound with explicit
// overflow, cross-org isolation, and no-side-effect failures. Operator
// replay/retry APIs and built-in platform events stay deferred to S3 and
// are untested here by design.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga } from "../src/domain";
import { subscriptionDeliveryKey } from "../src/events";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const MEMBER_USER = "00000000-0000-4000-8000-000000000006";
const ADMIN2_USER = "00000000-0000-4000-8000-000000000007";
const STRANGER_USER = "00000000-0000-4000-8000-000000000005";
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

async function ensureUser(userId: string, role: "admin" | "member"): Promise<void> {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT(user_id) DO NOTHING",
  )
    .bind(userId, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,'active','ordinary',?,?) ON CONFLICT(org_id,user_id) DO NOTHING",
  )
    .bind(ORG, userId, role, stamp, stamp)
    .run();
  await bindings.DB.prepare("UPDATE org_memberships SET role=?,status='active' WHERE org_id=? AND user_id=?")
    .bind(role, ORG, userId)
    .run();
}

async function createSource(name: string): Promise<void> {
  const res = await worker.fetch(authed("/api/event-sources", "POST", { name, kind: "topic" }), bindings);
  expect(res.status).toBe(201);
}

interface TestDelivery {
  readonly subscription: string;
  readonly status: string;
  readonly executionId: string;
  readonly replayed: boolean;
  readonly code?: string;
}

interface EmitBody {
  readonly event?: { eventId: string; topic: string };
  readonly replayed?: boolean;
  readonly deliveries?: TestDelivery[];
  readonly overflowSkipped?: number;
  readonly error?: { code?: string };
}

interface SubBody {
  readonly subscription?: { id: string; name: string };
  readonly subscriptions?: { name: string }[];
  readonly deliveries?: { eventId: string; executionId: string }[];
  readonly deleted?: boolean;
  readonly error?: { code?: string };
}

async function createSub(source: string, body: Record<string, unknown>): Promise<{ status: number; body: SubBody }> {
  const res = await worker.fetch(authed(`/api/event-sources/${source}/subscriptions`, "POST", body), bindings);
  return { status: res.status, body: (await res.json()) as SubBody };
}

async function emit(
  source: string,
  body: Record<string, unknown>,
  caller: Bindings = bindings,
): Promise<{ status: number; body: EmitBody }> {
  const res = await worker.fetch(authed(`/api/event-sources/${source}/events`, "POST", body), caller);
  return { status: res.status, body: (await res.json()) as EmitBody };
}

async function trackAll(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await trackWorkflowInstance(bindings.HELLO_WORKFLOW, id);
  }
}

useWorkflowHarness(bindings.DB, {
  setup: () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("subscription tests must not fetch");
    });
  },
});

it("gates subscription lifecycle on operators and hides foreign rows", async () => {
  await createSource("s2-crud");
  await ensureUser(MEMBER_USER, "member");
  await ensureUser(STRANGER_USER, "member");
  // The stranger row exists as a user but carries no membership: the
  // membership gate answers 404 before any subscription row is touched.
  await bindings.DB.prepare("DELETE FROM org_memberships WHERE org_id=? AND user_id=?").bind(ORG, STRANGER_USER).run();
  const member = asUser(MEMBER_USER);
  const stranger = asUser(STRANGER_USER);

  // Non-operator writes fail closed; member reads stay open.
  const memberWrite = await worker.fetch(
    authed("/api/event-sources/s2-crud/subscriptions", "POST", {
      name: "member-sub",
      topicFilter: "vendor.order.created",
      sagaId: helloSaga.id,
    }),
    member,
  );
  expect(memberWrite.status).toBe(403);

  const created = await createSub("s2-crud", {
    name: "orders-created",
    topicFilter: "vendor.order.created",
    sagaId: helloSaga.id,
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    subscription: { name: "orders-created", topicFilter: "vendor.order.created", sagaId: helloSaga.id, enabled: true },
  });

  const listed = await worker.fetch(authed("/api/event-sources/s2-crud/subscriptions", "GET"), member);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ subscriptions: [{ name: "orders-created" }] });

  const detail = await worker.fetch(authed("/api/event-sources/s2-crud/subscriptions/orders-created", "GET"), member);
  expect(detail.status).toBe(200);

  const duplicate = await createSub("s2-crud", {
    name: "orders-created",
    topicFilter: "vendor.order.created",
    sagaId: helloSaga.id,
  });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body).toMatchObject({ error: { code: "SUBSCRIPTION_EXISTS" } });

  const badFilter = await createSub("s2-crud", { name: "bad-filter", topicFilter: "orders", sagaId: helloSaga.id });
  expect(badFilter.status).toBe(400);
  expect(badFilter.body).toMatchObject({ error: { code: "INVALID_SUBSCRIPTION" } });

  const wildFilter = await createSub("s2-crud", { name: "wild-filter", topicFilter: "vendor.*", sagaId: helloSaga.id });
  expect(wildFilter.status).toBe(201);

  const unknownSaga = await createSub("s2-crud", {
    name: "unknown-saga",
    topicFilter: "vendor.order.created",
    sagaId: "00000000-0000-4000-8000-ffffffffffff",
  });
  expect(unknownSaga.status).toBe(400);
  expect(unknownSaga.body).toMatchObject({ error: { code: "UNKNOWN_SAGA" } });

  const emptyBody = await worker.fetch(authed("/api/event-sources/s2-crud/subscriptions", "POST", null), bindings);
  expect(emptyBody.status).toBe(400);

  // Unknown shapes answer 404, never a leak or UNIMPLEMENTED theater.
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/subscriptions/BAD_NAME", "GET"), bindings)
      .then((res) => res.status),
  ).toBe(404);
  expect(
    await worker.fetch(authed("/api/event-sources/s2-crud/subscriptions/ghost", "GET"), bindings).then((r) => r.status),
  ).toBe(404);
  expect(
    await worker.fetch(authed("/api/event-sources/ghost/subscriptions", "GET"), bindings).then((r) => r.status),
  ).toBe(404);
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/subscriptions/ghost/deliveries", "GET"), bindings)
      .then((r) => r.status),
  ).toBe(404);
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/subscriptions/nope/deeper", "GET"), bindings)
      .then((r) => r.status),
  ).toBe(404);

  // Cross-Organization isolation: the stranger reaches nothing.
  expect(
    await worker.fetch(authed("/api/event-sources/s2-crud/subscriptions", "GET"), stranger).then((r) => r.status),
  ).toBe(404);
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/subscriptions/orders-created", "GET"), stranger)
      .then((r) => r.status),
  ).toBe(404);
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/events", "POST", { eventId: "x", topic: "a.b", payload: {} }), stranger)
      .then((r) => r.status),
  ).toBe(404);

  // Disable fencing preserves receipts; member writes stay fenced too.
  const disabled = await worker.fetch(
    authed("/api/event-sources/s2-crud/subscriptions/orders-created/disable", "POST", {}),
    bindings,
  );
  expect(await disabled.json()).toMatchObject({ subscription: { name: "orders-created", enabled: false } });
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/subscriptions/orders-created/disable", "POST", {}), member)
      .then((r) => r.status),
  ).toBe(403);
  const enabled = await worker.fetch(
    authed("/api/event-sources/s2-crud/subscriptions/orders-created/enable", "POST", {}),
    bindings,
  );
  expect(await enabled.json()).toMatchObject({ subscription: { name: "orders-created", enabled: true } });

  // Deleting removes the subscription plus its receipts.
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/subscriptions/orders-created", "DELETE"), member)
      .then((r) => r.status),
  ).toBe(403);
  const deleted = await worker.fetch(
    authed("/api/event-sources/s2-crud/subscriptions/orders-created", "DELETE"),
    bindings,
  );
  expect(await deleted.json()).toEqual({ deleted: true });
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-crud/subscriptions/orders-created", "GET"), bindings)
      .then((r) => r.status),
  ).toBe(404);
  await worker.fetch(authed("/api/event-sources/s2-crud/subscriptions/wild-filter", "DELETE"), bindings);
});

it("fans out one accepted event to every eligible subscriber with stable keys", async () => {
  await createSource("s2-fanout");
  const exact = await createSub("s2-fanout", {
    name: "sub-exact",
    topicFilter: "vendor.order.created",
    sagaId: helloSaga.id,
  });
  const wild = await createSub("s2-fanout", { name: "sub-wild", topicFilter: "vendor.order.*", sagaId: helloSaga.id });
  expect(exact.status).toBe(201);
  expect(wild.status).toBe(201);
  const before = await executionCount();

  const first = await emit("s2-fanout", {
    eventId: "evt-fan-1",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(first.status).toBe(201);
  const deliveries: TestDelivery[] = first.body.deliveries ?? [];
  expect(first.body).toMatchObject({ replayed: false, overflowSkipped: 0 });
  expect(deliveries.map((entry) => [entry.subscription, entry.status])).toEqual([
    ["sub-exact", "dispatched"],
    ["sub-wild", "dispatched"],
  ]);
  const ids = deliveries.map((entry) => entry.executionId);
  expect(new Set(ids).size).toBe(2);
  await trackAll(ids);

  // Stable idempotency keys: each Execution ID is the deterministic hash of
  // (run-as org, run-as user, evt- delivery key).
  const runAs = { orgId: ORG, userId: LAB_USER };
  for (const [sub, id] of [
    [exact.body.subscription?.id ?? "", ids[0]],
    [wild.body.subscription?.id ?? "", ids[1]],
  ] as const) {
    const key = await subscriptionDeliveryKey(sub, "evt-fan-1");
    expect(key).toMatch(/^evt-[a-f0-9]{64}$/);
    expect(id).toBe(await executionId(runAs, key));
  }
  expect(await executionCount()).toBe(before + 2);

  // Delivery receipts carry replay visibility per subscriber.
  for (const sub of ["sub-exact", "sub-wild"]) {
    const receipts = (await (
      await worker.fetch(authed(`/api/event-sources/s2-fanout/subscriptions/${sub}/deliveries`, "GET"), bindings)
    ).json()) as { deliveries: { eventId: string; executionId: string }[] };
    expect(receipts.deliveries).toHaveLength(1);
    expect(receipts.deliveries[0]?.eventId).toBe("evt-fan-1");
  }

  // Same content replays: same Execution IDs, single receipt rows.
  const replay = await emit("s2-fanout", {
    eventId: "evt-fan-1",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({ replayed: true, overflowSkipped: 0 });
  const replayed = (replay.body.deliveries ?? []).map((entry) => entry.executionId);
  expect(new Set([...ids, ...replayed]).size).toBe(2);
  expect((replay.body.deliveries ?? []).every((entry) => entry.replayed)).toBe(true);
  const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM event_deliveries").first<{ n: number }>();
  expect(rows?.n).toBe(2);
  expect(await executionCount()).toBe(before + 2);

  // Mismatched content conflicts with zero new work.
  const mismatch = await emit("s2-fanout", {
    eventId: "evt-fan-1",
    topic: "vendor.order.created",
    payload: { name: "Bo" },
  });
  expect(mismatch.status).toBe(409);
  expect(mismatch.body).toMatchObject({ error: { code: "EVENT_CONFLICT" } });
  expect(await executionCount()).toBe(before + 2);
}, 25000);

it("matches, misses, and orders filters deterministically", async () => {
  await createSource("s2-filter");
  for (const [name, topicFilter] of [
    ["aaa-exact", "vendor.order.created"],
    ["mmm-other", "customer.created"],
    ["zzz-wild", "vendor.*"],
  ] as const) {
    expect((await createSub("s2-filter", { name, topicFilter, sagaId: helloSaga.id })).status).toBe(201);
  }
  const before = await executionCount();

  const first = await emit("s2-filter", {
    eventId: "evt-ord-1",
    topic: "vendor.order.created",
    payload: { name: "Bo" },
  });
  expect(first.status).toBe(201);
  const order = (first.body.deliveries ?? []).map((entry) => entry.subscription);
  expect(order).toEqual(["aaa-exact", "zzz-wild"]);
  await trackAll((first.body.deliveries ?? []).map((entry) => entry.executionId));

  const second = await emit("s2-filter", { eventId: "evt-cust-1", topic: "customer.created", payload: { name: "Cy" } });
  expect((second.body.deliveries ?? []).map((entry) => entry.subscription)).toEqual(["mmm-other"]);
  await trackAll((second.body.deliveries ?? []).map((entry) => entry.executionId));
  expect(await executionCount()).toBe(before + 3);
}, 25000);

it("fences disable, revoked authority, missing grants, and delete with zero dispatch", async () => {
  await createSource("s2-fence");
  expect(
    (await createSub("s2-fence", { name: "fenced", topicFilter: "vendor.order.created", sagaId: helloSaga.id })).status,
  ).toBe(201);
  const before = await executionCount();
  const attempt = async (eventId: string) =>
    emit("s2-fence", { eventId, topic: "vendor.order.created", payload: { name: "Ada" } });

  // Disabled subscriptions fence fan-out while the log still accepts.
  await worker.fetch(authed("/api/event-sources/s2-fence/subscriptions/fenced/disable", "POST", {}), bindings);
  const fenced = await attempt("evt-fence-1");
  expect(fenced.status).toBe(201);
  expect(fenced.body.deliveries).toMatchObject([
    { subscription: "fenced", status: "skipped", code: "SUBSCRIPTION_DISABLED" },
  ]);
  expect(await executionCount()).toBe(before);
  await worker.fetch(authed("/api/event-sources/s2-fence/subscriptions/fenced/enable", "POST", {}), bindings);

  // Revoked run-as authority never resurrects: a second admin emits while
  // the persisted run-as owner stays revoked.
  await ensureUser(ADMIN2_USER, "admin");
  await bindings.DB.prepare("UPDATE org_memberships SET status='revoked' WHERE org_id=? AND user_id=?")
    .bind(ORG, LAB_USER)
    .run();
  try {
    const revoked = await emit(
      "s2-fence",
      { eventId: "evt-fence-2", topic: "vendor.order.created", payload: { name: "Ada" } },
      asUser(ADMIN2_USER),
    );
    expect(revoked.status).toBe(201);
    expect(revoked.body.deliveries).toMatchObject([
      { subscription: "fenced", status: "skipped", code: "MEMBERSHIP_REVOKED" },
    ]);
    expect(await executionCount()).toBe(before);
  } finally {
    await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
      .bind(ORG, LAB_USER)
      .run();
  }

  // A run-as member with no execute grant fences with GRANT_REQUIRED.
  await ensureUser(MEMBER_USER, "member");
  await bindings.DB.prepare("UPDATE event_subscriptions SET run_as_user_id=? WHERE org_id=? AND name=?")
    .bind(MEMBER_USER, ORG, "fenced")
    .run();
  const denied = await attempt("evt-fence-3");
  expect(denied.status).toBe(201);
  expect(denied.body.deliveries).toMatchObject([{ subscription: "fenced", status: "skipped", code: "GRANT_REQUIRED" }]);
  expect(await executionCount()).toBe(before);
  await bindings.DB.prepare("UPDATE event_subscriptions SET run_as_user_id=? WHERE org_id=? AND name=?")
    .bind(LAB_USER, ORG, "fenced")
    .run();

  // Deleted subscriptions leave no entry at all and dispatch nothing.
  await worker.fetch(authed("/api/event-sources/s2-fence/subscriptions/fenced", "DELETE"), bindings);
  const gone = await attempt("evt-fence-4");
  expect(gone.status).toBe(201);
  expect(gone.body).toMatchObject({ deliveries: [], overflowSkipped: 0 });
  expect(await executionCount()).toBe(before);
}, 25000);

it("bounds fan-out per event with explicit overflow", async () => {
  await createSource("s2-bound");
  for (let index = 0; index < 12; index += 1) {
    const name = `s2-b${String(index).padStart(2, "0")}`;
    expect((await createSub("s2-bound", { name, topicFilter: "vendor.order.*", sagaId: helloSaga.id })).status).toBe(
      201,
    );
  }
  const before = await executionCount();

  const burst = await emit("s2-bound", {
    eventId: "evt-burst-1",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(burst.status).toBe(201);
  expect(burst.body).toMatchObject({ overflowSkipped: 2 });
  const deliveries: TestDelivery[] = burst.body.deliveries ?? [];
  expect(deliveries).toHaveLength(10);
  expect(deliveries.map((entry) => entry.subscription)).toEqual(
    Array.from({ length: 10 }, (_, index) => `s2-b${String(index).padStart(2, "0")}`),
  );
  expect(deliveries.every((entry) => entry.status === "dispatched")).toBe(true);
  await trackAll(deliveries.map((entry) => entry.executionId));
  expect(await executionCount()).toBe(before + 10);

  const rows = await bindings.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_deliveries WHERE subscription_id IN (SELECT id FROM event_subscriptions WHERE source_id IN (SELECT id FROM event_sources WHERE org_id=? AND name=?))",
  )
    .bind(ORG, "s2-bound")
    .first<{ n: number }>();
  expect(rows?.n).toBe(10);
}, 60000);

it("fails with no side effects and deletes cascade to subscriptions", async () => {
  await createSource("s2-clean");
  expect(
    (await createSub("s2-clean", { name: "clean-sub", topicFilter: "vendor.order.created", sagaId: helloSaga.id }))
      .status,
  ).toBe(201);
  const before = await executionCount();

  // Validation failures emit nothing and dispatch nothing.
  const bare = await emit("s2-clean", { eventId: "evt-clean-1", topic: "orders", payload: { name: "Ada" } });
  expect(bare.status).toBe(400);
  const noId = await emit("s2-clean", { topic: "vendor.order.created", payload: { name: "Ada" } });
  expect(noId.status).toBe(400);
  expect(
    await worker
      .fetch(authed("/api/event-sources/ghost/events", "POST", { eventId: "e", topic: "a.b", payload: {} }), bindings)
      .then((res) => res.status),
  ).toBe(404);
  expect(await executionCount()).toBe(before);

  // The log accepts the event but the Saga parse gate fences fan-out: the
  // payload is not valid hello input, so nothing dispatches.
  const invalidInput = await emit("s2-clean", {
    eventId: "evt-clean-2",
    topic: "vendor.order.created",
    payload: { wrong: "shape" },
  });
  expect(invalidInput.status).toBe(201);
  expect(invalidInput.body.deliveries).toMatchObject([
    { subscription: "clean-sub", status: "skipped", code: "INVALID_INPUT" },
  ]);
  expect(await executionCount()).toBe(before);

  // One valid dispatch first so the cascade has a receipt to remove.
  const live = await emit("s2-clean", {
    eventId: "evt-clean-3",
    topic: "vendor.order.created",
    payload: { name: "Ada" },
  });
  expect(live.status).toBe(201);
  await trackAll((live.body.deliveries ?? []).map((entry) => entry.executionId));

  // Deleting the source cascades to subscriptions and receipts while
  // dispatched Executions keep their history rows.
  await worker.fetch(authed("/api/event-sources/s2-clean", "DELETE"), bindings);
  expect(
    await worker
      .fetch(authed("/api/event-sources/s2-clean/subscriptions/clean-sub", "GET"), bindings)
      .then((r) => r.status),
  ).toBe(404);
  const scopedSubs = await bindings.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_subscriptions WHERE org_id=? AND name=?",
  )
    .bind(ORG, "clean-sub")
    .first<{ n: number }>();
  expect(scopedSubs?.n).toBe(0);
  const scopedReceipts = await bindings.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_deliveries WHERE org_id=? AND event_id=?",
  )
    .bind(ORG, "evt-clean-3")
    .first<{ n: number }>();
  expect(scopedReceipts?.n).toBe(0);
  expect(await executionCount()).toBe(before + 1);
}, 25000);
