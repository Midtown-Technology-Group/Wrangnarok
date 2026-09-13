// SPDX-License-Identifier: AGPL-3.0
// SOL-03 (issue #163): portable Solution source capture/export/import.
// Proven against real local D1 in workerd: capture preview and gap paths,
// export/import round-trip in a fresh org, malicious archive and path input,
// missing modules, and export-job failure with guaranteed cleanup.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { digestSaga, ECHO_INTEGRATION_ID, echoSaga, Fault, helloSaga, NINJA_INTEGRATION_ID } from "../src/domain";
import { SAGA_DEFINITIONS } from "../src/sagas";
import { installBundle } from "../src/solutions";
import type { BundleManifest } from "../src/solutions";
import {
  captureSource,
  checkClosure,
  defaultSourceNotes,
  exportSourcePackage,
  importSourcePackage,
  mapSourceToInstall,
  previewCaptureSource,
  runExportJob,
  staticSourceCatalogs,
} from "../src/solution-export";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";

const bindings = env as unknown as Bindings;
const BUNDLE_ID = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
const ENDPOINT = "http://127.0.0.1:8788/echo";

function manifest() {
  return {
    manifestVersion: 1,
    bundle: { id: BUNDLE_ID, name: "echo-starter", version: "1.0.0" },
    sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    integrations: [
      {
        id: ECHO_INTEGRATION_ID,
        connections: [{ org: "default", config: { endpoint: ENDPOINT }, secretsRequired: [] }],
      },
    ],
    config: [{ key: "supportEmail", value: "ops@example.com" }],
  };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migration4);
});

afterEach(async () => {
  await reset();
});

describe("solution source capture (SOL-03)", () => {
  it("stays in agreement with the Saga definitions and the installer catalog", () => {
    const catalogs = staticSourceCatalogs();
    for (const def of SAGA_DEFINITIONS) {
      const pin = catalogs.sagas.find((entry) => entry.id === def.id);
      expect(pin?.revision).toBe(def.revision);
      expect(pin?.name).toBe(def.name);
      expect([...(pin?.requiredIntegrations ?? [])]).toEqual([...def.requiredIntegrations]);
    }
    const defs = new Map(SAGA_DEFINITIONS.map((def) => [def.id, def]));
    expect(catalogs.sagas).toHaveLength(defs.size);
  });

  it("previews capture read-only and captures after a clean install", async () => {
    const preview = await previewCaptureSource(bindings.DB, manifest());
    expect(preview.package.source.id).toBe(BUNDLE_ID);
    expect(preview.package.modules).toHaveLength(1);
    expect(preview.package.metadata.notes.join(" ")).toContain("not a data backup");
    expect(preview.gaps.some((gap) => gap.reason === "MISSING_MANAGED_ROW" && gap.blocking)).toBe(true);
    await expect(captureSource(bindings.DB, manifest())).rejects.toMatchObject({ code: "CAPTURE_BLOCKED" });
    // Preview wrote nothing.
    const orgs = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first<{ n: number }>();
    expect(orgs?.n).toBe(0);

    await installBundle(bindings.DB, manifest());
    const captured = await captureSource(bindings.DB, manifest(), {
      readme: "# echo-starter",
      git: { commit: "abc1234" },
    });
    expect(captured.gaps).toEqual([]);
    expect(captured.package.source.readme).toBe("# echo-starter");
    expect(captured.package.modules[0]?.name).toBe("echo");
  });

  it("refuses to adopt loose rows and reports foreign ownership and drift", async () => {
    await installBundle(bindings.DB, manifest());
    const blocked = await previewCaptureSource(bindings.DB, {
      ...manifest(),
      integrations: [
        {
          id: NINJA_INTEGRATION_ID,
          connections: [
            {
              org: "default",
              config: { endpoint: "https://api.ninjaone.test" },
              secretsRequired: ["clientSecret"],
            },
          ],
        },
      ],
      sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    });
    expect(blocked.gaps.map((gap) => gap.reason)).toContain("MISSING_MANAGED_ROW");

    // Loose row for the declared connection: reported, never adopted.
    const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("漂")
      .first<{ id: string }>();
    void org;
    const looseId = crypto.randomUUID();
    const defaultOrg = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("default")
      .first<{ id: string }>();
    await bindings.DB.prepare(
      "INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, NULL)",
    )
      .bind(looseId, defaultOrg?.id, NINJA_INTEGRATION_ID, "https://api.ninjaone.test")
      .run();
    const loose = await previewCaptureSource(bindings.DB, {
      manifestVersion: 1,
      bundle: { id: BUNDLE_ID, name: "mixed", version: "9.9.9" },
      sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
      integrations: [
        {
          id: NINJA_INTEGRATION_ID,
          connections: [
            {
              org: "default",
              config: { endpoint: "https://api.ninjaone.test" },
              secretsRequired: ["clientSecret"],
            },
          ],
        },
      ],
      config: [],
    });
    expect(loose.gaps.map((gap) => gap.reason)).toContain("LOOSE_RESOURCE_NOT_ADOPTED");
    expect(loose.gaps.some((gap) => gap.blocking)).toBe(true);
    await expect(
      captureSource(bindings.DB, {
        manifestVersion: 1,
        bundle: { id: BUNDLE_ID, name: "mixed", version: "9.9.9" },
        sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
        integrations: [
          {
            id: NINJA_INTEGRATION_ID,
            connections: [
              {
                org: "default",
                config: { endpoint: "https://api.ninjaone.test" },
                secretsRequired: ["clientSecret"],
              },
            ],
          },
        ],
        config: [],
      }),
    ).rejects.toMatchObject({ code: "CAPTURE_BLOCKED" });

    // Drifted managed row blocks capture.
    await bindings.DB.prepare("UPDATE connections SET endpoint = ? WHERE org_id = ? AND integration_id = ?")
      .bind("http://127.0.0.1:9999/drifted", defaultOrg?.id, ECHO_INTEGRATION_ID)
      .run();
    const drifted = await previewCaptureSource(bindings.DB, manifest());
    expect(drifted.gaps.map((gap) => gap.reason)).toContain("DRIFTED_CONNECTION");
    await expect(captureSource(bindings.DB, manifest())).rejects.toMatchObject({ code: "CAPTURE_BLOCKED" });
  });

  it("refuses capture across ownership boundaries", async () => {
    await installBundle(bindings.DB, manifest());
    const preview = await previewCaptureSource(bindings.DB, {
      ...manifest(),
      bundle: { id: "00000000-0000-4000-8000-000000000000", name: "echo-starter", version: "1.0.0" },
    });
    expect(preview.gaps.map((gap) => gap.reason)).toContain("OWNERSHIP_MISMATCH");
  });
});

