// SPDX-License-Identifier: AGPL-3.0
// Zone Inventory migration (issues #116 MIG-01, #119 MIG-02): replay ALL 6
// vendored bundle scenarios as regression tests with mocked vendor fetch.
// Every test runs the real local runtime (workerd + D1 + Workflow
// bindings); only outbound Cloudflare HTTP is intercepted at the
// Integration boundary. Requests match in order against the declared
// exchanges; the terminal result or error compares exactly; every listed
// invariant is enforced. No live Cloudflare calls, ever: the only token in
// play is the CLOUDFLARE_API_TOKEN test sentinel.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_INTEGRATION_ID,
  cloudflareInventorySaga,
  cloudflareVerifySaga,
  executionId,
} from "../src/domain";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import invalidLimit from "./fixtures/zone-inventory/inventory-invalid-limit.json";
import missingMapping from "./fixtures/zone-inventory/inventory-missing-mapping.json";
import twoPages from "./fixtures/zone-inventory/inventory-two-pages.json";
import activeToken from "./fixtures/zone-inventory/verify-active-token.json";
import authFailure from "./fixtures/zone-inventory/verify-authorization-failure.json";
import malformedJson from "./fixtures/zone-inventory/verify-malformed-json.json";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN_SENTINEL = "test-cloudflare-token-sentinel";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT_NAME = "Example MSP";

interface ReplayExchange {
  request: { method: string; url: string; headers?: Record<string, string>; query?: Record<string, unknown> };
  response: { status: number; json?: unknown; body?: string };
}

function toSearchParams(query: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  return params;
}

/** Intercept outbound vendor fetch and replay the scenario's declared
 * exchanges in order. The `{{ secret.cloudflare_api_token }}` template
 * resolves to the runner-provided sentinel; anything else fails closed.
 * D1/Workflow bindings are never replaced. */
function mockVendor(exchanges: ReplayExchange[]) {
  let cursor = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const next = exchanges[cursor];
    if (!next) throw new Error(`Unexpected outbound request (no exchanges left): ${method} ${url}`);
    const expectedUrl = new URL(next.request.url);
    const actualUrl = new URL(url);
    expect(method).toBe(next.request.method.toUpperCase());
    expect(`${actualUrl.origin}${actualUrl.pathname}`).toBe(`${expectedUrl.origin}${expectedUrl.pathname}`);
    if (next.request.query !== undefined) {
      expect(toSearchParams(next.request.query).toString()).toBe(
        toSearchParams(Object.fromEntries(actualUrl.searchParams.entries())).toString(),
      );
    }
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers as HeadersInit);
    for (const [name, template] of Object.entries(next.request.headers ?? {})) {
      const expected = template.replace("{{ secret.cloudflare_api_token }}", TOKEN_SENTINEL);
      expect(headers.get(name)).toBe(expected);
    }
    // Bearer material must arrive as `Bearer <token>` exactly as the
    // scenarios declare — never a query param, never a bare token.
    const authorization = headers.get("Authorization");
    expect(authorization).toBe(`Bearer ${TOKEN_SENTINEL}`);
    expect(url).not.toContain(TOKEN_SENTINEL);
    cursor += 1;
    if (next.response.json !== undefined) {
      return new Response(JSON.stringify(next.response.json), {
        status: next.response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(next.response.body ?? "", {
      status: next.response.status,
      headers: { "Content-Type": "text/plain" },
    });
  });
}

function request(path: string, method = "GET", sagaId: string, body: unknown, idempotencyKey: string) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    ...(method === "POST" ? { body: JSON.stringify({ sagaId, input: body }) } : {}),
  });
}

/** Seed the Cloudflare Connection row (endpoint only — D1 holds no
 * secrets) for the fixture org. The account mapping rides the Execution
 * input binding per scenario; the token rides the test env binding. */
async function seedConnection() {
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind("00000000-0000-4000-8000-000000000201", principal.orgId, CLOUDFLARE_INTEGRATION_ID, CLOUDFLARE_API_BASE)
    .run();
}

function accountBinding(entityId: unknown, entityName: unknown): { account: { id: unknown; name: unknown } } {
  return { account: { id: entityId, name: entityName } };
}

useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await seedConnection();
  },
});

