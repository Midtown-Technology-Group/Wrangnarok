// Saga orchestration paths without native Workflow instances: real local D1
// plus an inline step runner and stubbed Integration handles. Covers the
// branches no happy-path Workflow reaches — invalid invocations, missing
// preconditions, Fault mapping, and explicit timeout markers.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bindings } from "../src/bindings";
import {
  digestSaga,
  echoSaga,
  ECHO_INTEGRATION_ID,
  Fault,
  helloSaga,
  ninjaSaga,
  NINJA_INTEGRATION_ID,
  smokeSaga,
} from "../src/domain";
import type { SagaEventContext, SagaStep } from "../src/saga";
import { digestSagaDef } from "../src/sagas/digest";
import { echoSagaDef } from "../src/sagas/echo";
import { helloSagaDef } from "../src/sagas/hello";
import { ninjaOrgsSagaDef } from "../src/sagas/ninjaorgs";
import { smokeSagaDef } from "../src/sagas/smoke";
import { executeSaga } from "../src/sagas/shared";
import migration from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const PRINCIPAL = {
  orgId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
};
const ID = "ab".repeat(32);

const inlineStep: SagaStep = {
  do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
  sleep: async () => {},
};

function ctxWith(db: D1Database, executionId: string, integrations: SagaEventContext["integrations"]) {
  return { executionId, integrations, db, secrets: {} } as unknown as SagaEventContext;
}

async function insertExecution(
  db: D1Database,
  id: string,
  saga: { id: string; name: string; revision: string },
  status = "Pending",
  inputJson = "{}",
) {
  await db
    .prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      saga.id,
      saga.name,
      saga.revision,
      PRINCIPAL.orgId,
      PRINCIPAL.userId,
      inputJson,
      1,
      status,
      new Date().toISOString(),
    )
    .run();
}

async function insertConnection(db: D1Database, id: string, integrationId: string, endpoint: string) {
  // The seed owns the echo fixture row for this org; keep it, add the rest.
  await db
    .prepare(
      "INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?) ON CONFLICT(org_id,integration_id) DO NOTHING",
    )
    .bind(id, PRINCIPAL.orgId, integrationId, endpoint)
    .run();
}

async function executionStatus(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT status,error_json FROM executions WHERE id=?")
    .bind(id)
    .first<{ status: string; error_json: string | null }>();
  return { status: row?.status, error: row?.error_json ? JSON.parse(row.error_json) : null };
}

/** Delegate every D1 call to the real binding except one SELECT shape, which
 * answers with a canned row. Lets a Saga step observe a precondition the real
 * single-threaded runtime cannot arrange (row vanishing mid-flight). */
function withSelectOverride(
  db: D1Database,
  match: string,
  first: () => Promise<unknown>,
  all: () => Promise<unknown>,
): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          const stmt = (target.prepare as (...args: unknown[]) => D1PreparedStatement)(sql, ...rest);
          if (typeof sql === "string" && sql.includes(match)) {
            return {
              bind: () => ({ first, all, run: () => stmt.bind().run() }),
            } as unknown as D1PreparedStatement;
          }
          return stmt;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await bindings.DB.exec(migration);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("rejects invalid Execution invocations before touching D1", async () => {
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  for (const def of [smokeSagaDef, echoSagaDef, ninjaOrgsSagaDef, digestSagaDef]) {
    await expect(def.run(ctxWith(bindings.DB, "not-an-id", integrations), inlineStep)).rejects.toThrow(
      "Invalid local Execution invocation.",
    );
  }
});

it("fails a smoke Execution whose prepare row is unknown", async () => {
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  // No executions row at all: prepareExecution throws before any checkpoint,
  // so the catch persists the generic EXECUTION_FAILED marker.
  await expect(smokeSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "EXECUTION_FAILED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBeUndefined();
  expect(error).toBeNull();
});

it("fails a smoke Execution whose D1 write cannot be verified", async () => {
  await insertExecution(bindings.DB, ID, smokeSaga);
  // A stale terminal row for the write step: begin/finish fence on Running,
  // so the probe below reads history without the smoke marker.
  await bindings.DB.prepare(
    "INSERT INTO operations(execution_id,name,position,status,started_at,result_json) VALUES (?,?,?,'Succeeded',?,?)",
  )
    .bind(ID, "smoke-write-v1", 1, new Date().toISOString(), '{"probe":"stale"}')
    .run();
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  await expect(smokeSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "SMOKE_WRITE_UNVERIFIED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "SMOKE_WRITE_UNVERIFIED" });
});

it("fails a smoke Execution whose Execution row vanishes before verify", async () => {
  await insertExecution(bindings.DB, ID, smokeSaga);
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  const db = withSelectOverride(
    bindings.DB,
    "SELECT id,status,org_id FROM executions",
    async () => null,
    async () => ({ results: [] }),
  );
  await expect(smokeSagaDef.run(ctxWith(db, ID, integrations), inlineStep)).rejects.toThrow("SMOKE_READ_UNVERIFIED");
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "SMOKE_READ_UNVERIFIED" });
});

