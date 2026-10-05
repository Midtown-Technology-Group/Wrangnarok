// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171) S1+S3: org MCP Connections plus the per-Connection
// tool catalog. Real local workerd with a real D1 binding (full harness
// chain + migration 0041); catalog sync runs against inline payloads, so
// no vendor HTTP exists on this path. Pins one-Connection-per-(server,
// org), flag/override/token-path validation, client-secret envelopes with
// ciphertext-only D1, verbatim schemas, drift rules (auto-disable with
// timestamped reason, manual-disable survival, restore), and the
// allowed/denied caller matrix.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { planCatalogSync, qualifiedMcpToolName } from "../src/mcp-catalog";
import type { McpCatalogRow } from "../src/mcp-catalog";
import { useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const MEMBER_USER = "00000000-0000-4000-8000-000000000003";
const ORG_B = "00000000-0000-4000-8000-000000000004";
const FOREIGN_USER = "00000000-0000-4000-8000-000000000006";
const TOKEN = "a".repeat(64);
const SERVER_URL = "https://mcp-fixture.invalid/mcp";
const CLIENT_SECRET = "test-mcp-client-secret-alpha";

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

function call(path: string, method = "GET", body?: unknown) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function jsonOf(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function asMember(): Bindings {
  return { ...bindings, LAB_USER_ID: MEMBER_USER, LAB_FIXTURE_USER_ID: USER_ADMIN };
}

function asForeignOrg(): Bindings {
  return { ...bindings, LAB_ORG_ID: ORG_B, LAB_USER_ID: FOREIGN_USER };
}

useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await bindings.DB.prepare("DELETE FROM mcp_tool_catalog").run();
    await bindings.DB.prepare("DELETE FROM mcp_user_consents").run();
    await bindings.DB.prepare("DELETE FROM mcp_service_tokens").run();
    await bindings.DB.prepare("DELETE FROM mcp_connections").run();
    await bindings.DB.prepare("DELETE FROM mcp_server_templates").run();
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind(ORG_B, "Org B")
      .run();
    const now = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?) ON CONFLICT DO NOTHING",
    )
      .bind(MEMBER_USER, now)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'member','active','ordinary',?,?) ON CONFLICT DO NOTHING",
    )
      .bind(ORG_A, MEMBER_USER, now, now)
      .run();
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedTemplate(name: string, flow = "authorization_code"): Promise<string> {
  const response = await worker.fetch(
    call("/api/mcp-servers", "POST", { name, serverUrl: SERVER_URL, providerFlow: flow, orgId: ORG_A }),
    bindings,
  );
  expect(response.status).toBe(201);
  return ((await jsonOf(response)).server as { id: string }).id;
}

async function seedConnection(
  serverId: string,
  body: Record<string, unknown> = {},
  env: Bindings = bindings,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(call("/api/mcp-connections", "POST", { serverId, ...body }), env);
  return { status: response.status, body: await jsonOf(response) };
}

