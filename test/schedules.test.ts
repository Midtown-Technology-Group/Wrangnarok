// SPDX-License-Identifier: AGPL-3.0
// TRG-01 (issue #137, ADR 012): schedule parsers and due-time math, pure
// plus workerd-backed CRUD. Every gate runs in real workerd with real D1;
// only outbound vendor HTTP is mocked (hello Saga needs no vendor fetch).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { helloSaga } from "../src/domain";
import { currentWindow, nextCronDue, parseCron, parseScheduleTimezone, scheduleWindowKey } from "../src/schedules";
import { createSdkClient, SdkError } from "../src/sdk";
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

describe("TRG-01 cron and timezone parsing (pure)", () => {
  it("accepts standard 5-field cron and rejects malformed cadence", () => {
    expect(parseCron("* * * * *")).toBe("* * * * *");
    expect(parseCron("0 9 * * 1-5")).toBe("0 9 * * 1-5");
    expect(parseCron("*/15 8-18 * * *")).toBe("*/15 8-18 * * *");
    expect(() => parseCron("* * * *")).toThrow(/5-field/);
    expect(() => parseCron("* * * * * *")).toThrow(/5-field/);
    expect(() => parseCron("61 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 25 * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 0 * *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("0 0 * * 8")).toThrow(/out of range/);
    expect(() => parseCron("nope * * * *")).toThrow(/5-field/);
    expect(() => parseCron("")).toThrow(/Cron must be/);
    expect(() => parseCron("*".repeat(65))).toThrow(/at most 64/);
    expect(() => parseCron(null)).toThrow(/Cron must be/);
  });
  it("defaults timezones to UTC and fails closed on unknown zones", () => {
    expect(parseScheduleTimezone(undefined)).toBe("UTC");
    expect(parseScheduleTimezone("")).toBe("UTC");
    expect(parseScheduleTimezone("UTC")).toBe("UTC");
    expect(parseScheduleTimezone("America/New_York")).toBe("America/New_York");
    expect(() => parseScheduleTimezone("Mars/Olympus")).toThrow(/IANA timezone/);
    expect(() => parseScheduleTimezone(42)).toThrow(/IANA timezone/);
  });
  it("computes the next due instant after the cursor", () => {
    const from = new Date("2026-09-12T10:00:30.000Z");
    expect(nextCronDue("* * * * *", "UTC", from)).toBe("2026-09-12T10:01:00.000Z");
    expect(nextCronDue("0 9 * * *", "UTC", new Date("2026-09-12T10:00:00.000Z"))).toBe("2026-09-13T09:00:00.000Z");
    expect(nextCronDue("0 9 * * *", "UTC", new Date("2026-09-12T08:00:00.000Z"))).toBe("2026-09-12T09:00:00.000Z");
  });
  it("derives deterministic schedule-window keys in the sch- namespace", async () => {
    const first = await scheduleWindowKey("schedule-id-1", "2026-09-12T10:01");
    const second = await scheduleWindowKey("schedule-id-1", "2026-09-12T10:01");
    expect(first).toBe(second);
    expect(first.startsWith("sch-")).toBe(true);
    expect(await scheduleWindowKey("schedule-id-1", "2026-09-12T10:02")).not.toBe(first);
    expect(await scheduleWindowKey("schedule-id-2", "2026-09-12T10:01")).not.toBe(first);
    await expect(scheduleWindowKey("schedule-id-1", "evil window!")).rejects.toThrow(/safe delivery/);
  });
  it("formats minute windows in UTC", () => {
    expect(currentWindow(new Date("2026-09-12T10:01:45.000Z"))).toBe("2026-09-12T10:01");
  });
});

describe("TRG-01 schedule CRUD (workerd)", () => {
  it("rejects malformed schedule route identifiers", async () => {
    expect((await worker.fetch(authed("/api/schedules/UPPER", "GET"), bindings)).status).toBe(404);
  });
  it("creates, lists, previews, disables, and deletes schedules as an operator", async () => {
    const created = await worker.fetch(
      authed("/api/schedules", "POST", {
        name: "morning-digest",
        sagaId: helloSaga.id,
        kind: "recurring",
        cron: "* * * * *",
        timezone: "UTC",
        input: { name: "sched" },
      }),
      bindings,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { schedule: { name: string; nextDueAt: string; enabled: boolean } };
    expect(createdBody.schedule.name).toBe("morning-digest");
    expect(createdBody.schedule.enabled).toBe(true);
    expect(Date.parse(createdBody.schedule.nextDueAt)).toBeGreaterThan(Date.now() - 60_000);
    // Same-org duplicate names answer 409, never a second row.
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "morning-digest",
            sagaId: helloSaga.id,
            kind: "recurring",
            cron: "* * * * *",
            input: { name: "sched" },
          }),
          bindings,
        )
      ).status,
    ).toBe(409);
    // Unknown Sagas and malformed cron fail closed; identity smuggling rejects.
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "bad-saga",
            sagaId: "395e15f0-3627-41f6-8922-008ce37e3b00",
            kind: "recurring",
            cron: "* * * * *",
          }),
          bindings,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", { name: "bad-cron", sagaId: helloSaga.id, kind: "recurring", cron: "nope" }),
          bindings,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "smuggle",
            sagaId: helloSaga.id,
            kind: "recurring",
            cron: "* * * * *",
            runAs: "someone-else",
          }),
          bindings,
        )
      ).status,
    ).toBe(400);
    // Inventory lists the row; detail previews it.
    const listed = (await (await worker.fetch(authed("/api/schedules", "GET"), bindings)).json()) as {
      schedules: { name: string }[];
    };
    expect(listed.schedules.map((entry) => entry.name)).toContain("morning-digest");
    const detail = (await (await worker.fetch(authed("/api/schedules/morning-digest", "GET"), bindings)).json()) as {
      schedule: { sagaId: string };
    };
    expect(detail.schedule.sagaId).toBe(helloSaga.id);
    // Unknown names 404, never a leak.
    expect((await worker.fetch(authed("/api/schedules/no-such-schedule", "GET"), bindings)).status).toBe(404);
    expect((await worker.fetch(authed("/api/schedules/no-such-schedule", "DELETE"), bindings)).status).toBe(404);
    expect((await worker.fetch(authed("/api/schedules/no-such-schedule/enable", "POST"), bindings)).status).toBe(404);
    expect((await worker.fetch(authed("/api/schedules/no-such-schedule/disable", "POST"), bindings)).status).toBe(404);
    expect(
      (
        await worker.fetch(
          authed("/api/schedules/no-such-schedule/deliveries?window=2026-09-12T10:01", "GET"),
          bindings,
        )
      ).status,
    ).toBe(404);
    // Unknown delivery windows 404, never an invented mapping.
    expect(
      (await worker.fetch(authed("/api/schedules/morning-digest/deliveries?window=2099-01-01T00:00", "GET"), bindings))
        .status,
    ).toBe(404);
    // Query strings outside the allowlist stay denied.
    expect(
      (await worker.fetch(authed("/api/schedules/morning-digest/deliveries?window=x&extra=1", "GET"), bindings)).status,
    ).toBe(400);
    // Disable fences promotion; re-enable resumes.
    expect((await worker.fetch(authed("/api/schedules/morning-digest/disable", "POST"), bindings)).status).toBe(200);
    const disabled = (await (await worker.fetch(authed("/api/schedules/morning-digest", "GET"), bindings)).json()) as {
      schedule: { enabled: boolean };
    };
    expect(disabled.schedule.enabled).toBe(false);
    expect((await worker.fetch(authed("/api/schedules/morning-digest/enable", "POST"), bindings)).status).toBe(200);
    // Delete removes the row; a second delete is gone, not resurrected.
    expect((await worker.fetch(authed("/api/schedules/morning-digest", "DELETE"), bindings)).status).toBe(200);
    expect((await worker.fetch(authed("/api/schedules/morning-digest", "GET"), bindings)).status).toBe(404);
  });
  it("deletes a schedule after its first delivery without FK failure", async () => {
    // Regression (#137 reopen): schedule_deliveries references schedules(id)
    // with no ON DELETE action, so deleting a delivered schedule must clear
    // its delivery rows in the same delete. ExecutionHistory provenance
    // survives on the executions rows (keyed by Execution ID).
    const runAt = new Date(Date.now() - 30_000).toISOString();
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "delivered-then-deleted",
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
    const delivered = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id=(SELECT id FROM schedules WHERE org_id=? AND name=?)",
    )
      .bind("00000000-0000-4000-8000-000000000001", "delivered-then-deleted")
      .first<{ n: number }>();
    expect(delivered?.n).toBe(1);
    expect((await worker.fetch(authed("/api/schedules/delivered-then-deleted", "DELETE"), bindings)).status).toBe(200);
    const remaining = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM schedule_deliveries").first<{
      n: number;
    }>();
    expect(remaining?.n).toBe(0);
    const executions = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
    expect(executions?.n).toBeGreaterThan(0);
  }, 25000);
  it("creates one-off schedules with durable due-time", async () => {
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const created = await worker.fetch(
      authed("/api/schedules", "POST", {
        name: "one-shot",
        sagaId: helloSaga.id,
        kind: "one-off",
        runAt,
        input: { name: "sched" },
      }),
      bindings,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { schedule: { runAt: string; nextDueAt: string; kind: string } };
    expect(body.schedule.kind).toBe("one-off");
    expect(body.schedule.runAt).toBe(runAt);
    expect(body.schedule.nextDueAt).toBe(runAt);
    // One-off rows require a real timestamp.
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", { name: "no-time", sagaId: helloSaga.id, kind: "one-off" }),
          bindings,
        )
      ).status,
    ).toBe(400);
  });
  it("gates writes to Organization admins; ordinary members read only", async () => {
    const memberId = "00000000-0000-4000-8000-000000000099";
    const stamp = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(memberId, stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'member','active','ordinary',?,?)",
    )
      .bind("00000000-0000-4000-8000-000000000001", memberId, stamp, stamp)
      .run();
    const memberBindings = {
      ...bindings,
      LAB_USER_ID: memberId,
      LAB_FIXTURE_USER_ID: "00000000-0000-4000-8000-000000000002",
    };
    expect(
      (
        await worker.fetch(
          authed("/api/schedules", "POST", {
            name: "member-try",
            sagaId: helloSaga.id,
            kind: "recurring",
            cron: "* * * * *",
          }),
          memberBindings,
        )
      ).status,
    ).toBe(403);
    // Reads stay open to same-org members.
    expect((await worker.fetch(authed("/api/schedules", "GET"), memberBindings)).status).toBe(200);
  });
  it("falls back to the saga id when the catalog drops a scheduled saga", async () => {
    const now = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,next_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "55555555-5555-4555-8555-555555555555",
        "00000000-0000-4000-8000-000000000001",
        "orphan-row",
        "00000000-0000-4000-8000-000000000099",
        "recurring",
        "* * * * *",
        "UTC",
        1,
        "{}",
        "00000000-0000-4000-8000-000000000002",
        now,
        now,
        now,
      )
      .run();
    const listed = (await (await worker.fetch(authed("/api/schedules", "GET"), bindings)).json()) as {
      schedules: { name: string; sagaName: string }[];
    };
    expect(listed.schedules.find((entry) => entry.name === "orphan-row")?.sagaName).toBe(
      "00000000-0000-4000-8000-000000000099",
    );
  });
  it("drives schedules through the typed SDK client", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(new Request(url, { ...(init ?? {}), headers: { ...auth, ...(init?.headers ?? {}) } }), {
        ...bindings,
      })) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl });
    // Malformed names fail before any fetch.
    await expect(client.getSchedule("UPPER")).rejects.toBeInstanceOf(SdkError);
    const created = await client.createSchedule({
      name: "sdk-roundtrip",
      sagaId: helloSaga.id,
      kind: "one-off",
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
      input: { name: "sched" },
    });
    expect(created.name).toBe("sdk-roundtrip");
    expect(created.kind).toBe("one-off");
    const recurring = await client.createSchedule({
      name: "sdk-recur",
      sagaId: helloSaga.id,
      kind: "recurring",
      cron: "0 9 * * 1-5",
      timezone: "America/New_York",
      input: { name: "sched" },
      enabled: false,
    });
    expect(recurring.cron).toBe("0 9 * * 1-5");
    expect(recurring.timezone).toBe("America/New_York");
    expect(recurring.enabled).toBe(false);
    expect(await client.listSchedules()).toHaveLength(2);
    expect((await client.getSchedule("sdk-roundtrip")).id).toBe(created.id);
    const disabled = await client.setScheduleEnabled("sdk-roundtrip", false);
    expect(disabled.enabled).toBe(false);
    expect((await client.setScheduleEnabled("sdk-roundtrip", true)).enabled).toBe(true);
    // No deliveries yet: the visibility read 404s instead of inventing one.
    await expect(client.getScheduleDelivery("sdk-roundtrip", "2026-09-12T10:01")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await client.deleteSchedule("sdk-roundtrip");
    await client.deleteSchedule("sdk-recur");
    expect(await client.listSchedules()).toHaveLength(0);
  }, 25000);
});
