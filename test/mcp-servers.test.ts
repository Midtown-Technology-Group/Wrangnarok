// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171) S1: portable MCP server templates. Real local
// workerd with a real D1 binding (full harness chain + migration 0041);
// no vendor HTTP exists on this path. Pins secretless CRUD, globally-unique
// names, platform-vs-org visibility with cross-org 404s, soft/hard delete,
// and the allowed/denied caller matrix (instance admin / org admin /
// member / foreign).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const MEMBER_USER = "00000000-0000-4000-8000-000000000003";
const ORG_B = "00000000-0000-4000-8000-000000000004";
const FOREIGN_USER = "00000000-0000-4000-8000-000000000006";
const TOKEN = "a".repeat(64);
const SERVER_URL = "https://mcp-fixture.invalid/mcp";

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

/** Ordinary member of ORG_A: no admin bootstrap — membership resolves from
 * the seeded row. */
function asMember(): Bindings {
  return { ...bindings, LAB_USER_ID: MEMBER_USER, LAB_FIXTURE_USER_ID: USER_ADMIN };
}

/** Stranger in ORG_B: authenticated, but never a member of ORG_A. */
function asForeignOrg(): Bindings {
  return { ...bindings, LAB_ORG_ID: ORG_B, LAB_USER_ID: FOREIGN_USER };
}

