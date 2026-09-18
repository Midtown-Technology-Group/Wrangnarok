// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171) branch coverage: edge, validation, tamper, and
// failure-path branches across the MCP modules plus the remaining route
// arms. Two setups: a table-less D1 binding pins the pre-migration 503
// gates and absence reads (hand-built, no harness — applying the full
// chain would mask the gates), and the full harness chain pins
// module-level validation, envelope tamper, generation races, transport
// faults, and the leftover route arms. Only vendor HTTP is stubbed.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { ENVELOPE_KEY_VERSION } from "../src/envelope";
import { Fault } from "../src/domain";
import {
  createMcpServerTemplate,
  deleteMcpServerTemplate,
  getMcpServerTemplate,
  listMcpServerTemplates,
  parseMcpProviderFlow,
  parseMcpServerUrl,
  parseMcpTemplateName,
  resolveBindableTemplate,
  setMcpServerTemplateActive,
  updateMcpServerTemplate,
  type McpTemplateWrite,
} from "../src/mcp-servers";
import {
  createMcpConnection,
  deleteMcpConnection,
  getMcpConnection,
  listMcpConnections,
  parseMcpTokenPath,
  putMcpConnectionClientSecret,
  resolveDispatchConnection,
  resolveMcpConnectionClientSecret,
  updateMcpConnection,
  type McpConnectionWrite,
} from "../src/mcp-connections";
import {
  listMcpCatalog,
  manualDisableReason,
  mcpToolDescription,
  normalizeMcpInputSchema,
  parseDiscoveredTools,
  parseQualifiedMcpToolName,
  planCatalogSync,
  qualifiedMcpToolName,
  resolveMcpCatalogTool,
  setMcpCatalogToolEnabled,
  syncMcpCatalog,
  vendorToolNamePattern,
} from "../src/mcp-catalog";
import {
  disconnectMcpServiceCredential,
  disconnectMcpUserConsent,
  loadMcpServiceToken,
  loadMcpUserConsent,
  readMcpServiceTokenState,
  readMcpUserConsent,
  recordMcpServiceTokenOutcome,
  recordMcpUserConsentOutcome,
  replaceMcpServiceToken,
  replaceMcpUserConsentToken,
  storeInitialMcpServiceToken,
  storeInitialMcpUserConsent,
} from "../src/mcp-tokens";
import {
  authorizeMcpUserConsent,
  completeMcpUserConsent,
  connectMcpServiceCredential,
  disconnectMcpUserConsentSelf,
} from "../src/mcp-consent";
import {
  assertMcpEndpoint,
  dispatchMcpTool,
  isMcpAuthMarker,
  listMcpToolsRemote,
  postMcpRpc,
  readBoundedMcpBody,
} from "../src/mcp-dispatch";
import { useWorkflowHarness } from "./helpers/workflow-harness";

const bindings = env as unknown as Bindings;
const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000004";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const MEMBER_USER = "00000000-0000-4000-8000-000000000003";
const TOKEN = "a".repeat(64);
const KEK = "test-secrets-kek-sentinel-fixture-only";
const SERVER_URL = "https://mcp-fixture.invalid/mcp";
const TOKEN_PATH = "/oauth/token";
const AUTHORIZE_ENDPOINT = "https://login-fixture.invalid/authorize";
const REDIRECT_URI = "http://localhost:3000/callback";
const CLIENT_ID = "test-mcp-client-id";
const CLIENT_SECRET = "test-mcp-client-secret";
const PRINCIPAL = { orgId: ORG_A, userId: USER_ADMIN };
const ADMIN = { isInstanceAdmin: true };
const AT = "2026-09-18T00:00:00.000Z";

function codeOf(error: unknown): string {
  return error instanceof Fault ? error.code : `threw:${String(error)}`;
}

