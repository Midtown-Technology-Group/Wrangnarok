// SPDX-License-Identifier: AGPL-3.0
// Workspace-to-bundle bridge (issue #116, MIG-01): converter/mapping
// validation with explicit source identity, environment exclusion, and
// actionable unsupported-feature results. Pure node-safe tests: no bindings,
// no D1, no Workflows. The sharepoint-shaped fixture proves the #116 exit:
// converts or enumerates the missing pieces as follow-ups.
import { describe, expect, it } from "vitest";
import { ECHO_INTEGRATION_ID, echoSaga, helloSaga } from "../src/domain";
import { convertWorkspaceToBundle, WORKSPACE_TO_BUNDLE_MAPPING } from "../src/migration";
import { parseBundleManifest } from "../src/solutions";

const BUNDLE_ID = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
const WORKFLOW_UUID = "aaaaaaaa-1111-4111-8111-111111111111";

function opts() {
  return {
    bundleId: BUNDLE_ID,
    sagas: { [WORKFLOW_UUID]: { id: echoSaga.id, revision: echoSaga.revision } },
    integrations: {
      echo: { id: ECHO_INTEGRATION_ID, org: "default", endpoint: "http://127.0.0.1:8788/echo", secretsRequired: [] },
    },
  };
}

function sharepointShaped() {
  return {
    slug: "sharepoint-file-transfer",
    name: "SharePoint file transfer",
    version: "1.2.0",
    workflows: [{ id: WORKFLOW_UUID, name: "transfer", path: "workflows/transfer.py", functionName: "main" }],
    configs: [{ key: "supportEmail", value: "ops@example.com" }],
    connections: [{ integrationName: "echo" }],
    extraEntities: { tables: 2, forms: 1 },
  };
}

