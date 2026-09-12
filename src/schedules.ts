// SPDX-License-Identifier: AGPL-3.0
// Schedule Triggers (TRG-01, issue #137; ADR 012 accepted per that issue).
//
// A schedule Trigger pairs a Cloudflare Cron Trigger (the tick) with a durable
// Scheduled Execution row (the intent): the tick promotes due rows through the
// normal submit protocol. Cadence, enabled/disabled state, and timezone live
// as persisted per-installation environment state on the schedules table —
// never as Saga source properties (buildCatalog keeps rejecting
// schedule/cron keys today). Correspondingly, this module owns no Saga logic:
// it parses schedule policy, derives server-side submit keys, and promotes
// due rows into the existing dispatch path.
//
// Identity (ADR 012, decided): the deterministic Execution ID hashes
// (orgId, userId, key); a schedule has no client-supplied key. The tick
// derives the submit key server-side as
// `sched:{scheduleId}:{kind}:{window}` — e.g. `sched:abc:once:2026-…, or
// `sched:abc:recur:2026-…T…:00Z` — which satisfies the 16–128
// Idempotency-Key alphabet and keeps the existing tenant scoping plus the
// PRIMARY KEY single-winner discipline. Same-window duplicate ticks converge
// like concurrent identical submits; a window that already terminally settled
// replays its receipt (a cancelled window stays 409 EXECUTION_CANCELLED and
// needs the schedule disabled plus a fresh one-off — ticks never resurrect).
//
// Cross-window overlap is NOT dedup: a deterministic key for window W says
// nothing about W+1. Upstream skips a new window while an earlier delivery
// for the same source stays active; here the operator chooses per schedule:
// `overlap: "allow"` dispatches every due window (concurrent windows run
// side by side), `overlap: "skip"` skips a new window while an earlier
// window's Execution is non-terminal (Pending, Running, Cancelling, or
// Scheduled). A skipped window is not a failure: the tick records the skip
// on the schedule row (last_skipped_window) and keeps the next window.
import { executionId, Fault, UUID } from "./domain";
import type { Principal } from "./domain";

export type ScheduleKind = "once" | "recurring";
export type ScheduleStatus = "active" | "disabled" | "deleted";
export type ScheduleOverlap = "allow" | "skip";

/** One persisted schedule policy row (environment state, never Saga source). */
export interface ScheduleRow {
  id: string;
  org_id: string;
  user_id: string;
  saga_id: string;
  input_json: string;
  kind: ScheduleKind;
  status: ScheduleStatus;
  cron_expr: string | null;
  timezone: string;
  run_at: string | null;
  next_due_at: string | null;
  overlap: ScheduleOverlap;
  last_execution_id: string | null;
  last_skipped_window: string | null;
  created_at: string;
  updated_at: string;
}