// File-level harness: full chain plus migration 0041 for every test. The
// pre-migration suite drops the MCP tables in its own describe-scoped
// beforeEach (which runs after this hook) to pin the 503 gates.
useWorkflowHarness(bindings.DB, {
  setup: async () => {
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

describe("MCP pre-migration gates (table-less D1)", () => {
  beforeEach(async () => {
    for (const table of [
      "mcp_tool_catalog",
      "mcp_user_consents",
      "mcp_service_tokens",
      "mcp_connection_secrets",
      "mcp_connections",
      "mcp_server_templates",
    ]) {
      await bindings.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  it("writes fail closed with MCP_STORE_NOT_MIGRATED; reads answer absence", async () => {
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "x",
        serverUrl: SERVER_URL,
        providerFlow: "none",
      }),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      updateMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, "11111111-1111-4111-8111-111111111111", {}),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      setMcpServerTemplateActive(bindings.DB, PRINCIPAL, ADMIN, "11111111-1111-4111-8111-111111111111", false),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      deleteMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, "11111111-1111-4111-8111-111111111111", false),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      createMcpConnection(bindings.DB, PRINCIPAL, { serverId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      updateMcpConnection(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111", {}),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      deleteMcpConnection(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111", "s", KEK),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      storeInitialMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: "c",
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      storeInitialMcpUserConsent(bindings.DB, {
        orgId: ORG_A,
        connectionId: "c",
        userId: "u",
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      replaceMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: "c",
        expectedGeneration: 1,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      replaceMcpUserConsentToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: "c",
        userId: "u",
        expectedGeneration: 1,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      recordMcpServiceTokenOutcome(bindings.DB, ORG_A, "c", { kind: "success" }, AT, 1),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    await expect(
      recordMcpUserConsentOutcome(bindings.DB, ORG_A, "c", "u", { kind: "success" }, AT, 1),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
    expect(await listMcpServerTemplates(bindings.DB, PRINCIPAL)).toEqual([]);
    expect(await listMcpConnections(bindings.DB, PRINCIPAL)).toEqual([]);
    expect(await readMcpServiceTokenState(bindings.DB, ORG_A, "c")).toBeNull();
    expect(await loadMcpServiceToken(bindings.DB, ORG_A, "c", { [ENVELOPE_KEY_VERSION]: KEK })).toBeNull();
    expect(await readMcpUserConsent(bindings.DB, ORG_A, "c", "u")).toBeNull();
    expect(await loadMcpUserConsent(bindings.DB, ORG_A, "c", "u", { [ENVELOPE_KEY_VERSION]: KEK })).toBeNull();
    expect(await resolveMcpConnectionClientSecret(bindings.DB, ORG_A, "c", { [ENVELOPE_KEY_VERSION]: KEK })).toBeNull();
    await expect(
      getMcpServerTemplate(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(
      resolveBindableTemplate(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    expect(await disconnectMcpServiceCredential(bindings.DB, ORG_A, "c")).toEqual({ disconnected: true });
    expect(await disconnectMcpUserConsent(bindings.DB, ORG_A, "c", "u")).toEqual({ disconnected: true });
    await expect(
      resolveDispatchConnection(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(
      resolveMcpCatalogTool(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111", "tool"),
    ).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(listMcpCatalog(bindings.DB, PRINCIPAL, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
  });
});

describe("MCP module validation branches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("template validators reject every malformed shape", () => {
    for (const name of [undefined, "", "AB", "a", "a".repeat(65), "has space", "-lead"]) {
      expect(codeOf(catchSync(() => parseMcpTemplateName(name)))).toBe("INVALID_MCP_SERVER");
    }
    expect(parseMcpTemplateName("good-name_1")).toBe("good-name_1");
    for (const url of [
      undefined,
      "",
      "garbage",
      "ftp://h/x",
      "https://user:pw@mcp-fixture.invalid/",
      "http://public.invalid/x",
      "https://1.2.3.4/x",
      "https://[::1]/x",
      "https://localhost:1/x",
    ]) {
      expect(codeOf(catchSync(() => parseMcpServerUrl(url)))).toBe("INVALID_MCP_SERVER");
    }
    expect(parseMcpServerUrl("http://localhost:8787/mcp")).toBe("http://localhost:8787/mcp");
    expect(codeOf(catchSync(() => parseMcpProviderFlow("oauth2")))).toBe("INVALID_MCP_SERVER");
    expect(parseMcpProviderFlow("none")).toBe("none");
    expect(codeOf(catchSync(() => parseMcpTokenPath("//evil/x")))).toBe("INVALID_MCP_CONNECTION");
    expect(codeOf(catchSync(() => parseMcpTokenPath("relative")))).toBe("INVALID_MCP_CONNECTION");
    expect(parseMcpTokenPath(null)).toBeNull();
  });

  it("template writes validate bodies, scope, and identity", async () => {
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, null as unknown as McpTemplateWrite),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_SERVER",
    });
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "branch-x",
        serverUrl: SERVER_URL,
        providerFlow: "none",
        orgId: "nope",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_SERVER",
    });
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "branch-x",
        serverUrl: SERVER_URL,
        providerFlow: "none",
        orgId: ORG_B,
      }),
    ).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(
      createMcpServerTemplate(
        bindings.DB,
        PRINCIPAL,
        { isInstanceAdmin: false },
        { name: "branch-x", serverUrl: SERVER_URL, providerFlow: "none" },
      ),
    ).rejects.toMatchObject({
      code: "MCP_ADMIN_ONLY",
    });
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "n",
        serverUrl: SERVER_URL,
        providerFlow: "none",
        discoveryMetadata: [1],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_SERVER",
    });
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "n",
        serverUrl: SERVER_URL,
        providerFlow: "none",
        discoveryMetadata: { big: "x".repeat(5000) },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_SERVER",
    });
    await expect(getMcpServerTemplate(bindings.DB, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(
      getMcpServerTemplate(bindings.DB, PRINCIPAL, "00000000-0000-4000-8000-00000000ffff"),
    ).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(updateMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, "not-a-uuid", {})).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(
      updateMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, "00000000-0000-4000-8000-00000000ffff", {}),
    ).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    const created = await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
      name: "branch-one",
      serverUrl: SERVER_URL,
      providerFlow: "none",
      orgId: ORG_A,
    });
    await expect(
      updateMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, created.id, null as unknown as McpTemplateWrite),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_SERVER",
    });
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "branch-meta",
        serverUrl: SERVER_URL,
        providerFlow: "none",
        discoveryMetadata: "nope",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_SERVER" });
    const meta = await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
      name: "branch-meta-ok",
      serverUrl: SERVER_URL,
      providerFlow: "none",
      discoveryMetadata: { vendor: "fixture" },
    });
    expect(meta.discoveryMetadata).toEqual({ vendor: "fixture" });
    await expect(
      deleteMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, "00000000-0000-4000-8000-00000000ffff"),
    ).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(setMcpServerTemplateActive(bindings.DB, PRINCIPAL, ADMIN, "not-a-uuid", true)).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(deleteMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, "not-a-uuid", false)).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    await expect(resolveBindableTemplate(bindings.DB, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    // Corrupt discovery JSON degrades to null in views, never a crash.
    await bindings.DB.prepare("UPDATE mcp_server_templates SET discovery_metadata='{' WHERE id=?")
      .bind(created.id)
      .run();
    expect((await getMcpServerTemplate(bindings.DB, PRINCIPAL, created.id, true)).discoveryMetadata).toBeNull();
  });

  it("connection writes validate every field and identity", async () => {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "branch-conn",
        serverUrl: SERVER_URL,
        providerFlow: "authorization_code",
        orgId: ORG_A,
      })
    ).id;
    await expect(
      createMcpConnection(bindings.DB, PRINCIPAL, null as unknown as McpConnectionWrite),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    await expect(
      createMcpConnection(bindings.DB, PRINCIPAL, { serverId, bogus: 1 } as unknown as McpConnectionWrite),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    await expect(
      createMcpConnection(bindings.DB, PRINCIPAL, { serverId, availableInChat: "yes" }),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    await expect(createMcpConnection(bindings.DB, PRINCIPAL, { serverId, clientId: "" })).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    await expect(
      createMcpConnection(bindings.DB, PRINCIPAL, { serverId, tokenPath: "relative" }),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    await expect(updateMcpConnection(bindings.DB, PRINCIPAL, "not-a-uuid", {})).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(
      updateMcpConnection(bindings.DB, PRINCIPAL, "00000000-0000-4000-8000-00000000ffff", {}),
    ).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(
      updateMcpConnection(bindings.DB, PRINCIPAL, serverId, null as unknown as McpConnectionWrite),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    const id = (await createMcpConnection(bindings.DB, PRINCIPAL, { serverId })).id;
    await expect(updateMcpConnection(bindings.DB, PRINCIPAL, id, { serverId })).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    await expect(getMcpConnection(bindings.DB, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(deleteMcpConnection(bindings.DB, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(resolveDispatchConnection(bindings.DB, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, "not-a-uuid", "s", KEK)).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, id, "s", undefined)).rejects.toMatchObject({
      code: "SECRET_STORE_NOT_CONFIGURED",
    });
    await expect(putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, id, 42, KEK)).rejects.toMatchObject({
      code: "INVALID_MCP_CONNECTION",
    });
    // Empty secret is the edit-preserve no-op: existing ciphertext stands.
    await putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, id, CLIENT_SECRET, KEK);
    const preserved = await putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, id, "", KEK);
    expect(preserved.clientSecretProvisioned).toBe(true);
    // Tampered ciphertext fails loud, never partial values.
    await bindings.DB.prepare("UPDATE mcp_connection_secrets SET ciphertext='bogus' WHERE connection_id=?")
      .bind(id)
      .run();
    await expect(
      resolveMcpConnectionClientSecret(bindings.DB, ORG_A, id, { [ENVELOPE_KEY_VERSION]: KEK }),
    ).rejects.toMatchObject({
      code: "MCP_SECRET_UNREADABLE",
    });
    // Disabled Connections deny dispatch-shaped resolution.
    await updateMcpConnection(bindings.DB, PRINCIPAL, id, { enabled: false });
    await expect(resolveDispatchConnection(bindings.DB, PRINCIPAL, id)).rejects.toMatchObject({
      code: "MCP_CONNECTION_DISABLED",
    });
  });
});

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("MCP catalog pure branches", () => {
  it("covers description, schema, parse, and plan edges", () => {
    expect(mcpToolDescription("t", "  ")).toBe("External MCP tool t.");
    expect(mcpToolDescription("t", 42)).toBe("External MCP tool t.");
    expect(mcpToolDescription("t", "real")).toBe("real");
    expect(mcpToolDescription("t", "x".repeat(2000)).length).toBe(1024);
    expect(normalizeMcpInputSchema({})).toEqual({ type: "object" });
    expect(normalizeMcpInputSchema({ inputSchema: null })).toEqual({ type: "object" });
    expect(normalizeMcpInputSchema({ input_schema: { type: "string" } })).toEqual({ type: "string" });
    expect(codeOf(catchSync(() => parseDiscoveredTools(null)))).toBe("MCP_CATALOG_INVALID");
    expect(codeOf(catchSync(() => parseDiscoveredTools({ tools: {} })))).toBe("MCP_CATALOG_INVALID");
    expect(codeOf(catchSync(() => parseDiscoveredTools({ tools: [null] })))).toBe("MCP_CATALOG_INVALID");
    expect(codeOf(catchSync(() => parseDiscoveredTools({ tools: [{ name: "9bad" }] })))).toBe("MCP_CATALOG_INVALID");
    expect(parseDiscoveredTools({ tools: [] })).toEqual([]);
    expect(parseQualifiedMcpToolName("mcp__x")).toBeNull();
    expect(parseQualifiedMcpToolName("mcp____tool")).toBeNull();
    expect(qualifiedMcpToolName("AAAAAAAA-1111-4111-8111-111111111111", "t")).toBe(
      "mcp__aaaaaaaa-1111-4111-8111-111111111111__t",
    );
    expect(vendorToolNamePattern().test("ok_tool-1.2")).toBe(true);
    expect(manualDisableReason()).toBe("Manually disabled by admin");
    const plan = planCatalogSync(
      [],
      [{ name: "n", description: "d".repeat(3000), inputSchema: { big: "x".repeat(20000) } }],
      "c",
      AT,
    );
    expect(plan.insert).toHaveLength(1);
    expect(plan.insert[0]?.description?.length).toBeLessThanOrEqual(1024);
    expect(plan.insert[0]?.schema_json.length).toBeLessThanOrEqual(16384);
  });

  it("covers catalog store edges", async () => {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: "branch-cat",
        serverUrl: SERVER_URL,
        providerFlow: "none",
        orgId: ORG_A,
      })
    ).id;
    const id = (await createMcpConnection(bindings.DB, PRINCIPAL, { serverId })).id;
    await expect(listMcpCatalog(bindings.DB, { orgId: ORG_B, userId: "x" }, id)).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(resolveMcpCatalogTool(bindings.DB, PRINCIPAL, id, "9bad")).rejects.toMatchObject({
      code: "MCP_TOOL_UNKNOWN",
    });
    await expect(resolveMcpCatalogTool(bindings.DB, PRINCIPAL, "not-a-uuid", "t")).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, id, "ghost", true)).rejects.toMatchObject({
      code: "MCP_TOOL_UNKNOWN",
    });
    await expect(setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, "not-a-uuid", "t", true)).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, id, "9bad", true)).rejects.toMatchObject({
      code: "MCP_TOOL_UNKNOWN",
    });
    await syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: [{ name: "solo" }] });
    await expect(
      setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, id, "solo", "yes" as unknown as boolean),
    ).rejects.toMatchObject({ code: "MCP_CATALOG_INVALID" });
    const reenabled = await setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, id, "solo", true);
    expect(reenabled.enabled).toBe(true);
    await expect(syncMcpCatalog(bindings.DB, PRINCIPAL, "not-a-uuid", { tools: [] })).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: "nope" })).rejects.toMatchObject({
      code: "MCP_CATALOG_INVALID",
    });
    // Corrupt schema JSON degrades to the empty object in views.
    await bindings.DB.prepare("UPDATE mcp_tool_catalog SET schema_json='{' WHERE connection_id=?").bind(id).run();
    const listed = await listMcpCatalog(bindings.DB, PRINCIPAL, id);
    expect(listed[0]?.inputSchema).toEqual({ type: "object" });
  });
});

