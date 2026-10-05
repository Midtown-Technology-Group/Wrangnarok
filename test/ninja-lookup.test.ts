// SPDX-License-Identifier: AGPL-3.0
// Issue #115 (second pilot): ninjaone-org-lookup end to end on the real
// local runtime. Field-names-bind-to-Saga-inputs via bindFormInput, one live
// NinjaOne Integration call through the existing Connection resolution, and
// ExecutionHistory assertions. Only outbound vendor HTTP is mocked at the
// Integration boundary; D1/Workflow bindings are never replaced.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { bindFormInput, parseFormFields } from "../src/forms";
import { executionId, ninjaLookupSaga } from "../src/domain";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "ninja-lookup-pilot-001";
const SECRET_SENTINEL = "test-client-secret-sentinel";
const TOKEN_SENTINEL = "test-access-token-sentinel";

// Form declaration for the pilot Saga: field names bind to Saga inputs.
const fields = parseFormFields([{ name: "query", type: "text", required: true, maxLength: 128 }]);
const formDef = {
  id: "b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6",
  orgId: principal.orgId,
  name: "org-lookup",
  sagaId: ninjaLookupSaga.id,
  allowPrefill: false,
  fields,
};

function request(path: string, method = "GET", body: unknown = {}) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json", "Idempotency-Key": key },
    ...(method === "POST" ? { body: JSON.stringify({ sagaId: ninjaLookupSaga.id, input: body }) } : {}),
  });
}
function mockNinja(token: unknown, orgs: unknown, tokenStatus = 200, orgsStatus = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return new Response(JSON.stringify(token), {
        status: tokenStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers as HeadersInit);
      expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN_SENTINEL}`);
      expect(init?.redirect).toBe("manual");
      return new Response(typeof orgs === "string" ? orgs : JSON.stringify(orgs), {
        status: orgsStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
}
const ORGS = [
  { id: 1, name: "Acme" },
  { id: 2, name: "Globex" },
  { id: 3, name: "Acme Labs" },
];
useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind(
        "00000000-0000-4000-8000-000000000103",
        principal.orgId,
        "0606e237-137b-4629-8346-85468e1c2df6",
        "https://ninja-in-test.invalid/api",
      )
      .run();
    mockNinja({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" }, ORGS);
  },
});

describe("ninjaone-org-lookup pilot (issue #115)", () => {
  it("binds form fields to the Saga input before the Saga gate", () => {
    expect(bindFormInput(formDef, { query: "acme" })).toMatchObject({ input: { query: "acme" } });
    try {
      bindFormInput(formDef, {});
      throw new Error("expected form validation to throw");
    } catch (error) {
      expect(error).toMatchObject({ status: 422, code: "FORM_VALIDATION_FAILED" });
    }
  });

  it("looks up organizations end to end with one vendor read and full history", async () => {
    const { input } = bindFormInput(formDef, { query: "acme" });
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_LOOKUP_WORKFLOW, id);
    const accepted = await worker.fetch(request("/api/executions", "POST", input), bindings);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
    await instance.waitForStatus("complete");
    const detail = await worker.fetch(request(`/api/executions/${id}`), bindings);
    expect(await detail.json()).toMatchObject({
      executionId: id,
      status: "Succeeded",
      result: {
        query: "acme",
        organizationCount: 3,
        matchCount: 2,
        matches: [
          { id: 1, name: "Acme" },
          { id: 3, name: "Acme Labs" },
        ],
      },
      operations: [
        { name: "prepare-input-v1", status: "Succeeded" },
        { name: "ninja-list-orgs-v1", status: "Succeeded" },
        { name: "ninja-match-orgs-v1", status: "Succeeded" },
      ],
    });
    // Exactly one Integration call: token acquisition plus the single list
    // read, no retry, no second hop.
    expect(fetch).toHaveBeenCalledTimes(2);
    // Secrets and tokens never persist: audit every D1 row for both
    // sentinels, including the persisted usage block.
    const tables = await bindings.DB.batch([
      bindings.DB.prepare("SELECT input_json,result_json,error_json FROM executions"),
      bindings.DB.prepare("SELECT result_json,error_json FROM operations"),
      bindings.DB.prepare("SELECT endpoint FROM connections"),
      bindings.DB.prepare("SELECT usage_json FROM usage_blocks"),
    ]);
    const dumped = JSON.stringify(tables.map((result) => result.results));
    expect(dumped).not.toContain(SECRET_SENTINEL);
    expect(dumped).not.toContain(TOKEN_SENTINEL);
    expect(dumped).toContain("ninja-in-test.invalid");
  });

  it("succeeds with an empty match and rejects bad input", async () => {
    const { input } = bindFormInput(formDef, { query: "zzz-no-such-org" });
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_LOOKUP_WORKFLOW, id);
    expect((await worker.fetch(request("/api/executions", "POST", input), bindings)).status).toBe(202);
    await instance.waitForStatus("complete");
    const detail = await worker.fetch(request(`/api/executions/${id}`), bindings);
    expect(await detail.json()).toMatchObject({
      status: "Succeeded",
      result: { query: "zzz-no-such-org", organizationCount: 3, matchCount: 0, matches: [] },
    });
    expect((await worker.fetch(request("/api/executions", "POST", {}), bindings)).status).toBe(400);
    expect((await worker.fetch(request("/api/executions", "POST", { query: "" }), bindings)).status).toBe(400);
    expect((await worker.fetch(request("/api/executions", "POST", { query: "x".repeat(129) }), bindings)).status).toBe(
      400,
    );
  });
});
