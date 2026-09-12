// SPDX-License-Identifier: AGPL-3.0
// Dynamic forms UI (FORM-02, issue #155).
//
// Borrowed structure from client/src/pages/Configs.tsx (token form,
// loading/error/notice states). Lists org-scoped declarations, renders one
// server-authoritative declaration (display-only layout kinds render text,
// conditional fields hide by rule, provider options populate selects),
// runs the startup handshake (defaults, opt-in prefill, provider options),
// and submits through the consumed handle with inspectable execution
// linkage. Validation errors render per-field; the server stays
// authoritative and every failure surfaces its machine-readable code.
import { useEffect, useState } from "react";
import {
  deleteForm,
  fetchFormDetail,
  fetchFormProviders,
  getToken,
  listForms,
  setToken,
  startFormSession,
  submitForm,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type {
  FormDetail,
  FormFieldDef,
  FormStartupResponse,
  FormSubmitResponse,
  FormsResponse,
} from "../lib/client-types";

/** Renderer visibility mirrors the server validation gate: the submit body
 * is the complete record and the server evaluates conditionals over the
 * startup snapshot plus submitted values, so the renderer must too —
 * edits alone would hide fields the server shows (and require) when the
 * trigger comes from a default or prefill. */
function isVisible(field: FormFieldDef, values: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true;
  return values[field.visibleWhen.field] === field.visibleWhen.equals;
}

/** Visibility base: startup snapshot under current edits (edits win). */
function visibilityBase(snapshot: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  return { ...snapshot, ...values };
}

/** Submit values: current edits over the startup snapshot for visible
 * fields. The server merges submitted values over declaration defaults but
 * does NOT auto-merge the startup snapshot (snapshot only drives
 * visibility), so untouched prefill would be lost if the client sent edits
 * alone. Sending snapshot-backed values for visible fields keeps the submit
 * body the complete record the server gate evaluates. A null edit means
 * the user cleared the field: send explicit null so the server visibility
 * sees the gap too (merged snapshot would otherwise resurrect the trigger
 * and show a dependent the renderer hides); the server reads null as a gap
 * (a declared default fills it, a missing required fails). Hidden fields
 * stay omitted either way (sending them fails HIDDEN_FIELD). */
export function submitValues(
  fields: FormFieldDef[],
  snapshot: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const visible = visibilityBase(snapshot, values);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "heading" || field.type === "paragraph" || field.type === "divider") continue;
    if (!isVisible(field, visible)) continue;
    if (values[field.name] === null) {
      out[field.name] = null;
      continue;
    }
    const next = values[field.name] !== undefined ? values[field.name] : snapshot[field.name];
    if (next !== undefined && next !== null) out[field.name] = next;
  }
  return out;
}

function fieldError(details: unknown, name: string): string | null {
  if (!Array.isArray(details)) return null;
  for (const entry of details) {
    if (typeof entry === "object" && entry !== null) {
      const row = entry as { field?: unknown; code?: unknown; message?: unknown };
      if (row.field === name && typeof row.code === "string") {
        return typeof row.message === "string" ? `${row.code}: ${row.message}` : row.code;
      }
    }
  }
  return null;
}

