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
// the delivery itself. Operator retry/replay ships in the S3a slice below;
// built-in platform events and retention policy stay deferred. No Queue,
// no Durable Object, no second auth or execution path.
//
// TRG-03 S2 (issue #139) adds scoped subscriptions plus bounded fan-out in
// this same file: one accepted event fans out through the existing submit
// protocol to every eligible subscriber, with the schedule-tick fencing
// discipline (disable/delete fence plus pre-dispatch authority revalidation
// through the canonical resolver/grant path) applied per subscriber.
import { BODY_LIMIT, EXECUTION_ID, Fault, hash, parseKeyShape, resolveSubmissionSaga, UUID } from "./domain";
import type { Principal } from "./domain";
import type { Bindings } from "./bindings";
import type { submit } from "./executions";
import { resolveCurrentAuthority } from "./roles";

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
  // S2 cascade: subscriptions hang off the source, and delivery receipts
  // hang off the subscriptions. Deleting the source removes all three
  // layers; dispatched Executions keep their ExecutionHistory rows.
  try {
    await db.batch([
      db
        .prepare(
          "DELETE FROM event_deliveries WHERE subscription_id IN (SELECT id FROM event_subscriptions WHERE source_id=?)",
        )
        .bind(row.id),
      db.prepare("DELETE FROM event_subscriptions WHERE source_id=?").bind(row.id),
      db.prepare("DELETE FROM events WHERE source_id=?").bind(row.id),
      db.prepare("DELETE FROM event_sources WHERE id=?").bind(row.id),
    ]);
  } catch (error) {
    // A database with the S1 tables but without migration 0033 keeps the
    // S1 delete shape instead of failing the operator request.
    if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
    await db.batch([
      db.prepare("DELETE FROM events WHERE source_id=?").bind(row.id),
      db.prepare("DELETE FROM event_sources WHERE id=?").bind(row.id),
    ]);
  }
}

export interface EmitEventInput {
  readonly eventId: unknown;
  readonly topic: unknown;
  readonly payload?: unknown;
}

