// SPDX-License-Identifier: AGPL-3.0
// ExecutionHistory page. Layout borrowed (not verbatim) from upstream
// gobifrost/bifrost client/src/pages/ExecutionHistory.tsx (reference:
// vendor/upstream/client) with Wrangnarök vocabulary throughout: Saga (not
// Workflow), Execution (not run), and no Agents surface.
//
// Filtering is split by surface on purpose. Status (single or multi), exact
// Saga name, and ISO date bounds run server-side through the allowlisted
// history query keys (status, sagaId, sagaName, startDate, endDate, limit,
// cursor — upstream parity: scope/workflow + multi-status + ISO dates +
// keyset continuation). Free-text search stays client-side over each loaded
// slice (upstream exposes no search param on the executions list; only the
// admin-only logs surface has message_search). The summary line states the
// scope honestly: loaded-slice counts plus "more available" whenever the
// server reports hasMore — first-page counts are never presented as totals.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchExecutionHistory, getToken, listSagas, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ExecutionHistoryResponse, ExecutionSummary, ExecutionStatus, SagaSummary } from "../lib/client-types";
import {
  EMPTY_HISTORY_FILTERS,
  HISTORY_STATUSES,
  filterExecutions,
  formatExecutionDuration,
  formatExecutionTime,
  groupExecutionsByDay,
  hasActiveHistoryFilters,
  summarizeExecutions,
  type HistoryFilterState,
  type StatusFilter,
} from "../lib/history-view";
import { StatusBadge } from "../components/StatusBadge";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** Server-side status sets: which pill maps to which server filter. */
export const SERVER_STATUS_FILTERS: Readonly<Record<StatusFilter, ExecutionStatus[] | undefined>> = {
  all: undefined,
  Pending: ["Pending"],
  Running: ["Running"],
  Succeeded: ["Succeeded"],
  Failed: ["Failed"],
  TimedOut: ["TimedOut"],
  Cancelling: ["Cancelling"],
  Cancelled: ["Cancelled"],
};

function RowCells({ row, localTime }: { row: ExecutionSummary; localTime: boolean }): React.JSX.Element {
  const duration = formatExecutionDuration(row.startedAt, row.completedAt);
  return (
    <>
      <td>
        <code className="mono" title={row.orgId}>
          {shortId(row.orgId)}
        </code>
      </td>
      <td>
        <Link to={`/history/${row.executionId}`} className="saga-link">
          {row.sagaName}
        </Link>
        <div className="muted muted--small">{row.sagaRevision}</div>
      </td>
      <td>
        <StatusBadge status={row.status} />
      </td>
      <td>
        <code className="mono" title={row.userId}>
          {shortId(row.userId)}
        </code>
      </td>
      <td>
        <time className="muted" title={row.startedAt ?? row.createdAt}>
          {formatExecutionTime(row.startedAt ?? row.createdAt, localTime)}
        </time>
      </td>
      <td className="cell--numeric">
        <span className="muted">{duration ?? "—"}</span>
      </td>
      <td className="cell--chevron">
        <Link
          to={`/history/${row.executionId}`}
          className="chevron-link"
          aria-label={`Open Execution ${row.executionId}`}
        >
          <span aria-hidden="true">›</span>
        </Link>
      </td>
    </>
  );
}

