// SPDX-License-Identifier: AGPL-3.0
// TRG-01 tick (issue #137, ADR 012): the exported scheduled handler promotes
// due rows with bounded scan/admission costs. One-off rows promote once then
// disable themselves; racing ticks converge on one Execution per window.
// Real workerd with real D1/Workflow bindings; hello Saga needs no vendor.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration12 from "../migrations/0012_saga_policies.sql?raw";
import migration16 from "../migrations/0016_schedules.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration12);
  await bindings.DB.exec(migration16);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  await reset();
});

describe("TRG-01 scheduled tick (workerd)", () => {
  it("promotes a due one-off exactly once, then disables the row", async () => {
    const runAt = new Date(Date.now() - 30_000).toISOString();
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "tick-once",
            sagaId: helloSaga.id,
            kind: "one-off",
            runAt,
            input: { name: "sched" },
          }),
          bindings,
        )
      ).status,
    ).toBe(201);
    const tick = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
    await tick.scheduled({ cron: "* * * * *" }, bindings);
    const detail = (await (await worker.fetch(authed("/api/schedules/tick-once", "GET"), bindings)).json()) as {
      schedule: { enabled: boolean; lastWindow: string | null };
    };
    expect(detail.schedule.enabled).toBe(false);
    expect(detail.schedule.lastWindow).toMatch(/^once-/);
    const deliveries = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id=(SELECT id FROM schedules WHERE org_id=? AND name=?)",
    )
      .bind("00000000-0000-4000-8000-000000000001", "tick-once")
      .first<{ n: number }>();
    expect(deliveries?.n).toBe(1);
    // A second tick promotes nothing further for the spent row.
    await tick.scheduled({ cron: "* * * * *" }, bindings);
    const again = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id=(SELECT id FROM schedules WHERE org_id=? AND name=?)",
    )
      .bind("00000000-0000-4000-8000-000000000001", "tick-once")
      .first<{ n: number }>();
    expect(again?.n).toBe(1);
  }, 25000);
  it("advances recurring rows past the promoted window without fanning out catch-up", async () => {
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "tick-recur",
            sagaId: helloSaga.id,
            kind: "recurring",
            cron: "* * * * *",
            input: { name: "sched" },
          }),
          bindings,
        )
      ).status,
    ).toBe(201);
    const past = new Date(Date.now() - 5 * 60_000).toISOString();
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
      .bind(past, "00000000-0000-4000-8000-000000000001", "tick-recur")
      .run();
    const before = (await (await worker.fetch(authed("/api/schedules/tick-recur", "GET"), bindings)).json()) as {
      schedule: { nextDueAt: string };
    };
    const tick = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
    await tick.scheduled({ cron: "* * * * *" }, bindings);
    const after = (await (await worker.fetch(authed("/api/schedules/tick-recur", "GET"), bindings)).json()) as {
      schedule: { nextDueAt: string; lastWindow: string | null; enabled: boolean };
    };
    // One promotion per tick: the row stays enabled and advances past the
    // promoted window instead of emitting five catch-up Executions.
    expect(after.schedule.enabled).toBe(true);
    expect(Date.parse(after.schedule.nextDueAt)).toBeGreaterThan(Date.parse(before.schedule.nextDueAt));
    expect(after.schedule.lastWindow).not.toBeNull();
    const deliveries = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id=(SELECT id FROM schedules WHERE org_id=? AND name=?)",
    )
      .bind("00000000-0000-4000-8000-000000000001", "tick-recur")
      .first<{ n: number }>();
    expect(deliveries?.n).toBe(1);
  }, 25000);
});