/** Public schedule shape served by the schedule routes (no input payload). */
export interface ScheduleSummary {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sagaId: string;
  readonly kind: ScheduleKind;
  readonly status: ScheduleStatus;
  readonly cron: string | null;
  readonly timezone: string;
  readonly runAt: string | null;
  readonly nextDueAt: string | null;
  readonly overlap: ScheduleOverlap;
  readonly lastExecutionId: string | null;
  readonly lastSkippedWindow: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toScheduleSummary(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    sagaId: row.saga_id,
    kind: row.kind,
    status: row.status,
    cron: row.cron_expr,
    timezone: row.timezone,
    runAt: row.run_at,
    nextDueAt: row.next_due_at,
    overlap: row.overlap,
    lastExecutionId: row.last_execution_id,
    lastSkippedWindow: row.last_skipped_window,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Cron validation ----------------------------------------------------------
// Cloudflare Cron Triggers accept 5-field minute/hour/day-of-month/month/
// day-of-week expressions. Only the shapes Cloudflare documents are admitted:
// numeric fields, `*`, `*/n`, comma lists, numeric ranges, and the named
// shorthands (JAN–DEC, SUN–SAT). Seconds, years, `L`/`W`/`#`, and free text
// are refused — a "valid elsewhere" expression that Cloudflare cannot tick is
// a silent schedule, and silent schedules are the failure this gate exists
// to prevent.

const CRON_FIELD = /^[a-zA-Z0-9*,/-]+$/;

function parseCronField(field: string, min: number, max: number, names?: Readonly<Record<string, number>>): void {
  if (!CRON_FIELD.test(field)) {
    throw new Fault(400, "INVALID_CRON", "Cron must be five fields: minute hour day-of-month month day-of-week.");
  }
  const resolve = (token: string): number => {
    if (names && names[token.toUpperCase()] !== undefined) return names[token.toUpperCase()] as number;
    if (!/^\d+$/.test(token)) {
      throw new Fault(400, "INVALID_CRON", `Unsupported cron value in "${field}".`);
    }
    return Number(token);
  };
  for (const part of field.split(",")) {
    if (part.length === 0) {
      throw new Fault(400, "INVALID_CRON", "Cron lists must not hold empty entries.");
    }
    const [range, step] = part.split("/");
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1) {
        throw new Fault(400, "INVALID_CRON", `Cron step in "${part}" must be a positive integer.`);
      }
    }
    if (range === "*") continue;
    if (range === undefined || range.length === 0) {
      throw new Fault(400, "INVALID_CRON", `Unsupported cron value in "${field}".`);
    }
    if (range.includes("-")) {
      const [lo, hi] = range.split("-");
      if (lo === undefined || hi === undefined || lo.length === 0 || hi.length === 0) {
        throw new Fault(400, "INVALID_CRON", `Cron range "${part}" needs both bounds.`);
      }
      const low = resolve(lo);
      const high = resolve(hi);
      if (low < min || high > max || low > high) {
        throw new Fault(400, "INVALID_CRON", `Cron range "${part}" is outside ${min}-${max}.`);
      }
      continue;
    }
    const value = resolve(range);
    if (value < min || value > max) {
      throw new Fault(400, "INVALID_CRON", `Cron value "${part}" is outside ${min}-${max}.`);
    }
  }
}

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};
const WEEKDAYS: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/** Validate a 5-field Cloudflare cron expression. Returns the trimmed form. */
export function parseCronExpression(value: unknown): string {
  if (typeof value !== "string") {
    throw new Fault(400, "INVALID_CRON", "Cron must be five fields: minute hour day-of-month month day-of-week.");
  }
  const expr = value.trim().replace(/\s+/g, " ");
  const fields = expr.split(" ");
  if (fields.length !== 5 || fields.some((field) => field.length === 0 || field.length > 64)) {
    throw new Fault(400, "INVALID_CRON", "Cron must be five fields: minute hour day-of-month month day-of-week.");
  }
  parseCronField(fields[0] as string, 0, 59);
  parseCronField(fields[1] as string, 0, 23);
  parseCronField(fields[2] as string, 1, 31);
  parseCronField(fields[3] as string, 1, 12, MONTHS);
  parseCronField(fields[4] as string, 0, 6, WEEKDAYS);
  return expr;
}

// --- Timezone -----------------------------------------------------------------
// The timezone is a display/cadence label carried on the schedule row: the
// Cloudflare Cron tick fires in UTC, and next-window advancement runs in UTC.
// What the timezone buys is honest preview text (docs list DST/missed-tick
// behavior): an IANA name must parse under Intl, else the schedule is
// refused. "UTC" is the default; fixed offsets ("+02:00") are accepted as
// labels but never shift the UTC tick.

/** Validate an IANA timezone label (or UTC/fixed offset). Returns it verbatim. */
export function parseTimezone(value: unknown): string {
  if (value === undefined) return "UTC";
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new Fault(400, "INVALID_TIMEZONE", "Timezone must be an IANA name or UTC.");
  }
  const zone = value.trim();
  if (zone === "UTC" || /^[+-]\d{2}:\d{2}$/.test(zone)) return zone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
  } catch {
    throw new Fault(400, "INVALID_TIMEZONE", "Timezone must be an IANA name or UTC.");
  }
  return zone;
}

// --- Bodies ---------------------------------------------------------------------

export const SCHEDULE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SCHEDULE_MAX_PER_ORG = 100;
/** Bounded tick scan: at most this many schedules per Cron tick. */
export const TICK_SCAN_LIMIT = 50;
/** Bounded admission: at most this many due rows promoted per Cron tick. */
export const TICK_ADMISSION_LIMIT = 25;
export const SCHEDULE_ID = UUID;

export interface ScheduleCreate {
  readonly sagaId: string;
  readonly input: unknown;
  readonly kind: ScheduleKind;
  readonly cron?: string;
  readonly timezone?: string;
  readonly runAt?: string;
  readonly overlap?: ScheduleOverlap;
}

