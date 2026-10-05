// SPDX-License-Identifier: AGPL-3.0
// ADR-033-3 (issue #414): terminal outcome helpers. completeExecution /
// failSagaExecution own scrub + terminal-state rules + Failed-vs-TimedOut
// classification as the one canonical terminal writer; timeout-mark-v1 is
// retired (fail-closed-0 proof, not a deprecated alias). Real workerd D1;
// the legacy-behavior pin stubs Integration handles through an inline step
// runner (no native Workflow instance), mirroring test/saga-run-paths.test.ts.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/bindings";
import { DEFAULT_SAGA_POLICY, echoSaga, Fault, parseSagaPolicy, stepRetryLimit } from "../src/domain";
import type { ExecutionStatus, SafeError } from "../src/domain";
import {
  beginOperation,
  cancelExecution,
  completeExecution,
  failSagaExecution,
  isTimeoutError,
} from "../src/executions";
import { retryLimitForStep } from "../src/saga";
import type { SagaEventContext, SagaStep } from "../src/saga";
import { echoSagaDef } from "../src/sagas/echo";
import { clearExecutionSecrets, registerExecutionSecrets, SCRUB_PLACEHOLDER } from "../src/secrets";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  await reset();
});

async function insertExecution(id: string, status: ExecutionStatus): Promise<void> {
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

interface StoredExecution {
  status: string;
  completed_at: string | null;
  result_json: string | null;
  error_json: string | null;
}

async function readExecution(id: string): Promise<StoredExecution | null> {
  return bindings.DB.prepare("SELECT status,completed_at,result_json,error_json FROM executions WHERE id=?")
    .bind(id)
    .first<StoredExecution>();
}

async function readOperation(id: string, name: string) {
  return bindings.DB.prepare("SELECT status,result_json,error_json FROM operations WHERE execution_id=? AND name=?")
    .bind(id, name)
    .first<{ status: string; result_json: string | null; error_json: string | null }>();
}

function timeoutError(code: string): SafeError {
  return { code, message: "The vendor exceeded its deadline." };
}

describe("isTimeoutError", () => {
  it("classifies every *_VENDOR_TIMEOUT code as a timeout", () => {
    for (const code of [
      "ECHO_VENDOR_TIMEOUT",
      "NINJA_VENDOR_TIMEOUT",
      "CLOUDFLARE_VENDOR_TIMEOUT",
      "HALO_VENDOR_TIMEOUT",
      // Generated Integrations emit the same `${prefix}_VENDOR_TIMEOUT`
      // shape, so the suffix — not an enumerated list — is the contract.
      "BEARER_VENDOR_TIMEOUT",
    ]) {
      expect(isTimeoutError(timeoutError(code))).toBe(true);
    }
  });
  it("fails closed to Failed for every non-vendor-timeout code", () => {
    for (const code of [
      "ECHO_INTEGRATION_FAILED",
      "EXECUTION_FAILED",
      "INTEGRATION_REQUIREMENT_UNSATISFIED",
      // Near-misses that a substring match would wrongly classify.
      "CHILD_AWAIT_TIMEOUT",
      "PROVIDER_TIMEOUT",
      "TIMEOUT",
      "VENDOR_TIMEOUT",
      "",
    ]) {
      expect(isTimeoutError({ code, message: "not a vendor deadline" })).toBe(false);
    }
  });
});

describe("failSagaExecution", () => {
  it("writes Failed for generic errors and marks Running Operations", async () => {
    const id = "a0".repeat(32);
    await insertExecution(id, "Running");
    await beginOperation(bindings.DB, id, "echo-http-v1", 1);
    await failSagaExecution(bindings.DB, id, {
      code: "ECHO_INTEGRATION_FAILED",
      message: "The echo Integration could not complete.",
    });
    const row = await readExecution(id);
    expect(row?.status).toBe("Failed");
    expect(row?.completed_at).not.toBeNull();
    expect(JSON.parse(row?.error_json ?? "")).toMatchObject({ code: "ECHO_INTEGRATION_FAILED" });
    expect(row?.result_json).toBeNull();
    const op = await readOperation(id, "echo-http-v1");
    expect(op?.status).toBe("Failed");
    expect(JSON.parse(op?.error_json ?? "")).toMatchObject({ code: "ECHO_INTEGRATION_FAILED" });
  });
  it("writes TimedOut for vendor timeout codes with the safe code preserved", async () => {
    const codes = ["ECHO_VENDOR_TIMEOUT", "NINJA_VENDOR_TIMEOUT", "CLOUDFLARE_VENDOR_TIMEOUT", "HALO_VENDOR_TIMEOUT"];
    let index = 0;
    for (const code of codes) {
      const id = `b${index}`.padEnd(64, "b");
      index += 1;
      await insertExecution(id, "Running");
      await failSagaExecution(bindings.DB, id, timeoutError(code));
      const row = await readExecution(id);
      expect(row?.status).toBe("TimedOut");
      expect(row?.completed_at).not.toBeNull();
      expect(JSON.parse(row?.error_json ?? "")).toMatchObject({ code });
    }
  });
  it("writes Failed (not TimedOut) for timeout lookalikes", async () => {
    const id = "c0".repeat(32);
    await insertExecution(id, "Running");
    await failSagaExecution(bindings.DB, id, { code: "CHILD_AWAIT_TIMEOUT", message: "child still running" });
    expect((await readExecution(id))?.status).toBe("Failed");
  });
});

describe("completeExecution", () => {
  it("writes Succeeded on Running and touches only the Execution row", async () => {
    const id = "d0".repeat(32);
    await insertExecution(id, "Running");
    await beginOperation(bindings.DB, id, "echo-http-v1", 1);
    await completeExecution(bindings.DB, id, { message: "hello" });
    const row = await readExecution(id);
    expect(row?.status).toBe("Succeeded");
    expect(row?.completed_at).not.toBeNull();
    expect(JSON.parse(row?.result_json ?? "")).toEqual({ message: "hello" });
    expect(row?.error_json).toBeNull();
    // The success checkpoint owns the Execution row only: Operation rows
    // close through their own finishOperation writes, never here.
    expect((await readOperation(id, "echo-http-v1"))?.status).toBe("Running");
  });
});

describe("cancel-race fencing", () => {
  it("never lets a late failure checkpoint overwrite Cancelled, Cancelling, or another terminal", async () => {
    const terminals: ExecutionStatus[] = ["Succeeded", "Failed", "TimedOut", "Cancelling", "Cancelled"];
    let index = 0;
    for (const status of terminals) {
      for (const error of [
        { code: "ECHO_INTEGRATION_FAILED", message: "late failure" },
        timeoutError("ECHO_VENDOR_TIMEOUT"),
      ]) {
        const id = `e${index}`.padEnd(64, "e");
        index += 1;
        await insertExecution(id, status);
        const before = await readExecution(id);
        await failSagaExecution(bindings.DB, id, error);
        // A stale checkpoint is a no-op: status, payloads, and the original
        // completion marker all survive byte-identical.
        expect(await readExecution(id)).toEqual(before);
      }
    }
  });
  it("never lets a late success checkpoint overwrite a non-Running row", async () => {
    const settled: ExecutionStatus[] = ["Pending", "Succeeded", "Failed", "TimedOut", "Cancelling", "Cancelled"];
    let index = 0;
    for (const status of settled) {
      const id = `f${index}`.padEnd(64, "f");
      index += 1;
      await insertExecution(id, status);
      const before = await readExecution(id);
      await completeExecution(bindings.DB, id, { message: "late success" });
      expect(await readExecution(id)).toEqual(before);
    }
  });
  it("lets owner-cancel win over a racing terminal checkpoint", async () => {
    const id = "0c".repeat(32);
    await insertExecution(id, "Cancelling");
    // The Cancelling marker is already written: the racing failure
    // checkpoint is stale and no-ops, then the cancel half lands.
    await failSagaExecution(bindings.DB, id, timeoutError("ECHO_VENDOR_TIMEOUT"));
    expect((await readExecution(id))?.status).toBe("Cancelling");
    await cancelExecution(bindings.DB, id);
    const row = await readExecution(id);
    expect(row?.status).toBe("Cancelled");
    expect(JSON.parse(row?.error_json ?? "")).toMatchObject({ code: "EXECUTION_CANCELLED" });
    // And the acknowledged cancellation is never rewritten afterward.
    await failSagaExecution(bindings.DB, id, timeoutError("ECHO_VENDOR_TIMEOUT"));
    await completeExecution(bindings.DB, id, { message: "too late" });
    expect(await readExecution(id)).toEqual(row);
  });
  it("never resurrects terminal Operation rows", async () => {
    const id = "1c".repeat(32);
    await insertExecution(id, "Failed");
    const stamp = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO operations(execution_id,name,position,status,started_at,completed_at,error_json) VALUES (?,?,?,'Failed',?,?,?)",
    )
      .bind(id, "echo-http-v1", 1, stamp, stamp, JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "old" }))
      .run();
    await failSagaExecution(bindings.DB, id, timeoutError("NINJA_VENDOR_TIMEOUT"));
    expect(await readOperation(id, "echo-http-v1")).toMatchObject({
      status: "Failed",
      error_json: JSON.stringify({ code: "ECHO_INTEGRATION_FAILED", message: "old" }),
    });
  });
});

