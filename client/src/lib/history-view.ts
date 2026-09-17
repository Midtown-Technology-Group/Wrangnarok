// SPDX-License-Identifier: AGPL-3.0
// Pure view helpers for the ExecutionHistory page. Structure borrowed from
// upstream gobifrost/bifrost historyView.ts (reference: vendor/upstream);
// Wrangnarök shapes and vocabulary only: Saga (not Workflow), Execution
// (not run), no Agents surface.
//
// Filtering is split by surface on purpose: the Worker history API serves
// status (single or multi), exact Saga name, and ISO date bounds (ADR 001,
// 400 UNSUPPORTED_QUERY outside the allowlist), so those filters run
// server-side while free-text search stays client-side over each loaded
// slice. The summary line states the scope honestly when hasMore is true.
import type { ExecutionSummary } from "./client-types";

/** Every Execution status the Worker can persist (ADR 001 CHECK; TRG-01 promotes schedules directly to Pending). */
export const HISTORY_STATUSES = [
  "Pending",
  "Running",
  "Succeeded",
  "Failed",
  "TimedOut",
  "Cancelling",
  "Cancelled",
] as const;

export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export type StatusFilter = "all" | HistoryStatus;

export interface HistoryFilterState {
  /** Free text matched against Saga name, user ID, Execution ID, status. */
  search: string;
  /** Exact Saga name; "" means all Sagas. */
  sagaName: string;
  status: StatusFilter;
  /** Inclusive calendar-day bounds ("YYYY-MM-DD"); "" means open. */
  from: string;
  to: string;
  /** Render Started/day groups in local time instead of UTC. */
  localTime: boolean;
}

export const EMPTY_HISTORY_FILTERS: HistoryFilterState = {
  search: "",
  sagaName: "",
  status: "all",
  from: "",
  to: "",
  localTime: true,
};

/** The timestamp that anchors an Execution on the timeline. */
export function executionAnchorDate(row: ExecutionSummary): Date | null {
  const iso = row.startedAt ?? row.createdAt;
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar-day key ("YYYY-MM-DD") in local time or UTC. */
export function dayKey(date: Date, localTime: boolean): string {
  if (localTime) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function dayLabel(date: Date, localTime: boolean, now: Date): string {
  const key = dayKey(date, localTime);
  if (key === dayKey(now, localTime)) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (key === dayKey(yesterday, localTime)) return "Yesterday";
  return localTime
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export interface ExecutionDayGroup {
  /** Stable key: day "YYYY-MM-DD" or "unknown". */
  key: string;
  /** Human label: "Today", "Yesterday", a short date, or "Undated". */
  label: string;
  executions: ExecutionSummary[];
}

/**
 * Group rows into calendar-day buckets by anchor date. Order within a group
 * is preserved as given; groups run newest day first with undated last.
 */
export function groupExecutionsByDay(
  rows: ExecutionSummary[],
  localTime: boolean,
  now: Date = new Date(),
): ExecutionDayGroup[] {
  const byKey = new Map<string, ExecutionDayGroup>();
  for (const row of rows) {
    const anchor = executionAnchorDate(row);
    const key = anchor ? dayKey(anchor, localTime) : "unknown";
    const existing = byKey.get(key);
    if (existing) existing.executions.push(row);
    else byKey.set(key, { key, label: anchor ? dayLabel(anchor, localTime, now) : "Undated", executions: [row] });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.key === "unknown") return 1;
    if (b.key === "unknown") return -1;
    return b.key.localeCompare(a.key);
  });
}

export interface HistorySummary {
  total: number;
  byStatus: Partial<Record<HistoryStatus, number>>;
}

/** Page-level rollup over the loaded rows (not the whole table). */
export function summarizeExecutions(rows: ExecutionSummary[]): HistorySummary {
  const byStatus: Partial<Record<HistoryStatus, number>> = {};
  for (const row of rows) {
    const status = row.status as HistoryStatus;
    if ((HISTORY_STATUSES as readonly string[]).includes(status)) {
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
  }
  return { total: rows.length, byStatus };
}

/** Client-side filter over one loaded history page. */
export function filterExecutions(rows: ExecutionSummary[], filters: HistoryFilterState): ExecutionSummary[] {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status !== "all" && row.status !== filters.status) return false;
    if (filters.sagaName !== "" && row.sagaName !== filters.sagaName) return false;
    if (search !== "") {
      const haystack = `${row.sagaName} ${row.userId} ${row.executionId} ${row.status}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (filters.from !== "" || filters.to !== "") {
      const anchor = executionAnchorDate(row);
      if (!anchor) return false;
      const key = dayKey(anchor, filters.localTime);
      if (filters.from !== "" && key < filters.from) return false;
      if (filters.to !== "" && key > filters.to) return false;
    }
    return true;
  });
}

/** Whether any narrowing filter is active (drives empty-state copy). */
export function hasActiveHistoryFilters(filters: HistoryFilterState): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.sagaName !== "" ||
    filters.status !== "all" ||
    filters.from !== "" ||
    filters.to !== ""
  );
}

/**
 * Compact single-line time: "08:12 AM" for today, "Jun 10, 08:12 AM"
 * otherwise. Unparseable input is returned unchanged.
 */
export function formatExecutionTime(iso: string | null, localTime: boolean, now: Date = new Date()): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const timePart = localTime
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
  if (dayKey(date, localTime) === dayKey(now, localTime)) return timePart;
  const dayPart = localTime
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  return `${dayPart}, ${timePart}`;
}

/** Duration between two timestamps, compact ("3s", "1m 12s", "412ms"). */
export function formatExecutionDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const ms = end - start;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}
