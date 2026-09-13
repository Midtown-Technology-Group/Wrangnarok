// SPDX-License-Identifier: AGPL-3.0
// TRG-01 lifecycle (issue #137, ADR 012): duplicate-window dedup is separate
// from cross-window overlap, overdue promotion, disabled/deleted schedules,
// revocation, and cancellation before dispatch. A Pending queue backup must
// never be mistaken for failed execution. Real workerd with real D1/Workflow
// bindings; hello Saga needs no vendor fetch.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga, parseHelloInput } from "../src/domain";
import { promoteDueSchedules, scheduleWindowKey } from "../src/schedules";
import { submit } from "../src/executions";
import { SAGA_DEFINITIONS } from "../src/sagas";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration12 from "../migrations/0012_saga_policies.sql?raw";
import migration16 from "../migrations/0016_schedules.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN = "a".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`http://local.test${path}`, {
    method,
    headers: { ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createRecurring(name: string): Promise<void> {
  const created = await worker.fetch(
    authed("/api/schedules", "POST", {
      name,
      sagaId: helloSaga.id,
      kind: "recurring",
      cron: "* * * * *",
      input: { name: "sched" },
    }),
    bindings,
  );
  expect(created.status).toBe(201);
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
  vi.restoreAllMocks();
  await reset();
});

