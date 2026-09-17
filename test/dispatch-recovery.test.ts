// SPDX-License-Identifier: AGPL-3.0
// Dispatch-recovery regression (issue #250): the ambiguous dispatch window
// against the real local Workflow engine.
//
// Sequence on one Idempotency-Key: a fault-injected Workflow binding makes
// the first submit fail ambiguously, the retry on the real binding dispatches,
// and a third submit replays. Pins three contract points from ADR 001:
//
// 1. the failure answers the established 503 DISPATCH_UNCONFIRMED shape
//    (Retry-After: 5) and leaves the Pending receipt undispatched;
// 2. retrying the same key dispatches exactly once (one createBatch call)
//    and returns the canonical Execution receipt;
// 3. a third same-key submit is a pure replay: 200 replayed:true with no
//    additional Workflow dispatch and no additional vendor call.
//
// Technique: the first POST swaps only the ECHO_WORKFLOW binding for a
// throwing stub (the same fault-injection shape as
// test/execution-guards.test.ts); retries delegate createBatch to the real
// binding through a counting wrapper. The mocked vendor fetch counts
// outbound side effects, so exactly-once dispatch is observable end to end.
//
// Explicitly out of scope: pause/resume semantics and the hostile ambiguous
// provider (dependency #248). Local-emulation limits and the real-edge
// subset live in docs/testing.md.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { echoSaga, executionId } from "../src/domain";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN = "a".repeat(64);
const KEY = "dispatch-recovery-001";
const MESSAGE = "dispatch-recovery-probe";

function postExecutions(key: string) {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ sagaId: echoSaga.id, input: { message: MESSAGE } }),
  });
}

function getExecution(id: string) {
  return new Request(`https://local.test/api/executions/${id}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

useWorkflowHarness(bindings.DB, {
  setup: () => {
    // Intercept only outbound vendor HTTP. Native D1/Workflow bindings are never replaced.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "http://127.0.0.1:8788/echo") throw new Error("Unexpected outbound request");
      return Response.json({ message: MESSAGE });
    });
  },
});

it("recovers an ambiguous dispatch on the same key: 503, then one dispatch, then pure replay", async () => {
  const id = await executionId(principal, KEY);

  // 1. Ambiguous failure: the established 503 shape, receipt left Pending.
  const failing = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async () => {
        throw new Error("control plane down");
      },
    },
  } as unknown as Bindings;
  const unconfirmed = await worker.fetch(postExecutions(KEY), failing);
  expect(unconfirmed.status).toBe(503);
  expect(unconfirmed.headers.get("Retry-After")).toBe("5");
  expect(await unconfirmed.json()).toMatchObject({ error: { code: "DISPATCH_UNCONFIRMED" } });
  // No dispatch means no vendor work.
  expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  const pending = await worker.fetch(getExecution(id), bindings);
  expect(pending.status).toBe(200);
  expect(await pending.json()).toMatchObject({
    executionId: id,
    status: "Pending",
    dispatchConfirmed: false,
    result: null,
  });

  // 2. Same-key retry dispatches exactly once and returns the canonical
  // receipt. The key was seen before (the unconfirmed reservation), so the
  // established idempotency rule answers 200 replayed:true with the same
  // Execution identity; the single createBatch call below proves this retry
  // performed the one and only dispatch.
  const tracked = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  const realEcho = bindings.ECHO_WORKFLOW;
  let createBatchCalls = 0;
  const retryEnv = {
    ...bindings,
    ECHO_WORKFLOW: {
      createBatch: async (batch: Parameters<typeof realEcho.createBatch>[0]) => {
        createBatchCalls += 1;
        return realEcho.createBatch(batch);
      },
    },
  } as unknown as Bindings;
  const retry = await worker.fetch(postExecutions(KEY), retryEnv);
  expect(retry.status).toBe(200);
  expect(retry.headers.get("Location")).toBe(`/api/executions/${id}`);
  expect(await retry.json()).toMatchObject({
    executionId: id,
    replayed: true,
    statusUrl: `/api/executions/${id}`,
  });
  expect(createBatchCalls).toBe(1);
  await tracked.inner.waitForStatus("complete");
  const done = await worker.fetch(getExecution(id), bindings);
  expect(await done.json()).toMatchObject({
    executionId: id,
    status: "Succeeded",
    result: { message: MESSAGE },
    operations: [
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "echo-http-v1", status: "Succeeded" },
    ],
  });
  expect(vi.mocked(fetch).mock.calls.length).toBe(1);

  // 3. Third same-key submit is a pure replay: no new dispatch, no new vendor call.
  const replay = await worker.fetch(postExecutions(KEY), retryEnv);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    executionId: id,
    replayed: true,
    statusUrl: `/api/executions/${id}`,
  });
  expect(createBatchCalls).toBe(1);
  expect(vi.mocked(fetch).mock.calls.length).toBe(1);

  // Organization isolation holds on the recovered receipt: a foreign
  // Organization learns nothing and triggers no dispatch.
  const foreign = await worker.fetch(getExecution(id), {
    ...bindings,
    LAB_ORG_ID: "00000000-0000-4000-8000-000000000004",
  });
  expect(foreign.status).toBe(404);
  expect(createBatchCalls).toBe(1);
  expect(vi.mocked(fetch).mock.calls.length).toBe(1);
});