function parseRunAt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Fault(400, "INVALID_RUN_AT", "runAt must be an ISO 8601 date-time in the future.");
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Fault(400, "INVALID_RUN_AT", "runAt must be an ISO 8601 date-time in the future.");
  }
  const at = new Date(parsed).toISOString();
  if (Date.parse(at) <= Date.now()) {
    throw new Fault(400, "INVALID_RUN_AT", "runAt must be an ISO 8601 date-time in the future.");
  }
  return at;
}

function parseOverlap(value: unknown): ScheduleOverlap {
  if (value === undefined) return "allow";
  if (value === "allow" || value === "skip") return value;
  throw new Fault(400, "INVALID_OVERLAP", 'Overlap must be "allow" or "skip".');
}

export interface ScheduleSagaRef {
  readonly id: string;
  readonly name: string;
  readonly revision: string;
  readonly description: string;
  readonly parse: (input: unknown) => unknown;
}

/** Validate a schedule create/update body against the static Saga catalog.
 * Returns the parsed Saga plus its validated input. Unknown keys are
 * refused; one-off bodies carry runAt and no cron, recurring bodies carry
 * cron and no runAt. */
export function parseScheduleBody(
  value: unknown,
  sagas: readonly ScheduleSagaRef[],
): { saga: ScheduleSagaRef; input: unknown; create: ScheduleCreate } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Fault(400, "INVALID_SCHEDULE", "A schedule body with sagaId, input, and kind is required.");
  }
  const body = value as Record<string, unknown>;
  const allowed = ["sagaId", "input", "kind", "cron", "timezone", "runAt", "overlap"];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new Fault(400, "INVALID_SCHEDULE", `Unknown schedule field "${key}".`);
    }
  }
  const sagaId = body.sagaId;
  if (typeof sagaId !== "string" || !UUID.test(sagaId)) {
    throw new Fault(400, "INVALID_SAGA_ID", "sagaId must be a stable Saga UUID.");
  }
  const found = sagas.find((entry) => entry.id === sagaId);
  if (!found) throw new Fault(400, "UNKNOWN_SAGA", "Provide a built-in Saga ID and its input only.");
  let input: unknown;
  try {
    input = found.parse(body.input);
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(400, "INVALID_INPUT", "The Saga input did not pass validation.");
  }
  const kind = body.kind;
  if (kind !== "once" && kind !== "recurring") {
    throw new Fault(400, "INVALID_SCHEDULE", 'Schedule kind must be "once" or "recurring".');
  }
  const overlap = parseOverlap(body.overlap);
  const timezone = parseTimezone(body.timezone);
  if (kind === "once") {
    if (body.cron !== undefined) {
      throw new Fault(400, "INVALID_SCHEDULE", "One-off schedules carry runAt, never cron.");
    }
    const runAt = parseRunAt(body.runAt);
    return { saga: found, input, create: { sagaId, input, kind, timezone, runAt, overlap } };
  }
  if (body.runAt !== undefined) {
    throw new Fault(400, "INVALID_SCHEDULE", "Recurring schedules carry cron, never runAt.");
  }
  const cron = parseCronExpression(body.cron);
  return { saga: found, input, create: { sagaId, input, kind, cron, timezone, overlap } };
}

// --- Windows and keys --------------------------------------------------------------

/** Canonical window label: one-off uses its runAt instant; recurring windows
 * are minute-aligned UTC instants rendered without milliseconds. */
export function windowOf(kind: ScheduleKind, at: Date, runAt?: string): string {
  if (kind === "once") {
    if (!runAt) throw new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
    return new Date(Date.parse(runAt)).toISOString();
  }
  const aligned = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), 0, 0),
  );
  return aligned.toISOString().replace(".000Z", "Z");
}

/** Server-side submit key for one window. Satisfies the 16–128
 * Idempotency-Key alphabet (parseKey-compatible) by construction. */
export function scheduleKey(scheduleId: string, kind: ScheduleKind, window: string): string {
  const tag = kind === "once" ? "once" : "recur";
  return `sched.${scheduleId}.${tag}.${window}`;
}

/** Next-minute alignment for the first window of a recurring schedule. */
export function firstWindow(from: Date): Date {
  return new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes() + 1,
      0,
      0,
    ),
  );
}

/** Match a UTC instant against a validated 5-field cron expression. Pure and
 * unit-tested; the tick uses the same predicate as the preview route. */
