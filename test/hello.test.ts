// SPDX-License-Identifier: AGPL-3.0
// Migration pilot (issue #119): workspace `workflows/sample/hello_world.py`
// re-authored as the hello Saga, exercised end to end on the real local
// runtime. No vendor boundary exists, so any outbound fetch is a failure.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga } from "../src/domain";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "hello-pilot-test-001";
function request(
  path: string,
  method = "GET",
  sagaId: string = helloSaga.id,
  body: unknown = { name: "Ada" },
  idempotencyKey = key,
) {
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
useWorkflowHarness(bindings.DB, {
  setup: () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("hello must not fetch");
    });
  },
});
it("runs the hello pilot end to end: prepare, pure greet, persisted success", async () => {
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.HELLO_WORKFLOW, id);
  const listed = await worker.fetch(request("/api/sagas"), bindings);
  expect(await listed.json()).toMatchObject({
    sagas: expect.arrayContaining([expect.objectContaining({ name: "hello" })]),
  });
  const accepted = await worker.fetch(request("/api/executions", "POST"), bindings);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
  expect(await accepted.json()).toMatchObject({ executionId: id, replayed: false });
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(request(`/api/executions/${id}`), bindings);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    status: "Succeeded",
    result: { greeting: "Hello, Ada!", name: "Ada" },
    operations: [
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "greet-v1", status: "Succeeded" },
    ],
  });
  expect(fetch).not.toHaveBeenCalled();
  // History proof (#119 exit): the completed pilot run is visible through
  // the standard sagaId-filtered history query with its registered ID.
  const history = await worker.fetch(request(`/api/executions?sagaId=${helloSaga.id}`), bindings);
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({
    executions: expect.arrayContaining([expect.objectContaining({ executionId: id, status: "Succeeded" })]),
  });
});
it("rejects empty and non-string hello names", async () => {
  for (const [body, k] of [
    [{ name: "" }, "hello-pilot-bad-001"],
    [{ name: 7 }, "hello-pilot-bad-002"],
    [{ nickname: "Ada" }, "hello-pilot-bad-003"],
  ] as const) {
    const res = await worker.fetch(request("/api/executions", "POST", helloSaga.id, body, k), bindings);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  }
});
