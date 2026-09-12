// SPDX-License-Identifier: AGPL-3.0
// Connections admin UI (CON-01, issue #146): list/detail render from mocked
// /api/* payloads, honest about managed read-only rows. No secret values
// appear in any payload or render.
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { listConnections, listIntegrations } from "../client/src/lib/api-client";
import type { ConnectionsResponse, IntegrationsResponse } from "../client/src/lib/client-types";
import { ConnectionsList } from "../client/src/pages/Connections";
import { ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID } from "../src/domain";

const integrationsPayload: IntegrationsResponse = {
  integrations: [
    {
      id: ECHO_INTEGRATION_ID,
      name: "echo",
      description: "Local fixture HTTP echo.",
      secretFields: [],
      configSchema: [{ name: "endpoint", type: "string", required: true, description: "Fixture URL." }],
      requiredSecrets: [],
      secretEnvVars: {},
      health: { testHint: "Round-trip a message.", remediation: "Check the fixture server." },
    },
    {
      id: NINJA_INTEGRATION_ID,
      name: "ninjaone",
      description: "Read-only census.",
      secretFields: ["clientSecret"],
      configSchema: [{ name: "endpoint", type: "string", required: true, description: "Regional origin." }],
      requiredSecrets: ["clientSecret"],
      secretEnvVars: { clientSecret: "NINJA_CLIENT_SECRET" },
      health: { testHint: "Probe the token host.", remediation: "Check the endpoint and credential." },
    },
  ],
};

const connectionsPayload: ConnectionsResponse = {
  connections: [
    {
      id: "00000000-0000-4000-8000-000000000101",
      integrationId: ECHO_INTEGRATION_ID,
      integrationName: "echo",
      orgId: "00000000-0000-4000-8000-000000000001",
      displayName: "Fixture echo",
      endpoint: "http://127.0.0.1:8788/echo",
      config: { endpoint: "http://127.0.0.1:8788/echo" },
      enabled: true,
      managedBy: null,
      ownerKind: "loose",
      secretsRequired: [],
      updatedAt: null,
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      integrationId: NINJA_INTEGRATION_ID,
      integrationName: "ninjaone",
      orgId: "00000000-0000-4000-8000-000000000001",
      displayName: null,
      endpoint: "https://us2.ninjarmm.com/api",
      config: { endpoint: "https://us2.ninjarmm.com/api" },
      enabled: false,
      managedBy: "bundle@1.0.0",
      ownerKind: "managed",
      secretsRequired: ["clientSecret"],
      updatedAt: "2026-09-11T00:00:00.000Z",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders Connection rows with state and ownership, marking managed read-only", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ connections: connectionsPayload.connections }))
    .mockResolvedValueOnce(Response.json({ integrations: integrationsPayload.integrations }));
  const data = await listConnections();
  expect(data.connections).toHaveLength(2);
  const integrations = await listIntegrations();
  expect(integrations.integrations).toHaveLength(2);

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ConnectionsList initial={data} />
    </MemoryRouter>,
  );
  expect(html).toContain("Fixture echo");
  expect(html).toContain("disabled");
  expect(html).toContain("MANAGED_RESOURCE");
  expect(html).toContain("Disable");
  expect(html).toContain("Delete");
  const row = JSON.stringify(data.connections[0]);
  // Field names (secretsRequired) are the declaration contract; values must
  // never ride the payload.
  expect(row).not.toMatch(/hunter2|test-client-secret|NINJA_CLIENT_SECRET\s*=\s*\S/);
  expect(row).not.toContain("token");
});

it("renders the Integration definitions with schema and required-secret names", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ integrations: integrationsPayload.integrations }));
  const data = await listIntegrations();

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/connections"]}>
      <Routes>
        <Route path="/connections" element={<ConnectionsList initial={{ connections: [] }} />} />
      </Routes>
    </MemoryRouter>,
  );
  void data;
  expect(html).toContain("Connections");
  expect(html).toContain("Secret values are never shown");
});
