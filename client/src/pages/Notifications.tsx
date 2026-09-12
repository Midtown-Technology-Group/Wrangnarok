// SPDX-License-Identifier: AGPL-3.0
// Operational notifications inbox (OPS-01, issue #172; ADR 020). Lists the
// caller's own personal rows plus same-Organization org-scoped rows with
// durable status, progress, and dismiss behavior. Refresh re-reads the
// authoritative D1 rows (poll, never a stream); refresh stops on unmount.
import { useCallback, useEffect, useState } from "react";
import { dismissNotification, getToken, listNotifications, setToken } from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { AppNotification } from "../lib/client-types";
import { StatusBadge } from "../components/StatusBadge";

function Progress({ percent }: { percent: number | null }): React.JSX.Element {
  if (percent === null) return <span className="muted">indeterminate</span>;
  return (
    <span className="muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      {percent}%
    </span>
  );
}

export function NotificationsList(props: { initial?: AppNotification[] }): React.JSX.Element {
  const [items, setItems] = useState<AppNotification[] | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [working, setWorking] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listNotifications();
      setItems(data.notifications);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load notifications."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await listNotifications();
        if (!cancelled) setItems(data.notifications);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load notifications."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // Reconnect-safe refresh: re-read authoritative state every 10s so an
    // interrupted job or a new deploy job appears without losing the inbox.
    // D1 is the source of truth; the poll stops on unmount.
    const timer = setInterval(() => {
      void (async () => {
        try {
          const data = await listNotifications();
          if (!cancelled) setItems(data.notifications);
        } catch {
          // Keep the last good inbox; the manual Reload surfaces errors.
        }
      })();
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [props.initial]);

  const dismiss = useCallback(async (id: string) => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await dismissNotification(id);
      setItems((prev) => (prev ?? []).filter((row) => row.id !== id));
      setNotice("Notification dismissed.");
    } catch (err) {
      setError(getErrorMessage(err, "Could not dismiss the notification."));
    } finally {
      setWorking(false);
    }
  }, []);

  return (
    <section aria-labelledby="notifications-heading">
      <h1 id="notifications-heading">Notifications</h1>
      <p className="muted">
        Durable operational status for long-running work (app deploy jobs in this slice). Your personal rows plus
        Organization-scoped rows; other users&apos; personal rows never appear here. Dismissal is yours for personal
        rows.
      </p>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
          void reload();
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
          Loading notifications…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="status-line">
          {notice}
        </p>
      ) : null}
      {items ? (
        items.length === 0 ? (
          <p className="empty-state">No notifications.</p>
        ) : (
          <ul className="ops-list">
            {items.map((row) => (
              <li key={row.id} data-testid="notification-row" className="op-row op-row--detail">
                <div className="op-head">
                  <span className="op-name">{row.title}</span>
                  <StatusBadge status={row.status} />
                  <span className="muted muted--small">
                    {row.scope} · {row.category}
                  </span>
                </div>
                {row.body ? <p className="muted">{row.body}</p> : null}
                <p className="muted muted--small">
                  progress: <Progress percent={row.progressPercent} />
                </p>
                <div>
                  <button type="button" disabled={working} onClick={() => void dismiss(row.id)}>
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
