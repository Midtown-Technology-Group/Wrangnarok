// SPDX-License-Identifier: AGPL-3.0
// OPS-04 slice S1 (issue #175): attributed usage summaries over the existing
// usage_blocks table (migration 0003). Worker + D1 only, no new primitive.
//
// What this is: per-Organization, per-Saga aggregates of application-observed
// counters (D1 statements/rows, Workflow steps/durations) already persisted
// by persistUsage (src/usage.ts). One usage_blocks row per execution_id by
// primary key, so replays and duplicate persists can never double-count.
//
// What this is not (S2 explicit no-build): there are no metered model-token
// events anywhere in the tree, so every dollar figure would be fabricated.
// The response says so explicitly: model costs are "unpriced", provider
// billing is "unavailable", estimates are "none", and no cost, price,
// currency arithmetic, or savings claim appears. Show the gap, never
// interpolate money.
import { Fault, parseDateBound } from "./domain";

export interface UsageSummaryQuery {
  readonly saga: string | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
}

export interface UsageSagaTotals {
  readonly saga: string;
  readonly executions: number;
  readonly d1Reads: number;
  readonly d1Writes: number;
  readonly operationRows: number;
  readonly stepsExecuted: number;
  readonly durationMs: number;
}

export type UsageTotals = Omit<UsageSagaTotals, "saga">;

export interface UsageGaps {
  readonly modelTokenCosts: "unpriced";
  readonly providerBilling: "unavailable";
  readonly estimates: "none";
  readonly currency: null;
  readonly unreadableBlocks: number;
}

export interface UsageSummary {
  readonly orgId: string;
  readonly window: { readonly start: string | null; readonly end: string | null };
  readonly totals: UsageTotals;
  readonly bySaga: readonly UsageSagaTotals[];
  readonly byStatus: Readonly<Record<string, number>>;
  readonly cancelledExecutions: number;
  /** Truncation contract: rows are the oldest matches up to the row limit.
   * matchedExecutions counts every match; truncated is true when totals
   * cover only a prefix, so a capped summary can never read as complete. */
  readonly matchedExecutions: number;
  readonly truncated: boolean;
  readonly gaps: UsageGaps;
  readonly note: string;
}

/** Maximum usage_blocks rows aggregated per summary read. Worker + D1 only:
 * the cap keeps one read inside Free-tier time/row budgets; the response
 * says when it applied (truncated/matchedExecutions) instead of silently
 * reporting a prefix as the total. */
export const USAGE_SUMMARY_ROW_LIMIT = 5000;

const SUMMARY_NOTE =
  "Application-observed statements/rows/steps in local or dev runtime; not Cloudflare metering. " +
  "Model token costs are unpriced and provider billing is unavailable: no cost, currency, or savings " +
  "figure is reported here. Verify allowances vs current Cloudflare pricing before claiming Free-tier headroom.";

/** Pure parser for GET /api/usage/summary. Only saga, startDate, and endDate
 * are supported; anything else answers UNSUPPORTED_QUERY. The window is
 * inclusive [startDate, endDate], mirroring the upstream usage-report
 * posture: a date-only endDate covers its whole calendar day (through
 * 23:59:59.999Z), so records created later on the end day are included.
 * An inverted window answers INVALID_WINDOW. */
export function parseUsageSummaryQuery(params: URLSearchParams): UsageSummaryQuery {
  for (const key of params.keys()) {
    if (!["saga", "startDate", "endDate"].includes(key)) {
      throw new Fault(400, "UNSUPPORTED_QUERY", "Only saga, startDate, and endDate are supported here.");
    }
  }
  let saga: string | null = null;
  const rawSaga = params.get("saga");
  if (rawSaga !== null) {
    if (rawSaga.length === 0 || rawSaga.length > 320) {
      throw new Fault(400, "INVALID_SAGA", "Saga must be a 1 to 320 character Saga name filter.");
    }
    saga = rawSaga;
  }
  let startAt: string | null = null;
  const rawStart = params.get("startDate");
  if (rawStart !== null) startAt = parseDateBound(rawStart, "INVALID_START_DATE");
  let endAt: string | null = null;
  const rawEnd = params.get("endDate");
  if (rawEnd !== null) {
    endAt = parseDateBound(rawEnd, "INVALID_END_DATE");
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) {
      endAt = new Date(Date.parse(endAt) + 86_400_000 - 1).toISOString();
    }
  }
  if (startAt !== null && endAt !== null && startAt > endAt) {
    throw new Fault(400, "INVALID_WINDOW", "startDate must not be after endDate.");
  }
  return { saga, startAt, endAt };
}

interface UsageJoinRow {
  execution_id: string;
  usage_json: string;
  created_at: string;
  saga_name: string;
  status: string;
}

