// SPDX-License-Identifier: AGPL-3.0
// TRG-01 branch coverage (issue #137): parser guards, timezone math, and
// failure paths not exercised by the CRUD/lifecycle/tick suites. Pure unit
// tests where possible; workerd only where D1 is required.
import { describe, expect, it } from "vitest";
import { helloSaga } from "../src/domain";
import {
  currentWindow,
  deliveryForWindow,
  listSchedules,
  loadSchedule,
  nextCronDue,
  parseCron,
  parseRunAt,
  parseScheduleBody,
  parseScheduleInput,
  parseScheduleName,
  parseScheduleTimezone,
  promoteDueSchedules,
  promoteWindow,
} from "../src/schedules";
import type { ScheduleRow } from "../src/schedules";
import type { submit } from "../src/executions";
import { SAGA_DEFINITIONS } from "../src/sagas";

describe("TRG-01 branch coverage", () => {
  it("rejects malformed schedule names", () => {
    expect(() => parseScheduleName("UPPER")).toThrow(/Not found/);
    expect(() => parseScheduleName("has space")).toThrow(/Not found/);
    expect(parseScheduleName("ok-name-01")).toBe("ok-name-01");
  });
  it("validates cron ranges, lists, and steps", () => {
    expect(parseCron("5,10,15 9 * * *")).toBe("5,10,15 9 * * *");
    expect(parseCron("0 0 1 1 0")).toBe("0 0 1 1 0");
    expect(parseCron("*/30 * * * *")).toBe("*/30 * * * *");
    expect(() => parseCron("0-100 * * * *")).toThrow(/out of range/);
    // Weekday 7 aliases Sunday for matching.
    expect(nextCronDue("0 0 * * 7", "UTC", new Date("2026-09-12T10:00:00.000Z"))).toBe("2026-09-13T00:00:00.000Z");
    expect(nextCronDue("0 0 * * 0", "UTC", new Date("2026-09-12T10:00:00.000Z"))).toBe("2026-09-13T00:00:00.000Z");
    // Step cadences advance arithmetically; garbage fails closed fast.
    expect(nextCronDue("*/30 * * * *", "UTC", new Date("2026-09-12T10:05:00.000Z"))).toBe("2026-09-12T10:30:00.000Z");
    expect(() => nextCronDue("nope * * * *", "UTC")).toThrow(/5-field/);
    expect(() => nextCronDue("* * * *", "UTC")).toThrow(/5-field/);
    // Zero (or otherwise non-positive) steps never reach the matcher: a
    // `value % 0` matcher would spin the full one-year horizon, so the
    // parser rejects fast with 400 INVALID_SCHEDULE instead.
    expect(() => parseCron("*/0 * * * *")).toThrow(/5-field/);
    expect(() => nextCronDue("*/0 * * * *", "UTC")).toThrow(/5-field/);
  });
  it("matches wall-clock time in named timezones", () => {
    // 09:00 in New York is 13:00 UTC (EDT, September).
    expect(nextCronDue("0 9 * * *", "America/New_York", new Date("2026-09-12T12:00:00.000Z"))).toBe(
      "2026-09-12T13:00:00.000Z",
    );
    expect(parseScheduleTimezone("America/New_York")).toBe("America/New_York");
  });
  it("rejects malformed schedule bodies", () => {
    expect(() => parseScheduleBody(null, SAGA_DEFINITIONS)).toThrow(/JSON object/);
    expect(() => parseScheduleBody([], SAGA_DEFINITIONS)).toThrow(/JSON object/);
    expect(() => parseScheduleBody({}, SAGA_DEFINITIONS)).toThrow(/lowercase/);
    expect(() => parseScheduleBody({ name: "x", sagaId: "not-a-uuid" }, SAGA_DEFINITIONS)).toThrow(/stable Saga UUID/);
    expect(() => parseScheduleBody({ name: "x", sagaId: 42 }, SAGA_DEFINITIONS)).toThrow(/stable Saga UUID/);
    expect(() =>
      parseScheduleBody({ name: "x", sagaId: "395e15f0-3627-41f6-8922-008ce37e3b00" }, SAGA_DEFINITIONS),
    ).toThrow(/known Saga UUID/);
    expect(() => parseScheduleBody({ name: "x", sagaId: helloSaga.id }, SAGA_DEFINITIONS)).toThrow(/must be/);
    expect(() => parseScheduleBody({ name: "x", sagaId: helloSaga.id, kind: "whenever" }, SAGA_DEFINITIONS)).toThrow(
      /must be/,
    );
    expect(() =>
      parseScheduleBody({ name: "x", sagaId: helloSaga.id, kind: "recurring", enabled: "yes" }, SAGA_DEFINITIONS),
    ).toThrow(/boolean/);
    // One-off due instants validate at create time: ISO strings pass the
    // body gate and fail closed in parseRunAt.
    expect(
      parseScheduleBody({ name: "x", sagaId: helloSaga.id, kind: "one-off", runAt: "not-a-date" }, SAGA_DEFINITIONS)
        .runAt,
    ).toBe("not-a-date");
    expect(() => parseRunAt("not-a-date")).toThrow(/ISO run-at/);
    expect(() => parseRunAt(42)).toThrow(/ISO run-at/);
    expect(() => parseRunAt("")).toThrow(/ISO run-at/);
    expect(parseRunAt("2026-09-12T10:00:00.000Z")).toBe("2026-09-12T10:00:00.000Z");
    const parsed = parseScheduleBody(
      { name: "branch-probe", sagaId: helloSaga.id, kind: "recurring", cron: "* * * * *", enabled: false },
      SAGA_DEFINITIONS,
    );
    expect(parsed.enabled).toBe(false);
  });
  it("formats the current window with its default cursor", () => {
    expect(currentWindow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
  it("bounds schedule input and resolves saga fallbacks", () => {
    // The 4096-byte bound applies after the Saga parse gate: a permissive
    // parse still fails closed on oversized shaped input.
    const permissive = {
      id: helloSaga.id,
      name: "hello",
      revision: "hello-v1",
      description: "stub",
      parse: (value: unknown) => value,
    };
    expect(() => parseScheduleInput({ message: "x".repeat(5000) }, permissive)).toThrow(/4096-byte/);
    expect(parseScheduleInput({ message: "hi" }, permissive)).toEqual({ message: "hi" });
    expect(parseScheduleInput(undefined, permissive)).toEqual({});
  });
});

describe("TRG-01 pre-dispatch fence (fake D1, no workerd)", () => {
  const ORG = "00000000-0000-4000-8000-000000000001";
  const USER = "00000000-0000-4000-8000-000000000002";

  function scheduleRow(): ScheduleRow {
    const stamp = new Date().toISOString();
    return {
      id: "schedule-fence-probe",
      org_id: ORG,
      name: "fence-probe",
      saga_id: helloSaga.id,
      kind: "recurring",
      cron: "* * * * *",
      timezone: "UTC",
      enabled: 1,
      input_json: JSON.stringify({ name: "sched" }),
      run_as_user_id: USER,
      run_at: null,
      next_due_at: stamp,
      last_window: null,
      created_at: stamp,
      updated_at: stamp,
    };
  }

  interface FenceStore {
    schedule?: ScheduleRow | null;
    fenceThrows?: unknown;
    org?: Record<string, unknown> | null;
    user?: Record<string, unknown> | null;
    membership?: Record<string, unknown> | null;
    authorityThrows?: unknown;
  }

  function fenceDb(store: FenceStore): D1Database {
    return {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => {
            if (sql.startsWith("SELECT * FROM schedules WHERE id=")) {
              if (store.fenceThrows !== undefined) throw store.fenceThrows;
              return (store.schedule ?? null) as unknown;
            }
            if (store.authorityThrows !== undefined) throw store.authorityThrows;
            if (sql.startsWith("SELECT * FROM organizations")) return (store.org ?? null) as unknown;
            if (sql.startsWith("SELECT * FROM users")) return (store.user ?? null) as unknown;
            if (sql.startsWith("SELECT * FROM org_memberships")) return (store.membership ?? null) as unknown;
            if (sql.startsWith("SELECT execution_id FROM schedule_deliveries")) return null;
            throw new Error(`unexpected query: ${sql}`);
          },
          run: async () => ({ success: true, meta: { changes: 1 } }),
        }),
      }),
    } as unknown as D1Database;
  }

  function stubSubmit(): { calls: () => number; submit: typeof submit } {
    let calls = 0;
    const submitFn: typeof submit = (async () => {
      calls += 1;
      return { executionId: "stub-execution", replayed: false, statusUrl: "/api/executions/stub-execution" };
    }) as typeof submit;
    return { calls: () => calls, submit: submitFn };
  }

  const ACTIVE = {
    org: { id: ORG, status: "active" },
    user: { user_id: USER, status: "active" },
    membership: { org_id: ORG, user_id: USER, status: "active" },
  };

  it("promotes when the re-read row and run-as authority are live", async () => {
    // AUTH-02 S3 (issue #143): promoteWindow enforces the saga execute
    // grant at dispatch, so a live fixture needs live authority — the org
    // admin bypass here — not just live lifecycle rows.
    const stub = stubSubmit();
    const report = await promoteWindow(
      fenceDb({ schedule: scheduleRow(), ...ACTIVE, membership: { ...ACTIVE.membership, role: "admin" } }),
      { DB: fenceDb({}) } as never,
      scheduleRow(),
      "2026-09-12T10:01",
      SAGA_DEFINITIONS,
      stub.submit,
    );
    expect(stub.calls()).toBe(1);
    expect(report).toMatchObject({ scheduleName: "fence-probe", window: "2026-09-12T10:01" });
  });
  it("reports a deleted row without touching submit", async () => {
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({ schedule: null, ...ACTIVE }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toMatchObject({ code: "SCHEDULE_GONE" });
    expect(stub.calls()).toBe(0);
  });
  it("rethrows a fence re-read backend failure instead of reporting a gone row (issue #137)", async () => {
    // A D1 fault on the pre-dispatch re-read is a tick failure, not a
    // deletion: the tick reports failure so the window retries instead of
    // being answered as gone. No dispatch happens either way.
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({ schedule: scheduleRow(), fenceThrows: new Error("D1 hiccup"), ...ACTIVE }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toThrow("D1 hiccup");
    expect(stub.calls()).toBe(0);
  });
  it("lets an instance admin dispatch without membership rows", async () => {
    const stub = stubSubmit();
    const report = await promoteWindow(
      fenceDb({ schedule: scheduleRow(), org: null, user: null, membership: null }),
      { DB: fenceDb({}), ADMIN_USER_IDS: USER } as never,
      scheduleRow(),
      "2026-09-12T10:01",
      SAGA_DEFINITIONS,
      stub.submit,
    );
    expect(stub.calls()).toBe(1);
    expect(report.scheduleName).toBe("fence-probe");
  });
  it("fails closed when the run-as org is gone", async () => {
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({ schedule: scheduleRow(), org: null, user: ACTIVE.user, membership: ACTIVE.membership }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
    expect(stub.calls()).toBe(0);
  });
  it("treats pre-migration rows without a status column as active", async () => {
    // Covers the `?? "active"` fallbacks: rows predating the status column
    // read as active, so old databases fence on membership, not on shape.
    // AUTH-02 S3 (issue #143): the org/user rows still carry no status (the
    // fallback under test); the membership carries the admin role so the
    // live fixture also holds dispatch authority under the saga execute
    // grant fence.
    const stub = stubSubmit();
    const report = await promoteWindow(
      fenceDb({
        schedule: scheduleRow(),
        org: { id: ORG },
        user: { user_id: USER },
        membership: { ...ACTIVE.membership, role: "admin" },
      }),
      { DB: fenceDb({}) } as never,
      scheduleRow(),
      "2026-09-12T10:01",
      SAGA_DEFINITIONS,
      stub.submit,
    );
    expect(stub.calls()).toBe(1);
    expect(report.scheduleName).toBe("fence-probe");
  });
  it("fails closed when the run-as user row is gone", async () => {
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({ schedule: scheduleRow(), org: ACTIVE.org, user: null, membership: ACTIVE.membership }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
    expect(stub.calls()).toBe(0);
  });
  it("fails closed when the run-as membership row is gone", async () => {
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({ schedule: scheduleRow(), org: ACTIVE.org, user: ACTIVE.user, membership: null }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
    expect(stub.calls()).toBe(0);
  });
  it("never activates an invited membership from the tick", async () => {
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({
          schedule: scheduleRow(),
          org: ACTIVE.org,
          user: ACTIVE.user,
          membership: { org_id: ORG, user_id: USER, status: "invited" },
        }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_SUSPENDED" });
    expect(stub.calls()).toBe(0);
  });
  it("fails loud when the authority store predates migration 0007", async () => {
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({ schedule: scheduleRow(), authorityThrows: new Error("no such table: organizations") }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toMatchObject({ code: "ORG_STORE_NOT_MIGRATED" });
    expect(stub.calls()).toBe(0);
  });
  it("reads pre-migration absence on missing tables, never on backend faults (issue #137)", async () => {
    // The isMissingTable-true branches: a store predating the schedules
    // tables reads as absence (null / empty), preserving the pre-migration
    // contract. Real faults rethrow (covered by the sibling test above).
    const missingDb = {
      prepare() {
        throw new Error("D1_ERROR: no such table: schedules: SQLITE_ERROR");
      },
    } as unknown as D1Database;
    await expect(loadSchedule(missingDb, "00000000-0000-4000-8000-000000000001", "nope")).resolves.toBeNull();
    await expect(
      listSchedules(
        missingDb,
        { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" },
        SAGA_DEFINITIONS,
      ),
    ).resolves.toEqual([]);
    await expect(deliveryForWindow(missingDb, "sched", "2026-09-12T10:00")).resolves.toBeNull();
    await expect(
      promoteDueSchedules(
        missingDb,
        { DB: missingDb, HELLO_WORKFLOW: {} } as never,
        SAGA_DEFINITIONS,
        (async () => {
          throw new Error("must not dispatch");
        }) as never,
        new Date(),
      ),
    ).resolves.toEqual({ promoted: [], skipped: [] });
  });

  it("rethrows tick-scan and delivery-lookup backend faults (issue #137)", async () => {
    // The due-scan rethrow branch: a broken tick scan fails the tick
    // instead of reporting an empty schedule set.
    const brokenDb = {
      prepare() {
        throw new Error("D1 backend failure: connection reset");
      },
    } as unknown as D1Database;
    await expect(
      promoteDueSchedules(
        brokenDb,
        { DB: brokenDb, HELLO_WORKFLOW: {} } as never,
        SAGA_DEFINITIONS,
        (async () => {
          throw new Error("must not dispatch");
        }) as never,
        new Date(),
      ),
    ).rejects.toThrow("D1 backend failure");
    // The delivery-lookup rethrow branch: a broken read fails loud
    // instead of answering a missing delivery.
    await expect(deliveryForWindow(brokenDb, "sched", "2026-09-12T10:00")).rejects.toThrow("D1 backend failure");
  });

  it("rethrows non-table authority failures instead of masking them", async () => {
    const stub = stubSubmit();
    await expect(
      promoteWindow(
        fenceDb({ schedule: scheduleRow(), authorityThrows: new Error("connection reset") }),
        { DB: fenceDb({}) } as never,
        scheduleRow(),
        "2026-09-12T10:01",
        SAGA_DEFINITIONS,
        stub.submit,
      ),
    ).rejects.toThrow("connection reset");
    expect(stub.calls()).toBe(0);
  });
});
