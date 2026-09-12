// SPDX-License-Identifier: AGPL-3.0
// Connections admin (CON-01, issue #146). Layout borrowed (not verbatim)
// from client/src/pages/Applications.tsx (token form, loading/error/empty
// states, truncated-mono ID + tooltip table pattern).
//
// Minimal usable admin screen: portable Integration definitions (schema,
// defaults, required-secret names, health) plus this Organization's
// Connection mappings with create/update/test/disable/delete. Non-secret
// config only: secret values are never accepted, displayed, or posted on any
// path here. Managed rows render read-only: the server rejects live mutation
// with MANAGED_RESOURCE.
import { useCallback, useEffect, useState } from "react";
import {
  createConnection,
  deleteConnection,
  getToken,
  listConnections,
  listIntegrations,
  setToken,
  testConnection,
  updateConnection,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type {
  ConnectionsResponse,
  ConnectionSummary,
  ConnectionTestResult,
  IntegrationsResponse,
} from "../lib/client-types";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function ConnectionsList(props: { initial?: ConnectionsResponse }): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionsResponse | null>(props.initial ?? null);
  const [integrations, setIntegrations] = useState<IntegrationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [selected, setSelected] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextConnections, nextIntegrations] = await Promise.all([listConnections(), listIntegrations()]);
      setConnections(nextConnections);
      setIntegrations(nextIntegrations);
      if (!selected && nextIntegrations.integrations.length > 0) {
        const first = nextIntegrations.integrations[0];
        if (first) {
          setSelected(first.id);
          const endpointField = first.configSchema.find((field) => field.name === "endpoint");
          if (endpointField?.default) setEndpoint(endpointField.default);
        }
      }
    } catch (err) {
      setError(getErrorMessage(err, "Could not load Connections."));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    if (props.initial) {
      void listIntegrations()
        .then((next) => {
          setIntegrations(next);
          if (next.integrations.length > 0) {
            const first = next.integrations[0];
            if (first) {
              setSelected(first.id);
              const endpointField = first.configSchema.find((field) => field.name === "endpoint");
              if (endpointField?.default) setEndpoint(endpointField.default);
            }
          }
        })
        .catch((err: unknown) => setError(getErrorMessage(err, "Could not load Integrations.")));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [nextConnections, nextIntegrations] = await Promise.all([listConnections(), listIntegrations()]);
        if (cancelled) return;
        setConnections(nextConnections);
        setIntegrations(nextIntegrations);
        const first = nextIntegrations.integrations[0];
        if (first) {
          setSelected(first.id);
          const endpointField = first.configSchema.find((field) => field.name === "endpoint");
          if (endpointField?.default) setEndpoint(endpointField.default);
        }
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load Connections."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  const configuredIds = new Set((connections?.connections ?? []).map((entry) => entry.integrationId));
  const unconfigured = (integrations?.integrations ?? []).filter((entry) => !configuredIds.has(entry.id));

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await createConnection({
        integrationId: selected,
        config: { endpoint },
        ...(displayName ? { displayName } : {}),
      });
      setEndpoint("");
      setDisplayName("");
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not create the Connection."));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(entry: ConnectionSummary): Promise<void> {
    setError(null);
    try {
      await updateConnection(entry.integrationId, { enabled: !entry.enabled });
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not update the Connection."));
    }
  }

  async function handleDelete(entry: ConnectionSummary): Promise<void> {
    setError(null);
    try {
      await deleteConnection(entry.integrationId);
      await reload();
    } catch (err) {
      setError(getErrorMessage(err, "Could not delete the Connection."));
    }
  }

  async function handleTest(entry: ConnectionSummary): Promise<void> {
    setTesting(entry.integrationId);
    setError(null);
    try {
      const result = await testConnection(entry.integrationId);
      setTestResults((prev) => ({ ...prev, [entry.integrationId]: result.test }));
    } catch (err) {
      setError(getErrorMessage(err, "The connectivity test failed."));
    } finally {
      setTesting(null);
    }
  }

  return (
    <section aria-labelledby="connections-heading">
      <h1 id="connections-heading">Connections</h1>
      <p className="muted">
        Non-secret Connection mappings for this Organization. Secret values are never shown or entered here.
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
          Loading Connections…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}
      {connections ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Display name</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">State</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Test</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.connections.map((entry) => {
                  const test = testResults[entry.integrationId];
                  return (
                    <tr key={entry.id} data-testid="connection-row">
                      <td>
                        <span className="saga-link">{entry.integrationName}</span>{" "}
                        <code className="mono mono--truncate" title={entry.id}>
                          {shortId(entry.id)}
                        </code>
                      </td>
                      <td>{entry.displayName ?? <span className="muted">none</span>}</td>
                      <td>
                        <code className="mono mono--truncate" title={entry.endpoint}>
                          {entry.endpoint}
                        </code>
                      </td>
                      <td>{entry.enabled ? "enabled" : "disabled"}</td>
                      <td>
                        {entry.ownerKind}
                        {entry.managedBy ? (
                          <span className="muted" title={entry.managedBy}>
                            {" "}
                            · managed
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {test ? (
                          <span className={test.ok ? "muted" : "alert"}>
                            {test.ok ? "passing" : `failing (${test.code ?? "error"})`}
                          </span>
                        ) : (
                          <span className="muted">untested</span>
                        )}
                      </td>
                      <td>
                        {entry.ownerKind === "managed" ? (
                          <span className="muted" title="Solution-owned: use the bundle install to change this mapping">
                            MANAGED_RESOURCE
                          </span>
                        ) : (
                          <>
                            <button type="button" onClick={() => void handleToggle(entry)}>
                              {entry.enabled ? "Disable" : "Enable"}
                            </button>{" "}
                            <button
                              type="button"
                              onClick={() => void handleTest(entry)}
                              disabled={testing === entry.integrationId}
                            >
                              {testing === entry.integrationId ? "Testing…" : "Test"}
                            </button>{" "}
                            <button type="button" onClick={() => void handleDelete(entry)}>
                              Delete
                            </button>
                          </>
                        )}
                        {entry.ownerKind === "managed" ? (
                          <>
                            {" "}
                            <button
                              type="button"
                              onClick={() => void handleTest(entry)}
                              disabled={testing === entry.integrationId}
                            >
                              {testing === entry.integrationId ? "Testing…" : "Test"}
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {connections.connections.length === 0 ? (
            <p className="empty-state">No Connections configured for this Organization yet.</p>
          ) : null}
        </>
      ) : null}
      {integrations && unconfigured.length > 0 ? (
        <form className="connection-form" onSubmit={(e) => void handleCreate(e)}>
          <h2>Add a Connection</h2>
          <label htmlFor="integration">Integration</label>
          <select
            id="integration"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              const def = integrations.integrations.find((entry) => entry.id === e.target.value);
              const endpointField = def?.configSchema.find((field) => field.name === "endpoint");
              setEndpoint(endpointField?.default ?? "");
            }}
          >
            {unconfigured.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <label htmlFor="endpoint">Endpoint (non-secret)</label>
          <input
            id="endpoint"
            name="endpoint"
            type="text"
            autoComplete="off"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://…"
          />
          <label htmlFor="displayName">Display name (optional)</label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            autoComplete="off"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Production NinjaOne"
          />
          <button type="submit" disabled={saving || !selected}>
            {saving ? "Creating…" : "Create Connection"}
          </button>
        </form>
      ) : null}
      {integrations ? (
        <>
          <h2>Integration definitions</h2>
          <p className="muted">Portable provider contracts: schema, defaults, required-secret names, and health.</p>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Config schema</th>
                  <th scope="col">Secrets required</th>
                  <th scope="col">Health</th>
                </tr>
              </thead>
              <tbody>
                {integrations.integrations.map((entry) => (
                  <tr key={entry.id} data-testid="integration-row">
                    <td>
                      <span className="saga-link">{entry.name}</span> <span className="muted">{entry.description}</span>
                    </td>
                    <td>
                      {entry.configSchema.map((field) => (
                        <span key={field.name}>
                          <code className="mono">{field.name}</code>
                          {field.required ? " (required" : " (optional"}
                          {field.default ? `, default ${field.default}` : ""})
                        </span>
                      ))}
                    </td>
                    <td>
                      {entry.requiredSecrets.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        entry.requiredSecrets.map((name) => (
                          <code key={name} className="mono" title={entry.secretEnvVars[name] ?? name}>
                            {name}
                          </code>
                        ))
                      )}
                    </td>
                    <td>
                      <span className="muted">{entry.health.testHint}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
