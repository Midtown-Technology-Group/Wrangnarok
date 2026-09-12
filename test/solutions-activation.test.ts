// SPDX-License-Identifier: AGPL-3.0
// SOL-01 activation contract (ADR 011): staged/fenced activation, scoped
// managed-absentee deletion, immutable install evidence, fail-closed
// execution against the active install/revision, and the explicit
// local/loose development exception. Every test runs against real local D1
// through the full migration chain (0001-0005); the only doubles are
// outbound vendor fetch (worker submit tests) and a prepare() Proxy that
// holds one fenced statement to force a race.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { ECHO_INTEGRATION_ID, echoSaga, executionId, NINJA_INTEGRATION_ID, ninjaSaga, smokeSaga } from "../src/domain";
import { activeInstallFor, installBundle, requireActiveInstall } from "../src/solutions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0010_solutions_activation.sql?raw";

const bindings = env as unknown as Bindings;
const BUNDLE_ID = "b10a7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c2d";
const OTHER_BUNDLE_ID = "c20b7c2e-3f4d-4a5b-8c6d-7e8f9a0b1c3e";
const ENDPOINT_V1 = "http://127.0.0.1:8788/echo";
const ENDPOINT_V2 = "http://127.0.0.1:8789/echo";
const ENDPOINT_V3 = "http://127.0.0.1:8790/echo";
const LAB_ORG_ID = "00000000-0000-4000-8000-000000000001";

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

function twoIntegrationManifest(version: string, endpoint = ENDPOINT_V1): MutableManifest {
  const m = manifest(version, endpoint);
  m.integrations.push({
    id: NINJA_INTEGRATION_ID,
    connections: [
      { org: "default", config: { endpoint: "https://api.ninjaone.test" }, secretsRequired: ["clientSecret"] },
    ],
  });
  return m;
}

