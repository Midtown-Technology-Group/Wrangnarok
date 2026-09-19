// SPDX-License-Identifier: AGPL-3.0
// Trigger and schedule management (issue #557). Layout borrowed (not
// verbatim) from client/src/pages/Connections.tsx (token form,
// loading/error/empty states, truncated-mono + tooltip table pattern).
//
// Usable management over the existing Worker routes only: /api/schedules,
// /api/event-sources (plus per-source subscriptions), and /api/endpoints.
// Creates, deletes, enable/disable toggles, emits, retries, and rotates are
// operator-managed (the server gates them on manage access); reads are
// member-open. Every failure — 403 manage gates, 404 foreign rows, 409
// identity conflicts — renders the server message honestly instead of a
// synthesized empty state.
//
// Unexposed subflows (documented, not invented): endpoints have no DELETE
// route (disable plus rotate is the credential lifecycle); schedule delivery
// history is a single window-keyed lookup (?window=), not a list.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  createEndpoint,
  createEventSource,
  createSchedule,
  createSubscription,
  deleteEventSource,
  deleteSchedule,
  deleteSubscription,
  emitSourceEvent,
  fetchSchedule,
  fetchScheduleDelivery,
  getToken,
  listEndpoints,
  listEndpointEvents,
  listEventSources,
  listSagas,
  listSchedules,
  listSourceEvents,
  listSubscriptionDeliveries,
  listSubscriptions,
  rotateEndpoint,
  retrySubscriptionDelivery,
  setEndpointEnabled,
  setScheduleEnabled,
  setSourceEnabled,
  setSubscriptionEnabled,
  setToken,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type {
  EndpointEvent,
  EndpointsResponse,
  EndpointSummary,
  EventSourcesResponse,
  EventSourceSummary,
  SagasResponse,
  SchedulesResponse,
  ScheduleSummary,
  SourceEvent,
  SubscriptionDelivery,
  SubscriptionSummary,
} from "../lib/client-types";

export interface TriggersInitial {
  schedules: SchedulesResponse;
  sources: EventSourcesResponse;
  endpoints: EndpointsResponse;
  sagas: SagasResponse;
}

type Tab = "schedules" | "sources" | "endpoints";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function SectionError(props: { message: string | null }): React.JSX.Element | null {
  if (!props.message) return null;
  return (
    <p role="alert" className="alert">
      {props.message}
    </p>
  );
}

