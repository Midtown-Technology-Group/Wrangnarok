// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171): centralized MCP credential resolution — the
// five-path table (`auth_resolution.py` pins in docs/upstream-spec.md §23,
// namespace policy P0 D3).
//
// Paths: (1) chat caller + healthy per-user consent → user token;
// (2) chat caller without one + `available_in_chat` + healthy service token
// → service fallback; (3) chat caller with no fallback → needs-reauth
// (`authorization_code`, carrying a server-built reauth URL) or
// misconfigured (`client_credentials` — only an admin enabling the flag or
// provisioning the service credential can fix it); (4) autonomous caller
// (an explicit Connection-owned service principal, never ambient authority
// — P0 D1.2) + `available_to_autonomous` + healthy service token → service;
// (5) autonomous otherwise → misconfigured (a planner bug made visible,
// never a silent fallback).
//
// Hard rule threading every path: a user-identity auth failure resolves to
// needs-reauth, never to the service identity. The chat service fallback
// (path 2) survives only as an explicit admin decision via the
// `available_in_chat` flag — never a silent upgrade. Freshness uses the
// shared 5-minute skew (`OAUTH_EXPIRY_SKEW_MS`): `expires_at` NULL counts
// as fresh (unknown expiry — the vendor rejects first use). Health checks
// are uncached by construction: callers pass freshly read state, so
// revocation fails closed on the next call.
//
// This module is pure over non-secret token state. D1 reads (service state
// plus consent view) and the single inline refresh attempt live in the
// dispatch layer (`src/mcp-dispatch.ts`), which re-resolves after a failed
// refresh so the failure falls through to the next path naturally.
import { Fault } from "./domain";
import { isTokenExpired, isTokenUsable, OAUTH_EXPIRY_SKEW_MS } from "./oauth";
import type { TokenHealth } from "./oauth";

/** Chat caller (a user identity) or autonomous caller (an explicit
 * Connection-owned service principal naming the Connection it may use). */
export type McpCaller =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "autonomous"; readonly serviceConnectionId: string };

/** Non-secret credential inputs: freshly read service state plus the
 * caller's consent state (null when none). Health here is the persisted
 * lifecycle — revocation fails closed because the next call rereads it. */
export interface McpCredentialInputs {
  readonly connection: {
    readonly id: string;
    readonly providerFlow: "authorization_code" | "client_credentials" | "none";
    readonly availableInChat: boolean;
    readonly availableToAutonomous: boolean;
  };
  readonly service: {
    readonly generation: number;
    readonly expiresAtMs?: number;
    readonly health: TokenHealth;
  } | null;
  readonly user: {
    readonly generation: number;
    readonly expiresAtMs?: number;
    readonly health: TokenHealth;
  } | null;
  readonly nowMs: number;
}

export type McpResolution =
  | { readonly kind: "user" }
  | { readonly kind: "service" }
  | { readonly kind: "needs-reauth"; readonly providerFlow: "authorization_code" }
  | { readonly kind: "misconfigured"; readonly reason: string };

/** Fresh + usable: healthy lifecycle and outside the expiry skew margin.
 * NULL expiry counts as fresh — the vendor rejects first use. Pure. */
export function isMcpCredentialUsable(
  state: { readonly expiresAtMs?: number; readonly health: TokenHealth } | null,
  nowMs: number,
): boolean {
  if (!state) return false;
  return isTokenUsable(state.health) && !isTokenExpired(state, nowMs, OAUTH_EXPIRY_SKEW_MS);
}

/** Resolve one (Connection, caller) to its credential identity. Pure —
 * every branch is pinned by `test/mcp-auth-resolution.test.ts`, including
 * the no-privilege-fallback rule. */
export function resolveMcpCredential(caller: McpCaller, inputs: McpCredentialInputs): McpResolution {
  const { connection, service, user, nowMs } = inputs;
  if (caller.kind === "user") {
    if (isMcpCredentialUsable(user, nowMs)) return Object.freeze({ kind: "user" as const });
    if (connection.availableInChat && isMcpCredentialUsable(service, nowMs)) {
      return Object.freeze({ kind: "service" as const });
    }
    if (connection.providerFlow === "authorization_code") {
      return Object.freeze({ kind: "needs-reauth" as const, providerFlow: "authorization_code" as const });
    }
    return Object.freeze({
      kind: "misconfigured" as const,
      reason:
        connection.providerFlow === "client_credentials"
          ? "This Connection needs an admin-provisioned service credential before chat can use it."
          : "This Connection has no usable credential for chat.",
    });
  }
  // Autonomous callers carry no user identity to fall back from (paths
  // 4/5): the service principal must name this Connection exactly, or the
  // call is misconfigured — ambient authority never resolves.
  if (caller.serviceConnectionId.toLowerCase() !== connection.id.toLowerCase()) {
    return Object.freeze({
      kind: "misconfigured" as const,
      reason: "The autonomous service principal does not name this Connection.",
    });
  }
  if (connection.availableToAutonomous && isMcpCredentialUsable(service, nowMs)) {
    return Object.freeze({ kind: "service" as const });
  }
  return Object.freeze({
    kind: "misconfigured" as const,
    reason: connection.availableToAutonomous
      ? "This Connection has no usable service credential for autonomous runs."
      : "This Connection is not available to autonomous runs.",
  });
}

/** Map a non-identity resolution to its denial Fault. Needs-reauth carries
 * the server-built reconnect affordance; misconfigured fails loud for the
 * operator. Pure. */
export function mcpResolutionFault(resolution: McpResolution, reauthUrl?: string): Fault {
  if (resolution.kind === "needs-reauth") {
    return reauthUrl === undefined
      ? new Fault(403, "MCP_NEEDS_REAUTH", "Reconnect this MCP Connection before using its tools.")
      : new Fault(403, "MCP_NEEDS_REAUTH", "Reconnect this MCP Connection before using its tools.", {
          reauthUrl,
        });
  }
  if (resolution.kind === "misconfigured") {
    return new Fault(424, "MCP_MISCONFIGURED", resolution.reason);
  }
  throw new Fault(500, "INTERNAL_ERROR", "The MCP credential resolution is invalid.");
}
