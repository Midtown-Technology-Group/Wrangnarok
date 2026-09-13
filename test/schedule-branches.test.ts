// SPDX-License-Identifier: AGPL-3.0
// TRG-01 branch coverage (issue #137): parser guards, timezone math, and
// failure paths not exercised by the CRUD/lifecycle/tick suites. Pure unit
// tests where possible; workerd only where D1 is required.
import { describe, expect, it } from "vitest";
import { helloSaga } from "../src/domain";
import {
  currentWindow,
  nextCronDue,
  parseCron,
  parseRunAt,
  parseScheduleBody,
  parseScheduleInput,
  parseScheduleName,
  parseScheduleTimezone,
} from "../src/schedules";
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
