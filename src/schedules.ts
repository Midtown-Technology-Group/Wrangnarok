// SPDX-License-Identifier: AGPL-3.0
// TRG-01 (issue #137, ADR 012): one-off and recurring schedules with durable
// due-time and cancellation semantics.
//
// Upstream inventory (pins at gobifrost/bifrost@3543c7e):
// - `api/src/routers/schedules.py`: schedule CRUD binding a cadence,
//   timezone, enablement, input, and run-as policy to one workflow; all
//   runtime policy, never workflow source metadata (upstream finding 3).
// - `api/src/jobs/schedulers/cron_scheduler.py:166-203`: a tick promotes due
//   rows; a new window for the same source skips while an earlier delivery
//   stays active (same-window dedup is not cross-window overlap policy).
// - `api/src/jobs/schedulers/deferred_execution_promoter.py`: overdue
//   promotion through the normal dispatch protocol with fencing.
// - `api/src/routers/events.py`: scheduled inventory surfaces beside events.
//
// Cloudflare mapping (ADR 012, accepted here): a Schedule is persisted
// environment state (one org-scoped row binding a name to a stable Saga
// UUID). A Cloudflare Cron Trigger (the tick) calls the exported
// `promoteDueSchedules` scan, which promotes due rows through the standard
// submit protocol with deterministic schedule-window keys. Overlap policy is
// explicit: the same window replays (`200 replayed:true`) while live and
// never forks a second Execution; a later window is a new key and dispatches
// independently. Owner-cancel-wins: a tick never resurrects a cancelled
// window. Disabled or deleted schedules never promote. No Queue, no Durable
// Object, no background job beyond the Cron tick itself.
import { BODY_LIMIT, Fault, hash, parseKey, UUID } from "./domain";
import type { Principal, SagaDef } from "./domain";
import type { Bindings } from "./bindings";
import { submit } from "./executions";
import { instanceAdmins } from "./orgs";
import type { AdminEnv } from "./orgs";

export const SCHEDULE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_WINDOW_CHAR = /^[a-zA-Z0-9._:-]+$/;
/** Schedule keys reserve the `sch-` namespace the way endpoint deliveries
 * reserve `wep-`: a caller squatting it could replay against a scheduled
 * Execution, so the submit route must reject caller keys with this prefix. */
export const SCHEDULE_KEY_PREFIX = "sch-";
/** Bounded scan/admission cost per Cron tick (Free-tier posture): the tick
 * reads at most this many due rows per Organization scan. */
export const SCHEDULE_TICK_LIMIT = 50;
/** Cron field bounds: standard 5-field cron, each field capped. */
export const SCHEDULE_CRON_MAX = 64;

export type ScheduleKind = "recurring" | "one-off";

export interface ScheduleRow {
  id: string;
  org_id: string;
  name: string;
  saga_id: string;
  kind: ScheduleKind;
  cron: string;
  timezone: string;
  enabled: number;
  input_json: string;
  run_as_user_id: string;
  run_at: string | null;
  next_due_at: string | null;
  last_window: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  sagaId: string;
  sagaName: string;
  kind: ScheduleKind;
  cron: string;
  timezone: string;
  enabled: boolean;
  input: unknown;
  runAt: string | null;
  nextDueAt: string | null;
  lastWindow: string | null;
  createdAt: string;
  updatedAt: string;
}

function invalid(code: string, message: string, status = 400): Fault {
  return new Fault(status, code, message);
}

/** Parse a schedule name from the route. Unknown shapes answer 404, never a leak. */
export function parseScheduleName(name: string): string {
  if (!SCHEDULE_NAME.test(name)) throw new Fault(404, "NOT_FOUND", "Not found.");
  return name;
}

const CRON_FIELD = /^(\*|\*\/[1-9]\d*|\d+(-\d+)?(,\d+(-\d+)?)*)$/;
/** Validate a 5-field cron expression (minute hour day month weekday).
 * Documented DST/missed-tick posture: matching is wall-clock UTC unless a
 * named IANA timezone parses via Intl; a tick that never fires (downtime)
 * promotes the missed window overdue on the next tick, never skips it
 * silently and never fans out catch-up windows (one promotion per tick). */
