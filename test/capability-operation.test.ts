// SPDX-License-Identifier: AGPL-3.0
// Capability/optional step interiors (issue #262): frozen-reuse
// determinism, declared/undeclared semantics, Transport loading, and Fault
// mapping — driven directly against real D1 without Workflow dispatch. The
// prove-it-green paths ride the Onboarding Workflow suite; this file pins
// the branch-level contract.
import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it, vi } from "vitest";
// Import the worker entry first: src/sagas/definitions.ts assembles every
// saga module while every saga module imports the shared adapter, so the
// catalog is only complete when evaluation starts at the entry (importing a
// saga module first observes partial bindings). Every workflow suite
// follows this order via its worker import; this module-only suite states
// the dependency explicitly as a side-effect import.
import "../src/index";
import type { Bindings } from "../src/bindings";
import { identityAdapterFor } from "../src/adapters/identity";
import { assignCapability, previewCapability } from "../src/capabilities";
import {
  AD_INTEGRATION_ID,
  GRAPH_INTEGRATION_ID,
  IDENTITY_TIMEOUT_MS,
  NINJA_INTEGRATION_ID,
  onboardingSaga,
} from "../src/domain";
import type { SagaEventContext } from "../src/saga";
import { capabilityOperation, optionalIntegrationOperation } from "../src/saga-helpers";
import type { CapabilityCall } from "../src/saga-helpers";
import { onboardingSagaDef } from "../src/sagas/onboarding";
import { useWorkflowHarness } from "./helpers/workflow-harness";
const bindings = env as unknown as Bindings;
const ORG = "e1e1e1e1-5555-4555-8555-555555555555";
const USER = "e2e2e2e2-5555-4555-8555-555555555555";
const GRAPH = "https://graph-in-test.invalid";
const NINJA = "https://ninja-in-test.invalid/api";
const AD = "https://ad-in-test.invalid/directory";
const EXEC = "exec-capability-operation-1";
function ctxFor(executionId: string, secrets: Record<string, string | undefined> = {}): SagaEventContext {
  return { executionId, db: bindings.DB, secrets } as unknown as SagaEventContext;
}
function preparedFor(executionId: string) {
  return {
    orgCtx: {
      orgId: ORG,
      userId: USER,
      executionId,
      sagaId: onboardingSaga.id,
      sagaRevision: onboardingSaga.revision,
      attemptToken: `${executionId}:0`,
    },
  };
}
async function seedExecution(id: string): Promise<void> {
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      onboardingSaga.id,
      onboardingSaga.name,
      onboardingSaga.revision,
      ORG,
      USER,
      "{}",
      new Date().toISOString(),
    )
    .run();
}
async function seedConnection(integrationId: string, endpoint: string): Promise<void> {
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), ORG, integrationId, endpoint)
    .run();
}
function mockGraphUsers(status = 200, body: unknown = { id: "u-1", userPrincipalName: "u@example.com" }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${GRAPH}/v1.0/users`) {
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
}
useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind(ORG, "Helper org")
      .run();
  },
});
const SUBJECT = { givenName: "Ada", familyName: "Lovelace", userPrincipalName: "ada@example.com" };
function identityCall(binding: CapabilityCall) {
  return binding.adapter.createIdentity(
    { directory: binding.directory, loadTransport: binding.loadTransport },
    SUBJECT,
    "op-1",
    1000,
  );
}
describe("capabilityOperation", () => {
  it("reuses the frozen binding when assignments move mid-run", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", GRAPH_INTEGRATION_ID);
    await seedExecution(EXEC);
    mockGraphUsers();
    const first = await capabilityOperation(ctxFor(EXEC), onboardingSagaDef, preparedFor(EXEC), {
      op: "identity-provision-v1",
      position: 1,
      capability: "identity.primary",
      adapterFor: identityAdapterFor,
      vendorDefaultMs: IDENTITY_TIMEOUT_MS,
      failureCode: "ONBOARDING_IDENTITY_FAILED",
      failureMessage: "nope",
      call: (binding) => identityCall(binding),
    });
    expect(first.ok).toBe(true);
    // Re-point the capability at another stack behind the running Execution
    // (the old row stays, so the frozen run keeps serving it): the next
    // step in the SAME run still resolves the frozen Connection, while a
    // new run follows the new assignment.
    await seedConnection(AD_INTEGRATION_ID, AD);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", AD_INTEGRATION_ID);
    const second = await capabilityOperation(ctxFor(EXEC), onboardingSagaDef, preparedFor(EXEC), {
      op: "identity-provision-v1-retry",
      position: 2,
      capability: "identity.primary",
      adapterFor: identityAdapterFor,
      vendorDefaultMs: IDENTITY_TIMEOUT_MS,
      failureCode: "ONBOARDING_IDENTITY_FAILED",
      failureMessage: "nope",
      call: (binding) => identityCall(binding),
    });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.result.userId).toBe("u-1");
    const both = await bindings.DB.prepare(
      "SELECT connection_id,adapter_id FROM capability_resolutions WHERE execution_id=? AND capability=?",
    )
      .bind(EXEC, "identity.primary")
      .first<{ connection_id: string; adapter_id: string }>();
    expect(both?.adapter_id).toBe("graph-identity-v1");
    // New runs follow the moved assignment; the settled run does not.
    const moved = await previewCapability(bindings.DB, ORG, "identity.primary", ["identity.primary"]);
    expect(moved.found).toBe(true);
    if (!moved.found) throw new Error("unreachable");
    expect(moved.preview.connection.integrationId).toBe(AD_INTEGRATION_ID);
    expect(moved.preview.connection.id).not.toBe(both?.connection_id);
  });
  it("rejects undeclared capability access and fails declared-missing loud", async () => {
    await seedExecution("exec-undeclared-1");
    await expect(
      capabilityOperation(ctxFor("exec-undeclared-1"), onboardingSagaDef, preparedFor("exec-undeclared-1"), {
        op: "identity-provision-v1",
        position: 1,
        capability: "calendar.primary",
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async () => ({ userId: "u", userPrincipalName: "u" }),
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    const missing = await capabilityOperation(
      ctxFor("exec-undeclared-1"),
      onboardingSagaDef,
      preparedFor("exec-undeclared-1"),
      {
        op: "identity-provision-v1",
        position: 1,
        capability: "identity.primary",
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async () => ({ userId: "u", userPrincipalName: "u" }),
      },
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.error.code).toBe("INTEGRATION_REQUIREMENT_UNSATISFIED");
  });
  it("passes Faults through and maps raw transport errors", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", GRAPH_INTEGRATION_ID);
    await seedExecution("exec-faults-1");
    mockGraphUsers(401, {});
    const denied = await capabilityOperation(ctxFor("exec-faults-1"), onboardingSagaDef, preparedFor("exec-faults-1"), {
      op: "identity-provision-v1",
      position: 1,
      capability: "identity.primary",
      adapterFor: identityAdapterFor,
      vendorDefaultMs: IDENTITY_TIMEOUT_MS,
      failureCode: "MAPPED",
      failureMessage: "mapped",
      call: (binding) => identityCall(binding),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("GRAPH_UNAUTHORIZED");
    vi.restoreAllMocks();
    const mapped = await capabilityOperation(ctxFor("exec-faults-1"), onboardingSagaDef, preparedFor("exec-faults-1"), {
      op: "identity-provision-v1",
      position: 1,
      capability: "identity.primary",
      adapterFor: identityAdapterFor,
      vendorDefaultMs: IDENTITY_TIMEOUT_MS,
      failureCode: "MAPPED",
      failureMessage: "mapped",
      call: async () => {
        throw new Error("boom");
      },
    });
    // The second call reuses the frozen binding (same run) and maps the raw
    // transport failure onto the fixed-shape code.
    expect(mapped.ok).toBe(false);
    if (mapped.ok) throw new Error("unreachable");
    expect(mapped.error).toEqual({ code: "MAPPED", message: "mapped" });
  });
  it("fails closed on endpoint edits but tolerates disable toggles", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", GRAPH_INTEGRATION_ID);
    await seedExecution("exec-generation-1");
    mockGraphUsers();
    const base = { op: "identity-provision-v1", position: 1, capability: "identity.primary" } as const;
    const first = await capabilityOperation(
      ctxFor("exec-generation-1"),
      onboardingSagaDef,
      preparedFor("exec-generation-1"),
      {
        ...base,
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: (binding) => identityCall(binding),
      },
    );
    expect(first.ok).toBe(true);
    // Disabling the Connection is lifecycle, not config: the frozen run
    // keeps serving the recorded binding (ADR disabled rule).
    await bindings.DB.prepare("UPDATE connections SET enabled=0 WHERE org_id=?").bind(ORG).run();
    const disabled = await capabilityOperation(
      ctxFor("exec-generation-1"),
      onboardingSagaDef,
      preparedFor("exec-generation-1"),
      {
        ...base,
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: (binding) => identityCall(binding),
      },
    );
    expect(disabled.ok).toBe(true);
    // Editing the endpoint starts a new config generation: the frozen run
    // fails closed instead of executing against un-audited config.
    await bindings.DB.prepare("UPDATE connections SET endpoint=?,enabled=1 WHERE org_id=?")
      .bind("https://graph-moved.invalid", ORG)
      .run();
    const moved = await capabilityOperation(
      ctxFor("exec-generation-1"),
      onboardingSagaDef,
      preparedFor("exec-generation-1"),
      {
        ...base,
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: (binding) => identityCall(binding),
      },
    );
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("unreachable");
    expect(moved.error.code).toBe("CAPABILITY_BINDING_CHANGED");
  });
  it("fails closed when the frozen Connection row is gone", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", GRAPH_INTEGRATION_ID);
    await seedExecution("exec-changed-1");
    mockGraphUsers();
    const first = await capabilityOperation(
      ctxFor("exec-changed-1"),
      onboardingSagaDef,
      preparedFor("exec-changed-1"),
      {
        op: "identity-provision-v1",
        position: 1,
        capability: "identity.primary",
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: (binding) => identityCall(binding),
      },
    );
    expect(first.ok).toBe(true);
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(ORG).run();
    const second = await capabilityOperation(
      ctxFor("exec-changed-1"),
      onboardingSagaDef,
      preparedFor("exec-changed-1"),
      {
        op: "identity-provision-v1",
        position: 1,
        capability: "identity.primary",
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: (binding) => identityCall(binding),
      },
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.error.code).toBe("CAPABILITY_BINDING_CHANGED");
  });
  it("loads the Transport once per step and fails loud without it", async () => {
    await seedConnection(AD_INTEGRATION_ID, AD);
    await seedConnection(NINJA_INTEGRATION_ID, NINJA);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", AD_INTEGRATION_ID);
    await seedExecution("exec-transport-1");
    let tokenCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://ninja-in-test.invalid/oauth/token") {
        tokenCalls += 1;
        return Response.json({ access_token: "tok", expires_in: 3600, token_type: "Bearer" });
      }
      if (url === `${NINJA}/v2/ad/execute`) {
        return Response.json({ id: "ad-1", userPrincipalName: "a@b" });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const outcome = await capabilityOperation(
      ctxFor("exec-transport-1", { clientId: "test-client-id", clientSecret: "test-client-secret-sentinel" }),
      onboardingSagaDef,
      preparedFor("exec-transport-1"),
      {
        op: "identity-provision-v1",
        position: 1,
        capability: "identity.primary",
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async (binding) => {
          const first = await binding.loadTransport();
          const second = await binding.loadTransport();
          expect(second).toBe(first);
          return binding.adapter.createIdentity(
            { directory: binding.directory, loadTransport: binding.loadTransport },
            SUBJECT,
            "op-1",
            1000,
          );
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(tokenCalls).toBe(1);
    // Without the Transport Connection the AD Adapter fails loud, never silent.
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=? AND integration_id=?")
      .bind(ORG, NINJA_INTEGRATION_ID)
      .run();
    await seedExecution("exec-transport-2");
    const missing = await capabilityOperation(
      ctxFor("exec-transport-2"),
      onboardingSagaDef,
      preparedFor("exec-transport-2"),
      {
        op: "identity-provision-v1",
        position: 1,
        capability: "identity.primary",
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: (binding) => identityCall(binding),
      },
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.error.code).toBe("TRANSPORT_REQUIREMENT_UNSATISFIED");
  });
  it("rejects Transport loads on direct-HTTPS Adapters", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", GRAPH_INTEGRATION_ID);
    await seedExecution("exec-direct-transport-1");
    mockGraphUsers();
    const outcome = await capabilityOperation(
      ctxFor("exec-direct-transport-1"),
      onboardingSagaDef,
      preparedFor("exec-direct-transport-1"),
      {
        op: "identity-provision-v1",
        position: 1,
        capability: "identity.primary",
        adapterFor: identityAdapterFor,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async (binding) => {
          await binding.loadTransport();
          return { userId: "u", userPrincipalName: "u" };
        },
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("TRANSPORT_NOT_SUPPORTED");
  });
  it("reads mappings-tolerant previews without the mapping table", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await bindings.DB.exec("DROP TABLE IF EXISTS external_entity_mappings");
    const bound = await assignCapability(
      bindings.DB,
      { orgId: ORG, userId: USER },
      "identity.primary",
      GRAPH_INTEGRATION_ID,
    );
    expect(bound.mappingPresent).toBe(false);
    const preview = await previewCapability(bindings.DB, ORG, "identity.primary", ["identity.primary"]);
    expect(preview.found).toBe(true);
    if (!preview.found) throw new Error("unreachable");
    expect(preview.preview.mappingId).toBeNull();
  });
});
describe("optionalIntegrationOperation", () => {
  it("skips undeclared-missing, fails declared-missing, and runs hits", async () => {
    await seedExecution("exec-optional-1");
    const skipped = await optionalIntegrationOperation(
      ctxFor("exec-optional-1"),
      onboardingSagaDef,
      preparedFor("exec-optional-1"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async () => true,
      },
    );
    expect(skipped).toEqual({ skipped: true });
    const declared = await optionalIntegrationOperation(
      ctxFor("exec-optional-1"),
      { requiredIntegrations: [GRAPH_INTEGRATION_ID] },
      preparedFor("exec-optional-1"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async () => true,
      },
    );
    expect(declared).toMatchObject({ ok: false });
    if (!("ok" in declared) || declared.ok) throw new Error("unreachable");
    expect(declared.error.code).toBe("INTEGRATION_REQUIREMENT_UNSATISFIED");
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    mockGraphUsers();
    const hit = await optionalIntegrationOperation(
      ctxFor("exec-optional-1"),
      onboardingSagaDef,
      preparedFor("exec-optional-1"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async (connection) => connection.endpoint,
      },
    );
    expect(hit).toMatchObject({ ok: true, result: GRAPH });
  });
  it("gates the direct call on the frozen capability binding", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await assignCapability(bindings.DB, { orgId: ORG, userId: USER }, "identity.primary", GRAPH_INTEGRATION_ID);
    await seedExecution("exec-gate-1");
    mockGraphUsers();
    // Freeze identity.primary to Graph first.
    const frozen = await capabilityOperation(ctxFor("exec-gate-1"), onboardingSagaDef, preparedFor("exec-gate-1"), {
      op: "identity-provision-v1",
      position: 1,
      capability: "identity.primary",
      adapterFor: identityAdapterFor,
      vendorDefaultMs: IDENTITY_TIMEOUT_MS,
      failureCode: "X",
      failureMessage: "x",
      call: (binding) => identityCall(binding),
    });
    expect(frozen.ok).toBe(true);
    // A gate naming another stack skips without touching the vendor.
    const mismatched = await optionalIntegrationOperation(
      ctxFor("exec-gate-1"),
      onboardingSagaDef,
      preparedFor("exec-gate-1"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        onlyWhen: { capability: "identity.primary", integrationId: "00000000-0000-4000-8000-000000000099" },
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async () => true,
      },
    );
    expect(mismatched).toEqual({ skipped: true });
    // The matching gate proceeds to the vendor.
    const matched = await optionalIntegrationOperation(
      ctxFor("exec-gate-1"),
      onboardingSagaDef,
      preparedFor("exec-gate-1"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        onlyWhen: { capability: "identity.primary", integrationId: GRAPH_INTEGRATION_ID },
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async (connection) => connection.endpoint,
      },
    );
    expect(matched).toMatchObject({ ok: true, result: GRAPH });
    // No frozen binding at all also skips.
    await seedExecution("exec-gate-2");
    const unfrozen = await optionalIntegrationOperation(
      ctxFor("exec-gate-2"),
      onboardingSagaDef,
      preparedFor("exec-gate-2"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        onlyWhen: { capability: "identity.primary", integrationId: GRAPH_INTEGRATION_ID },
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "X",
        failureMessage: "x",
        call: async () => true,
      },
    );
    expect(unfrozen).toEqual({ skipped: true });
  });
  it("maps Faults and raw errors from the direct call", async () => {
    await seedConnection(GRAPH_INTEGRATION_ID, GRAPH);
    await seedExecution("exec-optional-2");
    mockGraphUsers(401, {});
    const denied = await optionalIntegrationOperation(
      ctxFor("exec-optional-2"),
      onboardingSagaDef,
      preparedFor("exec-optional-2"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "MAPPED",
        failureMessage: "mapped",
        call: (connection) =>
          identityAdapterFor(GRAPH_INTEGRATION_ID).createIdentity(
            {
              directory: { endpoint: connection.endpoint },
              loadTransport: async () => {
                throw new Error("unused");
              },
            },
            SUBJECT,
            "op",
            100,
          ),
      },
    );
    // The 401 passes through with its own code, not the fixed-shape mapping.
    expect(denied).toMatchObject({ ok: false });
    if (!("ok" in denied) || denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("GRAPH_UNAUTHORIZED");
    vi.restoreAllMocks();
    const mapped = await optionalIntegrationOperation(
      ctxFor("exec-optional-2"),
      onboardingSagaDef,
      preparedFor("exec-optional-2"),
      {
        op: "entra-license-v1",
        position: 4,
        integrationId: GRAPH_INTEGRATION_ID,
        vendorDefaultMs: IDENTITY_TIMEOUT_MS,
        failureCode: "MAPPED",
        failureMessage: "mapped",
        call: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(mapped).toMatchObject({ ok: false, error: { code: "MAPPED", message: "mapped" } });
  });
});
