// SPDX-License-Identifier: AGPL-3.0
// TRG-01 lifecycle (issue #137, ADR 012): duplicate-window dedup is separate
// from cross-window overlap, overdue promotion, disabled/deleted schedules,
// revocation, and cancellation before dispatch. A Pending queue backup must
// never be mistaken for failed execution. Real workerd with real D1/Workflow
// bindings; hello Saga needs no vendor fetch.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { executionId, helloSaga, parseHelloInput } from "../src/domain";
import {
  createSchedule,
  listSchedules,
  loadSchedule,
  parseScheduleBody,
  promoteDueSchedules,
  promoteWindow,
  scheduleWindowKey,
} from "../src/schedules";
import type { ScheduleRow } from "../src/schedules";
import { submit } from "../src/executions";
import { SAGA_DEFINITIONS } from "../src/sagas";
import {
  addGrant,
  assignRole,
  createRole,
  deleteRole,
  ensureRoleTables,
  resolveCurrentAuthority,
  revokeAssignment,
} from "../src/roles";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN = "a".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`https://local.test${path}`, {
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

useWorkflowHarness(bindings.DB);

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
    const { inner: firstInstance } = await trackWorkflowInstance(bindings.HELLO_WORKFLOW, firstId);
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
  it("rethrows non-fence tick errors instead of recording a skip (issue #137)", async () => {
    // The TICK_SKIP_CODES branch: a Fault outside the skip set (or a
    // non-Fault backend error from submit) must fail the tick, proving the
    // `throw error` line runs. Skips stay reserved for named fences.
    await createRecurring("throw-probe");
    const past = new Date(Date.now() - 60_000).toISOString();
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
      .bind(past, principal.orgId, "throw-probe")
      .run();
    const boom = async () => {
      throw new Error("D1 backend failure: submit path down");
    };
    await expect(
      promoteDueSchedules(
        bindings.DB,
        { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        boom as never,
        new Date(),
      ),
    ).rejects.toThrow("D1 backend failure");
  });

  it("fails the tick loud on backend faults instead of reporting nothing-due (issue #137)", async () => {
    // A D1 fault that is NOT a missing table must fail the tick, never
    // masquerade as an empty schedule set: the Cron surface reports the
    // failure instead of silently skipping every due window.
    await createRecurring("fault-probe");
    const past = new Date(Date.now() - 60_000).toISOString();
    await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
      .bind(past, principal.orgId, "fault-probe")
      .run();
    const brokenDb = {
      prepare() {
        throw new Error("D1 backend failure: connection reset");
      },
    } as unknown as D1Database;
    await expect(
      promoteDueSchedules(
        brokenDb,
        { DB: brokenDb, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        submit,
        new Date(),
      ),
    ).rejects.toThrow("D1 backend failure");
    // The same fault through loadSchedule/listSchedules must rethrow, not
    // answer absence: routes keep their 404-on-foreign contract, but a
    // backend failure is a 500, never a false unknown.
    await expect(loadSchedule(brokenDb, principal.orgId, "fault-probe")).rejects.toThrow("D1 backend failure");
    await expect(
      listSchedules(brokenDb, { orgId: principal.orgId, userId: principal.userId }, SAGA_DEFINITIONS),
    ).rejects.toThrow("D1 backend failure");
  });

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
      new Request(`https://local.test/api/executions/${promoted?.executionId}/cancel`, {
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
  it("loses a mid-tick disable race at the pre-dispatch fence with zero dispatch", async () => {
    // Regression (#137 race): the tick scan selects the row while enabled,
    // then the operator disable lands before promoteWindow runs. The stale
    // row must lose at the fence: skip, never dispatch.
    await createRecurring("race-disable-probe");
    const stale = await bindings.DB.prepare("SELECT * FROM schedules WHERE org_id=? AND name=?")
      .bind(principal.orgId, "race-disable-probe")
      .first<ScheduleRow>();
    expect(stale?.enabled).toBe(1);
    await worker.fetch(authed("/api/schedules/race-disable-probe/disable", "POST"), bindings);
    let submitCalls = 0;
    const forbiddenSubmit: typeof submit = async (...args) => {
      submitCalls += 1;
      return submit(...args);
    };
    await expect(
      promoteWindow(
        bindings.DB,
        { DB: bindings.DB } as never,
        stale as ScheduleRow,
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        forbiddenSubmit,
      ),
    ).rejects.toMatchObject({ code: "SCHEDULE_DISABLED" });
    expect(submitCalls).toBe(0);
    const deliveries = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id=?")
      .bind(stale?.id ?? "")
      .first<{ n: number }>();
    expect(deliveries?.n).toBe(0);
  }, 25000);
  it("loses a mid-tick delete race at the pre-dispatch fence with zero dispatch", async () => {
    // Same interleaving for delete: the selected row is gone before
    // promoteWindow runs, so the fence reports SCHEDULE_GONE and the
    // delivery FK never comes into play.
    await createRecurring("race-delete-probe");
    const stale = await bindings.DB.prepare("SELECT * FROM schedules WHERE org_id=? AND name=?")
      .bind(principal.orgId, "race-delete-probe")
      .first<ScheduleRow>();
    expect(stale?.id).toBeDefined();
    expect((await worker.fetch(authed("/api/schedules/race-delete-probe", "DELETE"), bindings)).status).toBe(200);
    let submitCalls = 0;
    const forbiddenSubmit: typeof submit = async (...args) => {
      submitCalls += 1;
      return submit(...args);
    };
    await expect(
      promoteWindow(
        bindings.DB,
        { DB: bindings.DB } as never,
        stale as ScheduleRow,
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        forbiddenSubmit,
      ),
    ).rejects.toMatchObject({ code: "SCHEDULE_GONE" });
    expect(submitCalls).toBe(0);
  }, 25000);
  it("dispatches zero work when the run-as membership is revoked before the tick", async () => {
    // Regression (#137 revocation): the persisted run-as owner is not
    // continuing authorization. Revoke after create; the tick must skip.
    await createRecurring("revoked-owner-probe");
    await bindings.DB.prepare("UPDATE org_memberships SET status='revoked' WHERE org_id=? AND user_id=?")
      .bind(principal.orgId, principal.userId)
      .run();
    const executionsBefore = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND user_id=?",
    )
      .bind(principal.orgId, principal.userId)
      .first<{ n: number }>();
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
        .bind(past, principal.orgId, "revoked-owner-probe")
        .run();
      let submitCalls = 0;
      const countingSubmit: typeof submit = async (...args) => {
        submitCalls += 1;
        return submit(...args);
      };
      const report = await promoteDueSchedules(
        bindings.DB,
        { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        countingSubmit,
        new Date(),
      );
      expect(submitCalls).toBe(0);
      expect(report.promoted.map((entry) => entry.scheduleName)).not.toContain("revoked-owner-probe");
      expect(report.skipped).toContain("revoked-owner-probe");
      const executions = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND user_id=?")
        .bind(principal.orgId, principal.userId)
        .first<{ n: number }>();
      expect(executions?.n).toBe(executionsBefore?.n ?? 0);
    } finally {
      // Fixture auth resurrects membership on next use, but restore here so
      // no later test can observe the revoked row.
      await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
        .bind(principal.orgId, principal.userId)
        .run();
    }
  }, 25000);
  it("dispatches zero work when the run-as user is suspended or disabled before the tick", async () => {
    await createRecurring("suspended-owner-probe");
    await createRecurring("disabled-user-probe");
    await bindings.DB.prepare("UPDATE org_memberships SET status='suspended' WHERE org_id=? AND user_id=?")
      .bind(principal.orgId, principal.userId)
      .run();
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE name IN (?,?)")
        .bind(past, "suspended-owner-probe", "disabled-user-probe")
        .run();
      // Suspend first: the suspended membership must already fence both rows.
      let submitCalls = 0;
      const countingSubmit: typeof submit = async (...args) => {
        submitCalls += 1;
        return submit(...args);
      };
      const suspended = await promoteDueSchedules(
        bindings.DB,
        { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        countingSubmit,
        new Date(),
      );
      expect(submitCalls).toBe(0);
      expect(suspended.skipped).toContain("suspended-owner-probe");
      expect(suspended.skipped).toContain("disabled-user-probe");
      // Then disable the user as well: still zero dispatch, still skips.
      await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(principal.userId).run();
      const disabled = await promoteDueSchedules(
        bindings.DB,
        { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        countingSubmit,
        new Date(),
      );
      expect(submitCalls).toBe(0);
      expect(disabled.skipped).toContain("suspended-owner-probe");
      expect(disabled.skipped).toContain("disabled-user-probe");
    } finally {
      await bindings.DB.prepare("UPDATE users SET status='active' WHERE user_id=?").bind(principal.userId).run();
      await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
        .bind(principal.orgId, principal.userId)
        .run();
    }
  }, 25000);
  it("revalidates run-as authority through the shared resolver with zero non-HTTP dispatch after revocation (AUTH-02 S3)", async () => {
    // S3 canonical-resolver regression (issue #143): the persisted run-as
    // IDs are an identity reference, never proof of current authority.
    // An ordinary (non-admin) run-as holds a saga execute grant at schedule
    // creation; after membership revocation the shared resolver fences the
    // non-HTTP tick with zero submit and zero new Execution rows, and after
    // grant revocation it fences with GRANT_REQUIRED even with live
    // lifecycle. Unknown service identities fail closed without dispatch.
    const ORDINARY = "00000000-0000-4000-8000-000000000003";
    await ensureRoleTables(bindings.DB);
    const stamp = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT(user_id) DO NOTHING",
    )
      .bind(ORDINARY, stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'member','active','ordinary',?,?) ON CONFLICT(org_id,user_id) DO NOTHING",
    )
      .bind(principal.orgId, ORDINARY, stamp, stamp)
      .run();
    await bindings.DB.prepare(
      "UPDATE org_memberships SET role='member',status='active',kind='ordinary' WHERE org_id=? AND user_id=?",
    )
      .bind(principal.orgId, ORDINARY)
      .run();
    let roleId: string | null = null;
    try {
      roleId = (await createRole(bindings.DB, principal.orgId, "s3-schedule-runners")).id;
      await addGrant(bindings.DB, principal.orgId, roleId, "saga", helloSaga.id, "execute");
      await assignRole(bindings.DB, principal.orgId, roleId, ORDINARY);
      const runAs = { orgId: principal.orgId, userId: ORDINARY };
      const check = {
        orgId: principal.orgId,
        resourceKind: "saga" as const,
        resourceId: helloSaga.id,
        action: "execute" as const,
      };
      // Live lifecycle plus grant: the shared resolver authorizes.
      const allowed = await resolveCurrentAuthority(bindings.DB, {}, runAs, check);
      expect(allowed.principal).toEqual(runAs);
      expect(allowed.isOrgAdmin).toBe(false);
      // Unknown service identities fail closed: no users row, no membership,
      // no dispatch — a persisted actor ID never manufactures authority.
      await expect(
        resolveCurrentAuthority(bindings.DB, {}, { orgId: principal.orgId, userId: "service:probe" }, check),
      ).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
      // Schedule owned by the ordinary run-as. Direct create bypasses the
      // HTTP admin gate; promotion authority is what this pins.
      const parsed = parseScheduleBody(
        {
          name: "authority-revoked-probe",
          sagaId: helloSaga.id,
          kind: "recurring",
          cron: "* * * * *",
          input: { name: "sched" },
        },
        SAGA_DEFINITIONS,
      );
      await createSchedule(bindings.DB, runAs, parsed, SAGA_DEFINITIONS);
      const tickEnv = { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never;
      let ordinarySubmits = 0;
      const countingSubmit: typeof submit = async (...args) => {
        if (args[1].userId === ORDINARY) ordinarySubmits += 1;
        return submit(...args);
      };
      // Ancient due instants sort first in the oldest-first per-org scan, so
      // this probe is admitted even beside older leftover rows.
      await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
        .bind(new Date(Date.now() - 3_600_000).toISOString(), principal.orgId, "authority-revoked-probe")
        .run();
      const first = await promoteDueSchedules(bindings.DB, tickEnv, SAGA_DEFINITIONS, countingSubmit, new Date());
      expect(first.promoted.map((entry) => entry.scheduleName)).toContain("authority-revoked-probe");
      expect(ordinarySubmits).toBe(1);
      // Revoke AFTER creation, BEFORE the next non-HTTP promotion.
      await bindings.DB.prepare("UPDATE org_memberships SET status='revoked' WHERE org_id=? AND user_id=?")
        .bind(principal.orgId, ORDINARY)
        .run();
      await expect(resolveCurrentAuthority(bindings.DB, {}, runAs, check)).rejects.toMatchObject({
        code: "MEMBERSHIP_REVOKED",
      });
      const executionsBefore = await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND user_id=?",
      )
        .bind(principal.orgId, ORDINARY)
        .first<{ n: number }>();
      ordinarySubmits = 0;
      await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
        .bind(new Date(Date.now() - 7_200_000).toISOString(), principal.orgId, "authority-revoked-probe")
        .run();
      const second = await promoteDueSchedules(bindings.DB, tickEnv, SAGA_DEFINITIONS, countingSubmit, new Date());
      expect(second.promoted.map((entry) => entry.scheduleName)).not.toContain("authority-revoked-probe");
      expect(second.skipped).toContain("authority-revoked-probe");
      expect(ordinarySubmits).toBe(0);
      const executionsAfter = await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND user_id=?",
      )
        .bind(principal.orgId, ORDINARY)
        .first<{ n: number }>();
      expect(executionsAfter?.n).toBe(executionsBefore?.n ?? 0);
      // Grant revocation fences even with live lifecycle: restore the
      // membership, drop the assignment, and the shared resolver answers
      // GRANT_REQUIRED through the canonical deny-by-absence path.
      await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
        .bind(principal.orgId, ORDINARY)
        .run();
      await revokeAssignment(bindings.DB, principal.orgId, roleId, ORDINARY);
      await expect(resolveCurrentAuthority(bindings.DB, {}, runAs, check)).rejects.toMatchObject({
        code: "GRANT_REQUIRED",
      });
    } finally {
      await bindings.DB.prepare("UPDATE org_memberships SET status='active' WHERE org_id=? AND user_id=?")
        .bind(principal.orgId, ORDINARY)
        .run();
      // Delivery rows reference the schedule row (migration 0016 FK), so
      // they go first — same order as the route's deleteSchedule batch.
      const probeId = await bindings.DB.prepare("SELECT id FROM schedules WHERE org_id=? AND name=?")
        .bind(principal.orgId, "authority-revoked-probe")
        .first<{ id: string }>();
      if (probeId) {
        await bindings.DB.prepare("DELETE FROM schedule_deliveries WHERE schedule_id=?").bind(probeId.id).run();
        await bindings.DB.prepare("DELETE FROM schedules WHERE id=?").bind(probeId.id).run();
      }
      if (roleId) await deleteRole(bindings.DB, principal.orgId, roleId).catch(() => undefined);
    }
  }, 25000);
  it("dispatches zero work when the run-as Organization is disabled before the tick", async () => {
    await createRecurring("disabled-org-probe");
    await bindings.DB.prepare("UPDATE organizations SET status='disabled' WHERE id=?").bind(principal.orgId).run();
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      await bindings.DB.prepare("UPDATE schedules SET next_due_at=? WHERE org_id=? AND name=?")
        .bind(past, principal.orgId, "disabled-org-probe")
        .run();
      let submitCalls = 0;
      const countingSubmit: typeof submit = async (...args) => {
        submitCalls += 1;
        return submit(...args);
      };
      const report = await promoteDueSchedules(
        bindings.DB,
        { DB: bindings.DB, HELLO_WORKFLOW: bindings.HELLO_WORKFLOW } as never,
        SAGA_DEFINITIONS,
        countingSubmit,
        new Date(),
      );
      expect(submitCalls).toBe(0);
      expect(report.promoted.map((entry) => entry.scheduleName)).not.toContain("disabled-org-probe");
      expect(report.skipped).toContain("disabled-org-probe");
    } finally {
      // The disabled org blocks fixture-auth resurrection (fail closed), so
      // restore here: later tests need a usable org.
      await bindings.DB.prepare("UPDATE organizations SET status='active' WHERE id=?").bind(principal.orgId).run();
    }
  }, 25000);
});
