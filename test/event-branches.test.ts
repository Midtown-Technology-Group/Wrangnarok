// SPDX-License-Identifier: AGPL-3.0
// TRG-03 S1 (issue #139): branch-coverage companion to test/events.test.ts.
// Unit-level pins for every validation and fallback branch in src/events.ts
// that the end-to-end suite does not force: parser edges, registry creation
// conflicts, pre-migration fallbacks, emit identity with execution
// attribution, history bounds, and best-effort delivery silence paths.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import type { Principal } from "../src/domain";
import {
  createEventSource,
  deleteEventSource,
  emitEvent,
  listEvents,
  listEventSources,
  loadEventSource,
  parseEventId,
  parseEventPayload,
  parseEventSourceKind,
  parseEventSourceName,
  parseEventSourceRef,
  parseTopic,
  recordSourceDelivery,
  setEventSourceEnabled,
  type EventSourceKind,
} from "../src/events";
import { applyFullMigrations } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG = "00000000-0000-4000-8000-000000000001";
const LAB_USER = "00000000-0000-4000-8000-000000000002";
const UUID_REF = "00000000-0000-4000-8000-000000000002";
const HEX_REF = "a".repeat(64);
const CALLER: Principal = { userId: LAB_USER, orgId: ORG };
const LAB = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

function authed(path: string, method: string, body?: unknown): Request {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...LAB },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Wrap the test D1 binding so the listed statement methods on statements
 * matching `match` reject asynchronously with `fault`, exactly like a
 * query-specific D1 failure. Every other statement delegates to the real
 * tables, so the fault proves fail-closed (or best-effort silent) behavior
 * the missing-table case cannot model. */
function faultingDb(match: (sql: string) => boolean, fault: unknown, methods: readonly string[]): D1Database {
  const wrapStatement = (stmt: object): object =>
    new Proxy(stmt, {
      get(statementTarget, property) {
        if (typeof property === "string" && methods.includes(property)) {
          return () => Promise.reject(fault);
        }
        const value = (statementTarget as Record<string | symbol, unknown>)[property];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...args: unknown[]) => unknown).apply(statementTarget, args);
          return typeof out === "object" && out !== null ? wrapStatement(out) : out;
        };
      },
    });
  return new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          const stmt = (target.prepare as (sql: string, ...rest: unknown[]) => object)(sql, ...rest);
          return match(sql) ? wrapStatement(stmt) : stmt;
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[property];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await applyFullMigrations(bindings.DB, true);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("event branch tests must not fetch");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("pins source-name, kind, and ref parsing", () => {
  expect(parseEventSourceName("orders")).toBe("orders");
  try {
    parseEventSourceName("BAD_NAME");
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND" });
  }

  expect(parseEventSourceKind("schedule")).toBe("schedule");
  expect(parseEventSourceKind("webhook")).toBe("webhook");
  expect(parseEventSourceKind("topic")).toBe("topic");
  for (const bad of ["queue", null, undefined, 42]) {
    expect(() => parseEventSourceKind(bad)).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_EVENT_SOURCE" }),
    );
  }

  expect(parseEventSourceRef(undefined)).toBeNull();
  expect(parseEventSourceRef(null)).toBeNull();
  expect(parseEventSourceRef(UUID_REF)).toBe(UUID_REF);
  expect(parseEventSourceRef(HEX_REF)).toBe(HEX_REF);
  expect(() => parseEventSourceRef("not-a-uuid")).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SOURCE" }));
  expect(() => parseEventSourceRef(42)).toThrow(expect.objectContaining({ code: "INVALID_EVENT_SOURCE" }));
});

it("pins topic, event-id, and payload parsing", () => {
  expect(parseTopic("vendor.order.created")).toBe("vendor.order.created");
  for (const bad of ["orders", "Vendor.Order", "", 42, null]) {
    expect(() => parseTopic(bad)).toThrow(expect.objectContaining({ code: "INVALID_EVENT" }));
  }

  expect(parseEventId("evt-001")).toBe("evt-001");
  for (const bad of [undefined, null, "", "e".repeat(129), "bad id!", 42]) {
    expect(() => parseEventId(bad)).toThrow(expect.objectContaining({ code: "INVALID_EVENT" }));
  }

  expect(parseEventPayload({ order: 7 })).toBe('{"order":7}');
  expect(parseEventPayload(undefined)).toBe("null");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => parseEventPayload(circular)).toThrow(expect.objectContaining({ code: "INVALID_EVENT" }));
  try {
    parseEventPayload({ blob: "x".repeat(5000) });
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({ status: 413, code: "INVALID_EVENT" });
  }
});