it("replays verify-active-token: one ordered GET, exact healthy result", async () => {
  const scenario = activeToken as unknown as {
    workflow: { input: Record<string, unknown> };
    binding: { entity_id: string; entity_name: string };
    http: ReplayExchange[];
  };
  expect(scenario.http).toHaveLength(1);
  const mock = mockVendor(scenario.http);
  const key = "cf-verify-active-0001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_VERIFY_WORKFLOW, id);
  const body = { ...scenario.workflow.input, ...accountBinding(scenario.binding.entity_id, scenario.binding.entity_name) };
  const accepted = await worker.fetch(request("/api/executions", "POST", cloudflareVerifySaga.id, body, key), bindings);
  expect(accepted.status).toBe(202);
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(request(`/api/executions/${id}`, "GET", cloudflareVerifySaga.id, {}, key), bindings);
  const payload = (await detail.json()) as {
    status: string;
    result: unknown;
    operations: Array<{ name: string; status: string }>;
  };
  expect(payload.status).toBe("Succeeded");
  // Exact terminal result per the scenario's expected block.
  expect(payload.result).toEqual({
    status: "healthy",
    readOnly: true,
    integration: "Cloudflare",
    account: { id: ACCOUNT_ID, name: ACCOUNT_NAME },
    token: { status: "active", expiresOn: null, notBefore: null },
    apiCalls: 1,
  });
  // Invariants: org-scoped resolution, no secret in output/logs, one read call.
  expect(payload.operations).toMatchObject([
    { name: "prepare-input-v1", status: "Succeeded" },
    { name: "cloudflare-verify-v1", status: "Succeeded" },
  ]);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(payload)).not.toContain(TOKEN_SENTINEL);
  const ops = await bindings.DB.prepare("SELECT result_json,error_json FROM operations WHERE execution_id=?")
    .bind(id)
    .all<{ result_json: string | null; error_json: string | null }>();
  expect(JSON.stringify(ops.results)).not.toContain(TOKEN_SENTINEL);
});

it("replays verify-authorization-failure: vendor 403 becomes the stable error", async () => {
  const scenario = authFailure as unknown as {
    workflow: { input: Record<string, unknown> };
    binding: { entity_id: string; entity_name: string };
    http: ReplayExchange[];
  };
  mockVendor(scenario.http);
  const key = "cf-verify-authfail-0001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_VERIFY_WORKFLOW, id);
  const body = { ...scenario.workflow.input, ...accountBinding(scenario.binding.entity_id, scenario.binding.entity_name) };
  expect((await worker.fetch(request("/api/executions", "POST", cloudflareVerifySaga.id, body, key), bindings)).status).toBe(
    202,
  );
  await instance.waitForStatus("errored");
  const detail = await worker.fetch(request(`/api/executions/${id}`, "GET", cloudflareVerifySaga.id, {}, key), bindings);
  const payload = (await detail.json()) as { status: string; error: { code: string; message: string } };
  expect(payload.status).toBe("Failed");
  // Exact error contract: vendor status code plus the safe vendor message.
  expect(payload.error.message).toBe("Cloudflare returned HTTP 403: Invalid access token");
  // Invariants: no secret in the error or the persisted rows.
  expect(JSON.stringify(payload)).not.toContain(TOKEN_SENTINEL);
  const rows = await bindings.DB.prepare("SELECT result_json,error_json FROM operations WHERE execution_id=?")
    .bind(id)
    .all<{ result_json: string | null; error_json: string | null }>();
  expect(JSON.stringify(rows.results)).not.toContain(TOKEN_SENTINEL);
});

it("replays verify-malformed-json: non-JSON vendor body becomes the stable error", async () => {
  const scenario = malformedJson as unknown as {
    workflow: { input: Record<string, unknown> };
    binding: { entity_id: string; entity_name: string };
    http: ReplayExchange[];
  };
  mockVendor(scenario.http);
  const key = "cf-verify-malformed-0001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_VERIFY_WORKFLOW, id);
  const body = { ...scenario.workflow.input, ...accountBinding(scenario.binding.entity_id, scenario.binding.entity_name) };
  expect((await worker.fetch(request("/api/executions", "POST", cloudflareVerifySaga.id, body, key), bindings)).status).toBe(
    202,
  );
  await instance.waitForStatus("errored");
  const detail = await worker.fetch(request(`/api/executions/${id}`, "GET", cloudflareVerifySaga.id, {}, key), bindings);
  const payload = (await detail.json()) as { status: string; error: { code: string; message: string } };
  expect(payload.status).toBe("Failed");
  expect(payload.error.message).toBe("Cloudflare returned HTTP 502 with invalid JSON.");
  // Invariant: response content never lands in the error.
  expect(payload.error.message).not.toContain("upstream response was not JSON");
});

