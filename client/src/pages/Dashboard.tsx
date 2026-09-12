// SPDX-License-Identifier: AGPL-3.0
// Dashboard summary (CONSOLE-01, issue #222). Layout borrowed (not verbatim)
// from upstream gobifrost/bifrost client/src/pages/Dashboard.tsx (reference:
// fetched via `gh api repos/gobifrost/bifrost/contents/client/src/pages/Dashboard.tsx`
// because the vendor/upstream submodule is absent in this worktree).
//
// Only the product shape is adapted: a headline summary plus links into the
// surfaces this Worker actually serves. Upstream's metrics/timeseries/ROI
// backends (dashboard metrics, execution time-series, agents, applications
// counts) do not exist here — this Worker serves org-scoped summaries only —
// so this page aggregates the same real list APIs the other console pages use
// (sagas catalog, Execution history page one, connections + integrations,
// artifacts page one, files locations) and states the scope honestly: loaded
// sample counts, never platform totals. No new /api/* routes, no invented
// metrics endpoint, no lucide/react-query components: token form,
// loading/error/empty states, and the truncated-mono + tooltip table pattern
// from the sibling console pages.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchExecutionHistory,
  getToken,
  listArtifacts,
  listConnections,
  listFileLocations,
  listIntegrations,
  listSagas,
  setToken,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ExecutionStatus } from "../lib/client-types";
import { HISTORY_STATUSES } from "../lib/history-view";
import { StatusBadge } from "../components/StatusBadge";

export interface DashboardCounts {
  sagas: number | null;
  recentExecutions: number | null;
  recentHasMore: boolean | null;
  connections: number | null;
  integrations: number | null;
  artifacts: number | null;
  artifactsHasMore: boolean | null;
  fileLocations: number | null;
}

export const EMPTY_DASHBOARD_COUNTS: DashboardCounts = {
  sagas: null,
  recentExecutions: null,
  recentHasMore: null,
  connections: null,
  integrations: null,
  artifacts: null,
  artifactsHasMore: null,
  fileLocations: null,
};

export type DashboardByStatus = Record<ExecutionStatus, number>;

export function summarizeDashboardStatuses(statuses: ExecutionStatus[]): DashboardByStatus {
  const counts = Object.fromEntries(HISTORY_STATUSES.map((status) => [status, 0])) as DashboardByStatus;
  for (const status of statuses) counts[status] += 1;
  return counts;
}

export function DashboardView(props: { initial?: DashboardCounts }): React.JSX.Element {
  const [counts, setCounts] = useState<DashboardCounts | null>(props.initial ?? null);
  const [byStatus, setByStatus] = useState<DashboardByStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const [sagas, history, connections, integrations, artifacts, locations] = await Promise.all([
          listSagas(),
          fetchExecutionHistory({ limit: 20 }),
          listConnections(),
          listIntegrations(),
          listArtifacts(20),
          listFileLocations(),
        ]);
        if (cancelled) return;
        setCounts({
          sagas: sagas.sagas.length,
          recentExecutions: history.executions.length,
          recentHasMore: history.hasMore,
          connections: connections.connections.length,
          integrations: integrations.integrations.length,
          artifacts: artifacts.artifacts.length,
          artifactsHasMore: artifacts.hasMore,
          fileLocations: locations.locations.length,
        });
        setByStatus(summarizeDashboardStatuses(history.executions.map((row) => row.status)));
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load the Dashboard."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  return (
    <section aria-labelledby="dashboard-heading">
      <h1 id="dashboard-heading">Dashboard</h1>
      <p className="muted">
        Operator overview of this Organization: loaded sample counts from the same list APIs the console pages use —
        never platform totals.
      </p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          setLoading(true);
          setError(null);
          void Promise.all([
            listSagas(),
            fetchExecutionHistory({ limit: 20 }),
            listConnections(),
            listIntegrations(),
            listArtifacts(20),
            listFileLocations(),
          ])
            .then(([sagas, history, connections, integrations, artifacts, locations]) => {
              setCounts({
                sagas: sagas.sagas.length,
                recentExecutions: history.executions.length,
                recentHasMore: history.hasMore,
                connections: connections.connections.length,
                integrations: integrations.integrations.length,
                artifacts: artifacts.artifacts.length,
                artifactsHasMore: artifacts.hasMore,
                fileLocations: locations.locations.length,
              });
              setByStatus(summarizeDashboardStatuses(history.executions.map((row) => row.status)));
            })
            .catch((err: unknown) => setError(getErrorMessage(err, "Could not load the Dashboard.")))
            .finally(() => setLoading(false));
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
      {loading ? (
        <p role="status" className="status-line">
          Loading Dashboard…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error} {error.includes("UNIMPLEMENTED") ? <span>(server reports this surface UNIMPLEMENTED)</span> : null}
        </p>
      ) : null}
      {counts ? (
        <>
          <p className="summary-line" data-testid="dashboard-summary">
            {counts.sagas ?? "—"} Sagas · {counts.recentExecutions ?? "—"} recent Executions loaded
            {counts.recentHasMore ? " (more available server-side)" : ""}
          </p>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Surface</th>
                  <th scope="col">Loaded</th>
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                <tr data-testid="dashboard-row">
                  <td>Sagas</td>
                  <td>{counts.sagas ?? "—"}</td>
                  <td>
                    <Link to="/sagas" className="saga-link">
                      Catalog
                    </Link>
                  </td>
                </tr>
                <tr data-testid="dashboard-row">
                  <td>Executions (latest page)</td>
                  <td>
                    {counts.recentExecutions ?? "—"}
                    {counts.recentHasMore ? " · more available" : ""}
                  </td>
                  <td>
                    <Link to="/history" className="saga-link">
                      History
                    </Link>
                  </td>
                </tr>
                <tr data-testid="dashboard-row">
                  <td>Connections / Integrations</td>
                  <td>
                    {counts.connections ?? "—"} / {counts.integrations ?? "—"}
                  </td>
                  <td>
                    <Link to="/connections" className="saga-link">
                      Connections
                    </Link>
                  </td>
                </tr>
                <tr data-testid="dashboard-row">
                  <td>Artifacts (latest page)</td>
                  <td>
                    {counts.artifacts ?? "—"}
                    {counts.artifactsHasMore ? " · more available" : ""}
                  </td>
                  <td>
                    <Link to="/artifacts" className="saga-link">
                      Artifacts
                    </Link>
                  </td>
                </tr>
                <tr data-testid="dashboard-row">
                  <td>File locations</td>
                  <td>{counts.fileLocations ?? "—"}</td>
                  <td>
                    <Link to="/files" className="saga-link">
                      Files
                    </Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {byStatus ? (
            <>
              <h2>Recent Executions by status</h2>
              <p className="muted">Statuses of the loaded Execution sample only.</p>
              <ul aria-label="Recent Execution statuses" className="ops-list">
                {HISTORY_STATUSES.filter((status) => byStatus[status] > 0).map((status) => (
                  <li key={status} data-testid="dashboard-status-row" className="op-row">
                    <span className="op-head">
                      <StatusBadge status={status} />
                    </span>
                    <span className="muted">{byStatus[status]}</span>
                  </li>
                ))}
              </ul>
              {HISTORY_STATUSES.every((status) => byStatus[status] === 0) ? (
                <p className="empty-state">No Executions loaded yet.</p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