describe("TRG-01 promotion semantics (workerd)", () => {
  it("replays the same window while live and dispatches the next window independently", async () => {
    await createRecurring("overlap-probe");
    const row = await bindings.DB.prepare("SELECT id FROM schedules WHERE org_id=? AND name=?")
      .bind(principal.orgId, "overlap-probe")
      .first<{ id: string }>();
    expect(row?.id).toBeDefined();
    // Direct same-window promotion converges on one Execution identity.
    const key = await scheduleWindowKey(row?.id ?? "", "2026-09-12T10:01");
    const firstId = await executionId(principal, key);
    await using firstInstance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, firstId);
    const firstSubmit = await submit(
      { ...bindings } as never,
      principal,
      key,
      { ...helloSaga, parse: parseHelloInput },
      { name: "sched" },
    );
    expect(firstSubmit.executionId).toBe(firstId);
    expect(firstSubmit.replayed).toBe(false);
    await firstInstance.waitForStatus("complete");
    const replay = await submit(
      { ...bindings } as never,
      principal,
      key,
      { ...helloSaga, parse: parseHelloInput },
      { name: "sched" },
    );
    expect(replay).toMatchObject({ executionId: firstId, replayed: true });
    // A later window is a new key and dispatches independently.
    const nextKey = await scheduleWindowKey(row?.id ?? "", "2026-09-12T10:02");
    const next = await submit(
      { ...bindings } as never,
      principal,
      nextKey,
      { ...helloSaga, parse: parseHelloInput },
      { name: "sched" },
    );
    expect(next.executionId).not.toBe(firstId);
    expect(next.replayed).toBe(false);
  }, 25000);
  it("promotes overdue rows and never mistakes Pending backlog for failure", async () => {
    await createRecurring("overdue-probe");
    // Force the row overdue: next_due_at an hour in the past.
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
      .bind(past, principal.orgId, "overdue-probe")
      .run();
    const report = await promoteDueSchedules(
      bindings.DB,
      { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
      SAGA_DEFINITIONS,
      submit,
      new Date(),
    );
    expect(report.promoted.map((entry) => entry.scheduleName)).toContain("overdue-probe");
    const promoted = report.promoted.find((entry) => entry.scheduleName === "overdue-probe");
    expect(promoted?.replayed).toBe(false);
    // The promoted Execution is Pending-or-better, never Failed-by-backlog.
    const detail = (await (
      await worker.fetch(authed(`/api/executions/${promoted?.executionId}`, "GET"), bindings)
    ).json()) as { status: string };
    expect(["Pending", "Running", "Succeeded"]).toContain(detail.status);
    // Delivery visibility records the window-to-Execution mapping.
    const deliveries = (await (
      await worker.fetch(authed(`/api/schedules/overdue-probe/deliveries?window=${promoted?.window}`, "GET"), bindings)
    ).json()) as { delivery: { executionId: string } };
    expect(deliveries.delivery.executionId).toBe(promoted?.executionId);
  }, 25000);
  it("skips ticks fenced by runtime policy or missing sagas without failing the tick", async () => {
    // A paused Saga fences promotion with SAGA_PAUSED: the tick reports a
    // skip and the next tick retries, never a tick failure.
    await createRecurring("paused-probe");
    expect(
      (
        await worker.fetch(
          authed(`/api/sagas/${helloSaga.id}/policy`, "PUT", { admission: { enabled: false } }),
          bindings,
        )
      ).status,
    ).toBe(200);
    const past = new Date(Date.now() - 60_000).toISOString();
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
      .bind(past, principal.orgId, "paused-probe")
      .run();
    const paused = await promoteDueSchedules(
      bindings.DB,
      { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
      SAGA_DEFINITIONS,
      submit,
      new Date(),
    );
    expect(paused.promoted.map((entry) => entry.scheduleName)).not.toContain("paused-probe");
    expect(paused.skipped).toContain("paused-probe");
    await worker.fetch(authed(`/api/sagas/${helloSaga.id}/policy`, "PUT", { admission: { enabled: true } }), bindings);
    // A schedule pointing at an unknown Saga skips the same way: no
    // misconfigured dispatch, no tick failure.
    await bindings.DB.prepare("UPDATE schedules SET saga_id=? WHERE org_id=? AND name=?")
      .bind("00000000-0000-4000-8000-000000000099", principal.orgId, "paused-probe")
      .run();
    const orphaned = await promoteDueSchedules(
      bindings.DB,
      { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
      SAGA_DEFINITIONS,
      submit,
      new Date(),
    );
    expect(orphaned.promoted.map((entry) => entry.scheduleName)).not.toContain("paused-probe");
    expect(orphaned.skipped).toContain("paused-probe");
  }, 25000);
  it("never promotes disabled or deleted schedules", async () => {
    await createRecurring("disabled-probe");
    await createRecurring("deleted-probe");
    await worker.fetch(authed("/api/schedules/disabled-probe/disable", "POST"), bindings);
    await worker.fetch(authed("/api/schedules/deleted-probe", "DELETE"), bindings);
    const report = await promoteDueSchedules(
      bindings.DB,
      { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
      SAGA_DEFINITIONS,
      submit,
      new Date(Date.now() + 10 * 60_000),
    );
    expect(report.promoted.map((entry) => entry.scheduleName)).not.toContain("disabled-probe");
    expect(report.promoted.map((entry) => entry.scheduleName)).not.toContain("deleted-probe");
  }, 25000);
  it("honors owner-cancel-wins: a tick never resurrects a cancelled window", async () => {
    await createRecurring("cancel-probe");
    const past = new Date(Date.now() - 60_000).toISOString();
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
      .bind(past, principal.orgId, "cancel-probe")
      .run();
    const first = await promoteDueSchedules(
      bindings.DB,
      { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
      SAGA_DEFINITIONS,
      submit,
      new Date(),
    );
    const promoted = first.promoted.find((entry) => entry.scheduleName === "cancel-probe");
    expect(promoted).toBeDefined();
    const cancelled = await worker.fetch(
      new Request(`http://local.test/api/executions/${promoted?.executionId}/cancel`, {
        method: "POST",
        headers: { ...auth },
      }),
      bindings,
    );
    expect(cancelled.status).toBe(200);
    // A racing tick for the same window reports a skip, never a resurrection.
    const second = await promoteDueSchedules(
      bindings.DB,
      { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
      SAGA_DEFINITIONS,
      submit,
      new Date(),
    );
    const sameWindow = second.promoted.filter((entry) => entry.window === promoted?.window);
    expect(sameWindow).toEqual([]);
    const detail = (await (
      await worker.fetch(authed(`/api/executions/${promoted?.executionId}`, "GET"), bindings)
    ).json()) as { status: string };
    expect(detail.status).toBe("Cancelled");
  }, 25000);
});