export interface EmitEventResult {
  readonly event: EventSummary;
  readonly replayed: boolean;
  /** Registry ID of the source the event landed in: the fan-out route
   * resolves subscriptions against it without re-reading the source row. */
  readonly sourceId: string;
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
      sourceId: row.id,
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
    sourceId: row.id,
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

// ---------------------------------------------------------------------------
// TRG-03 S2 (issue #139): org-scoped subscriptions plus bounded fan-out.
//
// A subscription binds one event source to one target Saga through a typed
// dot-namespaced topic filter. One accepted operator event fans out through
// the existing submit protocol to every eligible subscriber: exact-org rows
// only, deterministic name order, stable per-(subscription, event)
// idempotency keys, and per-subscriber fencing (disable/delete fence plus
// pre-dispatch authority revalidation through the canonical
// resolver/grant path, copied from promoteWindow). Each subscriber fails
// independently: an unauthorized or misconfigured subscriber skips with its
// code while eligible siblings still dispatch — but a skipped subscriber
// never dispatches, so there is no partial unauthorized dispatch.
//
// Admission bound: at most EVENT_FANOUT_LIMIT subscribers dispatch per
// accepted event (D1 per-invocation query discipline: every dispatch is a
// full submit). Eligible subscribers beyond the bound are skipped and
// reported as overflowSkipped, never silently dropped. Re-emitting the same
// event (same content replays) re-runs fan-out idempotently: submit
// converges on the same Executions and delivery rows converge via
// ON CONFLICT DO NOTHING, which is also the restart-recovery story —
// there is no cursor to resume and no Queue to drain.
//
// Worker + Workflows + D1 only. Operator retry/replay APIs ship in the S3a
// slice below; built-in platform events and retention policy stay deferred.

/** Deterministic per-event fan-out admission bound. Every dispatch is a
 * full submit-protocol call; the bound keeps one emit inside the D1
 * per-invocation query discipline. Raise only with measured evidence. */
export const EVENT_FANOUT_LIMIT = 10;

/** Delivery history per subscription stays bounded like the event log. */
export const SUBSCRIPTION_DELIVERY_LIMIT = 50;

export interface SubscriptionRow {
  id: string;
  org_id: string;
  source_id: string;
  name: string;
  saga_id: string;
  topic_filter: string;
  enabled: number;
  run_as_user_id: string;
  created_at: string;
}

export interface SubscriptionSummary {
  id: string;
  name: string;
  sagaId: string;
  topicFilter: string;
  enabled: boolean;
  createdAt: string;
}

export interface SubscriptionDeliverySummary {
  eventId: string;
  topic: string;
  /** Null while the delivery still failed: failed entries are derived
   * (log minus receipts), never rows, so there is no Execution to name. */
  executionId: string | null;
  outcome: "delivered" | "failed";
  createdAt: string;
}

/** Subscription names share the source shape (lowercase/dashes, 64 max)
 * and are scoped per source. Unknown shapes answer 404, never a leak. */
export function parseSubscriptionName(name: string): string {
  if (!EVENT_SOURCE_NAME.test(name)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return name;
}

/** A single topic segment: the legal base of a top-level namespace filter
 * such as `vendor.*`. Multi-segment bases reuse EVENT_TOPIC. */
const TOPIC_FILTER_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Topic filters are dot-namespaced like topics, with one deterministic
 * extension: a trailing `.*` matches the whole producer namespace
 * (`vendor.order.*` matches `vendor.order.created`, `vendor.*` matches any
 * vendor-namespaced topic). Bare `*` segments, mid-filter wildcards, and
 * unnamespaced exact filters are rejected. */
export function parseTopicFilter(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw invalid("INVALID_SUBSCRIPTION", "Topic filters are 1 to 128 characters of dot-namespaced topic shape.");
  }
  if (value.endsWith(".*")) {
    const base = value.slice(0, -2);
    if (!EVENT_TOPIC.test(base) && !TOPIC_FILTER_SEGMENT.test(base)) {
      throw invalid(
        "INVALID_SUBSCRIPTION",
        "Topic filters must be an exact dot-namespaced topic or a namespace prefix ending in .*.",
      );
    }
    return value;
  }
  if (!EVENT_TOPIC.test(value)) {
    throw invalid(
      "INVALID_SUBSCRIPTION",
      "Topic filters must be an exact dot-namespaced topic or a namespace prefix ending in .*.",
    );
  }
  return value;
}

/** Deterministic bounded filter evaluation: exact equality, or a strict
 * namespace-prefix match for trailing-`.*` filters. No regex, no payload
 * inspection, no ordering dependence — the same (topic, filter) pair
 * always answers the same way. */
export function matchesTopicFilter(topic: string, filter: string): boolean {
  if (filter.endsWith(".*")) {
    const prefix = filter.slice(0, -1);
    return topic.length > prefix.length && topic.startsWith(prefix);
  }
  return topic === filter;
}

function subscriptionInvalid(message: string): Fault {
  return invalid("INVALID_SUBSCRIPTION", message);
}

/** The target Saga resolves through the submission catalog: unknown IDs
 * answer UNKNOWN_SAGA like the submit path, so a subscription can never
 * name a Saga the Worker cannot dispatch. */
export function parseSubscriptionSagaId(value: unknown): string {
  if (typeof value !== "string" || !resolveSubmissionSaga(value)) {
    throw new Fault(400, "UNKNOWN_SAGA", "Provide a built-in Saga ID the Worker can dispatch.");
  }
  return value;
}

/** Exact-org subscription visibility: foreign rows resolve to null so
 * routes answer 404. */
export async function loadSubscription(
  db: D1Database,
  orgId: string,
  sourceId: string,
  name: string,
): Promise<SubscriptionRow | null> {
  const row = await db
    .prepare("SELECT * FROM event_subscriptions WHERE org_id=? AND source_id=? AND name=?")
    .bind(orgId, sourceId, name)
    .first<SubscriptionRow>();
  return row ?? null;
}

/** Public summary shape for subscription rows (route responses). */
export function subscriptionSummary(row: SubscriptionRow): SubscriptionSummary {
  return {
    id: row.id,
    name: row.name,
    sagaId: row.saga_id,
    topicFilter: row.topic_filter,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function toSubscriptionSummary(row: SubscriptionRow): SubscriptionSummary {
  return subscriptionSummary(row);
}

export interface CreateSubscriptionInput {
  readonly name: unknown;
  readonly topicFilter: unknown;
  readonly sagaId: unknown;
}

/** Register one subscription on an exact-org source. The deterministic ID
 * converges like sources: re-creating the same name answers 409, never a
 * fork. The creator becomes the persisted run-as owner whose authority is
 * revalidated at every fan-out — creation grants nothing by itself. */
export async function createSubscription(
  db: D1Database,
  caller: Principal,
  source: EventSourceRow,
  input: CreateSubscriptionInput,
): Promise<SubscriptionSummary> {
  const name = typeof input.name === "string" ? input.name : "";
  if (!EVENT_SOURCE_NAME.test(name)) {
    throw subscriptionInvalid("Subscription names are 1 to 64 lowercase letters, digits, or dashes.");
  }
  const topicFilter = parseTopicFilter(input.topicFilter);
  const sagaId = parseSubscriptionSagaId(input.sagaId);
  const id = await hash(JSON.stringify(["wrangnarok.event-subscription.v1", caller.orgId, source.id, name]));
  const stamp = new Date().toISOString();
  try {
    await db
      .prepare(
        "INSERT INTO event_subscriptions(id,org_id,source_id,name,saga_id,topic_filter,enabled,run_as_user_id,created_at) VALUES (?,?,?,?,?,?,1,?,?)",
      )
      .bind(id, caller.orgId, source.id, name, sagaId, topicFilter, caller.userId, stamp)
      .run();
  } catch {
    throw invalid("SUBSCRIPTION_EXISTS", "A subscription with this name already exists.", 409);
  }
  return { id, name, sagaId, topicFilter, enabled: true, createdAt: stamp };
}

/** Enabled subscriptions for one source in deterministic dispatch order
 * (name ASC). Pre-migration absence reads as empty; a real backend fault
 * rethrows so discovery never answers failure as a successful empty list. */
export async function listSubscriptions(
  db: D1Database,
  orgId: string,
  sourceId: string,
): Promise<SubscriptionSummary[]> {
  let rows: SubscriptionRow[];
  try {
    const result = await db
      .prepare("SELECT * FROM event_subscriptions WHERE org_id=? AND source_id=? ORDER BY name ASC")
      .bind(orgId, sourceId)
      .all<SubscriptionRow>();
    rows = result.results;
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return [];
    throw error;
  }
  return rows.map(toSubscriptionSummary);
}

/** Disable (or re-enable) one subscription. Disabling fences future
 * fan-out while already-dispatched Executions run to their own terminal;
 * delivery receipts keep their rows and history. */
export async function setSubscriptionEnabled(
  db: D1Database,
  caller: Principal,
  source: EventSourceRow,
  name: string,
  enabled: boolean,
): Promise<SubscriptionSummary> {
  const row = await loadSubscription(db, caller.orgId, source.id, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  await db
    .prepare("UPDATE event_subscriptions SET enabled=? WHERE id=?")
    .bind(enabled ? 1 : 0, row.id)
    .run();
  const updated = await loadSubscription(db, caller.orgId, source.id, name);
  if (!updated) throw new Fault(404, "NOT_FOUND", "Not found.");
  return toSubscriptionSummary(updated);
}

/** Deleting removes the subscription plus its delivery receipts in one
 * batch. Dispatched Executions keep their ExecutionHistory rows (keyed by
 * Execution ID, never by subscription). */
export async function deleteSubscription(
  db: D1Database,
  caller: Principal,
  source: EventSourceRow,
  name: string,
): Promise<void> {
  const row = await loadSubscription(db, caller.orgId, source.id, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  await db.batch([
    db.prepare("DELETE FROM event_deliveries WHERE subscription_id=?").bind(row.id),
    db.prepare("DELETE FROM event_subscriptions WHERE id=?").bind(row.id),
  ]);
}

/** Delivery receipts for replay visibility: newest first, bounded.
 * Unknown or foreign subscriptions answer 404. */
export async function listSubscriptionDeliveries(
  db: D1Database,
  subscriptionId: string,
  limit: number,
): Promise<SubscriptionDeliverySummary[]> {
  // Exact-org visibility is enforced by the caller via loadSubscription:
  // only a subscription row already resolved in this Organization reaches
  // this query, so foreign delivery rows stay unreachable here.
  const capped = Math.min(Math.max(limit, 1), SUBSCRIPTION_DELIVERY_LIMIT);
  let rows: { event_id: string; topic: string; execution_id: string; created_at: string }[];
  try {
    const result = await db
      .prepare(
        "SELECT event_id,topic,execution_id,created_at FROM event_deliveries WHERE subscription_id=? ORDER BY created_at DESC,event_id DESC LIMIT ?",
      )
      .bind(subscriptionId, capped)
      .all<{ event_id: string; topic: string; execution_id: string; created_at: string }>();
    rows = result.results;
  } catch (error) {
    // Old DB without the table: the Execution row itself stays the receipt.
    if (error instanceof Error && /no such table/i.test(error.message)) return [];
    throw error;
  }
  return rows.map((entry) => ({
    eventId: entry.event_id,
    topic: entry.topic,
    executionId: entry.execution_id,
    outcome: "delivered",
    createdAt: entry.created_at,
  }));
}

/** Derive the deterministic submit Idempotency-Key for one
 * (subscription, event) pair. The 16-128 safe-alphabet rule is satisfied
 * by construction: `evt-` plus 64 hex. The same event re-emitted (or
 * re-run after a crash) converges via same-key replay, and caller keys
 * starting with `evt-` are rejected at parseCallerKey so no caller can
 * squat the delivery namespace. */
export async function subscriptionDeliveryKey(subscriptionId: string, eventId: string): Promise<string> {
  const key = `evt-${await hash(JSON.stringify(["wrangnarok.event-delivery.v1", subscriptionId, eventId]))}`;
  return parseKeyShape(key);
}

export interface FanoutEvent {
  readonly orgId: string;
  readonly sourceId: string;
  readonly eventId: string;
  readonly topic: string;
  readonly payload: unknown;
}

export interface FanoutDelivery {
  readonly subscription: string;
  readonly status: "dispatched" | "skipped";
  readonly executionId?: string;
  readonly replayed?: boolean;
  readonly code?: string;
}

export interface FanoutResult {
  readonly deliveries: readonly FanoutDelivery[];
  readonly overflowSkipped: number;
}

function fanoutSkip(subscription: string, code: string): FanoutDelivery {
  return { subscription, status: "skipped", code };
}

export interface SubscriberDispatch {
  readonly executionId: string;
  readonly replayed: boolean;
}

/** Dispatch one event to one subscriber through the standard submit
 * protocol. Shared by fan-out (S2) and operator retry (S3a) so the two
 * admission paths cannot drift: the same disable/delete fence, the same
 * run-as authority revalidation, the same catalog and parse gates, the
 * same stable `evt-` delivery key, and the same submit-first-then-receipt
 * discipline. Every fence fails closed by throwing its Fault — fan-out
 * catches it into a per-subscriber skip, retry lets it answer the route —
 * and anything else fails loud so a backend fault never reads as a skip.
 * Callers own admission policy (fan-out's attempt bound, retry's receipt
 * bound) and eligibility (fan-out's scan filter, retry's log lookup). */
async function dispatchToSubscriber(
  db: D1Database,
  env: Bindings,
  submitFn: typeof submit,
  subscriptionId: string,
  event: FanoutEvent,
): Promise<SubscriberDispatch> {
  // Fence 1: never trust the scan. Re-read by id so a disable/delete
  // that landed after the scan wins the race here.
  let fresh: SubscriptionRow | null;
  try {
    fresh = await db
      .prepare("SELECT * FROM event_subscriptions WHERE id=?")
      .bind(subscriptionId)
      .first<SubscriptionRow>();
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) fresh = null;
    else throw error;
  }
  if (!fresh) throw new Fault(404, "SUBSCRIPTION_GONE", "This subscription no longer exists.");
  if (fresh.enabled !== 1) throw new Fault(409, "SUBSCRIPTION_DISABLED", "This subscription is disabled.");
  // Fence 2: the persisted run-as IDs are an identity reference, not
  // continuing authorization. Re-resolve organization, user, and
  // membership lifecycle plus the saga execute grant at action time.
  const { principal } = await resolveCurrentAuthority(
    db,
    env,
    { orgId: fresh.org_id, userId: fresh.run_as_user_id },
    {
      orgId: fresh.org_id,
      resourceKind: "saga",
      resourceId: fresh.saga_id.toLowerCase(),
      action: "execute",
    },
  );
  // Fence 3: the catalog is the authority on dispatchable Sagas.
  const saga = resolveSubmissionSaga(fresh.saga_id);
  if (!saga) {
    throw new Fault(409, "SUBSCRIPTION_MISCONFIGURED", "This subscription targets a Saga that is no longer deployed.");
  }
  // Fence 4: the event payload must be valid Saga input.
  const input = saga.parse(event.payload);
  const key = await subscriptionDeliveryKey(fresh.id, event.eventId);
  const accepted = await submitFn(env, principal, key, saga, input);
  try {
    await db
      .prepare(
        "INSERT INTO event_deliveries(subscription_id,event_id,org_id,topic,execution_id,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(subscription_id,event_id) DO NOTHING",
      )
      .bind(fresh.id, event.eventId, event.orgId, event.topic, accepted.executionId, new Date().toISOString())
      .run();
  } catch {
    // Delivery receipts are replay visibility only: a missing table on an
    // old database must not fail the Execution itself.
  }
  return { executionId: accepted.executionId, replayed: accepted.replayed };
}

/** Fan out one accepted event through the standard submit protocol.
 * Deterministic: eligible subscribers resolve exact-org in name order and
 * at most EVENT_FANOUT_LIMIT dispatch; the remainder report as
 * overflowSkipped. Fenced per subscriber, in order:
 *
 * 1. Re-read by id — a disable/delete that landed after the scan wins the
 *    race (SUBSCRIPTION_DISABLED/SUBSCRIPTION_GONE skips, zero dispatch).
 * 2. Revalidate the persisted run-as owner through the canonical shared
 *    resolver plus the saga execute grant — revoked/disabled authority
 *    fails closed with the same codes as the request path, and an
 *    unattended fan-out never activates membership. Skipped authority
 *    never dispatches.
 * 3. Resolve the target Saga from the live catalog — a removed Saga skips
 *    as SUBSCRIPTION_MISCONFIGURED instead of dispatching stale config.
 * 4. Parse the event payload through the Saga parse gate — caller payload
 *    that is not valid Saga input skips with the parse code.
 * 5. Submit with the stable delivery key. Submit Faults (pause, admission,
 *    cancel, expiry, unconfirmed dispatch) skip with their code and record
 *    no receipt; the operator re-emits the same event to retry, and the
 *    same keys converge instead of forking.
 *
 * Only a successful submit records a delivery receipt (submit first, then
 * the row — the endpoint_events discipline), so a failed dispatch leaves
 * no receipt and a redelivered event converges on the exact created
 * Execution with no latest-for-subscription lookup. The per-subscriber
 * dispatch below is shared with operator retry (dispatchToSubscriber):
 * one fence sequence, one key derivation, one submit path. */
export async function dispatchEventFanout(
  db: D1Database,
  env: Bindings,
  submitFn: typeof submit,
  event: FanoutEvent,
): Promise<FanoutResult> {
  let scanned: SubscriptionRow[];
  try {
    const result = await db
      .prepare("SELECT * FROM event_subscriptions WHERE org_id=? AND source_id=? ORDER BY name ASC")
      .bind(event.orgId, event.sourceId)
      .all<SubscriptionRow>();
    scanned = result.results;
  } catch (error) {
    // Pre-migration database: no subscription can exist, so no fan-out.
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return { deliveries: [], overflowSkipped: 0 };
    }
    throw error;
  }
  // Matched in deterministic name order. Disabled rows report an explicit
  // fence skip (no dispatch, no bound consumption); enabled rows past the
  // admission bound report as overflowSkipped, never silently dropped.
  const matched = scanned.filter((row) => matchesTopicFilter(event.topic, row.topic_filter));
  const deliveries: FanoutDelivery[] = [];
  let attempted = 0;
  let overflowSkipped = 0;
  for (const candidate of matched) {
    if (candidate.enabled !== 1) {
      deliveries.push(fanoutSkip(candidate.name, "SUBSCRIPTION_DISABLED"));
      continue;
    }
    if (attempted >= EVENT_FANOUT_LIMIT) {
      overflowSkipped += 1;
      continue;
    }
    attempted += 1;
    try {
      const accepted = await dispatchToSubscriber(db, env, submitFn, candidate.id, event);
      deliveries.push({
        subscription: candidate.name,
        status: "dispatched",
        executionId: accepted.executionId,
        replayed: accepted.replayed,
      });
    } catch (error) {
      // Every fence fails closed with its code while eligible siblings
      // still dispatch; anything else fails loud so a backend fault never
      // reads as a skip.
      if (error instanceof Fault) {
        deliveries.push(fanoutSkip(candidate.name, error.code));
        continue;
      }
      throw error;
    }
  }
  return { deliveries, overflowSkipped };
}

// ---------------------------------------------------------------------------
// TRG-03 S3a (issue #139): operator retry/replay of failed deliveries.
//
// A failed delivery is derived, never stored: S2 records a receipt row only
// for a successful submit, so a logged event that matches a subscription's
// filter but carries no receipt for it is exactly the retry set — no new
// table, no new migration, no second dispatch path. The operator lists
// failures per subscription (newest first, bounded, alongside the S2
// receipts) and retries one event, which re-dispatches through the shared
// dispatchToSubscriber helper with the identical stable `evt-` key: the
// first retry creates the Execution, duplicate retries converge on it via
// same-key submit replay, and the receipt converges via ON CONFLICT DO
// NOTHING. Authority revalidates at dispatch time through the same
// fences as fan-out, so a disabled or deleted subscription, or a revoked
// run-as grant, fails closed with no Execution and no re-enable side
// effect. The per-event admission bound survives replay: an event that
// already dispatched EVENT_FANOUT_LIMIT times refuses further retries.
//
// Worker + Workflows + D1 only. Built-in platform emissions and the
// retention/admission policy stay deferred to later slices.

/** An event ID from the retry route. Unknown shapes answer 404 like the
 * sibling path-segment parsers, never a leak. */
export function parseDeliveryEventId(segment: string): string {
  if (segment.length === 0 || segment.length > EVENT_ID_MAX || !SAFE_EVENT_CHAR.test(segment)) {
    throw new Fault(404, "NOT_FOUND", "Not found.");
  }
  return segment;
}

export type DeliveryOutcomeFilter = "delivered" | "failed" | "all";

/** Parse the deliveries `?outcome=` filter. The key allowlist mirrors the
 * schedule-deliveries `?window=` posture: only `outcome` travels here, an
 * absent filter returns both outcomes newest-first, and anything else
 * fails closed. */
export function parseDeliveryOutcome(params: URLSearchParams): DeliveryOutcomeFilter {
  for (const key of params.keys()) {
    if (key !== "outcome") {
      throw new Fault(400, "UNSUPPORTED_QUERY", "Only outcome is supported here.");
    }
  }
  const raw = params.get("outcome");
  if (raw === null) return "all";
  if (raw !== "delivered" && raw !== "failed" && raw !== "all") {
    throw new Fault(400, "INVALID_OUTCOME", "Outcome must be delivered, failed, or all.");
  }
  return raw;
}

/** Failed deliveries for replay visibility: logged events matching this
 * subscription's filter with no receipt row, newest first, bounded. The
 * bound windows the unreceived log scan, so a filter matching only older
 * events reports what the window holds — the same bounded newest-first
 * posture as every other history read. Exact-org visibility is enforced
 * by the caller via loadSubscription, like listSubscriptionDeliveries.
 * Pre-migration absence reads as empty; a real backend fault rethrows. */
export async function listFailedDeliveries(
  db: D1Database,
  subscription: SubscriptionRow,
  limit: number,
): Promise<SubscriptionDeliverySummary[]> {
  const capped = Math.min(Math.max(limit, 1), SUBSCRIPTION_DELIVERY_LIMIT);
  let rows: { event_id: string; topic: string; created_at: string }[];
  try {
    const result = await db
      .prepare(
        "SELECT event_id,topic,created_at FROM events WHERE source_id=? AND NOT EXISTS (SELECT 1 FROM event_deliveries WHERE subscription_id=? AND event_deliveries.event_id=events.event_id) ORDER BY created_at DESC,event_id DESC LIMIT ?",
      )
      .bind(subscription.source_id, subscription.id, capped)
      .all<{ event_id: string; topic: string; created_at: string }>();
    rows = result.results;
  } catch (error) {
    // Old DB without the tables: no log means no failed deliveries.
    if (error instanceof Error && /no such table/i.test(error.message)) return [];
    throw error;
  }
  return rows
    .filter((entry) => matchesTopicFilter(entry.topic, subscription.topic_filter))
    .map((entry) => ({
      eventId: entry.event_id,
      topic: entry.topic,
      executionId: null,
      outcome: "failed",
      createdAt: entry.created_at,
    }));
}

export interface RetryDeliveryRequest {
  readonly orgId: string;
  readonly source: EventSourceRow;
  readonly subscription: SubscriptionRow;
  readonly eventId: string;
}

export interface RetryDeliveryResult {
  readonly subscription: string;
  readonly eventId: string;
  readonly executionId: string;
  readonly replayed: boolean;
}

/** Retry one failed delivery through the shared single-subscriber dispatch
 * (identical `evt-` key, same fences, same submit protocol). In order:
 *
 * 1. The event must be logged in this source and must match the
 *    subscription's filter — anything else is not a failed delivery of
 *    this subscription and answers 404, never a dispatch.
 * 2. The per-event bound holds: receipts for this event from the source's
 *    other subscriptions already at EVENT_FANOUT_LIMIT refuse the retry
 *    (DELIVERY_BOUND_EXCEEDED), so one event never dispatches more than
 *    the bound however it was admitted. The retry's own receipt never
 *    counts, so duplicate retries still converge below.
 * 3. The shared dispatch re-reads the subscription, revalidates the
 *    run-as authority and grant, and submits with the identical key —
 *    disabled/deleted/revoked fail closed, the first retry creates the
 *    Execution, and duplicate retries converge on it with no receipt
 *    pre-check (the submit protocol's same-key replay is the dedup).
 */
export async function retrySubscriptionDelivery(
  db: D1Database,
  env: Bindings,
  submitFn: typeof submit,
  request: RetryDeliveryRequest,
): Promise<RetryDeliveryResult> {
  let logged: { topic: string; payload_json: string } | null;
  try {
    logged = await db
      .prepare("SELECT topic,payload_json FROM events WHERE source_id=? AND event_id=?")
      .bind(request.source.id, request.eventId)
      .first<{ topic: string; payload_json: string }>();
  } catch (error) {
    // Old DB without the log: nothing logged means nothing to retry.
    if (error instanceof Error && /no such table/i.test(error.message)) logged = null;
    else throw error;
  }
  if (!logged || !matchesTopicFilter(logged.topic, request.subscription.topic_filter)) {
    throw new Fault(404, "NOT_FOUND", "This subscription has no failed delivery for this event.");
  }
  let dispatched: { n: number } | null;
  try {
    dispatched = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM event_deliveries WHERE event_id=? AND subscription_id IN (SELECT id FROM event_subscriptions WHERE source_id=?) AND subscription_id != ?",
      )
      .bind(request.eventId, request.source.id, request.subscription.id)
      .first<{ n: number }>();
  } catch (error) {
    // Old DB without the receipts: no receipts means nothing dispatched.
    if (error instanceof Error && /no such table/i.test(error.message)) dispatched = { n: 0 };
    else throw error;
  }
  if ((dispatched?.n ?? 0) >= EVENT_FANOUT_LIMIT) {
    throw new Fault(
      409,
      "DELIVERY_BOUND_EXCEEDED",
      `This event already reached the per-event dispatch bound (${EVENT_FANOUT_LIMIT}).`,
    );
  }
  const accepted = await dispatchToSubscriber(db, env, submitFn, request.subscription.id, {
    orgId: request.orgId,
    sourceId: request.source.id,
    eventId: request.eventId,
    topic: logged.topic,
    payload: JSON.parse(logged.payload_json) as unknown,
  });
  return {
    subscription: request.subscription.name,
    eventId: request.eventId,
    executionId: accepted.executionId,
    replayed: accepted.replayed,
  };
}
