// SPDX-License-Identifier: AGPL-3.0
// Solutions install (ADR 011, Accepted): manifest-driven install with
// owned/loose enforcement, proven against real local D1 in workerd. The full
// migration chain (0001-0004) applies in order, so this also proves the
// managed_by migration composes with the existing schema.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import {
  digestSaga,
  ECHO_INTEGRATION_ID,
  echoSaga,
  helloSaga,
  NINJA_INTEGRATION_ID,
  ninjaSaga,
  smokeSaga,
} from "../src/domain";
import { installBundle, parseBundleManifest, updateConnectionEndpoint } from "../src/solutions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0010_solutions_activation.sql?raw";
import exampleManifest from "../bundles/echo-starter/solution.manifest.json";

const bindings = env as unknown as Bindings;
const BUNDLE_ID = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
const ENDPOINT_V1 = "http://127.0.0.1:8788/echo";
const ENDPOINT_V2 = "http://127.0.0.1:8789/echo";

interface MutableManifest {
  manifestVersion: number;
  bundle: { id: string; name: string; version: string };
  sagas: { id: string; revision: string }[];
  integrations: {
    id: string;
    connections: { org: string; config: Record<string, string>; secretsRequired: string[] }[];
  }[];
  config: { key: string; value: string }[];
}

function manifest(version = "1.0.0", endpoint = ENDPOINT_V1): MutableManifest {
  return {
    manifestVersion: 1,
    bundle: { id: BUNDLE_ID, name: "echo-starter", version },
    sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    integrations: [
      {
        id: ECHO_INTEGRATION_ID,
        connections: [{ org: "default", config: { endpoint }, secretsRequired: [] as string[] }],
      },
    ],
    config: [{ key: "supportEmail", value: "ops@example.com" }],
  };
}

async function connectionRow(orgName: string, integrationId: string) {
  const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
    .bind(orgName)
    .first<{ id: string }>();
  if (!org) return null;
  return bindings.DB.prepare("SELECT endpoint, managed_by FROM connections WHERE org_id = ? AND integration_id = ?")
    .bind(org.id, integrationId)
    .first<{ endpoint: string; managed_by: string | null }>();
}

async function orgCount() {
  const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration5);
});

afterEach(async () => {
  await reset();
});

it("installs a fresh org from the manifest and records the install", async () => {
  const result = await installBundle(bindings.DB, manifest());
  expect(result.drift).toEqual({ created: 3, updated: 0, skipped: 0, deleted: 0 });
  expect(result.dryRun).toBe(false);
  expect(result.bundleId).toBe(BUNDLE_ID);
  const row = await connectionRow("default", ECHO_INTEGRATION_ID);
  expect(row?.endpoint).toBe(ENDPOINT_V1);
  expect(row?.managed_by).toBe(`${BUNDLE_ID}@1.0.0`);
  const ledger = await bindings.DB.prepare("SELECT version, manifest_hash FROM bundle_installs WHERE bundle_id = ?")
    .bind(BUNDLE_ID)
    .first<{ version: string; manifest_hash: string }>();
  expect(ledger?.version).toBe("1.0.0");
  expect(ledger?.manifest_hash).toBe(result.manifestHash);
});

it("re-running a converged install is a no-op that still appends the ledger", async () => {
  await installBundle(bindings.DB, manifest());
  const second = await installBundle(bindings.DB, manifest());
  expect(second.drift).toEqual({ created: 0, updated: 0, skipped: 3, deleted: 0 });
  const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM bundle_installs WHERE bundle_id = ?")
    .bind(BUNDLE_ID)
    .first<{ n: number }>();
  expect(rows?.n).toBe(2);
});

it("reconciles drifted managed rows back to the manifest", async () => {
  await installBundle(bindings.DB, manifest());
  const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
    .bind("default")
    .first<{ id: string }>();
  await bindings.DB.prepare("UPDATE connections SET endpoint = ? WHERE org_id = ? AND integration_id = ?")
    .bind("http://127.0.0.1:9999/drifted", org?.id, ECHO_INTEGRATION_ID)
    .run();
  const result = await installBundle(bindings.DB, manifest());
  expect(result.drift).toEqual({ created: 0, updated: 1, skipped: 2, deleted: 0 });
  const row = await connectionRow("default", ECHO_INTEGRATION_ID);
  expect(row?.endpoint).toBe(ENDPOINT_V1);
});

it("rejects live mutation of managed rows but allows loose rows", async () => {
  await installBundle(bindings.DB, manifest());
  const org = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
    .bind("default")
    .first<{ id: string }>();
  await expect(
    updateConnectionEndpoint(bindings.DB, org?.id as string, ECHO_INTEGRATION_ID, ENDPOINT_V2),
  ).rejects.toMatchObject({
    status: 409,
    code: "MANAGED_RESOURCE",
  });
  // A loose row (managed_by NULL, created outside install) stays writable.
  await bindings.DB.prepare(
    "INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, NULL)",
  )
    .bind("00000000-0000-4000-8000-000000000099", org?.id, NINJA_INTEGRATION_ID, "https://api.ninjaone.test")
    .run();
  await updateConnectionEndpoint(bindings.DB, org?.id as string, NINJA_INTEGRATION_ID, "https://api2.ninjaone.test");
  const loose = await connectionRow("default", NINJA_INTEGRATION_ID);
  expect(loose?.endpoint).toBe("https://api2.ninjaone.test");
  expect(loose?.managed_by).toBeNull();
});

