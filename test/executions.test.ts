import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId } from "../src/domain";
import migration from "../migrations/0001_initial.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "mvp-slice-test-001";
function request(path: string, method = "GET", message = "hello", idempotencyKey = key) {
  return new Request(`https://local.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    ...(method === "POST" ? { body: JSON.stringify({ sagaId: echoSaga.id, input: { message } }) } : {}),
  });
}
beforeEach(async () => {
  // These are real local D1 SQL statements, not an in-memory repository double.
  await bindings.DB.exec(migration);
  await bindings.DB.exec(seed);
  // Intercept only outbound vendor HTTP. Native D1/Workflow bindings are never replaced.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://127.0.0.1:8788/echo") throw new Error("Unexpected outbound request");
    return Response.json({ message: "hello" });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
it("traverses HTTP -> D1 -> Workflow -> HTTP Integration -> D1, and reuses a submission", async () => {
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  const accepted = await worker.fetch(request("/api/executions", "POST"), bindings);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
  expect(await accepted.json()).toMatchObject({ executionId: id, replayed: false });
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(request(`/api/executions/${id}`), bindings);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    status: "Succeeded",
    result: { message: "hello" },
    operations: [
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "echo-http-v1", status: "Succeeded" },
    ],
  });
  const replay = await worker.fetch(request("/api/executions", "POST"), bindings);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ executionId: id, replayed: true });
  const conflict = await worker.fetch(request("/api/executions", "POST", "changed"), bindings);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  expect(
    (
      await worker.fetch(request(`/api/executions/${id}`), {
        ...bindings,
        LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await worker.fetch(request(`/api/executions/${id}`), {
        ...bindings,
        LAB_ORG_ID: "00000000-0000-4000-8000-000000000004",
      })
    ).status,
  ).toBe(404);
  const history = await worker.fetch(request("/api/executions"), bindings);
  const text = await history.text();
  expect(text).not.toContain('"input"');
  expect(text).not.toContain('"result"');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("persists structured failure without copying the vendor error body", async () => {
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  vi.mocked(fetch).mockResolvedValue(new Response("private-vendor-diagnostic", { status: 503 }));
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ status: "Failed", error: { code: "ECHO_INTEGRATION_FAILED" } });
  expect(text).not.toContain("private-vendor-diagnostic");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("denies unauthenticated requests and stays disabled by default", async () => {
  expect((await worker.fetch(new Request("https://local.test/api/executions"), bindings)).status).toBe(401);
  expect((await worker.fetch(request("/api/executions"), { ...bindings, LAB_ENABLED: "false" })).status).toBe(404);
});

it("does not resolve another Organization's Connection when this Organization has none", async () => {
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(principal.orgId).run();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES ('other-organization','Other')").run();
  await bindings.DB.prepare(
    "INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES ('other','other-organization','720b9ebf-9b6a-4eac-bae9-6ed22c970402','http://127.0.0.1:8788/echo')",
  ).run();
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  expect((await worker.fetch(request("/api/executions", "POST"), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const response = await worker.fetch(request(`/api/executions/${id}`), bindings);
  expect(await response.json()).toMatchObject({
    status: "Failed",
    error: { code: "INTEGRATION_REQUIREMENT_UNSATISFIED" },
  });
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses to resurrect an expired unconfirmed reservation without inventing success", async () => {
  const expiredKey = "mvp-slice-expired-001";
  const id = await executionId(principal, expiredKey);
  const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
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
      old,
    )
    .run();
  const res = await worker.fetch(request("/api/executions", "POST", "hello", expiredKey), bindings);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: { code: "RECOVERY_EXPIRED" } });
  const detail = await worker.fetch(request(`/api/executions/${id}`, "GET", "hello", expiredKey), bindings);
  expect(await detail.json()).toMatchObject({ executionId: id, status: "Pending", dispatchConfirmed: false });
  expect(fetch).not.toHaveBeenCalled();
});