function SchedulesSection(props: {
  schedules: ScheduleSummary[];
  sagas: SagasResponse;
  onChanged: () => void;
  report: (message: string | null) => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<ScheduleSummary | null>(null);
  const [windowInput, setWindowInput] = useState("");
  const [delivery, setDelivery] = useState<{ window: string; executionId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sagaId, setSagaId] = useState(props.sagas.sagas[0]?.id ?? "");
  const [kind, setKind] = useState<"recurring" | "one-off">("recurring");
  const [cron, setCron] = useState("0 2 * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [runAt, setRunAt] = useState("");
  const [inputJson, setInputJson] = useState("{}");
  const [saving, setSaving] = useState(false);

  async function guard(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    props.report(null);
    try {
      await work();
      props.onChanged();
    } catch (err) {
      props.report(getErrorMessage(err, "The schedule request failed."));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = inputJson.trim() ? (JSON.parse(inputJson) as unknown) : {};
    } catch {
      props.report("Schedule input must be valid JSON.");
      return;
    }
    setSaving(true);
    props.report(null);
    try {
      await createSchedule({
        name,
        sagaId,
        kind,
        ...(kind === "recurring" ? { cron, ...(timezone ? { timezone } : {}) } : { runAt }),
        input: parsed,
      });
      setName("");
      setInputJson("{}");
      props.onChanged();
    } catch (err) {
      props.report(getErrorMessage(err, "Could not create the schedule."));
    } finally {
      setSaving(false);
    }
  }

  async function handleLookup(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!detail || !windowInput) return;
    await guard(`delivery:${detail.name}`, async () => {
      const found = await fetchScheduleDelivery(detail.name, windowInput);
      setDelivery({ window: found.window, executionId: found.executionId });
    });
  }

  return (
    <div>
      <h2>Schedules</h2>
      <p className="muted">
        One-off and recurring schedules bound to a Saga. Disabling fences future promotion; promoted Executions run to
        terminal.
      </p>
      <div className="table-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Saga</th>
              <th scope="col">Kind</th>
              <th scope="col">Cadence</th>
              <th scope="col">State</th>
              <th scope="col">Next due</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.schedules.map((entry) => (
              <tr key={entry.id} data-testid="schedule-row">
                <td>
                  <button
                    type="button"
                    className="saga-link"
                    onClick={() =>
                      void guard(`detail:${entry.name}`, async () => {
                        setDelivery(null);
                        setWindowInput(entry.lastWindow ?? "");
                        setDetail(await fetchSchedule(entry.name));
                      })
                    }
                  >
                    {entry.name}
                  </button>
                </td>
                <td title={entry.sagaId}>{entry.sagaName}</td>
                <td>{entry.kind}</td>
                <td>
                  {entry.kind === "recurring" ? (
                    <code className="mono" title={entry.timezone}>
                      {entry.cron}
                    </code>
                  ) : (
                    <span className="muted">{entry.runAt ?? "—"}</span>
                  )}
                </td>
                <td>{entry.enabled ? "enabled" : "disabled"}</td>
                <td>{entry.nextDueAt ?? <span className="muted">—</span>}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard(`toggle:${entry.name}`, async () => {
                        const next = await setScheduleEnabled(entry.name, !entry.enabled);
                        if (detail?.name === next.name) setDetail(next);
                      })
                    }
                  >
                    {entry.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard(`delete:${entry.name}`, async () => {
                        await deleteSchedule(entry.name);
                        if (detail?.name === entry.name) setDetail(null);
                      })
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.schedules.length === 0 ? (
        <p className="empty-state">No Schedules registered for this Organization yet.</p>
      ) : null}
      {detail ? (
        <div className="detail-panel">
          <h3>Schedule detail: {detail.name}</h3>
          <dl>
            <dt>Saga</dt>
            <dd title={detail.sagaId}>{detail.sagaName}</dd>
            <dt>Input</dt>
            <dd>
              <code className="mono">{JSON.stringify(detail.input)}</code>
            </dd>
            <dt>Last window</dt>
            <dd>{detail.lastWindow ?? <span className="muted">none yet</span>}</dd>
          </dl>
          <form className="inline-form" onSubmit={(e) => void handleLookup(e)}>
            <label htmlFor="schedule-window">Window (YYYY-MM-DDTHH:mm)</label>
            <input
              id="schedule-window"
              name="window"
              type="text"
              autoComplete="off"
              value={windowInput}
              onChange={(e) => setWindowInput(e.target.value)}
              placeholder="2026-09-19T02:00"
            />
            <button type="submit" disabled={busy !== null || !windowInput}>
              Look up delivery
            </button>
          </form>
          {delivery ? (
            <p className="muted">
              Window <code className="mono">{delivery.window}</code> promoted to Execution{" "}
              <Link to={`/history/${delivery.executionId}`}>
                <code className="mono mono--truncate" title={delivery.executionId}>
                  {shortId(delivery.executionId)}
                </code>
              </Link>
              .
            </p>
          ) : null}
        </div>
      ) : null}
      <form className="connection-form" onSubmit={(e) => void handleCreate(e)}>
        <h3>Create a schedule</h3>
        <label htmlFor="schedule-name">Name (lowercase, digits, dashes)</label>
        <input
          id="schedule-name"
          name="name"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="nightly-census"
        />
        <label htmlFor="schedule-saga">Saga</label>
        <select id="schedule-saga" value={sagaId} onChange={(e) => setSagaId(e.target.value)}>
          {props.sagas.sagas.map((saga) => (
            <option key={saga.id} value={saga.id}>
              {saga.name}
            </option>
          ))}
        </select>
        <label htmlFor="schedule-kind">Kind</label>
        <select id="schedule-kind" value={kind} onChange={(e) => setKind(e.target.value as "recurring" | "one-off")}>
          <option value="recurring">recurring</option>
          <option value="one-off">one-off</option>
        </select>
        {kind === "recurring" ? (
          <>
            <label htmlFor="schedule-cron">Cron (5-field)</label>
            <input
              id="schedule-cron"
              name="cron"
              type="text"
              autoComplete="off"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
            />
            <label htmlFor="schedule-tz">Timezone</label>
            <input
              id="schedule-tz"
              name="timezone"
              type="text"
              autoComplete="off"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="UTC"
            />
          </>
        ) : (
          <>
            <label htmlFor="schedule-runat">Run at (ISO timestamp)</label>
            <input
              id="schedule-runat"
              name="runAt"
              type="text"
              autoComplete="off"
              value={runAt}
              onChange={(e) => setRunAt(e.target.value)}
              placeholder="2026-09-21T00:00:00.000Z"
            />
          </>
        )}
        <label htmlFor="schedule-input">Input (JSON)</label>
        <textarea
          id="schedule-input"
          name="input"
          value={inputJson}
          onChange={(e) => setInputJson(e.target.value)}
          rows={3}
        />
        <button type="submit" disabled={saving || !name || !sagaId}>
          {saving ? "Creating…" : "Create schedule"}
        </button>
      </form>
    </div>
  );
}

function SubscriptionsBlock(props: {
  source: EventSourceSummary;
  sagas: SagasResponse;
  onChanged: () => void;
  report: (message: string | null) => void;
}): React.JSX.Element {
  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[] | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, SubscriptionDelivery[]>>({});
  const [outcome, setOutcome] = useState<"delivered" | "failed" | "all">("all");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [sagaId, setSagaId] = useState(props.sagas.sagas[0]?.id ?? "");

  const sourceName = props.source.name;
  const report = props.report;
  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const next = await listSubscriptions(sourceName);
      setSubscriptions(next.subscriptions);
    } catch (err) {
      report(getErrorMessage(err, "Could not load subscriptions."));
    } finally {
      setBusy(false);
    }
  }, [sourceName, report]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleDeliveries(sub: SubscriptionSummary): Promise<void> {
    props.report(null);
    try {
      const rows = await listSubscriptionDeliveries(props.source.name, sub.name, outcome);
      setDeliveries((prev) => ({ ...prev, [sub.name]: rows }));
    } catch (err) {
      props.report(getErrorMessage(err, "Could not load deliveries."));
    }
  }

  return (
    <div className="detail-panel">
      <h3>Subscriptions on {props.source.name}</h3>
      {busy && subscriptions === null ? (
        <p role="status" className="status-line">
          Loading subscriptions…
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Topic filter</th>
              <th scope="col">Saga</th>
              <th scope="col">State</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(subscriptions ?? []).map((sub) => (
              <tr key={sub.id} data-testid="subscription-row">
                <td>{sub.name}</td>
                <td>
                  <code className="mono">{sub.topicFilter}</code>
                </td>
                <td title={sub.sagaId}>{shortId(sub.sagaId)}</td>
                <td>{sub.enabled ? "enabled" : "disabled"}</td>
                <td>
                  <button type="button" onClick={() => void handleDeliveries(sub)}>
                    History
                  </button>{" "}
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        props.report(null);
                        try {
                          await setSubscriptionEnabled(props.source.name, sub.name, !sub.enabled);
                          await reload();
                          props.onChanged();
                        } catch (err) {
                          props.report(getErrorMessage(err, "Could not update the subscription."));
                        }
                      })()
                    }
                  >
                    {sub.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        props.report(null);
                        try {
                          await deleteSubscription(props.source.name, sub.name);
                          await reload();
                          props.onChanged();
                        } catch (err) {
                          props.report(getErrorMessage(err, "Could not delete the subscription."));
                        }
                      })()
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(subscriptions ?? []).map((sub) => {
        const rows = deliveries[sub.name];
        if (!rows) return null;
        return (
          <div key={sub.id}>
            <h4>Deliveries: {sub.name}</h4>
            {rows.length === 0 ? (
              <p className="empty-state">No deliveries recorded for this subscription yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
                      <th scope="col">Topic</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Execution</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.eventId} data-testid="delivery-row">
                        <td>
                          <code className="mono">{row.eventId}</code>
                        </td>
                        <td>
                          <code className="mono">{row.topic}</code>
                        </td>
                        <td>{row.outcome}</td>
                        <td>
                          {row.executionId ? (
                            <Link to={`/history/${row.executionId}`}>
                              <code className="mono mono--truncate" title={row.executionId}>
                                {shortId(row.executionId)}
                              </code>
                            </Link>
                          ) : (
                            <span className="muted">none</span>
                          )}
                        </td>
                        <td>
                          {row.outcome === "failed" ? (
                            <button
                              type="button"
                              onClick={() =>
                                void (async () => {
                                  props.report(null);
                                  try {
                                    const retried = await retrySubscriptionDelivery(
                                      props.source.name,
                                      sub.name,
                                      row.eventId,
                                    );
                                    props.report(
                                      retried.delivery.replayed
                                        ? `Retry replayed Execution ${shortId(retried.delivery.executionId)}.`
                                        : `Retry dispatched Execution ${shortId(retried.delivery.executionId)}.`,
                                    );
                                    await handleDeliveries(sub);
                                  } catch (err) {
                                    props.report(getErrorMessage(err, "The retry failed."));
                                  }
                                })()
                              }
                            >
                              Retry
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          props.report(null);
          void (async () => {
            try {
              await createSubscription(props.source.name, { name, topicFilter, sagaId });
              setName("");
              setTopicFilter("");
              await reload();
              props.onChanged();
            } catch (err) {
              props.report(getErrorMessage(err, "Could not create the subscription."));
            }
          })();
        }}
      >
        <h4>Subscribe a Saga</h4>
        <label htmlFor={`sub-name-${props.source.name}`}>Name</label>
        <input
          id={`sub-name-${props.source.name}`}
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="orders-echo"
        />
        <label htmlFor={`sub-filter-${props.source.name}`}>Topic filter</label>
        <input
          id={`sub-filter-${props.source.name}`}
          type="text"
          autoComplete="off"
          value={topicFilter}
          onChange={(e) => setTopicFilter(e.target.value)}
          placeholder="vendor.order.*"
        />
        <label htmlFor={`sub-saga-${props.source.name}`}>Saga</label>
        <select id={`sub-saga-${props.source.name}`} value={sagaId} onChange={(e) => setSagaId(e.target.value)}>
          {props.sagas.sagas.map((saga) => (
            <option key={saga.id} value={saga.id}>
              {saga.name}
            </option>
          ))}
        </select>
        <label htmlFor={`sub-outcome-${props.source.name}`}>Delivery history filter</label>
        <select
          id={`sub-outcome-${props.source.name}`}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as "delivered" | "failed" | "all")}
        >
          <option value="all">all</option>
          <option value="delivered">delivered</option>
          <option value="failed">failed</option>
        </select>
        <button type="submit" disabled={!name || !topicFilter || !sagaId}>
          Create subscription
        </button>
      </form>
    </div>
  );
}

function SourcesSection(props: {
  sources: EventSourceSummary[];
  sagas: SagasResponse;
  onChanged: () => void;
  report: (message: string | null) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, SourceEvent[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"schedule" | "webhook" | "topic">("topic");
  const [eventId, setEventId] = useState("");
  const [topic, setTopic] = useState("");
  const [payloadJson, setPayloadJson] = useState("{}");
  const [saving, setSaving] = useState(false);

  async function guard(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    props.report(null);
    try {
      await work();
      props.onChanged();
    } catch (err) {
      props.report(getErrorMessage(err, "The event-source request failed."));
    } finally {
      setBusy(null);
    }
  }

  async function handleEvents(source: string): Promise<void> {
    await guard(`events:${source}`, async () => {
      const rows = await listSourceEvents(source);
      setEvents((prev) => ({ ...prev, [source]: rows }));
    });
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    props.report(null);
    try {
      await createEventSource({ name, kind });
      setName("");
      props.onChanged();
    } catch (err) {
      props.report(getErrorMessage(err, "Could not create the event source."));
    } finally {
      setSaving(false);
    }
  }

  async function handleEmit(e: React.FormEvent, source: string): Promise<void> {
    e.preventDefault();
    let payload: unknown = null;
    try {
      payload = payloadJson.trim() ? (JSON.parse(payloadJson) as unknown) : null;
    } catch {
      props.report("Event payload must be valid JSON.");
      return;
    }
    await guard(`emit:${source}`, async () => {
      const emitted = await emitSourceEvent(source, { eventId, topic, payload });
      setEventId("");
      props.report(
        emitted.replayed
          ? `Event replayed against ${emitted.deliveries.length} fan-out deliveries.`
          : `Event accepted; ${emitted.deliveries.length} fan-out deliveries, ${emitted.overflowSkipped} overflow skipped.`,
      );
      const rows = await listSourceEvents(source);
      setEvents((prev) => ({ ...prev, [source]: rows }));
    });
  }

  return (
    <div>
      <h2>Event sources</h2>
      <p className="muted">
        Registry entries owning an append-only event log. Same (source, event) replays; mismatched content answers 409.
        Accepted events fan out to eligible subscriptions.
      </p>
      <div className="table-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">State</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.sources.map((entry) => (
              <tr key={entry.id} data-testid="source-row">
                <td>
                  <button
                    type="button"
                    className="saga-link"
                    aria-expanded={selected === entry.name}
                    onClick={() => {
                      setSelected((prev) => (prev === entry.name ? null : entry.name));
                      if (selected !== entry.name) void handleEvents(entry.name);
                    }}
                  >
                    {entry.name}
                  </button>
                </td>
                <td>{entry.kind}</td>
                <td>{entry.enabled ? "enabled" : "disabled"}</td>
                <td>
                  <button type="button" disabled={busy !== null} onClick={() => void handleEvents(entry.name)}>
                    History
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard(`toggle:${entry.name}`, async () => {
                        await setSourceEnabled(entry.name, !entry.enabled);
                      })
                    }
                  >
                    {entry.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard(`delete:${entry.name}`, async () => {
                        await deleteEventSource(entry.name);
                        if (selected === entry.name) setSelected(null);
                      })
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.sources.length === 0 ? (
        <p className="empty-state">No event sources registered for this Organization yet.</p>
      ) : null}
      {props.sources
        .filter((entry) => selected === entry.name)
        .map((entry) => (
          <div key={entry.id}>
            <div className="detail-panel">
              <h3>Event history: {entry.name}</h3>
              {(() => {
                const rows = events[entry.name];
                if (!rows) return <p className="muted">Open History to load the log.</p>;
                if (rows.length === 0) return <p className="empty-state">No events logged on this source yet.</p>;
                return (
                  <div className="table-scroll">
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th scope="col">Event</th>
                          <th scope="col">Topic</th>
                          <th scope="col">Execution</th>
                          <th scope="col">Logged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.eventId} data-testid="source-event-row">
                            <td>
                              <code className="mono">{row.eventId}</code>
                            </td>
                            <td>
                              <code className="mono">{row.topic}</code>
                            </td>
                            <td>
                              {row.executionId ? (
                                <Link to={`/history/${row.executionId}`}>
                                  <code className="mono mono--truncate" title={row.executionId}>
                                    {shortId(row.executionId)}
                                  </code>
                                </Link>
                              ) : (
                                <span className="muted">none</span>
                              )}
                            </td>
                            <td>{row.createdAt}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
              <form className="inline-form" onSubmit={(e) => void handleEmit(e, entry.name)}>
                <h4>Emit an event</h4>
                <label htmlFor={`emit-id-${entry.name}`}>Event ID</label>
                <input
                  id={`emit-id-${entry.name}`}
                  type="text"
                  autoComplete="off"
                  value={eventId}
                  onChange={(e) => setEventId(e.target.value)}
                  placeholder="evt-1"
                />
                <label htmlFor={`emit-topic-${entry.name}`}>Topic (dot-namespaced)</label>
                <input
                  id={`emit-topic-${entry.name}`}
                  type="text"
                  autoComplete="off"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="vendor.order.created"
                />
                <label htmlFor={`emit-payload-${entry.name}`}>Payload (JSON)</label>
                <textarea
                  id={`emit-payload-${entry.name}`}
                  value={payloadJson}
                  onChange={(e) => setPayloadJson(e.target.value)}
                  rows={3}
                />
                <button type="submit" disabled={busy !== null || !eventId || !topic}>
                  Emit event
                </button>
              </form>
            </div>
            <SubscriptionsBlock source={entry} sagas={props.sagas} onChanged={props.onChanged} report={props.report} />
          </div>
        ))}
      <form className="connection-form" onSubmit={(e) => void handleCreate(e)}>
        <h3>Register an event source</h3>
        <label htmlFor="source-name">Name (lowercase, digits, dashes)</label>
        <input
          id="source-name"
          name="name"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="vendor-orders"
        />
        <label htmlFor="source-kind">Kind</label>
        <select
          id="source-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as "schedule" | "webhook" | "topic")}
        >
          <option value="topic">topic</option>
          <option value="schedule">schedule</option>
          <option value="webhook">webhook</option>
        </select>
        <button type="submit" disabled={saving || !name}>
          {saving ? "Creating…" : "Create event source"}
        </button>
      </form>
    </div>
  );
}

function EndpointsSection(props: {
  endpoints: EndpointSummary[];
  sagas: SagasResponse;
  onChanged: () => void;
  report: (message: string | null) => void;
}): React.JSX.Element {
  const [detailEvents, setDetailEvents] = useState<Record<string, EndpointEvent[]>>({});
  const [issued, setIssued] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sagaId, setSagaId] = useState(props.sagas.sagas[0]?.id ?? "");
  const [kind, setKind] = useState<"api-key" | "webhook">("webhook");
  const [saving, setSaving] = useState(false);

  async function guard(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    props.report(null);
    try {
      await work();
      props.onChanged();
    } catch (err) {
      props.report(getErrorMessage(err, "The endpoint request failed."));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    props.report(null);
    try {
      const created = await createEndpoint({ name, sagaId, kind });
      setIssued({ name, value: created.apiKey ?? created.webhookSecret ?? "" });
      setName("");
      props.onChanged();
    } catch (err) {
      props.report(getErrorMessage(err, "Could not create the endpoint."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2>Endpoints</h2>
      <p className="muted">
        Authenticated webhook and API-key execution endpoints bound to a Saga. Endpoints have no delete route: disabling
        revokes delivery and rotating replaces the credential.
      </p>
      {issued ? (
        <p role="alert" className="alert">
          Credential for {issued.name}: <code className="mono">{issued.value}</code> — copy it now, it is never shown
          again. Webhook secrets must also be planted in the deployment secret store.
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="history-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Saga</th>
              <th scope="col">Kind</th>
              <th scope="col">State</th>
              <th scope="col">Rate/min</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.endpoints.map((entry) => (
              <tr key={entry.id} data-testid="endpoint-row">
                <td>{entry.name}</td>
                <td title={entry.sagaId}>{shortId(entry.sagaId)}</td>
                <td>{entry.kind}</td>
                <td>{entry.enabled ? "enabled" : "disabled"}</td>
                <td>{entry.rateLimitPerMinute ?? <span className="muted">none</span>}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard(`events:${entry.name}`, async () => {
                        const rows = await listEndpointEvents(entry.name);
                        setDetailEvents((prev) => ({ ...prev, [entry.name]: rows }));
                      })
                    }
                  >
                    History
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard(`toggle:${entry.name}`, async () => {
                        await setEndpointEnabled(entry.name, !entry.enabled);
                      })
                    }
                  >
                    {entry.enabled ? "Disable" : "Enable"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard(`rotate:${entry.name}`, async () => {
                        const rotated = await rotateEndpoint(entry.name);
                        setIssued({
                          name: entry.name,
                          value: rotated.apiKey ?? rotated.webhookSecret ?? "",
                        });
                      })
                    }
                  >
                    Rotate
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.endpoints.length === 0 ? (
        <p className="empty-state">No endpoints registered for this Organization yet.</p>
      ) : null}
      {props.endpoints
        .filter((entry) => detailEvents[entry.name] !== undefined)
        .map((entry) => {
          const rows = detailEvents[entry.name] ?? [];
          return (
            <div key={entry.id} className="detail-panel">
              <h3>Delivery history: {entry.name}</h3>
              {rows.length === 0 ? (
                <p className="empty-state">No deliveries recorded on this endpoint yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">Execution</th>
                        <th scope="col">Delivered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.eventId} data-testid="endpoint-event-row">
                          <td>
                            <code className="mono">{row.eventId}</code>
                          </td>
                          <td>
                            <Link to={`/history/${row.executionId}`}>
                              <code className="mono mono--truncate" title={row.executionId}>
                                {shortId(row.executionId)}
                              </code>
                            </Link>
                          </td>
                          <td>{row.createdAt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      <form className="connection-form" onSubmit={(e) => void handleCreate(e)}>
        <h3>Create an endpoint</h3>
        <label htmlFor="endpoint-name">Name (lowercase, digits, dashes)</label>
        <input
          id="endpoint-name"
          name="name"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="vendor-hook"
        />
        <label htmlFor="endpoint-saga">Saga</label>
        <select id="endpoint-saga" value={sagaId} onChange={(e) => setSagaId(e.target.value)}>
          {props.sagas.sagas.map((saga) => (
            <option key={saga.id} value={saga.id}>
              {saga.name}
            </option>
          ))}
        </select>
        <label htmlFor="endpoint-kind">Kind</label>
        <select id="endpoint-kind" value={kind} onChange={(e) => setKind(e.target.value as "api-key" | "webhook")}>
          <option value="webhook">webhook</option>
          <option value="api-key">api-key</option>
        </select>
        <button type="submit" disabled={saving || !name || !sagaId}>
          {saving ? "Creating…" : "Create endpoint"}
        </button>
      </form>
    </div>
  );
}

export function TriggersView(props: { initial?: TriggersInitial; defaultTab?: Tab }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(props.defaultTab ?? "schedules");
  const [schedules, setSchedules] = useState<SchedulesResponse | null>(props.initial?.schedules ?? null);
  const [sources, setSources] = useState<EventSourcesResponse | null>(props.initial?.sources ?? null);
  const [endpoints, setEndpoints] = useState<EndpointsResponse | null>(props.initial?.endpoints ?? null);
  const [sagas, setSagas] = useState<SagasResponse | null>(props.initial?.sagas ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSchedules, nextSources, nextEndpoints, nextSagas] = await Promise.all([
        listSchedules(),
        listEventSources(),
        listEndpoints(),
        listSagas(),
      ]);
      setSchedules(nextSchedules);
      setSources(nextSources);
      setEndpoints(nextEndpoints);
      setSagas(nextSagas);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Triggers."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const [nextSchedules, nextSources, nextEndpoints, nextSagas] = await Promise.all([
          listSchedules(),
          listEventSources(),
          listEndpoints(),
          listSagas(),
        ]);
        if (cancelled) return;
        setSchedules(nextSchedules);
        setSources(nextSources);
        setEndpoints(nextEndpoints);
        setSagas(nextSagas);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load Triggers."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  return (
    <section aria-labelledby="triggers-heading">
      <h1 id="triggers-heading">Triggers</h1>
      <p className="muted">
        Schedules, event sources, and execution endpoints for this Organization. Writes need manage access; the server
        answers anything else with an honest error, never an empty list.
      </p>
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
          Loading Triggers…
        </p>
      ) : null}
      <SectionError message={error} />
      <div role="tablist" aria-label="Trigger families">
        {(["schedules", "sources", "endpoints"] as Tab[]).map((entry) => (
          <button key={entry} type="button" role="tab" aria-selected={tab === entry} onClick={() => setTab(entry)}>
            {entry === "schedules" ? "Schedules" : entry === "sources" ? "Event sources" : "Endpoints"}
          </button>
        ))}
      </div>
      {schedules && sources && endpoints && sagas ? (
        <>
          {tab === "schedules" ? (
            <SchedulesSection
              schedules={schedules.schedules}
              sagas={sagas}
              onChanged={() => void reload()}
              report={setError}
            />
          ) : null}
          {tab === "sources" ? (
            <SourcesSection sources={sources.sources} sagas={sagas} onChanged={() => void reload()} report={setError} />
          ) : null}
          {tab === "endpoints" ? (
            <EndpointsSection
              endpoints={endpoints.endpoints}
              sagas={sagas}
              onChanged={() => void reload()}
              report={setError}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
