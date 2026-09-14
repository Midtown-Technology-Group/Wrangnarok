// SPDX-License-Identifier: AGPL-3.0
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId, SMOKE_ORG_ID, SMOKE_USER_ID, smokeSaga } from "../src/domain";
import { USAGE_VERSION } from "../src/usage";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
const bindings = env as unknown as Bindings;
// Per-run Free-tier budgets (docs/upstream-spec.md#free-tier-rule-measurable).
// The smoke path is deterministic, so budgets sit close to observed actuals
// (reads 4, writes 8, rows 4, steps 4, instances 1): any growth trips the
// gate and forces a deliberate bump with its reason recorded. These pin the
// saga's self-reported counters, not Cloudflare metered billing — deployed
// metering is still required before claiming production accuracy.
const FREE_TIER_PER_RUN_BUDGETS = {
  d1Reads: 10,
  d1Writes: 20,
  d1OperationRows: 10,
  workflowInstances: 1,
  workflowSteps: 10,
} as const;
// Disposable smoke Organization per ADR 004: never production tenant data.
const smokePrincipal = { orgId: SMOKE_ORG_ID, userId: SMOKE_USER_ID };
const smokeBindings = { ...bindings, LAB_ORG_ID: SMOKE_ORG_ID, LAB_USER_ID: SMOKE_USER_ID };
const key = "system-smoke-test-001";
function smokeRequest(
  path: string,
  method = "GET",
  sagaId: string = smokeSaga.id,
  body: unknown = {},
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
  // The smoke org row is org-specific (not in the shared seed); the fetch
  // guard stays: system.smoke has no vendor boundary, so any outbound fetch
  // is a failure.
  seed: false,
  setup: async () => {
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind(SMOKE_ORG_ID, "org_system_smoke")
      .run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("system.smoke must not fetch");
    });
  },
});
it("runs the loopback-free system.smoke saga end to end with a usage block", async () => {
  const id = await executionId(smokePrincipal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.SMOKE_WORKFLOW, id);
  const logs: unknown[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  try {
    const listed = await worker.fetch(smokeRequest("/api/sagas"), smokeBindings);
    expect(await listed.json()).toMatchObject({
      sagas: expect.arrayContaining([expect.objectContaining({ name: "system.smoke" })]),
    });
    const accepted = await worker.fetch(smokeRequest("/api/executions", "POST"), smokeBindings);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
    expect(await accepted.json()).toMatchObject({ executionId: id, replayed: false });
    await instance.waitForStatus("complete");
    const detail = await worker.fetch(smokeRequest(`/api/executions/${id}`), smokeBindings);
    const body = (await detail.json()) as {
      executionId: string;
      status: string;
      runtimeStatus: string | null;
      result: { d1WriteOk: boolean; d1ReadOk: boolean; operationCount: number; operations: string[] };
      operations: { name: string; status: string }[];
    };
    expect(body).toMatchObject({
      executionId: id,
      status: "Succeeded",
      result: { d1WriteOk: true, d1ReadOk: true },
      operations: [
        { name: "prepare-input-v1", status: "Succeeded" },
        { name: "smoke-write-v1", status: "Succeeded" },
        { name: "smoke-verify-v1", status: "Succeeded" },
      ],
    });
    expect(body.result.operations).toEqual(
      expect.arrayContaining(["prepare-input-v1", "smoke-write-v1", "smoke-verify-v1"]),
    );
    // Machine-readable usage block: console emission + persisted record, no secrets.
    const usageLine = logs.find((line) => typeof line === "string" && line.startsWith("WRANGNAROK_USAGE "));
    expect(usageLine).toBeDefined();
    const usage = JSON.parse((usageLine as string).replace("WRANGNAROK_USAGE ", "")) as Record<string, unknown>;
    expect(usage).toMatchObject({
      version: USAGE_VERSION,
      saga: "system.smoke",
      executionId: id,
      orgId: SMOKE_ORG_ID,
      workflows: { instancesStarted: 1, stepsExecuted: 4 },
    });
    // Free-tier habit: the run must fit its per-run budgets (see above).
    const d1 = usage.d1 as { operationRows: number; reads: number; writes: number };
    const workflows = usage.workflows as { instancesStarted: number; stepsExecuted: number };
    expect(d1.reads).toBeLessThanOrEqual(FREE_TIER_PER_RUN_BUDGETS.d1Reads);
    expect(d1.writes).toBeLessThanOrEqual(FREE_TIER_PER_RUN_BUDGETS.d1Writes);
    expect(d1.operationRows).toBeLessThanOrEqual(FREE_TIER_PER_RUN_BUDGETS.d1OperationRows);
    expect(workflows.instancesStarted).toBe(FREE_TIER_PER_RUN_BUDGETS.workflowInstances);
    expect(workflows.stepsExecuted).toBeLessThanOrEqual(FREE_TIER_PER_RUN_BUDGETS.workflowSteps);
    const stored = await bindings.DB.prepare("SELECT usage_json FROM usage_blocks WHERE execution_id=?")
      .bind(id)
      .first<{ usage_json: string }>();
    expect(stored).not.toBeNull();
    const storedJson = JSON.stringify(JSON.parse(stored?.usage_json ?? "{}"));
    expect(storedJson).toContain(USAGE_VERSION);
    expect(storedJson).toContain(id);
    expect(storedJson).not.toContain("a".repeat(64));
    // Duplicate submit replays; cross-saga same-key conflicts; foreign owners get 404.
    const replay = await worker.fetch(smokeRequest("/api/executions", "POST"), smokeBindings);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ executionId: id, replayed: true });
    const conflict = await worker.fetch(
      smokeRequest("/api/executions", "POST", echoSaga.id, { message: "hello" }),
      smokeBindings,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(
      (
        await worker.fetch(smokeRequest(`/api/executions/${id}`), {
          ...smokeBindings,
          LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
        })
      ).status,
    ).toBe(404);
    // History stays summary-only.
    const history = await worker.fetch(smokeRequest("/api/executions"), smokeBindings);
    const text = await history.text();
    expect(text).not.toContain('"input"');
    expect(text).not.toContain('"result"');
  } finally {
    console.log = originalLog;
  }
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects non-empty system.smoke input", async () => {
  const res = await worker.fetch(
    smokeRequest("/api/executions", "POST", smokeSaga.id, { probe: "x" }, "system-smoke-bad-001"),
    smokeBindings,
  );
  expect(res.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
