// SPDX-License-Identifier: AGPL-3.0
// Tool and external MCP administration UI (issue #559): discovery, catalog,
// connection health, and safe management over the existing Worker routes.
// Fixture-backed render + client-guard tests. Secret-free by construction:
// no payload, form, or render here carries a credential value, and the page
// offers no OAuth authorize/callback affordance — consent is state-only.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMcpConnection,
  createMcpServer,
  disableTool,
  enrollTool,
  getMcpConnectionConsent,
  inspectOpenapiOperation,
  listMcpConnections,
  listMcpConnectionTools,
  listMcpServers,
  listTools,
  refreshMcpConnectionTools,
  searchOpenapiOperations,
  setMcpCatalogToolEnabled,
  setMcpServerActive,
  updateMcpConnection,
} from "../client/src/lib/api-client";
import type {
  McpCatalogResponse,
  McpConnectionsResponse,
  McpConsentState,
  McpServersResponse,
  OpenapiSearchResponse,
  SagasResponse,
  ToolsResponse,
} from "../client/src/lib/client-types";
import { ToolsMcp } from "../client/src/pages/ToolsMcp";

const SAGA_ID = "00000000-0000-4000-8000-000000000011";
const SERVER_ID = "00000000-0000-4000-8000-000000000021";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000031";

const toolsPayload: ToolsResponse = {
  tools: [
    {
      name: "hello_tool",
      sagaId: SAGA_ID,
      sagaRevision: "hello-v3",
      description: "[hello_tool] Greet warmly.",
      inputSchema: { type: "object" },
      enabled: true,
    },
  ],
};

const sagasPayload: SagasResponse = {
  sagas: [
    {
      id: SAGA_ID,
      name: "hello",
      revision: "hello-v3",
      description: "Greet warmly.",
      requiredIntegrations: [],
    },
  ],
};

const searchPayload: OpenapiSearchResponse = {
  integration: "halo",
  operations: [
    {
      operationId: "GetTickets",
      method: "get",
      path: "/api/Tickets",
      summary: "List tickets.",
      risk: "read",
      deprecated: false,
    },
    {
      operationId: "DeleteTicket",
      method: "delete",
      path: "/api/Tickets/{id}",
      summary: "Delete a ticket.",
      risk: "mutation",
      deprecated: false,
    },
  ],
};

const serversPayload: McpServersResponse = {
  servers: [
    {
      id: SERVER_ID,
      name: "fixture-mcp",
      serverUrl: "http://localhost:4319/mcp",
      orgId: null,
      providerFlow: "none",
      discoveryMetadata: null,
      isActive: true,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    },
  ],
};

const connectionsPayload: McpConnectionsResponse = {
  connections: [
    {
      id: CONNECTION_ID,
      orgId: "00000000-0000-4000-8000-000000000001",
      serverId: SERVER_ID,
      serverName: "fixture-mcp",
      effectiveServerUrl: "http://localhost:4319/mcp",
      serverUrlOverride: null,
      tokenPath: null,
      clientId: null,
      clientSecretProvisioned: false,
      providerFlow: "none",
      availableInChat: true,
      availableToAutonomous: false,
      enabled: true,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    },
  ],
};

const catalogPayload: McpCatalogResponse = {
  tools: [
    {
      connectionId: CONNECTION_ID,
      toolName: "lookup",
      qualifiedName: `mcp__${CONNECTION_ID}__lookup`,
      description: "Look up a record.",
      inputSchema: { type: "object" },
      enabled: true,
      autoDisabledReason: null,
      syncedAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    },
  ],
};