describe("codex #364: per-org fairness and skip quarantine (workerd)", () => {
  it("admits another org's due row despite a larger older backlog (#364 reopen)", async () => {
    const tick = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
    const ORG_A = "00000000-0000-4000-8000-000000000001";
    const ORG_B = "00000000-0000-4000-8000-000000000002";
    const USER = "00000000-0000-4000-8000-000000000002";
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind(ORG_B, "Second")
      .run();
    // Promotion revalidates run-as authority: the fixture user needs an
    // active user row plus active membership in both orgs. (The API path
    // bootstraps this; direct inserts must declare it explicitly.)
    await bindings.DB.prepare(
      "INSERT INTO users(user_id,status,created_at) VALUES (?, 'active', ?) ON CONFLICT(user_id) DO NOTHING",
    )
      .bind(USER, new Date().toISOString())
      .run();
    for (const org of [ORG_A, ORG_B]) {
      await bindings.DB.prepare(
        "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'admin','active','ordinary',?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET status='active'",
      )
        .bind(org, USER, new Date().toISOString(), new Date().toISOString())
        .run();
    }
    // Org A: SCHEDULE_TICK_LIMIT + 5 due rows, all older than Org B's row.
    // Direct inserts (same shape the create route writes): this test pins
    // selection fairness, not the membership-gated create path.
    const ancient = new Date(Date.now() - 3_600_000).toISOString();
    const now = new Date().toISOString();
    for (let n = 0; n < 55; n += 1) {
      await bindings.DB.prepare(
        "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,run_at,next_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          `00000000-0000-4000-8000-000001${String(n).padStart(6, "0")}`,
          ORG_A,
          `backlog-${n}`,
          helloSaga.id,
          "one-off",
          "",
          "UTC",
          1,
          '{"name":"sched"}',
          "00000000-0000-4000-8000-000000000002",
          ancient,
          ancient,
          now,
          now,
        )
        .run();
    }
    const recent = new Date(Date.now() - 30_000).toISOString();
    await bindings.DB.prepare(
      "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,run_at,next_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000002000000",
        ORG_B,
        "second-org-due",
        helloSaga.id,
        "one-off",
        "",
        "UTC",
        1,
        '{"name":"sched"}',
        "00000000-0000-4000-8000-000000000002",
        recent,
        recent,
        now,
        now,
      )
      .run();
    await tick.scheduled({ cron: "* * * * *" }, bindings);
    // Org B's single eligible row promotes in the same tick despite Org A's
    // 55 older rows exceeding the old global LIMIT of 50.
    const promotedB = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id IN (SELECT id FROM schedules WHERE org_id=? AND name=?)",
    )
      .bind(ORG_B, "second-org-due")
      .first<{ n: number }>();
    expect(promotedB?.n).toBe(1);
  }, 60000);
  it("rotates admission so an 11th backlogged org is eventually processed (#399 review)", async () => {
    const { promoteDueSchedules } = await import("../src/schedules");
    const { submit } = await import("../src/executions");
    const { SAGA_DEFINITIONS } = await import("../src/sagas");
    const USER = "00000000-0000-4000-8000-000000000002";
    const now = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO users(user_id,status,created_at) VALUES (?, 'active', ?) ON CONFLICT(user_id) DO NOTHING",
    )
      .bind(USER, now)
      .run();
    // 11 orgs with REPLENISHED backlog: before every tick each org is
    // topped back up to 6 due rows, so no org ever drains on its own.
    // Each org's rows share a DISTINCT timestamp, ranked oldest (org 0) to
    // newest (org 10): ties would let SQLite's sorter smuggle the victim
    // into the old global LIMIT by accident, so strict ranking makes the
    // reproduction deterministic. (Recurring rows re-arm, but promotion
    // still consumes the due set faster than re-arming refills it; without
    // replenishment even the old global scan drains its way to the 11th
    // org and proves nothing.) Under the old global LIMIT-50 scan the
    // 11th (newest) org never enters the batch; with rotation it must see
    // a delivery within 12 ticks.
    const orgIds: string[] = [];
    const orgDueAt: string[] = [];
    let seq = 0;
    const topUp = async (orgId: string, orgIndex: number) => {
      const dueAt = orgDueAt[orgIndex] as string;
      const have = await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM schedules WHERE org_id=? AND enabled=1 AND next_due_at IS NOT NULL AND next_due_at<=?",
      )
        .bind(orgId, dueAt)
        .first<{ n: number }>();
      for (let n = have?.n ?? 0; n < 6; n += 1) {
        seq += 1;
        await bindings.DB.prepare(
          "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,run_at,next_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            `00000000-0000-4000-8000-000003${String(orgIndex).padStart(2, "0")}${String(seq).padStart(6, "0")}`,
            orgId,
            `rot-${orgIndex}-${seq}`,
            helloSaga.id,
            "recurring",
            "* * * * *",
            "UTC",
            1,
            '{"name":"sched"}',
            USER,
            null,
            dueAt,
            now,
            now,
          )
          .run();
      }
    };
    for (let o = 0; o < 11; o += 1) {
      const orgId = `00000000-0000-4000-8000-00000100000${o}`;
      orgIds.push(orgId);
      // Strict age rank: org 0 oldest, org 10 newest, one minute apart.
      orgDueAt.push(new Date(Date.now() - 3_600_000 + o * 60_000).toISOString());
      await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
        .bind(orgId, `rot-${o}`)
        .run();
      await bindings.DB.prepare(
        "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'admin','active','ordinary',?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET status='active'",
      )
        .bind(orgId, USER, now, now)
        .run();
      await topUp(orgId, o);
    }
    const last = orgIds[10] as string;
    // Drive 12 ticks with an advancing clock: rotation derives its offset
    // from the tick minute, so distinct minutes admit distinct org windows.
    // (The wall-clock scheduled handler would need 12 real minutes.)
    // Replenish before every tick so backlog never drains on its own.
    const baseMinute = Math.floor(Date.now() / 60_000);
    for (let t = 0; t < 12; t += 1) {
      for (let o = 0; o < 11; o += 1) await topUp(orgIds[o] as string, o);
      await promoteDueSchedules(
        bindings.DB,
        { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        submit,
        new Date((baseMinute + t) * 60_000),
      );
    }
    const promotedLast = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id IN (SELECT id FROM schedules WHERE org_id=?)",
    )
      .bind(last)
      .first<{ n: number }>();
    expect(promotedLast?.n).toBeGreaterThan(0);
    // Degraded-runner headroom (PR #516): ~13s locally, timed out at 120s on
    // a ~3x-slowed shared runner. Same stall mechanism as the workers default.
  }, 180000);
  it("admits a full window every tick with one omission per org per cycle (#364 wraparound)", async () => {
    const { promoteDueSchedules } = await import("../src/schedules");
    const { submit } = await import("../src/executions");
    const { SAGA_DEFINITIONS } = await import("../src/sagas");
    const USER = "00000000-0000-4000-8000-000000000002";
    const now = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO users(user_id,status,created_at) VALUES (?, 'active', ?) ON CONFLICT(user_id) DO NOTHING",
    )
      .bind(USER, now)
      .run();
    // 11 orgs, one promotable row each, all due at the same instant. Over
    // 11 minute ticks the rotation window must admit a FULL 10-org window
    // every tick (wraparound: no truncated tail), and every org must be
    // admitted exactly 10 times (one omission each) — not 1..10 times by
    // lexical position. Single rows drain on promotion, so top up before
    // every tick to keep all 11 due throughout the cycle.
    const orgIds: string[] = [];
    let seq = 0;
    const topUp = async (orgId: string, orgIndex: number) => {
      const have = await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM schedules WHERE org_id=? AND enabled=1 AND next_due_at IS NOT NULL",
      )
        .bind(orgId)
        .first<{ n: number }>();
      if ((have?.n ?? 0) > 0) return;
      seq += 1;
      await bindings.DB.prepare(
        "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,run_at,next_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          `00000000-0000-4000-8000-000004${String(orgIndex).padStart(2, "0")}${String(seq).padStart(6, "0")}`,
          orgId,
          `wrap-${orgIndex}-${seq}`,
          helloSaga.id,
          "one-off",
          "",
          "UTC",
          1,
          '{"name":"sched"}',
          USER,
          null,
          new Date(Date.now() - 3_600_000).toISOString(),
          now,
          now,
        )
        .run();
    };
    for (let o = 0; o < 11; o += 1) {
      const orgId = `00000000-0000-4000-8000-00000300000${o}`;
      orgIds.push(orgId);
      await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
        .bind(orgId, `wrap-${o}`)
        .run();
      await bindings.DB.prepare(
        "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'admin','active','ordinary',?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET status='active'",
      )
        .bind(orgId, USER, now, now)
        .run();
      await topUp(orgId, o);
    }
    const admissions = new Map<string, number>();
    const baseMinute = Math.floor(Date.now() / 60_000);
    for (let t = 0; t < 11; t += 1) {
      for (let o = 0; o < 11; o += 1) await topUp(orgIds[o] as string, o);
      const before = await bindings.DB.prepare(
        "SELECT org_id AS orgId, COUNT(*) AS n FROM schedule_deliveries d JOIN schedules s ON s.id=d.schedule_id GROUP BY org_id",
      ).all<{ orgId: string; n: number }>();
      const beforeMap = new Map(before.results.map((row) => [row.orgId, row.n]));
      await promoteDueSchedules(
        bindings.DB,
        { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        submit,
        new Date((baseMinute + t) * 60_000),
      );
      const after = await bindings.DB.prepare(
        "SELECT org_id AS orgId, COUNT(*) AS n FROM schedule_deliveries d JOIN schedules s ON s.id=d.schedule_id GROUP BY org_id",
      ).all<{ orgId: string; n: number }>();
      // A full window admits exactly 10 orgs per tick: every tick must show
      // deliveries for exactly 10 distinct orgs (one omission).
      const tickOrgs = after.results.filter((row) => (row.n ?? 0) > (beforeMap.get(row.orgId) ?? 0));
      expect(tickOrgs).toHaveLength(10);
      for (const row of tickOrgs) admissions.set(row.orgId, (admissions.get(row.orgId) ?? 0) + 1);
    }
    // Uniform omission: every org admitted exactly 10 of 11 ticks.
    expect([...admissions.keys()].sort()).toEqual([...orgIds].sort());
    for (const orgId of orgIds) expect(admissions.get(orgId)).toBe(10);
    // Degraded-runner headroom (PR #516): same stall mechanism as above.
  }, 180000);
  it("caps one org's promotions per tick so other orgs still promote", async () => {
    const tick = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
    // Seed six due one-off rows via the API (membership-gated create keeps
    // the run-as authority live), then force them overdue.
    const old = new Date(Date.now() - 60_000).toISOString();
    for (let n = 0; n < 6; n += 1) {
      const created = await worker.fetch(
        authed("/api/schedules", "POST", {
          name: `fair-a-${n}`,
          sagaId: helloSaga.id,
          kind: "one-off",
          runAt: new Date(Date.now() - 30_000).toISOString(),
          input: { name: "sched" },
        }),
        bindings,
      );
      expect(created.status).toBe(201);
    }
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name LIKE 'fair-a-%'")
      .bind(old, "00000000-0000-4000-8000-000000000001")
      .run();
    await tick.scheduled({ cron: "* * * * *" }, bindings);
    const promoted = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id IN (SELECT id FROM schedules WHERE org_id=? AND name LIKE 'fair-a-%')",
    )
      .bind("00000000-0000-4000-8000-000000000001")
      .first<{ n: number }>();
    // Per-org cap holds: at most 5 of the 6 promote on one tick.
    expect(promoted?.n).toBeLessThanOrEqual(5);
    expect(promoted?.n).toBeGreaterThanOrEqual(1);
  }, 25000);

  it("quarantines persistently paused rows out of the head-of-line", async () => {
    const tick = worker as unknown as { scheduled: (event: unknown, env: Bindings) => Promise<void> };
    // Pause the saga directly: every tick now skips with SAGA_PAUSED
    // (persistent, not a transient race). Direct store (same helper the
    // policy route uses) avoids the route's admin-grant surface.
    const { storeSagaPolicy } = await import("../src/executions");
    await storeSagaPolicy(bindings.DB, "00000000-0000-4000-8000-000000000001", helloSaga.id, {
      admission: { enabled: false },
    });
    const created = await worker.fetch(
      authed("/api/schedules", "POST", {
        name: "quarantine-me",
        sagaId: helloSaga.id,
        kind: "one-off",
        runAt: new Date(Date.now() - 30_000).toISOString(),
        input: { name: "sched" },
      }),
      bindings,
    );
    expect(created.status).toBe(201);
    const old = new Date(Date.now() - 60_000).toISOString();
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
      .bind(old, "00000000-0000-4000-8000-000000000001", "quarantine-me")
      .run();
    for (let n = 0; n < 10; n += 1) {
      await tick.scheduled({ cron: "* * * * *" }, bindings);
    }
    const row = await bindings.DB.prepare("SELECT enabled,last_window FROM schedules WHERE org_id=? AND name=?")
      .bind("00000000-0000-4000-8000-000000000001", "quarantine-me")
      .first<{ enabled: number; last_window: string | null }>();
    // Ten consecutive persistent skips park the row: disabled, out of the scan.
    expect(row?.enabled).toBe(0);
    expect(row?.last_window).toBe("quarantined");
    await bindings.DB.prepare("DELETE FROM saga_policies WHERE org_id=? AND saga_id=?")
      .bind("00000000-0000-4000-8000-000000000001", helloSaga.id)
      .run();
    // Operator re-enables: the next tick promotes the row and clears the
    // quarantine streak (covers the streak-clear arm).
    await bindings.DB.prepare("UPDATE schedules SET enabled=1,last_window=? WHERE org_id=? AND name=?")
      .bind("quarantine:10", "00000000-0000-4000-8000-000000000001", "quarantine-me")
      .run();
    await tick.scheduled({ cron: "* * * * *" }, bindings);
    const revived = await bindings.DB.prepare("SELECT enabled,last_window FROM schedules WHERE org_id=? AND name=?")
      .bind("00000000-0000-4000-8000-000000000001", "quarantine-me")
      .first<{ enabled: number; last_window: string | null }>();
    expect(revived?.last_window ?? "").not.toMatch(/^quarantine:/);
  }, 60000);
});
