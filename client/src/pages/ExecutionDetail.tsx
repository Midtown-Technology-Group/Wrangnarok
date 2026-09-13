// SPDX-License-Identifier: AGPL-3.0
// Borrowed structure (not verbatim) from upstream
// gobifrost/bifrost client/src/pages/ExecutionDetails.tsx (reference:
// vendor/upstream/client). Detail surface: status, Operations, runtimeStatus.
//
// Live behavior mirrors upstream's useExecution hook: the detail polls every
// 2s while the Execution is active (Pending/Running/Cancelling) and stops at
// a terminal status or on unmount. Stale responses (a slow fetch that lands
// after a newer one, or after unmount) are discarded by sequence number.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  cancelExecution,
  fetchExecutionDetail,
  fetchExecutionLogs,
  isTerminalStatus,
  mergeLogPages,
} from "../lib/api-client";
import { ApiError, getErrorMessage } from "../lib/api-error";
import type { ExecutionDetail as Detail, LogEntry } from "../lib/client-types";
import { StatusBadge } from "../components/StatusBadge";

/** Poll cadence for active Executions (mirrors upstream useExecution: 2s). */
export const DETAIL_POLL_MS = 2000;

/** Render bound for input/result payloads (mirrors the D1 4096-byte bound). */
export const DETAIL_JSON_BOUND = 4096;

const ACTIVE_STATUSES: readonly string[] = ["Pending", "Running", "Cancelling"];

/** Bounded JSON dump: never renders more than DETAIL_JSON_BOUND chars. */
export function boundedJsonPreview(value: unknown): { text: string; truncated: boolean } {
  const text = value === null || value === undefined ? "—" : (JSON.stringify(value, null, 2) ?? "—");
  if (text.length <= DETAIL_JSON_BOUND) return { text, truncated: false };
  return { text: `${text.slice(0, DETAIL_JSON_BOUND)}\n… (truncated at ${DETAIL_JSON_BOUND} chars)`, truncated: true };
}

function JsonBlock({ label, value, testId }: { label: string; value: unknown; testId: string }): React.JSX.Element {
  const { text, truncated } = boundedJsonPreview(value);
  return (
    <div className="payload-block">
      <h3>{label}</h3>
      <pre data-testid={testId} className="mono mono--wrap payload-pre">
        {text}
      </pre>
      {truncated ? (
        <p className="muted muted--small">Output truncated for display; fetch JSON for the full payload.</p>
      ) : null}
    </div>
  );
}

