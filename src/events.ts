// SPDX-License-Identifier: AGPL-3.0
// TRG-03 S1 (issue #139): event-source registry plus a durable,
// Organization-scoped event log.
//
// Upstream inventory (pins at gobifrost/bifrost@3543c7e, per issue #139):
// - `api/src/routers/events.py`, `api/src/models/contracts/events.py`,
//   `api/src/services/events/processor.py`, `docs/events/topics.md`.
// The local vendor checkout is an uninitialized submodule, so those bodies
// were not re-inspected here; the mapping below rests on ADR 012/018 and
// `docs/upstream-spec.md` finding 7 (events are source-plus-subscription).
//
// Cloudflare mapping (S1 only): an EventSource is persisted environment
// state (upstream finding 3, never Saga source metadata): one org-scoped row
// binding a name to a kind (`schedule`|`webhook`|`topic`) plus an optional
// `ref_id` pointing at the backing schedule/endpoint row. The `events` table
// is an append-only per-source log keyed by caller-supplied deterministic
// event IDs: same (source, event) replays, mismatched duplicates answer 409,
// and schedule promotion / endpoint delivery append best-effort delivery
// rows (topics `schedule.delivered` / `webhook.delivered`) that never fail
// the delivery itself. Subscriptions, fan-out, operator replay, and built-in
// platform events are explicitly deferred to later TRG-03 slices: this file
// owns registration plus the log, nothing downstream. No Queue, no Durable
// Object, no second auth or execution path.
import { BODY_LIMIT, EXECUTION_ID, Fault, hash, UUID } from "./domain";
import type { Principal } from "./domain";

export const EVENT_SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_EVENT_CHAR = /^[a-zA-Z0-9._:-]+$/;
/** Caller-supplied delivery/event IDs: deterministic, 128 chars max of the
 * shared safe alphabet (same bound as endpoint vendor event IDs). */
export const EVENT_ID_MAX = 128;
/** Topics are dot-namespaced (`schedule.delivered`, `vendor.order.created`)
 * so a later subscription slice can match on the producer namespace. Bare
 * single-segment topics are rejected: every event declares its producer. */
export const EVENT_TOPIC = /^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,31})+$/;
/** Delivery history stays bounded per read (Free-tier posture): newest first,
 * hard cap, no keyset pagination until a subscriber slice needs it. */
export const EVENT_LIST_LIMIT = 50;
/** System topics appended by the schedule/endpoint delivery paths. Operator
 * emits may use any dot-namespaced topic, including these. */
export const SCHEDULE_DELIVERED_TOPIC = "schedule.delivered";
export const WEBHOOK_DELIVERED_TOPIC = "webhook.delivered";

export type EventSourceKind = "schedule" | "webhook" | "topic";

export interface EventSourceRow {
  id: string;
  org_id: string;
  name: string;
  kind: EventSourceKind;
  ref_id: string | null;
  enabled: number;
  created_at: string;
}

export interface EventSourceSummary {
  id: string;
  name: string;
  kind: EventSourceKind;
  refId: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface EventSummary {
  eventId: string;
  topic: string;
  payload: unknown;
  executionId: string | null;
  createdAt: string;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Parse a source name from the route. Unknown shapes answer 404, never a leak. */
export function parseEventSourceName(name: string): string {
  if (!EVENT_SOURCE_NAME.test(name)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return name;
}

export function parseEventSourceKind(value: unknown): EventSourceKind {
  if (value === "schedule" || value === "webhook" || value === "topic") return value;
  throw invalid("INVALID_EVENT_SOURCE", "Event source kind must be schedule, webhook, or topic.");
}

/** A backing-row reference is opaque in S1 (row-ID shape only): it names the
 * schedule (deterministic 64-hex) or endpoint (UUID) row the source
 * observes, and the S2 subscription slice binds it. Existence is
 * intentionally not enforced here so registration never couples to the
 * schedule/endpoint modules. */
export function parseEventSourceRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || (!UUID.test(value) && !EXECUTION_ID.test(value))) {
    throw invalid("INVALID_EVENT_SOURCE", "Event source ref must be a schedule or endpoint row ID when present.");
  }
  return value;
}

export function parseTopic(value: unknown): string {
  if (typeof value !== "string" || !EVENT_TOPIC.test(value)) {
    throw invalid("INVALID_EVENT", "Event topic must be dot-namespaced lowercase (for example schedule.delivered).");
  }
  return value;
}

export function parseEventId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > EVENT_ID_MAX || !SAFE_EVENT_CHAR.test(value)) {
    throw invalid("INVALID_EVENT", "Event ID must be 1 to 128 safe-alphabet characters.");
  }
  return value;
}

