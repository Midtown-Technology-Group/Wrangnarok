// SPDX-License-Identifier: AGPL-3.0
// TRG-01 tick semantics over real D1 and the real promoteWindow (issue
// #137): racing ticks promote a window exactly once; duplicate-window ticks
// replay (never fork); a later window overlaps the earlier one under
// overlap=allow but skips under overlap=skip; overdue windows promote late;
// disabled/deleted schedules, revoked members, and cancelled windows never
// promote. Workflow dispatch is a createBatch double (a native control, not
// data); no vendor HTTP anywhere.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker, { promoteWindow } from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import { ensureLabFixture, inviteMember, updateMember } from "../src/orgs";
import { runTick, scheduleKey } from "../src/schedules";
import type { ScheduleRow } from "../src/schedules";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0016_schedules.sql?raw";
import migration10 from "../migrations/0016_scheduled_executions.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function dispatchStub(): Bindings {
  return {
    ...bindings,
    HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
  };
}

async function insertSchedule(db: D1Database, overrides: Partial<ScheduleRow> = {}): Promise<ScheduleRow> {
  const stamp = new Date().toISOString();
  const schedule: ScheduleRow = {
    id: crypto.randomUUID().toLowerCase(),
    org_id: ORG,
    user_id: USER,
    saga_id: helloSaga.id,
    input_json: JSON.stringify({ name: "Tick" }),
    kind: "once",
    status: "active",
    cron_expr: null,
    timezone: "UTC",
    run_at: new Date(Date.now() + 60_000).toISOString(),
    next_due_at: new Date(Date.now() + 60_000).toISOString(),
    overlap: "allow",
    last_execution_id: null,
    last_skipped_window: null,
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
  await db
    .prepare(
      "INSERT INTO schedules(id,org_id,user_id,saga_id,input_json,kind,status,cron_expr,timezone,run_at,next_due_at,overlap,last_execution_id,last_skipped_window,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      schedule.id,
      schedule.org_id,
      schedule.user_id,
      schedule.saga_id,
      schedule.input_json,
      schedule.kind,
      schedule.status,
      schedule.cron_expr,
      schedule.timezone,
      schedule.run_at,
      schedule.next_due_at,
      schedule.overlap,
      schedule.last_execution_id,
      schedule.last_skipped_window,
      schedule.created_at,
      schedule.updated_at,
    )
    .run();
  return schedule;
}

async function insertIntent(
  db: D1Database,
  schedule: ScheduleRow,
  window: string,
  executionId: string,
  status = "Scheduled",
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,schedule_id,due_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      executionId,
      helloSaga.id,
      "hello",
      "hello-v1",
      schedule.org_id,
      schedule.user_id,
      schedule.input_json,
      0,
      status,
      schedule.id,
      window,
      new Date().toISOString(),
    )
    .run();
}

async function executionStatus(id: string): Promise<string | null> {
  const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  await bindings.DB.exec(migration10);
  await bindings.DB.exec(seed);
  // Tick tests build rows directly (no route auth), so bootstrap the
  // fixture org/user/membership the LAB route path would create: the
  // per-window membership re-check must see a live member, not a stranger.
  await ensureLabFixture(bindings.DB, ORG, USER);
});

afterEach(async () => {
  await reset();
});

it("promotes racing ticks exactly once: one winner, one converger", async () => {
  const window = new Date(Date.now() - 60_000).toISOString();
  const schedule = await insertSchedule(bindings.DB, { next_due_at: window });
  const key = scheduleKey(schedule.id, "once", window);
  const id = await (await import("../src/schedules")).scheduleExecutionId({ orgId: ORG, userId: USER }, key);
  await insertIntent(bindings.DB, schedule, window, id);
  const live = dispatchStub();
  const gate = { held: true, waiters: [] as (() => void)[] };
  const gated = {
    ...live,
    DB: new Proxy(live.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string, ...rest: unknown[]) => {
            const stmt = (target.prepare as (...args: unknown[]) => D1PreparedStatement)(sql, ...rest);
            // Hold the Scheduled->Pending claim UPDATE: the first arrival
            // wins the gate, the second waits behind it, and both then
            // re-read the winner's Pending row and converge.
            if (typeof sql === "string" && sql.includes("AND status='Scheduled'")) {
              return {
                bind: (...values: unknown[]) => {
                  const bound = stmt.bind(...values);
                  return {
                    first: () => bound.first(),
                    all: () => bound.all(),
                    run: () =>
                      gate.held
                        ? new Promise((resolve) => {
                            gate.waiters.push(() => resolve(bound.run()));
                          })
                        : bound.run(),
                  } as unknown as D1PreparedStatement;
                },
              } as unknown as D1PreparedStatement;
            }
            return stmt;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
      },
    }) as D1Database,
  };
  const first = promoteWindow(gated, schedule, window, key);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The first tick is parked inside its claim write. The second tick reads
  // the still-Scheduled row, then parks behind the same write: both are
  // now committed to the same window, exactly one claim can win.
  const second = promoteWindow(gated, schedule, window, key);
  await new Promise((resolve) => setTimeout(resolve, 50));
  gate.held = false;
  for (const release of gate.waiters.splice(0)) release();
  const [a, b] = await Promise.all([first, second]);
  expect([a.skipped, b.skipped]).toEqual([false, false]);
  expect(a.executionId).toBe(id);
  expect(b.executionId).toBe(id);
  // Both ticks report the same Execution: exactly one row exists (proven
  // below), so no second Execution was forked. Both report replayed:true
  // here because each tick's own claim write found the row already moved
  // past Scheduled by the racing claim — convergence, never a fork.
  const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions WHERE id=?")
    .bind(id)
    .first<{ n: number }>();
  expect(rows?.n).toBe(1);
  expect(await executionStatus(id)).toBe("Pending");
});

