// SPDX-License-Identifier: AGPL-3.0
// Tool and external MCP administration (issue #559). Layout borrowed (not
// verbatim) from client/src/pages/Connections.tsx (token form,
// loading/error/empty states, truncated-mono ID + tooltip table pattern).
//
// Discovery, catalog, connection health, and safe management over the
// existing Worker routes only: GET/POST /api/tools (+ disable), GET
// /api/openapi/search (+ inspect), GET/POST /api/mcp-servers (+
// enable/disable/delete), and GET/POST /api/mcp-connections (+ update,
// delete, refresh-tools, catalog enable/disable, consent read).
//
// Secret-free by server construction and by omission here: this page has no
// secret field on any path — Connection views render provisioned flags
// (yes/no), never values, and client-secret provisioning plus the OAuth
// authorize/callback flows stay outside this UI. Consent is reported as
// state only; nothing here implies the browser consent flow is complete.
import { useCallback, useEffect, useState } from "react";
import {
  createMcpConnection,
  createMcpServer,
  deleteMcpConnection,
  deleteMcpServer,
  disableTool,
  enrollTool,
  getMcpConnectionConsent,
  getToken,
  inspectOpenapiOperation,
  listMcpConnections,
  listMcpConnectionTools,
  listMcpServers,
  listSagas,
  listTools,
  refreshMcpConnectionTools,
  searchOpenapiOperations,
  setMcpCatalogToolEnabled,
  setMcpServerActive,
  setToken,
  updateMcpConnection,
} from "../lib/api-client";
import { getErrorMessage } from "../lib/api-error";
import type {
  McpCatalogResponse,
  McpCatalogTool,
  McpConnectionsResponse,
  McpConnectionSummary,
  McpConsentState,
  McpRefreshSummary,
  McpServersResponse,
  OpenapiOperation,
  OpenapiSearchResponse,
  SagasResponse,
  ToolsResponse,
} from "../lib/client-types";

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export interface ToolsMcpInitial {
  tools?: ToolsResponse;
  sagas?: SagasResponse;
  search?: OpenapiSearchResponse;
  servers?: McpServersResponse;
  connections?: McpConnectionsResponse;
  catalog?: McpCatalogResponse;
  refresh?: McpRefreshSummary | null;
  consent?: McpConsentState | null;
}