it("fails a smoke Execution with incomplete Operation history", async () => {
  await insertExecution(bindings.DB, ID, smokeSaga);
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  const db = withSelectOverride(
    bindings.DB,
    "SELECT name,status FROM operations",
    async () => null,
    async () => ({ results: [] }),
  );
  await expect(smokeSagaDef.run(ctxWith(db, ID, integrations), inlineStep)).rejects.toThrow("SMOKE_READ_UNVERIFIED");
});

it("marks a digest Execution TimedOut when NinjaOne is slow", async () => {
  await insertExecution(bindings.DB, ID, digestSaga);
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000102",
    NINJA_INTEGRATION_ID,
    "https://ninja-in-test.invalid/api",
  );
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: {
      listOrganizations: async () => {
        throw new Fault(504, "NINJA_VENDOR_TIMEOUT", "slow vendor");
      },
    },
  } as unknown as SagaEventContext["integrations"];
  await expect(digestSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "NINJA_VENDOR_TIMEOUT",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("TimedOut");
  expect(error).toMatchObject({ code: "NINJA_VENDOR_TIMEOUT" });
});

it("maps raw NinjaOne transport errors to integration failure", async () => {
  await insertExecution(bindings.DB, ID, digestSaga);
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000102",
    NINJA_INTEGRATION_ID,
    "https://ninja-in-test.invalid/api",
  );
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: {
      listOrganizations: async () => {
        throw new Error("transport down");
      },
    },
  } as unknown as SagaEventContext["integrations"];
  await expect(digestSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "NINJA_INTEGRATION_FAILED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "NINJA_INTEGRATION_FAILED" });
});

it("marks a digest Execution TimedOut when the echo leg is slow", async () => {
  await insertExecution(bindings.DB, ID, digestSaga);
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000102",
    NINJA_INTEGRATION_ID,
    "https://ninja-in-test.invalid/api",
  );
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000103",
    ECHO_INTEGRATION_ID,
    "http://127.0.0.1:8788/echo",
  );
  const integrations = {
    echo: {
      echo: async () => {
        throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "slow vendor");
      },
    },
    ninjaone: {
      listOrganizations: async () => ({ organizationCount: 1, organizations: [{ id: 1, name: "Acme" }] }),
    },
  } as unknown as SagaEventContext["integrations"];
  await expect(digestSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "ECHO_VENDOR_TIMEOUT",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("TimedOut");
  expect(error).toMatchObject({ code: "ECHO_VENDOR_TIMEOUT" });
});

