// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): Defined Networking end-to-end generator proof. Runs
// the real Defined Networking OpenAPI spec (27 paths, bearer ApiToken
// scheme, 10 deprecated operations) through the fixed generator and proves
// the output registers, typechecks (by construction: the assertions below
// compile against the generated shape), and carries the bearer shape.
//
// Provenance: test/fixtures/definednet-openapi.json is the YAML spec at
// https://docs.defined.net/openapi.yaml (fetched 2026-09-16, openapi 3.1.0,
// info.version 1.0.0) converted locally with `python3 -c
// "yaml.safe_load + json.dump(sort_keys=True, indent=1)"`. Regenerate with
// the same one-liner when the vendor spec moves; the pinned digest assertion
// below will fail loudly on drift (diff, not silent overwrite).
import { describe, expect, it } from "vitest";
import { runCommand } from "../scripts/wrangnarok.mjs";
import { generateIntegrationModule } from "../src/generate-integration";
import { defineIntegration } from "../src/integrations/index";
import { detectGeneratorAuthKind, integrationUuidV5 } from "../src/openapi";
import fixtureText from "./fixtures/definednet-openapi.json?raw";

const ORIGIN = "https://api.defined.net";

function sha256Hex(text: string): Promise<string> {
  return globalThis.crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

describe("INT-01 DefinedNet end-to-end proof (issue #229)", () => {
  it("pins the fixture digest (spec drift fails loudly here)", async () => {
    expect(await sha256Hex(fixtureText)).toBe("d5cdaefef546598e5253559042ccb7424456844e46922b314a82d78ee7184b1f");
  });

  it("detects the bearer ApiToken scheme (never OAuth fields)", () => {
    const doc = JSON.parse(fixtureText) as Parameters<typeof detectGeneratorAuthKind>[0];
    expect(detectGeneratorAuthKind(doc)).toBe("apiToken");
  });

  it("emits 32 operations by default (10 deprecated excluded), 42 opt-in", async () => {
    const spec = fixtureText;
    const digest = await sha256Hex(spec);
    const excluded = generateIntegrationModule(
      spec,
      { id: "definednet", name: "definednet", allowedOrigins: [ORIGIN] },
      digest,
    );
    expect(excluded.operationCount).toBe(32);
    expect(excluded.source).toContain("// Auth kind: apiToken");
    expect(excluded.source).toContain("Authorization: `Bearer ${apiToken}`");
    expect(excluded.source).not.toContain("clientSecret");
    expect(excluded.source).not.toContain("requestClientCredentialsToken");
    // Deprecated operations stay out of the classification map by default.
    expect(excluded.source).not.toContain(`"hostCreate":`);
    expect(excluded.source).toContain(`"hostsListV2": "read"`);
    const included = generateIntegrationModule(
      spec,
      { id: "definednet", name: "definednet", allowedOrigins: [ORIGIN], includeDeprecated: true },
      digest,
    );
    expect(included.operationCount).toBe(42);
    expect(included.source).toContain(`"hostCreate":`);
    // The CLI agrees with the canonical typed output on both paths.
    const cli = (await runCommand({
      command: "generate-integration",
      genId: "definednet",
      genName: "definednet",
      genSpec: spec,
      genOrigins: [ORIGIN],
    })) as { generated: { content: string; operations: number } };
    expect(cli.generated.content).toBe(excluded.source);
    expect(cli.generated.operations).toBe(32);
  });

  it("emits a deterministic UUIDv5 Integration ID that registers", async () => {
    const spec = fixtureText;
    const digest = await sha256Hex(spec);
    const expected = integrationUuidV5(digest);
    expect(expected).toBe("19f50853-3e53-5611-b8ff-ac1e3745a069");
    const out = generateIntegrationModule(
      spec,
      { id: "definednet", name: "definednet", allowedOrigins: [ORIGIN] },
      digest,
    );
    expect(out.source).toContain(`export const DEFINEDNET_INTEGRATION_ID = "${expected}";`);
    expect(() =>
      defineIntegration({
        id: expected,
        name: "definednet",
        description: "Defined Networking hosts/roles/networks over bearer ApiToken.",
        secretFields: ["apiToken"],
        configSchema: [
          {
            name: "endpoint",
            type: "string",
            required: true,
            maxLength: 512,
            description: "Defined Networking API origin (https://api.defined.net).",
          },
        ],
        requiredSecrets: ["apiToken"],
        secretEnvVars: { apiToken: "DEFINEDNET_CLIENT" },
        health: {
          testHint: "List hosts through the generated read operation.",
          remediation: "Confirm the API origin and the bearer token, then retry.",
        },
      }),
    ).not.toThrow();
  });

  it("lands well under the 96 KiB embedding budget", async () => {
    const spec = fixtureText;
    const digest = await sha256Hex(spec);
    const out = generateIntegrationModule(
      spec,
      { id: "definednet", name: "definednet", allowedOrigins: [ORIGIN] },
      digest,
    );
    const embedded =
      out.source.match(/__GENERATED_SPEC__: OpenApiDocument = (\{.*?\});\n\nasync function pinnedSpec/s)?.[1] ?? "";
    const bytes = new TextEncoder().encode(embedded).length;
    expect(bytes).toBeLessThanOrEqual(96 * 1024);
    expect(bytes).toBeLessThan(80 * 1024);
  });
});
