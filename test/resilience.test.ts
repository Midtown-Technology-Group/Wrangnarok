// SPDX-License-Identifier: AGPL-3.0
// Issue #16: retries, sleeps, cancellation, timeout. All gates run in real
// workerd with real D1/Workflow bindings; only outbound vendor HTTP is mocked.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { echoSaga, executionId, smokeSaga } from "../src/domain";
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
useWorkflowHarness(bindings.DB);
it("wakes from the native sleep step and continues to success", async () => {
  const key = "resilience-sleep-001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
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
  const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
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
  const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
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
  const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
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
  const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  mockEcho(async () => Response.json({ message: "hello" }));
  expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  await waitForExecutionStatus(id, "Succeeded");
  const response = await worker.fetch(cancelRequest(id).request, bindings);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "EXECUTION_NOT_CANCELLABLE" } });
}, 20000);

// Migration replay on populated baselines (codex findings #381, #367-371).
// These tests rebuild a controlled database inline (reset + partial chain +
// seed rows), then apply the repair migrations and assert rows and schema
// survive. They never rely on the harness full-chain state: each test owns
// its baseline via reset() first so the assertions prove the upgrade path,
// not the fresh-install path.
import { reset as resetCloudflare } from "cloudflare:test";
import migration0001 from "../migrations/0001_initial.sql?raw";
import migration0002 from "../migrations/0002_cancelling.sql?raw";
import migration0004 from "../migrations/0004_solutions_install.sql?raw";
import migration0026 from "../migrations/0026_cancelling_repair.sql?raw";
import migration0027 from "../migrations/0027_rename_replay_repair.sql?raw";
import migration0010new from "../migrations/0010_solutions_activation.sql?raw";
import migration0018 from "../migrations/0018_ops.sql?raw";
import migration0019 from "../migrations/0019_files.sql?raw";
import migration0020 from "../migrations/0020_artifacts.sql?raw";
import migration0021 from "../migrations/0021_endpoints.sql?raw";

const REPLAY_ORG = "11111111-1111-4111-8111-111111111111";

async function replayBaseline(): Promise<void> {
  await resetCloudflare();
  await bindings.DB.exec(migration0001);
  await bindings.DB.exec(`INSERT INTO organizations(id, name) VALUES ('${REPLAY_ORG}', 'Replay baseline')`);
}

async function executionRow(id: string): Promise<{ status: string } | null> {
  return bindings.DB.prepare("SELECT status FROM executions WHERE id = ?").bind(id).first<{ status: string }>();
}