it("marks an echo Execution TimedOut via failSagaExecution classification", async () => {
  await insertExecution(bindings.DB, ID, echoSaga, "Pending", '{"message":"hi"}');
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000103",
    ECHO_INTEGRATION_ID,
    "http://127.0.0.1:8788/echo",
  );
  const integrations = {
    echo: {
      echo: async () => {
        throw new Fault(504, "ECHO_VENDOR_TIMEOUT", "slow vendor");
      },
    },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  await expect(echoSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "ECHO_VENDOR_TIMEOUT",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("TimedOut");
  expect(error).toMatchObject({ code: "ECHO_VENDOR_TIMEOUT" });
});

it("fails an echo Execution loudly when its Connection is missing", async () => {
  await insertExecution(bindings.DB, ID, echoSaga, "Pending", '{"message":"hi"}');
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=? AND integration_id=?")
    .bind(PRINCIPAL.orgId, ECHO_INTEGRATION_ID)
    .run();
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  await expect(echoSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "INTEGRATION_REQUIREMENT_UNSATISFIED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "INTEGRATION_REQUIREMENT_UNSATISFIED" });
});

it("fails a digest Execution loudly when a declared Connection is missing", async () => {
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: {
      listOrganizations: async () => ({ organizationCount: 1, organizations: [{ id: 1, name: "Acme" }] }),
    },
  } as unknown as SagaEventContext["integrations"];
  // Missing NinjaOne Connection: the census leg fails before echo resolves.
  await insertExecution(bindings.DB, ID, digestSaga);
  await expect(digestSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "INTEGRATION_REQUIREMENT_UNSATISFIED",
  );
  expect((await executionStatus(bindings.DB, ID)).status).toBe("Failed");

  // Missing echo Connection with a healthy census: the echo leg fails.
  const echoId = "cd".repeat(32);
  await insertExecution(bindings.DB, echoId, digestSaga);
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000102",
    NINJA_INTEGRATION_ID,
    "https://ninja-in-test.invalid/api",
  );
  await bindings.DB.prepare("DELETE FROM connections WHERE org_id=? AND integration_id=?")
    .bind(PRINCIPAL.orgId, ECHO_INTEGRATION_ID)
    .run();
  await expect(digestSagaDef.run(ctxWith(bindings.DB, echoId, integrations), inlineStep)).rejects.toThrow(
    "INTEGRATION_REQUIREMENT_UNSATISFIED",
  );
  expect((await executionStatus(bindings.DB, echoId)).status).toBe("Failed");
});

it("maps raw echo transport errors in the digest leg", async () => {
  await insertExecution(bindings.DB, ID, digestSaga);
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000102",
    NINJA_INTEGRATION_ID,
    "https://ninja-in-test.invalid/api",
  );
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000103",
    ECHO_INTEGRATION_ID,
    "http://127.0.0.1:8788/echo",
  );
  const integrations = {
    echo: {
      echo: async () => {
        throw new Error("transport down");
      },
    },
    ninjaone: {
      listOrganizations: async () => ({ organizationCount: 1, organizations: [{ id: 1, name: "Acme" }] }),
    },
  } as unknown as SagaEventContext["integrations"];
  await expect(digestSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "ECHO_INTEGRATION_FAILED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "ECHO_INTEGRATION_FAILED" });
});

it("fails unknown executions generically across Sagas", async () => {
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  // Valid format, no D1 row: prepare throws before any expected failure is
  // recorded, so every Saga persists the generic marker.
  await expect(digestSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "EXECUTION_FAILED",
  );
  await expect(echoSagaDef.run(ctxWith(bindings.DB, "cd".repeat(32), integrations), inlineStep)).rejects.toThrow(
    "EXECUTION_FAILED",
  );
  await expect(ninjaOrgsSagaDef.run(ctxWith(bindings.DB, "ef".repeat(32), integrations), inlineStep)).rejects.toThrow(
    "EXECUTION_FAILED",
  );
});

it("fails a ninjaone-orgs Execution loudly when its Connection is missing", async () => {
  await insertExecution(bindings.DB, ID, ninjaSaga);
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  await expect(ninjaOrgsSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "INTEGRATION_REQUIREMENT_UNSATISFIED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "INTEGRATION_REQUIREMENT_UNSATISFIED" });
});

it("maps raw NinjaOne transport errors in the census Saga", async () => {
  await insertExecution(bindings.DB, ID, ninjaSaga);
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000102",
    NINJA_INTEGRATION_ID,
    "https://ninja-in-test.invalid/api",
  );
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: {
      listOrganizations: async () => {
        throw new Error("transport down");
      },
    },
  } as unknown as SagaEventContext["integrations"];
  await expect(ninjaOrgsSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "NINJA_INTEGRATION_FAILED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "NINJA_INTEGRATION_FAILED" });
});

