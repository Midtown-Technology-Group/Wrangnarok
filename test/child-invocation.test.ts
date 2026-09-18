// SPDX-License-Identifier: AGPL-3.0
// RUN-02 (issue #136, ADR 018): nested Saga invocation against real local
// bindings. A hello-parent Execution dispatches a hello child through the
// durable child handle, awaits its typed JSON output, and serves inspectable
// lineage. Child failure is actionable (CHILD_FAILED) and can never become
// fabricated parent success. Rejections (unknown child, non-serializable
// input, self-invoke, foreign-org receipts, corrupt results), duplicate
// dispatch convergence, parent-cancel fan-out, and child timeout all run in
// real workerd with real D1/Workflow bindings; nothing here uses unit
// doubles for the runtime.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import {
  awaitChildResult,
  bindSagaChildren,
  cancelDirectChildren,
  childDispatchKey,
  childDispatchStep,
  childExecutionId,
  childPollStep,
  childTerminalOf,
  invokeChild,
  isMissingLineageColumn,
  resolveChildSaga,
} from "../src/children";
import type { ChildEnv } from "../src/children";
import { storeSagaPolicy } from "../src/executions";
import { addGrant, assignRole, createRole } from "../src/roles";
import { executionId, Fault, helloParentSaga, helloSaga } from "../src/domain";
import { parseHelloParentInput } from "../src/domain";
import { bindSagaStep } from "../src/saga";
import type { OrgCtx } from "../src/saga";
import type { SagaEventContext, SagaStep } from "../src/saga";
import { helloParentSagaDef } from "../src/sagas/hello-parent";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const auth = { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" };

function submitRequest(key: string, sagaId: string, body: unknown) {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": key },
    body: JSON.stringify({ sagaId, input: body }),
  });
}