it("replays inventory-two-pages: ordered pagination, exact inventory result", async () => {
  const scenario = twoPages as unknown as {
    workflow: { input: Record<string, unknown> };
    binding: { entity_id: string; entity_name: string };
    http: ReplayExchange[];
  };
  expect(scenario.http).toHaveLength(2);
  const mock = mockVendor(scenario.http);
  const key = "cf-inventory-twopages-0001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_INVENTORY_WORKFLOW, id);
  const body = { ...scenario.workflow.input, ...accountBinding(scenario.binding.entity_id, scenario.binding.entity_name) };
  const accepted = await worker.fetch(
    request("/api/executions", "POST", cloudflareInventorySaga.id, body, key),
    bindings,
  );
  expect(accepted.status).toBe(202);
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(
    request(`/api/executions/${id}`, "GET", cloudflareInventorySaga.id, {}, key),
    bindings,
  );
  const payload = (await detail.json()) as { status: string; result: unknown };
  expect(payload.status).toBe("Succeeded");
  // Exact terminal result per the scenario's expected block (snake_case
  // shaped to the Wrangnarok camelCase result contract).
  expect(payload.result).toEqual({
    status: "completed",
    readOnly: true,
    integration: "Cloudflare",
    account: { id: ACCOUNT_ID, name: ACCOUNT_NAME },
    zoneCount: 3,
    totalAvailable: 3,
    truncated: false,
    apiCalls: 2,
    summary: {
      statusCounts: { active: 2, pending: 1 },
      typeCounts: { full: 2, partial: 1 },
      paused: 1,
      developmentModeActive: 1,
    },
    zones: [
      {
        id: "zone-1",
        name: "alpha.example",
        status: "active",
        type: "full",
        paused: false,
        developmentModeActive: false,
        accountId: ACCOUNT_ID,
        accountName: ACCOUNT_NAME,
        plan: "Pro",
        nameServers: ["a.ns.example", "b.ns.example"],
        activatedOn: "2026-01-02T03:04:05Z",
        modifiedOn: "2026-02-03T04:05:06Z",
      },
      {
        id: "zone-2",
        name: "bravo.example",
        status: "active",
        type: "full",
        paused: false,
        developmentModeActive: false,
        accountId: ACCOUNT_ID,
        accountName: ACCOUNT_NAME,
        plan: "free",
        nameServers: ["c.ns.example", "d.ns.example"],
        activatedOn: null,
        modifiedOn: null,
      },
      {
        id: "zone-3",
        name: "charlie.example",
        status: "pending",
        type: "partial",
        paused: true,
        developmentModeActive: true,
        accountId: ACCOUNT_ID,
        accountName: ACCOUNT_NAME,
        plan: "unknown",
        nameServers: [],
        activatedOn: null,
        modifiedOn: null,
      },
    ],
  });
  // Invariants: vendor page order preserved, name servers sorted, final
  // advertised page stops pagination, exact external call count.
  expect(mock).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(payload)).not.toContain(TOKEN_SENTINEL);
});

it("replays inventory-missing-mapping: fails before any network request", async () => {
  const scenario = missingMapping as unknown as {
    workflow: { input: Record<string, unknown> };
    binding: { entity_id: null; entity_name: null };
  };
  // Empty http array: the run must make no network request.
  expect(scenario.http ?? []).toEqual([]);
  const mock = mockVendor([]);
  const key = "cf-inventory-missing-0001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_INVENTORY_WORKFLOW, id);
  const body = { ...scenario.workflow.input, ...accountBinding(null, null) };
  expect(
    (await worker.fetch(request("/api/executions", "POST", cloudflareInventorySaga.id, body, key), bindings)).status,
  ).toBe(202);
  await instance.waitForStatus("errored");
  const detail = await worker.fetch(
    request(`/api/executions/${id}`, "GET", cloudflareInventorySaga.id, {}, key),
    bindings,
  );
  const payload = (await detail.json()) as { status: string; error: { code: string; message: string } };
  expect(payload.status).toBe("Failed");
  expect(payload.error.message).toBe("Cloudflare integration is missing account mapping.");
  expect(mock).not.toHaveBeenCalled();
});

it("replays inventory-invalid-limit: input validation fails before resolution", async () => {
  const scenario = invalidLimit as unknown as { workflow: { input: Record<string, unknown> } };
  // max_zones 251 exceeds the 250 bound: parse rejects at submit with 400,
  // so no Execution row and no network request exist.
  const res = await worker.fetch(
    request("/api/executions", "POST", cloudflareInventorySaga.id, scenario.workflow.input, "cf-bad-limit-00000001"),
    bindings,
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
});

it("keeps the token sentinel out of every persisted row", async () => {
  const scenario = activeToken as unknown as {
    workflow: { input: Record<string, unknown> };
    binding: { entity_id: string; entity_name: string };
    http: ReplayExchange[];
  };
  mockVendor(scenario.http);
  const key = "cf-secret-audit-0001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.CLOUDFLARE_VERIFY_WORKFLOW, id);
  const body = { ...scenario.workflow.input, ...accountBinding(scenario.binding.entity_id, scenario.binding.entity_name) };
  expect((await worker.fetch(request("/api/executions", "POST", cloudflareVerifySaga.id, body, key), bindings)).status).toBe(
    202,
  );
  await instance.waitForStatus("complete");
  const tables = await bindings.DB.batch([
    bindings.DB.prepare("SELECT input_json,result_json,error_json FROM executions WHERE id=?").bind(id),
    bindings.DB.prepare("SELECT result_json,error_json FROM operations WHERE execution_id=?").bind(id),
    bindings.DB.prepare("SELECT endpoint FROM connections WHERE integration_id=?").bind(CLOUDFLARE_INTEGRATION_ID),
  ]);
  const dumped = JSON.stringify(tables.map((result) => result.results));
  expect(dumped).not.toContain(TOKEN_SENTINEL);
  expect(dumped).toContain("api.cloudflare.com");
});