describe("workspace-to-bundle bridge (issue #116)", () => {
  it("documents the field mapping next to the converter", () => {
    const fields = WORKSPACE_TO_BUNDLE_MAPPING.map((row) => row.workspace).join(" ");
    expect(fields).toContain("slug");
    expect(fields).toContain("workflows.yaml");
    expect(fields).toContain("configs.yaml");
    expect(fields).toContain("connections.yaml");
    expect(fields).toContain("scope");
  });

  it("converts a sharepoint-shaped workspace into a valid manifest with gaps enumerated", () => {
    const result = convertWorkspaceToBundle(sharepointShaped(), opts());
    expect(result.manifest.bundle).toEqual({ id: BUNDLE_ID, name: "sharepoint-file-transfer", version: "1.2.0" });
    expect(result.manifest.sagas).toEqual([{ id: echoSaga.id, revision: echoSaga.revision }]);
    expect(result.manifest.integrations).toEqual([
      {
        id: ECHO_INTEGRATION_ID,
        connections: [{ org: "default", config: { endpoint: "http://127.0.0.1:8788/echo" }, secretsRequired: [] }],
      },
    ]);
    // The converted manifest must pass the real installer validator.
    expect(() => parseBundleManifest(result.manifest)).not.toThrow();
    // Tables/Forms stay as actionable follow-ups, never silent drops.
    expect(result.gaps.map((gap) => gap.reason).sort()).toEqual(["UNSUPPORTED_FORMS", "UNSUPPORTED_TABLES"]);
  });

  it("treats manifest UUIDs as source identity resolved through the operator saga map", () => {
    const result = convertWorkspaceToBundle(
      {
        slug: "hello-port",
        name: "Hello port",
        version: "0.1.0",
        workflows: [
          { id: WORKFLOW_UUID, name: "hello", path: "workflows/sample/hello_world.py", functionName: "main" },
        ],
      },
      {
        bundleId: BUNDLE_ID,
        sagas: { [WORKFLOW_UUID]: { id: helloSaga.id, revision: helloSaga.revision } },
        integrations: {},
      },
    );
    expect(result.manifest.sagas).toEqual([{ id: helloSaga.id, revision: helloSaga.revision }]);
    // Legacy decorator id metadata never becomes identity by itself: an
    // unmapped manifest UUID is a gap alongside the mapped pin, not a
    // minted Saga.
    const unmapped = convertWorkspaceToBundle(
      {
        slug: "hello-port",
        name: "Hello port",
        version: "0.1.0",
        workflows: [
          { id: WORKFLOW_UUID, name: "hello", path: "workflows/sample/hello_world.py", functionName: "main" },
          {
            id: "bbbbbbbb-2222-4222-8222-222222222222",
            name: "ghost",
            path: "workflows/ghost.py",
            functionName: "main",
          },
        ],
      },
      {
        bundleId: BUNDLE_ID,
        sagas: { [WORKFLOW_UUID]: { id: helloSaga.id, revision: helloSaga.revision } },
        integrations: {},
      },
    );
    expect(unmapped.gaps.map((gap) => gap.reason)).toContain("UNMAPPED_WORKFLOW");
  });

  it("refuses scope pinning and credential values in portable source", () => {
    for (const scoped of [{ scope: "org" }, { organization_id: "x" }, { org: "default" }]) {
      expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", ...scoped }, opts())).toThrow(
        expect.objectContaining({ code: "SCOPE_IN_WORKSPACE" }),
      );
    }
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", secrets: { token: "x" } }, opts())).toThrow(
      expect.objectContaining({ code: "CREDENTIAL_IN_WORKSPACE" }),
    );
    expect(() =>
      convertWorkspaceToBundle(
        {
          slug: "s",
          name: "S",
          workflows: [{ id: WORKFLOW_UUID, name: "w", path: "w.py", functionName: "main" }],
          configs: [{ key: "clientSecret", value: "x" }],
        },
        opts(),
      ),
    ).toThrow(expect.objectContaining({ code: "CREDENTIAL_IN_MANIFEST" }));
  });

  it("emits value-less declarations and unmapped integrations as actionable gaps", () => {
    const result = convertWorkspaceToBundle(
      {
        slug: "s",
        name: "S",
        workflows: [{ id: WORKFLOW_UUID, name: "w", path: "w.py", functionName: "main" }],
        configs: [{ key: "region" }],
        connections: [{ integrationName: "sharepoint" }],
      },
      opts(),
    );
    expect(result.manifest.config).toEqual([]);
    expect(result.manifest.integrations).toEqual([]);
    expect(result.gaps.map((gap) => gap.reason).sort()).toEqual(["DECLARATION_WITHOUT_VALUE", "UNMAPPED_INTEGRATION"]);
  });

  it("fails closed on malformed workspace input", () => {
    expect(() => convertWorkspaceToBundle(null, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "Bad Name!", name: "S" }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", version: "1.0" }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S" }, opts())).toThrow(
      expect.objectContaining({ code: "NO_CONVERTIBLE_SAGAS" }),
    );
    // Every guard branch refuses its own malformed shape: bad bundle IDs,
    // non-list sections, bad UUIDs, unmapped pins, credential keys, empty
    // values, bad endpoints, and non-string secret lists.
    const badId = { ...opts(), bundleId: "nope" };
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S" }, badId)).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", workflows: {} }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", workflows: [{ id: "nope" }] }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() =>
      convertWorkspaceToBundle(
        { slug: "s", name: "S", workflows: [{ id: WORKFLOW_UUID }], configs: [], connections: [] },
        { ...opts(), sagas: { [WORKFLOW_UUID]: { id: "nope", revision: "" } } },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE" }));
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", configs: {} }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", configs: [{ key: "" }] }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", configs: [{ key: "apiToken" }] }, opts())).toThrow(
      expect.objectContaining({ code: "CREDENTIAL_IN_MANIFEST" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", configs: [{ key: "k", value: 7 }] }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", connections: {} }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", connections: [{}] }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
    expect(() =>
      convertWorkspaceToBundle(
        { slug: "s", name: "S", connections: [{ integrationName: "echo" }] },
        { ...opts(), integrations: { echo: { id: "nope", org: "d", endpoint: "e", secretsRequired: [] } } },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE" }));
    expect(() =>
      convertWorkspaceToBundle(
        { slug: "s", name: "S", connections: [{ integrationName: "echo" }] },
        { ...opts(), integrations: { echo: { id: ECHO_INTEGRATION_ID, org: "", endpoint: "e", secretsRequired: [] } } },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE" }));
    expect(() =>
      convertWorkspaceToBundle(
        { slug: "s", name: "S", connections: [{ integrationName: "echo" }] },
        {
          ...opts(),
          integrations: { echo: { id: ECHO_INTEGRATION_ID, org: "d", endpoint: "", secretsRequired: [] } },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE" }));
    expect(() =>
      convertWorkspaceToBundle(
        { slug: "s", name: "S", connections: [{ integrationName: "echo" }] },
        {
          ...opts(),
          integrations: {
            echo: { id: ECHO_INTEGRATION_ID, org: "d", endpoint: "https://x/token=1", secretsRequired: [] },
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "CREDENTIAL_IN_MANIFEST" }));
    expect(() =>
      convertWorkspaceToBundle(
        { slug: "s", name: "S", connections: [{ integrationName: "echo" }] },
        {
          ...opts(),
          integrations: {
            echo: { id: ECHO_INTEGRATION_ID, org: "d", endpoint: "e", secretsRequired: [7] as unknown as string[] },
          },
        },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_WORKSPACE" }));
    expect(() => convertWorkspaceToBundle({ slug: "s", name: "S", extraEntities: [] }, opts())).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE" }),
    );
  });
});

describe("zone-inventory bundle conversion (issues #116, #119)", () => {
  it("converts the real cloudflare-zone-inventory descriptor through the bridge", async () => {
    const { CLOUDFLARE_INTEGRATION_ID, cloudflareInventorySaga, cloudflareVerifySaga } = await import(
      "../src/domain"
    );
    // Workspace shape of the real bundle: descriptor fields plus the
    // workflows.yaml entries. The bundle ships no configs.yaml or
    // connections.yaml; the operator binds those at install time.
    const workspace = {
      slug: "cloudflare-zone-inventory",
      name: "Cloudflare Zone Inventory",
      version: "0.1.0",
      workflows: [
        { id: "2fcb2d31-091a-583f-a980-38c4de3da9ab", name: "Cloudflare: Verify API Connection" },
        { id: "a5160896-d1de-55cc-b1af-71e57b670f44", name: "Cloudflare: Inventory Zones" },
      ],
    };
    const result = convertWorkspaceToBundle(workspace, {
      bundleId: "d4e5f6a7-8b9c-4d1e-8f2a-3b4c5d6e7f81",
      sagas: {
        "2fcb2d31-091a-583f-a980-38c4de3da9ab": { id: cloudflareVerifySaga.id, revision: cloudflareVerifySaga.revision },
        "a5160896-d1de-55cc-b1af-71e57b670f44": {
          id: cloudflareInventorySaga.id,
          revision: cloudflareInventorySaga.revision,
        },
      },
      integrations: {
        Cloudflare: {
          id: CLOUDFLARE_INTEGRATION_ID,
          org: "default",
          endpoint: "https://api.cloudflare.com/client/v4",
          secretsRequired: ["apiToken"],
        },
      },
    });
    expect(result.gaps).toEqual([]);
    expect(result.manifest.bundle).toEqual({
      id: "d4e5f6a7-8b9c-4d1e-8f2a-3b4c5d6e7f81",
      name: "cloudflare-zone-inventory",
      version: "0.1.0",
    });
    expect(result.manifest.sagas).toEqual([
      { id: cloudflareVerifySaga.id, revision: cloudflareVerifySaga.revision },
      { id: cloudflareInventorySaga.id, revision: cloudflareInventorySaga.revision },
    ]);
    // The converted manifest parses as an installable bundle manifest.
    expect(() => parseBundleManifest(result.manifest)).not.toThrow();
  });
});