async function orgId(name: string): Promise<string | null> {
  const row = await bindings.DB.prepare("SELECT id FROM organizations WHERE name = ?")
    .bind(name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function pointer(bundleId = BUNDLE_ID, name = "default") {
  const id = await orgId(name);
  if (!id) return null;
  return activeInstallFor(bindings.DB, bundleId, id);
}

async function ledgerCount(bundleId = BUNDLE_ID, name = "default"): Promise<number> {
  const id = await orgId(name);
  if (!id) return 0;
  const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM bundle_installs WHERE bundle_id = ? AND org_id = ?")
    .bind(bundleId, id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function connectionRow(name: string, integrationId: string) {
  const id = await orgId(name);
  if (!id) return null;
  return bindings.DB.prepare(
    "SELECT id, endpoint, config_json AS configJson, managed_by FROM connections WHERE org_id = ? AND integration_id = ?",
  )
    .bind(id, integrationId)
    .first<{ id: string; endpoint: string; configJson: string | null; managed_by: string | null }>();
}

/** Hold one fenced statement open so a concurrent writer can land first. */
function gateStatement(matchSql: string) {
  const gate: { release: (() => void) | null } = { release: null };
  let resolveArrived!: () => void;
  const arrived = new Promise<void>((resolve) => {
    resolveArrived = resolve;
  });
  const gated = new Proxy(bindings.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          const stmt = (target.prepare as (...args: unknown[]) => D1PreparedStatement)(sql, ...rest);
          if (typeof sql === "string" && sql.includes(matchSql)) {
            return {
              bind: (...values: unknown[]) => {
                const bound = stmt.bind(...values);
                return {
                  first: () => bound.first(),
                  all: () => bound.all(),
                  run: () =>
                    new Promise((resolve) => {
                      gate.release = () => resolve(bound.run());
                      resolveArrived();
                    }),
                } as unknown as D1PreparedStatement;
              },
            } as unknown as D1PreparedStatement;
          }
          return stmt;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
  return { gated, arrived, release: () => gate.release?.() };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(migration5);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("activates the pointer on a fresh install and keeps it stable on no-op re-runs", async () => {
  const first = await installBundle(bindings.DB, manifest());
  expect(first.drift).toEqual({ created: 3, updated: 0, skipped: 0, deleted: 0 });
  const active = await pointer();
  expect(active).toMatchObject({ bundleId: BUNDLE_ID, version: "1.0.0" });
  expect(active?.manifestHash).toBe(first.manifestHash);
  // The pointer names the ledger row just appended: immutable evidence.
  const defaultOrg = (await orgId("default")) as string;
  const activeRow = await bindings.DB.prepare(
    "SELECT install_id AS installId FROM bundle_active WHERE bundle_id = ? AND org_id = ?",
  )
    .bind(BUNDLE_ID, defaultOrg)
    .first<{ installId: number }>();
  const evidence = await bindings.DB.prepare("SELECT bundle_id AS bundleId, version FROM bundle_installs WHERE id = ?")
    .bind(activeRow?.installId)
    .first<{ bundleId: string; version: string }>();
  expect(evidence).toMatchObject({ bundleId: BUNDLE_ID, version: "1.0.0" });

  const second = await installBundle(bindings.DB, manifest());
  expect(second.drift).toEqual({ created: 0, updated: 0, skipped: 3, deleted: 0 });
  // No-op re-runs still append ledger evidence but never rewrite the pointer.
  expect(await ledgerCount()).toBe(2);
  expect(await pointer()).toMatchObject({ bundleId: BUNDLE_ID, version: "1.0.0", manifestHash: first.manifestHash });
});

it("leaves the pointer on the previous complete version when interrupted, then converges on retry", async () => {
  await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  const hook = {
    internals: {
      afterWrite: (completed: number) => {
        if (completed >= 3) throw new Error("injected interruption after three writes");
      },
    },
  };
  await expect(installBundle(bindings.DB, manifest("2.0.0", ENDPOINT_V2), hook)).rejects.toThrow(
    "injected interruption after three writes",
  );
  // Ledger evidence of the attempt exists, but activation never ran: the
  // pointer still names the complete v1 install while a row already
  // carries v2 content (restart convergence, not atomicity).
  expect(await ledgerCount()).toBe(2);
  expect(await pointer()).toMatchObject({ version: "1.0.0" });
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.endpoint).toBe(ENDPOINT_V2);

  const retried = await installBundle(bindings.DB, manifest("2.0.0", ENDPOINT_V2));
  expect(retried.drift.deleted).toBe(0);
  expect(await pointer()).toMatchObject({ version: "2.0.0", manifestHash: retried.manifestHash });
  const row = await connectionRow("default", ECHO_INTEGRATION_ID);
  expect(row?.endpoint).toBe(ENDPOINT_V2);
  expect(row?.managed_by).toBe(`${BUNDLE_ID}@2.0.0`);
});

it("lets an interrupted upgrade fall back to the active version without force", async () => {
  await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  const hook = {
    internals: {
      afterWrite: (completed: number) => {
        if (completed >= 3) throw new Error("injected interruption before activation");
      },
    },
  };
  await expect(installBundle(bindings.DB, manifest("2.0.0", ENDPOINT_V2), hook)).rejects.toThrow(
    "injected interruption before activation",
  );
  // The failed v2 attempt is the newest ledger row, but the pointer still
  // names the complete v1 install: re-running v1 reconciles back to the
  // active version without force (fencing reads the pointer, not newest-row).
  // Regression for #161.
  expect(await pointer()).toMatchObject({ version: "1.0.0" });
  const recovered = await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  expect(await pointer()).toMatchObject({ version: "1.0.0", manifestHash: recovered.manifestHash });
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.endpoint).toBe(ENDPOINT_V1);
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.managed_by).toBe(`${BUNDLE_ID}@1.0.0`);
});

it("advertises nothing when the very first install is interrupted", async () => {
  const hook = {
    internals: {
      afterWrite: (completed: number) => {
        if (completed >= 1) throw new Error("injected interruption after one row");
      },
    },
  };
  await expect(installBundle(bindings.DB, manifest(), hook)).rejects.toThrow("injected interruption after one row");
  expect(await pointer()).toBeNull();
  const recovered = await installBundle(bindings.DB, manifest());
  expect(recovered.drift.created).toBeGreaterThan(0);
  expect(await pointer()).toMatchObject({ version: "1.0.0", manifestHash: recovered.manifestHash });
});

it("refuses same-version divergent content without moving the pointer", async () => {
  await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  const forked = manifest("1.0.0", ENDPOINT_V2);
  await expect(installBundle(bindings.DB, forked)).rejects.toMatchObject({ status: 409, code: "INSTALL_CONFLICT" });
  expect(await pointer()).toMatchObject({ version: "1.0.0" });
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.endpoint).toBe(ENDPOINT_V1);
  // Ledger evidence still records only the complete install.
  expect(await ledgerCount()).toBe(1);
});

it("fails the fenced activation move closed when a concurrent install wins", async () => {
  await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  const { gated, arrived, release } = gateStatement("UPDATE bundle_active");
  const pending = installBundle(gated, manifest("2.0.0", ENDPOINT_V2));
  await arrived;
  await installBundle(bindings.DB, manifest("3.0.0", ENDPOINT_V3));
  release();
  await expect(pending).rejects.toMatchObject({ status: 409, code: "INSTALL_CONFLICT" });
  // The winner converged everything before the loser failed: the pointer
  // names v3 and the rows carry v3 content. The loser's activation refused
  // to move the pointer backward instead of silently overwriting it.
  expect(await pointer()).toMatchObject({ version: "3.0.0" });
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.endpoint).toBe(ENDPOINT_V3);
  const healed = await installBundle(bindings.DB, manifest("3.0.0", ENDPOINT_V3));
  expect(healed.drift).toMatchObject({ created: 0, updated: 0, skipped: 3, deleted: 0 });
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.endpoint).toBe(ENDPOINT_V3);
  expect(await pointer()).toMatchObject({ version: "3.0.0", manifestHash: healed.manifestHash });
});