it("validates registry creation inputs and reports conflicts", async () => {
  await expect(createEventSource(bindings.DB, CALLER, { name: 42, kind: "topic" })).rejects.toMatchObject({
    code: "INVALID_EVENT_SOURCE",
  });
  await expect(createEventSource(bindings.DB, CALLER, { name: undefined, kind: "topic" })).rejects.toMatchObject({
    code: "INVALID_EVENT_SOURCE",
  });
  await expect(createEventSource(bindings.DB, CALLER, { name: "BAD", kind: "topic" })).rejects.toMatchObject({
    code: "INVALID_EVENT_SOURCE",
  });

  const bare = await createEventSource(bindings.DB, CALLER, { name: "br-bare", kind: "topic" });
  expect(bare).toMatchObject({ name: "br-bare", kind: "topic", refId: null, enabled: true });
  const uuidBacked = await createEventSource(bindings.DB, CALLER, {
    name: "br-uuid",
    kind: "webhook",
    refId: UUID_REF,
  });
  expect(uuidBacked.refId).toBe(UUID_REF);
  const hexBacked = await createEventSource(bindings.DB, CALLER, {
    name: "br-hex",
    kind: "schedule",
    refId: HEX_REF,
  });
  expect(hexBacked.refId).toBe(HEX_REF);

  await expect(createEventSource(bindings.DB, CALLER, { name: "br-bare", kind: "topic" })).rejects.toMatchObject({
    status: 409,
    code: "EVENT_SOURCE_EXISTS",
  });

  expect(await loadEventSource(bindings.DB, "00000000-0000-4000-8000-000000000099", "br-bare")).toBeNull();
  expect((await listEventSources(bindings.DB, ORG)).map((entry) => entry.name)).toEqual(
    expect.arrayContaining(["br-bare", "br-hex", "br-uuid"]),
  );
});

it("maps unknown registry rows to 404 and survives pre-migration reads", async () => {
  await expect(setEventSourceEnabled(bindings.DB, CALLER, "br-ghost", false)).rejects.toMatchObject({
    status: 404,
    code: "NOT_FOUND",
  });
  await expect(deleteEventSource(bindings.DB, CALLER, "br-ghost")).rejects.toMatchObject({
    status: 404,
    code: "NOT_FOUND",
  });
  await expect(listEvents(bindings.DB, ORG, "br-ghost", 50)).rejects.toMatchObject({
    status: 404,
    code: "NOT_FOUND",
  });

  // Pre-migration databases read as empty, never as failure.
  await bindings.DB.exec('DROP TABLE "event_sources"');
  expect(await listEventSources(bindings.DB, ORG)).toEqual([]);
});

it("degrades missing log tables to empty and rethrows real backend faults", async () => {
  await createEventSource(bindings.DB, CALLER, { name: "br-legacy", kind: "topic" });
  await bindings.DB.exec('DROP TABLE "events"');
  expect(await listEvents(bindings.DB, ORG, "br-legacy", 50)).toEqual([]);

  const readFault = faultingDb(
    (sql) => sql.includes("event_sources") && sql.trimStart().startsWith("SELECT"),
    new Error("injected source-list read fault"),
    ["all"],
  );
  await expect(listEventSources(readFault, ORG)).rejects.toThrow("injected source-list read fault");

  const exoticFault = faultingDb(
    (sql) => sql.includes("event_sources") && sql.trimStart().startsWith("SELECT"),
    "string-fault",
    ["all"],
  );
  await expect(listEventSources(exoticFault, ORG)).rejects.toBe("string-fault");

  const logFault = faultingDb(
    (sql) => sql.includes("FROM events") && sql.trimStart().startsWith("SELECT"),
    new Error("injected log read fault"),
    ["all"],
  );
  await expect(listEvents(logFault, ORG, "br-legacy", 50)).rejects.toThrow("injected log read fault");
});

it("emits with execution attribution and bounds history", async () => {
  await createEventSource(bindings.DB, CALLER, { name: "br-exec", kind: "topic" });

  // Payloads are optional: an omitted payload logs JSON null.
  const bare = await emitEvent(bindings.DB, CALLER, "br-exec", { eventId: "e-nopayload", topic: "test.feed" });
  expect(bare.replayed).toBe(false);
  expect(bare.event.payload).toBeNull();

  const execId = "b".repeat(64);
  const first = await emitEvent(
    bindings.DB,
    CALLER,
    "br-exec",
    { eventId: "e-attributed", topic: "test.feed", payload: { n: 1 } },
    execId,
  );
  expect(first.replayed).toBe(false);
  expect(first.event.executionId).toBe(execId);

  const replay = await emitEvent(
    bindings.DB,
    CALLER,
    "br-exec",
    { eventId: "e-attributed", topic: "test.feed", payload: { n: 1 } },
    execId,
  );
  expect(replay.replayed).toBe(true);
  expect(replay.event.executionId).toBe(execId);

  // Same event ID with different execution attribution forks: 409.
  await expect(
    emitEvent(bindings.DB, CALLER, "br-exec", { eventId: "e-attributed", topic: "test.feed", payload: { n: 1 } }),
  ).rejects.toMatchObject({ status: 409, code: "EVENT_CONFLICT" });
  // Same event ID with a different topic forks as well.
  await expect(
    emitEvent(
      bindings.DB,
      CALLER,
      "br-exec",
      { eventId: "e-attributed", topic: "test.other", payload: { n: 1 } },
      execId,
    ),
  ).rejects.toMatchObject({ code: "EVENT_CONFLICT" });

  // History bounds: a non-positive limit still returns the newest row, and
  // an oversized limit caps instead of failing.
  const clamped = await listEvents(bindings.DB, ORG, "br-exec", 0);
  expect(clamped.map((entry) => entry.eventId)).toEqual(["e-attributed"]);
  const capped = await listEvents(bindings.DB, ORG, "br-exec", 999);
  expect(capped.map((entry) => entry.eventId)).toEqual(["e-attributed", "e-nopayload"]);
});