/** Instance admin: the LAB fixture identity on the deployment admin list. */
function asInstanceAdmin(): Bindings {
  return { ...bindings, LAB_USER_ID: USER_ADMIN, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: USER_ADMIN };
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

async function createServer(
  body: Record<string, unknown>,
  env: Bindings = bindings,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(call("/api/mcp-servers", "POST", body), env);
  return { status: response.status, body: await jsonOf(response) };
}

describe("MCP server templates (TOOL-02 S1)", () => {
  it("instance admin creates a platform template; members read, never secrets", async () => {
    const { status, body } = await createServer(
      { name: "fixture-platform", serverUrl: SERVER_URL, providerFlow: "authorization_code" },
      asInstanceAdmin(),
    );
    expect(status).toBe(201);
    const server = body.server as Record<string, unknown>;
    expect(server.name).toBe("fixture-platform");
    expect(server.orgId).toBeNull();
    expect(server.isActive).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret");

    const listed = await worker.fetch(call("/api/mcp-servers"), asMember());
    expect(listed.status).toBe(200);
    const listedBody = await jsonOf(listed);
    const servers = listedBody.servers as { name: string }[];
    expect(servers.map((entry) => entry.name)).toContain("fixture-platform");
  });

  it("org admin creates an org template; members of other orgs get 404", async () => {
    const { status, body } = await createServer({
      name: "fixture-org",
      serverUrl: SERVER_URL,
      providerFlow: "client_credentials",
      orgId: ORG_A,
    });
    expect(status).toBe(201);
    const server = body.server as { id: string; orgId: string };
    expect(server.orgId).toBe(ORG_A);

    const foreign = await worker.fetch(call(`/api/mcp-servers/${server.id}`), asForeignOrg());
    expect(foreign.status).toBe(404);
    const foreignList = await jsonOf(await worker.fetch(call("/api/mcp-servers"), asForeignOrg()));
    expect((foreignList.servers as unknown[]).map((entry) => (entry as { name: string }).name)).not.toContain(
      "fixture-org",
    );
  });

  it("denies the caller matrix on create: member 403, platform needs instance admin", async () => {
    const member = await createServer(
      { name: "member-attempt", serverUrl: SERVER_URL, providerFlow: "none", orgId: ORG_A },
      asMember(),
    );
    expect(member.status).toBe(403);

    const orgAdminPlatform = await createServer({
      name: "platform-attempt",
      serverUrl: SERVER_URL,
      providerFlow: "none",
    });
    expect(orgAdminPlatform.status).toBe(403);
    expect((orgAdminPlatform.body.error as { code: string }).code).toBe("MCP_ADMIN_ONLY");
  });

  it("rejects duplicate names globally, secret-shaped bodies, and bad URLs", async () => {
    const first = await createServer(
      { name: "fixture-dup", serverUrl: SERVER_URL, providerFlow: "none", orgId: ORG_A },
      bindings,
    );
    expect(first.status).toBe(201);
    const second = await createServer(
      { name: "fixture-dup", serverUrl: SERVER_URL, providerFlow: "none" },
      asInstanceAdmin(),
    );
    expect(second.status).toBe(409);
    expect((second.body.error as { code: string }).code).toBe("MCP_SERVER_EXISTS");

    const secretShaped = await createServer(
      { name: "fixture-secret", serverUrl: SERVER_URL, providerFlow: "none", clientSecret: "nope" },
      asInstanceAdmin(),
    );
    expect(secretShaped.status).toBe(400);

    for (const serverUrl of [
      "http://public-fixture.invalid/mcp",
      "https://user:pass@mcp-fixture.invalid/",
      "garbage",
    ]) {
      const bad = await createServer(
        { name: `bad-${Math.random().toString(36).slice(2, 8)}`, serverUrl, providerFlow: "none" },
        asInstanceAdmin(),
      );
      expect(bad.status).toBe(400);
    }
  });

  it("updates URL/flow/metadata but never name or org scope", async () => {
    const created = await createServer(
      { name: "fixture-mutable", serverUrl: SERVER_URL, providerFlow: "none", orgId: ORG_A },
      bindings,
    );
    const id = (created.body.server as { id: string }).id;
    const updated = await worker.fetch(
      call(`/api/mcp-servers/${id}`, "POST", {
        serverUrl: "https://mcp-two.invalid/mcp",
        providerFlow: "client_credentials",
      }),
      bindings,
    );
    expect(updated.status).toBe(200);
    const view = (await jsonOf(updated)).server as Record<string, unknown>;
    expect(view.serverUrl).toBe("https://mcp-two.invalid/mcp");
    expect(view.providerFlow).toBe("client_credentials");

    const renamed = await worker.fetch(call(`/api/mcp-servers/${id}`, "POST", { name: "hijack" }), bindings);
    expect(renamed.status).toBe(400);
  });

  it("disable hides from discovery and blocks binding; enable restores", async () => {
    const created = await createServer(
      { name: "fixture-toggle", serverUrl: SERVER_URL, providerFlow: "none", orgId: ORG_A },
      bindings,
    );
    const id = (created.body.server as { id: string }).id;
    const disabled = await worker.fetch(call(`/api/mcp-servers/${id}/disable`, "POST"), bindings);
    expect(disabled.status).toBe(200);

    const hidden = await worker.fetch(call(`/api/mcp-servers/${id}`), bindings);
    expect(hidden.status).toBe(404);
    const shown = await jsonOf(await worker.fetch(call(`/api/mcp-servers/${id}?include_inactive=1`), bindings));
    expect((shown.server as { isActive: boolean }).isActive).toBe(false);

    const bind = await worker.fetch(call("/api/mcp-connections", "POST", { serverId: id }), bindings);
    expect(bind.status).toBe(409);

    const enabled = await worker.fetch(call(`/api/mcp-servers/${id}/enable`, "POST"), bindings);
    expect(enabled.status).toBe(200);
    expect(((await jsonOf(enabled)).server as { isActive: boolean }).isActive).toBe(true);
  });

  it("soft delete deactivates; hard delete cascades connections", async () => {
    const created = await createServer(
      { name: "fixture-drop", serverUrl: SERVER_URL, providerFlow: "none", orgId: ORG_A },
      bindings,
    );
    const id = (created.body.server as { id: string }).id;
    const bound = await worker.fetch(call("/api/mcp-connections", "POST", { serverId: id }), bindings);
    expect(bound.status).toBe(201);

    const soft = await worker.fetch(call(`/api/mcp-servers/${id}`, "DELETE"), bindings);
    expect(soft.status).toBe(200);
    const remaining = await bindings.DB.prepare("SELECT id FROM mcp_connections WHERE server_id=?").bind(id).all();
    expect(remaining.results.length).toBe(1);

    const hardDenied = await worker.fetch(call(`/api/mcp-servers/${id}?hard=true`, "DELETE"), bindings);
    expect(hardDenied.status).toBe(403);

    const hard = await worker.fetch(call(`/api/mcp-servers/${id}?hard=true`, "DELETE"), asInstanceAdmin());
    expect(hard.status).toBe(200);
    const gone = await bindings.DB.prepare("SELECT id FROM mcp_connections WHERE server_id=?").bind(id).all();
    expect(gone.results.length).toBe(0);
  });

  it("rejects unknown query strings and gray-outs malformed ids", async () => {
    const badQuery = await worker.fetch(call("/api/mcp-servers?nope=1"), bindings);
    expect(badQuery.status).toBe(400);
    // Non-UUID ids match no route matcher: the gray-out answers 501
    // UNIMPLEMENTED (the CON-01 posture), never a leak.
    const malformed = await worker.fetch(call("/api/mcp-servers/not-a-uuid"), bindings);
    expect(malformed.status).toBe(501);
    expect(((await jsonOf(malformed)).error as { code: string }).code).toBe("UNIMPLEMENTED");
  });
});