export function parseCron(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > SCHEDULE_CRON_MAX) {
    throw invalid("INVALID_SCHEDULE", "Cron must be a 5-field expression of at most 64 characters.");
  }
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((field) => CRON_FIELD.test(field))) {
    throw invalid("INVALID_SCHEDULE", "Cron must be a 5-field minute hour day month weekday expression.");
  }
  const minuteRaw = fields[0] as string;
  const hourRaw = fields[1] as string;
  const dayRaw = fields[2] as string;
  const monthRaw = fields[3] as string;
  const weekdayRaw = fields[4] as string;
  const raws = [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw].map((field) =>
    field.split(",").flatMap((part) => {
      if (part === "*" || part.startsWith("*/")) return [];
      return part.split("-").map(Number);
    }),
  );
  const minute = raws[0] as number[];
  const hour = raws[1] as number[];
  const day = raws[2] as number[];
  const month = raws[3] as number[];
  const weekday = raws[4] as number[];
  const bounds: Array<[number[], number, number, string]> = [
    [minute, 0, 59, "minute"],
    [hour, 0, 23, "hour"],
    [day, 1, 31, "day"],
    [month, 1, 12, "month"],
    [weekday, 0, 7, "weekday"],
  ];
  for (const [values, low, high, label] of bounds) {
    for (const candidate of values) {
      if (!Number.isInteger(candidate) || candidate < low || candidate > high) {
        throw invalid("INVALID_SCHEDULE", `Cron ${label} is out of range.`);
      }
    }
  }
  return fields.join(" ");
}

/** Validate a timezone: `UTC` or a named IANA zone resolvable by Intl.
 * Unresolvable names fail closed rather than silently matching UTC. */
export function parseScheduleTimezone(value: unknown): string {
  if (value === undefined || value === null || value === "") return "UTC";
  if (typeof value !== "string" || value.length > 64) {
    throw invalid("INVALID_SCHEDULE", "Timezone must be UTC or a named IANA timezone.");
  }
  if (value === "UTC") return value;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw invalid("INVALID_SCHEDULE", "Timezone must be UTC or a named IANA timezone.");
  }
  return value;
}

export function parseScheduleInput(value: unknown, saga: SagaDef): unknown {
  if (value === undefined) return saga.parse({});
  const shaped = saga.parse(value);
  if (new TextEncoder().encode(JSON.stringify(shaped)).byteLength > BODY_LIMIT) {
    throw invalid("INVALID_SCHEDULE", "Schedule input exceeds the 4096-byte bound.");
  }
  return shaped;
}

export function parseRunAt(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw invalid("INVALID_SCHEDULE", "One-off schedules require an ISO run-at timestamp.");
  }
  const when = Date.parse(value);
  if (!Number.isFinite(when)) throw invalid("INVALID_SCHEDULE", "One-off schedules require an ISO run-at timestamp.");
  return new Date(when).toISOString();
}

/** Deterministic submit key for one (schedule, window) pair. The existing
 * idempotency protocol does the overlap work: same-window ticks replay while
 * live, racing ticks converge on the retained-ID winner, and a cancelled
 * window stays 409 without resurrection. */
export async function scheduleWindowKey(scheduleId: string, window: string): Promise<string> {
  if (!SAFE_WINDOW_CHAR.test(window) || window.length > 128) {
    throw invalid("INVALID_SCHEDULE", "Schedule windows use safe delivery characters only.");
  }
  return `${SCHEDULE_KEY_PREFIX}${await hash(JSON.stringify(["wrangnarok.schedule-window.v1", scheduleId, window]))}`;
}

/** Current minute window in `YYYY-MM-DDTHH:mm` UTC. Recurring ticks derive
 * one window per minute; a tick arriving late for window W still promotes W
 * (overdue promotion), while W+1 waits for its own window. */
export function currentWindow(now: Date = new Date()): string {
  return now.toISOString().slice(0, 16);
}