describe("write-time scrub on every terminal path", () => {
  const SECRET = "terminal-scrub-secret-sentinel";
  it("scrubs the Failed path (Execution row and Operation rows)", async () => {
    const id = "2c".repeat(32);
    await insertExecution(id, "Running");
    await beginOperation(bindings.DB, id, "echo-http-v1", 1);
    registerExecutionSecrets(id, [SECRET]);
    try {
      await failSagaExecution(bindings.DB, id, { code: "ECHO_INTEGRATION_FAILED", message: `boom ${SECRET} boom` });
    } finally {
      clearExecutionSecrets(id);
    }
    const row = await readExecution(id);
    expect(row?.error_json).toContain(SCRUB_PLACEHOLDER);
    expect(row?.error_json).not.toContain(SECRET);
    const op = await readOperation(id, "echo-http-v1");
    expect(op?.error_json).toContain(SCRUB_PLACEHOLDER);
    expect(op?.error_json).not.toContain(SECRET);
  });
  it("scrubs the TimedOut path", async () => {
    const id = "3c".repeat(32);
    await insertExecution(id, "Running");
    registerExecutionSecrets(id, [SECRET]);
    try {
      await failSagaExecution(bindings.DB, id, { code: "NINJA_VENDOR_TIMEOUT", message: `slow ${SECRET}` });
    } finally {
      clearExecutionSecrets(id);
    }
    const row = await readExecution(id);
    expect(row?.status).toBe("TimedOut");
    expect(row?.error_json).toContain(SCRUB_PLACEHOLDER);
    expect(row?.error_json).not.toContain(SECRET);
  });
  it("scrubs the Succeeded path", async () => {
    const id = "5c".repeat(32);
    await insertExecution(id, "Running");
    registerExecutionSecrets(id, [SECRET]);
    try {
      await completeExecution(bindings.DB, id, { message: `hello ${SECRET}` });
    } finally {
      clearExecutionSecrets(id);
    }
    const row = await readExecution(id);
    expect(row?.result_json).toContain(SCRUB_PLACEHOLDER);
    expect(row?.result_json).not.toContain(SECRET);
  });
});