it("deletes managed absentees scoped to the bundle install and nothing else", async () => {
  await installBundle(bindings.DB, twoIntegrationManifest("1.0.0"), { secrets: { clientSecret: "sentinel" } });
  expect(await connectionRow("default", NINJA_INTEGRATION_ID)).not.toBeNull();
  // Rows outside this bundle install must survive: a loose row and a
  // foreign-bundle row in another org (UNIQUE(org, integration) keeps each
  // org to one row per integration).
  const otherOrg = crypto.randomUUID();
  await bindings.DB.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(otherOrg, "other").run();
  await bindings.DB.prepare(
    "INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, NULL)",
  )
    .bind(crypto.randomUUID(), otherOrg, ECHO_INTEGRATION_ID, "https://loose.example")
    .run();
  await bindings.DB.prepare(
    "INSERT INTO connections(id, org_id, integration_id, endpoint, managed_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), otherOrg, NINJA_INTEGRATION_ID, "https://foreign.example", `${OTHER_BUNDLE_ID}@9.9.9`)
    .run();
  // v2 drops the ninja connection: exactly that managed row is deleted.
  const pruned = manifest("2.0.0", ENDPOINT_V2);
  const result = await installBundle(bindings.DB, pruned);
  expect(result.drift.deleted).toBe(1);
  expect(await connectionRow("default", NINJA_INTEGRATION_ID)).toBeNull();
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.endpoint).toBe(ENDPOINT_V2);
  const survivors = await bindings.DB.prepare(
    "SELECT integration_id AS id, endpoint FROM connections WHERE org_id = ? ORDER BY integration_id",
  )
    .bind(otherOrg)
    .all<{ id: string; endpoint: string }>();
  expect(survivors.results).toHaveLength(2);
});

it("reconciles manifest config entries and drops removed keys", async () => {
  await installBundle(bindings.DB, manifest());
  const id = (await orgId("default")) as string;
  const stored = await bindings.DB.prepare(
    "SELECT config_value AS value FROM bundle_config WHERE bundle_id = ? AND org_id = ? AND config_key = ?",
  )
    .bind(BUNDLE_ID, id, "supportEmail")
    .first<{ value: string }>();
  expect(stored?.value).toBe("ops@example.com");
  const v2 = manifest("2.0.0", ENDPOINT_V2);
  v2.config = [
    { key: "supportEmail", value: "new@example.com" },
    { key: "pagerDuty", value: "pd-default" },
  ];
  const upgraded = await installBundle(bindings.DB, v2);
  expect(upgraded.drift.updated).toBeGreaterThan(0);
  const v3 = manifest("3.0.0", ENDPOINT_V2);
  v3.config = [{ key: "supportEmail", value: "new@example.com" }];
  const pruned = await installBundle(bindings.DB, v3);
  expect(pruned.drift.deleted).toBe(1);
  const gone = await bindings.DB.prepare(
    "SELECT config_value AS value FROM bundle_config WHERE bundle_id = ? AND org_id = ? AND config_key = ?",
  )
    .bind(BUNDLE_ID, id, "pagerDuty")
    .first<{ value: string }>();
  expect(gone).toBeNull();
});