export function cronMatches(expr: string, at: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.split(" ");
  const match = (field: string | undefined, value: number, names?: Readonly<Record<string, number>>): boolean => {
    if (field === undefined) return false;
    const resolve = (token: string): number => {
      if (names && names[token.toUpperCase()] !== undefined) return names[token.toUpperCase()] as number;
      return Number(token);
    };
    for (const part of field.split(",")) {
      const [range, stepRaw] = part.split("/");
      const step = stepRaw === undefined ? 1 : Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) continue;
      const inRange = (candidate: number): boolean => candidate % step === 0;
      if (range === "*") {
        if (inRange(value)) return true;
        continue;
      }
      if (range !== undefined && range.includes("-")) {
        const [lo, hi] = range.split("-");
        if (lo === undefined || hi === undefined) continue;
        const low = resolve(lo);
        const high = resolve(hi);
        if (value >= low && value <= high && (value - low) % step === 0) return true;
        continue;
      }
      if (range !== undefined && resolve(range) === value && inRange(value)) return true;
    }
    return false;
  };
  return (
    match(minute, at.getUTCMinutes()) &&
    match(hour, at.getUTCHours()) &&
    match(dayOfMonth, at.getUTCDate()) &&
    match(month, at.getUTCMonth() + 1, MONTHS) &&
    match(dayOfWeek, at.getUTCDay(), WEEKDAYS)
  );
}

/** Next window strictly after `from` for a recurring expression. Scans
 * minute by minute up to 366 days; throws SCHEDULE_UNMATCHABLE when nothing
 * matches (e.g. Feb 30) instead of looping forever. Pure and unit-tested. */
export function nextWindow(expr: string, from: Date): Date {
  let candidate = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes(),
      0,
      0,
    ) + 60_000,
  );
  for (let step = 0; step < 366 * 24 * 60; step += 1) {
    if (cronMatches(expr, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  throw new Fault(400, "SCHEDULE_UNMATCHABLE", "The cron expression matches no minute within a year.");
}

/** Next `count` windows strictly after `from` (preview). Bounded to 20 so
 * the preview route cannot scan unboundedly. */
export function previewWindows(expr: string, from: Date, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Fault(400, "INVALID_PREVIEW", "Preview count must be an integer from 1 to 20.");
  }
  const windows: string[] = [];
  let cursor = from;
  for (let index = 0; index < count; index += 1) {
    cursor = nextWindow(expr, cursor);
    windows.push(windowOf("recurring", cursor));
  }
  return windows;
}

// --- Persistence ----------------------------------------------------------------------

function scheduleNow(): string {
  return new Date().toISOString();
}

/** Insert a schedule row plus its first durable Scheduled intent row. The
 * intent row carries the deterministic window key so a racing tick converges
 * instead of forking: same-window ticks replay the same Execution. */
export async function createSchedule(
  db: D1Database,
  caller: Principal,
  saga: ScheduleSagaRef,
  input: unknown,
  create: ScheduleCreate,
): Promise<ScheduleSummary> {
  const existing = await db
    .prepare("SELECT COUNT(*) AS n FROM schedules WHERE org_id=? AND status='active'")
    .bind(caller.orgId)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) >= SCHEDULE_MAX_PER_ORG) {
    throw new Fault(409, "SCHEDULE_LIMIT", `At most ${SCHEDULE_MAX_PER_ORG} active schedules per Organization.`);
  }
  const id = crypto.randomUUID().toLowerCase();
  const stamp = scheduleNow();
  const inputJson = JSON.stringify(input);
  const nextDue =
    create.kind === "once"
      ? (create.runAt as string)
      : windowOf("recurring", nextWindow(create.cron as string, new Date()));
  await db.batch([
    db
      .prepare(
        "INSERT INTO schedules(id,org_id,user_id,saga_id,input_json,kind,status,cron_expr,timezone,run_at,next_due_at,overlap,last_execution_id,last_skipped_window,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        caller.orgId,
        caller.userId,
        saga.id,
        inputJson,
        create.kind,
        "active",
        create.kind === "recurring" ? (create.cron as string) : null,
        create.timezone ?? "UTC",
        create.kind === "once" ? (create.runAt as string) : null,
        nextDue,
        create.overlap ?? "allow",
        null,
        null,
        stamp,
        stamp,
      ),
    db
      .prepare(
        "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,schedule_id,due_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        await scheduleExecutionId(
          caller,
          scheduleKey(id, create.kind, create.kind === "once" ? (create.runAt as string) : nextDue),
        ),
        saga.id,
        saga.name,
        saga.revision,
        caller.orgId,
        caller.userId,
        inputJson,
        0,
        "Scheduled",
        id,
        nextDue,
        stamp,
      ),
  ]);
  const row = await loadSchedule(db, caller.orgId, id);
  if (!row) throw new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
  return toScheduleSummary(row);
}