function renderInput(
  field: FormFieldDef,
  value: unknown,
  options: Record<string, string[]>,
  onChange: (name: string, next: unknown) => void,
): React.JSX.Element {
  const current = value ?? field.default ?? "";
  switch (field.type) {
    case "boolean":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="checkbox"
          checked={current === true}
          onChange={(e) => onChange(field.name, e.target.checked)}
        />
      );
    case "number":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="number"
          value={typeof current === "number" ? String(current) : ""}
          onChange={(e) => onChange(field.name, e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "select": {
      const list = options[field.name] ?? field.options ?? [];
      return (
        <select
          id={`form-field-${field.name}`}
          name={field.name}
          value={typeof current === "string" ? current : ""}
          // The placeholder is "": map it to undefined (cleared → stored
          // as null → sent as explicit null) so the server reads a gap —
          // a declared default fills it, a missing required fails REQUIRED,
          // and an optional stays omitted instead of failing INVALID_OPTION.
          onChange={(e) => onChange(field.name, e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="">Select…</option>
          {list.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    case "multiselect": {
      const list = options[field.name] ?? field.options ?? [];
      const picked = Array.isArray(current) ? (current as unknown[]).filter((item) => typeof item === "string") : [];
      return (
        <select
          id={`form-field-${field.name}`}
          name={field.name}
          multiple
          value={picked as string[]}
          onChange={(e) =>
            onChange(
              field.name,
              Array.from(e.target.selectedOptions, (item) => item.value),
            )
          }
        >
          {list.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    case "textarea":
      return (
        <textarea
          id={`form-field-${field.name}`}
          name={field.name}
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
    case "date":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="date"
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
    case "time":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="time"
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
    case "datetime":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="datetime-local"
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
    case "email":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="email"
          autoComplete="off"
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
    case "url":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="url"
          autoComplete="off"
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
    case "tel":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="tel"
          autoComplete="off"
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
    case "file": {
      // File fields reference a finalized FILE-01 { location, path }: the
      // renderer takes a path and pins the declared location. The server
      // re-validates readiness, size, and type against the live file row.
      // An emptied path maps to undefined (cleared → stored as null → sent
      // as explicit null, which the server reads as a gap).
      const ref = (typeof current === "object" && current !== null ? current : {}) as Record<string, unknown>;
      const path = typeof ref["path"] === "string" ? (ref["path"] as string) : "";
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="text"
          autoComplete="off"
          placeholder={`path in ${field.file?.location ?? "location"}`}
          value={path}
          onChange={(e) =>
            onChange(
              field.name,
              e.target.value === "" ? undefined : { location: field.file?.location ?? "", path: e.target.value },
            )
          }
        />
      );
    }
    case "hidden":
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="hidden"
          value={typeof current === "string" ? current : ""}
          readOnly
        />
      );
    default:
      return (
        <input
          id={`form-field-${field.name}`}
          name={field.name}
          type="text"
          autoComplete="off"
          value={typeof current === "string" ? current : ""}
          onChange={(e) => onChange(field.name, e.target.value)}
        />
      );
  }
}

export function FormsList(props: { initial?: FormsResponse }): React.JSX.Element {
  const [data, setData] = useState<FormsResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setData(await listForms());
    } catch (err) {
      setError(getErrorMessage(err, "Could not load forms."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await listForms());
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load forms."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  async function onDelete(name: string): Promise<void> {
    setError(null);
    try {
      await deleteForm(name);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not delete form."));
    }
  }

  return (
    <section aria-labelledby="forms-heading">
      <h1 id="forms-heading">Forms</h1>
      <p className="muted">
        Org-scoped dynamic forms. Declarations are server-authoritative; submissions run startup then submit.
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
          Loading forms…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Saga</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.forms.map((entry) => (
                  <tr key={entry.id} data-testid="form-row">
                    <td>
                      <code className="mono" title={entry.id}>
                        {entry.name}
                      </code>
                    </td>
                    <td>
                      <code className="mono" title={entry.sagaId}>
                        {entry.sagaId.slice(0, 12)}…
                      </code>
                    </td>
                    <td>
                      <a href={`/forms/${entry.name}`}>Open</a>{" "}
                      <button type="button" onClick={() => void onDelete(entry.name)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.forms.length === 0 ? <p className="empty-state">No forms yet.</p> : null}
        </>
      ) : null}
    </section>
  );
}

export function FormDetailView(props: { name: string; initial?: FormDetail }): React.JSX.Element {
  const [form, setForm] = useState<FormDetail | null>(props.initial ?? null);
  const [session, setSession] = useState<FormStartupResponse | null>(null);
  const [providers, setProviders] = useState<Record<string, string[]> | null>(null);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<FormSubmitResponse | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [scheduleAt, setScheduleAt] = useState("");
  const [token, setTokenState] = useState(getToken());

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setForm(await fetchFormDetail(props.name));
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load form."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial, props.name]);

  function onChange(name: string, next: unknown): void {
    setValues((prev) => ({
      ...prev,
      // Cleared inputs arrive as undefined (e.g. an emptied number field).
      // Store null so the edit stays present: untouched fields are absent
      // (snapshot-backed on submit), cleared fields are null (sent as
      // explicit null on submit, which the server reads as a gap for
      // defaults to fill).
      [name]: next === undefined ? null : next,
    }));
  }

  async function onStart(): Promise<void> {
    setError(null);
    setFieldErrors(null);
    setNotice(null);
    setReceipt(null);
    setSession(null);
    try {
      const started = await startFormSession(props.name);
      setSession(started);
      setProviders(started.options);
      setSnapshot({ ...started.snapshot });
      setValues({});
      setNotice(`Session started; expires ${started.expiresAt}.`);
    } catch (err) {
      setError(getErrorMessage(err, "Could not start form session."));
    }
  }

  async function onProviders(): Promise<void> {
    setError(null);
    try {
      const resolved = await fetchFormProviders(props.name);
      setProviders(resolved.options);
      setProviderErrors(resolved.errors);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load providers."));
    }
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!session) {
      setError("Start a form session first (STALE_FORM_HANDLE otherwise).");
      return;
    }
    setError(null);
    setFieldErrors(null);
    setNotice(null);
    setReceipt(null);
    try {
      const key = `form-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
      const accepted = await submitForm(
        props.name,
        {
          handle: session.handle,
          values: form ? submitValues(form.fields, snapshot, values) : values,
          ...(scheduleAt.trim().length === 0 ? {} : { scheduleAt: scheduleAt.trim() }),
        },
        key,
      );
      setReceipt(accepted);
      setSession(null);
      setNotice(
        accepted.scheduled === true
          ? `Scheduled for ${accepted.scheduleAt} (inspectable linkage below).`
          : "Submitted; execution linkage below.",
      );
    } catch (err) {
      setError(getErrorMessage(err, "Could not submit form."));
      // Per-field details ride the Worker 422 envelope through ApiError;
      // surface them per field when present (fail-closed, never a crash).
      // The server consumes the handle only after validation passes, so the
      // session stays for a corrected retry; only a consumed handle clears.
      const shaped = err as { details?: unknown; code?: unknown };
      setFieldErrors(Array.isArray(shaped.details) ? shaped.details : null);
      if (shaped.code === "STALE_FORM_HANDLE") setSession(null);
    }
  }

  return (
    <section aria-labelledby="form-detail-heading">
      <h1 id="form-detail-heading">Form {props.name}</h1>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token);
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
        <button type="submit">Save token</button>
      </form>
      {loading ? (
        <p role="status" className="status-line">
          Loading form…
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
      {form ? (
        <>
          {form.title ? <h2>{form.title}</h2> : null}
          {form.description ? <p className="muted">{form.description}</p> : null}
          <p className="muted">
            Saga <code className="mono">{form.sagaId}</code>
            {form.allowPrefill ? " · URL-prefill opt-in" : null}
          </p>
          <div>
            <button type="button" onClick={() => void onStart()}>
              Start session
            </button>{" "}
            <button type="button" onClick={() => void onProviders()}>
              Reload providers
            </button>
          </div>
          {Object.keys(providerErrors).length > 0 ? (
            <ul>
              {Object.entries(providerErrors).map(([field, message]) => (
                <li key={field} role="alert">
                  Provider {field}: {message}
                </li>
              ))}
            </ul>
          ) : null}
          <form onSubmit={(e) => void onSubmit(e)}>
            {form.fields.map((field) => {
              if (field.type === "heading")
                return <h3 key={field.name}>{field.content ?? field.label ?? field.name}</h3>;
              if (field.type === "paragraph")
                return (
                  <p key={field.name} className="muted">
                    {field.content ?? ""}
                  </p>
                );
              if (field.type === "divider") return <hr key={field.name} />;
              if (!isVisible(field, visibilityBase(snapshot, values))) return null;
              const problem = fieldError(fieldErrors, field.name);
              return (
                <div key={field.name}>
                  <label htmlFor={`form-field-${field.name}`}>
                    {field.label ?? field.name}
                    {field.required ? " (required)" : null}
                  </label>
                  {renderInput(
                    field,
                    // A null edit means the user cleared the field: render
                    // the empty value, never the snapshot (submit sends
                    // explicit null so the server reads a gap for defaults
                    // to fill).
                    values[field.name] === null ? "" : (values[field.name] ?? snapshot[field.name]),
                    providers ?? {},
                    onChange,
                  )}
                  {problem ? (
                    <p role="alert" className="alert">
                      {problem}
                    </p>
                  ) : null}
                </div>
              );
            })}
            <label htmlFor="form-schedule">Schedule at (optional ISO instant, within 30 days)</label>
            <input
              id="form-schedule"
              name="scheduleAt"
              type="text"
              autoComplete="off"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              placeholder="2026-09-20T12:00:00.000Z"
            />
            <button type="submit">Submit</button>
          </form>
          {receipt ? (
            <p role="status" className="status-line">
              Execution <a href={`/history/${receipt.executionId}`}>{receipt.executionId.slice(0, 12)}…</a>
              {receipt.replayed ? " (replayed)" : null}
              {receipt.scheduled === true ? " (scheduled)" : null}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
