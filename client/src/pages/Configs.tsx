// SPDX-License-Identifier: AGPL-3.0
// Scoped configuration UI (CON-02, issue #147; ADR 020).
//
// Borrowed structure from client/src/pages/Sagas.tsx (token form,
// loading/error/empty states, truncated-mono ID + tooltip pattern). Lists
// typed config rows for this Organization, sets non-secret values,
// provisions secret references, and deletes loose rows. Secret rows answer
// "[SECRET]" everywhere — values and reference targets never render, and the
// secret-value form only ever sends a { ref } reference name.
import { useEffect, useState } from "react";
import {
  deleteConfigEntry,
  getToken,
  listConfigs,
  setConfigEntry,
  setToken,
  updateConfigEntry,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type { ConfigEntry, ConfigListResponse } from "../lib/client-types";

const CONFIG_TYPES = ["string", "int", "bool", "json", "secret"] as const;

function renderValue(entry: ConfigEntry): string {
  if (entry.type === "secret") return "[SECRET]";
  return JSON.stringify(entry.value) ?? "—";
}

export function ConfigsList(props: { initial?: ConfigListResponse }): React.JSX.Element {
  const [data, setData] = useState<ConfigListResponse | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [key, setKey] = useState("");
  const [type, setType] = useState<string>("string");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setData(await listConfigs());
    } catch (err) {
      setError(getErrorMessage(err, "Could not load config."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        setData(await listConfigs());
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load config."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  async function onSet(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      // Secret rows provision a reference ({ ref }), never a value: the
      // free-text field names the declared deployment secret (e.g.
      // clientSecret), and the server presence-checks it.
      const body =
        type === "secret"
          ? {
              key,
              type,
              ...(value.trim().length === 0 ? {} : { value: JSON.parse(value) }),
              ...(description.trim().length === 0 ? {} : { description: description.trim() }),
            }
          : {
              key,
              type,
              value,
              ...(description.trim().length === 0 ? {} : { description: description.trim() }),
            };
      const saved = await setConfigEntry(body);
      setNotice(`Saved ${saved.key} (${saved.type}).`);
      setKey("");
      setValue("");
      setDescription("");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not save config."));
    }
  }

  async function onDelete(entry: ConfigEntry): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await deleteConfigEntry(entry.id);
      setNotice(`Deleted ${entry.key}.`);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not delete config."));
    }
  }

  async function onPreserveSecret(entry: ConfigEntry): Promise<void> {
    // Upstream partial-update parity, surfaced in the UI: re-saving a secret
    // row with no value keeps the existing reference.
    setError(null);
    setNotice(null);
    try {
      const saved = await updateConfigEntry(entry.id, { description: entry.description ?? undefined });
      setNotice(`Kept the ${saved.key} reference (no value sent).`);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not update config."));
    }
  }

  return (
    <section aria-labelledby="configs-heading">
      <h1 id="configs-heading">Configuration</h1>
      <p className="muted">
        Typed key/value rows for this Organization. Secret rows answer [SECRET] everywhere; values never leave the
        server.
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
          Loading config…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error} {error.includes("UNIMPLEMENTED") ? <span>(server reports this surface UNIMPLEMENTED)</span> : null}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="status-line">
          {notice}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Type</th>
                  <th scope="col">Value</th>
                  <th scope="col">Ownership</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.configs.map((entry) => (
                  <tr key={entry.id} data-testid="config-row">
                    <td>
                      <code className="mono" title={entry.id}>
                        {entry.key}
                      </code>
                    </td>
                    <td>
                      <span className="muted">{entry.type}</span>
                    </td>
                    <td>
                      <code className="mono">{renderValue(entry)}</code>
                    </td>
                    <td>
                      {entry.managedBy ? (
                        <span className="muted" title={entry.managedBy}>
                          managed
                        </span>
                      ) : (
                        <span className="muted">loose</span>
                      )}
                    </td>
                    <td>
                      {entry.managedBy ? (
                        <span className="muted">installer-owned</span>
                      ) : (
                        <>
                          {entry.type === "secret" ? (
                            <button type="button" onClick={() => void onPreserveSecret(entry)}>
                              Keep reference
                            </button>
                          ) : null}{" "}
                          <button type="button" onClick={() => void onDelete(entry)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.configs.length === 0 ? <p className="empty-state">No config rows yet.</p> : null}
          <form className="token-form" onSubmit={(e) => void onSet(e)}>
            <h2>Set config</h2>
            <label htmlFor="config-key">Key ([A-Za-z0-9_], 1-128 chars)</label>
            <input
              id="config-key"
              name="key"
              type="text"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="timeout"
            />
            <label htmlFor="config-type">Type</label>
            <select id="config-type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
              {CONFIG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label htmlFor="config-value">
              {type === "secret" ? 'Reference, e.g. {"ref":"clientSecret"} (empty keeps unprovisioned)' : "Value"}
            </label>
            <input
              id="config-value"
              name="value"
              type="text"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={type === "secret" ? '{"ref":"clientSecret"}' : "30"}
            />
            <label htmlFor="config-description">Description (optional, 280 chars)</label>
            <input
              id="config-description"
              name="description"
              type="text"
              autoComplete="off"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this key controls"
            />
            <button type="submit">Save</button>
          </form>
        </>
      ) : null}
    </section>
  );
}
