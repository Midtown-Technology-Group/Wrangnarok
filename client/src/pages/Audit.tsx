// SPDX-License-Identifier: AGPL-3.0
// Administrative audit trail (OPS-01, issue #172; ADR 020). Lists the
// Organization-scoped audit events newest-first with server-side
// action-prefix/outcome/search/date filters plus cursor traversal. Audit rows
// are management mutations and policy denies with actor/outcome attribution;
// ordinary Execution runs stay on the History page.
import { useCallback, useEffect, useState } from "react";
import { fetchAuditEvents, getToken, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { AuditEvent, AuditResponse } from "../lib/client-types";

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function AuditList(props: { initial?: AuditResponse }): React.JSX.Element {
  const [pages, setPages] = useState<AuditEvent[][]>(props.initial ? [props.initial.events] : []);
  const [hasMore, setHasMore] = useState(props.initial?.hasMore ?? false);
  const [nextCursor, setNextCursor] = useState<string | null>(props.initial?.nextCursor ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [token, setTokenState] = useState(getToken());
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState<"" | "success" | "failure">("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const serverQuery = {
    ...(action !== "" ? { action } : {}),
    ...(outcome !== "" ? { outcome } : {}),
    ...(search !== "" ? { search } : {}),
    ...(from !== "" ? { startDate: from } : {}),
    ...(to !== "" ? { endDate: to } : {}),
  };

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const first = await fetchAuditEvents(serverQuery);
      setPages([first.events]);
      setHasMore(first.hasMore);
      setNextCursor(first.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the audit trail."));
    } finally {
      setLoading(false);
    }
  }, [action, outcome, search, from, to]);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const first = await fetchAuditEvents(serverQuery);
        if (cancelled) return;
        setPages([first.events]);
        setHasMore(first.hasMore);
        setNextCursor(first.nextCursor);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load the audit trail."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial, action, outcome, search, from, to]);

  const loaded = pages.flat();

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await fetchAuditEvents({ ...serverQuery, cursor: nextCursor });
      const seen = new Set(loaded.map((row) => row.id));
      setPages((prev) => [...prev, next.events.filter((row) => !seen.has(row.id))]);
      setHasMore(next.hasMore);
      setNextCursor(next.nextCursor);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the next page."));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, nextCursor, loadingMore, action, outcome, search, from, to, loaded]);

  return (
    <section aria-labelledby="audit-heading">
      <h1 id="audit-heading">Audit trail</h1>
      <p className="muted">
        Consequential management mutations and policy denies with actor and outcome attribution, newest first. Reads are
        scoped to this Organization; role-gated reads arrive with the authorization model.
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
      {loading ? (
        <p role="status" className="status-line">
          Loading audit trail…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      <div className="filter-bar" role="group" aria-label="Audit filters">
        <div className="filter-field">
          <label htmlFor="audit-action">Action prefix</label>
          <input
            id="audit-action"
            name="action"
            type="text"
            autoComplete="off"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="app."
            maxLength={128}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="audit-outcome">Outcome</label>
          <select
            id="audit-outcome"
            name="outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as "" | "success" | "failure")}
          >
            <option value="">all</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="audit-search">Search</label>
          <input
            id="audit-search"
            name="search"
            type="text"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="slug, target, detail…"
            maxLength={256}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="audit-from">From</label>
          <input id="audit-from" name="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="filter-field">
          <label htmlFor="audit-to">To</label>
          <input id="audit-to" name="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className="table-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col">Target</th>
              <th scope="col">Actor</th>
              <th scope="col">At</th>
            </tr>
          </thead>
          <tbody>
            {loaded.map((event: AuditEvent) => (
              <tr key={event.id} data-testid="audit-row">
                <td>
                  <code className="mono">{event.action}</code>
                </td>
                <td>
                  <span className="muted">{event.outcome}</span>
                </td>
                <td>
                  <code className="mono" title={event.targetId ?? ""}>
                    {shortId(event.targetId)}
                  </code>
                  <div className="muted muted--small">{event.targetType ?? "—"}</div>
                </td>
                <td>
                  <code className="mono" title={event.actorUserId}>
                    {shortId(event.actorUserId)}
                  </code>
                </td>
                <td>
                  <time className="muted" title={event.createdAt}>
                    {event.createdAt}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loaded.length === 0 && !loading ? <p className="empty-state">No audit events under these filters.</p> : null}
      {hasMore ? (
        <div className="more-row">
          <p className="more-line">More events available server-side.</p>
          <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : (
        <p className="more-line">{loaded.length} loaded (complete under these filters).</p>
      )}
    </section>
  );
}
