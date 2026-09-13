// SPDX-License-Identifier: AGPL-3.0
// TRG-01 pure schedule contracts (issue #137): cron validation, timezone
// labels, window math, key derivation, and the tick scan/promotion skeleton
// over a stub promoter. No runtime binding: runs in plain Vitest.
import { describe, expect, it } from "vitest";
import {
  advanceRecurring,
  createSchedule,
  cronMatches,
  deleteSchedule,
  firstWindow,
  listSchedules,
  loadSchedule,
  nextWindow,
  parseCronExpression,
  parseScheduleBody,
  parseTimezone,
  previewWindows,
  runTick,
  scheduleKey,
  setScheduleStatus,
  windowOf,
  type ScheduleRow,
} from "../src/schedules";
import { echoSaga, helloSaga } from "../src/domain";
import type { Principal } from "../src/domain";

function faultCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  throw new Error("expected a Fault");
}

function row(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    org_id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    saga_id: echoSaga.id,
    input_json: JSON.stringify({ message: "hi" }),
    kind: "once",
    status: "active",
    cron_expr: null,
    timezone: "UTC",
    run_at: "2026-09-12T00:00:00.000Z",
    next_due_at: "2026-09-12T00:00:00.000Z",
    overlap: "allow",
    last_execution_id: null,
    last_skipped_window: null,
    created_at: "2026-09-11T00:00:00.000Z",
    updated_at: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("cron validation", () => {
  it("accepts Cloudflare-shaped expressions and normalizes whitespace", () => {
    expect(parseCronExpression("* * * * *")).toBe("* * * * *");
    expect(parseCronExpression("  */15  9-17  *  *  MON-FRI ")).toBe("*/15 9-17 * * MON-FRI");
    expect(parseCronExpression("0 0 1 JAN SUN")).toBe("0 0 1 JAN SUN");
    expect(parseCronExpression("0,30 8,18 1,15 1,6 0,6")).toBe("0,30 8,18 1,15 1,6 0,6");
  });
  it("refuses seconds, years, L/W/#, free text, and out-of-range fields", () => {
    for (const bad of [
      "* * * *",
      "* * * * * *",
      "*/0 * * * *",
      "61 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 7",
      "L * * * *",
      "* * W * *",
      "* * * * #",
      "every minute please",
      "* * * * MON-",
      "* * * *, *",
      "",
    ]) {
      expect(
        faultCode(() => parseCronExpression(bad)),
        bad,
      ).toBe("INVALID_CRON");
    }
  });
});

describe("timezone labels", () => {
  it("defaults to UTC and accepts IANA names plus fixed offsets", () => {
    expect(parseTimezone(undefined)).toBe("UTC");
    expect(parseTimezone("UTC")).toBe("UTC");
    expect(parseTimezone("America/New_York")).toBe("America/New_York");
    expect(parseTimezone("+02:00")).toBe("+02:00");
    expect(faultCode(() => parseTimezone("Mars/Olympus"))).toBe("INVALID_TIMEZONE");
    expect(faultCode(() => parseTimezone(7))).toBe("INVALID_TIMEZONE");
  });
});

describe("windows and keys", () => {
  it("labels one-off windows by runAt and aligns recurring windows to the minute", () => {
    expect(windowOf("once", new Date(), "2026-09-12T00:00:00.000Z")).toBe("2026-09-12T00:00:00.000Z");
    expect(windowOf("recurring", new Date("2026-09-12T03:04:05.678Z"))).toBe("2026-09-12T03:04:00Z");
    expect(firstWindow(new Date("2026-09-12T03:04:05.000Z")).toISOString()).toBe("2026-09-12T03:05:00.000Z");
  });
  it("derives parseKey-compatible submit keys", () => {
    const key = scheduleKey("11111111-1111-4111-8111-111111111111", "recurring", "2026-09-12T03:04:00Z");
    expect(key).toMatch(/^[a-zA-Z0-9._:-]{16,128}$/);
    expect(key).toContain("recur");
    expect(scheduleKey("11111111-1111-4111-8111-111111111111", "once", "2026-09-12T00:00:00.000Z")).toContain("once");
  });
  it("matches cron fields in UTC and advances to the next window", () => {
    expect(cronMatches("* * * * *", new Date("2026-09-12T03:04:00Z"))).toBe(true);
    expect(cronMatches("5 3 * * *", new Date("2026-09-12T03:05:00Z"))).toBe(true);
    expect(cronMatches("5 3 * * *", new Date("2026-09-12T03:06:00Z"))).toBe(false);
    expect(cronMatches("0 9 * * MON", new Date("2026-09-14T09:00:00Z"))).toBe(true);
    expect(nextWindow("* * * * *", new Date("2026-09-12T03:04:00Z")).toISOString()).toBe("2026-09-12T03:05:00.000Z");
    expect(nextWindow("0 0 1 * *", new Date("2026-09-12T00:00:00Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(faultCode(() => nextWindow("0 0 30 2 *", new Date("2026-09-12T00:00:00Z")))).toBe("SCHEDULE_UNMATCHABLE");
  });
  it("previews bounded window lists", () => {
    expect(previewWindows("* * * * *", new Date("2026-09-12T03:04:00Z"), 3)).toEqual([
      "2026-09-12T03:05:00Z",
      "2026-09-12T03:06:00Z",
      "2026-09-12T03:07:00Z",
    ]);
    expect(faultCode(() => previewWindows("* * * * *", new Date(), 0))).toBe("INVALID_PREVIEW");
    expect(faultCode(() => previewWindows("* * * * *", new Date(), 21))).toBe("INVALID_PREVIEW");
  });
});

describe("schedule bodies", () => {
  const sagas = [
    { id: echoSaga.id, name: "echo", revision: "echo-v1", description: "echo", parse: (v: unknown) => v },
    { id: helloSaga.id, name: "hello", revision: "hello-v1", description: "hello", parse: (v: unknown) => v },
  ];
  it("accepts one-off and recurring shapes, refuses cross-fields and extras", () => {
    const once = parseScheduleBody(
      { sagaId: echoSaga.id, input: { message: "hi" }, kind: "once", runAt: "2099-01-01T00:00:00.000Z" },
      sagas,
    );
    expect(once.create.kind).toBe("once");
    const recur = parseScheduleBody(
      { sagaId: echoSaga.id, input: { message: "hi" }, kind: "recurring", cron: "* * * * *" },
      sagas,
    );
    expect(recur.create.kind).toBe("recurring");
    const bodyCode = (body: unknown): string => faultCode(() => parseScheduleBody(body, sagas));
    expect(
      bodyCode({ sagaId: echoSaga.id, input: {}, kind: "once", runAt: "2099-01-01T00:00:00.000Z", cron: "* * * * *" }),
    ).toBe("INVALID_SCHEDULE");
    expect(
      bodyCode({
        sagaId: echoSaga.id,
        input: {},
        kind: "recurring",
        cron: "* * * * *",
        runAt: "2099-01-01T00:00:00.000Z",
      }),
    ).toBe("INVALID_SCHEDULE");
    expect(bodyCode({ sagaId: echoSaga.id, input: {}, kind: "recurring", cron: "* * * * *", bogus: 1 })).toBe(
      "INVALID_SCHEDULE",
    );
    expect(bodyCode({ sagaId: echoSaga.id, input: {}, kind: "recurring", cron: "nope" })).toBe("INVALID_CRON");
    expect(bodyCode({ sagaId: echoSaga.id, input: {}, kind: "once", runAt: "2000-01-01T00:00:00.000Z" })).toBe(
      "INVALID_RUN_AT",
    );
    expect(bodyCode({ sagaId: "not-a-uuid", input: {}, kind: "once", runAt: "2099-01-01T00:00:00.000Z" })).toBe(
      "INVALID_SAGA_ID",
    );
    expect(
      bodyCode({
        sagaId: "395e15f0-3627-41f6-8922-008ce37e3b00",
        input: {},
        kind: "once",
        runAt: "2099-01-01T00:00:00.000Z",
      }),
    ).toBe("UNKNOWN_SAGA");
    expect(bodyCode(null)).toBe("INVALID_SCHEDULE");
    expect(bodyCode({ sagaId: echoSaga.id, input: {}, kind: "sometimes", runAt: "2099-01-01T00:00:00.000Z" })).toBe(
      "INVALID_SCHEDULE",
    );
    expect(
      bodyCode({ sagaId: echoSaga.id, input: {}, kind: "recurring", cron: "* * * * *", overlap: "sometimes" }),
    ).toBe("INVALID_OVERLAP");
  });
});

describe("tick skeleton over a stub promoter", () => {
  function memoryDb(schedules: ScheduleRow[]): D1Database {
    const updates: { sql: string; binds: unknown[] }[] = [];
    const stmt = (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => null,
        all: async () => ({ results: schedules }),
        run: async () => {
          updates.push({ sql, binds });
          return {};
        },
      }),
    });
    return { prepare: stmt } as unknown as D1Database;
  }
  it("promotes due rows, skips loudly, and retires one-offs", async () => {
    const due = row({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      kind: "once",
      next_due_at: "2026-09-11T00:00:00.000Z",
    });
    const recur = row({
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      kind: "recurring",
      cron_expr: "* * * * *",
      run_at: null,
      next_due_at: "2026-09-11T00:00:00.000Z",
    });
    const skip = row({
      id: "cccccccc-3333-4333-8333-333333333333",
      kind: "once",
      next_due_at: "2026-09-11T00:00:00.000Z",
    });
    const db = memoryDb([due, recur, skip]);
    const calls: string[] = [];
    const result = await runTick(
      db,
      async ({ schedule, window, key }) => {
        calls.push(`${schedule.id}:${window}:${key}`);
        if (schedule.id.startsWith("cccc"))
          return { executionId: "", replayed: false, skipped: true, skipReason: "test" };
        return { executionId: `exec-${schedule.id}`, replayed: false, skipped: false };
      },
      new Date("2026-09-12T00:00:00.000Z"),
    );
    expect(result.scanned).toBe(3);
    expect(result.promoted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.receipts).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("once");
  });
  it("respects the admission bound", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      row({ id: `0000000${i % 10}-1111-4111-8111-11111111111${i % 10}`, next_due_at: "2026-09-11T00:00:00.000Z" }),
    );
    const db = memoryDb(many);
    let count = 0;
    const result = await runTick(
      db,
      async ({ schedule }) => {
        count += 1;
        return { executionId: `exec-${schedule.id}`, replayed: false, skipped: false };
      },
      new Date("2026-09-12T00:00:00.000Z"),
    );
    expect(count).toBeLessThanOrEqual(25);
    expect(result.promoted).toBeLessThanOrEqual(25);
  });
});

