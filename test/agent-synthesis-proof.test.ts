// SPDX-License-Identifier: AGPL-3.0
// ADR-033-5 agent synthesis proof (issue #416): an agent takes the short
// natural-language spec below and generates a valid Saga using only the
// interior helpers — no manual repair afterward.
//
// Spec: "shout-echo takes { phrase }, echoes it through the echo
// Integration, and returns the echoed message uppercased as { shouted }."
//
// Proof bar: typecheck (this file compiles under test/tsconfig.json) +
// scanner gate (assertDeterministicRun) + local runtime proof (real D1,
// real echo Action, only vendor HTTP mocked) for the success leg and the
// failure leg. Generation attempts: the generated Saga passed typecheck,
// contract, and runtime on the first run with no saga edits; one
// test-assertion correction followed (terminal checkpoints write the
// executions row, not an Operation row — a test-side assumption, not a
// saga defect).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/bindings";
import { Fault } from "../src/domain";
import type { SafeError } from "../src/domain";
import { ECHO_INTEGRATION_ID, VENDOR_TIMEOUT_MS } from "../src/domain";
import { assertDeterministicRun, defineSaga, schemaOf } from "../src/saga";
import type { SagaEventContext, SagaStep } from "../src/saga";
import { integrationOperation, prepareInput } from "../src/saga-helpers";
import { echo } from "../src/integrations/echo";
import { assertRunExecutionId, completeExecution, failSagaExecution } from "../src/executions";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";

// Test-only stable identity: never registered in SAGA_DEFINITIONS, so the
// manifest gate never sees it. Fixed (not random) so reruns converge.
const SYNTH_SAGA_ID = "77777777-7777-4777-8777-777777777777";
const SYNTH_SAGA_REVISION = "shout-echo-v1";

interface SynthInput {
  readonly phrase: string;
}

interface SynthOutput {
  readonly shouted: string;
}

function parseSynthInput(value: unknown): SynthInput {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { phrase?: unknown }).phrase !== "string" ||
    (value as { phrase: string }).phrase.length === 0
  ) {
    throw new Fault(400, "INVALID_INPUT", "Expected { phrase: string }.");
  }
  return { phrase: (value as { phrase: string }).phrase };
}

// The generated Saga: identity + schemas + visible durable sequencing; the
// platform owns prepare/checkpoint interiors and terminal classification.
export const synthSagaDef = defineSaga<SynthOutput>({
  id: SYNTH_SAGA_ID,
  name: "shout-echo",
  revision: SYNTH_SAGA_REVISION,
  description: "Echo a phrase through the echo Integration and shout it back.",
  tags: ["utility", "example"],
  requiredIntegrations: [ECHO_INTEGRATION_ID],
  inputSchema: schemaOf({ phrase: "string" }, ["phrase"]),
  outputSchema: schemaOf({ shouted: "string" }, ["shouted"]),
  parse: parseSynthInput,
  run: async (ctx, step): Promise<SynthOutput> => {
    const id = assertRunExecutionId(ctx.executionId);
    let terminalWritten = false;
    try {
      const prepared = await step.do("prepare-input-v1", () => prepareInput(ctx, synthSagaDef, parseSynthInput));
      const outcome = await step.do("echo-http-v1", () =>
        integrationOperation(ctx, synthSagaDef, prepared, {
          op: "echo-http-v1",
          position: 1,
          integrationId: ECHO_INTEGRATION_ID,
          vendorDefaultMs: VENDOR_TIMEOUT_MS,
          failureCode: "ECHO_INTEGRATION_FAILED",
          failureMessage: "The echo Integration could not complete.",
          call: (connection, _secrets, deadline, operationId) =>
            ctx.integrations.echo.echo(connection, { message: prepared.input.phrase }, operationId, deadline),
        }),
      );
      if (!outcome.ok) {
        await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, outcome.error));
        terminalWritten = true;
        throw new NonRetryableError(outcome.error.code);
      }
      const output: SynthOutput = { shouted: outcome.result.message.toUpperCase() };
      await step.do("persist-success-v1", () => completeExecution(ctx.db, id, output));
      return output;
    } catch (error) {
      if (terminalWritten) throw error;
      const failure: SafeError = {
        code: "EXECUTION_FAILED",
        message: "The Execution could not complete. Inspect local runtime diagnostics.",
      };
      await step.do("persist-failure-v1", () => failSagaExecution(ctx.db, id, failure));
      throw new NonRetryableError(failure.code);
    }
  },
});