it("reconciles sibling connection-config keys instead of skipping on endpoint alone", async () => {
  await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  const v2 = manifest("2.0.0", ENDPOINT_V1);
  v2.integrations[0]!.connections[0]!.config = { endpoint: ENDPOINT_V1, region: "us" };
  const result = await installBundle(bindings.DB, v2);
  // The connection reconciles (not skips) on the sibling key; the config
  // entry and saga pin bump their markers to the new version.
  expect(result.drift).toMatchObject({ updated: 3, skipped: 0, deleted: 0 });
  const row = await connectionRow("default", ECHO_INTEGRATION_ID);
  expect(row?.managed_by).toBe(`${BUNDLE_ID}@2.0.0`);
  expect(JSON.parse(row?.configJson ?? "{}")).toMatchObject({ endpoint: ENDPOINT_V1, region: "us" });
});

it("bumps a stale same-bundle marker even when content already matches", async () => {
  await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  const id = (await orgId("default")) as string;
  await bindings.DB.prepare("UPDATE connections SET managed_by = ? WHERE org_id = ? AND integration_id = ?")
    .bind(`${BUNDLE_ID}@0.9.0`, id, ECHO_INTEGRATION_ID)
    .run();
  const result = await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  expect(result.drift).toMatchObject({ updated: 1, skipped: 2, deleted: 0 });
  expect((await connectionRow("default", ECHO_INTEGRATION_ID))?.managed_by).toBe(`${BUNDLE_ID}@1.0.0`);
});

it("derives org installs from saga pins alone for saga-only bundles", async () => {
  const sagaOnly = {
    manifestVersion: 1,
    bundle: { id: BUNDLE_ID, name: "saga-only", version: "1.0.0" },
    sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    integrations: [],
    config: [],
  };
  const result = await installBundle(bindings.DB, sagaOnly, { orgName: "saga-org" });
  expect(result.drift).toMatchObject({ created: 1, skipped: 0, deleted: 0 });
  expect(await orgId("saga-org")).not.toBeNull();
  const gate = await requireActiveInstall(
    bindings.DB,
    echoSaga.id,
    echoSaga.revision,
    (await orgId("saga-org")) as string,
  );
  expect(gate).toMatchObject({ bundleId: BUNDLE_ID, version: "1.0.0" });
  // A saga the bundle does not pin stays denied even in an installed org.
  await expect(
    requireActiveInstall(bindings.DB, ninjaSaga.id, ninjaSaga.revision, (await orgId("saga-org")) as string),
  ).rejects.toMatchObject({ status: 409, code: "NO_ACTIVE_INSTALL" });
});

