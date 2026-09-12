// SPDX-License-Identifier: AGPL-3.0
// Issue 75 (v0 acceptance): secretFields coverage for the echo Integration.
// The echo Integration declares no secrets, its resolved Connection carries
// no secret material, and echo API surfaces carry no secret-like text.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { ECHO_INTEGRATION_ID, echoSaga, executionId } from "../src/domain";
import { echoIntegrationDef } from "../src/integrations/index";
import { buildOrgCtx } from "../src/saga";
import { resolveConnection } from "../src/executions";
import type { ExecutionRow } from "../src/executions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const principal = { orgId, userId };
const key = "echo-secretcover-001";
const message = "hello-echo-coverage";
const auth = {
  Authorization: `Bearer ${"a".repeat(64)}`,
  "Content-Type": "application/json",
  "Idempotency-Key": key,
};

async function insertExecution(id: string): Promise<void> {
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      orgId,
      userId,
      JSON.stringify({ message }),
      1,
      "Pending",
      new Date().toISOString(),
    )
    .run();
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  // Intercept only outbound vendor HTTP. Native D1/Workflow bindings are never replaced.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://127.0.0.1:8788/echo") throw new Error("Unexpected outbound request");
    return Response.json({ message });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("declares empty secretFields for the echo Integration", () => {
  expect(echoIntegrationDef.secretFields).toEqual([]);
});

it("resolves an echo Connection with IDs plus endpoint only, no secret material", async () => {
  const id = "e".repeat(64);
  await insertExecution(id);
  const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
  if (!row) throw new Error("missing execution");
  const orgCtx = buildOrgCtx(row, "echo-http-v1");
  const resolved = await resolveConnection(bindings.DB, orgCtx, ECHO_INTEGRATION_ID, [ECHO_INTEGRATION_ID]);
  expect(resolved.found).toBe(true);
  if (!resolved.found) throw new Error("expected echo Connection");
  expect(Object.keys(resolved.connection).sort()).toEqual(
    ["displayName", "enabled", "endpoint", "id", "integrationId", "managedBy", "orgId"].sort(),
  );
  expect(resolved.connection).toMatchObject({
    integrationId: ECHO_INTEGRATION_ID,
    orgId,
    endpoint: "http://127.0.0.1:8788/echo",
  });
});

it("carries no secret-like material through echo API surfaces", async () => {
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  const accepted = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: { ...auth },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message } }),
    }),
    bindings,
  );
  expect(accepted.status).toBe(202);
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(
    new Request(`http://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } }),
    bindings,
  );
  expect(detail.status).toBe(200);
  const detailBody = await detail.json<{ status: string; result: { message: string } }>();
  expect(detailBody).toMatchObject({ status: "Succeeded", result: { message } });

  const sagas = await worker.fetch(
    new Request("http://local.test/api/sagas", { method: "GET", headers: { ...auth } }),
    bindings,
  );
  const history = await worker.fetch(
    new Request("http://local.test/api/executions", { method: "GET", headers: { ...auth } }),
    bindings,
  );
  const reread = await worker.fetch(
    new Request(`http://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } }),
    bindings,
  );
  for (const text of [await sagas.text(), await history.text(), await reread.text()]) {
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/token/i);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});
