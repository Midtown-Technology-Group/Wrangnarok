// SPDX-License-Identifier: AGPL-3.0
// TRG-01 lifecycle over the Worker routes (issue #137): create one-off and
// recurring schedules, preview windows, disable/enable/delete, foreign-org
// isolation, and the Scheduled intent row. Runs in real workerd with a real
// D1 binding; no vendor calls (schedules validate input at creation).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker, { promoteWindow } from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, helloSaga } from "../src/domain";
import type { ScheduleRow } from "../src/schedules";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration9 from "../migrations/0016_schedules.sql?raw";
import migration10 from "../migrations/0016_scheduled_executions.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";

function authed(path: string, method: string, body?: unknown, query = "") {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  };
  return new Request(`http://local.test${path}${query}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(path: string, method: string, body?: unknown, query = "", envOverride?: Bindings) {
  const res = await worker.fetch(authed(path, method, body, query), envOverride ?? bindings);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration9);
  await bindings.DB.exec(migration10);
  await bindings.DB.exec(seed);
});

afterEach(async () => {
  await reset();
});

it("creates a one-off schedule with its durable Scheduled intent row", async () => {
  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await call("/api/schedules", "POST", {
    sagaId: helloSaga.id,
    input: { name: "Ada" },
    kind: "once",
    runAt,
  });
  expect(created.status).toBe(201);
  const schedule = created.body.schedule as Record<string, unknown>;
  expect(schedule).toMatchObject({ kind: "once", status: "active", runAt });
  expect(typeof schedule.id).toBe("string");
  // The intent row survives: a durable pre-publish row distinct from Pending.
  const intent = await bindings.DB.prepare("SELECT status,schedule_id,due_at FROM executions WHERE schedule_id=?")
    .bind(schedule.id as string)
    .first<{ status: string; schedule_id: string; due_at: string }>();
  expect(intent).toMatchObject({ status: "Scheduled", schedule_id: schedule.id, due_at: runAt });
  const listed = await call("/api/schedules", "GET");
  expect(listed.body.schedules).toHaveLength(1);
  const detail = await call(`/api/schedules/${schedule.id}`, "GET");
  expect(detail.status).toBe(200);
});

it("creates a recurring schedule and previews its next windows", async () => {
  const created = await call("/api/schedules", "POST", {
    sagaId: echoSaga.id,
    input: { message: "tick" },
    kind: "recurring",
    cron: "* * * * *",
    timezone: "America/New_York",
  });
  expect(created.status).toBe(201);
  const schedule = created.body.schedule as Record<string, unknown>;
  expect(schedule).toMatchObject({ kind: "recurring", timezone: "America/New_York" });
  expect(typeof schedule.nextDueAt).toBe("string");
  const preview = await call(`/api/schedules/${schedule.id}/preview`, "GET", undefined, "?count=3");
  expect(preview.status).toBe(200);
  expect(preview.body.windows as string[]).toHaveLength(3);
  const badCount = await call(`/api/schedules/${schedule.id}/preview`, "GET", undefined, "?count=99");
  expect(badCount.status).toBe(400);
  expect(badCount.body).toMatchObject({ error: { code: "INVALID_PREVIEW" } });
});

it("refuses invalid schedule bodies with machine-readable codes", async () => {
  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cases: { body: unknown; code: string }[] = [
    {
      body: { sagaId: echoSaga.id, input: { message: "x" }, kind: "once", cron: "* * * * *", runAt },
      code: "INVALID_SCHEDULE",
    },
    { body: { sagaId: echoSaga.id, input: { message: "x" }, kind: "recurring", cron: "nope" }, code: "INVALID_CRON" },
    {
      body: {
        sagaId: echoSaga.id,
        input: { message: "x" },
        kind: "recurring",
        cron: "* * * * *",
        timezone: "Mars/Olympus",
      },
      code: "INVALID_TIMEZONE",
    },
    {
      body: { sagaId: echoSaga.id, input: { message: "x" }, kind: "once", runAt: "2000-01-01T00:00:00.000Z" },
      code: "INVALID_RUN_AT",
    },
    { body: { sagaId: echoSaga.id, input: { nope: 1 }, kind: "once", runAt }, code: "INVALID_INPUT" },
    { body: { sagaId: echoSaga.id, input: { message: "x" }, kind: "once", runAt, extra: 1 }, code: "INVALID_SCHEDULE" },
  ];
  for (const { body, code } of cases) {
    const res = await call("/api/schedules", "POST", body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code } });
  }
  const noJson = await worker.fetch(
    new Request("http://local.test/api/schedules", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
      body: "{}",
    }),
    bindings,
  );
  expect(noJson.status).toBe(415);
  const query = await call("/api/schedules", "GET", undefined, "?order=asc");
  expect(query.status).toBe(400);
  expect(query.body).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
});

it("disables, re-enables, and deletes a schedule", async () => {
  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await call("/api/schedules", "POST", {
    sagaId: helloSaga.id,
    input: { name: "Bo" },
    kind: "once",
    runAt,
  });
  const id = (created.body.schedule as { id: string }).id;
  const disabled = await call(`/api/schedules/${id}/disable`, "POST");
  expect(disabled.status).toBe(200);
  expect(disabled.body.schedule).toMatchObject({ status: "disabled" });
  const enabled = await call(`/api/schedules/${id}/enable`, "POST");
  expect(enabled.body.schedule).toMatchObject({ status: "active" });
  const deleted = await call(`/api/schedules/${id}`, "DELETE");
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ deleted: true });
  expect((await call(`/api/schedules/${id}`, "GET")).status).toBe(404);
  expect((await call("/api/schedules", "GET")).body.schedules).toHaveLength(0);
  expect((await call(`/api/schedules/${id}/disable`, "POST")).status).toBe(404);
});

it("isolates schedules across Organizations", async () => {
  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await call("/api/schedules", "POST", {
    sagaId: helloSaga.id,
    input: { name: "Cy" },
    kind: "once",
    runAt,
  });
  const id = (created.body.schedule as { id: string }).id;
  const foreign = {
    ...bindings,
    LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
    LAB_FIXTURE_USER_ID: "00000000-0000-4000-8000-000000000002",
  };
  expect((await call(`/api/schedules/${id}`, "GET", undefined, "", foreign)).status).toBe(404);
  expect((await call("/api/schedules", "GET", undefined, "", foreign)).status).toBe(404);
});

it("cancels a Scheduled intent row without touching promoted Executions", async () => {
  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await call("/api/schedules", "POST", {
    sagaId: helloSaga.id,
    input: { name: "De" },
    kind: "once",
    runAt,
  });
  const id = (created.body.schedule as { id: string }).id;
  const intent = await bindings.DB.prepare("SELECT id FROM executions WHERE schedule_id=?")
    .bind(id)
    .first<{ id: string }>();
  const cancelled = await call(`/api/schedules/executions/${intent?.id}/cancel`, "POST");
  expect(cancelled.status).toBe(200);
  expect(cancelled.body).toMatchObject({ status: "Cancelled", cancelled: true });
  // Promoted rows are not schedule-cancelled: the owner cancel route owns those.
  const pendingId = "ab".repeat(32);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      pendingId,
      helloSaga.id,
      "hello",
      "hello-v1",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      JSON.stringify({ name: "live" }),
      0,
      "Pending",
      new Date().toISOString(),
    )
    .run();
  const refused = await call(`/api/schedules/executions/${pendingId}/cancel`, "POST");
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({ error: { code: "EXECUTION_NOT_CANCELLABLE" } });
  expect((await call(`/api/schedules/executions/${"f".repeat(64)}/cancel`, "POST")).status).toBe(404);
});

it("promotes a due one-off window through the real submit path", async () => {
  const runAt = new Date(Date.now() + 60 * 1000).toISOString();
  const created = await call("/api/schedules", "POST", {
    sagaId: helloSaga.id,
    input: { name: "Tick" },
    kind: "once",
    runAt,
  });
  const id = (created.body.schedule as { id: string }).id;
  const row = await bindings.DB.prepare("SELECT * FROM schedules WHERE id=? AND org_id=?")
    .bind(id, ORG)
    .first<ScheduleRow>();
  if (!row) throw new Error("schedule row missing");
  const outcome = await promoteWindow(bindings, row, runAt, `sched.${id}.once.${runAt}`);
  expect(outcome.skipped).toBe(false);
  expect(outcome.replayed).toBe(true);
  expect(typeof outcome.executionId).toBe("string");
  const detail = await call(`/api/executions/${outcome.executionId}`, "GET");
  expect(detail.status).toBe(200);
  // Same-window promotion converges: the second call replays the same Execution.
  const replay = await promoteWindow(bindings, row, runAt, `sched.${id}.once.${runAt}`);
  expect(replay).toMatchObject({ executionId: outcome.executionId, replayed: true, skipped: false });
});