it("rejects saga-only installs without an org scope and scoped orgs with no connections", async () => {
  const sagaOnly = {
    manifestVersion: 1,
    bundle: { id: BUNDLE_ID, name: "saga-only", version: "1.0.0" },
    sagas: [{ id: echoSaga.id, revision: echoSaga.revision }],
    integrations: [],
    config: [],
  };
  await expect(installBundle(bindings.DB, sagaOnly)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
  await expect(installBundle(bindings.DB, manifest(), { orgName: "ghost" })).rejects.toMatchObject({
    code: "ORG_NOT_DECLARED",
  });
});

it("fails execution closed on revision drift and heals on reinstall", async () => {
  await installBundle(bindings.DB, manifest());
  const id = (await orgId("default")) as string;
  await bindings.DB.prepare("UPDATE bundle_sagas SET revision = ? WHERE bundle_id = ? AND org_id = ? AND saga_id = ?")
    .bind("echo-v999", BUNDLE_ID, id, echoSaga.id)
    .run();
  await expect(requireActiveInstall(bindings.DB, echoSaga.id, echoSaga.revision, id)).rejects.toMatchObject({
    status: 409,
    code: "STALE_INSTALL_REVISION",
  });
  await installBundle(bindings.DB, manifest());
  const gate = await requireActiveInstall(bindings.DB, echoSaga.id, echoSaga.revision, id);
  expect(gate).toMatchObject({ bundleId: BUNDLE_ID, version: "1.0.0" });
});

it("treats a lost activation pointer as denied and heals it on reinstall", async () => {
  const first = await installBundle(bindings.DB, manifest());
  const id = (await orgId("default")) as string;
  await bindings.DB.prepare("DELETE FROM bundle_active WHERE bundle_id = ? AND org_id = ?").bind(BUNDLE_ID, id).run();
  expect(await activeInstallFor(bindings.DB, BUNDLE_ID, id)).toBeNull();
  await expect(requireActiveInstall(bindings.DB, echoSaga.id, echoSaga.revision, id)).rejects.toMatchObject({
    status: 409,
    code: "NO_ACTIVE_INSTALL",
  });
  const healed = await installBundle(bindings.DB, manifest());
  expect(healed.drift).toMatchObject({ created: 0, updated: 0, skipped: 3, deleted: 0 });
  expect(await pointer()).toMatchObject({ version: "1.0.0", manifestHash: first.manifestHash });
});

it("keeps install evidence immutable at the database layer", async () => {
  await installBundle(bindings.DB, manifest());
  await expect(
    bindings.DB.prepare("UPDATE bundle_installs SET version = ? WHERE bundle_id = ?").bind("9.9.9", BUNDLE_ID).run(),
  ).rejects.toThrow(/immutable/);
  await expect(
    bindings.DB.prepare("DELETE FROM bundle_installs WHERE bundle_id = ?").bind(BUNDLE_ID).run(),
  ).rejects.toThrow(/immutable/);
  expect(await ledgerCount()).toBe(1);
});

it("moves the pointer on forced rollback and restores managed values with stable IDs", async () => {
  const v1 = await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1));
  const firstId = (await connectionRow("default", ECHO_INTEGRATION_ID))?.id;
  const v2 = manifest("2.0.0", ENDPOINT_V2);
  v2.config = [{ key: "supportEmail", value: "new@example.com" }];
  await installBundle(bindings.DB, v2);
  expect(await pointer()).toMatchObject({ version: "2.0.0" });
  await expect(installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1))).rejects.toMatchObject({
    code: "DOWNGRADE_REFUSED",
  });
  // Forced rollback restores endpoint and config through the same path and
  // moves the pointer back; the managed Connection keeps its stable ID.
  const rolledBack = await installBundle(bindings.DB, manifest("1.0.0", ENDPOINT_V1), { force: true });
  expect(rolledBack.drift.deleted).toBe(0);
  expect(await pointer()).toMatchObject({ version: "1.0.0", manifestHash: v1.manifestHash });
  const row = await connectionRow("default", ECHO_INTEGRATION_ID);
  expect(row?.endpoint).toBe(ENDPOINT_V1);
  expect(row?.id).toBe(firstId);
  const id = (await orgId("default")) as string;
  const restored = await bindings.DB.prepare(
    "SELECT config_value AS value FROM bundle_config WHERE bundle_id = ? AND org_id = ? AND config_key = ?",
  )
    .bind(BUNDLE_ID, id, "supportEmail")
    .first<{ value: string }>();
  expect(restored?.value).toBe("ops@example.com");
});

it("rejects config and saga-pin rows whose marker leaves the bundle lineage", async () => {
  await installBundle(bindings.DB, manifest());
  const id = (await orgId("default")) as string;
  // bundle_config and bundle_sagas are namespaced by bundle id, so a
  // hijack here means a row in our namespace whose marker no longer
  // descends from this bundle: only hand tampering (or a writer bug)
  // produces it, and install fails closed instead of adopting it.
  await bindings.DB.prepare(
    "UPDATE bundle_config SET managed_by = ? WHERE bundle_id = ? AND org_id = ? AND config_key = ?",
  )
    .bind(`${OTHER_BUNDLE_ID}@9.9.9`, BUNDLE_ID, id, "supportEmail")
    .run();
  await expect(installBundle(bindings.DB, manifest())).rejects.toMatchObject({ code: "INSTALL_CONFLICT" });
  await bindings.DB.prepare(
    "UPDATE bundle_config SET managed_by = ? WHERE bundle_id = ? AND org_id = ? AND config_key = ?",
  )
    .bind(`${BUNDLE_ID}@1.0.0`, BUNDLE_ID, id, "supportEmail")
    .run();
  await bindings.DB.prepare("UPDATE bundle_sagas SET managed_by = ? WHERE bundle_id = ? AND org_id = ? AND saga_id = ?")
    .bind(`${OTHER_BUNDLE_ID}@9.9.9`, BUNDLE_ID, id, echoSaga.id)
    .run();
  await expect(installBundle(bindings.DB, manifest())).rejects.toMatchObject({ code: "INSTALL_CONFLICT" });
});

it("refuses absentee deletes that lose a race", async () => {
  await installBundle(bindings.DB, twoIntegrationManifest("1.0.0"), { secrets: { clientSecret: "sentinel" } });
  const { gated, arrived, release } = gateStatement("DELETE FROM connections");
  const pending = installBundle(gated, manifest("2.0.0", ENDPOINT_V2));
  await arrived;
  const id = (await orgId("default")) as string;
  await bindings.DB.prepare("UPDATE connections SET managed_by = ? WHERE org_id = ? AND integration_id = ?")
    .bind(`${BUNDLE_ID}@1.0.0+tampered`, id, NINJA_INTEGRATION_ID)
    .run();
  release();
  await expect(pending).rejects.toMatchObject({ status: 409, code: "INSTALL_CONFLICT" });
});