/** Deterministic Execution ID for one schedule window. Same tuple shape as
 * the submit path (executionId in domain.ts), with the server-derived key —
 * so promotion reuses the idempotency record instead of inventing a second
 * identity discipline. */
export async function scheduleExecutionId(caller: Principal, key: string): Promise<string> {
  return executionId(caller, key);
}

/** Load one schedule for this Organization. Foreign rows resolve to null so
 * routes answer 404, never a cross-tenant leak. */
export async function loadSchedule(db: D1Database, orgId: string, id: string): Promise<ScheduleRow | null> {
  if (!UUID.test(id)) return null;
  const row = await db
    .prepare("SELECT * FROM schedules WHERE id=? AND org_id=?")
    .bind(id.toLowerCase(), orgId)
    .first<ScheduleRow>();
  return row ?? null;
}

/** List schedules for one Organization, newest first. Deleted rows are
 * excluded by default; pass includeDeleted for the operator audit view. */
export async function listSchedules(db: D1Database, orgId: string, includeDeleted = false): Promise<ScheduleSummary[]> {
  const rows = await db
    .prepare(
      includeDeleted
        ? "SELECT * FROM schedules WHERE org_id=? ORDER BY created_at DESC,id DESC"
        : "SELECT * FROM schedules WHERE org_id=? AND status!='deleted' ORDER BY created_at DESC,id DESC",
    )
    .bind(orgId)
    .all<ScheduleRow>();
  return rows.results.map(toScheduleSummary);
}

/** Enable/disable a schedule. Disabling stops future ticks from promoting;
 * already-promoted Executions keep their own terminal lifecycle. */
export async function setScheduleStatus(
  db: D1Database,
  orgId: string,
  id: string,
  disabled: boolean,
): Promise<ScheduleSummary> {
  const row = await loadSchedule(db, orgId, id);
  if (!row || row.status === "deleted") throw new Fault(404, "SCHEDULE_NOT_FOUND", "Schedule not found.");
  const next: ScheduleStatus = disabled ? "disabled" : "active";
  if (row.status === next) return toScheduleSummary(row);
  const stamp = scheduleNow();
  await db
    .prepare("UPDATE schedules SET status=?,updated_at=? WHERE id=? AND org_id=?")
    .bind(next, stamp, row.id, orgId)
    .run();
  if (!disabled && row.kind === "recurring") {
    await advanceRecurring(db, row, new Date(), stamp);
  }
  const updated = await loadSchedule(db, orgId, id);
  if (!updated) throw new Fault(404, "SCHEDULE_NOT_FOUND", "Schedule not found.");
  return toScheduleSummary(updated);
}

/** Soft-delete a schedule. Future ticks ignore it; its ExecutionHistory
 * rows are retained (they carry their own org scoping, like org deletes). */
export async function deleteSchedule(db: D1Database, orgId: string, id: string): Promise<void> {
  const row = await loadSchedule(db, orgId, id);
  if (!row || row.status === "deleted") throw new Fault(404, "SCHEDULE_NOT_FOUND", "Schedule not found.");
  await db
    .prepare("UPDATE schedules SET status='deleted',updated_at=? WHERE id=? AND org_id=?")
    .bind(scheduleNow(), row.id, orgId)
    .run();
}

/** Cancel a Scheduled (not yet promoted) Execution by exact Execution ID.
 * Promoted rows (Pending+) are not schedule-cancelled: the owner cancel
 * route owns those. Cancelling the intent row stops the tick from promoting
 * it; the receipt stays Cancelled so a later tick replays 409 rather than
 * resurrecting. */