/** Next due instant for a 5-field cron after `from`, evaluated minute by
 * minute up to one year out. Step values (`*\/n`) advance arithmetically;
 * named timezones shift the wall clock through Intl before matching. */
export function nextCronDue(cron: string, timezone: string, from: Date = new Date()): string {
  // Fail closed on unvalidated cadence: only a parseCron-shaped expression
  // reaches the matcher, so the matcher never spins on garbage.
  const valid = parseCron(cron);
  const fields = valid.split(" ");
  const matchers = fields.map((field) => cronMatcher(field));
  // parseCron guarantees five fields, so every matcher exists here.
  const [minuteMatch, hourMatch, dayMatch, monthMatch, weekdayMatch] = matchers as [
    (value: number) => boolean,
    (value: number) => boolean,
    (value: number) => boolean,
    (value: number) => boolean,
    (value: number) => boolean,
  ];
  let cursor = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const horizon = cursor + 366 * 24 * 60 * 60_000;
  while (cursor <= horizon) {
    const parts = zonedParts(new Date(cursor), timezone);
    if (
      minuteMatch(parts.minute) &&
      hourMatch(parts.hour) &&
      dayMatch(parts.day) &&
      monthMatch(parts.month) &&
      weekdayMatch(parts.weekday)
    ) {
      return new Date(cursor).toISOString();
    }
    cursor += 60_000;
  }
  throw invalid("INVALID_SCHEDULE", "Cron never matches within one year.");
}

function cronMatcher(field: string): (value: number) => boolean {
  if (field === "*") return () => true;
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return (value) => value % step === 0;
  }
  // Fields arrive parseCron-validated (numeric lists and ranges only), so
  // every chunk yields a finite low; a missing high end is a plain value.
  const values = new Set<number>();
  for (const chunk of field.split(",")) {
    const ends = chunk.split("-").map(Number);
    const low = ends[0] as number;
    const high = ends[1];
    if (high === undefined) values.add(low);
    else for (let candidate = low; candidate <= high; candidate += 1) values.add(candidate);
  }
  return (value) => values.has(value) || (values.has(7) && value === 0);
}

function zonedParts(
  when: Date,
  timezone: string,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
  if (timezone === "UTC") {
    return {
      minute: when.getUTCMinutes(),
      hour: when.getUTCHours(),
      day: when.getUTCDate(),
      month: when.getUTCMonth() + 1,
      weekday: when.getUTCDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(when);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const weekdayRaw = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayRaw);
  return { minute: get("minute"), hour: get("hour"), day: get("day"), month: get("month"), weekday };
}

export interface ScheduleCreate {
  readonly name: string;
  readonly sagaId: string;
  readonly kind: ScheduleKind;
  readonly cron?: unknown;
  readonly timezone?: unknown;
  readonly input?: unknown;
  readonly runAt?: unknown;
  readonly enabled?: unknown;
}

/** Parse a schedule create/update body against the catalog. Caller-supplied
 * org/user identity is never accepted: run-as always resolves to the
 * creating caller (the schedule owner), and Organization comes from the
 * membership gate in the route. */
export function parseScheduleBody(body: unknown, sagas: readonly SagaDef[]): ScheduleCreate & { saga: SagaDef } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("INVALID_SCHEDULE", "Schedule bodies must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  for (const forbidden of ["orgId", "org_id", "organizationId", "userId", "user_id", "runAs", "run_as"]) {
    if (forbidden in record) {
      throw invalid(
        "SCHEDULE_IDENTITY_FORBIDDEN",
        "Organization and run-as identity come from the schedule owner, never the request body.",
      );
    }
  }
  const name = record.name;
  if (typeof name !== "string" || !SCHEDULE_NAME.test(name)) {
    throw invalid("INVALID_SCHEDULE", "Schedule names use lowercase letters, digits, and dashes.");
  }
  const sagaId = typeof record.sagaId === "string" ? record.sagaId.toLowerCase() : "";
  if (!UUID.test(sagaId)) throw invalid("INVALID_SCHEDULE", "sagaId must be a stable Saga UUID.");
  const saga = sagas.find((entry) => entry.id.toLowerCase() === sagaId);
  if (!saga) throw invalid("UNKNOWN_SAGA", "sagaId must be a known Saga UUID.");
  const kind = record.kind;
  if (kind !== "recurring" && kind !== "one-off") {
    throw invalid("INVALID_SCHEDULE", 'Schedule kind must be "recurring" or "one-off".');
  }
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw invalid("INVALID_SCHEDULE", "Schedule enabled must be a boolean.");
  }
  return {
    name,
    sagaId: saga.id,
    kind,
    cron: record.cron,
    timezone: record.timezone,
    input: record.input,
    runAt: record.runAt,
    enabled: record.enabled,
    saga,
  };
}

