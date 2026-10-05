// SPDX-License-Identifier: AGPL-3.0
// Capability-based Connection resolution (issue #262, ADR TBD): assignment
// persistence, org-bound lazy resolution with declared/undeclared semantics,
// frozen Execution metadata, entity mappings, readiness reporting, and the
// operator routes. Runs in real workerd with a real D1 binding (full
// migration chain via the shared harness); no vendor HTTP is touched here.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  assignCapability,
  checkReadiness,
  deleteMapping,
  freezeBinding,
  listCapabilities,
  listExecutionBindings,
  listMappings,
  loadFrozenBinding,
  previewCapability,
  removeCapability,
  upsertMapping,
} from "../src/capabilities";
import { createConnection, deleteConnection, putConnectionSecrets } from "../src/connections";
import {
  AD_INTEGRATION_ID,
  GOOGLEWORKSPACE_INTEGRATION_ID,
  GRAPH_INTEGRATION_ID,
  NINJA_INTEGRATION_ID,
} from "../src/domain";
import { identityAdapterFor } from "../src/adapters/identity";
import { useWorkflowHarness } from "./helpers/workflow-harness";
const bindings = env as unknown as Bindings;
const ORG_A = "a1a1a1a1-1111-4111-8111-111111111111";
const USER_A = "a2a2a2a2-1111-4111-8111-111111111111";
const ORG_B = "b1b1b1b1-2222-4222-8222-222222222222";
const USER_B = "b2b2b2b2-2222-4222-8222-222222222222";
const ORG_EMPTY = "d1d1d1d1-4444-4444-8444-444444444444";
const USER_EMPTY = "d2d2d2d2-4444-4444-8444-444444444444";
const TOKEN = "a".repeat(64);
const SECRET_SENTINEL = "capability-test-secret-sentinel";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
function call(path: string, method = "GET", body?: unknown) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { ...auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function seedOrg(orgId: string, name: string): Promise<void> {
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, name)
    .run();
}
async function seedConnection(orgId: string, integrationId: string, endpoint: string): Promise<string> {
  const id = crypto.randomUUID();
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(id, orgId, integrationId, endpoint)
    .run();
  return id;
}
useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await seedOrg(ORG_A, "Entra org");
    await seedOrg(ORG_B, "AD org");
    await seedOrg(ORG_EMPTY, "Empty org");
  },
});
describe("capability assignments", () => {
  it("binds, lists, rebinds, disables, and removes one capability", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    const bound = await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID);
    expect(bound).toMatchObject({
      capability: "identity.primary",
      integrationId: GRAPH_INTEGRATION_ID,
      integrationName: "graph",
      enabled: true,
    });
    expect((await listCapabilities(bindings.DB, caller)).map((entry) => entry.capability)).toEqual([
      "identity.primary",
    ]);
    // Rebinding moves the pointer: one row per (org, capability).
    await seedConnection(ORG_A, GOOGLEWORKSPACE_INTEGRATION_ID, "https://google-in-test.invalid");
    const moved = await assignCapability(
      bindings.DB,
      caller,
      "identity.primary",
      GOOGLEWORKSPACE_INTEGRATION_ID,
      false,
    );
    expect(moved).toMatchObject({ integrationId: GOOGLEWORKSPACE_INTEGRATION_ID, enabled: false });
    expect(await listCapabilities(bindings.DB, caller)).toHaveLength(1);
    await removeCapability(bindings.DB, caller, "identity.primary");
    expect(await listCapabilities(bindings.DB, caller)).toEqual([]);
  });
  it("rejects malformed names, unknown Integrations, and missing Connections", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    for (const bad of ["", "identity", "identity primary", "a".repeat(129), 42, null]) {
      await expect(assignCapability(bindings.DB, caller, bad as string, GRAPH_INTEGRATION_ID)).rejects.toMatchObject({
        code: "INVALID_CAPABILITY",
      });
    }
    await expect(
      assignCapability(bindings.DB, caller, "identity.primary", "00000000-0000-4000-8000-000000000099"),
    ).rejects.toMatchObject({ code: "UNKNOWN_INTEGRATION" });
    // No Google Connection in ORG_A yet: binding fails closed, never cross-org.
    await expect(
      assignCapability(bindings.DB, caller, "mail.primary", GOOGLEWORKSPACE_INTEGRATION_ID),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    await expect(removeCapability(bindings.DB, caller, "identity.primary")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_BOUND",
    });
  });
  it("isolates assignments across Organizations", async () => {
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await assignCapability(bindings.DB, { orgId: ORG_A, userId: USER_A }, "identity.primary", GRAPH_INTEGRATION_ID);
    expect(await listCapabilities(bindings.DB, { orgId: ORG_B, userId: USER_B })).toEqual([]);
    await expect(
      removeCapability(bindings.DB, { orgId: ORG_B, userId: USER_B }, "identity.primary"),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_BOUND" });
    // A foreign Connection never satisfies a local bind.
    await seedConnection(ORG_B, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await expect(
      assignCapability(bindings.DB, { orgId: ORG_EMPTY, userId: USER_EMPTY }, "identity.primary", GRAPH_INTEGRATION_ID),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
  });
});
describe("capability preview (lazy resolution read half)", () => {
  it("resolves the bound Connection with mapping context", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID);
    await upsertMapping(bindings.DB, caller, GRAPH_INTEGRATION_ID, {
      entityId: "entra-tenant-a",
      displayName: "Entra tenant A",
      primary: true,
    });
    const resolved = await previewCapability(bindings.DB, ORG_A, "identity.primary", ["identity.primary"]);
    expect(resolved.found).toBe(true);
    if (!resolved.found) throw new Error("unreachable");
    expect(resolved.preview.connection.integrationId).toBe(GRAPH_INTEGRATION_ID);
    expect(resolved.preview.integrationRevision).toBe("graph");
    expect(resolved.preview.mappingId).not.toBeNull();
    expect(resolved.preview.mappingVersion).not.toBeNull();
  });
  it("fails declared-but-missing loud and resolves undeclared to None", async () => {
    const missing = await previewCapability(bindings.DB, ORG_EMPTY, "identity.primary", ["identity.primary"]);
    expect(missing.found).toBe(false);
    if (missing.found || !missing.declared) throw new Error("unreachable");
    expect(missing.error.code).toBe("INTEGRATION_REQUIREMENT_UNSATISFIED");
    const optional = await previewCapability(bindings.DB, ORG_EMPTY, "mail.primary", []);
    expect(optional).toEqual({ found: false, declared: false });
  });
  it("treats disabled bindings and disabled Connections as missing", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    const connectionId = await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID, false);
    const disabledBinding = await previewCapability(bindings.DB, ORG_A, "identity.primary", ["identity.primary"]);
    expect(disabledBinding.found).toBe(false);
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID, true);
    await bindings.DB.prepare("UPDATE connections SET enabled=0 WHERE id=?").bind(connectionId).run();
    const disabledConnection = await previewCapability(bindings.DB, ORG_A, "identity.primary", ["identity.primary"]);
    expect(disabledConnection.found).toBe(false);
    if (disabledConnection.found || !disabledConnection.declared) throw new Error("unreachable");
    expect(disabledConnection.error.code).toBe("INTEGRATION_REQUIREMENT_UNSATISFIED");
  });
  it("never resolves across Organizations", async () => {
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await assignCapability(bindings.DB, { orgId: ORG_A, userId: USER_A }, "identity.primary", GRAPH_INTEGRATION_ID);
    const foreign = await previewCapability(bindings.DB, ORG_B, "identity.primary", ["identity.primary"]);
    expect(foreign.found).toBe(false);
  });
});
describe("frozen Execution bindings", () => {
  it("freezes first-use identity and converges races on the first writer", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind("exec-freeze-1", "saga", "saga", "r1", ORG_A, USER_A, "{}", new Date().toISOString())
      .run();
    const preview = await previewCapability(bindings.DB, ORG_A, "identity.primary", ["identity.primary"]);
    if (!preview.found) throw new Error("unreachable");
    const adapter = identityAdapterFor(preview.preview.connection.integrationId);
    const first = await freezeBinding(
      bindings.DB,
      "exec-freeze-1",
      preview.preview,
      { id: adapter.id, revision: adapter.revision, transport: adapter.transport },
      "identity-provision-v1",
    );
    expect(first).toMatchObject({
      capability: "identity.primary",
      adapterId: "graph-identity-v1",
      transport: "direct-https",
      operation: "identity-provision-v1",
    });
    // A second first-use (rebound assignment) converges on the frozen row.
    await seedConnection(ORG_A, GOOGLEWORKSPACE_INTEGRATION_ID, "https://google-in-test.invalid");
    await assignCapability(bindings.DB, caller, "identity.primary", GOOGLEWORKSPACE_INTEGRATION_ID);
    const again = await previewCapability(bindings.DB, ORG_A, "identity.primary", ["identity.primary"]);
    if (!again.found) throw new Error("unreachable");
    const second = await freezeBinding(
      bindings.DB,
      "exec-freeze-1",
      again.preview,
      { id: "googleworkspace-identity-v1", revision: "googleworkspace-identity-v1", transport: "direct-https" },
      "identity-provision-v1",
    );
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.adapterId).toBe("graph-identity-v1");
    expect(await loadFrozenBinding(bindings.DB, "exec-freeze-1", "identity.primary")).toMatchObject({
      connectionId: first.connectionId,
    });
    expect(await loadFrozenBinding(bindings.DB, "exec-freeze-1", "mail.primary")).toBeNull();
    expect(await listExecutionBindings(bindings.DB, "exec-freeze-1")).toHaveLength(1);
  });
  it("degrades to empty on stores without the resolution table", async () => {
    await bindings.DB.exec("DROP TABLE IF EXISTS capability_resolutions");
    expect(await loadFrozenBinding(bindings.DB, "exec-missing", "identity.primary")).toBeNull();
    expect(await listExecutionBindings(bindings.DB, "exec-missing")).toEqual([]);
  });
});
describe("external entity mappings", () => {
  it("upserts, lists, and deletes mappings with one primary per Connection", async () => {
    const caller = { orgId: ORG_B, userId: USER_B };
    await seedConnection(ORG_B, AD_INTEGRATION_ID, "https://ad-in-test.invalid/directory");
    const first = await upsertMapping(bindings.DB, caller, AD_INTEGRATION_ID, {
      entityId: "ad-domain-b",
      displayName: "AD domain B",
      primary: true,
      source: "sync",
    });
    expect(first).toMatchObject({ entityId: "ad-domain-b", primary: true, source: "sync" });
    // One-to-many vendor entities stay as non-primary siblings.
    await upsertMapping(bindings.DB, caller, AD_INTEGRATION_ID, { entityId: "ad-site-b2" });
    // Promoting a sibling demotes the previous primary.
    const promoted = await upsertMapping(bindings.DB, caller, AD_INTEGRATION_ID, {
      entityId: "ad-site-b2",
      primary: true,
    });
    expect(promoted.primary).toBe(true);
    // Repeat upserts converge on one row per vendor entity (the unique
    // identity index enforces what the write path assumes).
    await upsertMapping(bindings.DB, caller, AD_INTEGRATION_ID, { entityId: "ad-site-b2", primary: true });
    const counted = await bindings.DB.prepare(
      "SELECT COUNT(*) AS n FROM external_entity_mappings WHERE org_id=? AND entity_id=?",
    )
      .bind(ORG_B, "ad-site-b2")
      .first<{ n: number }>();
    expect(counted?.n).toBe(1);
    const listed = await listMappings(bindings.DB, caller, AD_INTEGRATION_ID);
    expect(listed.filter((entry) => entry.primary)).toHaveLength(1);
    expect(listed.find((entry) => entry.entityId === "ad-site-b2")?.primary).toBe(true);
    await deleteMapping(bindings.DB, caller, first.id);
    expect((await listMappings(bindings.DB, caller, AD_INTEGRATION_ID)).map((entry) => entry.entityId)).toEqual([
      "ad-site-b2",
    ]);
  });
  it("rejects malformed mapping writes and foreign deletes", async () => {
    const caller = { orgId: ORG_B, userId: USER_B };
    await expect(
      upsertMapping(bindings.DB, caller, "00000000-0000-4000-8000-000000000099", { entityId: "x" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_INTEGRATION" });
    await expect(upsertMapping(bindings.DB, caller, AD_INTEGRATION_ID, { entityId: "x" })).rejects.toMatchObject({
      code: "CONNECTION_NOT_FOUND",
    });
    await seedConnection(ORG_B, AD_INTEGRATION_ID, "https://ad-in-test.invalid/directory");
    for (const bad of [
      {},
      { entityId: "" },
      { entityId: "x", displayName: "" },
      { entityId: "x", primary: "yes" },
      { entityId: "x", source: "import" },
    ]) {
      await expect(upsertMapping(bindings.DB, caller, AD_INTEGRATION_ID, bad)).rejects.toMatchObject({
        code: "INVALID_MAPPING",
      });
    }
    await expect(deleteMapping(bindings.DB, caller, crypto.randomUUID())).rejects.toMatchObject({
      code: "MAPPING_NOT_FOUND",
    });
    const mapped = await upsertMapping(bindings.DB, caller, AD_INTEGRATION_ID, { entityId: "ad-domain-b" });
    await expect(deleteMapping(bindings.DB, { orgId: ORG_A, userId: USER_A }, mapped.id)).rejects.toMatchObject({
      code: "MAPPING_NOT_FOUND",
    });
    expect(await listMappings(bindings.DB, { orgId: ORG_A, userId: USER_A }, AD_INTEGRATION_ID)).toEqual([]);
  });
});
describe("readiness reporting", () => {
  it("reports bound roles and names every blocker without secret values", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID);
    // No primary mapping yet: bound=false with the mapping blocker.
    let report = await checkReadiness(bindings.DB, caller);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ capability: "identity.primary", bound: false });
    expect(report[0]?.blockers).toContain("mapping-missing");
    await upsertMapping(bindings.DB, caller, GRAPH_INTEGRATION_ID, { entityId: "entra-tenant-a", primary: true });
    report = await checkReadiness(bindings.DB, caller);
    expect(report[0]).toMatchObject({ bound: true, mappingPresent: true, blockers: [] });
    // Disabling the role binding (not the Connection) blocks with its own code.
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID, false);
    report = await checkReadiness(bindings.DB, caller);
    expect(report[0]).toMatchObject({ bound: false, enabled: false });
    expect(report[0]?.blockers).toContain("binding-disabled");
    // Provisioned per-Organization secrets never leak into readiness output.
    // The report is recomputed AFTER the secret-bearing state exists, so the
    // assertion inspects output produced from that state — not a stale copy.
    await seedConnection(ORG_A, NINJA_INTEGRATION_ID, "https://ninja-in-test.invalid/api");
    await assignCapability(bindings.DB, caller, "mail.primary", NINJA_INTEGRATION_ID);
    await putConnectionSecrets(
      bindings.DB,
      caller,
      NINJA_INTEGRATION_ID,
      { clientSecret: SECRET_SENTINEL },
      "test-secrets-kek-sentinel-fixture-only",
    );
    report = await checkReadiness(bindings.DB, caller);
    expect(report.find((entry) => entry.capability === "mail.primary")).toMatchObject({ bound: false });
    const dumped = JSON.stringify([
      report,
      await listCapabilities(bindings.DB, caller),
      await listMappings(bindings.DB, caller, GRAPH_INTEGRATION_ID),
    ]);
    expect(dumped).not.toContain(SECRET_SENTINEL);
  });
  it("names disabled Connections distinctly from disabled bindings", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    const connectionId = await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID);
    await upsertMapping(bindings.DB, caller, GRAPH_INTEGRATION_ID, { entityId: "entra-tenant-a", primary: true });
    await bindings.DB.prepare("UPDATE connections SET enabled=0 WHERE id=?").bind(connectionId).run();
    const report = await checkReadiness(bindings.DB, caller);
    expect(report[0]).toMatchObject({ bound: false, enabled: true });
    expect(report[0]?.blockers).toContain("connection-disabled");
  });
  it("names mismatched and unknown-Integration bindings", async () => {
    const now = new Date().toISOString();
    // An assignment pointing at another org's Connection (reachable only
    // behind the module, which always binds org-local rows) reads as
    // missing: the org predicate stays authoritative.
    const foreignConn = await seedConnection(ORG_B, GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
    await bindings.DB.prepare(
      "INSERT INTO capability_assignments(org_id,capability,connection_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(ORG_A, "identity.primary", foreignConn, 1, now, now)
      .run();
    // A Connection row for an Integration the registry no longer knows
    // (stale row) names its own blocker instead of resolving.
    const staleConn = await seedConnection(ORG_A, "00000000-0000-4000-8000-000000000099", "https://stale.invalid");
    await bindings.DB.prepare(
      "INSERT INTO capability_assignments(org_id,capability,connection_id,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(ORG_A, "mail.primary", staleConn, 1, now, now)
      .run();
    const report = await checkReadiness(bindings.DB, { orgId: ORG_A, userId: USER_A });
    expect(report.find((entry) => entry.capability === "identity.primary")).toMatchObject({
      bound: false,
      connectionId: null,
    });
    expect(report.find((entry) => entry.capability === "identity.primary")?.blockers).toContain("connection-missing");
    expect(report.find((entry) => entry.capability === "mail.primary")).toMatchObject({ bound: false });
    expect(report.find((entry) => entry.capability === "mail.primary")?.blockers).toContain("integration-unknown");
    // Both fail loud as declared requirements, never as silent skips.
    for (const capability of ["identity.primary", "mail.primary"]) {
      const preview = await previewCapability(bindings.DB, ORG_A, capability, [capability]);
      expect(preview.found).toBe(false);
      if (preview.found || !preview.declared) throw new Error("unreachable");
      expect(preview.error.code).toBe("INTEGRATION_REQUIREMENT_UNSATISFIED");
    }
  });
});
describe("connection lifecycle with capabilities", () => {
  it("deletes assignments and mappings with the Connection but keeps frozen audit", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    await createConnection(bindings.DB, caller, GRAPH_INTEGRATION_ID, {
      config: { endpoint: "https://graph-in-test.invalid" },
    });
    await assignCapability(bindings.DB, caller, "identity.primary", GRAPH_INTEGRATION_ID);
    await upsertMapping(bindings.DB, caller, GRAPH_INTEGRATION_ID, { entityId: "entra-tenant-a", primary: true });
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind("exec-audit-1", "saga", "saga", "r1", ORG_A, USER_A, "{}", new Date().toISOString())
      .run();
    const preview = await previewCapability(bindings.DB, ORG_A, "identity.primary", ["identity.primary"]);
    if (!preview.found) throw new Error("unreachable");
    await freezeBinding(
      bindings.DB,
      "exec-audit-1",
      preview.preview,
      { id: "graph-identity-v1", revision: "graph-identity-v1", transport: "direct-https" },
      "identity-provision-v1",
    );
    await deleteConnection(bindings.DB, caller, GRAPH_INTEGRATION_ID);
    expect(await listCapabilities(bindings.DB, caller)).toEqual([]);
    expect(await listMappings(bindings.DB, caller, GRAPH_INTEGRATION_ID)).toEqual([]);
    expect(await listExecutionBindings(bindings.DB, "exec-audit-1")).toHaveLength(1);
  });
});
describe("capability operator routes", () => {
  beforeEach(async () => {
    // Fixture org owns a Graph Connection; member + stranger callers below
    // exercise the admin gate and org isolation through HTTP.
    await seedConnection("00000000-0000-4000-8000-000000000001", GRAPH_INTEGRATION_ID, "https://graph-in-test.invalid");
  });
  it("lists, binds, disables, and removes through HTTP as admin", async () => {
    const listed = await (await worker.fetch(call("/api/capabilities"), bindings)).json();
    expect(listed).toEqual({ capabilities: [] });
    const bound = await worker.fetch(
      call("/api/capabilities/identity.primary", "PUT", { integrationId: GRAPH_INTEGRATION_ID }),
      bindings,
    );
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({
      capability: { capability: "identity.primary", integrationName: "graph", enabled: true },
    });
    const readiness = await (
      await worker.fetch(call("/api/capabilities/readiness"), bindings)
    ).json<{ capabilities: { capability: string; blockers: string[] }[] }>();
    expect(readiness.capabilities.map((entry) => entry.capability)).toEqual(["identity.primary"]);
    const disabled = await worker.fetch(
      call("/api/capabilities/identity.primary", "PUT", { integrationId: GRAPH_INTEGRATION_ID, enabled: false }),
      bindings,
    );
    expect(await disabled.json()).toMatchObject({ capability: { enabled: false } });
    const removed = await worker.fetch(call("/api/capabilities/identity.primary", "DELETE"), bindings);
    expect(removed.status).toBe(200);
    const relisted = await (await worker.fetch(call("/api/capabilities"), bindings)).json();
    expect(relisted).toEqual({ capabilities: [] });
  });
  it("rejects bad capability input and gates writes on admin", async () => {
    const noIntegration = await worker.fetch(call("/api/capabilities/identity.primary", "PUT", {}), bindings);
    expect(noIntegration.status).toBe(400);
    const badEnabled = await worker.fetch(
      call("/api/capabilities/identity.primary", "PUT", { integrationId: GRAPH_INTEGRATION_ID, enabled: "yes" }),
      bindings,
    );
    expect(badEnabled.status).toBe(400);
    const badName = await worker.fetch(
      call("/api/capabilities/not-a-capability", "PUT", { integrationId: GRAPH_INTEGRATION_ID }),
      bindings,
    );
    expect(badName.status).toBe(400);
    const missing = await worker.fetch(call("/api/capabilities/identity.primary", "DELETE"), bindings);
    expect(missing.status).toBe(404);
    // Ordinary members (role=member) cannot write bindings.
    const stamp = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind("09d9d9d9-9999-4999-8999-999999999999", stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        "00000000-0000-4000-8000-000000000001",
        "09d9d9d9-9999-4999-8999-999999999999",
        "member",
        "active",
        "ordinary",
        stamp,
        stamp,
      )
      .run();
    const member = { ...bindings, LAB_USER_ID: "09d9d9d9-9999-4999-8999-999999999999" };
    const refused = await worker.fetch(
      call("/api/capabilities/identity.primary", "PUT", { integrationId: GRAPH_INTEGRATION_ID }),
      member,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "CAPABILITY_FORBIDDEN" } });
    // Foreign orgs see an empty list through HTTP, never our rows.
    const foreign = { ...bindings, LAB_ORG_ID: ORG_B, LAB_USER_ID: USER_B };
    expect(await (await worker.fetch(call("/api/capabilities"), foreign)).json()).toEqual({ capabilities: [] });
  });
  it("manages entity mappings through HTTP", async () => {
    const created = await worker.fetch(
      call(`/api/connections/${GRAPH_INTEGRATION_ID}/mappings`, "PUT", {
        entityId: "entra-tenant-a",
        displayName: "Entra tenant A",
        primary: true,
      }),
      bindings,
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { mapping: { id: string; entityId: string; primary: boolean } };
    expect(createdBody).toMatchObject({ mapping: { entityId: "entra-tenant-a", primary: true } });
    const mappingId = createdBody.mapping.id;
    const listed = await (
      await worker.fetch(call(`/api/connections/${GRAPH_INTEGRATION_ID}/mappings`), bindings)
    ).json<{ mappings: { entityId: string }[] }>();
    expect(listed.mappings.map((entry) => entry.entityId)).toEqual(["entra-tenant-a"]);
    const deleted = await worker.fetch(
      call(`/api/connections/${GRAPH_INTEGRATION_ID}/mappings/${mappingId}`, "DELETE"),
      bindings,
    );
    expect(deleted.status).toBe(200);
    const relisted = await (
      await worker.fetch(call(`/api/connections/${GRAPH_INTEGRATION_ID}/mappings`), bindings)
    ).json<{ mappings: unknown[] }>();
    expect(relisted.mappings).toEqual([]);
    const unknown = await worker.fetch(
      call("/api/connections/00000000-0000-4000-8000-000000000099/mappings", "PUT", { entityId: "x" }),
      bindings,
    );
    expect(unknown.status).toBe(404);
  });
});
describe("pre-0038 tolerance", () => {
  it("degrades capability reads to empty without the tables", async () => {
    const caller = { orgId: ORG_A, userId: USER_A };
    await bindings.DB.exec("DROP TABLE IF EXISTS capability_assignments");
    await bindings.DB.exec("DROP TABLE IF EXISTS external_entity_mappings");
    await bindings.DB.exec("DROP TABLE IF EXISTS capability_resolutions");
    expect(await listCapabilities(bindings.DB, caller)).toEqual([]);
    expect(await checkReadiness(bindings.DB, caller)).toEqual([]);
    expect(await listMappings(bindings.DB, caller, GRAPH_INTEGRATION_ID)).toEqual([]);
    expect(await loadFrozenBinding(bindings.DB, "exec-missing", "identity.primary")).toBeNull();
    expect(await listExecutionBindings(bindings.DB, "exec-missing")).toEqual([]);
    // Resolution without assignment state still honors the declared split.
    const declared = await previewCapability(bindings.DB, ORG_A, "identity.primary", ["identity.primary"]);
    expect(declared.found).toBe(false);
  });
});
