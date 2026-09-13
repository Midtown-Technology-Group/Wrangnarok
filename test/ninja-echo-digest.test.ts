// SPDX-License-Identifier: AGPL-3.0
// Phase 2 (issue #76): multi-Integration Saga ninjaone-echo-digest. All gates
// run in real workerd with real D1/Workflow bindings; only outbound vendor
// HTTP is mocked.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { digestSaga, executionId } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "ninja-echo-digest-test-001";
const SECRET_SENTINEL = "test-client-secret-sentinel";
const TOKEN_SENTINEL = "test-access-token-sentinel";
const EXPECTED_DIGEST = "NinjaOne organizations (2 total): Acme, Globex";
function request(path: string, method = "GET", idempotencyKey = key) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    ...(method === "POST" ? { body: JSON.stringify({ sagaId: digestSaga.id, input: {} }) } : {}),
  });
}
const calls: string[] = [];
function mockVendors(
  token: unknown,
  orgs: unknown,
  tokenStatus = 200,
  orgsStatus = 200,
  echoStatus = 200,
  orgsDelayMs = 0,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return new Response(JSON.stringify(token), {
        status: tokenStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      // Optional slow vendor: the Integration's 5s AbortSignal deadline fires
      // first and must surface NINJA_VENDOR_TIMEOUT, never a hang.
      if (orgsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, orgsDelayMs));
      return new Response(typeof orgs === "string" ? orgs : JSON.stringify(orgs), {
        status: orgsStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "http://127.0.0.1:8788/echo") {
      // The digest step reuses its stable operation ID as the outbound
      // Idempotency-Key so a redelivered step converges downstream.
      const headers = new Headers(init?.headers as HeadersInit);
      const operationKey = headers.get("Idempotency-Key");
      if (!operationKey?.endsWith("-echo-digest-v1")) {
        return new Response("unexpected-operation-key", { status: 500 });
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { message?: unknown };
      return new Response(JSON.stringify({ message: body.message }), {
        status: echoStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
}
beforeEach(async () => {
  // Real local D1 SQL statements, not an in-memory repository double.
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(seed);
  // Each suite owns its fixture Connection rows. Dummy host: never contacted
  // (vendor HTTP is intercepted below) and never a real instance.
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(
      "00000000-0000-4000-8000-000000000103",
      principal.orgId,
      "0606e237-137b-4629-8346-85468e1c2df6",
      "https://ninja-in-test.invalid/api",
    )
    .run();
  calls.length = 0;
  mockVendors({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" }, [
    { id: 1, name: "Acme" },
    { id: 2, name: "Globex" },
  ]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
it("runs the NinjaOne census through the echo Integration end to end", async () => {
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.DIGEST_WORKFLOW, id);
  const started = Date.now();
  const accepted = await worker.fetch(request("/api/executions", "POST"), bindings);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
  expect(await accepted.json()).toMatchObject({ executionId: id, replayed: false });
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(request(`/api/executions/${id}`), bindings);
  const detailText = await detail.text();
  expect(JSON.parse(detailText)).toMatchObject({
    executionId: id,
    status: "Succeeded",
    result: { organizationCount: 2, echoed: { message: EXPECTED_DIGEST } },
    operations: [
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "ninja-list-orgs-v1", status: "Succeeded" },
      { name: "echo-digest-v1", status: "Succeeded" },
    ],
  });
  // The served detail surface carries no secret material either.
  expect(detailText).not.toContain(SECRET_SENTINEL);
  expect(detailText).not.toContain(TOKEN_SENTINEL);
  // Exactly one outbound call per vendor hop: both vendor steps resolve
  // retries 0 through stepRetryLimit, so success costs token + orgs + echo.
  expect(calls).toHaveLength(3);
  // The 1-second native step.sleep sits between the echo step and the success
  // checkpoint, so reaching Succeeded proves wake+continue on this Saga too.
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
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
  expect(dumped).toContain(EXPECTED_DIGEST);
});
it("fails loud on NinjaOne auth without ever calling echo", async () => {
  mockVendors({ error: "invalid_client" }, [], 401, 200);
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.DIGEST_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ status: "Failed", error: { code: "NINJA_UNAUTHORIZED" } });
  expect(text).not.toContain("invalid_client");
  expect(text).not.toContain(SECRET_SENTINEL);
  expect(text).not.toContain(TOKEN_SENTINEL);
  expect(calls).toHaveLength(1);
  expect(calls.some((url) => url.endsWith("/echo"))).toBe(false);
});
it("never auto-retries a failing echo of the digest", async () => {
  mockVendors(
    { access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" },
    [{ id: 1, name: "Acme" }],
    200,
    200,
    503,
  );
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.DIGEST_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  expect(await response.json()).toMatchObject({ status: "Failed", error: { code: "ECHO_INTEGRATION_FAILED" } });
  // Token + orgs + exactly one echo attempt: no engine retry of either vendor hop.
  expect(calls).toHaveLength(3);
  expect(calls.filter((url) => url.endsWith("/echo"))).toHaveLength(1);
});
it("surfaces a slow NinjaOne vendor as TimedOut through the explicit timeout step", async () => {
  // The mocked orgs endpoint outlives the Integration's 5s deadline: the
  // abort maps to NINJA_VENDOR_TIMEOUT and the census leg routes it to
  // timeout-mark-v1, never an inferred failure. The echo hop never runs.
  mockVendors(
    { access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" },
    [{ id: 1, name: "Acme" }],
    200,
    200,
    200,
    6000,
  );
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.DIGEST_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  expect(await response.json()).toMatchObject({ status: "TimedOut", error: { code: "NINJA_VENDOR_TIMEOUT" } });
  expect(calls).toHaveLength(2);
  expect(calls.some((url) => url.endsWith("/echo"))).toBe(false);
}, 20000);
it("cancels a Pending digest execution on its own Workflow binding", async () => {
  // workflowForSaga must resolve the digest binding the same way submit
  // dispatches it (issue #55 class of regression: cancel missing a binding).
  const id = await executionId(principal, key);
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("cancelled digest must not fetch");
  });
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      digestSaga.id,
      digestSaga.name,
      digestSaga.revision,
      principal.orgId,
      principal.userId,
      JSON.stringify({}),
      0,
      "Pending",
      new Date().toISOString(),
    )
    .run();
  const cancelled = await worker.fetch(request(`/api/executions/${id}/cancel`, "POST"), bindings);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
  expect(fetch).not.toHaveBeenCalled();
  const replay = await worker.fetch(request("/api/executions", "POST"), bindings);
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "EXECUTION_CANCELLED" } });
  expect(fetch).not.toHaveBeenCalled();
});
