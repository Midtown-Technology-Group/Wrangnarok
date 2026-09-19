// SPDX-License-Identifier: AGPL-3.0
// TOOL-02 (issue #171) S2: the centralized five-path credential table.
// Pure unit coverage over `src/mcp-auth.ts` — no D1, no vendor HTTP. Pins
// every path (user chat / service-chat fallback / needs-reauth /
// autonomous / misconfigured), the 5-minute freshness margin with NULL
// expiry counting as fresh, uncached health failing closed, and the hard
// no-privilege-fallback rule: a user-identity failure never resolves to
// the service identity.
import { describe, expect, it } from "vitest";
import { Fault } from "../src/domain";
import { isMcpCredentialUsable, mcpResolutionFault, resolveMcpCredential } from "../src/mcp-auth";
import type { McpCredentialInputs } from "../src/mcp-auth";
import { OAUTH_EXPIRY_SKEW_MS } from "../src/oauth";
import type { TokenHealth } from "../src/oauth";

const NOW = 1_800_000_000_000;
const FRESH = NOW + 3_600_000;
const EXPIRY = "2026-09-18T00:00:00.000Z";

function health(status: TokenHealth["status"] = "healthy"): TokenHealth {
  return { status, checkedAt: EXPIRY, consecutiveFailures: 0, lastFailureCode: null, lastSuccessAt: null };
}