it("keeps pre-activation databases on the endpoint-only path with the gate open", async () => {
  // A database migrated only through 0004 predates activation: installs
  // reconcile endpoints, advertise no pointer, and execution stays loose.
  await bindings.DB.exec("DROP TABLE IF EXISTS bundle_active");
  await bindings.DB.exec("DROP TABLE IF EXISTS bundle_config");
  await bindings.DB.exec("DROP TABLE IF EXISTS bundle_sagas");
  const result = await installBundle(bindings.DB, manifest());
  expect(result.drift).toEqual({ created: 1, updated: 0, skipped: 0, deleted: 0 });
  const id = (await orgId("default")) as string;
  expect(await activeInstallFor(bindings.DB, BUNDLE_ID, id)).toBeNull();
  expect(await requireActiveInstall(bindings.DB, echoSaga.id, echoSaga.revision, id)).toBeNull();
});

it("allows local/loose execution with no installs and denies it once installs exist", async () => {
  const freshOrg = crypto.randomUUID();
  await bindings.DB.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(freshOrg, "fresh").run();
  expect(await requireActiveInstall(bindings.DB, echoSaga.id, echoSaga.revision, freshOrg)).toBeNull();
  const pruned = manifest("1.0.0", ENDPOINT_V1);
  pruned.integrations[0]!.connections[0]!.org = "fresh";
  await installBundle(bindings.DB, pruned);
  const gate = await requireActiveInstall(bindings.DB, echoSaga.id, echoSaga.revision, freshOrg);
  expect(gate).toMatchObject({ bundleId: BUNDLE_ID, version: "1.0.0" });
  await expect(requireActiveInstall(bindings.DB, smokeSaga.id, smokeSaga.revision, freshOrg)).rejects.toMatchObject({
    status: 409,
    code: "NO_ACTIVE_INSTALL",
  });
});

function submitRequest(sagaId: string, body: unknown, key: string) {
  return new Request("http://local.test/api/executions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ sagaId, input: body }),
  });
}

async function executionCount(): Promise<number> {
  const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
  return row?.n ?? 0;
}

it("denies worker submits with no applicable active install and persists nothing", async () => {
  await bindings.DB.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(LAB_ORG_ID, "default").run();
  const ninjaOnly = twoIntegrationManifest("1.0.0");
  ninjaOnly.sagas = [{ id: ninjaSaga.id, revision: ninjaSaga.revision }];
  ninjaOnly.integrations = ninjaOnly.integrations.filter((i) => i.id === NINJA_INTEGRATION_ID);
  await installBundle(bindings.DB, ninjaOnly, { secrets: { clientSecret: "sentinel" } });
  const denied = await worker.fetch(submitRequest(echoSaga.id, { message: "hi" }, "sol01-denied-0001"), bindings);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({ error: { code: "NO_ACTIVE_INSTALL" } });
  expect(await executionCount()).toBe(0);
});

it("serves worker submits against the active install and fails them on revision drift", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ENDPOINT_V1) throw new Error(`Unexpected outbound request to ${url}`);
    return Response.json({ message: "hi" });
  });
  await bindings.DB.prepare("INSERT INTO organizations(id, name) VALUES (?, ?)").bind(LAB_ORG_ID, "default").run();
  await installBundle(bindings.DB, manifest());
  const allowedKey = "sol01-allowed-001";
  const allowedId = await executionId(
    { orgId: LAB_ORG_ID, userId: "00000000-0000-4000-8000-000000000002" },
    allowedKey,
  );
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, allowedId);
  const accepted = await worker.fetch(submitRequest(echoSaga.id, { message: "hi" }, allowedKey), bindings);
  expect(accepted.status).toBe(202);
  await instance.waitForStatus("complete");
  const id = (await orgId("default")) as string;
  await bindings.DB.prepare("UPDATE bundle_sagas SET revision = ? WHERE bundle_id = ? AND org_id = ? AND saga_id = ?")
    .bind("echo-v999", BUNDLE_ID, id, echoSaga.id)
    .run();
  const stale = await worker.fetch(submitRequest(echoSaga.id, { message: "hi" }, "sol01-stale-0001"), bindings);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "STALE_INSTALL_REVISION" } });
  expect(await executionCount()).toBe(1);
});
