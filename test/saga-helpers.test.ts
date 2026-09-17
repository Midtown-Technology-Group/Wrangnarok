// SPDX-License-Identifier: AGPL-3.0
// ADR-033-1: interior helpers over the defineSaga contract. Runs in real
// workerd with a real D1 binding. Covers the new helpers' behavior only —
// no existing Saga is rewritten here, so existing suites must stay green.
import { env } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { echoSaga, ECHO_INTEGRATION_ID, Fault, NINJA_INTEGRATION_ID, parseInput } from "../src/domain";
import { schemaOf } from "../src/saga";
import type { SagaEventContext } from "../src/saga";
import { integrationOperation, prepareInput } from "../src/saga-helpers";
import { echoSagaDef } from "../src/sagas/echo";
import { makeSagaWorkflow } from "../src/sagas/shared";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

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
      JSON.stringify({ message: "hello" }),
      1,
      "Pending",
      new Date().toISOString(),
    )
    .run();
}

function testCtx(id: string): SagaEventContext {
  // The helpers touch only executionId + db; the remaining handles stay
  // unbound because no step callback under test reaches them.
  return { executionId: id, db: bindings.DB } as SagaEventContext;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  await reset();
});

describe("schemaOf", () => {
  it("builds the same frozen shape as the hand-written echo schema", () => {
    const built = schemaOf({ message: "string" }, ["message"]);
    expect(built).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.properties)).toBe(true);
    expect(Object.isFrozen(built.properties["message"])).toBe(true);
    expect(Object.isFrozen(built.required)).toBe(true);
  });

  it("defaults to an empty frozen required list", () => {
    const built = schemaOf({ status: "string" });
    expect(built.required).toEqual([]);
    expect(Object.isFrozen(built.required)).toBe(true);
  });
});

describe("prepareInput", () => {
  it("validates against the D1 row and marks Pending -> Running", async () => {
    const id = "d".repeat(64);
    await insertExecution(id);
    const prepared = await prepareInput(testCtx(id), echoSaga, parseInput);
    expect(prepared.input).toEqual({ message: "hello" });
    expect(prepared.orgCtx).toMatchObject({ orgId, userId, executionId: id, sagaId: echoSaga.id });
    expect(typeof prepared.startedMs).toBe("number");
    const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("Running");
  });
});