function inputs(overrides: Partial<McpCredentialInputs> = {}): McpCredentialInputs {
  return {
    connection: {
      id: "11111111-1111-4111-8111-111111111111",
      providerFlow: "authorization_code",
      availableInChat: false,
      availableToAutonomous: false,
    },
    service: null,
    user: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe("MCP five-path credential resolution (TOOL-02 S2)", () => {
  it("path 1: chat caller with a healthy per-user consent resolves user — user wins ties", () => {
    const resolution = resolveMcpCredential(
      { kind: "user", userId: "u" },
      inputs({
        connection: {
          id: "11111111-1111-4111-8111-111111111111",
          providerFlow: "authorization_code",
          availableInChat: true,
          availableToAutonomous: true,
        },
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
        user: { generation: 2, expiresAtMs: FRESH, health: health() },
      }),
    );
    expect(resolution).toEqual({ kind: "user" });
  });

  it("path 2: chat caller without consent falls back to service only via available_in_chat", () => {
    const fallback = resolveMcpCredential(
      { kind: "user", userId: "u" },
      inputs({
        connection: {
          id: "11111111-1111-4111-8111-111111111111",
          providerFlow: "authorization_code",
          availableInChat: true,
          availableToAutonomous: false,
        },
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
      }),
    );
    expect(fallback).toEqual({ kind: "service" });

    const noFlag = resolveMcpCredential(
      { kind: "user", userId: "u" },
      inputs({
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
      }),
    );
    expect(noFlag.kind).toBe("needs-reauth");
  });

  it("failed user consent falls through to the explicit service flag, never silently", () => {
    const fellThrough = resolveMcpCredential(
      { kind: "user", userId: "u" },
      inputs({
        connection: {
          id: "11111111-1111-4111-8111-111111111111",
          providerFlow: "authorization_code",
          availableInChat: true,
          availableToAutonomous: false,
        },
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
        user: { generation: 2, health: health("failed") },
      }),
    );
    expect(fellThrough).toEqual({ kind: "service" });
  });

  it("no-privilege-fallback: failed user consent without the flag needs reauth, never service", () => {
    const resolution = resolveMcpCredential(
      { kind: "user", userId: "u" },
      inputs({
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
        user: { generation: 2, health: health("failed") },
      }),
    );
    expect(resolution.kind).toBe("needs-reauth");
  });

  it("path 3: client_credentials without fallback is misconfigured, not reauth", () => {
    const resolution = resolveMcpCredential(
      { kind: "user", userId: "u" },
      inputs({
        connection: {
          id: "11111111-1111-4111-8111-111111111111",
          providerFlow: "client_credentials",
          availableInChat: false,
          availableToAutonomous: false,
        },
        service: { generation: 1, health: health("failed") },
      }),
    );
    expect(resolution.kind).toBe("misconfigured");
    const fault = mcpResolutionFault(resolution, "https://local.test/reauth");
    expect(fault).toBeInstanceOf(Fault);
    expect(fault.status).toBe(424);
    expect(fault.code).toBe("MCP_MISCONFIGURED");
  });

  it("needs-reauth carries the server-built reconnect affordance", () => {
    const resolution = resolveMcpCredential({ kind: "user", userId: "u" }, inputs());
    const fault = mcpResolutionFault(resolution, "https://local.test/api/mcp-connections/c/consent/authorize");
    expect(fault.status).toBe(403);
    expect(fault.code).toBe("MCP_NEEDS_REAUTH");
    expect(fault.details).toEqual({ reauthUrl: "https://local.test/api/mcp-connections/c/consent/authorize" });
  });

  it("path 4: autonomous service principal naming the Connection resolves service", () => {
    const resolution = resolveMcpCredential(
      { kind: "autonomous", serviceConnectionId: "11111111-1111-4111-8111-111111111111" },
      inputs({
        connection: {
          id: "11111111-1111-4111-8111-111111111111",
          providerFlow: "client_credentials",
          availableInChat: false,
          availableToAutonomous: true,
        },
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
        user: { generation: 9, expiresAtMs: FRESH, health: health() },
      }),
    );
    expect(resolution).toEqual({ kind: "service" });
  });

  it("path 5: autonomous without the flag, without a token, or with a foreign principal is misconfigured", () => {
    const base = {
      providerFlow: "client_credentials" as const,
      availableInChat: false,
      availableToAutonomous: true,
    };
    const noToken = resolveMcpCredential(
      { kind: "autonomous", serviceConnectionId: "11111111-1111-4111-8111-111111111111" },
      inputs({
        connection: { id: "11111111-1111-4111-8111-111111111111", ...base },
      }),
    );
    expect(noToken.kind).toBe("misconfigured");

    const flagOff = resolveMcpCredential(
      { kind: "autonomous", serviceConnectionId: "11111111-1111-4111-8111-111111111111" },
      inputs({
        connection: { id: "11111111-1111-4111-8111-111111111111", ...base, availableToAutonomous: false },
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
      }),
    );
    expect(flagOff.kind).toBe("misconfigured");

    const foreign = resolveMcpCredential(
      { kind: "autonomous", serviceConnectionId: "22222222-2222-4222-8222-222222222222" },
      inputs({
        connection: { id: "11111111-1111-4111-8111-111111111111", ...base },
        service: { generation: 1, expiresAtMs: FRESH, health: health() },
      }),
    );
    expect(foreign.kind).toBe("misconfigured");
  });

  it("freshness: 5-minute margin, NULL expiry fresh, revoked never usable", () => {
    expect(OAUTH_EXPIRY_SKEW_MS).toBe(5 * 60 * 1000);
    expect(isMcpCredentialUsable(null, NOW)).toBe(false);
    expect(isMcpCredentialUsable({ health: health("revoked") }, NOW)).toBe(false);
    expect(isMcpCredentialUsable({ health: health() }, NOW)).toBe(true);
    expect(isMcpCredentialUsable({ expiresAtMs: NOW + OAUTH_EXPIRY_SKEW_MS + 1, health: health() }, NOW)).toBe(true);
    expect(isMcpCredentialUsable({ expiresAtMs: NOW + OAUTH_EXPIRY_SKEW_MS, health: health() }, NOW)).toBe(false);
    expect(isMcpCredentialUsable({ expiresAtMs: NOW - 1, health: health() }, NOW)).toBe(false);
  });

  it("fault mapping an identity resolution is a programmer error, never a denial", () => {
    expect(() => mcpResolutionFault({ kind: "user" })).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(() => mcpResolutionFault({ kind: "service" })).toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });
});
