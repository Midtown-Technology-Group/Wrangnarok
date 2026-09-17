// SPDX-License-Identifier: AGPL-3.0
// Adversarial Workflow lifecycle coverage (issue #250): terminate and
// retry an Execution mid-lifecycle against the real local Workflow engine
// and assert the D1 record never claims success for a dead instance and a
// same-key retry never redispatches vendor work.
//
// Determinism without timing assumptions: the mocked vendor fetch is gated
// on a deferred promise, so the test scripts the interleaving (submit ->
// vendor call in flight -> terminate -> resubmit) instead of racing it.
//
// Out of scope by platform contract (documented, not tested here):
// duplicate/out-of-order *events* — waitForEvent is not part of the Saga
// contract (src/saga.ts), so there is no event-driven path to exercise.
// Local-emulation limits and the real-edge subset live in docs/testing.md.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { echoSaga, executionId } from "../src/domain";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > 15000) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function postExecutions(key: string, message = "lifecycle-probe") {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ sagaId: echoSaga.id, input: { message } }),
  });
}

function getExecution(id: string) {
  return new Request(`https://local.test/api/executions/${id}`, {
    headers: { Authorization: `Bearer ${"a".repeat(64)}` },
  });
}

useWorkflowHarness(bindings.DB, {
  setup: () => {
    // Gated vendor fetch: the echo step blocks until the test releases it,
    // so termination always lands mid-lifecycle, never by luck.
    const gate = deferred<Response>();
    (
      globalThis as unknown as { __vendorGate?: { promise: Promise<Response>; resolve: (r: Response) => void } }
    ).__vendorGate = gate;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "http://127.0.0.1:8788/echo") throw new Error("Unexpected outbound request");
      return gate.promise;
    });
  },
});

function releaseVendor(message = "lifecycle-probe") {
  const gate = (
    globalThis as unknown as { __vendorGate?: { promise: Promise<Response>; resolve: (r: Response) => void } }
  ).__vendorGate;
  gate?.resolve(Response.json({ message }));
}

it("terminating mid-lifecycle never reads as success and preserves diagnostics", async () => {
  const key = "lifecycle-terminate-001";
  const id = await executionId(principal, key);
  const tracked = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  const accepted = await worker.fetch(postExecutions(key), bindings);
  expect(accepted.status).toBe(202);
  // Vendor call in flight: the instance is provably mid-lifecycle.
  await waitFor(() => vi.mocked(fetch).mock.calls.length >= 1, "vendor call to start");
  await tracked.inner.waitForStatus("running");
  await (await bindings.ECHO_WORKFLOW.get(id)).terminate();
  await tracked.inner.waitForStatus("terminated");
  releaseVendor();

  const detail = await worker.fetch(getExecution(id), bindings);
  expect(detail.status).toBe(200);
  const body = (await detail.json()) as {
    status: string;
    runtimeStatus: string | null;
    result: unknown;
    operations: unknown[];
  };
  // The engine is dead; the D1 record must say so-adjacent, never Succeeded.
  expect(body.runtimeStatus).toBe("terminated");
  expect(body.status).not.toBe("Succeeded");
  expect(body.result).toBeNull();
  // Diagnostics survive: operation checkpoints stay inspectable for repro.
  expect(Array.isArray(body.operations)).toBe(true);
  expect(body.operations.length).toBeGreaterThan(0);
});

it("same-key resubmit after mid-flight death replays without redispatching vendor work", async () => {
  const key = "lifecycle-retry-001";
  const id = await executionId(principal, key);
  const tracked = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  const accepted = await worker.fetch(postExecutions(key), bindings);
  expect(accepted.status).toBe(202);
  await waitFor(() => vi.mocked(fetch).mock.calls.length >= 1, "vendor call to start");
  await tracked.inner.waitForStatus("running");
  await (await bindings.ECHO_WORKFLOW.get(id)).terminate();
  await tracked.inner.waitForStatus("terminated");

  const callsBefore = vi.mocked(fetch).mock.calls.length;
  const replay = await worker.fetch(postExecutions(key), bindings);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ executionId: id, replayed: true });
  // The dispatched marker holds: no second Workflow instance, no second
  // vendor call, even though the first instance died mid-flight.
  expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  releaseVendor();
});