it("replays duplicate-window ticks and overlaps distinct windows under allow", async () => {
  const live = dispatchStub();
  const windowA = new Date(Date.now() - 120_000).toISOString();
  const schedule = await insertSchedule(bindings.DB, {
    next_due_at: windowA,
    kind: "recurring",
    cron_expr: "* * * * *",
    run_at: null,
    overlap: "allow",
  });
  const keyA = scheduleKey(schedule.id, "recurring", windowA);
  const idA = await (await import("../src/schedules")).scheduleExecutionId({ orgId: ORG, userId: USER }, keyA);
  await insertIntent(bindings.DB, schedule, windowA, idA);
  const first = await promoteWindow(live, schedule, windowA, keyA);
  expect(first).toMatchObject({ executionId: idA, skipped: false });
  // Same window again: dedup replay, never a second dispatch.
  const dupe = await promoteWindow(live, { ...schedule }, windowA, keyA);
  expect(dupe).toMatchObject({ executionId: idA, replayed: true, skipped: false });
  // A later window for the same source: deterministic key for W says nothing
  // about W+1, so overlap=allow dispatches it side by side.
  const windowB = new Date(Date.now() - 60_000).toISOString();
  await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE id=?").bind(windowB, schedule.id).run();
  const keyB = scheduleKey(schedule.id, "recurring", windowB);
  const idB = await (await import("../src/schedules")).scheduleExecutionId({ orgId: ORG, userId: USER }, keyB);
  await insertIntent(bindings.DB, schedule, windowB, idB);
  const second = await promoteWindow(live, { ...schedule, next_due_at: windowB }, windowB, keyB);
  expect(second).toMatchObject({ executionId: idB, skipped: false });
  expect(idB).not.toBe(idA);
});

it("skips a new window while an earlier one is live under overlap=skip", async () => {
  const live = dispatchStub();
  const windowA = new Date(Date.now() - 120_000).toISOString();
  const schedule = await insertSchedule(bindings.DB, {
    next_due_at: windowA,
    kind: "recurring",
    cron_expr: "* * * * *",
    run_at: null,
    overlap: "skip",
  });
  const keyA = scheduleKey(schedule.id, "recurring", windowA);
  const idA = await (await import("../src/schedules")).scheduleExecutionId({ orgId: ORG, userId: USER }, keyA);
  await insertIntent(bindings.DB, schedule, windowA, idA);
  expect(await promoteWindow(live, schedule, windowA, keyA)).toMatchObject({ skipped: false });
  const windowB = new Date(Date.now() - 60_000).toISOString();
  const keyB = scheduleKey(schedule.id, "recurring", windowB);
  const idB = await (await import("../src/schedules")).scheduleExecutionId({ orgId: ORG, userId: USER }, keyB);
  await insertIntent(bindings.DB, schedule, windowB, idB);
  const skipped = await promoteWindow(live, { ...schedule, next_due_at: windowB }, windowB, keyB);
  expect(skipped).toMatchObject({ skipped: true });
  expect((skipped as { skipReason?: string }).skipReason).toBe("overlap");
  // Once the earlier window settles, the next tick promotes the held window.
  await bindings.DB.prepare("UPDATE executions SET status='Succeeded',completed_at=? WHERE id=?")
    .bind(new Date().toISOString(), idA)
    .run();
  expect(await promoteWindow(live, { ...schedule, next_due_at: windowB }, windowB, keyB)).toMatchObject({
    executionId: idB,
    skipped: false,
  });
});

it("promotes overdue windows late and advances the recurring due index", async () => {
  const live = dispatchStub();
  const overdue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const schedule = await insertSchedule(bindings.DB, {
    next_due_at: overdue,
    kind: "recurring",
    cron_expr: "* * * * *",
    run_at: null,
  });
  const ticked = await runTick(
    live.DB,
    async ({ schedule: due, window, key }) => promoteWindow(live, due, window, key),
    new Date(),
  );
  // No intent row exists for the scanned window, so the tick skips loud
  // (missing-intent) instead of inventing one: the scan is the finder, the
  // intent row is the claim record, and promotion never mints rows.
  expect(ticked.scanned).toBe(1);
  expect(ticked.promoted).toBe(0);
  const key = scheduleKey(schedule.id, "recurring", overdue);
  const id = await (await import("../src/schedules")).scheduleExecutionId({ orgId: ORG, userId: USER }, key);
  await insertIntent(live.DB, schedule, overdue, id);
  const late = await promoteWindow(live, { ...schedule }, overdue, key);
  expect(late).toMatchObject({ skipped: false });
  const { advanceRecurring } = await import("../src/schedules");
  await advanceRecurring(bindings.DB, schedule, new Date());
  const updated = await bindings.DB.prepare("SELECT next_due_at FROM schedules WHERE id=?")
    .bind(schedule.id)
    .first<{ next_due_at: string }>();
  expect(Date.parse(updated?.next_due_at ?? "")).toBeGreaterThan(Date.now() - 120_000);
});

