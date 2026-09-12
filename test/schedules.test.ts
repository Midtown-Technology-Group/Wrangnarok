// SPDX-License-Identifier: AGPL-3.0
// TRG-01 pure schedule contracts (issue #137): cron validation, timezone
// labels, window math, key derivation, and the tick scan/promotion skeleton
// over a stub promoter. No runtime binding: runs in plain Vitest.
import { describe, expect, it } from "vitest";
import {
  cronMatches,
  firstWindow,
  nextWindow,
  parseCronExpression,
  parseScheduleBody,
  parseTimezone,
  previewWindows,
  runTick,
  scheduleKey,
  windowOf,
  type ScheduleRow,
} from "../src/schedules";
import { echoSaga, helloSaga } from "../src/domain";

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