const inlineStep: SagaStep = {
  do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
  sleep: async () => {},
};

function synthCtx(executionId: string): SagaEventContext {
  return {
    executionId,
    integrations: { echo: { echo } },
    db: bindings.DB,
    secrets: {},
  } as unknown as SagaEventContext;
}

async function insertSynthExecution(id: string, phrase = "hello"): Promise<void> {
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      SYNTH_SAGA_ID,
      "shout-echo",
      SYNTH_SAGA_REVISION,
      orgId,
      userId,
      JSON.stringify({ phrase }),
      1,
      "Pending",
      new Date().toISOString(),
    )
    .run();
}

async function executionRow(id: string): Promise<{ status: string; result: unknown; error: SafeError | null }> {
  const row = await bindings.DB.prepare("SELECT status,result_json,error_json FROM executions WHERE id=?")
    .bind(id)
    .first<{ status: string; result_json: string | null; error_json: string | null }>();
  if (!row) throw new Error("missing execution row");
  return {
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_json ? (JSON.parse(row.error_json) as SafeError) : null,
  };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("agent synthesis proof (issue #416)", () => {
  it("passes the determinism scanner with no helper-shape deviation", () => {
    expect(() => assertDeterministicRun("shout-echo", synthSagaDef.run)).not.toThrow();
  });

  it("runs the success leg against local D1 with the real echo Action", async () => {
    const id = "aa".repeat(32);
    await insertSynthExecution(id, "hello");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "http://127.0.0.1:8788/echo") throw new Error("Unexpected outbound request");
      return Response.json(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
    });
    await expect(synthSagaDef.run(synthCtx(id), inlineStep)).resolves.toEqual({ shouted: "HELLO" });
    const row = await executionRow(id);
    expect(row.status).toBe("Succeeded");
    expect(row.result).toEqual({ shouted: "HELLO" });
    const ops = await bindings.DB.prepare("SELECT name,status FROM operations WHERE execution_id=? ORDER BY position")
      .bind(id)
      .all<{ name: string; status: string }>();
    expect(ops.results.map((op) => `${op.name}:${op.status}`)).toEqual([
      "prepare-input-v1:Succeeded",
      "echo-http-v1:Succeeded",
    ]);
  });

  it("persists the failure leg exactly once with the safe code", async () => {
    const id = "bb".repeat(32);
    await insertSynthExecution(id, "hello");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 500 }));
    await expect(synthSagaDef.run(synthCtx(id), inlineStep)).rejects.toThrow("ECHO_INTEGRATION_FAILED");
    const row = await executionRow(id);
    expect(row.status).toBe("Failed");
    expect(row.error).toMatchObject({ code: "ECHO_INTEGRATION_FAILED" });
    // Terminal checkpoints write the executions row, not an Operation row:
    // exactly one terminal write lands, and the failed leg's Operation row
    // closes as Failed (not a second terminal shape).
    const ops = await bindings.DB.prepare("SELECT name,status FROM operations WHERE execution_id=? ORDER BY position")
      .bind(id)
      .all<{ name: string; status: string }>();
    expect(ops.results.map((op) => `${op.name}:${op.status}`)).toEqual([
      "prepare-input-v1:Succeeded",
      "echo-http-v1:Failed",
    ]);
  });

  it("rejects invalid invocations before D1 and maps unparsable input to the generic marker", async () => {
    await expect(synthSagaDef.run(synthCtx("not-an-id"), inlineStep)).rejects.toThrow(
      "Invalid local Execution invocation.",
    );
    const id = "cc".repeat(32);
    await insertSynthExecution(id, "");
    await expect(synthSagaDef.run(synthCtx(id), inlineStep)).rejects.toThrow("EXECUTION_FAILED");
  });
});