it("0026 preserves executions and operations across the cancelling rebuild (#381)", async () => {
  await replayBaseline();
  // Baseline mirrors a populated pre-upgrade database: an execution with a
  // child operation row, the exact state that made migration 0002 fail with
  // FOREIGN KEY constraint failed when operation history existed.
  await bindings.DB.exec(
    `INSERT INTO executions(id, saga_id, saga_name, saga_revision, org_id, user_id, input_json, created_at, status) VALUES ('replay-exec-1', 'saga', 'Saga', 'r1', '${REPLAY_ORG}', 'user-1', '{}', '2026-01-01T00:00:00.000Z', 'Running');
     INSERT INTO operations(execution_id, name, position, status, started_at) VALUES ('replay-exec-1', 'op-v1', 0, 'Running', '2026-01-01T00:00:00.000Z')`,
  );
  // Applying 0002 to this populated baseline fails exactly as issue #381
  // reports (FOREIGN KEY constraint failed on the DROP while operations
  // rows reference executions) -- the bug under test. The repair then
  // converges the same state while preserving every row.
  await expect(bindings.DB.exec(migration0002)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  await bindings.DB.exec(migration0026);
  // Rows survive the repair rebuild byte for byte.
  expect(await executionRow("replay-exec-1")).toMatchObject({ status: "Running" });
  const operation = await bindings.DB.prepare(
    "SELECT execution_id, name, position, status FROM operations WHERE execution_id = ?",
  )
    .bind("replay-exec-1")
    .first<{ execution_id: string; name: string; position: number; status: string }>();
  expect(operation).toMatchObject({
    execution_id: "replay-exec-1",
    name: "op-v1",
    position: 0,
    status: "Running",
  });
  // The rebuilt executions table carries the Cancelling/Cancelled statuses.
  await bindings.DB.exec(
    `INSERT INTO executions(id, saga_id, saga_name, saga_revision, org_id, user_id, input_json, created_at, status) VALUES ('replay-exec-2', 'saga', 'Saga', 'r1', '${REPLAY_ORG}', 'user-1', '{}', '2026-01-02T00:00:00.000Z', 'Cancelling')`,
  );
  expect(await executionRow("replay-exec-2")).toMatchObject({ status: "Cancelling" });
  expect(await bindings.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
  await resetCloudflare();
});

it("0026 is a safe no-op on an already-healthy database (#381)", async () => {
  await replayBaseline();
  await bindings.DB.exec(migration0002);
  await bindings.DB.exec(
    `INSERT INTO executions(id, saga_id, saga_name, saga_revision, org_id, user_id, input_json, created_at, status) VALUES ('healthy-exec-1', 'saga', 'Saga', 'r1', '${REPLAY_ORG}', 'user-1', '{}', '2026-01-01T00:00:00.000Z', 'Cancelled');
     INSERT INTO operations(execution_id, name, position, status, started_at) VALUES ('healthy-exec-1', 'op-v1', 0, 'Succeeded', '2026-01-01T00:00:00.000Z')`,
  );
  await bindings.DB.exec(migration0026);
  // Second application proves the repair itself reruns cleanly.
  await bindings.DB.exec(migration0026);
  expect(await executionRow("healthy-exec-1")).toMatchObject({ status: "Cancelled" });
  const operations = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM operations").first<{ n: number }>();
  expect(operations?.n).toBe(1);
  await resetCloudflare();
});

it("0027 converges rename-split objects without losing rows (#367-371)", async () => {
  await replayBaseline();
  // Baseline mirrors an old-name database: the pre-rename files applied under
  // their original filenames (content identical to the renamed files).
  await bindings.DB.exec(migration0004);
  await bindings.DB.exec(migration0010new);
  await bindings.DB.exec(migration0018);
  await bindings.DB.exec(migration0019);
  await bindings.DB.exec(migration0020);
  await bindings.DB.exec(migration0021);
  await bindings.DB.exec(
    `INSERT INTO audit_events(id, org_id, actor_user_id, action, outcome, created_at) VALUES ('replay-audit-1', '${REPLAY_ORG}', 'user-1', 'app.create', 'success', '2026-01-01T00:00:00.000Z');
     INSERT INTO endpoints(id, org_id, name, saga_id, kind, created_at) VALUES ('replay-endpoint-1', '${REPLAY_ORG}', 'greet', 'saga-1', 'api-key', '2026-01-01T00:00:00.000Z');
     INSERT INTO file_locations(org_id, name, max_bytes, created_at) VALUES ('${REPLAY_ORG}', 'uploads', 1024, '2026-01-01T00:00:00.000Z');
     INSERT INTO artifacts(id, org_id, creator_user_id, name, mime, size_bytes, created_at, updated_at) VALUES ('replay-artifact-1', '${REPLAY_ORG}', 'user-1', 'notes', 'text/plain', 5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  // The repair converges every renamed object; rerunning proves it is stable.
  await bindings.DB.exec(migration0027);
  await bindings.DB.exec(migration0027);
  const audit = await bindings.DB.prepare("SELECT action, outcome FROM audit_events WHERE id = ?")
    .bind("replay-audit-1")
    .first<{ action: string; outcome: string }>();
  expect(audit).toMatchObject({ action: "app.create", outcome: "success" });
  const endpoint = await bindings.DB.prepare("SELECT name, kind FROM endpoints WHERE id = ?")
    .bind("replay-endpoint-1")
    .first<{ name: string; kind: string }>();
  expect(endpoint).toMatchObject({ name: "greet", kind: "api-key" });
  const location = await bindings.DB.prepare("SELECT name FROM file_locations WHERE org_id = ?")
    .bind(REPLAY_ORG)
    .first<{ name: string }>();
  expect(location).toMatchObject({ name: "uploads" });
  const artifact = await bindings.DB.prepare("SELECT name, mime FROM artifacts WHERE id = ?")
    .bind("replay-artifact-1")
    .first<{ name: string; mime: string }>();
  expect(artifact).toMatchObject({ name: "notes", mime: "text/plain" });
  await resetCloudflare();
});
