// SPDX-License-Identifier: AGPL-3.0
// Phase 1b (ADR 010): OrgCtx construction, Connection resolution contract,
// owner-cancel-wins over racing terminal checkpoints, plus the
// source/persisted boundary checks. Runs in real workerd with a real D1
// binding; drives the terminal checkpoints directly so both race orders are
// deterministic (no timing).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, ECHO_INTEGRATION_ID, NINJA_INTEGRATION_ID } from "../src/domain";
import { buildOrgCtx, withOperation } from "../src/saga";
import { beginOperation, cancelExecution, failExecution, finishOperation, resolveConnection } from "../src/executions";
import type { ExecutionRow } from "../src/executions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const auth = { Authorization: `Bearer ${"a".repeat(64)}` };

async function insertExecution(id: string, status: string): Promise<void> {
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
      JSON.stringify({ message: "hello" }),
      1,
      status,
      new Date().toISOString(),
    )
    .run();
}

async function statusOf(id: string): Promise<string> {
  const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
    .bind(id)
    .first<{ status: string }>();
  if (!row) throw new Error(`missing execution ${id}`);
  return row.status;
}

async function operationOf(id: string, name: string) {
  const row = await bindings.DB.prepare(
    "SELECT status,result_json,error_json FROM operations WHERE execution_id=? AND name=?",
  )
    .bind(id, name)
    .first<{ status: string; result_json: string | null; error_json: string | null }>();
  if (!row) throw new Error(`missing operation ${name} for ${id}`);
  return row;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  await reset();
});

it("builds OrgCtx from the D1 row, never from caller input", async () => {
  const id = "c".repeat(64);
  await insertExecution(id, "Pending");
  const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
  if (!row) throw new Error("missing execution");
  const ctx = buildOrgCtx(row, "prepare-input-v1");
  expect(ctx).toMatchObject({
    orgId,
    userId,
    executionId: id,
    sagaId: echoSaga.id,
    sagaRevision: echoSaga.revision,
    operationId: "prepare-input-v1",
    attemptToken: `${id}:1`,
  });
});

it("resolves the exact-org Connection through the OrgCtx", async () => {
  const id = "f".repeat(64);
  await insertExecution(id, "Pending");
  const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
  if (!row) throw new Error("missing execution");
  const org = buildOrgCtx(row, "echo-http-v1");
  const resolved = await resolveConnection(bindings.DB, org, ECHO_INTEGRATION_ID, [ECHO_INTEGRATION_ID]);
  expect(resolved).toMatchObject({ found: true });
  // ADR 003 split: the hit is a typed Connection (stable IDs plus
  // non-secret config) — never bare endpoint text, never credentials.
  if (resolved.found) {
    expect(resolved.connection).toMatchObject({
      integrationId: ECHO_INTEGRATION_ID,
      orgId,
      endpoint: "http://127.0.0.1:8788/echo",
    });
    expect(typeof resolved.connection.id).toBe("string");
  }
});

it("fails loud on declared-but-missing and returns None on undeclared", async () => {
  const id = "a".repeat(64);
  await insertExecution(id, "Pending");
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(orgId).run();
  const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
  if (!row) throw new Error("missing execution");
  const org = buildOrgCtx(row, "echo-http-v1");
  const loud = await resolveConnection(bindings.DB, org, ECHO_INTEGRATION_ID, [ECHO_INTEGRATION_ID]);
  expect(loud).toMatchObject({
    found: false,
    declared: true,
    error: { code: "INTEGRATION_REQUIREMENT_UNSATISFIED" },
  });
  // Optional (undeclared) access resolves to None: no throw, no error row —
  // the Saga decides its own fallback/skip.
  const silent = await resolveConnection(bindings.DB, org, NINJA_INTEGRATION_ID, []);
  expect(silent).toEqual({ found: false, declared: false });
});