function detailRequest(id: string) {
  return new Request(`https://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } });
}

function cancelRequest(id: string) {
  return new Request(`https://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } });
}

/** Seed AUTH-02 authority for one caller: org + user + membership rows.
 * Fixture callers default to the admin bypass (mirrors ensureLabFixture);
 * pass explicit role/status/userId for the denied-caller matrix. */
async function seedAuthority(
  userId: string = principal.userId,
  orgId: string = principal.orgId,
  role = "admin",
  status = "active",
) {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, "Seed org")
    .run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(userId, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(orgId, userId, role, status, "ordinary", stamp, stamp)
    .run();
}

/** Direct saga execute grant for one caller (the policy-rule path). */
async function seedExecuteGrant(orgId: string, sagaId: string, userId: string) {
  await bindings.DB.prepare(
    "INSERT INTO policy_rules(id,org_id,resource_kind,resource_id,action,subject_type,subject_ref,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), orgId, "saga", sagaId.toLowerCase(), "execute", "user", userId, new Date().toISOString())
    .run();
}

async function detail(id: string) {
  const response = await worker.fetch(detailRequest(id), bindings);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    executionId: string;
    status: string;
    result: { greeting: string; name: string; childExecutionId: string } | null;
    error: { code: string; message: string } | null;
    parentExecutionId: string | null;
    parentStep: string | null;
    children: { executionId: string; sagaId: string; sagaName: string; status: string }[];
    operations: { name: string; status: string }[];
  };
}

useWorkflowHarness(bindings.DB);

describe("RUN-02 nested invocation (issue #136)", () => {
  it("runs a parent invoking an authorized child with typed I/O and inspectable lineage", async () => {
    const key = "run02-parent-happy-001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.HELLO_PARENT_WORKFLOW, id);
    expect((await worker.fetch(submitRequest(key, helloParentSaga.id, { name: "Ada" }), bindings)).status).toBe(202);
    await instance.waitForStatus("complete");
    const parent = await detail(id);
    expect(parent.status).toBe("Succeeded");
    expect(parent.result).toMatchObject({ greeting: "Hello, Ada!", name: "Ada" });
    expect(parent.result?.childExecutionId).toMatch(/^[a-f0-9]{64}$/);
    expect(parent.parentExecutionId).toBeNull();
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toMatchObject({ executionId: parent.result?.childExecutionId, sagaName: "hello" });
    expect(parent.operations.map((op) => op.name)).toEqual(
      expect.arrayContaining(["prepare-input-v1", "child-dispatch-invoke-v1", "child-await-invoke-v1"]),
    );
    // The child side carries the parent lineage and the same typed output.
    const child = await detail(parent.result?.childExecutionId as string);
    expect(child.status).toBe("Succeeded");
    expect(child.parentExecutionId).toBe(id);
    expect(child.parentStep).toBe("child-dispatch-invoke-v1");
    expect(child.result).toMatchObject({ greeting: "Hello, Ada!", name: "Ada" });
  }, 25000);

  it("fails the parent actionably when the child input is invalid, never inventing success", async () => {
    // Empty child name: the child prepare rejects, the parent persists
    // CHILD_FAILED with the child code, and no greeting is fabricated.
    const key = "run02-parent-childfail-001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.HELLO_PARENT_WORKFLOW, id);
    expect((await worker.fetch(submitRequest(key, helloParentSaga.id, { name: "" }), bindings)).status).toBe(400);
    expect(instance).toBeDefined();
    // Direct proof at the row level: reserve a parent/child pair and drive
    // the child to Failed, then read the parent-visible outcome.
    const parentId = "a1".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const childId = "b2".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: 7 }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Failed",
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ code: "EXECUTION_FAILED", message: "nope" }),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: childId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${childId}` },
      ),
    ).rejects.toMatchObject({ code: "CHILD_FAILED" });
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unknown children, non-serializable input, self-invocation, and bad keys before any write", async () => {
    // Seeded admin authority: every rejection below is the validation code,
    // never an auth code, and no dispatch row is reserved.
    await seedAuthority();
    const parentId = "c3".repeat(32);
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: {
        sagas: [
          { ...helloSaga, parse: (v: unknown) => v },
          { ...helloParentSaga, parse: (v: unknown) => v },
        ],
      },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", "no-such-saga", { name: "Ada" }),
    ).rejects.toMatchObject({
      code: "CHILD_SAGA_NOT_FOUND",
    });
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { run: () => 1 }),
    ).rejects.toMatchObject({ code: "CHILD_INPUT_NOT_SERIALIZABLE" });
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloParentSaga.id, { name: "Ada" }),
    ).rejects.toMatchObject({ code: "CHILD_SELF_INVOKE" });
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }, { key: "bad key!" }),
    ).rejects.toMatchObject({ code: "CHILD_KEY_INVALID" });
    await expect(
      invokeChild({ ...childEnv, parentExecutionId: "nope" }, "child-dispatch-invoke-v1", helloSaga.id, {
        name: "Ada",
      }),
    ).rejects.toMatchObject({ code: "CHILD_PARENT_INVALID" });
    // No rows were reserved by any rejected dispatch.
    const count = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a foreign-org child receipt and corrupt child results", async () => {
    const childId = "d4".repeat(32);
    await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING")
      .bind("00000000-0000-4000-8000-000000000009", "Foreign org probe")
      .run();
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        "00000000-0000-4000-8000-000000000009",
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        "f".repeat(64),
        "child-dispatch-invoke-v1",
        1,
        "Succeeded",
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ greeting: "Hello, Ada!", name: "Ada" }),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: "e5".repeat(32),
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: "e5".repeat(32).concat(":0"),
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: "e5".repeat(32),
      parentSagaId: helloParentSaga.id,
    };
    // Foreign-org receipt: the org-scoped read 404s, failing closed.
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: childId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${childId}` },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    // Corrupt Succeeded row: invalid JSON is CHILD_RESULT_CORRUPT, never success.
    const corruptId = "1a".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        corruptId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        "e5".repeat(32),
        "child-dispatch-invoke-v1",
        1,
        "Succeeded",
        new Date().toISOString(),
        new Date().toISOString(),
        "{not-json",
      )
      .run();
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: corruptId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${corruptId}` },
      ),
    ).rejects.toMatchObject({ code: "CHILD_RESULT_CORRUPT" });
  });

  it("converges duplicate child dispatches on one child row", async () => {
    await seedAuthority();
    const parentId = "2b".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const live = {
      ...bindings,
      HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: live,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    const first = await invokeChild(
      childEnv,
      "child-dispatch-invoke-v1",
      helloSaga.id,
      { name: "Ada" },
      { key: "sib" },
    );
    const second = await invokeChild(
      childEnv,
      "child-dispatch-invoke-v1",
      helloSaga.id,
      { name: "Ada" },
      { key: "sib" },
    );
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions WHERE parent_execution_id=?")
      .bind(parentId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // Same key with different input conflicts loudly instead of forking.
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Bo" }, { key: "sib" }),
    ).rejects.toMatchObject({ code: "CHILD_DISPATCH_CONFLICT" });
  });

  it("fences child dispatch on RUN-01 admission exactly like top-level submit (issue #136)", async () => {
    // Pause the child Saga: child dispatch must refuse with SAGA_PAUSED
    // through the shared admitExecution gate, never dispatch the Workflow.
    await seedAuthority();
    await storeSagaPolicy(bindings.DB, principal.orgId, helloSaga.id, { admission: { enabled: false } });
    const parentId = "4d".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    let created = 0;
    const live = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {
          created += 1;
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: live,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }, { key: "adm" }),
    ).rejects.toMatchObject({ code: "SAGA_PAUSED" });
    expect(created).toBe(0);
    // Resume: the same key dispatches exactly once through the same gate.
    await storeSagaPolicy(bindings.DB, principal.orgId, helloSaga.id, { admission: { enabled: true } });
    const receipt = await invokeChild(
      childEnv,
      "child-dispatch-invoke-v1",
      helloSaga.id,
      { name: "Ada" },
      { key: "adm" },
    );
    expect(receipt.replayed).toBe(false);
    expect(created).toBe(1);
  });

  it("maps dispatch ambiguity to CHILD_DISPATCH_UNCONFIRMED with the reservation intact", async () => {
    await seedAuthority();
    const parentId = "3c".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const flaky = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {
          throw new Error("control plane unavailable");
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: flaky,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    const failure = await invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "CHILD_DISPATCH_UNCONFIRMED" });
    // The reservation stays Pending and undispatched: retry-safe, never invented.
    const childId = await childExecutionId(
      { orgId: principal.orgId, userId: principal.userId },
      parentId,
      "child-dispatch-invoke-v1",
      helloSaga.id,
      "default",
    );
    const row = await bindings.DB.prepare("SELECT status,dispatched FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string; dispatched: number }>();
    expect(row).toMatchObject({ status: "Pending", dispatched: 0 });
  });

  it("fans out parent cancellation to a reserved child without resurrecting it", async () => {
    // Deterministic parent-cancel route coverage: seed an undispatched
    // Pending parent with an undispatched Pending child. The parent cancel
    // takes the vacuous-stop branch (no native instance, never dispatched),
    // the fan-out runs, the child confirms Cancelled through the same
    // branch, and the parent confirms. The row-count assertion pins the
    // fan-out path: with zero children this test fails instead of passing
    // vacuously, and without the fan-out call the child would stay Pending.
    const parentId = "e5".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        0,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const childId = "f6".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        0,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const cancelled = await worker.fetch(cancelRequest(parentId), bindings);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ executionId: parentId, status: "Cancelled", cancelled: true });
    expect((await detail(parentId)).status).toBe("Cancelled");
    const kids = await bindings.DB.prepare("SELECT id,status FROM executions WHERE parent_execution_id=?")
      .bind(parentId)
      .all<{ id: string; status: string }>();
    // Non-vacuous: exactly our seeded child, now Cancelled, with lineage.
    expect(kids.results).toHaveLength(1);
    expect(kids.results[0]).toMatchObject({ id: childId, status: "Cancelled" });
    expect((await detail(childId)).parentExecutionId).toBe(parentId);
  }, 25000);

  it("leaves an ambiguous child active and the parent confirmation intact", async () => {
    // A dispatched child whose native instance vanished: fan-out rolls it
    // back to Running, the parent still confirms, and the child stays
    // inspectable for its true terminal.
    const parentId = "4d".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const childId = "5e".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const live = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => {
          throw new Error("instance.not_found");
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const confirmed = await cancelDirectChildren(live, principal, parentId);
    expect(confirmed).toEqual([]);
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string }>();
    expect(row?.status).toBe("Running");
  });

  it("confirms fan-out for a Pending child whose instance never existed", async () => {
    // Vacuous stop (same rule as the parent route): an undispatched Pending
    // child confirms outright through cancelDirectChildren.
    const parentId = "aa".repeat(32);
    const childId = "bb".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        0,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const live = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => {
          throw new Error("instance.not_found");
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    await expect(cancelDirectChildren(live, principal, parentId)).resolves.toEqual([childId]);
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string }>();
    expect(row?.status).toBe("Cancelled");
  });

  it("times out the await while the child keeps running", async () => {
    const parentId = "6f".repeat(32);
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const childId = "7a".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    let sleeps = 0;
    // Deterministic deadline: freeze the clock so the 1ms budget expires
    // before the first D1 read returns, never depending on two Date.now()
    // calls landing in different milliseconds.
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValueOnce(1_000).mockReturnValue(1_002);
      const failure = await awaitChildResult(
        childEnv,
        {
          sleep: async () => {
            sleeps += 1;
          },
        },
        { executionId: childId, sagaId: helloSaga.id, replayed: false, statusUrl: `/api/executions/${childId}` },
        { awaitTimeoutMs: 1 },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "CHILD_AWAIT_TIMEOUT" });
      expect(sleeps).toBe(0);
    } finally {
      now.mockRestore();
    }
    // The child keeps running: the timeout stopped the wait, not the work.
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string }>();
    expect(row?.status).toBe("Running");
  });

  it("validates await receipts and timeout bounds before any read", async () => {
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: "8b".repeat(32),
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${"8b".repeat(32)}:0`,
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: "8b".repeat(32),
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: "nope", sagaId: helloSaga.id, replayed: false, statusUrl: "/x" },
      ),
    ).rejects.toMatchObject({ code: "CHILD_RECEIPT_INVALID" });
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: "9c".repeat(32), sagaId: helloSaga.id, replayed: false, statusUrl: "/x" },
        { awaitTimeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "CHILD_AWAIT_INVALID" });
  });
});