function toSummary(row: ScheduleRow, sagas: readonly SagaDef[]): ScheduleSummary {
  const saga = sagas.find((entry) => entry.id === row.saga_id);
  return {
    id: row.id,
    name: row.name,
    sagaId: row.saga_id,
    sagaName: saga?.name ?? row.saga_id,
    kind: row.kind,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    input: JSON.parse(row.input_json) as unknown,
    runAt: row.run_at,
    nextDueAt: row.next_due_at,
    lastWindow: row.last_window,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Create one schedule row. Exact-org visibility: same-org duplicate names
 * answer 409; the Saga parse gate stays authoritative for input. */
export async function createSchedule(
  db: D1Database,
  caller: Principal,
  parsed: ScheduleCreate & { saga: SagaDef },
  sagas: readonly SagaDef[],
): Promise<ScheduleSummary> {
  const now = new Date();
  const input = parseScheduleInput(parsed.input, parsed.saga);
  const inputJson = JSON.stringify(input);
  const timezone = parseScheduleTimezone(parsed.timezone);
  let cron = "";
  let runAt: string | null = null;
  if (parsed.kind === "recurring") {
    cron = parseCron(parsed.cron);
  } else {
    runAt = parseRunAt(parsed.runAt);
  }
  const nextDue = parsed.kind === "recurring" ? nextCronDue(cron, timezone, now) : runAt;
  const id = await hash(JSON.stringify(["wrangnarok.schedule.v1", caller.orgId, parsed.name]));
  const stamp = now.toISOString();
  const enabled = parsed.enabled === false ? 0 : 1;
  // The summary builds from the just-validated values: the INSERT below is
  // the only writer of this id, so no reload race exists to close.
  const row: ScheduleRow = {
    id,
    org_id: caller.orgId,
    name: parsed.name,
    saga_id: parsed.saga.id,
    kind: parsed.kind,
    cron,
    timezone,
    enabled,
    input_json: inputJson,
    run_as_user_id: caller.userId,
    run_at: runAt,
    next_due_at: nextDue,
    last_window: null,
    created_at: stamp,
    updated_at: stamp,
  };
  try {
    await db
      .prepare(
        "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,run_at,next_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        caller.orgId,
        parsed.name,
        parsed.saga.id,
        parsed.kind,
        cron,
        timezone,
        enabled,
        inputJson,
        caller.userId,
        runAt,
        nextDue,
        stamp,
        stamp,
      )
      .run();
  } catch {
    throw invalid("SCHEDULE_CONFLICT", "A schedule with this name already exists.", 409);
  }
  return toSummary(row, sagas);
}

/** Load one schedule row for exact-org visibility: foreign rows resolve to
 * null so routes answer 404, never a cross-tenant leak. */
export async function loadSchedule(db: D1Database, orgId: string, name: string): Promise<ScheduleRow | null> {
  try {
    const row = await db
      .prepare("SELECT * FROM schedules WHERE org_id=? AND name=?")
      .bind(orgId, name)
      .first<ScheduleRow>();
    return row ?? null;
  } catch {
    return null;
  }
}

export async function listSchedules(
  db: D1Database,
  caller: Principal,
  sagas: readonly SagaDef[],
): Promise<ScheduleSummary[]> {
  let rows: ScheduleRow[];
  try {
    const result = await db
      .prepare("SELECT * FROM schedules WHERE org_id=? ORDER BY name")
      .bind(caller.orgId)
      .all<ScheduleRow>();
    rows = result.results;
  } catch {
    return [];
  }
  return rows.map((row) => toSummary(row, sagas));
}

/** Disable (or re-enable) one schedule. Disabling fences future promotion;
 * already-promoted Executions keep their identity and run to terminal.
 * Deleting removes the row plus its delivery rows (migration 0016 FK);
 * ExecutionHistory provenance survives on the executions rows. */
export async function setScheduleEnabled(
  db: D1Database,
  caller: Principal,
  name: string,
  enabled: boolean,
  sagas: readonly SagaDef[],
): Promise<ScheduleSummary> {
  const row = await loadSchedule(db, caller.orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  const stamp = new Date().toISOString();
  await db
    .prepare("UPDATE schedules SET enabled=?,updated_at=? WHERE id=?")
    .bind(enabled ? 1 : 0, stamp, row.id)
    .run();
  const updated = await loadSchedule(db, caller.orgId, name);
  if (!updated) throw new Fault(404, "NOT_FOUND", "Not found.");
  return toSummary(updated, sagas);
}

export async function deleteSchedule(db: D1Database, caller: Principal, name: string): Promise<void> {
  const row = await loadSchedule(db, caller.orgId, name);
  if (!row) throw new Fault(404, "NOT_FOUND", "Not found.");
  // Delivery rows reference the schedule row (migration 0016 FK), so they go
  // in the same delete: the window-to-Execution mapping is schedule-scoped
  // metadata, while ExecutionHistory provenance survives on the executions
  // rows themselves (keyed by Execution ID, never by schedule). One batch
  // keeps the pair atomic: a failed schedule delete never strands an
  // already-cleared delivery table.
  await db.batch([
    db.prepare("DELETE FROM schedule_deliveries WHERE schedule_id=?").bind(row.id),
    db.prepare("DELETE FROM schedules WHERE id=?").bind(row.id),
  ]);
}

export interface PromotionResult {
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly window: string;
  readonly executionId: string;
  readonly replayed: boolean;
  readonly statusUrl: string;
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function storeNotMigrated(): Fault {
  return new Fault(503, "ORG_STORE_NOT_MIGRATED", "Organization storage is not migrated: apply migration 0007.");
}

/** Revalidate the persisted run-as authority immediately before dispatch.
 * Same lifecycle semantics as the request path (orgs.resolveCaller): unknown
 * orgs answer as not-found, disabled orgs/users and non-active memberships
 * fail closed — but with two tick-specific differences. There is no verified
 * identity present, so an `invited` membership is never activated here: the
 * tick only dispatches for already-active authority. And a store that predates
 * migration 0007 fails loud (503) instead of dispatching unchecked. */
async function assertScheduleAuthority(db: D1Database, env: AdminEnv, schedule: ScheduleRow): Promise<Principal> {
  const principal: Principal = { orgId: schedule.org_id, userId: schedule.run_as_user_id };
  // Instance-admin recovery parity: resolveCaller lets the env-held admin list
  // through without membership rows, so the tick does the same.
  if (instanceAdmins(env).has(principal.userId)) return principal;
  // One missing-table fence for all three reads: a store predating migration
  // 0007 fails loud (503) instead of dispatching unchecked.
  let org: { status?: string } | null;
  let user: { status?: string } | null;
  let membership: { status?: string } | null;
  try {
    org = await db.prepare("SELECT * FROM organizations WHERE id=?").bind(schedule.org_id).first<{ status?: string }>();
    user = await db
      .prepare("SELECT * FROM users WHERE user_id=?")
      .bind(schedule.run_as_user_id)
      .first<{ status?: string }>();
    membership = await db
      .prepare("SELECT * FROM org_memberships WHERE org_id=? AND user_id=?")
      .bind(schedule.org_id, schedule.run_as_user_id)
      .first<{ status?: string }>();
  } catch (error) {
    if (isMissingTable(error)) throw storeNotMigrated();
    throw error;
  }
  if (!org) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  if ((org.status ?? "active") === "disabled") throw new Fault(403, "ORG_DISABLED", "This Organization is disabled.");
  if (!user) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  if ((user.status ?? "active") !== "active") throw new Fault(403, "USER_DISABLED", "This user is disabled.");
  if (!membership) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  if (membership.status === "revoked") throw new Fault(403, "MEMBERSHIP_REVOKED", "Membership is revoked.");
  // Suspended, invited, and unknown statuses all read as not-active here: the
  // tick never activates membership, it only dispatches for active authority.
  if (membership.status !== "active") throw new Fault(403, "MEMBERSHIP_SUSPENDED", "Membership is not active.");
  return principal;
}

/** Tick skip codes: per-schedule fences that report a skip and let the next
 * tick retry (or stay refused for cancelled/unauthorized windows), never a
 * tick failure. Store-missing (ORG_STORE_NOT_MIGRATED) is deliberately absent:
 * a config error fails the tick loud like the request path does. */
const TICK_SKIP_CODES: ReadonlySet<string> = new Set([
  "EXECUTION_CANCELLED",
  "SAGA_PAUSED",
  "ADMISSION_LIMITED",
  "SCHEDULE_GONE",
  "SCHEDULE_DISABLED",
  "ORG_NOT_FOUND",
  "ORG_DISABLED",
  "USER_DISABLED",
  "MEMBERSHIP_SUSPENDED",
  "MEMBERSHIP_REVOKED",
]);

/** Promote one due window through the submit protocol. Single-winner
 * discipline comes free: the deterministic key plus retained-ID dedup make
 * racing ticks converge; the delivery row records the winner for replay
 * visibility. A cancelled window stays 409 and needs no fresh key here —
 * the tick reports it as skipped, never resurrected.
 *
 * Pre-dispatch fence (issue #137): the caller-held row may be stale — a tick
 * that selected this row can lose a race with an operator disable/delete, and
 * the persisted run-as owner may have been revoked since creation. The row is
 * re-read and the run-as authority revalidated immediately before submit, so
 * a lost race reports a skip instead of dispatching stale authority. */
export async function promoteWindow(
  db: D1Database,
  env: Bindings,
  schedule: ScheduleRow,
  window: string,
  sagas: readonly SagaDef[],
  submitFn: typeof submit,
): Promise<PromotionResult> {
  // Pre-dispatch fence: never trust the caller-held row. Re-read by id so a
  // disable/delete that landed after the tick scan wins the race here.
  let fresh: ScheduleRow | null;
  try {
    fresh = await db.prepare("SELECT * FROM schedules WHERE id=?").bind(schedule.id).first<ScheduleRow>();
  } catch {
    fresh = null;
  }
  if (!fresh) throw new Fault(409, "SCHEDULE_GONE", "This schedule was deleted before dispatch.");
  if (fresh.enabled !== 1) throw new Fault(409, "SCHEDULE_DISABLED", "This schedule was disabled before dispatch.");
  // Run-as revalidation: the persisted owner IDs are not continuing
  // authorization. Mirror the request-path lifecycle semantics
  // (orgs.resolveCaller) without its invited-activation write — an unattended
  // tick never activates membership, it only dispatches for active authority.
  const principal = await assertScheduleAuthority(db, env, fresh);
  const saga = sagas.find((entry) => entry.id === fresh.saga_id);
  if (!saga) throw new Fault(500, "SCHEDULE_MISCONFIGURED", "This schedule is not configured correctly.");
  const key = await scheduleWindowKey(fresh.id, window);
  parseKey(key);
  const input = JSON.parse(fresh.input_json) as unknown;
  const accepted = await submitFn(env, principal, key, saga, input);
  try {
    await db
      .prepare(
        "INSERT INTO schedule_deliveries(schedule_id,window,input_json,execution_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT(schedule_id,window) DO NOTHING",
      )
      .bind(fresh.id, window, fresh.input_json, accepted.executionId, new Date().toISOString())
      .run();
  } catch {
    // Old DB without the table: the Execution row itself stays the receipt.
  }
  await db
    .prepare("UPDATE schedules SET last_window=?,updated_at=? WHERE id=?")
    .bind(window, new Date().toISOString(), fresh.id)
    .run();
  return {
    scheduleId: fresh.id,
    scheduleName: fresh.name,
    window,
    executionId: accepted.executionId,
    replayed: accepted.replayed,
    statusUrl: accepted.statusUrl,
  };
}

export interface TickReport {
  readonly promoted: PromotionResult[];
  readonly skipped: string[];
}

/** Cron tick: scan enabled due rows (bounded), promote each exactly once.
 * One-off rows promote once then disable themselves; recurring rows advance
 * next_due_at past the promoted window. Overdue rows promote (never silently
 * skipped); future rows wait. Disabled or deleted rows never appear — and a
 * row disabled, deleted, or de-authorized after the scan still loses at the
 * pre-dispatch fence inside promoteWindow (skip, zero dispatch). */
export async function promoteDueSchedules(
  db: D1Database,
  env: Bindings,
  sagas: readonly SagaDef[],
  submitFn: typeof submit,
  now: Date = new Date(),
): Promise<TickReport> {
  let due: ScheduleRow[];
  try {
    const result = await db
      .prepare(
        "SELECT * FROM schedules WHERE enabled=1 AND next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at LIMIT ?",
      )
      .bind(now.toISOString(), SCHEDULE_TICK_LIMIT)
      .all<ScheduleRow>();
    due = result.results;
  } catch {
    return { promoted: [], skipped: [] };
  }
  const promoted: PromotionResult[] = [];
  const skipped: string[] = [];
  for (const schedule of due) {
    const saga = sagas.find((entry) => entry.id === schedule.saga_id);
    if (!saga) {
      skipped.push(schedule.name);
      continue;
    }
    // next_due_at is non-null here: the tick query selects enabled rows
    // with next_due_at <= now, and only the one-off branch below nulls it.
    const dueAt = schedule.next_due_at as string;
    const window = schedule.kind === "one-off" ? `once-${schedule.id.slice(0, 16)}` : currentWindow(new Date(dueAt));
    try {
      promoted.push(await promoteWindow(db, env, schedule, window, sagas, submitFn));
    } catch (error) {
      // Owner-cancel-wins, admission, liveness, and authority fences surface
      // as skips, never as tick failures: the next tick retries a live
      // window, while a cancelled or unauthorized window stays refused until
      // the operator renames the key surface (new schedule or re-enable
      // after cancel clears) or restores the run-as authority.
      if (error instanceof Fault && TICK_SKIP_CODES.has(error.code)) {
        skipped.push(schedule.name);
        continue;
      }
      throw error;
    }
    if (schedule.kind === "one-off") {
      await db
        .prepare("UPDATE schedules SET enabled=0,next_due_at=NULL,updated_at=? WHERE id=?")
        .bind(now.toISOString(), schedule.id)
        .run();
    } else {
      const advanced = nextCronDue(schedule.cron, schedule.timezone, new Date(dueAt));
      await db
        .prepare("UPDATE schedules SET next_due_at=?,updated_at=? WHERE id=?")
        .bind(advanced, now.toISOString(), schedule.id)
        .run();
    }
  }
  return { promoted, skipped };
}

/** Cancel one future scheduled Execution before dispatch: marks the pending
 * receipt Cancelling through the owner-cancel path. Implemented in the route
 * via the executions cancel protocol; this helper only resolves the
 * delivery row for visibility. */
export async function deliveryForWindow(
  db: D1Database,
  scheduleId: string,
  window: string,
): Promise<{ execution_id: string } | null> {
  try {
    const row = await db
      .prepare("SELECT execution_id FROM schedule_deliveries WHERE schedule_id=? AND window=?")
      .bind(scheduleId, window)
      .first<{ execution_id: string }>();
    return row ?? null;
  } catch {
    return null;
  }
}