it("treats a vanished prior row as conflict, never silent replay", async () => {
  const sourceRow = {
    id: "src-vanished",
    org_id: ORG,
    name: "br-vanished",
    kind: "topic",
    ref_id: null,
    enabled: 1,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const stubDb = {
    prepare: (sql: string) => ({
      bind: () => ({
        run: async () => ({ meta: { changes: sql.startsWith("INSERT") ? 0 : 0 } }),
        first: async () => (sql.includes("event_sources") ? sourceRow : null),
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;
  // The insert lost the race (0 changes) yet no prior row is visible: the
  // log must refuse with 409 rather than report a replay it never read.
  await expect(
    emitEvent(stubDb, CALLER, "br-vanished", { eventId: "e-lost", topic: "test.feed", payload: {} }),
  ).rejects.toMatchObject({ status: 409, code: "EVENT_CONFLICT" });
});

it("keeps delivery appends best-effort and idempotent", async () => {
  // No observing source: silence, never a throw.
  await recordSourceDelivery(bindings.DB, ORG, "webhook", UUID_REF, {
    eventId: "wh-miss",
    topic: "webhook.delivered",
    payloadJson: "{}",
    executionId: "c".repeat(64),
  });

  await createEventSource(bindings.DB, CALLER, { name: "br-deliver", kind: "webhook", refId: UUID_REF });
  const delivery = {
    eventId: "wh-1",
    topic: "webhook.delivered",
    payloadJson: '{"ok":true}',
    executionId: "c".repeat(64),
  };
  await recordSourceDelivery(bindings.DB, ORG, "webhook", UUID_REF, delivery);
  // Redelivery converges: the deterministic key collapses the duplicate.
  await recordSourceDelivery(bindings.DB, ORG, "webhook", UUID_REF, delivery);
  // A disabled source fences appends while keeping history.
  await setEventSourceEnabled(bindings.DB, CALLER, "br-deliver", false);
  await recordSourceDelivery(bindings.DB, ORG, "webhook", UUID_REF, { ...delivery, eventId: "wh-2" });
  const history = await listEvents(bindings.DB, ORG, "br-deliver", 50);
  expect(history.map((entry) => entry.eventId)).toEqual(["wh-1"]);
  expect(history[0]).toMatchObject({ topic: "webhook.delivered", executionId: "c".repeat(64) });

  // Backend faults on the lookup or the append resolve to silence: the log
  // never gates delivery itself.
  const lookupFault = faultingDb(
    (sql) => sql.includes("event_sources") && sql.trimStart().startsWith("SELECT"),
    new Error("injected delivery lookup fault"),
    ["first"],
  );
  await expect(
    recordSourceDelivery(lookupFault, ORG, "webhook", UUID_REF, { ...delivery, eventId: "wh-3" }),
  ).resolves.toBeUndefined();
  const appendFault = faultingDb(
    (sql) => sql.includes("INSERT INTO events"),
    new Error("injected delivery append fault"),
    ["run"],
  );
  await expect(
    recordSourceDelivery(appendFault, ORG, "webhook", UUID_REF, { ...delivery, eventId: "wh-4" }),
  ).resolves.toBeUndefined();
});

it("answers unknown registry routes with 404 and rejects bad create names", async () => {
  expect(await worker.fetch(authed("/api/event-sources/br-ghost/events", "GET"), bindings).then((r) => r.status)).toBe(
    404,
  );
  expect(
    await worker.fetch(authed("/api/event-sources/br-ghost/enable", "POST", {}), bindings).then((r) => r.status),
  ).toBe(404);
  expect(await worker.fetch(authed("/api/event-sources/br-ghost", "DELETE"), bindings).then((r) => r.status)).toBe(404);
  // Unknown name shapes answer 404 at the route pre-check (never a leak),
  // while createEventSource itself reports 400 for the same input.
  const badName = await worker.fetch(authed("/api/event-sources", "POST", { name: "BAD", kind: "topic" }), bindings);
  expect(badName.status).toBe(404);
  expect(await badName.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
});

it("pins delivery kinds as distinct registry identities", async () => {
  const kinds: EventSourceKind[] = ["schedule", "webhook", "topic"];
  for (const kind of kinds) {
    const created = await createEventSource(bindings.DB, CALLER, { name: `br-kind-${kind}`, kind });
    expect(created.kind).toBe(kind);
  }
  expect((await listEventSources(bindings.DB, ORG)).map((entry) => entry.kind).sort()).toEqual(
    expect.arrayContaining(["schedule", "topic", "webhook"]),
  );
});