/** Payloads are serializable JSON bounded like every other stored input
 * (BODY_LIMIT): the log is replay visibility, never a blob store. */
export function parseEventPayload(value: unknown): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value ?? null);
  } catch {
    throw invalid("INVALID_EVENT", "Event payload must be serializable JSON.");
  }
  if (encoded.length > BODY_LIMIT) {
    throw invalid("INVALID_EVENT", "Event payload must fit within 4096 bytes.", 413);
  }
  return encoded;
}

/** Exact-org visibility: foreign rows resolve to null so routes answer 404. */
export async function loadEventSource(db: D1Database, orgId: string, name: string): Promise<EventSourceRow | null> {
  const row = await db
    .prepare('SELECT * FROM "event_sources" WHERE org_id=? AND name=?')
    .bind(orgId, name)
    .first<EventSourceRow>();
  return row ?? null;
}

function toSummary(row: EventSourceRow): EventSourceSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    refId: row.ref_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export interface CreateEventSourceInput {
  readonly name: unknown;
  readonly kind: unknown;
  readonly refId?: unknown;
}

/** Register one org-scoped source. The deterministic ID mirrors schedules:
 * re-creating the same name converges on the same row identity, and any
 * insert conflict (same name, or a colliding ID) answers 409, never a fork. */
export async function createEventSource(
  db: D1Database,
  caller: Principal,
  input: CreateEventSourceInput,
): Promise<EventSourceSummary> {
  const name = typeof input.name === "string" ? input.name : "";
  if (!EVENT_SOURCE_NAME.test(name)) {
    throw invalid("INVALID_EVENT_SOURCE", "Event source names are 1 to 64 lowercase letters, digits, or dashes.");
  }
  const kind = parseEventSourceKind(input.kind);
  const refId = parseEventSourceRef(input.refId);
  const id = await hash(JSON.stringify(["wrangnarok.event-source.v1", caller.orgId, name]));
  const stamp = new Date().toISOString();
  try {
    await db
      .prepare("INSERT INTO event_sources(id,org_id,name,kind,ref_id,enabled,created_at) VALUES (?,?,?,?,?,1,?)")
      .bind(id, caller.orgId, name, kind, refId, stamp)
      .run();
  } catch {
    throw invalid("EVENT_SOURCE_EXISTS", "An event source with this name already exists.", 409);
  }
  return { id, name, kind, refId, enabled: true, createdAt: stamp };
}

export async function listEventSources(db: D1Database, orgId: string): Promise<EventSourceSummary[]> {
  let rows: EventSourceRow[];
  try {
    const result = await db
      .prepare('SELECT * FROM "event_sources" WHERE org_id=? ORDER BY name ASC')
      .bind(orgId)
      .all<EventSourceRow>();
    rows = result.results;
  } catch (error) {
    // Pre-migration absence reads as empty; a real backend fault rethrows
    // so discovery never answers failure as a successful empty list.
    if (error instanceof Error && /no such table/i.test(error.message)) return [];
    throw error;
  }
  return rows.map(toSummary);
}

/** Disable (or re-enable) one source. Disabling fences future emits and
 * delivery appends; already-logged events keep their rows and history. */