describe("MCP Connections (TOOL-02 S1)", () => {
  it("binds one Connection per (server, org) with flags, override, and client id", async () => {
    const serverId = await seedTemplate("conn-basic");
    const { status, body } = await seedConnection(serverId, {
      availableInChat: true,
      clientId: "test-client",
      tokenPath: "/oauth/token",
    });
    expect(status).toBe(201);
    const view = body.connection as Record<string, unknown>;
    expect(view.availableInChat).toBe(true);
    expect(view.availableToAutonomous).toBe(false);
    expect(view.clientId).toBe("test-client");
    expect(view.clientSecretProvisioned).toBe(false);
    expect(view.effectiveServerUrl).toBe(SERVER_URL);

    const again = await seedConnection(serverId);
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe("MCP_CONNECTION_EXISTS");
  });

  it("denies member writes, foreign reads, and unknown servers", async () => {
    const serverId = await seedTemplate("conn-gates");
    const member = await seedConnection(serverId, {}, asMember());
    expect(member.status).toBe(403);

    const created = await seedConnection(serverId);
    const id = (created.body.connection as { id: string }).id;
    const foreign = await worker.fetch(call(`/api/mcp-connections/${id}`), asForeignOrg());
    expect(foreign.status).toBe(404);

    const unknown = await seedConnection("00000000-0000-4000-8000-00000000ffff");
    expect(unknown.status).toBe(404);
  });

  it("provisions the client secret as envelope ciphertext, never in views", async () => {
    const serverId = await seedTemplate("conn-secret");
    const id = ((await seedConnection(serverId)).body.connection as { id: string }).id;
    const stored = await worker.fetch(
      call(`/api/mcp-connections/${id}/client-secret`, "PUT", { secret: CLIENT_SECRET }),
      bindings,
    );
    expect(stored.status).toBe(200);
    const view = (await jsonOf(stored)).connection as Record<string, unknown>;
    expect(view.clientSecretProvisioned).toBe(true);

    const rows = await bindings.DB.prepare("SELECT ciphertext FROM mcp_connection_secrets WHERE connection_id=?")
      .bind(id)
      .all<{ ciphertext: string }>();
    expect(rows.results.length).toBe(1);
    expect(JSON.stringify(rows.results)).not.toContain(CLIENT_SECRET);

    const listed = (await jsonOf(await worker.fetch(call("/api/mcp-connections"), bindings))).connections as Record<
      string,
      unknown
    >[];
    expect(JSON.stringify(listed)).not.toContain(CLIENT_SECRET);
  });

  it("updates flags and override; the bound template never moves; delete cascades", async () => {
    const first = await seedTemplate("conn-first");
    const second = await seedTemplate("conn-second");
    const id = ((await seedConnection(first)).body.connection as { id: string }).id;
    const updated = await worker.fetch(
      call(`/api/mcp-connections/${id}`, "POST", {
        serverUrlOverride: "https://mcp-override.invalid/mcp",
        availableToAutonomous: true,
        serverId: second,
      }),
      bindings,
    );
    expect(updated.status).toBe(400);
    const flags = await worker.fetch(
      call(`/api/mcp-connections/${id}`, "POST", {
        serverUrlOverride: "https://mcp-override.invalid/mcp",
        availableToAutonomous: true,
      }),
      bindings,
    );
    expect(flags.status).toBe(200);
    const view = (await jsonOf(flags)).connection as Record<string, unknown>;
    expect(view.effectiveServerUrl).toBe("https://mcp-override.invalid/mcp");
    expect(view.availableToAutonomous).toBe(true);
    expect(view.serverId).toBe(first);

    const dropped = await worker.fetch(call(`/api/mcp-connections/${id}`, "DELETE"), bindings);
    expect(dropped.status).toBe(200);
    const reread = await worker.fetch(call(`/api/mcp-connections/${id}`), bindings);
    expect(reread.status).toBe(404);
  });
});

