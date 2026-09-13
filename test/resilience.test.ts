// SPDX-License-Identifier: AGPL-3.0
// Issue #16: retries, sleeps, cancellation, timeout. All gates run in real
// workerd with real D1/Workflow bindings; only outbound vendor HTTP is mocked.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId, smokeSaga } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const auth = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };
function submitRequest(key: string, message = "hello") {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": key },
    body: JSON.stringify({ sagaId: echoSaga.id, input: { message } }),
  });
}
function detailRequest(id: string) {
  return new Request(`https://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } });
}
function cancelRequest(id: string, override: Partial<Bindings> = {}) {
  return {
    request: new Request(`https://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } }),
    override,
  };
}
async function waitForExecutionStatus(id: string, want: string, timeoutMs = 10000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const body = (await (await worker.fetch(detailRequest(id), bindings)).json()) as { status: string };
    if (body.status === want) return body.status;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${want}; last observed: ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function mockEcho(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const [input] = args;
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://127.0.0.1:8788/echo") throw new Error(`Unexpected outbound request: ${url}`);
    return implementation(input as RequestInfo, args[1]);
  });
}
beforeEach(async () => {
  // Real local D1 SQL statements, not an in-memory repository double.
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
it("wakes from the native sleep step and continues to success", async () => {
  const key = "resilience-sleep-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  mockEcho(async () => Response.json({ message: "hello" }));
  const started = Date.now();
  expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(detailRequest(id), bindings);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    status: "Succeeded",
    result: { message: "hello" },
    operations: [
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "echo-http-v1", status: "Succeeded" },
    ],
  });
  // The 1-second native step.sleep sits between the vendor step and the
  // success checkpoint, so reaching Succeeded proves wake+continue. The sleep
  // itself is an infrastructure checkpoint, not a product Operation.
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
});
it("never auto-retries a failing vendor operation", async () => {
  const key = "resilience-noretry-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  mockEcho(async () => new Response("private-vendor-diagnostic", { status: 503 }));
  expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(detailRequest(id), bindings);
  expect(await response.json()).toMatchObject({ status: "Failed", error: { code: "ECHO_INTEGRATION_FAILED" } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("surfaces a slow vendor as TimedOut through the explicit timeout step", async () => {
  const key = "resilience-timeout-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  mockEcho(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return new Response("slow-vendor-diagnostic", { status: 503 });
  });
  expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(detailRequest(id), bindings);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    executionId: id,
    status: "TimedOut",
    error: { code: "ECHO_VENDOR_TIMEOUT" },
  });
  expect(text).not.toContain("slow-vendor-diagnostic");
}, 20000);
it("cancels a Running execution through the native terminate control", async () => {
  const key = "resilience-cancel-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  // Never-settling vendor: the mocked fetch ignores the abort signal, so the
  // step stays Running until the native step timeout (10s) or terminate wins.
  mockEcho(() => new Promise<Response>(() => {}));
  expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
  await waitForExecutionStatus(id, "Running");
  const { request } = cancelRequest(id);
  const cancelled = await worker.fetch(request, bindings);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
  const native = await Promise.race([
    instance.waitForStatus("terminated").then(() => "terminated"),
    new Promise((resolve) => setTimeout(() => resolve("unobserved"), 8000)),
  ]);
  console.log(`native terminate observation: ${native}`);
  const detail = await worker.fetch(detailRequest(id), bindings);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    status: "Cancelled",
    error: { code: "EXECUTION_CANCELLED" },
  });
  // Re-cancel of the now-terminal Execution is rejected, not resurrected.
  expect((await worker.fetch(cancelRequest(id).request, bindings)).status).toBe(409);
  // A foreign requester learns nothing about the Execution.
  const foreign = await worker.fetch(cancelRequest(id).request, {
    ...bindings,
    LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
  });
  expect(foreign.status).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(1);
}, 25000);
it("cancels a Pending execution immediately and never dispatches it", async () => {
  const key = "resilience-cancel-pending-001";
  const id = await executionId(principal, key);
  mockEcho(async () => Response.json({ message: "hello" }));
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      principal.orgId,
      principal.userId,
      JSON.stringify({ message: "hello" }),
      0,
      "Pending",
      new Date().toISOString(),
    )
    .run();
  const { request } = cancelRequest(id);
  const cancelled = await worker.fetch(request, bindings);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
  expect(fetch).not.toHaveBeenCalled();
  // The durable receipt stays Cancelled: retrying the same key must not
  // resurrect a Workflow instance for it.
  const replay = await worker.fetch(submitRequest(key), bindings);
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "EXECUTION_CANCELLED" } });
  expect(fetch).not.toHaveBeenCalled();
});
it("cancels a Pending system.smoke execution and never dispatches it", async () => {
  // Issue #55: the cancel path resolved only the ninja/echo Workflow
  // bindings and missed SMOKE_WORKFLOW, while submit dispatches all three
  // Sagas through workflowForSaga. Cancel now resolves the same way, so a
  // smoke Execution terminates on its own binding and lands Cancelled.
  const key = "resilience-cancel-smoke-pending-001";
  const id = await executionId(principal, key);
  // Guard, not a fixture: system.smoke is loopback-free, so any outbound
  // fetch is a failure.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("system.smoke must not fetch");
  });
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      smokeSaga.id,
      smokeSaga.name,
      smokeSaga.revision,
      principal.orgId,
      principal.userId,
      JSON.stringify({}),
      0,
      "Pending",
      new Date().toISOString(),
    )
    .run();
  const { request } = cancelRequest(id);
  const cancelled = await worker.fetch(request, bindings);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
  const detail = await worker.fetch(detailRequest(id), bindings);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    status: "Cancelled",
    error: { code: "EXECUTION_CANCELLED" },
  });
  // Re-cancel of the now-terminal Execution is rejected, not resurrected.
  expect((await worker.fetch(cancelRequest(id).request, bindings)).status).toBe(409);
  // The durable receipt stays Cancelled: retrying the same key must not
  // resurrect a Workflow instance for it.
  const replay = await worker.fetch(
    new Request("https://local.test/api/executions", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": key },
      body: JSON.stringify({ sagaId: smokeSaga.id, input: {} }),
    }),
    bindings,
  );
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "EXECUTION_CANCELLED" } });
  expect(fetch).not.toHaveBeenCalled();
});
it("refuses to cancel terminal executions", async () => {
  const key = "resilience-cancel-terminal-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  mockEcho(async () => Response.json({ message: "hello" }));
  expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  await waitForExecutionStatus(id, "Succeeded");
  const response = await worker.fetch(cancelRequest(id).request, bindings);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "EXECUTION_NOT_CANCELLABLE" } });
}, 20000);