interface ParsedBlock {
  d1Reads: number;
  d1Writes: number;
  operationRows: number;
  stepsExecuted: number;
  durationMs: number;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Best-effort decode of one usage_json payload. Corrupt or unexpected
 * shapes contribute zeros and are counted in gaps.unreadableBlocks instead
 * of failing the summary: diagnostics degrade, never throw. */
function parseBlock(raw: string): ParsedBlock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const d1 = (record.d1 ?? {}) as Record<string, unknown>;
  const workflows = (record.workflows ?? {}) as Record<string, unknown>;
  return {
    d1Reads: toCount(d1.reads),
    d1Writes: toCount(d1.writes),
    operationRows: toCount(d1.operationRows),
    stepsExecuted: toCount(workflows.stepsExecuted),
    durationMs: toCount(workflows.durationMs),
  };
}

interface MutableTotals {
  executions: number;
  d1Reads: number;
  d1Writes: number;
  operationRows: number;
  stepsExecuted: number;
  durationMs: number;
}

function emptyTotals(): MutableTotals {
  return { executions: 0, d1Reads: 0, d1Writes: 0, operationRows: 0, stepsExecuted: 0, durationMs: 0 };
}

/** Attributed usage summary for one Organization. Org scoping binds the
 * executions row (the authorization truth), never usage_json.orgId, so a
 * spoofed payload cannot move counts across the boundary. Status and Saga
 * likewise come from the executions row: cancellation-aware
 * (Cancelled/Cancelling keep their own buckets) and rename-proof. */
export async function getUsageSummary(
  db: D1Database,
  orgId: string,
  query: UsageSummaryQuery,
  rowLimit = USAGE_SUMMARY_ROW_LIMIT,
): Promise<UsageSummary> {
  const conditions = ["e.org_id=?"];
  const binds: unknown[] = [orgId];
  if (query.saga !== null) {
    conditions.push("e.saga_name=?");
    binds.push(query.saga);
  }
  if (query.startAt !== null) {
    conditions.push("u.created_at>=?");
    binds.push(query.startAt);
  }
  if (query.endAt !== null) {
    conditions.push("u.created_at<=?");
    binds.push(query.endAt);
  }
  const where = conditions.join(" AND ");
  const degraded: UsageSummary = {
    orgId,
    window: { start: query.startAt, end: query.endAt },
    totals: emptyTotals(),
    bySaga: [],
    byStatus: {},
    cancelledExecutions: 0,
    matchedExecutions: 0,
    truncated: false,
    gaps: {
      modelTokenCosts: "unpriced",
      providerBilling: "unavailable",
      estimates: "none",
      currency: null,
      unreadableBlocks: 0,
    },
    note: SUMMARY_NOTE,
  };
  let rows: UsageJoinRow[];
  let matchedExecutions: number;
  try {
    const counted = await db
      .prepare(`SELECT COUNT(*) AS n FROM usage_blocks u JOIN executions e ON e.id=u.execution_id WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    matchedExecutions = counted?.n ?? 0;
    const result = await db
      .prepare(
        `SELECT u.execution_id,u.usage_json,u.created_at,e.saga_name,e.status FROM usage_blocks u ` +
          `JOIN executions e ON e.id=u.execution_id WHERE ${where} ` +
          `ORDER BY u.created_at ASC,u.execution_id ASC LIMIT ?`,
      )
      .bind(...binds, Math.max(1, Math.floor(rowLimit)))
      .all<UsageJoinRow>();
    rows = result.results;
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return degraded;
    }
    throw error;
  }
  const totals = emptyTotals();
  const sagas = new Map<string, MutableTotals>();
  const byStatus: Record<string, number> = {};
  let cancelledExecutions = 0;
  let unreadableBlocks = 0;
  for (const row of rows) {
    const block = parseBlock(row.usage_json);
    if (!block) {
      unreadableBlocks += 1;
      continue;
    }
    totals.executions += 1;
    totals.d1Reads += block.d1Reads;
    totals.d1Writes += block.d1Writes;
    totals.operationRows += block.operationRows;
    totals.stepsExecuted += block.stepsExecuted;
    totals.durationMs += block.durationMs;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status === "Cancelled" || row.status === "Cancelling") cancelledExecutions += 1;
    const entry = sagas.get(row.saga_name) ?? emptyTotals();
    entry.executions += 1;
    entry.d1Reads += block.d1Reads;
    entry.d1Writes += block.d1Writes;
    entry.operationRows += block.operationRows;
    entry.stepsExecuted += block.stepsExecuted;
    entry.durationMs += block.durationMs;
    sagas.set(row.saga_name, entry);
  }
  // Map keys are unique, so the comparator never sees equal names.
  const bySaga: UsageSagaTotals[] = [...sagas.entries()]
    .map(([saga, entry]) => ({ saga, ...entry }))
    .sort((a, b) => (a.saga < b.saga ? -1 : 1));
  return {
    orgId,
    window: { start: query.startAt, end: query.endAt },
    totals,
    bySaga,
    byStatus,
    cancelledExecutions,
    matchedExecutions,
    truncated: totals.executions + unreadableBlocks < matchedExecutions,
    gaps: {
      modelTokenCosts: "unpriced",
      providerBilling: "unavailable",
      estimates: "none",
      currency: null,
      unreadableBlocks,
    },
    note: SUMMARY_NOTE,
  };
}
