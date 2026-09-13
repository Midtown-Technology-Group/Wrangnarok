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
import migration16 from "../migrations/0016_schedules.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`http://local.test${path}`, {
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
