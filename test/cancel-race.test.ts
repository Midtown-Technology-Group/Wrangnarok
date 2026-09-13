// Cancellation race coverage for src/index.ts: two cancel requests for one
// Execution interleave between the read and the Cancelling marker write.
// A tiny D1 proxy holds the marker UPDATEs so the test scripts the
// interleaving deterministically against the real local database — no timing
// assumptions, no sleeps.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { smokeSaga } from "../src/domain";
import migration from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > 15000) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Hold every Cancelling-marker UPDATE until the test releases it. Reads and
 * all other writes delegate straight to the real binding. */
function gateCancellingUpdates(db: D1Database) {
  const releases: Array<() => void> = [];
  const gated = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          const stmt = (target.prepare as (...args: unknown[]) => D1PreparedStatement)(sql, ...rest);
          if (typeof sql === "string" && sql.includes("SET status='Cancelling'")) {
            return {
              bind: (...values: unknown[]) => {
                const bound = stmt.bind(...values);
                return {
                  first: () => bound.first(),
                  all: () => bound.all(),
                  run: () =>
                    new Promise((resolve) => {
                      releases.push(() => resolve(bound.run()));
                    }),
                } as unknown as D1PreparedStatement;
              },
            } as unknown as D1PreparedStatement;
          }
          return stmt;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  }) as D1Database;
  return {
    db: gated,
    arrivalCount: () => releases.length,
    release: (index: number) => releases[index]?.(),
    waitForArrivals: (count: number) => waitFor(() => releases.length >= count, `${count} marker writes`),
  };
}

function fakeSmokeWorkflow(onTerminate: () => Promise<void>): Bindings["SMOKE_WORKFLOW"] {
  return {
    createBatch: async () => {},
    get: async () => ({ terminate: onTerminate, status: async () => ({ status: "running" }) }),
  } as unknown as Bindings["SMOKE_WORKFLOW"];
}

function submitRequest(key: string) {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ sagaId: smokeSaga.id, input: {} }),
  });
}

function cancelRequest(id: string) {
  return new Request(`https://local.test/api/executions/${id}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

async function rowStatus(id: string): Promise<string | null> {
  const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
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

it("answers the losing racer idempotently while the winner is terminating", async () => {
  const gate = gateCancellingUpdates(bindings.DB);
  let terminateCalled = false;
  const terminateGate = deferred<void>();
  const live = {
    ...bindings,
    DB: gate.db,
    SMOKE_WORKFLOW: fakeSmokeWorkflow(async () => {
      terminateCalled = true;
      await terminateGate.promise;
    }),
  };
  const submitted = await worker.fetch(submitRequest("race-cancel-loser-0001"), live);
  expect(submitted.status).toBe(202);
  const { executionId: id } = (await submitted.json()) as { executionId: string };

  const first = worker.fetch(cancelRequest(id), live);
  await gate.waitForArrivals(1);
  const second = worker.fetch(cancelRequest(id), live);
  await gate.waitForArrivals(2);

  // The first marker write wins; the winner blocks in native terminate while
  // still marked Cancelling.
  gate.release(0);
  await waitFor(() => terminateCalled, "native terminate");
  // The loser's marker matches no row and re-reads Cancelling: idempotent.
  gate.release(1);
  const loser = await Promise.race([first, second]);
  expect(loser.status).toBe(200);
  const loserBody = (await loser.json()) as { executionId: string; status: string; cancelled: boolean };
  expect(loserBody).toMatchObject({ executionId: id, status: "Cancelling", cancelled: false });

  // The winner then completes the cancellation.
  terminateGate.resolve();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  const firstBody = firstResponse === loser ? loserBody : ((await firstResponse.json()) as { cancelled: boolean });
  const secondBody = secondResponse === loser ? loserBody : ((await secondResponse.json()) as { cancelled: boolean });
  expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 200]);
  expect([firstBody.cancelled, secondBody.cancelled].sort()).toEqual([false, true]);
  expect(await rowStatus(id)).toBe("Cancelled");
});

it("rejects the losing racer once the winner has terminally cancelled", async () => {
  const gate = gateCancellingUpdates(bindings.DB);
  const live = {
    ...bindings,
    DB: gate.db,
    SMOKE_WORKFLOW: fakeSmokeWorkflow(async () => {}),
  };
  const submitted = await worker.fetch(submitRequest("race-cancel-winner-0001"), live);
  expect(submitted.status).toBe(202);
  const { executionId: id } = (await submitted.json()) as { executionId: string };

  const first = worker.fetch(cancelRequest(id), live);
  await gate.waitForArrivals(1);
  const second = worker.fetch(cancelRequest(id), live);
  await gate.waitForArrivals(2);

  // The winner runs to terminal Cancelled before the loser proceeds.
  gate.release(0);
  await waitFor(async () => (await rowStatus(id)) === "Cancelled", "terminal cancel");
  gate.release(1);
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 409]);
  const bodies = await Promise.all([firstResponse.json(), secondResponse.json()]);
  expect(bodies).toContainEqual(
    expect.objectContaining({ error: expect.objectContaining({ code: "EXECUTION_NOT_CANCELLABLE" }) }),
  );
});