describe("timeout-mark-v1 retirement (fail-closed-0)", () => {
  it("resolves the retired name to 0 through the code table and the policy-resolved gate", () => {
    expect(stepRetryLimit("timeout-mark-v1")).toBe(0);
    expect(retryLimitForStep("timeout-mark-v1", DEFAULT_SAGA_POLICY)).toBe(0);
    // Post-retirement the legacy steps ride the operator vendor budget, not
    // the checkpoint ceiling: engine-loss-only either way, never a mutation
    // retry, and 0 unless an operator explicitly raises vendorRetries.
    expect(retryLimitForStep("timeout-mark-v1", parseSagaPolicy({ retry: { vendorRetries: 1 } }))).toBe(1);
  });
  it("keeps the surviving checkpoint set at the ceiling (no over-retirement)", () => {
    for (const step of ["prepare-input-v1", "persist-success-v1", "persist-failure-v1"]) {
      expect(stepRetryLimit(step)).toBe(2);
      expect(retryLimitForStep(step, DEFAULT_SAGA_POLICY)).toBe(2);
    }
  });
  it("still lands TimedOut through the migrated echo path", async () => {
    // ADR-033-5 (issue #416, echo migration): the echo timeout-mark-v1 step
    // is gone — failSagaExecution classifies ECHO_VENDOR_TIMEOUT as TimedOut
    // inside persist-failure-v1. Same terminal row as the retired explicit
    // marker wrote (representative echo leg pinned here; the surviving
    // legacy legs plus the native-step suites stay green in the full gate
    // as the behavior proof until their migrations land).
    const id = "6c".repeat(32);
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
        JSON.stringify({ message: "hi" }),
        1,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const inlineStep: SagaStep = {
      do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      sleep: async () => {},
    };
    const ctx = {
      executionId: id,
      integrations: {
        echo: {
          echo: async () => {
            throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "slow vendor");
          },
        },
      },
      db: bindings.DB,
      secrets: {},
    } as unknown as SagaEventContext;
    await expect(echoSagaDef.run(ctx, inlineStep)).rejects.toThrow("ECHO_VENDOR_TIMEOUT");
    const row = await readExecution(id);
    expect(row?.status).toBe("TimedOut");
    expect(JSON.parse(row?.error_json ?? "")).toMatchObject({ code: "ECHO_VENDOR_TIMEOUT" });
  });
});
