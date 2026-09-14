import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { executionId, ninjaSaga } from "../src/domain";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "ninjaone-test-001";
const SECRET_SENTINEL = "test-client-secret-sentinel";
const TOKEN_SENTINEL = "test-access-token-sentinel";
function request(path: string, method = "GET", body: unknown = {}) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json", "Idempotency-Key": key },
    ...(method === "POST" ? { body: JSON.stringify({ sagaId: ninjaSaga.id, input: body }) } : {}),
  });
}
function mockNinja(token: unknown, orgs: unknown, tokenStatus = 200, orgsStatus = 200, orgsDelayMs = 0) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      const body = typeof init?.body === "string" ? init.body : "";
      expect(body).toContain("grant_type=client_credentials");
      expect(body).toContain("scope=monitoring");
      expect(body).not.toContain("management");
      // workerd has no error-mode redirect; pin the live-safe policy.
      expect(init?.redirect).toBe("manual");
      return new Response(JSON.stringify(token), {
        status: tokenStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      // Optional slow vendor: the Integration's 5s deadline fires first and
      // must surface NINJA_VENDOR_TIMEOUT, never a hang.
      if (orgsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, orgsDelayMs));
      // Read headers without rebuilding a Request: init may carry a
      // cross-realm AbortSignal that the Request constructor rejects.
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
useWorkflowHarness(bindings.DB, {
  setup: async () => {
    // The committed seed carries no real endpoints (override pattern); each
    // suite owns its fixture Connection rows. Dummy host: never contacted
    // (vendor HTTP is intercepted below) and never a real instance.
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind(
        "00000000-0000-4000-8000-000000000102",
        principal.orgId,
        "0606e237-137b-4629-8346-85468e1c2df6",
        "https://ninja-in-test.invalid/api",
      )
      .run();
    // Intercept only outbound vendor HTTP. Native D1/Workflow bindings are never replaced.
    mockNinja({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" }, [
      { id: 1, name: "Acme" },
      { id: 2, name: "Globex" },
    ]);
  },
});
it("lists NinjaOne organizations end to end and reuses a submission", async () => {
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  const accepted = await worker.fetch(request("/api/executions", "POST"), bindings);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
  expect(await accepted.json()).toMatchObject({ executionId: id, replayed: false });
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(request(`/api/executions/${id}`), bindings);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    status: "Succeeded",
    result: {
      organizationCount: 2,
      organizations: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Globex" },
      ],
    },
    operations: [
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "ninja-list-orgs-v1", status: "Succeeded" },
    ],
  });
  const replay = await worker.fetch(request("/api/executions", "POST"), bindings);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ executionId: id, replayed: true });
  // Secrets and tokens never persist: audit every D1 row for both sentinels,
  // including the persisted usage block.
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
it("exposes no secret material on discovery, history, or detail surfaces", async () => {
  // v0 acceptance: the declared secretFields (clientSecret) plus transient
  // tokens must be absent from every browser-facing surface, not just D1.
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  const bodies: string[] = [];
  for (const path of ["/api/sagas", "/api/executions", `/api/executions/${id}`]) {
    const response = await worker.fetch(request(path), bindings);
    expect(response.status).toBe(200);
    bodies.push(await response.text());
  }
  for (const text of bodies) {
    expect(text).not.toContain(SECRET_SENTINEL);
    expect(text).not.toContain(TOKEN_SENTINEL);
  }
  expect(bodies.join("")).toContain("ninjaone-orgs");
});
it("persists NINJA_UNAUTHORIZED without copying vendor bodies", async () => {
  mockNinja({ error: "invalid_client" }, [], 401, 200);
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ status: "Failed", error: { code: "NINJA_UNAUTHORIZED" } });
  expect(text).not.toContain("invalid_client");
  expect(text).not.toContain(SECRET_SENTINEL);
  expect(text).not.toContain(TOKEN_SENTINEL);
});
it("surfaces a throttled token request as NINJA_RATE_LIMITED without calling orgs", async () => {
  // Acceptance gap G1 (issue #76): the token call had no distinct 429 code
  // and collapsed into NINJA_AUTH_FAILED. Exactly one outbound call proves
  // the orgs hop never runs and nothing retries.
  mockNinja({ error: "rate_limited" }, [], 429, 200);
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ status: "Failed", error: { code: "NINJA_RATE_LIMITED" } });
  expect(text).not.toContain("rate_limited");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects non-empty input and unknown sagas", async () => {
  expect((await worker.fetch(request("/api/executions", "POST", { message: "x" }), bindings)).status).toBe(400);
  const unknown = new Request("https://local.test/api/executions", {
    method: "POST",
    headers: { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ sagaId: "00000000-0000-0000-0000-000000000000", input: {} }),
  });
  expect((await worker.fetch(unknown, bindings)).status).toBe(400);
});
it("truncates large organization lists to a bounded persisted summary", async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Org ${index + 1}` }));
  mockNinja({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" }, many);
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(request(`/api/executions/${id}`), bindings);
  const body = (await detail.json()) as {
    status: string;
    result: { organizationCount: number; organizations: unknown[] };
  };
  expect(body.status).toBe("Succeeded");
  expect(body.result.organizationCount).toBe(100);
  expect(body.result.organizations).toHaveLength(25);
});
it("surfaces a slow NinjaOne vendor as TimedOut through the explicit timeout step", async () => {
  // Timeout parity with the echo and digest legs: the Integration deadline
  // fires first and the Saga routes NINJA_VENDOR_TIMEOUT to timeout-mark-v1.
  // Token + orgs attempt only: no retry, no echo of anything.
  mockNinja(
    { access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" },
    [{ id: 1, name: "Acme" }],
    200,
    200,
    6000,
  );
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  expect(await response.json()).toMatchObject({ status: "TimedOut", error: { code: "NINJA_VENDOR_TIMEOUT" } });
  expect(fetch).toHaveBeenCalledTimes(2);
}, 20000);