describe("RUN-02 child authorization (AUTH-02, issue #136)", () => {
  const OPERATOR = "00000000-0000-4000-8000-000000000011";
  const STRANGER = "00000000-0000-4000-8000-000000000012";
  const REVOKED = "00000000-0000-4000-8000-000000000013";
  const VIEWER = "00000000-0000-4000-8000-000000000014";

  function childEnvFor(userId: string, parentId: string, workflow = "HELLO_WORKFLOW"): ChildEnv {
    const live = {
      ...bindings,
      [workflow]: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    return {
      env: live,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: {
        orgId: principal.orgId,
        userId,
        executionId: parentId,
        sagaId: helloParentSaga.id,
        sagaRevision: helloParentSaga.revision,
        attemptToken: `${parentId}:0`,
      },
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
  }

  async function seedParent(parentId: string) {
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
  }

  async function childRowCount(parentId: string): Promise<number> {
    const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions WHERE parent_execution_id=?")
      .bind(parentId)
      .first<{ n: number }>();
    return row?.n ?? -1;
  }

  it("dispatches for an operator holding a direct execute grant, inheriting the parent org", async () => {
    await seedAuthority(OPERATOR, principal.orgId, "operator");
    await seedExecuteGrant(principal.orgId, helloSaga.id, OPERATOR);
    const parentId = "5a".repeat(32);
    await seedParent(parentId);
    const receipt = await invokeChild(childEnvFor(OPERATOR, parentId), "child-dispatch-invoke-v1", helloSaga.id, {
      name: "Ada",
    });
    expect(receipt.executionId).toMatch(/^[a-f0-9]{64}$/);
    const row = await bindings.DB.prepare("SELECT org_id,user_id,parent_execution_id FROM executions WHERE id=?")
      .bind(receipt.executionId)
      .first<{ org_id: string; user_id: string; parent_execution_id: string }>();
    // The child inherits caller/org/install context from the parent D1 row:
    // no org parameter exists to point it elsewhere.
    expect(row).toMatchObject({
      org_id: principal.orgId,
      user_id: OPERATOR,
      parent_execution_id: parentId,
    });
  });

  it("dispatches for an operator holding the grant through a role assignment", async () => {
    await seedAuthority(OPERATOR, principal.orgId, "operator");
    const role = await createRole(bindings.DB, principal.orgId, "child-runners");
    await addGrant(bindings.DB, principal.orgId, role.id, "saga", helloSaga.id, "execute");
    await assignRole(bindings.DB, principal.orgId, role.id, OPERATOR);
    const parentId = "5b".repeat(32);
    await seedParent(parentId);
    const receipt = await invokeChild(childEnvFor(OPERATOR, parentId), "child-dispatch-invoke-v1", helloSaga.id, {
      name: "Ada",
    });
    expect(receipt.executionId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a stranger with no membership before any write", async () => {
    // No authority rows at all: the persisted parent identity proves nothing.
    const parentId = "5c".repeat(32);
    await seedParent(parentId);
    await expect(
      invokeChild(childEnvFor(STRANGER, parentId), "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }),
    ).rejects.toMatchObject({ code: "ORG_NOT_FOUND" });
    expect(await childRowCount(parentId)).toBe(0);
  });

  it("rejects a member with no execute grant on the hidden child before any write", async () => {
    // The caller may run other Sagas; this child stays hidden by absence.
    await seedAuthority(OPERATOR, principal.orgId, "operator");
    const parentId = "5d".repeat(32);
    await seedParent(parentId);
    await expect(
      invokeChild(childEnvFor(OPERATOR, parentId), "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }),
    ).rejects.toMatchObject({ code: "GRANT_REQUIRED" });
    expect(await childRowCount(parentId)).toBe(0);
  });

  it("rejects a revoked member even when a grant row still names them", async () => {
    await seedAuthority(REVOKED, principal.orgId, "operator", "revoked");
    await seedExecuteGrant(principal.orgId, helloSaga.id, REVOKED);
    const parentId = "5e".repeat(32);
    await seedParent(parentId);
    await expect(
      invokeChild(childEnvFor(REVOKED, parentId), "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_REVOKED" });
    expect(await childRowCount(parentId)).toBe(0);
  });

  it("rejects a viewer under the read-only ceiling even with a direct execute rule", async () => {
    await seedAuthority(VIEWER, principal.orgId, "viewer");
    await seedExecuteGrant(principal.orgId, helloSaga.id, VIEWER);
    const parentId = "5f".repeat(32);
    await seedParent(parentId);
    await expect(
      invokeChild(childEnvFor(VIEWER, parentId), "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }),
    ).rejects.toMatchObject({ code: "GRANT_REQUIRED" });
    expect(await childRowCount(parentId)).toBe(0);
  });

  it("fails an HTTP parent actionably when the caller may run the parent but not the child", async () => {
    // Hidden-child end to end on real local bindings: the caller holds
    // execute on hello-parent only, submits the parent over HTTP, and the
    // parent persists GRANT_REQUIRED instead of fabricating a greeting.
    await seedAuthority(OPERATOR, principal.orgId, "operator");
    await seedExecuteGrant(principal.orgId, helloParentSaga.id, OPERATOR);
    const callerEnv = { ...bindings, LAB_USER_ID: OPERATOR, LAB_FIXTURE_USER_ID: principal.userId };
    const key = "run02-hidden-child-001";
    // Execution identity binds the submitting caller: derive it from the
    // operator principal, never the fixture one.
    const id = await executionId({ orgId: principal.orgId, userId: OPERATOR }, key);
    const submit = await worker.fetch(
      new Request("https://local.test/api/executions", {
        method: "POST",
        headers: { ...auth, "Idempotency-Key": key },
        body: JSON.stringify({ sagaId: helloParentSaga.id, input: { name: "Ada" } }),
      }),
      callerEnv,
    );
    // The parent submit itself is authorized; the denial lands at child
    // dispatch inside the Workflow, so this stays 202 with a receipt.
    expect(submit.status).toBe(202);
    const { inner: instance } = await trackWorkflowInstance(bindings.HELLO_PARENT_WORKFLOW, id);
    // The D1 row persists Failed while the native instance ends errored
    // (NonRetryableError after the persist-failure checkpoint): wait for the
    // native terminal, then read the inspectable row.
    await instance.waitForStatus("errored");
    // Reads are owner-scoped (org + user): the operator reads their own row.
    const response = await worker.fetch(detailRequest(id), callerEnv);
    expect(response.status).toBe(200);
    const parent = (await response.json()) as {
      status: string;
      result: unknown;
      error: { code: string; message: string } | null;
      children: unknown[];
    };
    expect(parent.status).toBe("Failed");
    expect(parent.error).toMatchObject({ code: "GRANT_REQUIRED" });
    expect(parent.result).toBeNull();
    expect(parent.children).toHaveLength(0);
  }, 25000);
});

describe("RUN-02 child helpers (pure, no bindings)", () => {
  it("rejects invalid Execution identity and forwards explicit child keys", async () => {
    const step: SagaStep = {
      do: async (_name: string, fn: () => Promise<never>) => fn(),
      sleep: async () => {},
    };
    const badCtx = { executionId: "not-an-execution", children: {}, db: bindings.DB } as unknown as SagaEventContext;
    await expect(helloParentSagaDef.run(badCtx, step)).rejects.toThrow("Invalid local Execution invocation.");
    // Explicit childKey flows through to the child handle as { key }.
    const parentId = "9f".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    let seenOptions: unknown = null;
    const keyedChildren = {
      invoke: async (_ref: string, _input: unknown, options?: unknown) => {
        seenOptions = options;
        return { executionId: "ab".repeat(32), sagaId: helloSaga.id, replayed: false, statusUrl: "/x" };
      },
      awaitResult: async <T>(): Promise<T> => ({ greeting: "Hello, Ada!", name: "Ada" }) as unknown as T,
    };
    const keyedCtx = {
      executionId: parentId,
      children: keyedChildren,
      db: bindings.DB,
    } as unknown as SagaEventContext;
    // Prepare reads the row first: seed a keyed input through the parse path.
    await bindings.DB.prepare("UPDATE executions SET input_json=? WHERE id=?")
      .bind(JSON.stringify({ name: "Ada", childKey: "k-9" }), parentId)
      .run();
    const out = await helloParentSagaDef.run(keyedCtx, step);
    expect(seenOptions).toEqual({ key: "k-9" });
    expect(out).toMatchObject({ greeting: "Hello, Ada!", childExecutionId: "ab".repeat(32) });
  });

  it("persists actionable child codes and never invents success from unknown failures", async () => {
    const parentId = "6b".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    // A Fault from the child path persists its own code/message (CHILD_FAILED).
    const failingChildren = {
      invoke: async () => {
        throw new Fault(502, "CHILD_FAILED", "Child ended Failed (EXECUTION_FAILED).");
      },
      awaitResult: async <T>(): Promise<T> => {
        throw new Error("unreachable");
      },
    };
    const ctx = { executionId: parentId, children: failingChildren, db: bindings.DB } as unknown as SagaEventContext;
    const step: SagaStep = {
      do: async (_name: string, fn: () => Promise<never>) => fn(),
      sleep: async () => {},
    };
    await expect(helloParentSagaDef.run(ctx, step)).rejects.toThrow("CHILD_FAILED");
    const failed = await bindings.DB.prepare("SELECT status,error_json FROM executions WHERE id=?")
      .bind(parentId)
      .first<{ status: string; error_json: string }>();
    expect(failed?.status).toBe("Failed");
    expect(JSON.parse(failed?.error_json as string)).toMatchObject({ code: "CHILD_FAILED" });
    // An unknown (non-Fault) failure keeps the generic EXECUTION_FAILED marker.
    const otherId = "7c".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        otherId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const otherChildren = {
      invoke: async () => {
        throw new Error("transport exploded");
      },
      awaitResult: async <T>(): Promise<T> => {
        throw new Error("unreachable");
      },
    };
    const otherCtx = {
      executionId: otherId,
      children: otherChildren,
      db: bindings.DB,
    } as unknown as SagaEventContext;
    await expect(helloParentSagaDef.run(otherCtx, step)).rejects.toThrow("EXECUTION_FAILED");
    const generic = await bindings.DB.prepare("SELECT status,error_json FROM executions WHERE id=?")
      .bind(otherId)
      .first<{ status: string; error_json: string }>();
    expect(generic?.status).toBe("Failed");
    expect(JSON.parse(generic?.error_json as string)).toMatchObject({ code: "EXECUTION_FAILED" });
  });

  it("fails the parent through the dispatch-await boundary when a dispatched child fails", async () => {
    // Crosses invoke -> awaitResult: reserve and dispatch a real child row,
    // drive it to Failed at the row level, then prove the parent-visible
    // await surfaces CHILD_FAILED (not invented success, not a silent pass).
    await seedAuthority();
    const parentId = "d4".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const live = {
      ...bindings,
      HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: live,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    // invoke reserves AND dispatches (stubbed native): a real receipt.
    const receipt = await invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" });
    expect(receipt.executionId).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.sagaId).toBe(helloSaga.id);
    // Drive the dispatched child to Failed at the row level.
    await bindings.DB.prepare("UPDATE executions SET status='Failed',completed_at=?,error_json=? WHERE id=?")
      .bind(
        new Date().toISOString(),
        JSON.stringify({ code: "EXECUTION_FAILED", message: "child blew up" }),
        receipt.executionId,
      )
      .run();
    // The parent-visible await crosses the boundary and surfaces CHILD_FAILED.
    await expect(awaitChildResult(childEnv, { sleep: async () => {} }, receipt)).rejects.toMatchObject({
      code: "CHILD_FAILED",
    });
  });

  it("resolves children by UUID or exact name and derives stable keys", async () => {
    const catalog = { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] };
    expect(resolveChildSaga(catalog, helloSaga.id).name).toBe("hello");
    expect(resolveChildSaga(catalog, helloSaga.id.toUpperCase()).name).toBe("hello");
    expect(resolveChildSaga(catalog, "hello").id).toBe(helloSaga.id);
    expect(() => resolveChildSaga(catalog, "nope")).toThrow(Fault);
    expect(childDispatchKey("p", "s", "c", "k")).toBe("child.p.s.c.k");
    expect(childDispatchStep("invoke")).toBe("child-dispatch-invoke");
    expect(childPollStep("abcdef12")).toBe("child-poll-abcdef12");
    expect(childTerminalOf("Succeeded")).toBe("Succeeded");
    expect(childTerminalOf("Failed")).toBe("Failed");
    expect(childTerminalOf("Running")).toBeNull();
    const caller = { orgId: principal.orgId, userId: principal.userId };
    expect(await childExecutionId(caller, "p", "s", "c", "k")).toBe(await childExecutionId(caller, "p", "s", "c", "k"));
    expect(await childExecutionId(caller, "p", "s", "c", "k")).not.toBe(
      await childExecutionId(caller, "p", "s", "c", "other"),
    );
    expect(parseHelloParentInput({ name: "Ada" })).toEqual({ name: "Ada" });
    expect(parseHelloParentInput({ name: "Ada", childKey: "k-1" })).toEqual({ name: "Ada", childKey: "k-1" });
    expect(() => parseHelloParentInput({ name: "" })).toThrow(Fault);
    expect(() => parseHelloParentInput({ name: "Ada", childKey: "bad key!" })).toThrow(Fault);
    expect(() => parseHelloParentInput({ name: "Ada", extra: 1 })).toThrow(Fault);
  });

  it("binds the ctx.children handle to invoke plus await", async () => {
    await seedAuthority();
    const parentId = "ad".repeat(32);
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const live = {
      ...bindings,
      HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const handle = bindSagaChildren(
      {
        env: live,
        catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
        parentOrg: org,
        parentExecutionId: parentId,
        parentSagaId: helloParentSaga.id,
      },
      { sleep: async () => {} },
    );
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    // The handle resolves the identity step from the owning step.do
    // Operation: the ambient step name (not a hardcoded default) lands in
    // parent_step, and invoke outside a step.do fails loud.
    await expect(handle.invoke(helloSaga.id, { name: "Ada" })).rejects.toMatchObject({ code: "CHILD_STEP_MISSING" });
    const receipt = await handle.invoke(helloSaga.id, { name: "Ada" }, { callerStep: "invoke-v1" });
    expect(receipt.executionId).toMatch(/^[a-f0-9]{64}$/);
    const lineage = await bindings.DB.prepare("SELECT parent_step FROM executions WHERE id=?")
      .bind(receipt.executionId)
      .first<{ parent_step: string }>();
    expect(lineage?.parent_step).toBe("child-dispatch-invoke-v1");
    // Mark the child Succeeded and read it back through the same handle.
    await bindings.DB.prepare("UPDATE executions SET status='Succeeded',completed_at=?,result_json=? WHERE id=?")
      .bind(new Date().toISOString(), JSON.stringify({ greeting: "Hello, Ada!", name: "Ada" }), receipt.executionId)
      .run();
    await expect(handle.awaitResult(receipt)).resolves.toMatchObject({ greeting: "Hello, Ada!" });
    expect(helloParentSagaDef.id).toBe(helloParentSaga.id);
  });

  it("produces two child rows when two differently named steps invoke the same child under the same key", async () => {
    // Regression for the parent-step identity collision (issue #136): the
    // (parent, step, child, key) tuple must carry the owning Operation, so
    // two distinct step.do callbacks sharing one key fork two children with
    // correct parent_step instead of converging on one row.
    await seedAuthority();
    const parentId = "aa".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        parentId,
        helloParentSaga.id,
        helloParentSaga.name,
        helloParentSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const live = {
      ...bindings,
      HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: live,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    // Ambient Operation binding without a workflow double: each step.do name
    // scopes invoke identity through AsyncLocalStorage, mirroring the
    // native adapter path (bindSagaStep).
    const inlineStep: SagaStep = {
      do: async (name: string, fn: () => Promise<never>) =>
        bindSagaStep({ do: async (_n: string, _o: unknown, f: () => Promise<never>) => f() } as never).do(
          name,
          fn as () => Promise<never>,
        ),
      sleep: async () => {},
    };
    const first = await inlineStep.do("fanout-left-v1", () =>
      bindSagaChildren(childEnv, inlineStep).invoke(helloSaga.id, { name: "Ada" }),
    );
    const second = await inlineStep.do("fanout-right-v1", () =>
      bindSagaChildren(childEnv, inlineStep).invoke(helloSaga.id, { name: "Ada" }),
    );
    expect(second.executionId).not.toBe(first.executionId);
    const rows = await bindings.DB.prepare(
      "SELECT id,parent_step FROM executions WHERE parent_execution_id=? ORDER BY parent_step",
    )
      .bind(parentId)
      .all<{ id: string; parent_step: string }>();
    expect(rows.results.map((row) => row.parent_step)).toEqual([
      "child-dispatch-fanout-left-v1",
      "child-dispatch-fanout-right-v1",
    ]);
    // Same key with same step still converges: a retry of the left Operation
    // lands on the left child row, not a third row.
    const replay = await inlineStep.do("fanout-left-v1", () =>
      bindSagaChildren(childEnv, inlineStep).invoke(helloSaga.id, { name: "Ada" }),
    );
    expect(replay.executionId).toBe(first.executionId);
    expect(replay.replayed).toBe(true);
  });

  it("treats a missing lineage column as no children, never a failure", async () => {
    expect(isMissingLineageColumn(new Error("no such column: parent_execution_id"))).toBe(true);
    expect(isMissingLineageColumn(new Error("no such table: executions"))).toBe(false);
    expect(isMissingLineageColumn(new Error("boom"))).toBe(false);
    expect(isMissingLineageColumn("no such column: parent_execution_id")).toBe(false);
    // The cancel fan-out degrades on a pre-0015 store shape: a proxy DB whose
    // prepare throws the D1 missing-column error resolves to no confirmed
    // children instead of failing the parent cancel.
    const missingColumn: D1Database = new Proxy(bindings.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return () => {
            throw new Error("no such column: parent_execution_id");
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(cancelDirectChildren({ ...bindings, DB: missingColumn }, principal, "af".repeat(32))).resolves.toEqual(
      [],
    );
    // Genuine failures still throw: a proxy that fails with any other error
    // propagates out of the fan-out instead of degrading.
    const broken: D1Database = new Proxy(bindings.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return () => {
            throw new Error("D1_ERROR: disk I/O error");
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(cancelDirectChildren({ ...bindings, DB: broken }, principal, "af".repeat(32))).rejects.toThrow(
      /disk I\/O/,
    );
  });

  it("refuses to dispatch into a cancelled child instead of resurrecting it", async () => {
    await seedAuthority();
    const parentId = "1c".repeat(32);
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const live = {
      ...bindings,
      HELLO_WORKFLOW: { createBatch: async () => {} } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    const childEnv: ChildEnv = {
      env: live,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    const receipt = await invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" });
    // Cancel the reserved child before a second dispatch under the same key:
    // convergence finds the reservation, sees Cancelled, and fails loud.
    await bindings.DB.prepare("UPDATE executions SET status='Cancelled' WHERE id=?").bind(receipt.executionId).run();
    await expect(
      invokeChild(childEnv, "child-dispatch-invoke-v1", helloSaga.id, { name: "Ada" }),
    ).rejects.toMatchObject({ code: "CHILD_FAILED" });
  });

  it("falls back to the status marker for unreadable child error bodies", async () => {
    const childId = "2d".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        "3e".repeat(32),
        "child-dispatch-invoke-v1",
        1,
        "Failed",
        new Date().toISOString(),
        new Date().toISOString(),
        "{not-json",
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: "3e".repeat(32),
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: "3e".repeat(32).concat(":0"),
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: "3e".repeat(32),
      parentSagaId: helloParentSaga.id,
    };
    // Corrupt error_json: the failure still surfaces as CHILD_FAILED carrying
    // the child status marker instead of a parsed code.
    const failure = await awaitChildResult(
      childEnv,
      { sleep: async () => {} },
      { executionId: childId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${childId}` },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "CHILD_FAILED" });
    expect(String((failure as { message: string }).message)).toContain("Failed");
  });

  it("confirms a cannot_terminate stop without rolling the child back", async () => {
    const parentId = "4f".repeat(32);
    const childId = "5a".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const live = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => ({
          terminate: async () => {
            throw new Error("instance.cannot_terminate: already complete");
          },
        }),
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    await expect(cancelDirectChildren(live, principal, parentId)).resolves.toEqual([childId]);
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(childId)
      .first<{ status: string }>();
    expect(row?.status).toBe("Cancelled");
  });

  it("yields null for a Succeeded child with a null result and codes string error throws", async () => {
    // error_json NULL with a Failed child: safeCode takes the no-body arm and
    // the failure carries the status marker.
    const nullErrParent = "0f".repeat(32);
    const nullErrChild = "1e".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        nullErrChild,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        nullErrParent,
        "child-dispatch-invoke-v1",
        1,
        "Failed",
        new Date().toISOString(),
        new Date().toISOString(),
        null,
      )
      .run();
    const nullErrOrg: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: nullErrParent,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${nullErrParent}:0`,
    };
    const nullErrEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: nullErrOrg,
      parentExecutionId: nullErrParent,
      parentSagaId: helloParentSaga.id,
    };
    const nullErr = await awaitChildResult(
      nullErrEnv,
      { sleep: async () => {} },
      { executionId: nullErrChild, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${nullErrChild}` },
    ).catch((error: unknown) => error);
    expect(nullErr).toMatchObject({ code: "CHILD_FAILED" });
    expect(String((nullErr as { message: string }).message)).toContain("Failed");
    // Non-object error body (a bare JSON string): the code arm misses and the
    // status marker carries the failure instead.
    const strErrChild = "2e".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,error_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        strErrChild,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        nullErrParent,
        "child-dispatch-invoke-v1",
        1,
        "TimedOut",
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify("just a string"),
      )
      .run();
    const strErr = await awaitChildResult(
      nullErrEnv,
      { sleep: async () => {} },
      { executionId: strErrChild, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${strErrChild}` },
    ).catch((error: unknown) => error);
    expect(strErr).toMatchObject({ code: "CHILD_FAILED" });
    expect(String((strErr as { message: string }).message)).toContain("TimedOut");
    // result_json NULL: the Succeeded child yields null (still serializable).
    const parentId = "8d".repeat(32);
    const childId = "9e".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        childId,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Succeeded",
        new Date().toISOString(),
        new Date().toISOString(),
        null,
      )
      .run();
    const org: OrgCtx = {
      orgId: principal.orgId,
      userId: principal.userId,
      executionId: parentId,
      sagaId: helloParentSaga.id,
      sagaRevision: helloParentSaga.revision,
      attemptToken: `${parentId}:0`,
    };
    const childEnv: ChildEnv = {
      env: bindings,
      catalog: { sagas: [{ ...helloSaga, parse: (v: unknown) => v }] },
      parentOrg: org,
      parentExecutionId: parentId,
      parentSagaId: helloParentSaga.id,
    };
    await expect(
      awaitChildResult(
        childEnv,
        { sleep: async () => {} },
        { executionId: childId, sagaId: helloSaga.id, replayed: true, statusUrl: `/api/executions/${childId}` },
      ),
    ).resolves.toBeNull();
    // A string (non-Error) terminate throw is still classified: the message
    // arm reads it directly, so a terminal engine stop confirms.
    const stringParent = "af".repeat(32);
    const stringChild = "be".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        stringChild,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        stringParent,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const stringLive = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => ({
          terminate: async () => {
            throw "instance.cannot_terminate: already complete";
          },
        }),
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    await expect(cancelDirectChildren(stringLive, principal, stringParent)).resolves.toEqual([stringChild]);
    // A non-Error non-string throw (null) classifies as ambiguous: the child
    // rolls back to Running and stays inspectable.
    const nullParent = "0a".repeat(32);
    const nullChild = "1b".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        nullChild,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        nullParent,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const nullLive = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => ({
          terminate: async () => {
            throw null;
          },
        }),
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    await expect(cancelDirectChildren(nullLive, principal, nullParent)).resolves.toEqual([]);
    const rolled = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(nullChild)
      .first<{ status: string }>();
    expect(rolled?.status).toBe("Running");
    // A resolving terminate confirms outright: the success path marks stopped
    // without entering the classify arms.
    const okParent = "2c".repeat(32);
    const okChild = "3d".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        okChild,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        okParent,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const okLive = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => ({ terminate: async () => {} }),
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    await expect(cancelDirectChildren(okLive, principal, okParent)).resolves.toEqual([okChild]);
  });

  it("skips terminal children and lost races without touching the native control", async () => {
    // A Succeeded child is skipped before any mark: no native get, no confirm.
    const parentId = "ca".repeat(32);
    const terminalChild = "db".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,completed_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        terminalChild,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        parentId,
        "child-dispatch-invoke-v1",
        1,
        "Succeeded",
        new Date().toISOString(),
        new Date().toISOString(),
        JSON.stringify({ greeting: "Hello, Ada!", name: "Ada" }),
      )
      .run();
    let gets = 0;
    const counting = {
      ...bindings,
      HELLO_WORKFLOW: {
        createBatch: async () => {},
        get: async () => {
          gets += 1;
          throw new Error("must not be called");
        },
      } as unknown as Bindings["HELLO_WORKFLOW"],
    };
    await expect(cancelDirectChildren(counting, principal, parentId)).resolves.toEqual([]);
    expect(gets).toBe(0);
    // A lost mark race (row settled between list and mark) is skipped too.
    const racyParent = "ec".repeat(32);
    const racyChild = "fd".repeat(32);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,parent_execution_id,parent_step,dispatched,status,created_at,started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        racyChild,
        helloSaga.id,
        helloSaga.name,
        helloSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ name: "Ada" }),
        racyParent,
        "child-dispatch-invoke-v1",
        1,
        "Running",
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    const racy: D1Database = new Proxy(bindings.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.startsWith("UPDATE executions SET status='Cancelling'")) {
              return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
            }
            const stmt = (target as unknown as D1Database).prepare(sql);
            return stmt;
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(cancelDirectChildren({ ...counting, DB: racy }, principal, racyParent)).resolves.toEqual([]);
  });
});
