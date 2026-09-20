// SPDX-License-Identifier: AGPL-3.0
// Operations console (issue #558). Layout borrowed (not verbatim) from
// client/src/pages/Audit.tsx and client/src/pages/Connections.tsx (token
// form, loading/error/empty states, truncated-mono + tooltip table pattern).
//
// Operator UI over the existing read routes — /api/ops/* (version, health,
// metrics, jobs, scheduled tasks, preflight, connection diagnostics),
// /api/usage/summary, and /api/logs — plus inspect-then-act repairs over
// POST /api/ops/repairs. Every call rides the same Bearer authorization the
// other console pages use; the server enforces tenancy and the admin gate.
// Repairs stay inspect-first: Inspect posts dryRun:true (no writes) and the
// mutating commit needs an explicit confirmation checkbox first. Payloads
// carry counts/IDs/statuses only — no inputs, results, secret values, or
// Cloudflare metering.
import { useCallback, useEffect, useState } from "react";
import {
  OPS_REPAIR_KINDS,
  fetchOpsConnectionHealth,
  fetchOpsHealth,
  fetchOpsJobs,
  fetchOpsMetrics,
  fetchOpsPreflight,
  fetchOpsScheduledTasks,
  fetchOpsVersion,
  fetchUsageSummary,
  getToken,
  runOpsRepair,
  searchLogs,
  setToken,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type {
  LogEntry,
  LogPage,
  OpsConnectionHealthResponse,
  OpsExecutionCounters,
  OpsHealth,
  OpsJobsResponse,
  OpsMetricsResponse,
  OpsPreflightResponse,
  OpsRepairKind,
  OpsRepairOutcome,
  OpsScheduledTasksResponse,
  OpsVersionResponse,
  UsageSummaryResponse,
} from "../lib/client-types";

export interface OperationsInitial {
  version?: OpsVersionResponse;
  health?: OpsHealth;
  metrics?: OpsMetricsResponse;
  jobs?: OpsJobsResponse;
  tasks?: OpsScheduledTasksResponse;
  preflight?: OpsPreflightResponse;
  connections?: OpsConnectionHealthResponse;
  usage?: UsageSummaryResponse;
  logs?: LogPage;
}

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

const COUNTER_KEYS: (keyof OpsExecutionCounters)[] = [
  "total",
  "pending",
  "pendingUndispatched",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "timedOut",
  "cancelled",
];

const REPAIR_NEEDS_TARGET: Partial<Record<OpsRepairKind, string>> = {
  "retry-execution": "Exact 64-hex Execution ID",
  "cancel-execution": "Exact 64-hex Execution ID",
  "repair-stuck-build": "Exact app UUID",
};

const SECTIONS = [
  { id: "health", label: "Health" },
  { id: "metrics", label: "Metrics" },
  { id: "jobs", label: "Jobs" },
  { id: "tasks", label: "Scheduled tasks" },
  { id: "preflight", label: "Preflight" },
  { id: "connections", label: "Connections" },
  { id: "usage", label: "Usage" },
  { id: "logs", label: "Logs" },
  { id: "repairs", label: "Repairs" },
] as const;

export function OperationsView(props: { initial?: OperationsInitial }): React.JSX.Element {
  const [version, setVersion] = useState<OpsVersionResponse | null>(props.initial?.version ?? null);
  const [health, setHealth] = useState<OpsHealth | null>(props.initial?.health ?? null);
  const [metrics, setMetrics] = useState<OpsMetricsResponse | null>(props.initial?.metrics ?? null);
  const [jobs, setJobs] = useState<OpsJobsResponse | null>(props.initial?.jobs ?? null);
  const [tasks, setTasks] = useState<OpsScheduledTasksResponse | null>(props.initial?.tasks ?? null);
  const [preflight, setPreflight] = useState<OpsPreflightResponse | null>(props.initial?.preflight ?? null);
  const [connections, setConnections] = useState<OpsConnectionHealthResponse | null>(
    props.initial?.connections ?? null,
  );
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(props.initial?.usage ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  // Usage filters (server-side ?saga=&startDate=&endDate=).
  const [usageSaga, setUsageSaga] = useState("");
  const [usageFrom, setUsageFrom] = useState("");
  const [usageTo, setUsageTo] = useState("");

  // Log search (server-side level/saga/date filters plus cursor pages).
  const [logPages, setLogPages] = useState<LogEntry[][]>(props.initial?.logs ? [props.initial.logs.logs] : []);
  const [logsHasMore, setLogsHasMore] = useState(props.initial?.logs?.hasMore ?? false);
  const [logsCursor, setLogsCursor] = useState<string | null>(props.initial?.logs?.nextCursor ?? null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logLevel, setLogLevel] = useState("");
  const [logSagaId, setLogSagaId] = useState("");
  const [logSagaName, setLogSagaName] = useState("");
  const [logFrom, setLogFrom] = useState("");
  const [logTo, setLogTo] = useState("");

  // Repairs: inspect-then-act. The commit stays disabled until the
  // operator checks the explicit confirmation.
  const [repairKind, setRepairKind] = useState<OpsRepairKind>("cleanup-expired-tokens");
  const [repairTarget, setRepairTarget] = useState("");
  const [repairKey, setRepairKey] = useState("");
  const [repairConfirm, setRepairConfirm] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairOutcome, setRepairOutcome] = useState<OpsRepairOutcome | null>(null);

  const logQuery = {
    ...(logLevel !== "" ? { level: logLevel } : {}),
    ...(logSagaId !== "" ? { sagaId: logSagaId } : {}),
    ...(logSagaName !== "" ? { sagaName: logSagaName } : {}),
    ...(logFrom !== "" ? { startDate: logFrom } : {}),
    ...(logTo !== "" ? { endDate: logTo } : {}),
  };

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextVersion, nextHealth, nextMetrics, nextJobs, nextTasks, nextPreflight, nextConnections, nextUsage] =
        await Promise.all([
          fetchOpsVersion(),
          fetchOpsHealth(),
          fetchOpsMetrics(),
          fetchOpsJobs(),
          fetchOpsScheduledTasks(),
          fetchOpsPreflight(),
          fetchOpsConnectionHealth(),
          fetchUsageSummary({
            ...(usageSaga !== "" ? { saga: usageSaga } : {}),
            ...(usageFrom !== "" ? { startDate: usageFrom } : {}),
            ...(usageTo !== "" ? { endDate: usageTo } : {}),
          }),
        ]);
      setVersion(nextVersion);
      setHealth(nextHealth);
      setMetrics(nextMetrics);
      setJobs(nextJobs);
      setTasks(nextTasks);
      setPreflight(nextPreflight);
      setConnections(nextConnections);
      setUsage(nextUsage);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the Operations console."));
    } finally {
      setLoading(false);
    }
  }, [usageSaga, usageFrom, usageTo]);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const [nextVersion, nextHealth, nextMetrics, nextJobs, nextTasks, nextPreflight, nextConnections, nextUsage] =
          await Promise.all([
            fetchOpsVersion(),
            fetchOpsHealth(),
            fetchOpsMetrics(),
            fetchOpsJobs(),
            fetchOpsScheduledTasks(),
            fetchOpsPreflight(),
            fetchOpsConnectionHealth(),
            fetchUsageSummary(),
          ]);
        if (cancelled) return;
        setVersion(nextVersion);
        setHealth(nextHealth);
        setMetrics(nextMetrics);
        setJobs(nextJobs);
        setTasks(nextTasks);
        setPreflight(nextPreflight);
        setConnections(nextConnections);
        setUsage(nextUsage);
        const firstLogs = await searchLogs();
        if (cancelled) return;
        setLogPages([firstLogs.logs]);
        setLogsHasMore(firstLogs.hasMore);
        setLogsCursor(firstLogs.nextCursor);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load the Operations console."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  const loadedLogs = logPages.flat();

  async function handleSearchLogs(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setLoadingLogs(true);
    setError(null);
    try {
      const first = await searchLogs(logQuery);
      setLogPages([first.logs]);
      setLogsHasMore(first.hasMore);
      setLogsCursor(first.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err, "Could not search the logs."));
    } finally {
      setLoadingLogs(false);
    }
  }

  async function handleMoreLogs(): Promise<void> {
    if (!logsHasMore || !logsCursor || loadingLogs) return;
    setLoadingLogs(true);
    setError(null);
    try {
      const next = await searchLogs({ ...logQuery, cursor: logsCursor });
      const seen = new Set(loadedLogs.map((row) => row.seq));
      setLogPages((prev) => [...prev, next.logs.filter((row) => !seen.has(row.seq))]);
      setLogsHasMore(next.hasMore);
      setLogsCursor(next.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the next log page."));
    } finally {
      setLoadingLogs(false);
    }
  }

  async function handleRepair(dryRun: boolean): Promise<void> {
    setRepairBusy(true);
    setError(null);
    try {
      const outcome = await runOpsRepair({
        kind: repairKind,
        ...(repairTarget !== "" ? { targetId: repairTarget } : {}),
        ...(repairKind === "retry-execution" && repairKey !== "" ? { idempotencyKey: repairKey } : {}),
        dryRun,
      });
      setRepairOutcome(outcome.repair);
      if (!dryRun) setRepairConfirm(false);
    } catch (err) {
      setError(getErrorMessage(err, dryRun ? "Could not inspect the repair." : "Could not run the repair."));
    } finally {
      setRepairBusy(false);
    }
  }

  const targetHint = REPAIR_NEEDS_TARGET[repairKind];
  const needsKey = repairKind === "retry-execution";

  return (
    <section aria-labelledby="operations-heading">
      <h1 id="operations-heading">Operations</h1>
      <p className="muted">
        Operator console over this Organization&apos;s health, metrics, jobs, scheduled tasks, preflight, connection
        diagnostics, usage, and searchable logs. Reads are Organization-scoped; repairs inspect first and execute only
        with an explicit confirmation behind the admin gate.
      </p>
      <nav aria-label="Operations sections" className="nav">
        <ul className="nav-list">
          {SECTIONS.map((entry) => (
            <li key={entry.id}>
              <a href={`#ops-${entry.id}`} className="nav-link">
                {entry.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          void reload();
        }}
      >
        <label htmlFor="token">Bearer [REDACTED] (local fixture only, never committed)</label>
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
          Loading Operations…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}

      <h2 id="ops-health">Health</h2>
      {health ? (
        <p className="summary-line" data-testid="ops-health-summary">
          {health.status} · database {health.database} · worker {health.worker} · checked{" "}
          <time className="muted" title={health.checkedAt}>
            {health.checkedAt}
          </time>
        </p>
      ) : null}
      {version ? (
        <p className="muted" data-testid="ops-version-summary">
          SDK {version.version.sdkVersion} · {version.version.sagaCatalog.count} Sagas (
          {version.version.sagaCatalog.revision}) · {version.version.migrationsApplied.length} migrations applied
        </p>
      ) : null}
      {!health && !version && !loading ? <p className="empty-state">No health data loaded yet.</p> : null}

      <h2 id="ops-metrics">Metrics</h2>
      {metrics ? (
        <>
          <p className="muted">
            Execution counts for this Organization, generated{" "}
            <time title={metrics.metrics.generatedAt}>{metrics.metrics.generatedAt}</time>. The backlog counts
            undispatched Pending receipts awaiting Workflow confirmation.
          </p>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Count</th>
                </tr>
              </thead>
              <tbody>
                {COUNTER_KEYS.map((key) => (
                  <tr key={key} data-testid="ops-metric-row">
                    <td>{key}</td>
                    <td>{metrics.metrics.executions[key]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Recent failures</h3>
          {metrics.metrics.recentFailures.length === 0 ? (
            <p className="empty-state">No recent failures.</p>
          ) : (
            <div className="table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th scope="col">Execution</th>
                    <th scope="col">Saga</th>
                    <th scope="col">Status</th>
                    <th scope="col">Code</th>
                    <th scope="col">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.metrics.recentFailures.map((failure) => (
                    <tr key={failure.executionId} data-testid="ops-failure-row">
                      <td>
                        <code className="mono mono--truncate" title={failure.executionId}>
                          {shortId(failure.executionId)}
                        </code>
                      </td>
                      <td>{failure.sagaName}</td>
                      <td>{failure.status}</td>
                      <td>
                        <code className="mono">{failure.code ?? "—"}</code>
                      </td>
                      <td>
                        <time className="muted" title={failure.completedAt ?? ""}>
                          {failure.completedAt ?? "—"}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : !loading ? (
        <p className="empty-state">No metrics loaded yet.</p>
      ) : null}

      <h2 id="ops-jobs">Jobs</h2>
      {jobs ? (
        <>
          <p className="summary-line" data-testid="ops-jobs-summary">
            {jobs.jobs.executions.total} Executions · {jobs.jobs.appBuilds.queued} queued builds ·{" "}
            {jobs.jobs.appBuilds.running} running · {jobs.jobs.appBuilds.succeeded} succeeded ·{" "}
            {jobs.jobs.appBuilds.failed} failed
          </p>
          {jobs.jobs.appBuilds.interrupted.length === 0 ? (
            <p className="empty-state">No interrupted builds.</p>
          ) : (
            <div className="table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th scope="col">App</th>
                    <th scope="col">App ID</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.jobs.appBuilds.interrupted.map((entry) => (
                    <tr key={entry.appId} data-testid="ops-interrupted-row">
                      <td>{entry.appName}</td>
                      <td>
                        <code className="mono mono--truncate" title={entry.appId}>
                          {shortId(entry.appId)}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : !loading ? (
        <p className="empty-state">No job data loaded yet.</p>
      ) : null}

      <h2 id="ops-tasks">Scheduled tasks</h2>
      {tasks ? (
        tasks.tasks.length === 0 ? (
          <p className="empty-state">No scheduled tasks: no trigger inventory can run work yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">State</th>
                  <th scope="col">Cadence</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {tasks.tasks.map((task) => (
                  <tr key={task.id} data-testid="ops-task-row">
                    <td>{task.name}</td>
                    <td>
                      <span className="muted">{task.kind}</span>
                    </td>
                    <td>{task.enabled ? "enabled" : "disabled"}</td>
                    <td>
                      <code className="mono">{task.cadence ?? "—"}</code>
                    </td>
                    <td>
                      <span className="muted">{task.detail}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : !loading ? (
        <p className="empty-state">No scheduled-task data loaded yet.</p>
      ) : null}

      <h2 id="ops-preflight">Preflight</h2>
      {preflight ? (
        <>
          <p className="muted">
            Mapping and credential presence per Integration, checked{" "}
            <time title={preflight.checkedAt}>{preflight.checkedAt}</time>. No vendor calls, no secret values — names of
            missing secrets only.
          </p>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Mapping</th>
                  <th scope="col">Ready</th>
                  <th scope="col">Missing secrets</th>
                </tr>
              </thead>
              <tbody>
                {preflight.integrations.map((entry) => (
                  <tr key={entry.integrationId} data-testid="ops-preflight-row">
                    <td>{entry.integrationName}</td>
                    <td>
                      {entry.connected ? (entry.enabled ? "connected, enabled" : "connected, disabled") : "unmapped"}
                    </td>
                    <td>{entry.ready ? "ready" : "not ready"}</td>
                    <td>
                      {entry.missingSecrets.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        entry.missingSecrets.map((name) => (
                          <code key={name} className="mono">
                            {name}
                          </code>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : !loading ? (
        <p className="empty-state">No preflight data loaded yet.</p>
      ) : null}

      <h2 id="ops-connections">Connection diagnostics</h2>
      {connections ? (
        connections.connections.length === 0 ? (
          <p className="empty-state">No Connection health reported: no Integrations are mapped yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">State</th>
                  <th scope="col">Test hint</th>
                  <th scope="col">Remediation</th>
                </tr>
              </thead>
              <tbody>
                {connections.connections.map((entry) => (
                  <tr key={entry.integrationId} data-testid="ops-connection-row">
                    <td>{entry.integrationName}</td>
                    <td>
                      {entry.connected ? (entry.enabled ? "connected, enabled" : "connected, disabled") : "unmapped"}
                    </td>
                    <td>
                      <span className="muted">{entry.testHint}</span>
                    </td>
                    <td>
                      <span className="muted">{entry.remediation}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : !loading ? (
        <p className="empty-state">No connection diagnostics loaded yet.</p>
      ) : null}
      <p className="muted">
        Live probes stay on the per-Connection test route; this inventory reports mapping health only.
      </p>

      <h2 id="ops-usage">Usage</h2>
      <form
        className="filter-bar"
        role="group"
        aria-label="Usage filters"
        onSubmit={(e) => {
          e.preventDefault();
          void reload();
        }}
      >
        <div className="filter-field">
          <label htmlFor="ops-usage-saga">Saga</label>
          <input
            id="ops-usage-saga"
            name="saga"
            type="text"
            autoComplete="off"
            value={usageSaga}
            onChange={(e) => setUsageSaga(e.target.value)}
            placeholder="system.smoke"
            maxLength={320}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="ops-usage-from">From</label>
          <input
            id="ops-usage-from"
            name="from"
            type="date"
            value={usageFrom}
            onChange={(e) => setUsageFrom(e.target.value)}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="ops-usage-to">To</label>
          <input id="ops-usage-to" name="to" type="date" value={usageTo} onChange={(e) => setUsageTo(e.target.value)} />
        </div>
        <div className="filter-field">
          <button type="submit">Apply</button>
        </div>
      </form>
      {usage ? (
        <>
          <p className="summary-line" data-testid="ops-usage-summary">
            {usage.usage.totals.executions} Executions · {usage.usage.totals.d1Reads} D1 reads ·{" "}
            {usage.usage.totals.d1Writes} D1 writes · {usage.usage.cancelledExecutions} cancelled
            {usage.usage.truncated
              ? ` (truncated: totals cover ${usage.usage.matchedExecutions} matches as a prefix)`
              : ""}
          </p>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Saga</th>
                  <th scope="col">Executions</th>
                  <th scope="col">D1 reads</th>
                  <th scope="col">D1 writes</th>
                </tr>
              </thead>
              <tbody>
                {usage.usage.bySaga.map((row) => (
                  <tr key={row.saga} data-testid="ops-usage-row">
                    <td>{row.saga}</td>
                    <td>{row.executions}</td>
                    <td>{row.d1Reads}</td>
                    <td>{row.d1Writes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {usage.usage.bySaga.length === 0 ? <p className="empty-state">No usage blocks under these filters.</p> : null}
          <p className="muted">
            Model token costs are {usage.usage.gaps.modelTokenCosts}; provider billing is{" "}
            {usage.usage.gaps.providerBilling}; estimates: {usage.usage.gaps.estimates}. {usage.usage.note}
          </p>
        </>
      ) : !loading ? (
        <p className="empty-state">No usage data loaded yet.</p>
      ) : null}

      <h2 id="ops-logs">Logs</h2>
      <form className="filter-bar" role="group" aria-label="Log search" onSubmit={(e) => void handleSearchLogs(e)}>
        <div className="filter-field">
          <label htmlFor="ops-log-level">Level</label>
          <select id="ops-log-level" name="level" value={logLevel} onChange={(e) => setLogLevel(e.target.value)}>
            <option value="">all (DEBUG hidden)</option>
            <option value="DEBUG">DEBUG</option>
            <option value="INFO">INFO</option>
            <option value="WARN">WARN</option>
            <option value="ERROR">ERROR</option>
            <option value="PROGRESS">PROGRESS</option>
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="ops-log-saga">Saga name</label>
          <input
            id="ops-log-saga"
            name="sagaName"
            type="text"
            autoComplete="off"
            value={logSagaName}
            onChange={(e) => setLogSagaName(e.target.value)}
            placeholder="echo"
            maxLength={256}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="ops-log-saga-id">Saga ID</label>
          <input
            id="ops-log-saga-id"
            name="sagaId"
            type="text"
            autoComplete="off"
            value={logSagaId}
            onChange={(e) => setLogSagaId(e.target.value)}
            placeholder="stable Saga UUID"
            maxLength={36}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="ops-log-from">From</label>
          <input
            id="ops-log-from"
            name="from"
            type="date"
            value={logFrom}
            onChange={(e) => setLogFrom(e.target.value)}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="ops-log-to">To</label>
          <input id="ops-log-to" name="to" type="date" value={logTo} onChange={(e) => setLogTo(e.target.value)} />
        </div>
        <div className="filter-field">
          <button type="submit" disabled={loadingLogs}>
            {loadingLogs ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      <div className="table-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Seq</th>
              <th scope="col">Level</th>
              <th scope="col">Saga</th>
              <th scope="col">Execution</th>
              <th scope="col">Message</th>
              <th scope="col">At</th>
            </tr>
          </thead>
          <tbody>
            {loadedLogs.map((entry) => (
              <tr key={`${entry.executionId}:${entry.seq}`} data-testid="ops-log-row">
                <td>{entry.seq}</td>
                <td>
                  <code className="mono">{entry.level}</code>
                </td>
                <td>{entry.sagaName}</td>
                <td>
                  <code className="mono mono--truncate" title={entry.executionId}>
                    {shortId(entry.executionId)}
                  </code>
                </td>
                <td>{entry.message}</td>
                <td>
                  <time className="muted" title={entry.createdAt}>
                    {entry.createdAt}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loadedLogs.length === 0 && !loading ? <p className="empty-state">No logs under these filters.</p> : null}
      {logsHasMore ? (
        <div className="more-row">
          <p className="more-line">More logs available server-side.</p>
          <button type="button" disabled={loadingLogs} onClick={() => void handleMoreLogs()}>
            {loadingLogs ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : (
        <p className="more-line">{loadedLogs.length} loaded (complete under these filters).</p>
      )}

      <h2 id="ops-repairs">Repairs</h2>
      <p className="muted">
        Inspect-then-act: Inspect posts a dry run (no writes, no dispatch, no deletes). Executing a repair mutates
        operational state and needs an admin membership — the server refuses non-admin commits — plus the explicit
        confirmation below.
      </p>
      <form
        className="connection-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleRepair(true);
        }}
      >
        <label htmlFor="ops-repair-kind">Repair kind</label>
        <select
          id="ops-repair-kind"
          value={repairKind}
          onChange={(e) => {
            setRepairKind(e.target.value as OpsRepairKind);
            setRepairOutcome(null);
          }}
        >
          {OPS_REPAIR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        {targetHint ? (
          <>
            <label htmlFor="ops-repair-target">Target ID ({targetHint})</label>
            <input
              id="ops-repair-target"
              name="targetId"
              type="text"
              autoComplete="off"
              value={repairTarget}
              onChange={(e) => setRepairTarget(e.target.value)}
              placeholder={targetHint}
            />
          </>
        ) : null}
        {needsKey ? (
          <>
            <label htmlFor="ops-repair-key">Idempotency key (16-128 safe characters)</label>
            <input
              id="ops-repair-key"
              name="idempotencyKey"
              type="text"
              autoComplete="off"
              value={repairKey}
              onChange={(e) => setRepairKey(e.target.value)}
              placeholder="retry-001-unique-key"
              maxLength={128}
            />
          </>
        ) : null}
        <div className="filter-field">
          <label htmlFor="ops-repair-confirm">
            <input
              id="ops-repair-confirm"
              name="confirm"
              type="checkbox"
              checked={repairConfirm}
              onChange={(e) => setRepairConfirm(e.target.checked)}
            />{" "}
            I understand this repair mutates operational state
          </label>
        </div>
        <button type="submit" disabled={repairBusy}>
          {repairBusy ? "Inspecting…" : "Inspect"}
        </button>{" "}
        <button
          type="button"
          disabled={repairBusy || !repairConfirm}
          title={repairConfirm ? "Execute the repair" : "Check the confirmation first"}
          onClick={() => void handleRepair(false)}
        >
          {repairBusy ? "Working…" : "Execute (admin-gated)"}
        </button>
      </form>
      {repairOutcome ? (
        <p className="summary-line" data-testid="ops-repair-outcome">
          {repairOutcome.kind} · {repairOutcome.dryRun ? "inspected (no writes)" : "executed"} · {repairOutcome.action}
          {repairOutcome.targetId ? (
            <>
              {" "}
              ·{" "}
              <code className="mono mono--truncate" title={repairOutcome.targetId}>
                {shortId(repairOutcome.targetId)}
              </code>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