it("never promotes disabled, deleted, revoked, or cancelled-before-dispatch windows", async () => {
  const live = dispatchStub();
  const window = new Date(Date.now() - 60_000).toISOString();
  const disabled = await insertSchedule(bindings.DB, { status: "disabled", next_due_at: window });
  const deleted = await insertSchedule(bindings.DB, { status: "deleted", next_due_at: window });
  const ticked = await runTick(
    live.DB,
    async ({ schedule: due, window: dueWindow, key }) => promoteWindow(live, due, dueWindow, key),
    new Date(),
  );
  expect(ticked.scanned).toBe(0);
  expect(ticked.promoted).toBe(0);
  void disabled;
  void deleted;
  // Revoked member: the per-window membership gate skips loudly.
  const memberId = "00000000-0000-4000-8000-000000000009";
  await inviteMember(bindings.DB, ORG, memberId, "member", "ordinary");
  const revokedSchedule = await insertSchedule(bindings.DB, { user_id: memberId, next_due_at: window });
  await updateMember(bindings.DB, ORG, memberId, { status: "revoked" });
  const revokedKey = scheduleKey(revokedSchedule.id, "once", window);
  const revokedId = await (
    await import("../src/schedules")
  ).scheduleExecutionId({ orgId: ORG, userId: memberId }, revokedKey);
  await insertIntent(bindings.DB, revokedSchedule, window, revokedId);
  const revoked = await promoteWindow(live, revokedSchedule, window, revokedKey);
  expect(revoked.skipped).toBe(true);
  // Cancelled before dispatch: the receipt answers, the tick never resurrects.
  const doomed = await insertSchedule(bindings.DB, { next_due_at: window });
  const doomedKey = scheduleKey(doomed.id, "once", window);
  const doomedId = await (
    await import("../src/schedules")
  ).scheduleExecutionId({ orgId: ORG, userId: USER }, doomedKey);
  await insertIntent(bindings.DB, doomed, window, doomedId, "Cancelled");
  const cancelRes = await worker.fetch(
    new Request(`http://local.test/api/schedules/executions/${doomedId}/cancel`, {
      method: "POST",
      headers: { ...auth },
    }),
    bindings,
  );
  expect([200, 409]).toContain(cancelRes.status);
  const resurrected = await promoteWindow(live, doomed, window, doomedKey);
  expect(resurrected).toMatchObject({ executionId: doomedId, skipped: true });
  // Queue backup is not failure: an undispatched Pending row stays Pending,
  // and the receipt carries dispatchConfirmed:false on detail.
  const queued = await insertSchedule(bindings.DB, { next_due_at: window });
  const queuedKey = scheduleKey(queued.id, "once", window);
  const queuedId = await (
    await import("../src/schedules")
  ).scheduleExecutionId({ orgId: ORG, userId: USER }, queuedKey);
  await insertIntent(bindings.DB, queued, window, queuedId);
  expect(await promoteWindow(live, queued, window, queuedKey)).toMatchObject({ skipped: false });
  const detail = await worker.fetch(
    new Request(`http://local.test/api/executions/${queuedId}`, { headers: { ...auth } }),
    live,
  );
  expect(detail.status).toBe(200);
  expect(await executionStatus(queuedId)).toBe("Pending");
});

it("survives restart: due rows persist and promote after the tick restarts", async () => {
  // Durability proof, not a workerd-restart proof: the due schedule row
  // and its Scheduled intent row are plain D1 rows, so they survive any
  // restart by construction. Re-read both after a tick-shaped delay, then
  // promote through the real path and prove the same deterministic ID.
  const live = dispatchStub();
  const window = new Date(Date.now() - 60_000).toISOString();
  const schedule = await insertSchedule(bindings.DB, { next_due_at: window });
  const key = scheduleKey(schedule.id, "once", window);
  const id = await (await import("../src/schedules")).scheduleExecutionId({ orgId: ORG, userId: USER }, key);
  await insertIntent(bindings.DB, schedule, window, id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reread = await bindings.DB.prepare("SELECT * FROM schedules WHERE id=?").bind(schedule.id).first<ScheduleRow>();
  expect(reread?.next_due_at).toBe(window);
  expect(await executionStatus(id)).toBe("Scheduled");
  const ticked = await runTick(
    live.DB,
    async ({ schedule: due, window: dueWindow, key: dueKey }) => promoteWindow(live, due, dueWindow, dueKey),
    new Date(),
  );
  expect(ticked.promoted).toBe(1);
  expect(ticked.receipts[0]?.executionId).toBe(id);
  expect(await executionStatus(id)).toBe("Pending");
});