describe("parser and persistence branch edges", () => {
  it("refuses malformed cron ranges, values, and non-string expressions", () => {
    // Bare slash with no range side: `range` is empty, not "*".
    expect(faultCode(() => parseCronExpression("/2 * * * *"))).toBe("INVALID_CRON");
    // Out-of-range range bound.
    expect(faultCode(() => parseCronExpression("70-80 * * * *"))).toBe("INVALID_CRON");
    // Inverted range.
    expect(faultCode(() => parseCronExpression("30-10 * * * *"))).toBe("INVALID_CRON");
    // Non-string expression.
    expect(faultCode(() => parseCronExpression(42))).toBe("INVALID_CRON");
    // Field too long.
    expect(faultCode(() => parseCronExpression(`${"1".repeat(65)} * * * *`))).toBe("INVALID_CRON");
  });
  it("refuses malformed runAt, overlap, and timezone values", () => {
    const sagas = [
      { id: echoSaga.id, name: "echo", revision: "echo-v1", description: "echo", parse: (v: unknown) => v },
    ];
    const bodyCode = (body: unknown): string => faultCode(() => parseScheduleBody(body, sagas));
    // Non-string runAt.
    expect(bodyCode({ sagaId: echoSaga.id, input: {}, kind: "once", runAt: 123 })).toBe("INVALID_RUN_AT");
    // Unparseable runAt.
    expect(bodyCode({ sagaId: echoSaga.id, input: {}, kind: "once", runAt: "not-a-date" })).toBe("INVALID_RUN_AT");
    // Past runAt.
    expect(bodyCode({ sagaId: echoSaga.id, input: {}, kind: "once", runAt: "2000-01-01T00:00:00.000Z" })).toBe(
      "INVALID_RUN_AT",
    );
    // `skip` overlap is accepted and carried.
    const skipped = parseScheduleBody(
      { sagaId: echoSaga.id, input: {}, kind: "once", runAt: "2099-01-01T00:00:00.000Z", overlap: "skip" },
      sagas,
    );
    expect(skipped.create.overlap).toBe("skip");
    // Empty timezone string.
    expect(
      bodyCode({ sagaId: echoSaga.id, input: {}, kind: "once", runAt: "2099-01-01T00:00:00.000Z", timezone: "" }),
    ).toBe("INVALID_TIMEZONE");
    // Array body.
    expect(bodyCode([])).toBe("INVALID_SCHEDULE");
    // Non-Fault parse throw becomes INVALID_INPUT.
    const throwing = [
      {
        id: echoSaga.id,
        name: "echo",
        revision: "echo-v1",
        description: "echo",
        parse: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(
      faultCode(() =>
        parseScheduleBody(
          { sagaId: echoSaga.id, input: {}, kind: "once", runAt: "2099-01-01T00:00:00.000Z" },
          throwing,
        ),
      ),
    ).toBe("INVALID_INPUT");
    // Missing runAt inside windowOf for one-off.
    expect(faultCode(() => windowOf("once", new Date()))).toBe("INTERNAL_ERROR");
  });
  it("matches comma lists, ranges, steps, and names in cronMatches", () => {
    // Undefined field short-circuit is internal; exercise list/range/step paths.
    expect(cronMatches("0,30 * * * *", new Date("2026-09-12T03:30:00Z"))).toBe(true);
    expect(cronMatches("0,30 * * * *", new Date("2026-09-12T03:15:00Z"))).toBe(false);
    expect(cronMatches("10-20 * * * *", new Date("2026-09-12T03:15:00Z"))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date("2026-09-12T03:30:00Z"))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date("2026-09-12T03:31:00Z"))).toBe(false);
    expect(cronMatches("* * * JAN *", new Date("2026-01-12T03:00:00Z"))).toBe(true);
    expect(cronMatches("0 0 * * MON-FRI", new Date("2026-09-14T00:00:00Z"))).toBe(true);
    expect(cronMatches("0 0 * * MON-FRI", new Date("2026-09-13T00:00:00Z"))).toBe(false);
    // Malformed step is skipped, not fatal.
    expect(cronMatches("*/0 * * * *", new Date("2026-09-12T03:00:00Z"))).toBe(false);
  });

  // Small in-memory D1 stub keyed by SQL prefix.
  function stubDb(handlers: { count?: number; schedule?: ScheduleRow | null; listed?: ScheduleRow[] }): D1Database {
    const stmt = (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.startsWith("SELECT COUNT")) return { n: handlers.count ?? 0 };
          if (sql.startsWith("SELECT * FROM schedules WHERE id=")) return handlers.schedule ?? null;
          return null;
        },
        all: async () => ({ results: handlers.listed ?? [] }),
        run: async () => ({}),
      }),
    });
    return {
      prepare: stmt,
      batch: async () => [],
    } as unknown as D1Database;
  }
  const caller: Principal = {
    orgId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
  };
  const sagaRef = {
    id: echoSaga.id,
    name: "echo",
    revision: "echo-v1",
    description: "echo",
    parse: (v: unknown) => v,
  };

  it("refuses creation past the per-org limit", async () => {
    const db = stubDb({ count: 100 });
    await expect(
      createSchedule(
        db,
        caller,
        sagaRef,
        {},
        { sagaId: echoSaga.id, input: {}, kind: "once", runAt: "2099-01-01T00:00:00.000Z" },
      ),
    ).rejects.toMatchObject({ code: "SCHEDULE_LIMIT" });
  });
  it("loads null for malformed ids and lists with or without deleted rows", async () => {
    const db = stubDb({});
    expect(await loadSchedule(db, caller.orgId, "not-a-uuid")).toBeNull();
    const listed: ScheduleRow[] = [row({}), row({ id: "22222222-2222-4222-8222-222222222222", status: "deleted" })];
    const dbList = stubDb({ listed });
    expect(await listSchedules(dbList, caller.orgId)).toHaveLength(2);
    expect(await listSchedules(dbList, caller.orgId, true)).toHaveLength(2);
  });
  it("returns the same summary when the status already matches", async () => {
    const active = row({ status: "active" });
    const db = stubDb({ schedule: active });
    const summary = await setScheduleStatus(db, caller.orgId, active.id, false);
    expect(summary.status).toBe("active");
    const disabled = row({ status: "disabled" });
    const dbDisabled = stubDb({ schedule: disabled });
    const summaryDisabled = await setScheduleStatus(dbDisabled, caller.orgId, disabled.id, true);
    expect(summaryDisabled.status).toBe("disabled");
  });
  it("re-enables a recurring schedule by advancing its window", async () => {
    const disabled = row({ status: "disabled", kind: "recurring", cron_expr: "* * * * *" });
    const updates: string[] = [];
    const stmt = (sql: string) => ({
      bind: () => ({
        first: async () => (sql.startsWith("SELECT * FROM schedules WHERE id=") ? disabled : null),
        all: async () => ({ results: [] }),
        run: async () => {
          updates.push(sql);
          return {};
        },
      }),
    });
    const db = { prepare: stmt, batch: async () => [] } as unknown as D1Database;
    const summary = await setScheduleStatus(db, caller.orgId, disabled.id, false);
    // The stub reloads the pre-update row; what matters is the status UPDATE
    // plus the recurring advance UPDATE both ran.
    expect(summary.status).toBe("disabled");
    expect(updates.some((sql) => sql.startsWith("UPDATE schedules SET status="))).toBe(true);
    expect(updates.some((sql) => sql.startsWith("UPDATE schedules SET next_due_at="))).toBe(true);
  });
  it("rejects status changes and deletes for missing rows", async () => {
    const db = stubDb({ schedule: null });
    await expect(
      setScheduleStatus(db, caller.orgId, "11111111-1111-4111-8111-111111111111", true),
    ).rejects.toMatchObject({
      code: "SCHEDULE_NOT_FOUND",
    });
    await expect(deleteSchedule(db, caller.orgId, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "SCHEDULE_NOT_FOUND",
    });
    const deleted = row({ status: "deleted" });
    const dbDeleted = stubDb({ schedule: deleted });
    await expect(setScheduleStatus(dbDeleted, caller.orgId, deleted.id, true)).rejects.toMatchObject({
      code: "SCHEDULE_NOT_FOUND",
    });
    await expect(deleteSchedule(dbDeleted, caller.orgId, deleted.id)).rejects.toMatchObject({
      code: "SCHEDULE_NOT_FOUND",
    });
  });
  it("advanceRecurring ignores one-off rows and disables unmatchable crons", async () => {
    const once = row({ kind: "once" });
    const dbOnce = stubDb({});
    await advanceRecurring(dbOnce, once, new Date());
    const broken = row({ kind: "recurring", cron_expr: "0 0 30 2 *" });
    const dbBroken = stubDb({});
    await advanceRecurring(dbBroken, broken, new Date("2026-09-12T00:00:00Z"));
  });
});