export async function setEventSourceEnabled(
  db: D1Database,
  caller: Principal,
  name: string,
  enabled: boolean,
): Promise<EventSourceSummary> {
  const row = await loadEventSource(db, caller.orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  await db
    .prepare("UPDATE event_sources SET enabled=? WHERE id=?")
    .bind(enabled ? 1 : 0, row.id)
    .run();
  const updated = await loadEventSource(db, caller.orgId, name);
  if (!updated) throw new Fault(404, "NOT_FOUND", "Not found.");
  return toSummary(updated);
}

/** Deleting removes the source plus its log rows in one batch: event rows
 * are source-scoped delivery metadata, while ExecutionHistory provenance
 * survives on the executions rows (keyed by Execution ID, never by event). */
export async function deleteEventSource(db: D1Database, caller: Principal, name: string): Promise<void> {
  const row = await loadEventSource(db, caller.orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  await db.batch([
    db.prepare("DELETE FROM events WHERE source_id=?").bind(row.id),
    db.prepare("DELETE FROM event_sources WHERE id=?").bind(row.id),
  ]);
}

export interface EmitEventInput {
  readonly eventId: unknown;
  readonly topic: unknown;
  readonly payload?: unknown;
}

export interface EmitEventResult {
  readonly event: EventSummary;
  readonly replayed: boolean;
}

/** Append one event to a source log through the deterministic identity
 * protocol: same (source, event) plus same (topic, payload, execution)
 * replays (`replayed:true`); the same event ID carrying different content
 * answers 409 instead of forking a second row. Disabled sources refuse
 * with 410; unknown or foreign sources answer 404. */
export async function emitEvent(
  db: D1Database,
  caller: Principal,
  name: string,
  input: EmitEventInput,
  executionId: string | null = null,
): Promise<EmitEventResult> {
  const row = await loadEventSource(db, caller.orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  if (row.enabled !== 1) throw new Fault(410, "EVENT_SOURCE_DISABLED", "This event source is disabled.");
  const eventId = parseEventId(input.eventId);
  const topic = parseTopic(input.topic);
  const payloadJson = parseEventPayload(input.payload);
  const stamp = new Date().toISOString();
  const inserted = await db
    .prepare(
      "INSERT INTO events(source_id,event_id,org_id,topic,payload_json,execution_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_id,event_id) DO NOTHING",
    )
    .bind(row.id, eventId, caller.orgId, topic, payloadJson, executionId, stamp)
    .run();
  if (inserted.meta.changes !== 0) {
    return {
      event: { eventId, topic, payload: JSON.parse(payloadJson) as unknown, executionId, createdAt: stamp },
      replayed: false,
    };
  }
  const prior = await db
    .prepare("SELECT topic,payload_json,execution_id,created_at FROM events WHERE source_id=? AND event_id=?")
    .bind(row.id, eventId)
    .first<{ topic: string; payload_json: string; execution_id: string | null; created_at: string }>();
  if (
    !prior ||
    prior.topic !== topic ||
    prior.payload_json !== payloadJson ||
    (prior.execution_id ?? null) !== (executionId ?? null)
  ) {
    throw new Fault(409, "EVENT_CONFLICT", "This event already logged different content.");
  }
  return {
    event: {
      eventId,
      topic: prior.topic,
      payload: JSON.parse(prior.payload_json) as unknown,
      executionId: prior.execution_id,
      createdAt: prior.created_at,
    },
    replayed: true,
  };
}

/** Log history for replay visibility: newest first, bounded. Unknown or
 * foreign names answer 404. */
export async function listEvents(db: D1Database, orgId: string, name: string, limit: number): Promise<EventSummary[]> {
  const row = await loadEventSource(db, orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  const capped = Math.min(Math.max(limit, 1), EVENT_LIST_LIMIT);
  let rows: {
    event_id: string;
    topic: string;
    payload_json: string;
    execution_id: string | null;
    created_at: string;
  }[];
  try {
    const result = await db
      .prepare(
        "SELECT event_id,topic,payload_json,execution_id,created_at FROM events WHERE source_id=? ORDER BY created_at DESC,event_id DESC LIMIT ?",
      )
      .bind(row.id, capped)
      .all<{
        event_id: string;
        topic: string;
        payload_json: string;
        execution_id: string | null;
        created_at: string;
      }>();
    rows = result.results;
  } catch (error) {
    // Old DB without the table: the source row itself stays the receipt.
    if (error instanceof Error && /no such table/i.test(error.message)) return [];
    throw error;
  }
  return rows.map((entry) => ({
    eventId: entry.event_id,
    topic: entry.topic,
    payload: JSON.parse(entry.payload_json) as unknown,
    executionId: entry.execution_id,
    createdAt: entry.created_at,
  }));
}

export interface SourceDelivery {
  readonly eventId: string;
  readonly topic: string;
  readonly payloadJson: string;
  readonly executionId: string;
}

/** Best-effort delivery append for the schedule/endpoint promotion paths:
 * when (and only when) the operator registered an enabled source observing
 * this backing row, the delivery lands in the log with its Execution
 * attribution. Every miss path — no source, disabled source, old database,
 * backend fault — resolves to silence: the log is replay visibility, never
 * a gate on delivery itself. */
export async function recordSourceDelivery(
  db: D1Database,
  orgId: string,
  kind: EventSourceKind,
  refId: string,
  delivery: SourceDelivery,
): Promise<void> {
  try {
    const source = await db
      .prepare("SELECT id FROM event_sources WHERE org_id=? AND kind=? AND ref_id=? AND enabled=1")
      .bind(orgId, kind, refId)
      .first<{ id: string }>();
    if (!source) return;
    await db
      .prepare(
        "INSERT INTO events(source_id,event_id,org_id,topic,payload_json,execution_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_id,event_id) DO NOTHING",
      )
      .bind(
        source.id,
        delivery.eventId,
        orgId,
        delivery.topic,
        delivery.payloadJson,
        delivery.executionId,
        new Date().toISOString(),
      )
      .run();
  } catch {
    // Best-effort by contract: see above.
  }
}