it("maps raw echo transport errors in the echo Saga", async () => {
  await insertExecution(bindings.DB, ID, echoSaga, "Pending", '{"message":"hi"}');
  await insertConnection(
    bindings.DB,
    "00000000-0000-4000-8000-000000000103",
    ECHO_INTEGRATION_ID,
    "http://127.0.0.1:8788/echo",
  );
  const integrations = {
    echo: {
      echo: async () => {
        throw new Error("transport down");
      },
    },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  await expect(echoSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "ECHO_INTEGRATION_FAILED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "ECHO_INTEGRATION_FAILED" });
});
it("rejects workflow invocations that fail the identity gate", async () => {
  const step = { do: async () => ({}) } as unknown as Parameters<typeof executeSaga>[2];
  const base = { payload: { executionId: ID }, instanceId: ID } as unknown as Parameters<typeof executeSaga>[1];
  // Disabled lab gate.
  await expect(executeSaga({ ...bindings, LAB_ENABLED: "false" }, base, step, smokeSagaDef)).rejects.toThrow(
    NonRetryableError,
  );
  // Malformed id, missing id, and instance mismatch.
  await expect(
    executeSaga(bindings, { payload: { executionId: "nope" }, instanceId: "nope" } as never, step, smokeSagaDef),
  ).rejects.toThrow(NonRetryableError);
  await expect(executeSaga(bindings, { payload: {}, instanceId: ID } as never, step, smokeSagaDef)).rejects.toThrow(
    NonRetryableError,
  );
  await expect(
    executeSaga(bindings, { payload: { executionId: ID }, instanceId: "cd".repeat(32) } as never, step, smokeSagaDef),
  ).rejects.toThrow(NonRetryableError);
  expect(NonRetryableError).toBeDefined();
});

it("references every registered saga def so the module surface stays honest", async () => {
  expect(ninjaSaga.id).toBe(ninjaOrgsSagaDef.id);
  expect(smokeSaga.id).toBe(smokeSagaDef.id);
});

it("fails a hello Execution generically when prepare cannot parse its input", async () => {
  await insertExecution(bindings.DB, ID, helloSaga, "Pending", '{"name":123}');
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  // Fault input (non-string name): prepare throws before any expected failure
  // is recorded, so the catch persists the generic EXECUTION_FAILED marker.
  await expect(helloSagaDef.run(ctxWith(bindings.DB, ID, integrations), inlineStep)).rejects.toThrow(
    "EXECUTION_FAILED",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "EXECUTION_FAILED" });
});

it("fails a hello Execution loudly when its greet step reports failure", async () => {
  await insertExecution(bindings.DB, ID, helloSaga, "Pending", '{"name":"Ada"}');
  const integrations = {
    echo: { echo: async () => ({ message: "hi" }) },
    ninjaone: { listOrganizations: async () => ({ organizationCount: 0, organizations: [] }) },
  } as unknown as SagaEventContext["integrations"];
  // A greet step reporting {ok:false} records the expected failure and throws
  // its code: the catch persists that exact SafeError, not the generic marker.
  const failGreetStep: SagaStep = {
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> =>
      name === "greet-v1"
        ? ({ ok: false, error: { code: "STEWARD_PROBE", message: "Steward probe failure." } } as unknown as T)
        : fn(),
    sleep: async () => {},
  };
  await expect(helloSagaDef.run(ctxWith(bindings.DB, ID, integrations), failGreetStep)).rejects.toThrow(
    "STEWARD_PROBE",
  );
  const { status, error } = await executionStatus(bindings.DB, ID);
  expect(status).toBe("Failed");
  expect(error).toMatchObject({ code: "STEWARD_PROBE" });
});

it("scrubs thrown Error text and rethrows non-Error values in the workflow adapter", async () => {
  const step = { do: async () => ({}) } as unknown as Parameters<typeof executeSaga>[2];
  const event = { payload: { executionId: ID }, instanceId: ID } as unknown as Parameters<typeof executeSaga>[1];
  const secret = "steward-probe-secret-sentinel";
  const envWithSecret = { ...bindings, NINJA_CLIENT_ID: bindings.NINJA_CLIENT_ID, NINJA_CLIENT_SECRET: secret };
  // A raw Error carrying a secret substring surfaces with the code only: the
  // message is scrubbed before the native errored status sees it.
  const failing = {
    ...smokeSagaDef,
    run: async () => {
      throw new Error(`vendor blew up on ${secret}`);
    },
  };
  await expect(executeSaga(envWithSecret, event, step, failing)).rejects.toThrow(NonRetryableError);
  try {
    await executeSaga(envWithSecret, event, step, failing);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toContain("[REDACTED]");
  }
  // A non-Error throw passes through untouched (identity preserved).
  const marker = { odd: "throwable-sentinel" };
  const alien = { ...smokeSagaDef, run: async () => Promise.reject(marker) };
  await expect(executeSaga(bindings, event, step, alien)).rejects.toBe(marker);
});