export function ToolsMcp(props: { initial?: ToolsMcpInitial }): React.JSX.Element {
  const [tools, setTools] = useState<ToolsResponse | null>(props.initial?.tools ?? null);
  const [sagas, setSagas] = useState<SagasResponse | null>(props.initial?.sagas ?? null);
  const [search, setSearch] = useState<OpenapiSearchResponse | null>(props.initial?.search ?? null);
  const [servers, setServers] = useState<McpServersResponse | null>(props.initial?.servers ?? null);
  const [connections, setConnections] = useState<McpConnectionsResponse | null>(props.initial?.connections ?? null);
  const [catalog, setCatalog] = useState<McpCatalogResponse | null>(props.initial?.catalog ?? null);
  const [refresh, setRefresh] = useState<McpRefreshSummary | null>(props.initial?.refresh ?? null);
  const [consent, setConsent] = useState<McpConsentState | null | undefined>(props.initial?.consent);
  const [inspected, setInspected] = useState<OpenapiOperation | null>(props.initial?.search?.operations[0] ?? null);
  const [selectedConnection, setSelectedConnection] = useState(props.initial?.connections?.connections[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(props.initial ? false : true);
  const [token, setTokenState] = useState(getToken());
  const [includeInactive, setIncludeInactive] = useState(false);

  const [enrollSaga, setEnrollSaga] = useState("");
  const [enrollName, setEnrollName] = useState("");
  const [enrollDescription, setEnrollDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [serverName, setServerName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverFlow, setServerFlow] = useState("none");
  const [newServerUrl, setNewServerUrl] = useState("");
  const [newClientId, setNewClientId] = useState("");
  const [newTokenPath, setNewTokenPath] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTools, nextSagas, nextSearch, nextServers, nextConnections] = await Promise.all([
        listTools(),
        listSagas(),
        searchOpenapiOperations(""),
        listMcpServers(includeInactive),
        listMcpConnections(),
      ]);
      setTools(nextTools);
      setSagas(nextSagas);
      setSearch(nextSearch);
      setInspected(nextSearch.operations[0] ?? null);
      setServers(nextServers);
      setConnections(nextConnections);
      const first = nextConnections.connections[0];
      setSelectedConnection((prev) => prev || first?.id || "");
    } catch (err) {
      setError(getErrorMessage(err, "Could not load tools and MCP state."));
    } finally {
      setLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => {
    if (props.initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const [nextTools, nextSagas, nextSearch, nextServers, nextConnections] = await Promise.all([
          listTools(),
          listSagas(),
          searchOpenapiOperations(""),
          listMcpServers(false),
          listMcpConnections(),
        ]);
        if (cancelled) return;
        setTools(nextTools);
        setSagas(nextSagas);
        setSearch(nextSearch);
        setInspected(nextSearch.operations[0] ?? null);
        setServers(nextServers);
        setConnections(nextConnections);
        setSelectedConnection(nextConnections.connections[0]?.id ?? "");
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Could not load tools and MCP state."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initial]);

  async function handleEnroll(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const sagaId = enrollSaga || sagas?.sagas[0]?.id || "";
    if (!sagaId) return;
    setSaving(true);
    setError(null);
    try {
      await enrollTool({
        sagaId,
        ...(enrollName ? { name: enrollName } : {}),
        ...(enrollDescription ? { description: enrollDescription } : {}),
      });
      setEnrollName("");
      setEnrollDescription("");
      setTools(await listTools());
    } catch (err) {
      setError(getErrorMessage(err, "Could not enroll the tool."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDisable(name: string): Promise<void> {
    setError(null);
    try {
      await disableTool(name);
      setTools(await listTools());
    } catch (err) {
      setError(getErrorMessage(err, "Could not disable the tool."));
    }
  }

  async function handleSearch(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const next = await searchOpenapiOperations(query);
      setSearch(next);
      setInspected(next.operations[0] ?? null);
    } catch (err) {
      setError(getErrorMessage(err, "The contract search failed."));
    } finally {
      setSearching(false);
    }
  }

  async function handleInspect(operationId: string): Promise<void> {
    setError(null);
    try {
      setInspected(await inspectOpenapiOperation(operationId));
    } catch (err) {
      setError(getErrorMessage(err, "Could not inspect the operation."));
    }
  }

  async function handleCreateServer(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!serverName || !serverUrl) return;
    setSaving(true);
    setError(null);
    try {
      await createMcpServer({ name: serverName, serverUrl, providerFlow: serverFlow });
      setServerName("");
      setServerUrl("");
      setServers(await listMcpServers(includeInactive));
    } catch (err) {
      setError(getErrorMessage(err, "Could not create the MCP server."));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleServer(id: string, active: boolean): Promise<void> {
    setError(null);
    try {
      await setMcpServerActive(id, !active);
      setServers(await listMcpServers(includeInactive));
    } catch (err) {
      setError(getErrorMessage(err, "Could not update the MCP server."));
    }
  }

  async function handleDeleteServer(id: string): Promise<void> {
    setError(null);
    try {
      await deleteMcpServer(id);
      setServers(await listMcpServers(includeInactive));
    } catch (err) {
      setError(getErrorMessage(err, "Could not delete the MCP server."));
    }
  }

  async function handleCreateConnection(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const serverId = servers?.servers[0]?.id;
    if (!serverId) return;
    setSaving(true);
    setError(null);
    try {
      await createMcpConnection({
        serverId,
        ...(newServerUrl ? { serverUrlOverride: newServerUrl } : {}),
        ...(newTokenPath ? { tokenPath: newTokenPath } : {}),
        ...(newClientId ? { clientId: newClientId } : {}),
      });
      setNewServerUrl("");
      setNewTokenPath("");
      setNewClientId("");
      setConnections(await listMcpConnections());
    } catch (err) {
      setError(getErrorMessage(err, "Could not create the MCP Connection."));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleConnection(entry: McpConnectionSummary): Promise<void> {
    setError(null);
    try {
      await updateMcpConnection(entry.id, { enabled: !entry.enabled });
      setConnections(await listMcpConnections());
    } catch (err) {
      setError(getErrorMessage(err, "Could not update the MCP Connection."));
    }
  }

  async function handleDeleteConnection(id: string): Promise<void> {
    setError(null);
    try {
      await deleteMcpConnection(id);
      setConnections(await listMcpConnections());
      if (selectedConnection === id) {
        setSelectedConnection("");
        setCatalog(null);
        setConsent(undefined);
        setRefresh(null);
      }
    } catch (err) {
      setError(getErrorMessage(err, "Could not delete the MCP Connection."));
    }
  }

  async function handleInspectConnection(id: string): Promise<void> {
    setSelectedConnection(id);
    setDetailLoading(true);
    setError(null);
    try {
      const [nextCatalog, nextConsent] = await Promise.all([listMcpConnectionTools(id), getMcpConnectionConsent(id)]);
      setCatalog(nextCatalog);
      setConsent(nextConsent);
      setRefresh(null);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the Connection catalog."));
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleRefresh(id: string): Promise<void> {
    setDetailLoading(true);
    setError(null);
    try {
      const summary = await refreshMcpConnectionTools(id);
      setRefresh(summary);
      setCatalog(await listMcpConnectionTools(id));
    } catch (err) {
      setError(getErrorMessage(err, "The catalog refresh failed."));
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleToggleCatalogTool(entry: McpCatalogTool): Promise<void> {
    setError(null);
    try {
      await setMcpCatalogToolEnabled(entry.connectionId, entry.toolName, !entry.enabled);
      setCatalog(await listMcpConnectionTools(entry.connectionId));
    } catch (err) {
      setError(getErrorMessage(err, "Could not update the catalog tool."));
    }
  }

  return (
    <section aria-labelledby="tools-mcp-heading">
      <h1 id="tools-mcp-heading">Tools and MCP</h1>
      <p className="muted">
        Author and admin surface over the existing tool and external-MCP routes: Saga tool discovery, pinned contract
        search, MCP server templates, and per-Organization MCP Connections with catalog health. Writes shown here exist
        in the API contract; credential values are never shown or entered on any path.
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
          Loading tools and MCP state…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="alert">
          {error}
        </p>
      ) : null}

      <h2>Enrolled Saga tools</h2>
      <p className="muted">
        Opt-in tool exposure: a Saga becomes callable only through an explicit enrollment. Disabled and stale rows
        vanish from discovery and execution alike.
      </p>
      {tools ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Saga</th>
                  <th scope="col">Description</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tools.tools.map((entry) => (
                  <tr key={entry.name} data-testid="tool-row">
                    <td>
                      <code className="mono">{entry.name}</code>
                    </td>
                    <td>
                      <code className="mono mono--truncate" title={entry.sagaId}>
                        {shortId(entry.sagaId)}
                      </code>{" "}
                      <span className="muted">{entry.sagaRevision}</span>
                    </td>
                    <td>{entry.description}</td>
                    <td>
                      <button type="button" onClick={() => void handleDisable(entry.name)}>
                        Disable
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tools.tools.length === 0 ? <p className="empty-state">No tools enrolled yet.</p> : null}
        </>
      ) : null}
      {sagas && sagas.sagas.length > 0 ? (
        <form className="connection-form" onSubmit={(e) => void handleEnroll(e)}>
          <h2>Enroll a tool</h2>
          <label htmlFor="enrollSaga">Saga</label>
          <select id="enrollSaga" value={enrollSaga} onChange={(e) => setEnrollSaga(e.target.value)}>
            <option value="">{sagas.sagas[0]?.name} (default)</option>
            {sagas.sagas.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {entry.revision}
              </option>
            ))}
          </select>
          <label htmlFor="enrollName">Tool name (optional, derived when blank)</label>
          <input
            id="enrollName"
            name="enrollName"
            type="text"
            autoComplete="off"
            value={enrollName}
            onChange={(e) => setEnrollName(e.target.value)}
            placeholder="hello_tool"
          />
          <label htmlFor="enrollDescription">Description (optional, 1-280 chars)</label>
          <input
            id="enrollDescription"
            name="enrollDescription"
            type="text"
            autoComplete="off"
            value={enrollDescription}
            onChange={(e) => setEnrollDescription(e.target.value)}
            placeholder="Greet warmly."
          />
          <button type="submit" disabled={saving}>
            {saving ? "Enrolling…" : "Enroll"}
          </button>
        </form>
      ) : null}

      <h2>Contract discovery</h2>
      <p className="muted">
        Progressive search over the pinned HaloPSA contract. Read-only here: execution rides POST /api/openapi/execute
        outside this page, under policy and the Organization Connection.
      </p>
      <form className="connection-form" onSubmit={(e) => void handleSearch(e)}>
        <label htmlFor="openapiQuery">Search the pinned contract</label>
        <input
          id="openapiQuery"
          name="openapiQuery"
          type="text"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ticket"
        />
        <button type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {search ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Method</th>
                  <th scope="col">Path</th>
                  <th scope="col">Risk</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {search.operations.map((entry) => (
                  <tr key={entry.operationId} data-testid="openapi-row">
                    <td>
                      <code className="mono">{entry.operationId}</code>
                      {entry.deprecated ? <span className="muted"> · deprecated</span> : null}
                    </td>
                    <td>{entry.method}</td>
                    <td>
                      <code className="mono mono--truncate" title={entry.path}>
                        {entry.path}
                      </code>
                    </td>
                    <td>{entry.risk}</td>
                    <td>
                      <button type="button" onClick={() => void handleInspect(entry.operationId)}>
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {search.operations.length === 0 ? <p className="empty-state">No operations match.</p> : null}
        </>
      ) : null}
      {inspected ? (
        <p className="status-line" data-testid="openapi-detail">
          {inspected.operationId} · {inspected.method} {inspected.path} · {inspected.risk} — {inspected.summary}
        </p>
      ) : null}

      <h2>MCP servers</h2>
      <p className="muted">
        Portable, secretless server templates. Management writes are admin-only; platform-level rows additionally need
        an instance admin.
      </p>
      <label htmlFor="includeInactive">
        <input
          id="includeInactive"
          type="checkbox"
          checked={includeInactive}
          onChange={(e) => {
            setIncludeInactive(e.target.checked);
          }}
        />{" "}
        Include inactive
      </label>
      {servers ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Server</th>
                  <th scope="col">URL</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Flow</th>
                  <th scope="col">State</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {servers.servers.map((entry) => (
                  <tr key={entry.id} data-testid="mcp-server-row">
                    <td>
                      <span className="saga-link">{entry.name}</span>{" "}
                      <code className="mono mono--truncate" title={entry.id}>
                        {shortId(entry.id)}
                      </code>
                    </td>
                    <td>
                      <code className="mono mono--truncate" title={entry.serverUrl}>
                        {entry.serverUrl}
                      </code>
                    </td>
                    <td>{entry.orgId ? "organization" : "platform"}</td>
                    <td>{entry.providerFlow}</td>
                    <td>{entry.isActive ? "active" : "inactive"}</td>
                    <td>
                      <button type="button" onClick={() => void handleToggleServer(entry.id, entry.isActive)}>
                        {entry.isActive ? "Disable" : "Enable"}
                      </button>{" "}
                      <button type="button" onClick={() => void handleDeleteServer(entry.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {servers.servers.length === 0 ? <p className="empty-state">No MCP servers yet.</p> : null}
        </>
      ) : null}
      <form className="connection-form" onSubmit={(e) => void handleCreateServer(e)}>
        <h2>Add an MCP server</h2>
        <label htmlFor="serverName">Name (3-64 chars, lowercase first)</label>
        <input
          id="serverName"
          name="serverName"
          type="text"
          autoComplete="off"
          value={serverName}
          onChange={(e) => setServerName(e.target.value)}
          placeholder="fixture-mcp"
        />
        <label htmlFor="serverUrl">Server URL (absolute http(s), never credential-bearing)</label>
        <input
          id="serverUrl"
          name="serverUrl"
          type="text"
          autoComplete="off"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://…"
        />
        <label htmlFor="serverFlow">Provider flow</label>
        <select id="serverFlow" value={serverFlow} onChange={(e) => setServerFlow(e.target.value)}>
          <option value="none">none</option>
          <option value="authorization_code">authorization_code</option>
          <option value="client_credentials">client_credentials</option>
        </select>
        <button type="submit" disabled={saving || !serverName || !serverUrl}>
          {saving ? "Creating…" : "Create server"}
        </button>
      </form>

      <h2>MCP Connections</h2>
      <p className="muted">
        Per-Organization bindings: flags and identity only. Client secret provisioned renders yes or no — values are
        never shown or entered here. Management writes are admin-only.
      </p>
      {connections ? (
        <>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th scope="col">Server</th>
                  <th scope="col">URL</th>
                  <th scope="col">Client</th>
                  <th scope="col">Availability</th>
                  <th scope="col">State</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.connections.map((entry) => (
                  <tr key={entry.id} data-testid="mcp-connection-row">
                    <td>
                      <span className="saga-link">{entry.serverName}</span>{" "}
                      <code className="mono mono--truncate" title={entry.id}>
                        {shortId(entry.id)}
                      </code>
                    </td>
                    <td>
                      <code className="mono mono--truncate" title={entry.effectiveServerUrl}>
                        {entry.effectiveServerUrl}
                      </code>
                    </td>
                    <td>
                      {entry.clientId ?? <span className="muted">none</span>} ·{" "}
                      {entry.clientSecretProvisioned ? "provisioned" : "not provisioned"}
                    </td>
                    <td>
                      chat {entry.availableInChat ? "yes" : "no"} · autonomous{" "}
                      {entry.availableToAutonomous ? "yes" : "no"}
                    </td>
                    <td>{entry.enabled ? "enabled" : "disabled"}</td>
                    <td>
                      <button type="button" onClick={() => void handleInspectConnection(entry.id)}>
                        Inspect
                      </button>{" "}
                      <button type="button" onClick={() => void handleToggleConnection(entry)}>
                        {entry.enabled ? "Disable" : "Enable"}
                      </button>{" "}
                      <button type="button" onClick={() => void handleDeleteConnection(entry.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {connections.connections.length === 0 ? (
            <p className="empty-state">No MCP Connections for this Organization yet.</p>
          ) : null}
        </>
      ) : null}
      {servers && servers.servers.length > 0 ? (
        <form className="connection-form" onSubmit={(e) => void handleCreateConnection(e)}>
          <h2>Bind a Connection</h2>
          <p className="muted">
            Binds the first listed server template. No secret is accepted here — provisioning happens outside this page.
          </p>
          <label htmlFor="newServerUrl">Server URL override (optional)</label>
          <input
            id="newServerUrl"
            name="newServerUrl"
            type="text"
            autoComplete="off"
            value={newServerUrl}
            onChange={(e) => setNewServerUrl(e.target.value)}
            placeholder="https://…"
          />
          <label htmlFor="newTokenPath">Token path (optional, same-host path)</label>
          <input
            id="newTokenPath"
            name="newTokenPath"
            type="text"
            autoComplete="off"
            value={newTokenPath}
            onChange={(e) => setNewTokenPath(e.target.value)}
            placeholder="/oauth/token"
          />
          <label htmlFor="newClientId">Client ID (optional, public identifier)</label>
          <input
            id="newClientId"
            name="newClientId"
            type="text"
            autoComplete="off"
            value={newClientId}
            onChange={(e) => setNewClientId(e.target.value)}
            placeholder="client id"
          />
          <button type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create Connection"}
          </button>
        </form>
      ) : null}

      {selectedConnection ? (
        <>
          <h2>Connection catalog and health</h2>
          {detailLoading ? (
            <p role="status" className="status-line">
              Loading catalog…
            </p>
          ) : null}
          {refresh ? (
            <p className="status-line" data-testid="mcp-refresh">
              {refresh.total} total · {refresh.enabled} enabled · {refresh.disabled} disabled
            </p>
          ) : null}
          {catalog ? (
            <>
              <div className="table-scroll">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Description</th>
                      <th scope="col">State</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalog.tools.map((entry) => (
                      <tr key={entry.qualifiedName} data-testid="mcp-catalog-row">
                        <td>
                          <code className="mono">{entry.toolName}</code>{" "}
                          <code className="mono mono--truncate" title={entry.qualifiedName}>
                            {shortId(entry.qualifiedName)}
                          </code>
                        </td>
                        <td>{entry.description}</td>
                        <td>
                          {entry.enabled ? "enabled" : "disabled"}
                          {entry.autoDisabledReason ? (
                            <span className="muted" title={entry.autoDisabledReason}>
                              {" "}
                              · auto
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <button type="button" onClick={() => void handleToggleCatalogTool(entry)}>
                            {entry.enabled ? "Disable" : "Enable"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {catalog.tools.length === 0 ? (
                <p className="empty-state">No catalog tools synced for this Connection yet.</p>
              ) : null}
            </>
          ) : null}
          <p>
            <button type="button" onClick={() => void handleRefresh(selectedConnection)}>
              Refresh
            </button>{" "}
            <span className="muted">Syncs the catalog over the service credential (admin-only).</span>
          </p>
          <h2>Consent state</h2>
          <p className="muted">
            Own per-user consent, reported as state only — OAuth consent is not completed from this page.
          </p>
          {consent === undefined ? (
            <p className="empty-state">Select Inspect on a Connection to load consent state.</p>
          ) : consent === null ? (
            <p className="empty-state">No consent recorded for this Connection.</p>
          ) : (
            <p className="status-line" data-testid="mcp-consent">
              scope {consent.scope} · granted {consent.consentGrantedAt} · generation {consent.generation}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