export function ExecutionDetailView(props: { initial?: Detail }): React.JSX.Element {
  const params = useParams();
  const id = props.initial?.executionId ?? params["id"] ?? "";
  const [data, setData] = useState<Detail | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const logCursorRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  // Live poll: refetch while the stored status is active. Stops at terminal
  // statuses and on unmount; stale responses are discarded by sequence.
  useEffect(() => {
    if (props.initial) return;
    if (!/^[a-f0-9]{64}$/.test(id)) {
      setError("Unexpected Execution ID shape.");
      setLoading(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;
    const load = async (sequence: number): Promise<boolean> => {
      try {
        const next = await fetchExecutionDetail(id);
        if (unmounted || seqRef.current !== sequence) return false;
        setData(next);
        setError(null);
        // OBS-02 log tail rides the same 2s tick: each poll refetches from
        // the last cursor, merges by seq (reconnect replays dedupe), and
        // keeps the cursor for the next tick. D1 is the source of truth.
        try {
          const page = await fetchExecutionLogs(id, { cursor: logCursorRef.current ?? undefined });
          if (unmounted || seqRef.current !== sequence) return false;
          setLogs((prev) => mergeLogPages(prev, page.logs));
          if (page.nextCursor) logCursorRef.current = page.nextCursor;
          setLogError(null);
        } catch (logErr) {
          if (unmounted || seqRef.current !== sequence) return false;
          setLogError(getErrorMessage(logErr, "Could not load author logs."));
        }
        return !isTerminalStatus(next.status);
      } catch (err) {
        if (unmounted || seqRef.current !== sequence) return false;
        setError(getErrorMessage(err, "Could not load Execution."));
        // A 404 (hidden owner / expired receipt) is terminal for polling:
        // retrying cannot make a foreign Execution visible.
        if (err instanceof ApiError && err.status === 404) return false;
        return true;
      } finally {
        if (!unmounted && seqRef.current === sequence) setLoading(false);
      }
    };
    const tick = async (): Promise<void> => {
      const sequence = seqRef.current;
      const again = await load(sequence);
      if (again && !unmounted && seqRef.current === sequence) {
        timer = setTimeout(() => void tick(), DETAIL_POLL_MS);
      }
    };
    seqRef.current += 1;
    setLoading(true);
    void tick();
    return () => {
      unmounted = true;
      seqRef.current += 1;
      if (timer) clearTimeout(timer);
    };
  }, [props.initial, id]);

  const cancellable = data !== null && (data.status === "Pending" || data.status === "Running");

  const onCancel = useCallback(async () => {
    if (!cancellable || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    setCancelNotice(null);
    try {
      const outcome = await cancelExecution(id);
      // The cancel route answers 200 for both the winner (Cancelled) and a
      // racer that lands while Cancelling; surface which one this call was.
      setCancelNotice(
        outcome.cancelled
          ? "Cancellation confirmed. The Execution will not run again under this key."
          : "Cancellation already in progress (another request won the race). Refreshing status…",
      );
      const next = await fetchExecutionDetail(id);
      setData(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setCancelError("This Execution is already terminal and cannot be cancelled.");
      } else if (err instanceof ApiError && err.status === 404) {
        setCancelError("This Execution is not visible to this caller.");
      } else {
        setCancelError(getErrorMessage(err, "Cancellation failed."));
      }
    } finally {
      setCancelling(false);
    }
  }, [cancellable, cancelling, id]);

  const live = data !== null && ACTIVE_STATUSES.includes(data.status);

  return (
    <section aria-labelledby="detail-heading">
      <Link to="/history" className="back-link">
        ← Back to Execution history
      </Link>
      <h1 id="detail-heading">Execution detail</h1>
      {loading ? (
        <p role="status" className="status-line">
          Loading Execution…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {data ? (
        <article data-testid="execution-detail">
          <dl className="detail-grid">
            <dt>Saga</dt>
            <dd>
              {data.sagaName} ({data.sagaRevision})
            </dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={data.status} />
              {live ? (
                <span className="muted muted--small" data-testid="detail-live">
                  {" "}
                  · live (refreshing every 2s)
                </span>
              ) : null}
            </dd>
            <dt>Runtime status</dt>
            <dd className="muted" data-testid="detail-runtime">
              {data.runtimeStatus ?? "unavailable (native history expired or not yet dispatched)"}
            </dd>
            <dt>Execution</dt>
            <dd>
              <code className="mono mono--wrap" title={data.executionId}>
                {data.executionId}
              </code>
            </dd>
            <dt>Organization</dt>
            <dd>
              <code className="mono mono--wrap" title={data.orgId}>
                {data.orgId}
              </code>
            </dd>
            <dt>Dispatch</dt>
            <dd className="muted">{data.dispatchConfirmed ? "confirmed" : "unconfirmed (Pending receipt only)"}</dd>
            <dt>Runtime policy</dt>
            <dd className="muted" data-testid="detail-policy">
              {data.policy
                ? `v${data.policy.version} · vendor timeout ${data.policy.policy.timeout.vendorTimeoutMs === 0 ? "default" : `${data.policy.policy.timeout.vendorTimeoutMs}ms`} · checkpoint retries ${data.policy.policy.retry.checkpointRetries} · vendor retries ${data.policy.policy.retry.vendorRetries} · ${data.policy.policy.admission.enabled ? "admission open" : "paused"}${data.policy.policy.admission.maxConcurrent > 0 ? ` · max ${data.policy.policy.admission.maxConcurrent} concurrent` : ""}`
                : "default policy"}
            </dd>
            <dt>Created</dt>
            <dd className="muted">{data.createdAt}</dd>
            <dt>Started</dt>
            <dd className="muted">{data.startedAt ?? "—"}</dd>
            <dt>Completed</dt>
            <dd className="muted">{data.completedAt ?? "—"}</dd>
          </dl>
          {cancellable ? (
            <div className="cancel-row">
              <button type="button" onClick={() => void onCancel()} disabled={cancelling} data-testid="detail-cancel">
                {cancelling ? "Cancelling…" : "Cancel Execution"}
              </button>
            </div>
          ) : null}
          {cancelNotice ? (
            <p role="status" className="status-line" data-testid="cancel-notice">
              {cancelNotice}
            </p>
          ) : null}
          {cancelError ? (
            <p role="alert" className="alert" data-testid="cancel-error">
              {cancelError}
            </p>
          ) : null}
          <h2>Input</h2>
          <JsonBlock label="Submitted input" value={data.input} testId="detail-input" />
          <h2>Result</h2>
          {data.status === "Succeeded" ? (
            <JsonBlock label="Succeeded output" value={data.result} testId="detail-result" />
          ) : data.status === "Failed" || data.status === "TimedOut" || data.status === "Cancelled" ? (
            <JsonBlock label="Terminal error (safe code/message only)" value={data.error} testId="detail-error" />
          ) : (
            <p className="empty-state">No terminal output yet — the Execution is still active.</p>
          )}
          <h2>Operations</h2>
          {data.operations.length === 0 ? (
            <p className="empty-state">No Operations recorded yet.</p>
          ) : (
            <ul aria-label="Operations" className="ops-list">
              {data.operations.map((op) => (
                <li key={op.name} data-testid="operation-row" className="op-row op-row--detail">
                  <div className="op-head">
                    <span className="op-name">{op.name}</span>
                    <StatusBadge status={op.status} />
                  </div>
                  <div className="muted muted--small">
                    started {op.startedAt}
                    {op.completedAt ? ` · completed ${op.completedAt}` : " · still running"}
                  </div>
                  {op.result !== null && op.result !== undefined ? (
                    <pre data-testid={`operation-result-${op.name}`} className="mono mono--wrap payload-pre">
                      {boundedJsonPreview(op.result).text}
                    </pre>
                  ) : null}
                  {op.error !== null && op.error !== undefined ? (
                    <pre
                      data-testid={`operation-error-${op.name}`}
                      className="mono mono--wrap payload-pre payload-pre--error"
                    >
                      {boundedJsonPreview(op.error).text}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <h2>Author logs</h2>
          {logError ? (
            <p role="alert" className="alert" data-testid="logs-error">
              {logError}
            </p>
          ) : null}
          {logs.length === 0 ? (
            <p className="empty-state" data-testid="logs-empty">
              No author logs yet — Sagas emit bounded INFO/WARN/ERROR/PROGRESS rows here (DEBUG stays hidden).
            </p>
          ) : (
            <ul aria-label="Author logs" className="ops-list">
              {logs.map((entry) => (
                <li key={entry.seq} data-testid="log-row" className="op-row op-row--detail">
                  <div className="op-head">
                    <span className="op-name">
                      [{entry.level}] {entry.message}
                    </span>
                    <span className="muted muted--small">#{entry.seq}</span>
                  </div>
                  <div className="muted muted--small">
                    {entry.sagaName} · {entry.createdAt}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      ) : null}
    </section>
  );
}