export function ExecutionHistoryList(props: { initial?: ExecutionHistoryResponse }): React.JSX.Element {
  const [pages, setPages] = useState<ExecutionSummary[][]>(props.initial ? [props.initial.executions] : []);
  const [hasMore, setHasMore] = useState(props.initial?.hasMore ?? false);
  const [nextCursor, setNextCursor] = useState<string | null>(props.initial?.nextCursor ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [token, setTokenState] = useState(getToken());
  const [filters, setFilters] = useState<HistoryFilterState>(EMPTY_HISTORY_FILTERS);
  const [catalog, setCatalog] = useState<SagaSummary[] | null>(null);

  // Stable Saga UUID for the selected Saga name (catalog first, loaded rows
  // as fallback so the dropdown keeps working if the catalog fetch fails).
  const loaded = useMemo(() => pages.flat(), [pages]);
  const serverSagaId = useMemo(() => {
    if (filters.sagaName === "") return undefined;
    const fromCatalog = catalog?.find((saga) => saga.name === filters.sagaName)?.id;
    if (fromCatalog) return fromCatalog;
    return loaded.find((row) => row.sagaName === filters.sagaName)?.sagaId;
  }, [catalog, loaded, filters.sagaName]);
  const serverStatuses = SERVER_STATUS_FILTERS[filters.status];

  const serverQuery = useMemo(
    () => ({
      ...(serverStatuses ? { status: serverStatuses } : {}),
      // Exact-name fallback keeps the Saga filter server-side even when the
      // catalog fetch failed (e.g. a catalog 500): the server matches
      // saga_name directly, so filters never silently go client-only.
      ...(serverSagaId ? { sagaId: serverSagaId } : filters.sagaName !== "" ? { sagaName: filters.sagaName } : {}),
      ...(filters.from !== "" ? { startDate: filters.from } : {}),
      ...(filters.to !== "" ? { endDate: filters.to } : {}),
    }),
    [serverStatuses, serverSagaId, filters.sagaName, filters.from, filters.to],
  );

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const first = await fetchExecutionHistory(serverQuery);
      setPages([first.executions]);
      setHasMore(first.hasMore);
      setNextCursor(first.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load history."));
    } finally {
      setLoading(false);
    }
  }, [serverQuery]);

  // Server-filtered refetch: any server-side filter change resets to page
  // one with the same filters applied — never mixing cursors across queries.
  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const first = await fetchExecutionHistory(serverQuery);
        if (cancelled) return;
        setPages([first.executions]);
        setHasMore(first.hasMore);
        setNextCursor(first.nextCursor);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load history."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial, serverQuery]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      // Cursor traversal preserves the active server filters: the next page
      // is the same query resumed below the cursor, never an unfiltered tail.
      const next = await fetchExecutionHistory({ ...serverQuery, cursor: nextCursor });
      const seen = new Set(loaded.map((row) => row.executionId));
      setPages((prev) => [...prev, next.executions.filter((row) => !seen.has(row.executionId))]);
      setHasMore(next.hasMore);
      setNextCursor(next.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the next page."));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, nextCursor, loadingMore, serverQuery, loaded]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sagas = await listSagas();
        if (!cancelled) setCatalog(sagas.sagas);
      } catch {
        if (!cancelled) setCatalog(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sagaNames = useMemo(
    () => [...new Set([...(catalog ?? []).map((saga) => saga.name), ...loaded.map((row) => row.sagaName)])].sort(),
    [catalog, loaded],
  );
  // Free-text search is client-side over the loaded slices only: the server
  // exposes no search param here, so the empty-state copy says so whenever
  // more rows exist server-side.
  const filtered = useMemo(
    () => filterExecutions(loaded, { ...filters, status: "all", sagaName: "", from: "", to: "" }),
    [loaded, filters],
  );
  const groups = useMemo(() => groupExecutionsByDay(filtered, filters.localTime), [filtered, filters.localTime]);
  const summary = useMemo(() => summarizeExecutions(loaded), [loaded]);
  const filtersActive = hasActiveHistoryFilters(filters);

  const setStatus = (status: StatusFilter): void => setFilters((prev) => ({ ...prev, status }));
  const clearFilters = (): void => setFilters((prev) => ({ ...EMPTY_HISTORY_FILTERS, localTime: prev.localTime }));

  return (
    <section aria-labelledby="history-heading">
      <h1 id="history-heading">Execution history</h1>
      <p className="summary-line" data-testid="history-summary">
        {summary.total === 0 ? (
          "No Executions loaded."
        ) : (
          <>
            {summary.total} Execution{summary.total !== 1 ? "s" : ""} loaded
            {HISTORY_STATUSES.map((status) =>
              summary.byStatus[status] ? (
                <span key={status}>
                  {" · "}
                  {summary.byStatus[status]} {status}
                </span>
              ) : null,
            )}
            {hasMore ? " · more available server-side" : null}
          </>
        )}
      </p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          void loadFirstPage();
        }}
      >
        <label htmlFor="token">Bearer token (local fixture only, never committed)</label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setTokenState(e.target.value)}
          placeholder="paste LAB_TOKEN"
        />
        <button type="submit">Reload</button>
      </form>
      <form className="filter-bar" aria-label="Filter Executions" onSubmit={(e) => e.preventDefault()}>
        <div className="filter-field">
          <label htmlFor="history-search">Name search (loaded pages only)</label>
          <input
            id="history-search"
            name="search"
            type="search"
            autoComplete="off"
            placeholder="Saga, user, or Execution ID…"
            value={filters.search}
            onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="history-saga">Saga (server)</label>
          <select
            id="history-saga"
            name="saga"
            value={filters.sagaName}
            onChange={(e) => setFilters((prev) => ({ ...prev, sagaName: e.target.value }))}
          >
            <option value="">All Sagas</option>
            {sagaNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="history-status">Status (server)</label>
          <select
            id="history-status"
            name="status"
            value={filters.status}
            onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value as StatusFilter }))}
          >
            <option value="all">All</option>
            {HISTORY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="history-from">From (server)</label>
          <input
            id="history-from"
            name="from"
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="history-to">To (server)</label>
          <input
            id="history-to"
            name="to"
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))}
          />
        </div>
        <div className="filter-field filter-field--check">
          <input
            id="history-local-time"
            name="localTime"
            type="checkbox"
            checked={filters.localTime}
            onChange={(e) => setFilters((prev) => ({ ...prev, localTime: e.target.checked }))}
          />
          <label htmlFor="history-local-time">Local time</label>
        </div>
        {filtersActive ? (
          <div className="filter-field filter-field--check">
            <button type="button" className="link-button" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        ) : null}
      </form>
      <div className="pills" role="group" aria-label="Filter by status">
        {(["all", ...HISTORY_STATUSES] as StatusFilter[]).map((status) => {
          const count = status === "all" ? summary.total : (summary.byStatus[status] ?? 0);
          return (
            <button
              key={status}
              type="button"
              className="pill"
              aria-pressed={filters.status === status}
              onClick={() => setStatus(status)}
            >
              {status === "all" ? "All" : status}
              <span className="pill-count" aria-label={`${count} loaded Executions`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>
      {loading ? (
        <p role="status" className="status-line">
          Loading ExecutionHistory…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error} {error.includes("UNIMPLEMENTED") ? <span>(server reports this surface UNIMPLEMENTED)</span> : null}
        </p>
      ) : null}
      {pages.length > 0 || !loading ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Organization</th>
                  <th scope="col">Saga</th>
                  <th scope="col">Status</th>
                  <th scope="col">Run by</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="cell--numeric">
                    Duration
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Open detail</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={group.key}>
                    <tr className="day-row" data-testid="history-day-row">
                      <th colSpan={7} scope="colgroup">
                        {group.label}
                      </th>
                    </tr>
                    {group.executions.map((row) => (
                      <tr key={row.executionId} data-testid="execution-row">
                        <RowCells row={row} localTime={filters.localTime} />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore ? (
            <div className="more-row">
              <p className="more-line">More results available server-side.</p>
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="history-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
          {filtered.length === 0 && filtersActive ? (
            <p className="empty-state">
              No Executions match these filters
              {hasMore
                ? " in the loaded pages (more rows exist server-side — narrow the server filters or load more)"
                : ""}
              .
            </p>
          ) : null}
          {loaded.length === 0 ? <p className="empty-state">No Executions yet.</p> : null}
        </>
      ) : null}
    </section>
  );
}
