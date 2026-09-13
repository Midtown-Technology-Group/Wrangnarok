// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): generator tests. Pure node-safe: no bindings, no D1,
// no Workflows, no vendor HTTP. A Halo-shaped fixture proves the exit:
// converts to a compiling-shaped module or fails loudly with the gap.
import { describe, expect, it } from "vitest";
import { Fault } from "../src/domain";
import { generateIntegrationModule } from "../src/generate-integration";

const DIGEST = "ab".repeat(32);

function haloShaped() {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { version: "halo-lab-1", title: "HaloPSA lab proof" },
    servers: [{ url: "https://halo-lab.example.com" }],
    paths: {
      "/api/Tickets/{id}": {
        get: { operationId: "Ticket_Get", summary: "Get one ticket by id." },
        delete: { operationId: "Ticket_Delete", summary: "Delete one ticket (destructive)." },
      },
      "/api/Tickets/{id}/Notes": {
        post: { operationId: "Ticket_AddNote", summary: "Add a note to one ticket." },
      },
    },
  });
}

function opts() {
  return {
    id: "halo",
    name: "halo",
    allowedOrigins: ["https://halo-lab.example.com"],
    classifications: { Ticket_Delete: "destructive" as const },
  };
}

describe("INT-01 generator (issue #229)", () => {
  it("emits a self-contained module from a Halo-shaped spec", () => {
    const out = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    expect(out.fileName).toBe("halo.ts");
    expect(out.operationCount).toBe(3);
    expect(out.specDigest).toBe(DIGEST);
    // Self-contained identity: no domain import for the ID.
    expect(out.source).toContain(`export const HALO_INTEGRATION_ID = "halo";`);
    // Spec digest and version in the header.
    expect(out.source).toContain(`// Spec digest: ${DIGEST}`);
    expect(out.source).toContain("// Spec version: halo-lab-1");
    // Risk classifications flow through (method default refined).
    expect(out.source).toContain(`"Ticket_Get": "read"`);
    expect(out.source).toContain(`"Ticket_Delete": "destructive"`);
    expect(out.source).toContain(`"Ticket_AddNote": "mutation"`);
    // Operator allowlist, never the spec servers entries.
    expect(out.source).toContain(`"https://halo-lab.example.com"`);
    // Host-mediated execute plus provenance, scrubbed results.
    expect(out.source).toContain("executeHaloOperation");
    expect(out.source).toContain("scrubValueWithSecrets");
    expect(out.source).toContain("buildProvenance");
    // No secret VALUES embedded (interface field names are the contract):
    // no credential literals, no endpoint values beyond the allowlist.
    expect(out.source).not.toMatch(/clientSecret\s*[:=]\s*["'][^"']+["']/);
    expect(out.source).not.toContain("halo-lab.example.com/api");
  });

  it("is deterministic: same spec plus same options yields identical source", () => {
    const first = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    const second = generateIntegrationModule(haloShaped(), opts(), DIGEST);
    expect(second.source).toBe(first.source);
  });

  it("fails loudly on structural defects and bad options", () => {
    expect(() => generateIntegrationModule("not-json", opts(), DIGEST)).toThrow(Fault);
    expect(() => generateIntegrationModule(JSON.stringify({ openapi: "3.0.0" }), opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
    expect(() => generateIntegrationModule(haloShaped(), { ...opts(), id: "Bad!" }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
    expect(() => generateIntegrationModule(haloShaped(), { ...opts(), allowedOrigins: [] }, DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_OPTIONS" }),
    );
  });

  it("rejects oversized specs before parsing", () => {
    const big = " ".repeat(2 * 1024 * 1024 + 1);
    expect(() => generateIntegrationModule(big, opts(), DIGEST)).toThrow(
      expect.objectContaining({ code: "GENERATOR_INVALID_SPEC" }),
    );
  });
});
