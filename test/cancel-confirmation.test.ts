// SPDX-License-Identifier: AGPL-3.0
// RUN-04 (issue #151): never confirm cancellation when native Workflow
// termination is ambiguous. One test proves a real local Workflow reaches the
// native terminated state through the cancel route; the fault-injection tests
// prove a failed termination is NOT reported as confirmed physical
// cancellation (503 CANCELLATION_UNCONFIRMED, retry-safe, no false 200).
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { echoSaga, executionId } from "../src/domain";

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

function cancelRequest(id: string) {
  return new Request(`https://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } });
}

function mockEcho(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const [input] = args;
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://127.0.0.1:8788/echo") throw new Error(`Unexpected outbound request: ${url}`);
    return implementation(input as RequestInfo, args[1]);
  });
}

async function waitForExecutionStatus(id: string, want: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const body = (await (await worker.fetch(detailRequest(id), bindings)).json()) as { status: string };
    if (body.status === want) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${want}; last observed: ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function storedRow(id: string) {
  return bindings.DB.prepare("SELECT status,dispatched,error_json FROM executions WHERE id=?")
    .bind(id)
    .first<{ status: string; dispatched: number; error_json: string | null }>();
}

useWorkflowHarness(bindings.DB);

it("reaches the native terminated state through the cancel route", async () => {
  const key = "run04-native-terminated-001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  // Never-settling vendor: the mocked fetch ignores the abort signal, so the
  // step stays Running until the native step timeout (10s) or terminate wins.
  mockEcho(() => new Promise<Response>(() => {}));
  expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
  await waitForExecutionStatus(id, "Running");
  const cancelled = await worker.fetch(cancelRequest(id), bindings);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
  // The native engine itself must reach terminated — not just the D1 marker.
  // No unobserved fallback: this assertion, not a log line, is the proof.
  await instance.waitForStatus("terminated");
  const detail = (await (await worker.fetch(detailRequest(id), bindings)).json()) as {
    status: string;
    runtimeStatus: string | null;
  };
  expect(detail).toMatchObject({ status: "Cancelled", runtimeStatus: "terminated" });
}, 25000);

it("does not confirm cancellation when native terminate fails transiently", async () => {
  // Fault injection at the native control: terminate throws a
  // transient/control-plane failure. The route must answer 503
  // CANCELLATION_UNCONFIRMED (never 200 confirmed), leave the Execution
  // retry-safe in its prior active status, and write no terminal marker or
  // Operation rows. The native control is a control, not data — only outbound
  // vendor HTTP is mocked elsewhere.
  const key = "run04-terminate-ambiguous-001";
  const submitted = await worker.fetch(submitRequest(key), bindings);
  expect(submitted.status).toBe(202);
  const { executionId: id } = (await submitted.json()) as { executionId: string };
  const live = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {},
      get: async () => ({
        terminate: async () => {
          throw new Error("WorkflowError: control plane unavailable");
        },
        status: async () => ({ status: "running" }),
      }),
    } as unknown as Bindings["ECHO_WORKFLOW"],
  };
  const response = await worker.fetch(cancelRequest(id), live);
  expect(response.status).toBe(503);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("CANCELLATION_UNCONFIRMED");
  expect(response.headers.get("Retry-After")).toBe("5");
  // No false confirmation: the Execution stays Pending (its prior active
  // status), keeps its dispatch marker, and carries no terminal payload.
  const row = await storedRow(id);
  expect(row).toMatchObject({ status: "Pending", dispatched: 1, error_json: null });
  const operations = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE execution_id=?")
    .bind(id)
    .first<{ n: number }>();
  expect(operations?.n).toBe(0);
  // Retry-safe: the follow-up cancel attempts the control again (and now
  // succeeds, vacuous or delivered — the point is the route retries the full
  // classify path rather than replaying a stored confirmation).
  const retry = await worker.fetch(cancelRequest(id), {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {},
      get: async () => ({ terminate: async () => {}, status: async () => ({ status: "terminated" }) }),
    } as unknown as Bindings["ECHO_WORKFLOW"],
  });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
});

it("does not confirm cancellation when a dispatched native instance is gone", async () => {
  // Dispatched row + instance.not_found: the confirmed instance vanished, so
  // the outcome is ambiguous — 503 with no terminal write, plus a rollback to
  // Running that leaves the true terminal outcome able to land afterward.
  const key = "run04-native-vanished-001";
  const id = await executionId(principal, key);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      principal.orgId,
      principal.userId,
      JSON.stringify({ message: "hello" }),
      1,
      "Running",
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const live = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {},
      get: async () => {
        throw new Error("instance.not_found");
      },
    } as unknown as Bindings["ECHO_WORKFLOW"],
  };
  const response = await worker.fetch(cancelRequest(id), live);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "CANCELLATION_UNCONFIRMED" } });
  const row = await storedRow(id);
  expect(row).toMatchObject({ status: "Running", dispatched: 1, error_json: null });
});

it("still cancels a Pending Execution whose native instance never existed", async () => {
  // Undispatched Pending row + instance.not_found is a vacuous stop: dispatch
  // was never confirmed, so there is nothing left running — confirm outright.
  const key = "run04-pending-vacuous-001";
  const id = await executionId(principal, key);
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
  const live = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {},
      get: async () => {
        throw new Error("instance.not_found");
      },
    } as unknown as Bindings["ECHO_WORKFLOW"],
  };
  const response = await worker.fetch(cancelRequest(id), live);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
  expect(await storedRow(id)).toMatchObject({ status: "Cancelled" });
});

it("confirms cancellation when the engine already settled natively", async () => {
  // instance.cannot_terminate means the engine is already in a finite state —
  // the logical cancel still wins (racing terminal checkpoints already no-op
  // against the fence), so confirm outright.
  const key = "run04-already-settled-001";
  const submitted = await worker.fetch(submitRequest(key), bindings);
  expect(submitted.status).toBe(202);
  const { executionId: id } = (await submitted.json()) as { executionId: string };
  const live = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {},
      get: async () => ({
        terminate: async () => {
          throw new Error(
            "WorkflowError: (instance.cannot_terminate) Cannot terminate instance since its on a finite state",
          );
        },
        status: async () => ({ status: "complete" }),
      }),
    } as unknown as Bindings["ECHO_WORKFLOW"],
  };
  const response = await worker.fetch(cancelRequest(id), live);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ executionId: id, status: "Cancelled", cancelled: true });
  expect(await storedRow(id)).toMatchObject({ status: "Cancelled" });
});

it("keeps the 503 body free of native diagnostics and scoped to the owner", async () => {
  // Non-disclosure holds on the ambiguous path too: the 503 body carries the
  // safe code/message only, and a foreign owner gets 404, never 503.
  const key = "run04-no-disclosure-001";
  const submitted = await worker.fetch(submitRequest(key), bindings);
  expect(submitted.status).toBe(202);
  const { executionId: id } = (await submitted.json()) as { executionId: string };
  const live = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {},
      get: async () => ({
        terminate: async () => {
          throw new Error("WorkflowError: super-secret-control-plane-trace-12345");
        },
        status: async () => ({ status: "running" }),
      }),
    } as unknown as Bindings["ECHO_WORKFLOW"],
  };
  const response = await worker.fetch(cancelRequest(id), live);
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text).not.toContain("super-secret-control-plane-trace-12345");
  expect(text).not.toContain("WorkflowError");
  const foreign = await worker.fetch(cancelRequest(id), {
    ...live,
    LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
  });
  expect(foreign.status).toBe(404);
});