describe("MCP tool catalog (TOOL-02 drift rules)", () => {
  async function seedCatalog(connectionId: string, payload: unknown) {
    const { syncMcpCatalog } = await import("../src/mcp-catalog");
    return syncMcpCatalog(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, connectionId, payload);
  }

  it("sync inserts arrivals enabled, auto-disables vanished rows with reasons, restores returns", async () => {
    const serverId = await seedTemplate("catalog-drift");
    const id = ((await seedConnection(serverId)).body.connection as { id: string }).id;
    const first = await seedCatalog(id, {
      tools: [
        { name: "search", description: "Search things.", inputSchema: { type: "object" } },
        { name: "execute", input_schema: { type: "object" } },
      ],
    });
    expect(first).toMatchObject({ total: 2, enabled: 2, disabled: 0 });

    const second = await seedCatalog(id, { tools: [{ name: "search" }] });
    expect(second).toMatchObject({ total: 2, enabled: 1, disabled: 1 });
    const listed = (await jsonOf(await worker.fetch(call(`/api/mcp-connections/${id}/tools`), bindings))).tools as {
      toolName: string;
      enabled: boolean;
      autoDisabledReason: string | null;
      inputSchema: unknown;
    }[];
    const execute = listed.find((entry) => entry.toolName === "execute");
    expect(execute?.enabled).toBe(false);
    expect(execute?.autoDisabledReason).toContain("Removed from server catalog at ");
    // Verbatim schemas survive the round trip.
    expect(listed.find((entry) => entry.toolName === "search")?.inputSchema).toEqual({ type: "object" });

    const third = await seedCatalog(id, { tools: [{ name: "search" }, { name: "execute" }] });
    expect(third).toMatchObject({ total: 2, enabled: 2, disabled: 0 });
  });

  it("manual disables survive sync; duplicate vendor names fail loud", async () => {
    const serverId = await seedTemplate("catalog-manual");
    const id = ((await seedConnection(serverId)).body.connection as { id: string }).id;
    await seedCatalog(id, { tools: [{ name: "keep" }, { name: "drop" }] });
    const toggled = await worker.fetch(call(`/api/mcp-connections/${id}/tools/keep/disable`, "POST"), bindings);
    expect(toggled.status).toBe(200);
    await seedCatalog(id, { tools: [{ name: "keep" }, { name: "drop" }] });
    const listed = (await jsonOf(await worker.fetch(call(`/api/mcp-connections/${id}/tools`), bindings))).tools as {
      toolName: string;
      enabled: boolean;
      autoDisabledReason: string | null;
    }[];
    const keep = listed.find((entry) => entry.toolName === "keep");
    expect(keep?.enabled).toBe(false);
    expect(keep?.autoDisabledReason).toBe("Manually disabled by admin");

    const dup = seedCatalog(id, { tools: [{ name: "x" }, { name: "x" }] });
    await expect(dup).rejects.toMatchObject({ code: "MCP_CATALOG_INVALID" });
  });

  it("disabled tools deny dispatch-shaped resolution with the reason; unknown tools 404", async () => {
    const { resolveMcpCatalogTool } = await import("../src/mcp-catalog");
    const serverId = await seedTemplate("catalog-deny");
    const id = ((await seedConnection(serverId)).body.connection as { id: string }).id;
    await seedCatalog(id, { tools: [{ name: "gone" }] });
    await worker.fetch(call(`/api/mcp-connections/${id}/tools/gone/disable`, "POST"), bindings);
    const denied = resolveMcpCatalogTool(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, id, "gone");
    await expect(denied).rejects.toMatchObject({ code: "MCP_TOOL_DISABLED" });
    const unknown = resolveMcpCatalogTool(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, id, "nope");
    await expect(unknown).rejects.toMatchObject({ code: "MCP_TOOL_UNKNOWN" });
  });

  it("qualified names stay disjoint per Connection; malformed names route elsewhere", async () => {
    const connA = "11111111-1111-4111-8111-111111111111";
    const connB = "22222222-2222-4222-8222-222222222222";
    expect(qualifiedMcpToolName(connA, "search")).toBe(`mcp__${connA}__search`);
    expect(qualifiedMcpToolName(connA, "search")).not.toBe(qualifiedMcpToolName(connB, "search"));
    const { parseQualifiedMcpToolName } = await import("../src/mcp-catalog");
    expect(parseQualifiedMcpToolName(`mcp__${connA}__search`)).toEqual({ connectionId: connA, tool: "search" });
    expect(parseQualifiedMcpToolName("mcp__not-a-uuid__search")).toBeNull();
    expect(parseQualifiedMcpToolName("plain_tool")).toBeNull();
    expect(parseQualifiedMcpToolName(`mcp__${connA}__`)).toBeNull();
  });

  it("sync planner is pure: manual rows absent from every list", async () => {
    const existing: McpCatalogRow[] = [
      {
        connection_id: "c",
        tool_name: "manual",
        description: null,
        schema_json: "{}",
        enabled: 0,
        auto_disabled_reason: null,
        synced_at: "t",
        updated_at: "t",
      },
    ];
    const plan = planCatalogSync(existing, [{ name: "manual" }], "c", "now");
    expect(plan.insert).toEqual([]);
    expect(plan.restore).toEqual([]);
    expect(plan.autoDisable).toEqual([]);
  });
});
