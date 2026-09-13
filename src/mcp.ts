// SPDX-License-Identifier: AGPL-3.0
// TOOL-01 (issue #170) inbound MCP gateway (ADR 022): a compact,
// standards-shaped surface over Wrangnarok-authorized capabilities.
//
// External agents authenticate exactly like every other /api/* caller (the
// membership gate in src/index.ts proves authorization before any gateway
// code runs). Discovery and invocation share one policy: only enrolled,
// enabled, revision-current tools appear, and Code Mode operations execute
// only through the host-mediated request path — never as eager per-endpoint
// MCP tools, never with Connection credentials in view.
//
// Protocol: JSON-RPC 2.0 over POST with three methods — tools/list,
// tools/call, plus the tools/search + tools/describe pair that keeps large
// Code Mode surfaces progressive. Every response carries sanitized results;
// every denial carries a machine-readable code the caller switches on.
import { Fault } from "./domain";
import type { Principal } from "./domain";

/** Gateway methods. tools/list + tools/call are the MCP-shaped core;
 * tools/search + tools/describe keep Code Mode discovery progressive. */
export const MCP_METHODS = ["tools/list", "tools/call", "tools/search", "tools/describe"] as const;
export type McpMethod = (typeof MCP_METHODS)[number];

export interface McpRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface McpToolView {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object" };
}

export interface McpCallResult {
  readonly tool: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Parse one JSON-RPC 2.0 request body. Malformed envelopes fail with
 * MCP_INVALID_REQUEST (never a crash, never a 500 for caller errors). */
export function parseMcpRequest(body: unknown): McpRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Fault(400, "MCP_INVALID_REQUEST", "The MCP request must be a JSON-RPC 2.0 object.");
  }
  const record = body as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") {
    throw new Fault(400, "MCP_INVALID_REQUEST", "Only JSON-RPC 2.0 requests are accepted.");
  }
  if (!MCP_METHODS.includes(record.method as McpMethod)) {
    throw new Fault(400, "MCP_UNKNOWN_METHOD", "Unknown MCP method.");
  }
  if (record.id !== null && record.id !== undefined && typeof record.id !== "string" && typeof record.id !== "number") {
    throw new Fault(400, "MCP_INVALID_REQUEST", "The MCP request id must be a string, number, or null.");
  }
  return {
    jsonrpc: "2.0",
    id: (record.id ?? null) as string | number | null,
    method: record.method as string,
    ...(record.params === undefined ? {} : { params: record.params }),
  };
}

/** Parse tools/call params: exact tool name plus a JSON-object argument. */
export function parseMcpCallParams(params: unknown): { tool: string; input: unknown } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Fault(400, "MCP_INVALID_PARAMS", "tools/call needs a tool name and input object.");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.tool !== "string" || record.tool.length === 0 || record.tool.length > 64) {
    throw new Fault(400, "MCP_INVALID_PARAMS", "tools/call needs a tool name.");
  }
  if (record.input !== undefined && (record.input === null || typeof record.input !== "object")) {
    throw new Fault(400, "MCP_INVALID_PARAMS", "tools/call input must be a JSON object when provided.");
  }
  return { tool: record.tool, input: record.input ?? {} };
}

/** Parse tools/search params: a bounded free-text query. */
export function parseMcpSearchParams(params: unknown): { query: string } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Fault(400, "MCP_INVALID_PARAMS", "tools/search needs a query string.");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.query !== "string" || record.query.trim().length === 0 || record.query.length > 128) {
    throw new Fault(400, "MCP_INVALID_PARAMS", "tools/search needs a query of 1-128 chars.");
  }
  return { query: record.query.trim() };
}

/** Parse tools/describe params: one exact operation or tool name. */
export function parseMcpDescribeParams(params: unknown): { name: string } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Fault(400, "MCP_INVALID_PARAMS", "tools/describe needs a name.");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0 || record.name.length > 128) {
    throw new Fault(400, "MCP_INVALID_PARAMS", "tools/describe needs a name of 1-128 chars.");
  }
  return { name: record.name };
}

/** Filter tool views by a free-text query (case-insensitive substring over
 * name + description). Pure: the caller pre-filters by authorization, this
 * only narrows text. */
export function searchTools(tools: readonly McpToolView[], query: string): readonly McpToolView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return Object.freeze([]);
  return Object.freeze(
    tools
      .filter((tool) => tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle))
      .slice(0, 25),
  );
}

/** Envelope one JSON-RPC result. Errors serialize as { code, message } tool
 * results (call-level), while envelope faults (auth/parse/unknown-method)
 * throw Fault and ride the standard Worker error path. */
export function mcpResult(
  id: string | number | null,
  result: unknown,
): { jsonrpc: "2.0"; id: string | number | null; result: unknown } {
  return { jsonrpc: "2.0", id, result };
}

/** The gateway never invents authority: this marker interface documents that
 * every gateway execution receives an already-authorized Principal from the
 * membership gate in src/index.ts. MCP-client auth and vendor Connection
 * auth stay separate boundaries (ADR 022 invariant 9). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- marker: the Principal type IS the authorization proof
export interface AuthorizedMcpCaller extends Principal {}