describe("MCP token store branches", () => {
  async function seedPair(): Promise<string> {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-tok-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: "none",
        orgId: ORG_A,
      })
    ).id;
    return (await createMcpConnection(bindings.DB, PRINCIPAL, { serverId })).id;
  }

  it("service tokens: validation, duplicates, stale writes, outcomes, tamper", async () => {
    const id = await seedPair();
    await expect(
      storeInitialMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        accessToken: "",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CREDENTIAL_INVALID" });
    await expect(
      storeInitialMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: "00000000-0000-4000-8000-00000000ffff",
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONNECTION_NOT_FOUND" });
    const first = await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      accessToken: "a1",
      refreshToken: "r1",
      scope: "s",
      expiresAtMs: 1,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    expect(first.generation).toBe(1);
    await expect(
      storeInitialMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_TOKEN_EXISTS" });
    await expect(
      replaceMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        expectedGeneration: 0,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CREDENTIAL_INVALID" });
    await expect(
      replaceMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        expectedGeneration: 99,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_TOKEN_GENERATION_STALE" });
    await expect(
      replaceMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: "00000000-0000-4000-8000-00000000ffff",
        expectedGeneration: 1,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONNECTION_NOT_FOUND" });
    const healthy = await recordMcpServiceTokenOutcome(bindings.DB, ORG_A, id, { kind: "success" }, AT, 1);
    expect(healthy.status).toBe("healthy");
    const failed = await recordMcpServiceTokenOutcome(bindings.DB, ORG_A, id, { kind: "failure", code: "X" }, AT, 1);
    expect(failed).toMatchObject({ status: "failed", consecutiveFailures: 1 });
    const revoked = await recordMcpServiceTokenOutcome(bindings.DB, ORG_A, id, { kind: "revoked" }, AT, 1);
    expect(revoked.status).toBe("revoked");
    await expect(
      recordMcpServiceTokenOutcome(bindings.DB, ORG_A, id, { kind: "success" }, AT, 99),
    ).rejects.toMatchObject({
      code: "MCP_TOKEN_GENERATION_STALE",
    });
    // Tampered ciphertext fails loud; partial refresh columns fail loud.
    await bindings.DB.prepare("UPDATE mcp_service_tokens SET access_ciphertext='bogus' WHERE connection_id=?")
      .bind(id)
      .run();
    await expect(loadMcpServiceToken(bindings.DB, ORG_A, id, { [ENVELOPE_KEY_VERSION]: KEK })).rejects.toMatchObject({
      code: "MCP_TOKEN_UNREADABLE",
    });
    await bindings.DB.prepare("UPDATE mcp_service_tokens SET refresh_nonce=NULL WHERE connection_id=?").bind(id).run();
    const state = await readMcpServiceTokenState(bindings.DB, ORG_A, id);
    expect(state?.generation).toBe(1);
    await expect(loadMcpServiceToken(bindings.DB, ORG_A, id, { [ENVELOPE_KEY_VERSION]: KEK })).rejects.toMatchObject({
      code: "MCP_TOKEN_UNREADABLE",
    });
    // The status domain needs no read-time branch: the CHECK constraint on
    // both token tables rejects forged statuses at write time.
  });

  it("user consents: user binding, duplicates, stale writes, outcomes", async () => {
    const id = await seedPair();
    await expect(
      storeInitialMcpUserConsent(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        userId: "  ",
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CREDENTIAL_INVALID" });
    const view = await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "ua",
      refreshToken: "ur",
      scope: "s",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    expect(view.generation).toBe(1);
    await expect(
      storeInitialMcpUserConsent(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        userId: MEMBER_USER,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONSENT_EXISTS" });
    // A row copied to another user fails closed on decrypt (user-bound AAD).
    await bindings.DB.prepare("UPDATE mcp_user_consents SET user_id='copied-user' WHERE connection_id=?")
      .bind(id)
      .run();
    await expect(
      loadMcpUserConsent(bindings.DB, ORG_A, id, "copied-user", { [ENVELOPE_KEY_VERSION]: KEK }),
    ).rejects.toMatchObject({
      code: "MCP_TOKEN_UNREADABLE",
    });
    await bindings.DB.prepare("UPDATE mcp_user_consents SET user_id=? WHERE connection_id=?")
      .bind(MEMBER_USER.toLowerCase(), id)
      .run();
    await expect(
      replaceMcpUserConsentToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        userId: MEMBER_USER,
        expectedGeneration: 0,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CREDENTIAL_INVALID" });
    await expect(
      replaceMcpUserConsentToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        userId: MEMBER_USER,
        expectedGeneration: 99,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_TOKEN_GENERATION_STALE" });
    await expect(
      replaceMcpUserConsentToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        userId: "ghost",
        expectedGeneration: 1,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONSENT_NOT_FOUND" });
    const failed = await recordMcpUserConsentOutcome(
      bindings.DB,
      ORG_A,
      id,
      MEMBER_USER,
      { kind: "failure", code: "X" },
      AT,
      1,
    );
    expect(failed.status).toBe("failed");
    const ok = await recordMcpUserConsentOutcome(bindings.DB, ORG_A, id, MEMBER_USER, { kind: "success" }, AT, 1);
    expect(ok.status).toBe("healthy");
    const out = await recordMcpUserConsentOutcome(bindings.DB, ORG_A, id, MEMBER_USER, { kind: "revoked" }, AT, 1);
    expect(out.status).toBe("revoked");
    await expect(
      recordMcpUserConsentOutcome(bindings.DB, ORG_A, id, MEMBER_USER, { kind: "success" }, AT, 99),
    ).rejects.toMatchObject({
      code: "MCP_TOKEN_GENERATION_STALE",
    });
  });
});

describe("MCP consent branches", () => {
  async function seedFlow(flow: string, name: string, withClient = true, withSecret = true): Promise<string> {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-${name}-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: flow,
        orgId: ORG_A,
      })
    ).id;
    const id = (
      await createMcpConnection(bindings.DB, PRINCIPAL, {
        serverId,
        ...(withClient ? { clientId: CLIENT_ID, tokenPath: TOKEN_PATH } : {}),
      })
    ).id;
    if (withSecret) await putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, id, CLIENT_SECRET, KEK);
    return id;
  }

  it("authorize validates flow, pair, endpoints, and scope", async () => {
    const cc = await seedFlow("client_credentials", "cc");
    await expect(
      authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
        connectionId: cc,
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toMatchObject({ code: "MCP_USER_CONSENT_UNSUPPORTED" });
    const bare = await seedFlow("authorization_code", "bare", false, false);
    await expect(
      authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
        connectionId: bare,
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toMatchObject({ code: "MCP_MISCONFIGURED" });
    const id = await seedFlow("authorization_code", "ok");
    await expect(
      authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
        connectionId: id,
        authorizeEndpoint: "garbage",
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONSENT_INVALID" });
    await expect(
      authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
        connectionId: id,
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        redirectUri: "https://u:p@h/",
      }),
    ).rejects.toMatchObject({ code: "MCP_CONSENT_INVALID" });
    await expect(
      authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
        connectionId: id,
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        redirectUri: REDIRECT_URI,
        scope: "x".repeat(2000),
      }),
    ).rejects.toMatchObject({ code: "MCP_CONSENT_INVALID" });
    await expect(
      authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
        connectionId: "not-a-uuid",
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONNECTION_NOT_FOUND" });
    const issued = await authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
      connectionId: id,
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      redirectUri: REDIRECT_URI,
      scope: "read",
    });
    expect(issued.authorizationUrl).toContain(CLIENT_ID);
  });

  it("callback validates session, pair, and vendor denial before spending the code", async () => {
    const cc = await seedFlow("client_credentials", "cbcc");
    await expect(
      completeMcpUserConsent(
        bindings.DB,
        PRINCIPAL,
        { connectionId: cc, code: "c", expectedState: "s", codeVerifier: "v", redirectUri: REDIRECT_URI },
        { SECRETS_KEK: KEK },
      ),
    ).rejects.toMatchObject({ code: "MCP_USER_CONSENT_UNSUPPORTED" });
    const bare = await seedFlow("authorization_code", "cbbare", false, false);
    await expect(
      completeMcpUserConsent(
        bindings.DB,
        PRINCIPAL,
        { connectionId: bare, code: "c", expectedState: "s", codeVerifier: "v", redirectUri: REDIRECT_URI },
        { SECRETS_KEK: KEK },
      ),
    ).rejects.toMatchObject({ code: "MCP_MISCONFIGURED" });
    const noSecret = await seedFlow("authorization_code", "cbnosec", true, false);
    await expect(
      completeMcpUserConsent(
        bindings.DB,
        PRINCIPAL,
        {
          connectionId: noSecret,
          code: "c",
          state: "s",
          expectedState: "s",
          codeVerifier: "v",
          redirectUri: REDIRECT_URI,
        },
        { SECRETS_KEK: KEK },
      ),
    ).rejects.toMatchObject({ code: "MCP_NOT_CONFIGURED" });
    const id = await seedFlow("authorization_code", "cbok");
    await expect(
      completeMcpUserConsent(
        bindings.DB,
        PRINCIPAL,
        { connectionId: id, code: "c", state: "s", expectedState: "s", codeVerifier: "v", redirectUri: REDIRECT_URI },
        {},
      ),
    ).rejects.toMatchObject({ code: "SECRET_STORE_NOT_CONFIGURED" });
    await expect(
      completeMcpUserConsent(
        bindings.DB,
        PRINCIPAL,
        { connectionId: id, error: "access_denied", expectedState: "s", codeVerifier: "v", redirectUri: REDIRECT_URI },
        { SECRETS_KEK: KEK },
      ),
    ).rejects.toMatchObject({ code: "OAUTH_AUTHORIZATION_DENIED" });
    await expect(
      completeMcpUserConsent(
        bindings.DB,
        PRINCIPAL,
        { connectionId: id, code: "c", expectedState: 42, codeVerifier: "v", redirectUri: REDIRECT_URI },
        { SECRETS_KEK: KEK },
      ),
    ).rejects.toMatchObject({ code: "MCP_CONSENT_INVALID" });
    await expect(disconnectMcpUserConsentSelf(bindings.DB, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
  });

  it("service connect validates flow, pair, scope, and KEK", async () => {
    const auth = await seedFlow("authorization_code", "scac");
    await expect(
      connectMcpServiceCredential(bindings.DB, PRINCIPAL, { connectionId: auth }, { SECRETS_KEK: KEK }),
    ).rejects.toMatchObject({
      code: "MCP_SERVICE_CONNECT_UNSUPPORTED",
    });
    const bare = await seedFlow("client_credentials", "scbare", false, false);
    await expect(
      connectMcpServiceCredential(bindings.DB, PRINCIPAL, { connectionId: bare }, { SECRETS_KEK: KEK }),
    ).rejects.toMatchObject({
      code: "MCP_MISCONFIGURED",
    });
    const noSecret = await seedFlow("client_credentials", "scnosec", true, false);
    await expect(
      connectMcpServiceCredential(bindings.DB, PRINCIPAL, { connectionId: noSecret }, { SECRETS_KEK: KEK }),
    ).rejects.toMatchObject({
      code: "MCP_NOT_CONFIGURED",
    });
    const id = await seedFlow("client_credentials", "scok");
    await expect(
      connectMcpServiceCredential(
        bindings.DB,
        PRINCIPAL,
        { connectionId: id, scope: "x".repeat(2000) },
        { SECRETS_KEK: KEK },
      ),
    ).rejects.toMatchObject({
      code: "MCP_CONSENT_INVALID",
    });
    await expect(connectMcpServiceCredential(bindings.DB, PRINCIPAL, { connectionId: id }, {})).rejects.toMatchObject({
      code: "SECRET_STORE_NOT_CONFIGURED",
    });
  });
});

describe("MCP dispatch transport and refresh branches", () => {
  let tokenHandler: (form: URLSearchParams) => Response = () =>
    Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  let rpcHandler: (auth: string | null, body: Record<string, unknown>) => Response = () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  const tokenPosts: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(TOKEN_PATH)) {
      const body = typeof init?.body === "string" ? init.body : "";
      tokenPosts.push(body);
      return tokenHandler(new URLSearchParams(body));
    }
    if (url === SERVER_URL) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === "string" ? init.body : "{}";
      return rpcHandler(headers.Authorization ?? null, JSON.parse(body) as Record<string, unknown>);
    }
    throw new Error(`unexpected outbound ${url}`);
  }) as typeof fetch;

  function tokenSuccess(access: string, refresh?: string): Response {
    return Response.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      ...(refresh === undefined ? {} : { refresh_token: refresh }),
    });
  }

  async function seedDispatch(flow: string, flags: Record<string, unknown> = {}): Promise<string> {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-d-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: flow,
        orgId: ORG_A,
      })
    ).id;
    const id = (
      await createMcpConnection(bindings.DB, PRINCIPAL, {
        serverId,
        clientId: CLIENT_ID,
        tokenPath: TOKEN_PATH,
        ...flags,
      })
    ).id;
    await putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, id, CLIENT_SECRET, KEK);
    await syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: [{ name: "search" }] });
    return id;
  }

  beforeEach(() => {
    tokenPosts.length = 0;
    tokenHandler = () => Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    rpcHandler = () => Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("endpoint guard, bounded reads, and marker detection", async () => {
    expect(codeOf(catchSync(() => assertMcpEndpoint("garbage")))).toBe("MCP_INVALID_CONNECTION");
    assertMcpEndpoint(SERVER_URL);
    expect(isMcpAuthMarker(new Error("nope"))).toBe(false);
    expect(isMcpAuthMarker(new Fault(401, "OTHER", "x"))).toBe(false);
    expect(isMcpAuthMarker(new Fault(401, "MCP_VENDOR_UNAUTHORIZED", "x"))).toBe(false);
    expect(await readBoundedMcpBody(new Response(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    expect(await readBoundedMcpBody(new Response(""))).toBeNull();
    await expect(
      readBoundedMcpBody(new Response("x".repeat(10), { headers: { "Content-Length": "not-a-number" } })),
    ).rejects.toMatchObject({
      code: "MCP_VENDOR_UNREADABLE",
    });
    await expect(
      readBoundedMcpBody(new Response("x".repeat(10), { headers: { "Content-Length": String(300_000) } })),
    ).rejects.toMatchObject({ code: "MCP_RESPONSE_TOO_LARGE" });
    await expect(readBoundedMcpBody(new Response("not json"))).rejects.toMatchObject({ code: "MCP_VENDOR_UNREADABLE" });
  });

  it("single RPC faults speak fixed codes without retries", async () => {
    const down: typeof fetch = (() => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(
      postMcpRpc({ url: SERVER_URL, token: "t", method: "tools/call", params: {}, fetchImpl: down }),
    ).rejects.toMatchObject({
      code: "MCP_VENDOR_UNREACHABLE",
    });
    const timeout: typeof fetch = (() => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(
      postMcpRpc({ url: SERVER_URL, token: "t", method: "tools/call", params: {}, fetchImpl: timeout }),
    ).rejects.toMatchObject({
      code: "MCP_VENDOR_TIMEOUT",
    });
    await expect(
      postMcpRpc({
        url: SERVER_URL,
        token: "t",
        method: "tools/call",
        params: {},
        fetchImpl: (async () => new Response(null, { status: 500 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "MCP_VENDOR_ERROR" });
    await expect(
      postMcpRpc({
        url: SERVER_URL,
        token: "t",
        method: "tools/call",
        params: {},
        fetchImpl: (async () =>
          Response.json({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "vendor prose never copied" },
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "MCP_VENDOR_ERROR" });
    await expect(
      postMcpRpc({
        url: SERVER_URL,
        token: "t",
        method: "tools/call",
        params: {},
        fetchImpl: (async () => new Response("plain")) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "MCP_VENDOR_UNREADABLE" });
    await expect(
      postMcpRpc({
        url: SERVER_URL,
        token: "t",
        method: "tools/call",
        params: {},
        fetchImpl: (async () => new Response(null, { status: 403 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "MCP_VENDOR_UNAUTHORIZED" });
    expect(await listMcpToolsRemote(SERVER_URL, "t", { fetchImpl })).toEqual({ ok: true });
  });

  it("dispatch validates arguments, KEK, ownership, enablement, and egress", async () => {
    const id = await seedDispatch("authorization_code");
    const base = {
      db: bindings.DB,
      orgId: ORG_A,
      caller: { kind: "user", userId: MEMBER_USER } as const,
      connectionId: id,
      toolName: "search",
      kekMaterial: KEK,
      fetchImpl,
    };
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "ua",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await expect(dispatchMcpTool({ ...base, args: "nope" })).rejects.toMatchObject({ code: "MCP_INVALID_PARAMS" });
    await expect(dispatchMcpTool({ ...base, args: {}, kekMaterial: undefined })).rejects.toMatchObject({
      code: "SECRET_STORE_NOT_CONFIGURED",
    });
    await expect(
      dispatchMcpTool({ ...base, args: {}, connectionId: "00000000-0000-4000-8000-00000000ffff" }),
    ).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(dispatchMcpTool({ ...base, args: {}, toolName: "ghost" })).rejects.toMatchObject({
      code: "MCP_TOOL_UNKNOWN",
    });
    await updateMcpConnection(bindings.DB, PRINCIPAL, id, { enabled: false });
    await expect(dispatchMcpTool({ ...base, args: {} })).rejects.toMatchObject({ code: "MCP_CONNECTION_DISABLED" });
    await updateMcpConnection(bindings.DB, PRINCIPAL, id, { enabled: true });
    const template = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-e-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: "none",
        orgId: ORG_A,
      })
    ).id;
    const evil = (await createMcpConnection(bindings.DB, PRINCIPAL, { serverId: template })).id;
    await syncMcpCatalog(bindings.DB, PRINCIPAL, evil, { tools: [{ name: "search" }] });
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: evil,
      userId: MEMBER_USER,
      accessToken: "ua",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await bindings.DB.prepare("UPDATE mcp_server_templates SET server_url='garbage' WHERE id=?").bind(template).run();
    await expect(dispatchMcpTool({ ...base, args: {}, connectionId: evil })).rejects.toMatchObject({
      code: "MCP_INVALID_CONNECTION",
    });
  });

  it("expired user consent refreshes inline, then falls through to service on failure", async () => {
    const id = await seedDispatch("authorization_code", { availableInChat: true });
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "stale-user",
      refreshToken: "user-refresh",
      scope: "s",
      expiresAtMs: 1,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      accessToken: "fresh-service",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    tokenHandler = (form) =>
      form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "user-refresh"
        ? tokenSuccess("rotated-user", "user-refresh-2")
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    const seen: (string | null)[] = [];
    rpcHandler = (auth) => {
      seen.push(auth);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    };
    const refreshed = await dispatchMcpTool({
      db: bindings.DB,
      orgId: ORG_A,
      caller: { kind: "user", userId: MEMBER_USER },
      connectionId: id,
      toolName: "search",
      args: {},
      kekMaterial: KEK,
      fetchImpl,
    });
    expect(refreshed.provenance.identity).toBe("user");
    expect(seen).toEqual(["Bearer " + "rotated-user"]);
    expect(tokenPosts.filter((body) => body.includes("grant_type=refresh_token"))).toHaveLength(1);

    tokenHandler = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await bindings.DB.prepare("UPDATE mcp_user_consents SET expires_at_ms=1 WHERE connection_id=?").bind(id).run();
    const fellThrough = await dispatchMcpTool({
      db: bindings.DB,
      orgId: ORG_A,
      caller: { kind: "user", userId: MEMBER_USER },
      connectionId: id,
      toolName: "search",
      args: {},
      kekMaterial: KEK,
      fetchImpl,
    });
    expect(fellThrough.provenance.identity).toBe("service");
  });

  it("expired service without fallback needs reauth; refresh-less 401 denies without a vendor refresh", async () => {
    const id = await seedDispatch("authorization_code");
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      accessToken: "stale-service",
      refreshToken: "service-refresh",
      scope: "s",
      expiresAtMs: 1,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    tokenHandler = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: id,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_NEEDS_REAUTH" });

    const bare = await seedDispatch("authorization_code");
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: bare,
      userId: MEMBER_USER,
      accessToken: "bare-user",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    rpcHandler = () => new Response(null, { status: 401 });
    tokenPosts.length = 0;
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: bare,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_NEEDS_REAUTH" });
    expect(tokenPosts).toHaveLength(0);
  });

  it("dead refresh faults become denials; transport failures propagate", async () => {
    const id = await seedDispatch("authorization_code");
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "doomed",
      refreshToken: "doomed-refresh",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    rpcHandler = () => new Response(null, { status: 401 });
    tokenHandler = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: id,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_NEEDS_REAUTH" });

    // Fresh consent for the transport case: the denial above marked the
    // previous generation failed, so resolution would stop before the wire.
    const fresh = await seedDispatch("authorization_code");
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: fresh,
      userId: MEMBER_USER,
      accessToken: "live",
      refreshToken: "live-refresh",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    tokenHandler = (form) =>
      form.get("grant_type") === "refresh_token"
        ? tokenSuccess("r2", "r3")
        : Response.json({ error: "x" }, { status: 400 });
    let calls = 0;
    rpcHandler = () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 401 });
      throw new Error("socket hang up");
    };
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: fresh,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_VENDOR_UNREACHABLE" });
  });

  it("concurrent expired user dispatches share one refresh round", async () => {
    const id = await seedDispatch("authorization_code");
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "old",
      refreshToken: "shared-refresh",
      scope: "s",
      expiresAtMs: 1,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    tokenHandler = (form) =>
      form.get("grant_type") === "refresh_token"
        ? tokenSuccess("rotated-u", "rotated-u-2")
        : Response.json({ error: "x" }, { status: 400 });
    const request = {
      db: bindings.DB,
      orgId: ORG_A,
      caller: { kind: "user", userId: MEMBER_USER } as const,
      connectionId: id,
      toolName: "search",
      args: {},
      kekMaterial: KEK,
      fetchImpl,
    };
    const [first, second] = await Promise.all([dispatchMcpTool(request), dispatchMcpTool(request)]);
    expect(first.provenance.identity).toBe("user");
    expect(second.provenance.identity).toBe("user");
    expect(tokenPosts.filter((body) => body.includes("grant_type=refresh_token"))).toHaveLength(1);
    expect((await readMcpUserConsent(bindings.DB, ORG_A, id, MEMBER_USER))?.generation).toBe(2);
  });

  it("tampered service ciphertext fails dispatch loud", async () => {
    const id = await seedDispatch("client_credentials", { availableInChat: true });
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      accessToken: "svc",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await bindings.DB.prepare("UPDATE mcp_service_tokens SET access_ciphertext='bogus' WHERE connection_id=?")
      .bind(id)
      .run();
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: id,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_TOKEN_UNREADABLE" });
  });
});

describe("MCP route leftover arms", () => {
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
  async function seedRouteConnection(
    flow: string,
    body: Record<string, unknown> = {},
    withSecret = true,
  ): Promise<string> {
    const template = await worker.fetch(
      call("/api/mcp-servers", "POST", {
        name: `branch-r-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: flow,
        orgId: ORG_A,
      }),
      bindings,
    );
    expect(template.status).toBe(201);
    const serverId = ((await jsonOf(template)).server as { id: string }).id;
    const created = await worker.fetch(call("/api/mcp-connections", "POST", { serverId, ...body }), bindings);
    expect(created.status).toBe(201);
    const id = ((await jsonOf(created)).connection as { id: string }).id;
    if (withSecret) {
      const secret = await worker.fetch(
        call(`/api/mcp-connections/${id}/client-secret`, "PUT", { secret: CLIENT_SECRET }),
        bindings,
      );
      expect(secret.status).toBe(200);
    }
    return id;
  }

  it("consent read answers the view or null; bad call arguments fail", async () => {
    const id = await seedRouteConnection("authorization_code", { clientId: CLIENT_ID, tokenPath: TOKEN_PATH });
    const empty = await worker.fetch(call(`/api/mcp-connections/${id}/consent`), asMember());
    expect(empty.status).toBe(200);
    expect((await jsonOf(empty)).consent).toBeNull();
    const { syncMcpCatalog } = await import("../src/mcp-catalog");
    await syncMcpCatalog(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, id, { tools: [{ name: "search" }] });
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "ua",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const view = await worker.fetch(call(`/api/mcp-connections/${id}/consent`), asMember());
    expect(view.status).toBe(200);
    expect(((await jsonOf(view)).consent as { userId: string }).userId).toBe(MEMBER_USER);
    const badArgs = await worker.fetch(
      call(`/api/mcp-connections/${id}/tools/search/call`, "POST", { arguments: "nope" }),
      asMember(),
    );
    expect(badArgs.status).toBe(400);
    expect(((await jsonOf(badArgs)).error as { code: string }).code).toBe("MCP_INVALID_PARAMS");
  });

  it("tool toggle re-enables; service connect rejects the authorization_code flow", async () => {
    const id = await seedRouteConnection("authorization_code", { clientId: CLIENT_ID, tokenPath: TOKEN_PATH });
    const { syncMcpCatalog } = await import("../src/mcp-catalog");
    await syncMcpCatalog(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, id, { tools: [{ name: "flip" }] });
    await worker.fetch(call(`/api/mcp-connections/${id}/tools/flip/disable`, "POST"), bindings);
    const enabled = await worker.fetch(call(`/api/mcp-connections/${id}/tools/flip/enable`, "POST"), bindings);
    expect(enabled.status).toBe(200);
    expect(((await jsonOf(enabled)).tool as { enabled: boolean }).enabled).toBe(true);
    const connected = await worker.fetch(call(`/api/mcp-connections/${id}/service-connect`, "POST", {}), bindings);
    expect(connected.status).toBe(400);
    expect(((await jsonOf(connected)).error as { code: string }).code).toBe("MCP_SERVICE_CONNECT_UNSUPPORTED");
  });

  it("authorize without a client id and callback without a secret fail loud", async () => {
    const bare = await seedRouteConnection("authorization_code", {}, false);
    const authorized = await worker.fetch(
      call(`/api/mcp-connections/${bare}/consent/authorize`, "POST", {
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        redirectUri: REDIRECT_URI,
      }),
      asMember(),
    );
    expect(authorized.status).toBe(424);
    const paired = await seedRouteConnection(
      "authorization_code",
      { clientId: CLIENT_ID, tokenPath: TOKEN_PATH },
      false,
    );
    const callback = await worker.fetch(
      call(`/api/mcp-connections/${paired}/consent/callback`, "POST", {
        code: "c",
        state: "s",
        expectedState: "s",
        codeVerifier: "v",
        redirectUri: REDIRECT_URI,
      }),
      asMember(),
    );
    expect(callback.status).toBe(502);
    expect(((await jsonOf(callback)).error as { code: string }).code).toBe("MCP_NOT_CONFIGURED");
  });

  it("dispatch on a disabled connection denies before any vendor contact", async () => {
    const id = await seedRouteConnection("authorization_code", { clientId: CLIENT_ID, tokenPath: TOKEN_PATH });
    const { syncMcpCatalog } = await import("../src/mcp-catalog");
    await syncMcpCatalog(bindings.DB, { orgId: ORG_A, userId: USER_ADMIN }, id, { tools: [{ name: "search" }] });
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "ua",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await worker.fetch(call(`/api/mcp-connections/${id}`, "POST", { enabled: false }), bindings);
    const denied = await worker.fetch(call(`/api/mcp-connections/${id}/tools/search/call`, "POST", {}), asMember());
    expect(denied.status).toBe(404);
    expect(((await jsonOf(denied)).error as { code: string }).code).toBe("MCP_CONNECTION_DISABLED");
  });
});

describe("MCP partial-migration and store-failure branches", () => {
  async function seedFull(flags: Record<string, unknown> = {}): Promise<string> {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-p-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: "client_credentials",
        orgId: ORG_A,
      })
    ).id;
    return (
      await createMcpConnection(bindings.DB, PRINCIPAL, {
        serverId,
        clientId: CLIENT_ID,
        tokenPath: TOKEN_PATH,
        ...flags,
      })
    ).id;
  }

  it("dropping a template table cascades the bindings with it (D1 behavior)", async () => {
    const id = await seedFull();
    await bindings.DB.prepare("DROP TABLE mcp_server_templates").run();
    // The binding is gone with its template: 404, never a half-bound view.
    await expect(getMcpConnection(bindings.DB, PRINCIPAL, id)).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
  });

  it("a missing catalog table answers absence on reads and 404 on sync", async () => {
    const catalogId = await seedFull();
    await bindings.DB.prepare("DROP TABLE mcp_tool_catalog").run();
    expect(await listMcpCatalog(bindings.DB, PRINCIPAL, catalogId)).toEqual([]);
    await expect(resolveMcpCatalogTool(bindings.DB, PRINCIPAL, catalogId, "search")).rejects.toMatchObject({
      code: "MCP_TOOL_UNKNOWN",
    });
    await expect(setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, catalogId, "search", false)).rejects.toMatchObject({
      code: "MCP_TOOL_UNKNOWN",
    });
    await expect(
      syncMcpCatalog(bindings.DB, PRINCIPAL, catalogId, { tools: [{ name: "search" }] }),
    ).rejects.toMatchObject({
      code: "MCP_TOOL_UNKNOWN",
    });
  });

  it("loads register execution secrets with and without refresh material", async () => {
    const id = await seedFull();
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      accessToken: "sa",
      refreshToken: "sr",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const service = await loadMcpServiceToken(bindings.DB, ORG_A, id, { [ENVELOPE_KEY_VERSION]: KEK }, "exec-1");
    expect(service?.accessToken).toBe("sa");
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      userId: MEMBER_USER,
      accessToken: "ua",
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const consent = await loadMcpUserConsent(
      bindings.DB,
      ORG_A,
      id,
      MEMBER_USER,
      { [ENVELOPE_KEY_VERSION]: KEK },
      "exec-1",
    );
    expect(consent?.accessToken).toBe("ua");
    expect(consent?.refreshToken).toBeUndefined();
  });

  it("outcome writes fail loud when the store disappears mid-dispatch", async () => {
    const id = await seedFull({ availableInChat: true });
    await syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: [{ name: "search" }] });
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      accessToken: "svc",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const fetchImpl = (async () => {
      await bindings.DB.prepare("DROP TABLE mcp_service_tokens").run();
      return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    }) as typeof fetch;
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: id,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_STORE_NOT_MIGRATED" });
  });

  it("refresh-tools covers unrefreshable, stale, and vanished store paths", async () => {
    const { refreshMcpTools } = await import("../src/mcp-dispatch");
    // No token path: the expired credential is unrefreshable, the stale
    // token spends itself once, and the denial stays loud.
    const bare = await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
      name: `branch-r-${Math.random().toString(36).slice(2, 8)}`,
      serverUrl: SERVER_URL,
      providerFlow: "client_credentials",
      orgId: ORG_A,
    });
    const bareConn = (await createMcpConnection(bindings.DB, PRINCIPAL, { serverId: bare.id })).id;
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: bareConn,
      accessToken: "stale",
      refreshToken: "r",
      scope: "s",
      expiresAtMs: 1,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const failingFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith(TOKEN_PATH)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return new Response(null, { status: 401 });
    }) as typeof fetch;
    await expect(
      refreshMcpTools(bindings.DB, ORG_A, bareConn, KEK, { fetchImpl: failingFetch }, AT),
    ).rejects.toMatchObject({
      code: "MCP_VENDOR_UNAUTHORIZED",
    });

    // A concurrent rotation wins the fence: the stale failure write is
    // dropped and the denial still names the vendor rejection.
    const raced = await seedFull();
    await putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, raced, CLIENT_SECRET, KEK);
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: raced,
      accessToken: "stale",
      refreshToken: "r",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const racingFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith(TOKEN_PATH)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      await replaceMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: raced,
        expectedGeneration: 1,
        accessToken: "winner",
        kekMaterial: KEK,
        checkedAt: AT,
      });
      return new Response(null, { status: 401 });
    }) as typeof fetch;
    await expect(refreshMcpTools(bindings.DB, ORG_A, raced, KEK, { fetchImpl: racingFetch }, AT)).rejects.toMatchObject(
      {
        code: "MCP_VENDOR_UNAUTHORIZED",
      },
    );
    expect((await readMcpServiceTokenState(bindings.DB, ORG_A, raced))?.generation).toBe(2);

    // The store vanishing mid-refresh fails loud, never a silent success.
    const gone = await seedFull();
    await putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, gone, CLIENT_SECRET, KEK);
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: gone,
      accessToken: "stale",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const droppingFetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === SERVER_URL) {
        await bindings.DB.prepare("DROP TABLE mcp_service_tokens").run();
        return new Response(null, { status: 401 });
      }
      return Response.json({ error: "x" }, { status: 400 });
    }) as typeof fetch;
    await expect(
      refreshMcpTools(bindings.DB, ORG_A, gone, KEK, { fetchImpl: droppingFetch }, AT),
    ).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
  });
});

describe("MCP remaining deterministic arms", () => {
  async function seedTriple(flow = "authorization_code"): Promise<{ serverId: string; id: string }> {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-z-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: flow,
        orgId: ORG_A,
      })
    ).id;
    const id = (
      await createMcpConnection(bindings.DB, PRINCIPAL, { serverId, clientId: CLIENT_ID, tokenPath: TOKEN_PATH })
    ).id;
    return { serverId, id };
  }

  it("catalog null-description views, malformed lists, foreign writes, null-reason denials", async () => {
    const { id } = await seedTriple();
    await syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: [{ name: "nodesc" }] });
    await bindings.DB.prepare("UPDATE mcp_tool_catalog SET description=NULL WHERE connection_id=?").bind(id).run();
    const listed = await listMcpCatalog(bindings.DB, PRINCIPAL, id);
    expect(listed[0]?.description).toBe("External MCP tool nodesc.");
    await expect(listMcpCatalog(bindings.DB, PRINCIPAL, "not-a-uuid")).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    const foreign = "00000000-0000-4000-8000-00000000ffff";
    await expect(setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, foreign, "nodesc", false)).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(syncMcpCatalog(bindings.DB, PRINCIPAL, foreign, { tools: [] })).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await bindings.DB.prepare("UPDATE mcp_tool_catalog SET enabled=0,auto_disabled_reason=NULL WHERE connection_id=?")
      .bind(id)
      .run();
    const denied = resolveMcpCatalogTool(bindings.DB, PRINCIPAL, id, "nodesc");
    await expect(denied).rejects.toMatchObject({ code: "MCP_TOOL_DISABLED" });
    await expect(denied.catch((error: unknown) => error)).resolves.toMatchObject({ status: 404, details: undefined });
  });

  it("connection reads, writes, and deletes cover every arm", async () => {
    const { id } = await seedTriple();
    const read = await getMcpConnection(bindings.DB, PRINCIPAL, id);
    expect(read.id).toBe(id);
    await expect(
      createMcpConnection(bindings.DB, PRINCIPAL, { serverId: 42 as unknown as string }),
    ).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    const otherServer = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-z-other-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: "authorization_code",
        orgId: ORG_A,
      })
    ).id;
    const disabled = await createMcpConnection(bindings.DB, PRINCIPAL, { serverId: otherServer, enabled: false });
    expect(disabled.enabled).toBe(false);
    const flagged = await updateMcpConnection(bindings.DB, PRINCIPAL, id, {
      tokenPath: "/oauth/other",
      clientId: "other-client",
      availableInChat: true,
    });
    expect(flagged).toMatchObject({ tokenPath: "/oauth/other", clientId: "other-client", availableInChat: true });
    await expect(
      deleteMcpConnection(bindings.DB, PRINCIPAL, "00000000-0000-4000-8000-00000000ffff"),
    ).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
    await expect(
      putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, "00000000-0000-4000-8000-00000000ffff", "s", KEK),
    ).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
  });

  it("missing secret store degrades reads and blocks writes", async () => {
    const { id } = await seedTriple();
    await bindings.DB.prepare("DROP TABLE mcp_connection_secrets").run();
    const read = await getMcpConnection(bindings.DB, PRINCIPAL, id);
    expect(read.clientSecretProvisioned).toBe(false);
    expect(await listMcpConnections(bindings.DB, PRINCIPAL)).not.toEqual([]);
    await deleteMcpConnection(bindings.DB, PRINCIPAL, id);
    const { id: again } = await seedTriple();
    await expect(putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, again, "s", KEK)).rejects.toMatchObject({
      code: "MCP_STORE_NOT_MIGRATED",
    });
  });

  it("D1 faults propagate loud, never swallowed as absence", async () => {
    const { id } = await seedTriple();
    await syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: [{ name: "search" }] });
    const origPrepare = bindings.DB.prepare.bind(bindings.DB);
    const catalogBoom = vi.spyOn(bindings.DB, "prepare").mockImplementation(((sql: string, ...rest: unknown[]) => {
      if (typeof sql === "string" && sql.includes("mcp_tool_catalog")) throw new Error("boom-catalog");
      return (origPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof bindings.DB.prepare);
    await expect(listMcpCatalog(bindings.DB, PRINCIPAL, id)).rejects.toThrow("boom-catalog");
    await expect(resolveMcpCatalogTool(bindings.DB, PRINCIPAL, id, "search")).rejects.toThrow("boom-catalog");
    await expect(setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, id, "search", false)).rejects.toThrow("boom-catalog");
    catalogBoom.mockRestore();
    const connBoom = vi.spyOn(bindings.DB, "prepare").mockImplementation(((sql: string, ...rest: unknown[]) => {
      if (
        typeof sql === "string" &&
        (sql.includes("JOIN mcp_server_templates t ON") || sql.includes("FROM mcp_server_templates WHERE"))
      ) {
        throw new Error("boom-conn");
      }
      return (origPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof bindings.DB.prepare);
    await expect(getMcpConnection(bindings.DB, PRINCIPAL, id)).rejects.toThrow("boom-conn");
    await expect(listMcpConnections(bindings.DB, PRINCIPAL)).rejects.toThrow("boom-conn");
    await expect(getMcpServerTemplate(bindings.DB, PRINCIPAL, id)).rejects.toThrow("boom-conn");
    connBoom.mockRestore();
    const batchBoom = vi.spyOn(bindings.DB, "batch").mockImplementation((() => {
      throw new Error("boom-batch");
    }) as typeof bindings.DB.batch);
    await expect(syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: [{ name: "search" }] })).rejects.toThrow(
      "boom-batch",
    );
    batchBoom.mockRestore();
  });

  it("none-flow connections misconfigure; callbacks accept scope-less issues", async () => {
    const { resolveMcpCredential } = await import("../src/mcp-auth");
    expect(
      resolveMcpCredential(
        { kind: "user", userId: "u" },
        {
          connection: { id: "c", providerFlow: "none", availableInChat: false, availableToAutonomous: false },
          service: null,
          user: null,
          nowMs: Date.now(),
        },
      ).kind,
    ).toBe("misconfigured");
    const { id } = await seedTriple();
    const session = await authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
      connectionId: id,
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      redirectUri: REDIRECT_URI,
      scope: "read",
    });
    expect(session.state.length).toBeGreaterThan(0);
  });

  it("unrefreshable credentials skip the inline attempt", async () => {
    const noPath = await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
      name: `branch-u-${Math.random().toString(36).slice(2, 8)}`,
      serverUrl: SERVER_URL,
      providerFlow: "authorization_code",
      orgId: ORG_A,
    });
    const noPathConn = (await createMcpConnection(bindings.DB, PRINCIPAL, { serverId: noPath.id })).id;
    await syncMcpCatalog(bindings.DB, PRINCIPAL, noPathConn, { tools: [{ name: "search" }] });
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: noPathConn,
      accessToken: "stale",
      refreshToken: "r",
      scope: "s",
      expiresAtMs: 1,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    const tokenPosts: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith(TOKEN_PATH)) {
        tokenPosts.push(typeof init?.body === "string" ? init.body : "");
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    }) as typeof fetch;
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: noPathConn,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_NEEDS_REAUTH" });
    expect(tokenPosts).toHaveLength(0);

    // Bare (no refresh token) user consent is unrefreshable: a user call
    // skips the inline attempt entirely and lands on needs-reauth.
    const bareConn = (await seedTriple()).id;
    await syncMcpCatalog(bindings.DB, PRINCIPAL, bareConn, { tools: [{ name: "search" }] });
    await storeInitialMcpUserConsent(bindings.DB, {
      orgId: ORG_A,
      connectionId: bareConn,
      userId: MEMBER_USER,
      accessToken: "expired-bare",
      scope: "s",
      expiresAtMs: 1,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await expect(
      dispatchMcpTool({
        db: bindings.DB,
        orgId: ORG_A,
        caller: { kind: "user", userId: MEMBER_USER },
        connectionId: bareConn,
        toolName: "search",
        args: {},
        kekMaterial: KEK,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "MCP_NEEDS_REAUTH" });
    expect(tokenPosts).toHaveLength(0);
  });
});

describe("MCP coverage-gap arms", () => {
  const FOREIGN = "00000000-0000-4000-8000-00000000ffff";
  const keks = { [ENVELOPE_KEY_VERSION]: KEK };

  async function seedConn(): Promise<{ serverId: string; id: string }> {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-g-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: "authorization_code",
        orgId: ORG_A,
      })
    ).id;
    const id = (
      await createMcpConnection(bindings.DB, PRINCIPAL, { serverId, clientId: CLIENT_ID, tokenPath: TOKEN_PATH })
    ).id;
    return { serverId, id };
  }

  it("template updates apply every field; discovery metadata rejects non-objects", async () => {
    const { serverId } = await seedConn();
    const updated = await updateMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, serverId, {
      serverUrl: "https://mcp-fixture.invalid/rotated",
      providerFlow: "client_credentials",
      discoveryMetadata: { contact: "ops" },
    });
    expect(updated.serverUrl).toBe("https://mcp-fixture.invalid/rotated");
    expect(updated.providerFlow).toBe("client_credentials");
    const kept = await updateMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, serverId, {});
    expect(kept.serverUrl).toBe("https://mcp-fixture.invalid/rotated");
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-g-bad-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        discoveryMetadata: "nope" as unknown as Record<string, unknown>,
        orgId: ORG_A,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_SERVER" });
  });

  it("template metadata bounds, inactive listing, and active-toggle validation", async () => {
    await expect(
      createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-g-big-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        discoveryMetadata: { blob: "x".repeat(5000) },
        orgId: ORG_A,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_SERVER" });
    await expect(setMcpServerTemplateActive(bindings.DB, PRINCIPAL, ADMIN, "not-a-uuid", true)).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
    });
    const { serverId } = await seedConn();
    await setMcpServerTemplateActive(bindings.DB, PRINCIPAL, ADMIN, serverId, false);
    expect(await listMcpServerTemplates(bindings.DB, PRINCIPAL)).not.toContainEqual(
      expect.objectContaining({ id: serverId }),
    );
    const withInactive = await listMcpServerTemplates(bindings.DB, PRINCIPAL, false);
    expect(withInactive).toContainEqual(expect.objectContaining({ id: serverId }));
  });

  it("template list surfaces non-migration D1 faults instead of empty", async () => {
    const origPrepare = bindings.DB.prepare.bind(bindings.DB);
    const boom = vi.spyOn(bindings.DB, "prepare").mockImplementation(((sql: string, ...rest: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM mcp_server_templates WHERE")) throw new Error("boom-list");
      return (origPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof bindings.DB.prepare);
    await expect(listMcpServerTemplates(bindings.DB, PRINCIPAL)).rejects.toThrow("boom-list");
    boom.mockRestore();
  });

  it("double soft-delete conflicts; hard delete cascades without the secrets table", async () => {
    const soft = await seedConn();
    expect(await deleteMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, soft.serverId)).toMatchObject({ hard: false });
    await expect(deleteMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, soft.serverId)).rejects.toMatchObject({
      code: "MCP_SERVER_DISABLED",
    });
    const hard = await seedConn();
    await syncMcpCatalog(bindings.DB, PRINCIPAL, hard.id, { tools: [{ name: "search" }] });
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: hard.id,
      accessToken: "doomed",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await bindings.DB.prepare("DROP TABLE IF EXISTS mcp_connection_secrets").run();
    expect(await deleteMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, hard.serverId, true)).toMatchObject({
      hard: true,
    });
    await expect(getMcpConnection(bindings.DB, PRINCIPAL, hard.id)).rejects.toMatchObject({
      code: "MCP_CONNECTION_NOT_FOUND",
    });
  });

  it("consent authorize rejects unknown connections before any session state", async () => {
    await expect(
      authorizeMcpUserConsent(bindings.DB, PRINCIPAL, {
        connectionId: FOREIGN,
        authorizeEndpoint: AUTHORIZE_ENDPOINT,
        redirectUri: REDIRECT_URI,
        scope: "read",
      }),
    ).rejects.toMatchObject({ code: "MCP_CONNECTION_NOT_FOUND" });
  });

  it("catalog ownership faults propagate loud; resolve faults rethrow past the disabled catch", async () => {
    const { id } = await seedConn();
    await syncMcpCatalog(bindings.DB, PRINCIPAL, id, { tools: [{ name: "search" }] });
    const origPrepare = bindings.DB.prepare.bind(bindings.DB);
    const ownedBoom = vi.spyOn(bindings.DB, "prepare").mockImplementation(((sql: string, ...rest: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM mcp_connections WHERE org_id")) throw new Error("boom-owned");
      return (origPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof bindings.DB.prepare);
    await expect(listMcpCatalog(bindings.DB, PRINCIPAL, id)).rejects.toThrow("boom-owned");
    ownedBoom.mockRestore();
    const resolveBoom = vi.spyOn(bindings.DB, "prepare").mockImplementation(((sql: string, ...rest: unknown[]) => {
      if (typeof sql === "string" && sql.includes("FROM mcp_tool_catalog")) throw new Error("boom-resolve");
      return (origPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof bindings.DB.prepare);
    await expect(setMcpCatalogToolEnabled(bindings.DB, PRINCIPAL, id, "search", true)).rejects.toThrow("boom-resolve");
    resolveBoom.mockRestore();
  });

  it("token stores reject missing KEK, absent rows load null, partial refresh rows are unreadable", async () => {
    const { id } = await seedConn();
    await expect(
      storeInitialMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        accessToken: "x",
        kekMaterial: "",
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "SECRET_STORE_NOT_CONFIGURED" });
    await expect(
      storeInitialMcpUserConsent(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        userId: MEMBER_USER,
        accessToken: "x",
        kekMaterial: "",
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "SECRET_STORE_NOT_CONFIGURED" });
    expect(await loadMcpServiceToken(bindings.DB, ORG_A, id, keks)).toBeNull();
    expect(await loadMcpUserConsent(bindings.DB, ORG_A, id, MEMBER_USER, keks)).toBeNull();
    await storeInitialMcpServiceToken(bindings.DB, {
      orgId: ORG_A,
      connectionId: id,
      accessToken: "a",
      refreshToken: "r",
      scope: "s",
      expiresAtMs: Date.now() + 3_600_000,
      kekMaterial: KEK,
      checkedAt: AT,
    });
    await bindings.DB.prepare("UPDATE mcp_service_tokens SET refresh_nonce=NULL WHERE connection_id=?").bind(id).run();
    await expect(loadMcpServiceToken(bindings.DB, ORG_A, id, keks)).rejects.toMatchObject({
      code: "MCP_TOKEN_UNREADABLE",
    });
  });

  it("replaces on owned-but-tokenless connections report absence, not success", async () => {
    const { id } = await seedConn();
    await expect(
      replaceMcpServiceToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: id,
        expectedGeneration: 1,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_TOKEN_NOT_FOUND" });
    await expect(
      replaceMcpUserConsentToken(bindings.DB, {
        orgId: ORG_A,
        connectionId: FOREIGN,
        userId: MEMBER_USER,
        expectedGeneration: 1,
        accessToken: "a",
        kekMaterial: KEK,
        checkedAt: AT,
      }),
    ).rejects.toMatchObject({ code: "MCP_CONNECTION_NOT_FOUND" });
  });
});

describe("MCP consent exchange default arms", () => {
  const bareToken = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(TOKEN_PATH)) return Response.json({ access_token: "bare-vendor-token", token_type: "Bearer" });
    throw new Error(`unexpected outbound ${url}`);
  }) as typeof fetch;

  async function seedPair(flow: string): Promise<string> {
    const serverId = (
      await createMcpServerTemplate(bindings.DB, PRINCIPAL, ADMIN, {
        name: `branch-x-${Math.random().toString(36).slice(2, 8)}`,
        serverUrl: SERVER_URL,
        providerFlow: flow,
        orgId: ORG_A,
      })
    ).id;
    const id = (
      await createMcpConnection(bindings.DB, PRINCIPAL, { serverId, clientId: CLIENT_ID, tokenPath: TOKEN_PATH })
    ).id;
    await putMcpConnectionClientSecret(bindings.DB, PRINCIPAL, id, CLIENT_SECRET, KEK);
    return id;
  }

  it("user consent completion stores then replaces a bare vendor token without scope", async () => {
    const id = await seedPair("authorization_code");
    const base = {
      connectionId: id,
      code: "c1",
      state: "s",
      expectedState: "s",
      codeVerifier: "v",
      redirectUri: REDIRECT_URI,
      fetchImpl: bareToken,
      timeoutMs: 5000,
    };
    const stored = await completeMcpUserConsent(bindings.DB, PRINCIPAL, base, { SECRETS_KEK: KEK });
    expect(stored).toMatchObject({ generation: 1, scope: "" });
    const replaced = await completeMcpUserConsent(
      bindings.DB,
      PRINCIPAL,
      { ...base, code: "c2" },
      { SECRETS_KEK: KEK },
    );
    expect(replaced).toMatchObject({ generation: 2, scope: "" });
  });

  it("service connect stores then replaces a bare vendor token", async () => {
    const id = await seedPair("client_credentials");
    const base = { connectionId: id, fetchImpl: bareToken, timeoutMs: 5000 };
    const stored = await connectMcpServiceCredential(bindings.DB, PRINCIPAL, base, { SECRETS_KEK: KEK });
    expect(stored).toMatchObject({ generation: 1, scope: "" });
    const replaced = await connectMcpServiceCredential(bindings.DB, PRINCIPAL, base, { SECRETS_KEK: KEK });
    expect(replaced).toMatchObject({ generation: 2, scope: "" });
  });
});