export async function cancelScheduledExecution(
  db: D1Database,
  caller: Principal,
  executionIdValue: string,
): Promise<{ executionId: string; status: string; cancelled: boolean }> {
  const row = await db
    .prepare("SELECT * FROM executions WHERE id=? AND org_id=? AND user_id=?")
    .bind(executionIdValue, caller.orgId, caller.userId)
    .first<{ id: string; status: string; schedule_id: string | null }>();
  if (!row) throw new Fault(404, "EXECUTION_NOT_FOUND", "Execution not found.");
  if (row.status !== "Scheduled") {
    throw new Fault(409, "EXECUTION_NOT_CANCELLABLE", "Only Scheduled Executions can be cancelled here.");
  }
  const stamp = scheduleNow();
  await db
    .prepare("UPDATE executions SET status='Cancelled',completed_at=?,error_json=? WHERE id=? AND status='Scheduled'")
    .bind(
      stamp,
      JSON.stringify({ code: "EXECUTION_CANCELLED", message: "The Scheduled Execution was cancelled by its owner." }),
      row.id,
    )
    .run();
  return { executionId: row.id, status: "Cancelled", cancelled: true };
}

/** Advance a recurring schedule past `now`: recompute next_due_at from the
 * stored cron expression and stamp it. Called after each promotion (and on
 * re-enable) so the due index always points at the next unclaimed window. */
export async function advanceRecurring(
  db: D1Database,
  schedule: ScheduleRow,
  now: Date,
  stamp?: string,
): Promise<void> {
  if (schedule.kind !== "recurring" || !schedule.cron_expr) return;
  const at = stamp ?? scheduleNow();
  try {
    const next = windowOf("recurring", nextWindow(schedule.cron_expr, now));
    await db.prepare("UPDATE schedules SET next_due_at=?,updated_at=? WHERE id=?").bind(next, at, schedule.id).run();
  } catch {
    // An unmatchable cron (edited data, leap-day edge) disables the schedule
    // rather than spinning the tick: loud in the row, never silent.
    await db.prepare("UPDATE schedules SET status='disabled',updated_at=? WHERE id=?").bind(at, schedule.id).run();
  }
}

export interface TickResult {
  readonly scanned: number;
  readonly promoted: number;
  readonly skipped: number;
  readonly receipts: ReadonlyArray<{ scheduleId: string; window: string; executionId: string; replayed: boolean }>;
}

/** One Cron tick: scan due schedules (bounded), promote each due intent row
 * exactly once through the submit protocol, advance recurring windows.
 * Pure promotion: no Saga logic, no Connection reads, no vendor calls —
 * those happen inside the dispatched Workflow. Racing ticks converge on the
 * deterministic Execution ID (PRIMARY KEY single winner + retained-ID
 * dedup); disabled/deleted schedules and revoked callers are skipped
 * without promotion. */
export async function runTick(
  db: D1Database,
  promote: (args: {
    schedule: ScheduleRow;
    window: string;
    key: string;
    executionId: string;
  }) => Promise<{ executionId: string; replayed: boolean; skipped: boolean; skipReason?: string }>,
  now = new Date(),
): Promise<TickResult> {
  const at = now.toISOString();
  const rows = await db
    .prepare(
      "SELECT * FROM schedules WHERE status='active' AND next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at,id LIMIT ?",
    )
    .bind(at, TICK_SCAN_LIMIT)
    .all<ScheduleRow>();
  const receipts: { scheduleId: string; window: string; executionId: string; replayed: boolean }[] = [];
  let promoted = 0;
  let skipped = 0;
  let admitted = 0;
  for (const schedule of rows.results) {
    if (admitted >= TICK_ADMISSION_LIMIT) break;
    const window = schedule.next_due_at as string;
    const key = scheduleKey(schedule.id, schedule.kind, window);
    const outcome = await promote({ schedule, window, key, executionId: "" });
    if (outcome.skipped) {
      skipped += 1;
      await db
        .prepare("UPDATE schedules SET last_skipped_window=?,updated_at=? WHERE id=?")
        .bind(window, scheduleNow(), schedule.id)
        .run();
    } else {
      admitted += 1;
      promoted += 1;
      receipts.push({ scheduleId: schedule.id, window, executionId: outcome.executionId, replayed: outcome.replayed });
    }
    if (schedule.kind === "recurring") {
      await advanceRecurring(db, schedule, now);
    } else {
      // One-off schedules retire after their window is claimed OR skipped:
      // the intent row keeps the receipt either way.
      await db
        .prepare("UPDATE schedules SET status='disabled',updated_at=? WHERE id=?")
        .bind(scheduleNow(), schedule.id)
        .run();
    }
  }
  return { scanned: rows.results.length, promoted, skipped, receipts: Object.freeze(receipts) };
}