it("keeps Execution history readable after a Saga source rename", async () => {
  // Saga behavior always comes from source; the D1 row mirrors the
  // saga_id/name/revision snapshot for diagnosis. Renaming source must never
  // erase or hide history.
  const id = "b".repeat(64);
  await insertExecution(id, "Succeeded");
  await bindings.DB.prepare("UPDATE executions SET saga_name=?,saga_revision=? WHERE id=?")
    .bind("echo-renamed", "echo-v2", id)
    .run();
  const detail = await worker.fetch(
    new Request(`https://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } }),
    bindings,
  );
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    sagaId: echoSaga.id,
    sagaName: "echo-renamed",
    sagaRevision: "echo-v2",
    status: "Succeeded",
  });
});

it("applies the local seed idempotently", async () => {
  // Fresh-checkout setup: setup-local.mjs never overwrites .dev.vars
  // (flag wx) and the seed is ON CONFLICT DO NOTHING. Re-applying changes
  // nothing.
  await bindings.DB.exec(seed);
  const orgs = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM organizations WHERE id=?")
    .bind(orgId)
    .first<{ n: number }>();
  const conns = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM connections WHERE org_id=?")
    .bind(orgId)
    .first<{ n: number }>();
  expect(orgs?.n).toBe(1);
  expect(conns?.n).toBe(1);
});

it("lets an owner-requested cancel win over a racing terminal checkpoint", async () => {
  // ADR 001: once the Cancelling marker is written, the checkpoint is the
  // stale one — it no-ops, and the cancel marker lands Cancelled. An
  // acknowledged cancellation is never flipped to Failed afterward.
  const id = "d".repeat(64);
  await insertExecution(id, "Cancelling");
  await failExecution(bindings.DB, id, { code: "ECHO_INTEGRATION_FAILED", message: "lost race" });
  expect(await statusOf(id)).toBe("Cancelling");
  await cancelExecution(bindings.DB, id);
  expect(await statusOf(id)).toBe("Cancelled");
});

it("keeps Cancelled against a late terminal checkpoint", async () => {
  const id = "e".repeat(64);
  await insertExecution(id, "Cancelling");
  await cancelExecution(bindings.DB, id);
  expect(await statusOf(id)).toBe("Cancelled");
  // Late checkpoint after cancellation matches no row: no overwrite.
  await failExecution(bindings.DB, id, { code: "ECHO_INTEGRATION_FAILED", message: "late" });
  expect(await statusOf(id)).toBe("Cancelled");
});

it("narrows an OrgCtx to the step doing the work", async () => {
  const id = "b".repeat(64);
  await insertExecution(id, "Pending");
  const row = await bindings.DB.prepare("SELECT * FROM executions WHERE id=?").bind(id).first<ExecutionRow>();
  if (!row) throw new Error("missing execution");
  const stepOrg = withOperation(buildOrgCtx(row, "prepare-input-v1"), "echo-http-v1");
  expect(stepOrg.operationId).toBe("echo-http-v1");
  expect(stepOrg).toMatchObject({ orgId, userId, executionId: id, attemptToken: `${id}:1` });
});

it("never lets a late finish overwrite terminal Operation history", async () => {
  const id = "1".repeat(64);
  await insertExecution(id, "Pending");
  await beginOperation(bindings.DB, id, "echo-http-v1", 1);
  await failExecution(bindings.DB, id, { code: "ECHO_INTEGRATION_FAILED", message: "first" });
  expect((await operationOf(id, "echo-http-v1")).status).toBe("Failed");
  // A still-running vendor callback completes late: the fenced finish
  // matches no Running row and no-ops instead of inventing success.
  await finishOperation(bindings.DB, id, "echo-http-v1", { message: "late" });
  const op = await operationOf(id, "echo-http-v1");
  expect(op.status).toBe("Failed");
  expect(op.result_json).toBeNull();
  expect(JSON.parse(op.error_json as string)).toMatchObject({ code: "ECHO_INTEGRATION_FAILED" });
  // Re-begin after terminal is equally fenced: history is never resurrected.
  await beginOperation(bindings.DB, id, "echo-http-v1", 1);
  expect((await operationOf(id, "echo-http-v1")).status).toBe("Failed");
});

it("resets a Running Operation row on step retry", async () => {
  const id = "2".repeat(64);
  await insertExecution(id, "Pending");
  await beginOperation(bindings.DB, id, "prepare-input-v1", 0);
  await beginOperation(bindings.DB, id, "prepare-input-v1", 0);
  expect((await operationOf(id, "prepare-input-v1")).status).toBe("Running");
  await finishOperation(bindings.DB, id, "prepare-input-v1", { message: "hello" });
  expect(await operationOf(id, "prepare-input-v1")).toMatchObject({ status: "Succeeded" });
});