describe("solution source export and import (SOL-03)", () => {
  async function capturedPackage() {
    await installBundle(bindings.DB, manifest());
    const captured = await captureSource(bindings.DB, manifest(), { readme: "# echo-starter" });
    return captured.package;
  }

  it("round-trips export and import, then installs into a fresh org", async () => {
    const pkg = await capturedPackage();
    const exported = await exportSourcePackage(pkg);
    expect(exported.files.map((file) => file.name).sort()).toEqual(["solution.manifest.json", "solution.source.json"]);
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
    const imported = await importSourcePackage(JSON.parse(exported.files[0]?.json as string));
    expect(imported.report.modules).toBe(1);
    expect(imported.report.integrations).toBe(1);
    expect(imported.package.source.id).toBe(BUNDLE_ID);

    // Fresh-org adoption: the extracted manifest installs through the real
    // installer with no tenant state carried over.
    const fresh = JSON.parse(exported.files[1]?.json as string);
    fresh.integrations[0].connections[0].org = "second";
    const result = await installBundle(bindings.DB, fresh);
    void result;
    const row = await bindings.DB.prepare(
      "SELECT c.endpoint, c.managed_by FROM connections c JOIN organizations o ON o.id = c.org_id WHERE o.name = ? AND c.integration_id = ?",
    )
      .bind("second", ECHO_INTEGRATION_ID)
      .first<{ endpoint: string; managed_by: string }>();
    expect(row?.endpoint).toBe(ENDPOINT);
    expect(row?.managed_by).toBe(`${BUNDLE_ID}@1.0.0`);
    // The second org got the same deterministic Connection id the mapper predicts.
    const secondOrg = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("second")
      .first<{ id: string }>();
    const idRow = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id = ? AND integration_id = ?")
      .bind(secondOrg?.id, ECHO_INTEGRATION_ID)
      .first<{ id: string }>();
    expect(idRow?.id).toBe(await mapSourceToInstall(BUNDLE_ID, secondOrg?.id as string, ECHO_INTEGRATION_ID));
  });

  it("maps source identity to the exact managed Connection id the installer writes", async () => {
    await installBundle(bindings.DB, manifest());
    const defaultOrg = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
      .bind("default")
      .first<{ id: string }>();
    const row = await bindings.DB.prepare("SELECT id FROM connections WHERE org_id = ? AND integration_id = ?")
      .bind(defaultOrg?.id, ECHO_INTEGRATION_ID)
      .first<{ id: string }>();
    expect(row?.id).toBe(await mapSourceToInstall(BUNDLE_ID, defaultOrg?.id as string, ECHO_INTEGRATION_ID));
  });

  it("rejects embedded credentials, table rows, execution state, and artifact bytes", async () => {
    const pkg = await capturedPackage();
    for (const poison of [
      { tableRows: [{ id: 1 }] },
      { executions: [{ id: "x" }] },
      { operations: [] },
      { artifactBytes: "aGVsbG8=" },
      { secrets: { clientSecret: "hunter2" } },
      { credentials: { token: "x" } },
      { clientSecret: "hunter2" },
    ]) {
      await expect(exportSourcePackage({ ...pkg, ...poison })).rejects.toMatchObject({
        code:
          poison && ("clientSecret" in poison || "token" in poison) ? "CREDENTIAL_IN_SOURCE" : "TENANT_STATE_EXCLUDED",
      });
    }
    // Caller-known secret values embedded anywhere fail closed by value, too.
    const sneaky = JSON.parse(JSON.stringify(pkg));
    sneaky.assets = [{ path: "notes/leak.md", contentType: "text/markdown", text: "value is hunter2 here" }];
    await expect(exportSourcePackage(sneaky, { secrets: { clientSecret: "hunter2" } })).rejects.toMatchObject({
      code: "CREDENTIAL_IN_SOURCE",
    });
  });

  it("rejects malicious archive structure and asset paths", async () => {
    const pkg = await capturedPackage();
    await expect(importSourcePackage({ ...pkg, format: "bifrost.zip" })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(importSourcePackage({ ...pkg, formatVersion: 2 })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(
      importSourcePackage({ ...pkg, assets: [{ path: "../../etc/passwd", contentType: "text/plain", text: "x" }] }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_PATH" });
    await expect(
      importSourcePackage({
        ...pkg,
        assets: [
          { path: "a.md", contentType: "text/markdown", text: "x" },
          { path: "a.md", contentType: "text/markdown", text: "y" },
        ],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ASSET_PATH" });
    await expect(
      importSourcePackage({
        ...pkg,
        assets: [{ path: "run.exe", contentType: "application/octet-stream", text: "x" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const protoPoison = JSON.parse(JSON.stringify(pkg));
    Object.defineProperty(protoPoison, "__proto__", { value: { polluted: true }, enumerable: true });
    await expect(importSourcePackage(protoPoison)).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(importSourcePackage({ ...pkg, source: { ...pkg.source, version: "9.9.9" } })).rejects.toMatchObject({
      code: "SOURCE_MANIFEST_MISMATCH",
    });
    await expect(
      importSourcePackage({ ...pkg, metadata: { ...pkg.metadata, upstream: "somewhere-else" } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("fails closed on missing modules and undeclared requirements", async () => {
    const pkg = await capturedPackage();
    const ghost = JSON.parse(JSON.stringify(pkg));
    ghost.modules = [
      {
        sagaId: "00000000-0000-4000-8000-000000000000",
        name: "ghost",
        revision: "ghost-v1",
        description: "missing",
        requiredIntegrations: [],
      },
    ];
    ghost.manifest = {
      ...pkg.manifest,
      sagas: [{ id: "00000000-0000-4000-8000-000000000000", revision: "ghost-v1" }],
    };
    await expect(importSourcePackage(ghost)).rejects.toMatchObject({ code: "UNKNOWN_SAGA" });

    const closureGhost = checkClosure(
      pkg.manifest,
      [
        {
          sagaId: "00000000-0000-4000-8000-000000000000",
          name: "ghost",
          revision: "ghost-v1",
          description: "missing",
          requiredIntegrations: [],
        },
      ],
      staticSourceCatalogs(),
    );
    expect(closureGhost.map((gap) => gap.reason)).toContain("MISSING_MODULE");

    const driftedPin = JSON.parse(JSON.stringify(pkg));
    driftedPin.modules[0].revision = "echo-v999";
    driftedPin.manifest.sagas[0].revision = "echo-v999";
    await expect(importSourcePackage(driftedPin)).rejects.toMatchObject({ code: "REVISION_MISMATCH" });

    const missingReq = JSON.parse(JSON.stringify(pkg));
    missingReq.manifest.integrations = [];
    await expect(importSourcePackage(missingReq)).rejects.toMatchObject({ code: "INTEGRATION_NOT_DECLARED" });
    const closure = checkClosure(missingReq.manifest, pkg.modules, staticSourceCatalogs());
    expect(closure.map((gap) => gap.reason)).toContain("INTEGRATION_NOT_DECLARED");

    const unknownReq = JSON.parse(JSON.stringify(pkg));
    unknownReq.source.requirements = [{ name: "wrangnarok.time-machine", version: "1" }];
    await expect(importSourcePackage(unknownReq)).rejects.toMatchObject({ code: "REQUIREMENT_UNSATISFIED" });
  });

  it("rejects an oversized package without writing anything", async () => {
    const pkg = await capturedPackage();
    const big = JSON.parse(JSON.stringify(pkg));
    big.assets = [{ path: "notes/big.md", contentType: "text/markdown", text: "x".repeat(70000) }];
    let written = 0;
    const sink = {
      writeTemp: () => {
        written += 1;
      },
      commit: () => {},
      cleanup: () => {},
    };
    await expect(runExportJob(big, sink)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(written).toBe(0);
  });

  it("cleans up staged files when the export job fails mid-stage", async () => {
    const pkg = await capturedPackage();
    const staged: string[] = [];
    let cleaned = 0;
    let committed = false;
    const sink = {
      writeTemp: (name: string) => {
        if (name === "solution.manifest.json") throw new Error("disk full mid-stage");
        staged.push(name);
      },
      commit: () => {
        committed = true;
      },
      cleanup: () => {
        cleaned += 1;
        staged.length = 0;
      },
    };
    await expect(runExportJob(pkg, sink)).rejects.toMatchObject({ code: "EXPORT_JOB_FAILED" });
    expect(committed).toBe(false);
    expect(cleaned).toBe(1);
    expect(staged).toEqual([]);
  });

  it("cleans up when commit itself fails after staging", async () => {
    const pkg = await capturedPackage();
    const staged: string[] = [];
    let cleaned = 0;
    const sink = {
      writeTemp: (name: string) => {
        staged.push(name);
      },
      commit: () => {
        throw new Error("commit lost the race");
      },
      cleanup: () => {
        cleaned += 1;
        staged.length = 0;
      },
    };
    await expect(runExportJob(pkg, sink)).rejects.toMatchObject({ code: "EXPORT_JOB_FAILED" });
    expect(cleaned).toBe(1);
    expect(staged).toEqual([]);
  });

  it("keeps hello pins portable and preserves secret-schema requirements", async () => {
    await installBundle(
      bindings.DB,
      {
        manifestVersion: 1,
        bundle: { id: BUNDLE_ID, name: "hello-starter", version: "2.0.0" },
        sagas: [{ id: helloSaga.id, revision: helloSaga.revision }],
        integrations: [],
        config: [],
      },
      { orgName: "default" },
    );
    const captured = await captureSource(bindings.DB, {
      manifestVersion: 1,
      bundle: { id: BUNDLE_ID, name: "hello-starter", version: "2.0.0" },
      sagas: [{ id: helloSaga.id, revision: helloSaga.revision }],
      integrations: [],
      config: [],
    });
    expect(captured.package.modules[0]?.requiredIntegrations).toEqual([]);
    const exported = await exportSourcePackage(captured.package);
    const imported = await importSourcePackage(JSON.parse(exported.files[0]?.json as string));
    expect(imported.report.modules).toBe(1);
    expect(defaultSourceNotes().join(" ")).toContain("OPS-03");
  });

  // Branch-coverage sweep (coverage gate: every metric >= 95%). Each guard in
  // src/solution-export.ts gets one positive and one negative proof through
  // the public export/import surface, so the gate measures behavior and the
  // fail-closed branches cannot rot silently.
  it("rejects every malformed envelope, identity, and requirement branch", async () => {
    const pkg = await capturedPackage();
    const good = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    // Envelope: non-object, wrong format, wrong version.
    await expect(exportSourcePackage(null)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(exportSourcePackage({ ...good, format: "wrangnarok.backup" })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(exportSourcePackage({ ...good, formatVersion: 99 })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    // Requirements: non-list, malformed entry, version skew.
    await expect(exportSourcePackage({ ...good, source: { ...pkg.source, requirements: "1" } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(
      exportSourcePackage({ ...good, source: { ...pkg.source, requirements: [{ name: "x" }] } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(
      exportSourcePackage({
        ...good,
        source: { ...pkg.source, requirements: [{ name: "wrangnarok.manifest", version: "99" }] },
      }),
    ).rejects.toMatchObject({ code: "REQUIREMENT_UNSATISFIED" });
    // Identity: non-object source, bad UUID, bad slug, bad semver,
    // non-object logo and git pointers.
    await expect(exportSourcePackage({ ...good, source: null })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(exportSourcePackage({ ...good, source: { ...pkg.source, id: "nope" } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(exportSourcePackage({ ...good, source: { ...pkg.source, name: "-bad slug-" } })).rejects.toMatchObject(
      { code: "INVALID_SOURCE" },
    );
    await expect(exportSourcePackage({ ...good, source: { ...pkg.source, version: "v1" } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(exportSourcePackage({ ...good, source: { ...pkg.source, logo: "svg" } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(exportSourcePackage({ ...good, source: { ...pkg.source, git: "repo" } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    // Modules: empty list, non-object entry, non-UUID sagaId.
    await expect(exportSourcePackage({ ...good, modules: [] })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(exportSourcePackage({ ...good, modules: ["echo"] })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(
      exportSourcePackage({ ...good, modules: [{ ...pkg.modules[0], sagaId: "nope" }] }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    // Assets: non-list, oversized list, and a logo-less valid package still
    // exports (the optional-logo branch).
    await expect(exportSourcePackage({ ...good, assets: "notes" })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const tooMany = Array.from({ length: 17 }, (_, i) => ({
      path: `notes/n${i}.md`,
      contentType: "text/markdown",
      text: "x",
    }));
    await expect(exportSourcePackage({ ...good, assets: tooMany })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("rejects every malformed logo branch", async () => {
    const pkg = await capturedPackage();
    const svg = '<svg viewBox="0 0 1 1"></svg>';
    const good = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    // A valid logo passes: the true branch of every logo guard.
    const withLogo = await exportSourcePackage({
      ...good,
      source: { ...pkg.source, logo: { contentType: "image/svg+xml", svg } },
    });
    expect(withLogo.files).toHaveLength(2);
    // Every false branch: wrong content type, empty svg, non-svg markup,
    // scripted svg, and remote-reference svg.
    for (const logo of [
      { contentType: "image/png", svg },
      { contentType: "image/svg+xml", svg: "" },
      { contentType: "image/svg+xml", svg: "just text, no markup" },
      { contentType: "image/svg+xml", svg: "<svg><script>alert(1)</script></svg>" },
      { contentType: "image/svg+xml", svg: '<svg><image href="https://example.com/x.png"/></svg>' },
      { contentType: "image/svg+xml", svg: '<svg><image href="http://example.com/x.png"/></svg>' },
    ]) {
      await expect(exportSourcePackage({ ...good, source: { ...pkg.source, logo } })).rejects.toMatchObject({
        code: "INVALID_SOURCE",
      });
    }
  });

  it("rejects every malformed git, readme, asset, and metadata branch", async () => {
    const pkg = await capturedPackage();
    const good = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    // Valid git pointer passes; repo with embedded credentials, a non-hex
    // commit, and an overlong repo fail.
    const withGit = await exportSourcePackage({
      ...good,
      source: { ...pkg.source, git: { repo: "https://example.com/org/repo", commit: "abc1234" } },
    });
    expect(withGit.files).toHaveLength(2);
    await expect(
      exportSourcePackage({ ...good, source: { ...pkg.source, git: { repo: "https://user@example.com/r" } } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(
      exportSourcePackage({ ...good, source: { ...pkg.source, git: { commit: "not-hex!!" } } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(
      exportSourcePackage({ ...good, source: { ...pkg.source, git: { repo: `https://x/${"r".repeat(300)}` } } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    // Readme: empty and oversized fail; the valid capture path already
    // covers the true branch.
    await expect(exportSourcePackage({ ...good, source: { ...pkg.source, readme: "" } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(
      exportSourcePackage({ ...good, source: { ...pkg.source, readme: "x".repeat(9000) } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    // Assets: non-object entry, empty-text path segments ("a//b.md"),
    // dot segments, overlong text, and a valid asset passes.
    await expect(exportSourcePackage({ ...good, assets: ["notes"] })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(
      exportSourcePackage({ ...good, assets: [{ path: "a//b.md", contentType: "text/plain", text: "x" }] }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_PATH" });
    await expect(
      exportSourcePackage({ ...good, assets: [{ path: "a/./b.md", contentType: "text/plain", text: "x" }] }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_PATH" });
    await expect(
      exportSourcePackage({
        ...good,
        assets: [{ path: "notes/big.md", contentType: "text/plain", text: "x".repeat(9000) }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const withAsset = await exportSourcePackage({
      ...good,
      assets: [{ path: "notes/small.md", contentType: "text/markdown", text: "hello" }],
    });
    expect(withAsset.files).toHaveLength(2);
    // Metadata: non-object, bad instant, bad exporter via import path is
    // fixed ("wrangnarok-import") so only the raw branches are reachable
    // here; bad upstream, oversized notes, empty note, and bad notes type.
    await expect(exportSourcePackage({ ...good, metadata: null })).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(
      exportSourcePackage({ ...good, metadata: { ...pkg.metadata, exportedAt: "not-a-date" } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(
      exportSourcePackage({ ...good, metadata: { ...pkg.metadata, upstream: "x".repeat(200) } }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(exportSourcePackage({ ...good, metadata: { ...pkg.metadata, notes: "hi" } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(exportSourcePackage({ ...good, metadata: { ...pkg.metadata, notes: [""] } })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
  });

  it("rejects every module identity-mismatch branch", async () => {
    const pkg = await capturedPackage();
    const good = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    const first = pkg.modules[0] as { sagaId: string; name: string; description: string; revision: string };
    // Wrong name, wrong description, and reordered requiredIntegrations.
    await expect(exportSourcePackage({ ...good, modules: [{ ...first, name: "not-echo" }] })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    await expect(exportSourcePackage({ ...good, modules: [{ ...first, description: "wrong" }] })).rejects.toMatchObject(
      { code: "INVALID_SOURCE" },
    );
    await expect(
      exportSourcePackage({ ...good, modules: [{ ...first, requiredIntegrations: "x" }] }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("covers the closure matrix: unknown integration, secret mismatch, fallback name", async () => {
    const pkg = await capturedPackage();
    const catalogs = staticSourceCatalogs();
    // Unknown integration id: no catalog entry, so the fallback renders the
    // raw id in the detail and the gap blocks.
    const ghostManifest = {
      ...pkg.manifest,
      integrations: [{ id: "00000000-0000-4000-8000-000000000000", connections: [] }],
    } as unknown as BundleManifest;
    const ghostGaps = checkClosure(ghostManifest, [], catalogs);
    expect(ghostGaps.map((gap) => gap.reason)).toContain("UNKNOWN_INTEGRATION");
    expect(ghostGaps.every((gap) => gap.blocking)).toBe(true);
    await expect(
      importSourcePackage({ ...JSON.parse(JSON.stringify(pkg)), manifest: ghostManifest }),
    ).rejects.toMatchObject({ code: "UNKNOWN_INTEGRATION" });
    // Secret-schema mismatch through the public import surface.
    const badSecret = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    (badSecret.manifest as Record<string, unknown[]>).integrations = [
      {
        id: ECHO_INTEGRATION_ID,
        connections: [{ org: "default", config: { endpoint: ENDPOINT }, secretsRequired: ["nope"] }],
      },
    ] as unknown[];
    await expect(importSourcePackage(badSecret)).rejects.toMatchObject({ code: "SECRET_SCHEMA_MISMATCH" });
    // Undeclared integration requirement that IS in the catalog renders the
    // definition name (not the raw id) in the gap detail.
    const digestManifest = {
      manifestVersion: 1,
      bundle: { id: BUNDLE_ID, name: "digest-starter", version: "1.0.0" },
      sagas: [{ id: digestSaga.id, revision: digestSaga.revision }],
      integrations: [
        {
          id: ECHO_INTEGRATION_ID,
          connections: [{ org: "default", config: { endpoint: ENDPOINT }, secretsRequired: [] }],
        },
      ],
      config: [],
    };
    const digestGaps = checkClosure(
      digestManifest as unknown as BundleManifest,
      [
        {
          sagaId: digestSaga.id,
          name: digestSaga.name,
          revision: digestSaga.revision,
          description: digestSaga.description,
          requiredIntegrations: [NINJA_INTEGRATION_ID, ECHO_INTEGRATION_ID],
        },
      ],
      catalogs,
    );
    expect(digestGaps.map((gap) => gap.reason)).toContain("INTEGRATION_NOT_DECLARED");
    expect(digestGaps[0]?.detail).toContain("ninjaone");
  });

  it("covers capture scoping, mapper, scanner, and sink branches", async () => {
    // ORG_NOT_DECLARED: scoped org with no declared connections.
    const scoped = await previewCaptureSource(bindings.DB, manifest(), { orgName: "ghost-org" });
    expect(scoped.gaps.map((gap) => gap.reason)).toContain("ORG_NOT_DECLARED");
    // Empty readme fails closed.
    await expect(previewCaptureSource(bindings.DB, manifest(), { readme: "" })).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    // Mapper rejects non-UUID triplets.
    await expect(mapSourceToInstall("nope", "also-nope", "bad")).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    // Scanner: arrays walk element-wise (covered true branch), deep nesting
    // fails closed, constructor/prototype keys fail closed, and the
    // allowlisted secretsRequired key passes through the credential scan.
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 40; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    await expect(exportSourcePackage(deep)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    for (const key of ["constructor", "prototype"]) {
      const poisoned: Record<string, unknown> = {};
      Object.defineProperty(poisoned, key, { value: { polluted: true }, enumerable: true });
      await expect(exportSourcePackage(poisoned)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    // Fully-null secrets map and empty-string secret values skip the
    // value scan without failing.
    const pkg = await capturedPackage();
    const clean = await exportSourcePackage(pkg, { secrets: { nothing: "" } });
    expect(clean.files).toHaveLength(2);
    // Export-job sink cleanup on validation failure + Fault-preserving
    // cleanup when a staged Fault (not a transport error) aborts the job.
    let cleaned = 0;
    await expect(
      runExportJob(null, {
        writeTemp: () => {},
        commit: () => {},
        cleanup: () => {
          cleaned += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(cleaned).toBe(1);
    let cleanedFault = 0;
    const fault = new Fault(409, "CUSTOM_BLOCK", "staged fault");
    await expect(
      runExportJob(pkg, {
        writeTemp: () => {
          throw fault;
        },
        commit: () => {},
        cleanup: () => {
          cleanedFault += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "CUSTOM_BLOCK" });
    expect(cleanedFault).toBe(1);
  });

  it("rejects oversized packages at the byte cap through runExportJob", async () => {
    const pkg = await capturedPackage();
    // 70000 chars of text fail manifest asset validation first; craft a
    // package that passes validation but exceeds the 65536-byte cap: 8
    // max-size assets plus notes stay schema-valid while the canonical JSON
    // crosses the cap.
    const big = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    big.assets = Array.from({ length: 8 }, (_, i) => ({
      path: `notes/big${i}.md`,
      contentType: "text/plain",
      text: "x".repeat(8192),
    }));
    await expect(exportSourcePackage(big)).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    let cleaned = 0;
    await expect(
      runExportJob(big, {
        writeTemp: () => {},
        commit: () => {},
        cleanup: () => {
          cleaned += 1;
        },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    expect(cleaned).toBe(1);
  });

  // Final sweep: every remaining branch the coverage gate measures.
  it("covers git-without-commit, non-string asset type, and capture logo/git opts", async () => {
    const pkg = await capturedPackage();
    const good = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    // Git pointer with repo only (no commit): the commit-absent branch.
    const repoOnly = await exportSourcePackage({
      ...good,
      source: { ...pkg.source, git: { repo: "https://example.com/org/repo" } },
    });
    expect(repoOnly.files).toHaveLength(2);
    // Asset with a non-string contentType renders "?" in the error detail.
    await expect(
      exportSourcePackage({
        ...good,
        assets: [{ path: "notes/blob.md", contentType: 7, text: "x" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    // Capture with logo and git opts exercises the option-taken branches in
    // previewCaptureSource; capture succeeds after a clean install.
    const withOpts = await captureSource(bindings.DB, manifest(), {
      readme: "# echo-starter",
      logo: { contentType: "image/svg+xml", svg: '<svg viewBox="0 0 1 1"></svg>' },
      git: { commit: "abc1234" },
    });
    expect(withOpts.package.source.logo?.contentType).toBe("image/svg+xml");
    expect(withOpts.package.source.git?.commit).toBe("abc1234");
  });

  it("covers the closure mismatch matrix directly", () => {
    const catalogs = staticSourceCatalogs();
    const echo = catalogs.sagas.find((entry) => entry.id === echoSaga.id);
    const baseManifest = manifest() as unknown as BundleManifest;
    // REVISION_MISMATCH gap: module revision differs from deployed code.
    const drifted = checkClosure(
      baseManifest,
      [
        {
          sagaId: echoSaga.id,
          name: echo?.name ?? "echo",
          revision: "echo-v999",
          description: echo?.description ?? "echo",
          requiredIntegrations: [...(echo?.requiredIntegrations ?? [])],
        },
      ],
      catalogs,
    );
    expect(drifted.map((gap) => gap.reason)).toContain("REVISION_MISMATCH");
    // INTEGRATION_NOT_DECLARED with an unknown required id renders the raw
    // id fallback in the detail.
    const ghostReq = checkClosure(
      baseManifest,
      [
        {
          sagaId: echoSaga.id,
          name: echo?.name ?? "echo",
          revision: echo?.revision ?? "echo-v1",
          description: echo?.description ?? "echo",
          requiredIntegrations: ["00000000-0000-4000-8000-000000000000"],
        },
      ],
      catalogs,
    );
    expect(ghostReq.map((gap) => gap.reason)).toContain("INTEGRATION_NOT_DECLARED");
    expect(ghostReq[0]?.detail).toContain("00000000-0000-4000-8000-000000000000");
    // SECRET_SCHEMA_MISMATCH gap through checkClosure directly.
    const badSchema = checkClosure(
      {
        ...baseManifest,
        integrations: [
          {
            id: ECHO_INTEGRATION_ID,
            connections: [{ org: "default", config: { endpoint: ENDPOINT }, secretsRequired: ["nope"] }],
          },
        ],
      } as unknown as BundleManifest,
      [
        {
          sagaId: echoSaga.id,
          name: echo?.name ?? "echo",
          revision: echo?.revision ?? "echo-v1",
          description: echo?.description ?? "echo",
          requiredIntegrations: [],
        },
      ],
      catalogs,
    );
    expect(badSchema.map((gap) => gap.reason)).toContain("SECRET_SCHEMA_MISMATCH");
    // Non-blocking closure gaps are returned, never thrown: a loose-only
    // manifest state reports without failing the import status arm.
    const idle = checkClosure(baseManifest, [], catalogs);
    expect(idle).toEqual([]);
  });

  it("covers missing-module build, same-org second lookup, and import mismatch paths", async () => {
    // buildModules MISSING_MODULE: custom catalogs lacking the manifest saga
    // (the installer catalog still knows it, so parsing succeeds).
    const thin = staticSourceCatalogs();
    const stripped = { sagas: [], integrations: thin.integrations };
    const missing = await previewCaptureSource(bindings.DB, manifest(), { catalogs: stripped });
    expect(missing.gaps.map((gap) => gap.reason)).toContain("MISSING_MODULE");
    // Same-org second connection: the orgIds memo hit. Install echo + ninja
    // under one bundle id FIRST (fresh DB), then preview both: the second
    // same-org connection takes the memo path. The echo-bundle captures
    // below run after, in their own installs.
    const memoManifest = {
      manifestVersion: 1,
      bundle: { id: "c20b8d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", name: "echo-ninja", version: "1.0.0" },
      sagas: [{ id: digestSaga.id, revision: digestSaga.revision }],
      integrations: [
        {
          id: ECHO_INTEGRATION_ID,
          connections: [{ org: "default", config: { endpoint: ENDPOINT }, secretsRequired: [] }],
        },
        {
          id: NINJA_INTEGRATION_ID,
          connections: [
            { org: "default", config: { endpoint: "https://api.ninjaone.test" }, secretsRequired: ["clientSecret"] },
          ],
        },
      ],
      config: [],
    };
    await installBundle(bindings.DB, memoManifest, { secrets: { clientSecret: "sentinel" } });
    const both = await previewCaptureSource(bindings.DB, memoManifest);
    expect(both.gaps).toEqual([]);
    // validatePackage MISSING_MODULE / SOURCE_MANIFEST_MISMATCH: craft the
    // package docs by hand around the memo manifest (digest pin), so no
    // echo-bundle install collides with the memo rows above.
    const memoCapture = await captureSource(bindings.DB, memoManifest);
    const memoPkg = memoCapture.package;
    const ghostModule = JSON.parse(JSON.stringify(memoPkg)) as Record<string, unknown>;
    (ghostModule.modules as Record<string, unknown>[])[0] = {
      sagaId: "00000000-0000-4000-8000-000000000000",
      name: "ghost",
      revision: "ghost-v1",
      description: "missing",
      requiredIntegrations: [],
    };
    await expect(importSourcePackage(ghostModule)).rejects.toMatchObject({ code: "MISSING_MODULE" });
    // validatePackage SOURCE_MANIFEST_MISMATCH: a module for a catalog saga
    // the manifest never pins. The memo manifest parses (digest pin matches
    // code), the hello module passes every identity check, then the pin
    // lookup misses.
    const mixedPin = JSON.parse(JSON.stringify(memoPkg)) as Record<string, unknown>;
    const helloCatalog = staticSourceCatalogs().sagas.find((entry) => entry.id === helloSaga.id);
    (mixedPin.modules as Record<string, unknown>[])[0] = {
      sagaId: helloSaga.id,
      name: helloCatalog?.name ?? "hello",
      revision: helloCatalog?.revision ?? "hello-v1",
      description: helloCatalog?.description ?? "hello",
      requiredIntegrations: [...(helloCatalog?.requiredIntegrations ?? [])],
    };
    await expect(importSourcePackage(mixedPin)).rejects.toMatchObject({ code: "SOURCE_MANIFEST_MISMATCH" });
  });

  it("covers the validatePackage revision gate and import status arms", async () => {
    const pkg = await capturedPackage();
    // Module revision drifts from deployed code while the manifest pin stays
    // valid: validatePackage (not the installer) throws REVISION_MISMATCH.
    const driftedModule = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    (driftedModule.modules as Record<string, unknown>[])[0] = {
      ...(pkg.modules[0] as unknown as Record<string, unknown>),
      revision: "echo-v999",
    };
    await expect(importSourcePackage(driftedModule)).rejects.toMatchObject({ code: "REVISION_MISMATCH", status: 409 });
    // Non-string module revision renders "?" in the detail.
    const untypedModule = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    (untypedModule.modules as Record<string, unknown>[])[0] = {
      ...(pkg.modules[0] as unknown as Record<string, unknown>),
      revision: 42,
    };
    await expect(importSourcePackage(untypedModule)).rejects.toMatchObject({ code: "REVISION_MISMATCH" });
    // Bumping both pins together fails earlier in the installer with the same
    // code, proving the surfaces agree.
    const drifted = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    (drifted.modules as Record<string, unknown>[])[0] = {
      ...(pkg.modules[0] as unknown as Record<string, unknown>),
      revision: "echo-v999",
    };
    (drifted.manifest as Record<string, unknown[]>).sagas = [{ id: echoSaga.id, revision: "echo-v999" }];
    await expect(importSourcePackage(drifted)).rejects.toMatchObject({ code: "REVISION_MISMATCH", status: 409 });
    // Non-Error staging failure renders String(error) in EXPORT_JOB_FAILED.
    await expect(
      runExportJob(pkg, {
        writeTemp: () => {
          throw "disk gone";
        },
        commit: () => {},
        cleanup: () => {},
      }),
    ).rejects.toMatchObject({ code: "EXPORT_JOB_FAILED" });
  });
});
