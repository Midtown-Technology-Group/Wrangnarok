// SPDX-License-Identifier: AGPL-3.0
// Employee Onboarding proof (issue #262, ADR TBD §7): one Saga source
// executes green in three seeded Organizations — Entra, AD-via-Ninja,
// Google Workspace — over mocked vendor HTTP only (local workerd + D1).
// Each Execution's history carries the frozen capability → Connection →
// Integration revision chain, and the shared path carries zero
// provider-selection branches (pinned by the source scan below).
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { identityAdapterFor } from "../src/adapters/identity";
import {
  AD_INTEGRATION_ID,
  GOOGLEWORKSPACE_INTEGRATION_ID,
  GRAPH_INTEGRATION_ID,
  NINJA_INTEGRATION_ID,
  executionId,
  onboardingSaga,
} from "../src/domain";
import { onboardingSagaDef } from "../src/sagas/onboarding";
import { assignCapability } from "../src/capabilities";
import { upsertMapping } from "../src/capabilities";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
const bindings = env as unknown as Bindings;
const ORG_A = "a1a1a1a1-1111-4111-8111-111111111111";
const USER_A = "a2a2a2a2-1111-4111-8111-111111111111";
const ORG_B = "b1b1b1b1-2222-4222-8222-222222222222";
const USER_B = "b2b2b2b2-2222-4222-8222-222222222222";
const ORG_C = "c1c1c1c1-3333-4333-8333-333333333333";
const USER_C = "c2c2c2c2-3333-4333-8333-333333333333";
const ORG_Q = "d1d1d1d1-4444-4444-8444-444444444444";
const USER_Q = "d2d2d2d2-4444-4444-8444-444444444444";
const TOKEN = "a".repeat(64);
const NINJA_TOKEN_SENTINEL = "onboarding-proof-access-token";
const NINJA_SECRET_SENTINEL = "test-client-secret-sentinel";
const GRAPH_ENDPOINT = "https://graph-in-test.invalid";
const GOOGLE_ENDPOINT = "https://google-in-test.invalid";
const AD_ENDPOINT = "https://ad-in-test.invalid/directory";
const NINJA_ENDPOINT = "https://ninja-in-test.invalid/api";
const INPUT = {
  employee: { givenName: "Ada", familyName: "Lovelace", userPrincipalName: "ada@example.com" },
  groups: ["engineering", "all-staff"],
};
function orgEnv(orgId: string, userId: string): Bindings {
  return { ...bindings, LAB_ORG_ID: orgId, LAB_USER_ID: userId };
}
function submit(key: string, input: unknown = INPUT) {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ sagaId: onboardingSaga.id, input }),
  });
}
function detail(id: string) {
  return new Request(`https://local.test/api/executions/${id}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}
async function seedOrg(orgId: string, name: string): Promise<void> {
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, name)
    .run();
}
async function seedConnection(orgId: string, integrationId: string, endpoint: string): Promise<void> {
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), orgId, integrationId, endpoint)
    .run();
}
/** Bind all three proving capabilities to one Integration for an org, with
 * a primary vendor-entity mapping (one Connection satisfying multiple
 * capabilities — ADR TBD §1). */
async function bindOrg(orgId: string, userId: string, integrationId: string, entityId: string): Promise<void> {
  const caller = { orgId, userId };
  for (const capability of ["identity.primary", "groups.primary", "mail.primary"]) {
    await assignCapability(bindings.DB, caller, capability, integrationId);
  }
  await upsertMapping(bindings.DB, caller, integrationId, { entityId, primary: true });
}
/** When set, vendor paths containing the marker answer 500: drives the
 * Saga's persist-before-throw branches without touching the shared path. */
let vendorFailure: string | null = null;
/** When set, the license escape-hatch vendor answers `assigned: false`. */
let licenseDeclined = false;
function mockVendors() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (vendorFailure !== null && url.includes(vendorFailure)) {
      // A vendor Fault (not a raw transport break): the Saga persists the
      // Fault code before throwing, per step.
      return new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    // Vendor JSON bodies parse; the OAuth token form does not — read it raw.
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string" && url.endsWith("/v2/ad/execute")) {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } else if (input instanceof Request) {
      try {
        body = (await input.clone().json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    } else if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    if (method !== "POST") throw new Error(`Unexpected outbound request: ${method} ${url}`);
    if (url === `${GRAPH_ENDPOINT}/v1.0/users`) {
      return Response.json({ id: "entra-user-1", userPrincipalName: body.userPrincipalName });
    }
    if (url === `${GRAPH_ENDPOINT}/v1.0/groups:assign`) {
      return Response.json({ assigned: body.groups });
    }
    if (url === `${GRAPH_ENDPOINT}/v1.0/mailbox:provision`) {
      return Response.json({ mailbox: `${body.userId}@example.com` });
    }
    if (url === `${GRAPH_ENDPOINT}/v1.0/licenses:assign`) {
      return Response.json({ assigned: !licenseDeclined });
    }
    if (url === `${GOOGLE_ENDPOINT}/admin/directory/v1/users`) {
      return Response.json({ id: "google-user-1", userPrincipalName: body.userPrincipalName });
    }
    if (url === `${GOOGLE_ENDPOINT}/admin/directory/v1/groups:assign`) {
      return Response.json({ assigned: body.groups });
    }
    if (url === `${GOOGLE_ENDPOINT}/admin/directory/v1/mailbox:provision`) {
      return Response.json({ mailbox: `${body.userId}@example.com` });
    }
    // The token host is derived from the Connection endpoint origin (the
    // /api suffix does not ride along — same discrimination as the live
    // NinjaOne proof).
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return Response.json({ access_token: NINJA_TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === `${NINJA_ENDPOINT}/v2/ad/execute`) {
      const params = body.params as Record<string, unknown>;
      if (body.op === "createUser") {
        return Response.json({ id: "ad-user-1", userPrincipalName: params.userPrincipalName });
      }
      if (body.op === "assignGroups") {
        return Response.json({ assigned: params.groups });
      }
      if (body.op === "provisionMailbox") {
        return Response.json({ mailbox: `${params.userId}@example.com` });
      }
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
}
useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await seedOrg(ORG_A, "Entra org");
    await seedOrg(ORG_B, "AD org");
    await seedOrg(ORG_C, "Google org");
    await seedOrg(ORG_Q, "Unbound org");
    vendorFailure = null;
    licenseDeclined = false;
    mockVendors();
  },
});
interface ProofDetail {
  status: string;
  error: { code: string; message: string } | null;
  result: {
    userId: string;
    userPrincipalName: string;
    groupsAssigned: string[];
    mailboxProvisioned: boolean;
    escapeHatch: { attempted: boolean; applied: boolean };
  };
  operations: { name: string; status: string }[];
  capabilityBindings: {
    capability: string;
    connectionId: string;
    integrationId: string;
    adapterId: string;
    transport: string;
    mappingId: string | null;
  }[];
}
async function runOnboarding(
  orgId: string,
  userId: string,
  key: string,
  terminal: "complete" | "errored" = "complete",
): Promise<{ id: string; detail: ProofDetail }> {
  const id = await executionId({ orgId, userId }, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.ONBOARDING_WORKFLOW, id);
  const accepted = await worker.fetch(submit(key), orgEnv(orgId, userId));
  expect(accepted.status).toBe(202);
  await instance.waitForStatus(terminal);
  const response = await worker.fetch(detail(id), orgEnv(orgId, userId));
  expect(response.status).toBe(200);
  return { id, detail: (await response.json()) as ProofDetail };
}
describe("onboarding proof across three identity stacks", () => {
  it("onboards through Entra with the licensing escape hatch applied", async () => {
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, GRAPH_ENDPOINT);
    await bindOrg(ORG_A, USER_A, GRAPH_INTEGRATION_ID, "entra-tenant-a");
    const { detail } = await runOnboarding(ORG_A, USER_A, "onboarding-proof-a-001");
    expect(detail.status).toBe("Succeeded");
    expect(detail.result).toMatchObject({
      userId: "entra-user-1",
      userPrincipalName: "ada@example.com",
      groupsAssigned: ["engineering", "all-staff"],
      mailboxProvisioned: true,
      escapeHatch: { attempted: true, applied: true },
    });
    expect(detail.operations.map((op) => op.name)).toEqual([
      "prepare-input-v1",
      "identity-provision-v1",
      "groups-assign-v1",
      "mailbox-provision-v1",
      "entra-license-v1",
    ]);
    expect(detail.capabilityBindings).toHaveLength(3);
    for (const binding of detail.capabilityBindings) {
      expect(binding).toMatchObject({
        integrationId: GRAPH_INTEGRATION_ID,
        adapterId: "graph-identity-v1",
        transport: "direct-https",
      });
      expect(binding.mappingId).not.toBeNull();
    }
    // One Connection satisfies all three capabilities — no duplication.
    const connectionIds = new Set(detail.capabilityBindings.map((binding) => binding.connectionId));
    expect(connectionIds.size).toBe(1);
  });
  it("onboards through AD via the NinjaOne Transport with the hatch skipped", async () => {
    await seedConnection(ORG_B, AD_INTEGRATION_ID, AD_ENDPOINT);
    await seedConnection(ORG_B, NINJA_INTEGRATION_ID, NINJA_ENDPOINT);
    await bindOrg(ORG_B, USER_B, AD_INTEGRATION_ID, "ad-domain-b");
    const { detail } = await runOnboarding(ORG_B, USER_B, "onboarding-proof-b-001");
    expect(detail.status).toBe("Succeeded");
    expect(detail.result).toMatchObject({
      userId: "ad-user-1",
      userPrincipalName: "ada@example.com",
      groupsAssigned: ["engineering", "all-staff"],
      mailboxProvisioned: true,
      escapeHatch: { attempted: false, applied: false },
    });
    expect(detail.capabilityBindings).toHaveLength(3);
    for (const binding of detail.capabilityBindings) {
      expect(binding).toMatchObject({
        integrationId: AD_INTEGRATION_ID,
        adapterId: "ad-identity-v1",
        transport: "ninjaone",
      });
    }
    // Transport credentials and tokens never persist anywhere auditable.
    const tables = await bindings.DB.batch([
      bindings.DB.prepare("SELECT input_json,result_json,error_json FROM executions"),
      bindings.DB.prepare("SELECT result_json,error_json FROM operations"),
      bindings.DB.prepare(
        "SELECT connection_id,integration_id,adapter_id,transport,mapping_id FROM capability_resolutions",
      ),
    ]);
    const dumped = JSON.stringify(tables.map((result) => result.results));
    expect(dumped).not.toContain(NINJA_TOKEN_SENTINEL);
    expect(dumped).not.toContain(NINJA_SECRET_SENTINEL);
  });
  it("onboards through Google Workspace with the hatch skipped", async () => {
    await seedConnection(ORG_C, GOOGLEWORKSPACE_INTEGRATION_ID, GOOGLE_ENDPOINT);
    await bindOrg(ORG_C, USER_C, GOOGLEWORKSPACE_INTEGRATION_ID, "google-customer-c");
    const { detail } = await runOnboarding(ORG_C, USER_C, "onboarding-proof-c-001");
    expect(detail.status).toBe("Succeeded");
    expect(detail.result).toMatchObject({
      userId: "google-user-1",
      userPrincipalName: "ada@example.com",
      groupsAssigned: ["engineering", "all-staff"],
      mailboxProvisioned: true,
      escapeHatch: { attempted: false, applied: false },
    });
    expect(detail.capabilityBindings).toHaveLength(3);
    for (const binding of detail.capabilityBindings) {
      expect(binding).toMatchObject({
        integrationId: GOOGLEWORKSPACE_INTEGRATION_ID,
        adapterId: "googleworkspace-identity-v1",
        transport: "direct-https",
      });
    }
  });
  it.each([
    ["/v1.0/users", "GRAPH_VENDOR_FAILED"],
    ["/v1.0/groups:assign", "GRAPH_VENDOR_FAILED"],
    ["/v1.0/mailbox:provision", "GRAPH_VENDOR_FAILED"],
    ["/v1.0/licenses:assign", "GRAPH_VENDOR_FAILED"],
  ])("persists before throwing when %s fails", async (marker, code) => {
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, GRAPH_ENDPOINT);
    await bindOrg(ORG_A, USER_A, GRAPH_INTEGRATION_ID, "entra-tenant-a");
    vendorFailure = marker;
    const { detail } = await runOnboarding(ORG_A, USER_A, `onboarding-proof-a-fail-${marker.length}`, "errored");
    expect(detail.status).toBe("Failed");
    expect(detail.error?.code).toBe(code);
  });
  it("reports the hatch declined when the vendor refuses the license", async () => {
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, GRAPH_ENDPOINT);
    await bindOrg(ORG_A, USER_A, GRAPH_INTEGRATION_ID, "entra-tenant-a");
    licenseDeclined = true;
    const { detail } = await runOnboarding(ORG_A, USER_A, "onboarding-proof-a-005");
    expect(detail.status).toBe("Succeeded");
    expect(detail.result.escapeHatch).toEqual({ attempted: true, applied: false });
  });
  it("fails loud with 424 when no capability is bound (no cross-org fallback)", async () => {
    // Only ORG_B binds anything: the unbound org must not see it.
    await seedConnection(ORG_B, AD_INTEGRATION_ID, AD_ENDPOINT);
    await seedConnection(ORG_B, NINJA_INTEGRATION_ID, NINJA_ENDPOINT);
    await bindOrg(ORG_B, USER_B, AD_INTEGRATION_ID, "ad-domain-b");
    const { detail } = await runOnboarding(ORG_Q, USER_Q, "onboarding-proof-q-001", "errored");
    expect(detail.status).toBe("Failed");
    expect(detail.error?.code).toBe("INTEGRATION_REQUIREMENT_UNSATISFIED");
    expect(detail.capabilityBindings).toEqual([]);
  });
  it("freezes per run: rebinding moves new Executions, never settled audit", async () => {
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, GRAPH_ENDPOINT);
    await bindOrg(ORG_A, USER_A, GRAPH_INTEGRATION_ID, "entra-tenant-a");
    const first = await runOnboarding(ORG_A, USER_A, "onboarding-proof-a-002");
    const firstConnection = first.detail.capabilityBindings.find(
      (binding) => binding.capability === "identity.primary",
    )?.connectionId;
    // Rebind identity to a second Graph Connection row for the same org is
    // impossible under the (org, Integration) unique row — instead the org
    // re-points at the Google stack, and only new runs follow.
    await seedConnection(ORG_A, GOOGLEWORKSPACE_INTEGRATION_ID, GOOGLE_ENDPOINT);
    await assignCapability(
      bindings.DB,
      { orgId: ORG_A, userId: USER_A },
      "identity.primary",
      GOOGLEWORKSPACE_INTEGRATION_ID,
    );
    await upsertMapping(bindings.DB, { orgId: ORG_A, userId: USER_A }, GOOGLEWORKSPACE_INTEGRATION_ID, {
      entityId: "google-customer-a",
      primary: true,
    });
    const second = await runOnboarding(ORG_A, USER_A, "onboarding-proof-a-003");
    expect(second.detail.status).toBe("Succeeded");
    expect(second.detail.result.userId).toBe("google-user-1");
    const rerun = await worker.fetch(detail(first.id), orgEnv(ORG_A, USER_A));
    const firstAgain = (await rerun.json()) as ProofDetail;
    expect(
      firstAgain.capabilityBindings.find((binding) => binding.capability === "identity.primary")?.connectionId,
    ).toBe(firstConnection);
  });
  it("fails loud when a not-yet-bound capability is disabled mid-flight", async () => {
    await seedConnection(ORG_A, GRAPH_INTEGRATION_ID, GRAPH_ENDPOINT);
    await bindOrg(ORG_A, USER_A, GRAPH_INTEGRATION_ID, "entra-tenant-a");
    await assignCapability(bindings.DB, { orgId: ORG_A, userId: USER_A }, "mail.primary", GRAPH_INTEGRATION_ID, false);
    const { detail } = await runOnboarding(ORG_A, USER_A, "onboarding-proof-a-004", "errored");
    expect(detail.status).toBe("Failed");
    expect(detail.error?.code).toBe("INTEGRATION_REQUIREMENT_UNSATISFIED");
    // Identity and groups froze before the missing mailbox binding failed.
    expect(detail.capabilityBindings.map((binding) => binding.capability).sort()).toEqual([
      "groups.primary",
      "identity.primary",
    ]);
  });
});
describe("onboarding source proof (ADR TBD §7.1)", () => {
  it("carries zero provider-selection branches outside the marked escape hatch", () => {
    const source = Function.prototype.toString.call(onboardingSagaDef.run);
    const blocks = source.split("escape-hatch-begin");
    expect(blocks).toHaveLength(2);
    const [beforeHatch, hatchAndAfter] = blocks as [string, string];
    const endBlocks = (hatchAndAfter as string).split("escape-hatch-end");
    expect(endBlocks).toHaveLength(2);
    const [, afterHatch] = endBlocks as [string, string];
    // Provider-selection logic on EITHER side of the marked block fails the
    // proof — the shared path is everything outside the hatch.
    const shared = `${beforeHatch}\n${afterHatch}`;
    for (const token of ["graph", "entra", "google", "ninja", "microsoft", "gws"]) {
      expect(shared?.toLowerCase()).not.toContain(token);
    }
    // The shared path resolves capabilities and Adapters only: no direct
    // Integration handles, no per-provider modules chosen by org.
    expect(shared).toContain("capabilityOperation");
    expect(shared).not.toContain("if org");
    expect(shared).not.toContain("switch");
  });
  it("resolves identity Adapters per Integration and fails loud on unknown stacks", () => {
    expect(identityAdapterFor(GRAPH_INTEGRATION_ID)).toMatchObject({
      id: "graph-identity-v1",
      transport: "direct-https",
    });
    expect(identityAdapterFor(GOOGLEWORKSPACE_INTEGRATION_ID)).toMatchObject({
      id: "googleworkspace-identity-v1",
      transport: "direct-https",
    });
    expect(identityAdapterFor(AD_INTEGRATION_ID)).toMatchObject({
      id: "ad-identity-v1",
      transport: "ninjaone",
      transportIntegrationId: NINJA_INTEGRATION_ID,
    });
    try {
      identityAdapterFor("00000000-0000-4000-8000-000000000099");
      expect.unreachable("unknown stacks must fail loud");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("UNKNOWN_IDENTITY_ADAPTER");
    }
  });
});