describe("integrationOperation", () => {
  it("runs the full interior: begin, resolve, call, finish", async () => {
    const id = "e".repeat(64);
    await insertExecution(id);
    const ctx = testCtx(id);
    const prepared = await prepareInput(ctx, echoSaga, parseInput);
    const outcome = await integrationOperation(ctx, echoSagaDef, prepared, {
      op: "echo-http-v1",
      position: 1,
      integrationId: ECHO_INTEGRATION_ID,
      vendorDefaultMs: 1000,
      failureCode: "ECHO_INTEGRATION_FAILED",
      failureMessage: "The echo Integration could not complete.",
      call: async (connection, secrets, deadline, operationId) => {
        expect(connection.integrationId).toBe(ECHO_INTEGRATION_ID);
        expect(secrets).toBe(ctx.secrets);
        expect(typeof deadline).toBe("number");
        expect(operationId).toBe(`${id}-echo-http-v1`);
        return { message: "ok" };
      },
    });
    expect(outcome).toEqual({ ok: true, result: { message: "ok" } });
    const op = await bindings.DB.prepare("SELECT status,result_json FROM operations WHERE execution_id=? AND name=?")
      .bind(id, "echo-http-v1")
      .first<{ status: string; result_json: string }>();
    expect(op?.status).toBe("Succeeded");
    expect(JSON.parse(op?.result_json ?? "")).toEqual({ message: "ok" });
  });

  it("returns the 424 error for declared-but-missing Connections", async () => {
    const id = "f".repeat(64);
    await insertExecution(id);
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(orgId).run();
    const ctx = testCtx(id);
    const prepared = await prepareInput(ctx, echoSaga, parseInput);
    const outcome = await integrationOperation(ctx, echoSagaDef, prepared, {
      op: "echo-http-v1",
      position: 1,
      integrationId: ECHO_INTEGRATION_ID,
      vendorDefaultMs: 1000,
      failureCode: "ECHO_INTEGRATION_FAILED",
      failureMessage: "The echo Integration could not complete.",
      call: async () => {
        throw new Error("must not be called without a connection");
      },
    });
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: "INTEGRATION_REQUIREMENT_UNSATISFIED",
        message: "This Saga requires an Integration Connection that is not configured for this Organization.",
      },
    });
  });

  it("threads the secret handle through the one Action convention", async () => {
    // ADR-033-4: every leg takes the same
    // (connection, secrets, deadline, operationId) call shape — ninjaorgs-style
    // legs read secrets, echo-style legs ignore them, but the helper always
    // passes the Execution's handle straight through the Action boundary.
    const id = "2".repeat(64);
    await insertExecution(id);
    const secrets = { clientId: "ninja-client", clientSecret: "ninja-secret" };
    const ctx = { ...testCtx(id), secrets };
    const prepared = await prepareInput(testCtx(id), echoSaga, parseInput);
    const outcome = await integrationOperation(ctx, echoSagaDef, prepared, {
      op: "echo-http-v1",
      position: 1,
      integrationId: ECHO_INTEGRATION_ID,
      vendorDefaultMs: 1000,
      failureCode: "ECHO_INTEGRATION_FAILED",
      failureMessage: "The echo Integration could not complete.",
      call: async (connection, actionSecrets, deadline, operationId) => {
        expect(connection.integrationId).toBe(ECHO_INTEGRATION_ID);
        expect(actionSecrets).toBe(secrets);
        expect(typeof deadline).toBe("number");
        expect(operationId).toBe(`${id}-echo-http-v1`);
        return { message: "ok" };
      },
    });
    expect(outcome).toEqual({ ok: true, result: { message: "ok" } });
  });

  it("throws NonRetryableError on unreachable optional access", async () => {
    const id = "0".repeat(64);
    await insertExecution(id);
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=?").bind(orgId).run();
    const ctx = testCtx(id);
    const prepared = await prepareInput(ctx, echoSaga, parseInput);
    const optionalDef = { ...echoSagaDef, requiredIntegrations: [] as readonly string[] };
    await expect(
      integrationOperation(ctx, optionalDef, prepared, {
        op: "echo-http-v1",
        position: 1,
        integrationId: NINJA_INTEGRATION_ID,
        vendorDefaultMs: 5000,
        failureCode: "NINJA_INTEGRATION_FAILED",
        failureMessage: "The NinjaOne Integration could not complete.",
        call: async () => "unreachable",
      }),
    ).rejects.toThrow("Unexpected optional Integration access.");
  });

  it("passes Fault codes through scrubbed and maps generic throws", async () => {
    const id = "1".repeat(64);
    await insertExecution(id);
    const ctx = testCtx(id);
    const prepared = await prepareInput(ctx, echoSaga, parseInput);
    const base = {
      op: "echo-http-v1",
      position: 1,
      integrationId: ECHO_INTEGRATION_ID,
      vendorDefaultMs: 1000,
      failureCode: "ECHO_INTEGRATION_FAILED",
      failureMessage: "The echo Integration could not complete.",
    } as const;
    const faulted = await integrationOperation(ctx, echoSagaDef, prepared, {
      ...base,
      call: async () => {
        throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "vendor slow");
      },
    });
    expect(faulted.ok).toBe(false);
    if (!faulted.ok) expect(faulted.error.code).toBe("ECHO_VENDOR_TIMEOUT");
    const generic = await integrationOperation(ctx, echoSagaDef, prepared, {
      ...base,
      call: async () => {
        throw new Error("raw transport boom");
      },
    });
    expect(generic).toEqual({
      ok: false,
      error: { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." },
    });
  });
});

describe("makeSagaWorkflow", () => {
  it("returns a WorkflowEntrypoint subclass bound to the definition", () => {
    const Workflow = makeSagaWorkflow(echoSagaDef);
    expect(Object.getPrototypeOf(Workflow)).toBe(WorkflowEntrypoint);
    expect(typeof Workflow.prototype.run).toBe("function");
    // The named-subclass contract: call sites extend the product with a
    // static name for wrangler class_name targets.
    class EchoWorkflow extends Workflow {}
    expect(EchoWorkflow.name).toBe("EchoWorkflow");
    expect(Object.getPrototypeOf(EchoWorkflow)).toBe(Workflow);
  });
});