const consentPayload: McpConsentState = {
  connectionId: CONNECTION_ID,
  userId: "00000000-0000-4000-8000-000000000002",
  orgId: "00000000-0000-4000-8000-000000000001",
  scope: "read",
  consentGrantedAt: "2026-09-17T00:00:00.000Z",
  consentExpiresAt: null,
  generation: 1,
  health: { status: "healthy" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("lists discovery payloads through typed clients with shape guards", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ tools: toolsPayload.tools }))
    .mockResolvedValueOnce(Response.json({ integration: "halo", operations: searchPayload.operations }))
    .mockResolvedValueOnce(Response.json({ operation: searchPayload.operations[0] }))
    .mockResolvedValueOnce(Response.json({ servers: serversPayload.servers }))
    .mockResolvedValueOnce(Response.json({ connections: connectionsPayload.connections }))
    .mockResolvedValueOnce(Response.json({ tools: catalogPayload.tools }))
    .mockResolvedValueOnce(Response.json({ consent: consentPayload }));
  const tools = await listTools();
  expect(tools.tools.map((entry) => entry.name)).toEqual(["hello_tool"]);
  const search = await searchOpenapiOperations("ticket");
  expect(search.operations).toHaveLength(2);
  const inspected = await inspectOpenapiOperation("GetTickets");
  expect(inspected.method).toBe("get");
  const servers = await listMcpServers();
  expect(servers.servers[0]?.name).toBe("fixture-mcp");
  const connections = await listMcpConnections();
  expect(connections.connections[0]?.clientSecretProvisioned).toBe(false);
  const catalog = await listMcpConnectionTools(CONNECTION_ID);
  expect(catalog.tools[0]?.qualifiedName).toContain("mcp__");
  const consent = await getMcpConnectionConsent(CONNECTION_ID);
  expect(consent?.scope).toBe("read");

  // Malformed envelopes fail closed with shape errors, never silent empty.
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ tools: [{ name: 42 }] }));
  await expect(listTools()).rejects.toThrow("tools response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ integration: "halo", operations: [{ op: 1 }] }));
  await expect(searchOpenapiOperations("")).rejects.toThrow("OpenAPI search response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ servers: [{ name: 42 }] }));
  await expect(listMcpServers()).rejects.toThrow("MCP servers response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ connections: [{ id: 42 }] }));
  await expect(listMcpConnections()).rejects.toThrow("MCP connections response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ tools: [{ toolName: 42 }] }));
  await expect(listMcpConnectionTools(CONNECTION_ID)).rejects.toThrow("MCP catalog response shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ consent: { scope: 42 } }));
  await expect(getMcpConnectionConsent(CONNECTION_ID)).rejects.toThrow("MCP consent response shape");
  // Malformed IDs never reach the network.
  await expect(listMcpConnectionTools("nope")).rejects.toThrow("ID shape");
  await expect(getMcpConnectionConsent("nope")).rejects.toThrow("ID shape");
  await expect(inspectOpenapiOperation("bad id!")).rejects.toThrow("operation ID shape");
});

it("runs safe management calls and validates refresh summaries", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ tool: toolsPayload.tools[0] }))
    .mockResolvedValueOnce(Response.json({ tool: { ...toolsPayload.tools[0], enabled: false } }))
    .mockResolvedValueOnce(Response.json({ server: serversPayload.servers[0] }))
    .mockResolvedValueOnce(Response.json({ server: { ...serversPayload.servers[0], isActive: false } }))
    .mockResolvedValueOnce(Response.json({ connection: connectionsPayload.connections[0] }))
    .mockResolvedValueOnce(Response.json({ connection: connectionsPayload.connections[0] }))
    .mockResolvedValueOnce(Response.json({ catalog: { total: 1, enabled: 1, disabled: 0 } }))
    .mockResolvedValueOnce(Response.json({ tool: { ...catalogPayload.tools[0], enabled: false } }));
  const enrolled = await enrollTool({ sagaId: SAGA_ID });
  expect(enrolled.name).toBe("hello_tool");
  const disabled = await disableTool("hello_tool");
  expect(disabled.enabled).toBe(false);
  const server = await createMcpServer({ name: "fixture-mcp", serverUrl: "http://localhost:4319/mcp" });
  expect(server.name).toBe("fixture-mcp");
  const toggled = await setMcpServerActive(SERVER_ID, false);
  expect(toggled.isActive).toBe(false);
  const created = await createMcpConnection({ serverId: SERVER_ID });
  expect(created.serverName).toBe("fixture-mcp");
  const updated = await updateMcpConnection(CONNECTION_ID, { availableInChat: false });
  expect(updated.id).toBe(CONNECTION_ID);
  const refreshed = await refreshMcpConnectionTools(CONNECTION_ID);
  expect(refreshed).toEqual({ total: 1, enabled: 1, disabled: 0 });
  const catalogTool = await setMcpCatalogToolEnabled(CONNECTION_ID, "lookup", false);
  expect(catalogTool.enabled).toBe(false);

  await expect(enrollTool({ sagaId: "nope" })).rejects.toThrow("Saga ID shape");
  await expect(disableTool("Bad Name!")).rejects.toThrow("tool name shape");
  await expect(createMcpConnection({ serverId: "nope" })).rejects.toThrow("ID shape");
  await expect(updateMcpConnection("nope", { enabled: false })).rejects.toThrow("ID shape");
  await expect(refreshMcpConnectionTools("nope")).rejects.toThrow("ID shape");
  await expect(setMcpCatalogToolEnabled(CONNECTION_ID, "bad name!", true)).rejects.toThrow("catalog tool name shape");
  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ catalog: { total: "many" } }));
  await expect(refreshMcpConnectionTools(CONNECTION_ID)).rejects.toThrow("MCP refresh response shape");
});

it("renders discovery, catalog, health, and management without credential values", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ToolsMcp
        initial={{
          tools: toolsPayload,
          sagas: sagasPayload,
          search: searchPayload,
          servers: serversPayload,
          connections: connectionsPayload,
          catalog: catalogPayload,
          refresh: { total: 1, enabled: 1, disabled: 0 },
          consent: consentPayload,
        }}
      />
    </MemoryRouter>,
  );
  // Discovery: enrolled tools, openapi operations, servers, connections, catalog.
  expect(html).toContain("hello_tool");
  expect(html).toContain("GetTickets");
  expect(html).toContain("DeleteTicket");
  expect(html).toContain("fixture-mcp");
  expect(html).toContain("lookup");
  // Health: refresh summary counts, provisioned flag, consent scope.
  expect(html).toContain("1 total");
  expect(html).toContain("not provisioned");
  expect(html).toContain("read");
  // Safe-management affordances exist for contract-backed writes only.
  expect(html).toContain("Enroll");
  expect(html).toContain("Disable");
  expect(html).toContain("Refresh");
  // Consent is state-only: no OAuth authorize/callback affordance, no
  // secret field anywhere.
  expect(html).toContain("consent is not completed from this page");
  expect(html).not.toMatch(/client[_-]?secret/i);
  // The only password field is the standard local-fixture token reload form
  // shared with every admin page — no secret-provisioning field exists.
  expect(html.match(/type="password"/g) ?? []).toHaveLength(1);
  expect(html).not.toContain("apiKey");
  expect(html).not.toContain("client_secret");
  for (const text of [JSON.stringify(toolsPayload), JSON.stringify(connectionsPayload), html]) {
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  }
});