it("rolls back by reinstalling the older manifest with force", async () => {
  await installBundle(bindings.DB, manifest("1.0.0"));
  const upgraded = await installBundle(bindings.DB, manifest("2.0.0", ENDPOINT_V2));
  expect(upgraded.drift).toEqual({ created: 0, updated: 3, skipped: 0, deleted: 0 });
  await expect(installBundle(bindings.DB, manifest("1.0.0"))).rejects.toMatchObject({
    status: 409,
    code: "DOWNGRADE_REFUSED",
  });
  const rolledBack = await installBundle(bindings.DB, manifest("1.0.0"), { force: true });
  expect(rolledBack.drift).toEqual({ created: 0, updated: 3, skipped: 0, deleted: 0 });
  const row = await connectionRow("default", ECHO_INTEGRATION_ID);
  expect(row?.endpoint).toBe(ENDPOINT_V1);
  expect(row?.managed_by).toBe(`${BUNDLE_ID}@1.0.0`);
});

it("refuses half-credentialed installs without persisting anything", async () => {
  const ninjaManifest = {
    manifestVersion: 1,
    bundle: { id: BUNDLE_ID, name: "ninja-addon", version: "1.0.0" },
    sagas: [{ id: ninjaSaga.id, revision: ninjaSaga.revision }],
    integrations: [
      {
        id: NINJA_INTEGRATION_ID,
        connections: [
          {
            org: "acme",
            config: { endpoint: "https://api.ninjaone.test" },
            secretsRequired: ["clientSecret"],
          },
        ],
      },
    ],
    config: [],
  };
  await expect(installBundle(bindings.DB, ninjaManifest)).rejects.toMatchObject({
    status: 400,
    code: "SECRET_NOT_CONFIGURED",
  });
  expect(await orgCount()).toBe(0);
  const ok = await installBundle(bindings.DB, ninjaManifest, { secrets: { clientSecret: "sentinel" } });
  expect(ok.drift).toEqual({ created: 2, updated: 0, skipped: 0, deleted: 0 });
});

it("rejects credentials embedded in the manifest", async () => {
  const leaky = manifest();
  leaky.integrations[0]?.connections.push({
    org: "default",
    config: { endpoint: ENDPOINT_V1, apiKey: "hunter2" },
    secretsRequired: [],
  });
  await expect(installBundle(bindings.DB, leaky)).rejects.toMatchObject({
    status: 400,
    code: "CREDENTIAL_IN_MANIFEST",
  });
  const leakyConfig = manifest();
  leakyConfig.config.push({ key: "clientSecret", value: "hunter2" });
  await expect(installBundle(bindings.DB, leakyConfig)).rejects.toMatchObject({
    status: 400,
    code: "CREDENTIAL_IN_MANIFEST",
  });
});

it("fails closed on unknown sagas and revision drift", async () => {
  const unknown = manifest();
  unknown.sagas = [{ id: "00000000-0000-4000-8000-000000000000", revision: "ghost-v1" }];
  await expect(installBundle(bindings.DB, unknown)).rejects.toMatchObject({
    status: 400,
    code: "UNKNOWN_SAGA",
  });
  const drifted = manifest();
  drifted.sagas = [{ id: echoSaga.id, revision: "echo-v999" }];
  await expect(installBundle(bindings.DB, drifted)).rejects.toMatchObject({
    status: 409,
    code: "REVISION_MISMATCH",
  });
});

it("never adopts loose rows or rows managed by another bundle", async () => {
  const orgId = crypto.randomUUID();
  await bindings.DB.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(orgId, "default").run();
  await bindings.DB.prepare(
    "INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, NULL)",
  )
    .bind(crypto.randomUUID(), orgId, ECHO_INTEGRATION_ID, ENDPOINT_V1)
    .run();
  await expect(installBundle(bindings.DB, manifest())).rejects.toMatchObject({
    status: 409,
    code: "INSTALL_CONFLICT",
  });
  await bindings.DB.prepare("UPDATE connections SET managed_by = ? WHERE org_id = ? AND integration_id = ?")
    .bind("00000000-0000-4000-8000-000000000000@9.9.9", orgId, ECHO_INTEGRATION_ID)
    .run();
  await expect(installBundle(bindings.DB, manifest())).rejects.toMatchObject({
    status: 409,
    code: "INSTALL_CONFLICT",
  });
});

it("keeps the installer catalog in agreement with the static Saga definitions", () => {
  // The installer must accept pins for every Saga the code catalog defines
  // (same stable IDs and revisions the Saga definitions are built from).
  for (const saga of [echoSaga, ninjaSaga, digestSaga, smokeSaga, helloSaga]) {
    const parsed = parseBundleManifest({
      manifestVersion: 1,
      bundle: { id: BUNDLE_ID, name: "catalog-probe", version: "1.0.0" },
      sagas: [{ id: saga.id, revision: saga.revision }],
      integrations: [
        {
          id: ECHO_INTEGRATION_ID,
          connections: [{ org: "probe", config: { endpoint: ENDPOINT_V1 }, secretsRequired: [] }],
        },
      ],
      config: [],
    });
    expect(parsed.sagas).toHaveLength(1);
  }
});

it("accepts the checked-in example bundle and dry-runs it without writes", async () => {
  const parsed = parseBundleManifest(exampleManifest);
  expect(parsed.bundle.name).toBe("echo-starter");
  const planned = await installBundle(bindings.DB, exampleManifest, { dryRun: true, orgName: "default" });
  expect(planned.dryRun).toBe(true);
  expect(planned.drift).toEqual({ created: 3, updated: 0, skipped: 0, deleted: 0 });
  expect(await orgCount()).toBe(0);
  expect(await connectionRow("default", ECHO_INTEGRATION_ID)).toBeNull();
});
