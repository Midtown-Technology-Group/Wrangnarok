// SPDX-License-Identifier: AGPL-3.0
// Phase 2 timeout-sweeper investigation (issue #76, ADR 001): Wrangnarök
// runs NO sweeper — no Cron trigger, no background job, no reconciler ever
// writes TimedOut. A stuck Running Execution stays Running until its vendor
// responds, its Workflow step times out on its own terms, or its owner
// cancels it. Expiry of native Workflow history surfaces as unavailable,
// never as an inferred terminal state. All gates run in real workerd with
// real D1/Workflow bindings; only outbound vendor HTTP is mocked.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
import wranglerConfig from "../wrangler.jsonc?raw";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "timeout-sweeper-001";
const auth = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };
function submitRequest() {
  return new Request("http://local.test/api/executions", {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": key },
    body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "stuck" } }),
  });
}
function detailRequest(id: string) {
  return new Request(`http://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } });
}
async function observedStatus(id: string): Promise<string> {
  const body = (await (await worker.fetch(detailRequest(id), bindings)).json()) as { status: string };
  return body.status;
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
it("permits only the TRG-01 promotion tick as a Cron trigger", () => {
  // Tripwire (updated TRG-01, issue #137, ADR 012): the minute Cron tick is
  // earned for due-schedule promotion only. The tick promotes due rows
  // through the submit protocol — it never sweeps Pending, never writes
  // TimedOut, and never resurrects cancelled windows. Any second schedule
  // or non-promotion Cron use needs its own ADR per AGENTS.md constraint 7.
  const crons = [...wranglerConfig.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
  );
  expect(crons).toEqual(["* * * * *"]);
});
it("leaves a stuck Running execution alone until its owner cancels it", async () => {
  const id = await executionId(principal, key);
  // Never-settling vendor: the step stays Running past every observation.
  // (The native 10s step timeout is longer than the whole observation
  // window, so nothing but our cancel can move this Execution.)
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
  expect((await worker.fetch(submitRequest(), bindings)).status).toBe(202);
  // Wait for the run to start, then observe: no sweeper may infer
  // TimedOut or Failed while the vendor is silent.
  const start = Date.now();
  while ((await observedStatus(id)) === "Pending" && Date.now() - start < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await observedStatus(id)).toBe("Running");
  for (let probe = 0; probe < 5; probe += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await observedStatus(id)).toBe("Running");
  }
  const detail = (await (await worker.fetch(detailRequest(id), bindings)).json()) as {
    status: string;
    runtimeStatus: string | null;
    operations: { name: string; status: string }[];
  };
  expect(detail.operations.map((op) => ({ name: op.name, status: op.status }))).toContainEqual({
    name: "echo-http-v1",
    status: "Running",
  });
  expect(detail.runtimeStatus).not.toBe("complete");
  // The owner's cancel is the only exit a stuck run needs.
  const cancelled = await worker.fetch(
    new Request(`http://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } }),
    bindings,
  );
  expect(cancelled.status).toBe(200);
  expect(await observedStatus(id)).toBe("Cancelled");
}, 25000);
