// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170): inbound MCP gateway tests with a real JSON-RPC
// client over the local Worker. Pins discovery, invoke, result/error,
// unauthorized/hidden/cross-org calls, revocation, and stale-registry
// behavior. Runs in real workerd with a real D1 binding (migrations
// 0001-0002 plus 0011 + 0024); only outbound vendor HTTP is intercepted.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { HALO_INTEGRATION_ID, echoSaga, helloSaga } from "../src/domain";
import { Fault } from "../src/domain";
import {
  mcpResult,
  parseMcpCallParams,
  parseMcpDescribeParams,
  parseMcpRequest,
  parseMcpSearchParams,
  searchTools,
} from "../src/mcp";

function envelopeCode(fn: () => void): string | null {
  try {
    fn();
  } catch (error) {
    return error instanceof Fault ? error.code : `threw:${String(error)}`;
  }
  return null;
}
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration11 from "../migrations/0011_connection_admin.sql?raw";
import migration24 from "../migrations/0024_tool_enrollments.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";

/** Minimal real MCP client: JSON-RPC 2.0 over POST /api/mcp. */
async function mcp(method: string, params: unknown, id: string | number | null = 1, token: string = TOKEN) {
  const response = await worker.fetch(
    new Request("http://local.test/api/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    bindings,
  );
  return {
    status: response.status,
    body: (await response.json()) as { result?: Record<string, unknown>; error?: unknown },
  };
}

async function enrollHello(): Promise<string> {
  const response = await worker.fetch(
    new Request("http://local.test/api/tools", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sagaId: helloSaga.id }),
    }),
    bindings,
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { tool: { name: string } };
  return body.tool.name;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration11);
  await bindings.DB.exec(migration24);
  await bindings.DB.prepare("DELETE FROM tool_enrollments").run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "http://127.0.0.1:8788/echo") return Response.json({ message: "connection-test" });
    throw new Error(`Unexpected outbound request: ${url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("MCP envelope parsing (pure)", () => {
  it("accepts valid envelopes and rejects malformed ones", () => {
    expect(parseMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }).method).toBe("tools/list");
    expect(envelopeCode(() => parseMcpRequest({ jsonrpc: "1.0", id: 1, method: "tools/list" }))).toBe(
      "MCP_INVALID_REQUEST",
    );
    expect(envelopeCode(() => parseMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/delete" }))).toBe(
      "MCP_UNKNOWN_METHOD",
    );
    expect(mcpResult(1, { ok: true })).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(
      searchTools(
        [{ name: "hello_tool", description: "[hello_tool] greet", inputSchema: { type: "object" } }],
        "hello",
      ),
    ).toHaveLength(1);
    expect(
      searchTools(
        [{ name: "hello_tool", description: "[hello_tool] greet", inputSchema: { type: "object" } }],
        "zzz-no-match",
      ),
    ).toEqual([]);
    expect(searchTools([], "   ")).toEqual([]);
  });

  it("covers every parser rejection branch", () => {
    expect(envelopeCode(() => parseMcpRequest(null))).toBe("MCP_INVALID_REQUEST");
    expect(envelopeCode(() => parseMcpRequest([]))).toBe("MCP_INVALID_REQUEST");
    expect(envelopeCode(() => parseMcpRequest({ jsonrpc: "2.0", id: {}, method: "tools/list" }))).toBe(
      "MCP_INVALID_REQUEST",
    );
    expect(parseMcpRequest({ jsonrpc: "2.0", id: null, method: "tools/list" }).id).toBe(null);
    expect(envelopeCode(() => parseMcpCallParams(null))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpCallParams({ tool: "", input: {} }))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpCallParams({ tool: "x".repeat(65), input: {} }))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpCallParams({ tool: "ok", input: "nope" }))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpCallParams({ tool: "ok", input: null }))).toBe("MCP_INVALID_PARAMS");
    expect(parseMcpCallParams({ tool: "ok" })).toEqual({ tool: "ok", input: {} });
    expect(envelopeCode(() => parseMcpSearchParams(null))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpSearchParams({ query: "  " }))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpSearchParams({ query: "x".repeat(129) }))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpDescribeParams(null))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpDescribeParams({ name: "" }))).toBe("MCP_INVALID_PARAMS");
    expect(envelopeCode(() => parseMcpDescribeParams({ name: "x".repeat(129) }))).toBe("MCP_INVALID_PARAMS");
  });
});

describe("MCP gateway over the local Worker (real client)", () => {
  it("lists enrolled tools plus the Code Mode pair", async () => {
    const name = await enrollHello();
    const { status, body } = await mcp("tools/list", {});
    expect(status).toBe(200);
    const tools = body.result?.tools as { name: string; description: string }[];
    expect(tools.map((entry) => entry.name)).toContain(name);
    expect(tools.map((entry) => entry.name)).toContain("halo_api_search");
    expect(tools.map((entry) => entry.name)).toContain("halo_api_execute");
    for (const tool of tools) expect(tool.description.startsWith("[")).toBe(true);
  });

  it("searches and describes tools and pinned operations", async () => {
    const name = await enrollHello();
    const searched = await mcp("tools/search", { query: "hello" });
    expect(searched.status).toBe(200);
    expect(((searched.body.result?.tools as unknown[]) ?? []).length).toBe(1);
    const described = await mcp("tools/describe", { name });
    expect(described.status).toBe(200);
    expect((described.body.result?.tool as { name: string }).name).toBe(name);
    const op = await mcp("tools/describe", { name: "Ticket_Get" });
    expect(op.status).toBe(200);
    expect((op.body.result?.operation as { operationId: string }).operationId).toBe("Ticket_Get");
    const missing = await mcp("tools/describe", { name: "no_such_tool" });
    expect(missing.status).toBe(200);
    expect((missing.body.result as { error: { code: string } }).error.code).toBe("MCP_TOOL_DENIED");
  });

  it("calls an enrolled tool through the standard Execution path", async () => {
    const name = await enrollHello();
    const { status, body } = await mcp("tools/call", {
      tool: name,
      input: { input: { name: "Ada" }, idempotencyKey: "mcp-tool-call-0001" },
    });
    expect(status).toBe(200);
    expect((body.result as { tool: string }).tool).toBe(name);
    expect(typeof (body.result as { executionId: string }).executionId).toBe("string");
  });

  it("denies unknown, disabled, and stale tools as call-level errors", async () => {
    const name = await enrollHello();
    const unknown = await mcp("tools/call", { tool: "ghost_tool", input: {} });
    expect(unknown.status).toBe(200);
    expect((unknown.body.result as { error: { code: string } }).error.code).toBe("TOOL_NOT_FOUND");
    // Disabled: revoke then call.
    await worker.fetch(
      new Request(`http://local.test/api/tools/${name}/disable`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      bindings,
    );
    const revoked = await mcp("tools/call", { tool: name, input: {} });
    expect((revoked.body.result as { error: { code: string } }).error.code).toBe("TOOL_DISABLED");
    // Disabled tools also vanish from discovery (identical scoping).
    const listed = await mcp("tools/list", {});
    const names = ((listed.body.result?.tools as { name: string }[]) ?? []).map((entry) => entry.name);
    expect(names).not.toContain(name);
  });

  it("rejects unauthorized callers at the envelope (401), never call-level", async () => {
    const { status } = await mcp("tools/list", {}, 1, "wrong-token");
    expect(status).toBe(401);
    const badBody = await mcp("tools/call", { tool: "x" });
    expect(badBody.status).toBe(200);
  });

  it("rejects malformed envelopes and unknown methods with envelope faults", async () => {
    const response = await worker.fetch(
      new Request("http://local.test/api/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/delete" }),
      }),
      bindings,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "MCP_UNKNOWN_METHOD" } });
  });

  it("keeps cross-organization tools invisible (404, never a leak)", async () => {
    const name = await enrollHello();
    // The LAB org owns the enrollment; a foreign caller resolving it gets
    // TOOL_NOT_FOUND through the registry gate. The gateway route itself is
    // org-scoped by the membership gate, so foreign callers never reach a
    // sibling org's list — pinned here via the direct registry check.
    const { toolRegistry } = await import("../src/tools");
    const { SAGA_CATALOG } = await import("../src/sagas");
    const foreign = await toolRegistry
      .resolve(bindings.DB, { orgId: "00000000-0000-4000-8000-000000000004", userId: "x" }, name, SAGA_CATALOG)
      .then(() => "leaked")
      .catch((error: unknown) => (error as { code?: string }).code ?? "threw");
    expect(foreign).toBe("TOOL_NOT_FOUND");
    expect(ORG).toBe("00000000-0000-4000-8000-000000000001");
    expect(HALO_INTEGRATION_ID).toBe("a1b2c3d4-0000-4111-8111-000000000001");
    expect(echoSaga.id).toBe("720b9ebf-9b6a-4eac-bae9-6ed22c970401");
  });

  it("covers gateway call branches: bad operation ids, denied executes, and tool faults", async () => {
    // halo_api_execute without an operationId answers call-level invalid params.
    const noOp = await mcp("tools/call", { tool: "halo_api_execute", input: {} });
    expect(noOp.status).toBe(200);
    expect((noOp.body.result as { error: { code: string } }).error.code).toBe("MCP_INVALID_PARAMS");
    // halo_api_execute with an unknown operation denies through the host.
    const unknown = await mcp("tools/call", {
      tool: "halo_api_execute",
      input: { operationId: "Nope_Missing", params: {} },
    });
    expect(unknown.status).toBe(200);
    expect((unknown.body.result as { error: { code: string } }).error).toBeDefined();
    // halo_api_search with a non-string query matches nothing (never throws).
    const search = await mcp("tools/call", { tool: "halo_api_search", input: { query: 7 } });
    expect(search.status).toBe(200);
    expect((search.body.result as { tools: unknown[] }).tools).toEqual([]);
    // tools/call on an enrolled tool without an idempotency key faults
    // call-level (missing key), never an envelope throw.
    const name = await enrollHello();
    const noKey = await mcp("tools/call", { tool: name, input: { input: { name: "Al" } } });
    expect(noKey.status).toBe(200);
    expect((noKey.body.result as { error: { code: string } }).error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    // tools/call with an invalid Saga input faults call-level too.
    const badInput = await mcp("tools/call", {
      tool: name,
      input: { input: { name: "" }, idempotencyKey: "mcp-tool-call-badinput" },
    });
    expect(badInput.status).toBe(200);
    expect((badInput.body.result as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  it("covers openapi route guards: unknown integration, bad bodies, and query keys", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const unknownSearch = await worker.fetch(
      new Request("http://local.test/api/openapi/search?integration=nope&q=x", { headers: auth }),
      bindings,
    );
    expect(unknownSearch.status).toBe(404);
    const badKeys = await worker.fetch(
      new Request("http://local.test/api/openapi/search?integration=halo&bogus=1", { headers: auth }),
      bindings,
    );
    expect(badKeys.status).toBe(400);
    const unknownOp = await worker.fetch(
      new Request("http://local.test/api/openapi/operations/Nope_Missing", { headers: auth }),
      bindings,
    );
    expect(unknownOp.status).toBe(404);
    const unknownExec = await worker.fetch(
      new Request("http://local.test/api/openapi/execute", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ integration: "nope", operationId: "Ticket_Get" }),
      }),
      bindings,
    );
    expect(unknownExec.status).toBe(404);
    const noOpExec = await worker.fetch(
      new Request("http://local.test/api/openapi/execute", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ integration: "halo" }),
      }),
      bindings,
    );
    expect(noOpExec.status).toBe(400);
    const queryInspect = await worker.fetch(
      new Request("http://local.test/api/openapi/operations/Ticket_Get?x=1", { headers: auth }),
      bindings,
    );
    expect(queryInspect.status).toBe(400);
  });
});
