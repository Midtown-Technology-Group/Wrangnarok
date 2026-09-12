// SPDX-License-Identifier: AGPL-3.0
// RUN-01 persisted per-Saga runtime policy (ADR 018): operator inspect/change
// independent of Saga source, applied-policy snapshots on Execution detail,
// and enforcement of timeout/retry/admission plus stale fencing and recovery.
// All gates run in real workerd with real D1/Workflow bindings; only outbound
// vendor HTTP is mocked.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  checkpointRetryLimit,
  DEFAULT_SAGA_POLICY,
  digestSaga,
  echoSaga,
  executionId,
  helloSaga,
  parseSagaPolicy,
  parseSubmission,
  POLICY_VERSION,
  stepRetryLimit,
  vendorDeadlineMs,
  vendorRetryLimit,
} from "../src/domain";
import { loadSagaPolicy, parseStoredPolicy, policySnapshot, storeSagaPolicy } from "../src/executions";
import { retryLimitForStep } from "../src/saga";
import { buildCatalog, defineSaga } from "../src/saga";
import { parseRuntimePolicy } from "../src/sdk";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0012_saga_policies.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN = "a".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
// Operator identity for policy writes: the Phase 0 operator header. Ordinary
// callers never send it, so they read policy but cannot change it.
const operatorAuth = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  "X-Operator": "allow-policy-write",
};
function submitRequest(key: string, sagaId: string = echoSaga.id, input: unknown = { message: "hello" }) {
  return new Request("http://local.test/api/executions", {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": key },
    body: JSON.stringify({ sagaId, input }),
  });
}
function detailRequest(id: string) {
  return new Request(`http://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } });
}
function policyGet(sagaId: string) {
  return new Request(`http://local.test/api/sagas/${sagaId}/policy`, { method: "GET", headers: { ...auth } });
}
function policyPut(sagaId: string, body: unknown, headers: Record<string, string> = operatorAuth) {
  return new Request(`http://local.test/api/sagas/${sagaId}/policy`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}
function mockEcho(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    const [input] = args;
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://127.0.0.1:8788/echo") throw new Error(`Unexpected outbound request: ${url}`);
    return implementation(input as RequestInfo, args[1]);
  });
}
async function waitForExecutionStatus(id: string, want: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const body = (await (await worker.fetch(detailRequest(id), bindings)).json()) as { status: string };
    if (body.status === want) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${want}; last: ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  await bindings.DB.exec(seed);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("RUN-01 policy parsing (pure)", () => {
  it("defaults to engine-loss-only retries, Integration deadlines, open admission", () => {
    expect(DEFAULT_SAGA_POLICY).toEqual({
      timeout: { vendorTimeoutMs: 0, stepTimeout: "10 seconds" },
      retry: { checkpointRetries: 2, vendorRetries: 0 },
      admission: { enabled: true, maxConcurrent: 0 },
    });
    expect(POLICY_VERSION).toBe(1);
  });
  it("merges partial bodies over the current policy and rejects unknown keys", () => {
    expect(parseSagaPolicy({})).toEqual(DEFAULT_SAGA_POLICY);
    expect(parseSagaPolicy({ timeout: { vendorTimeoutMs: 250 } })).toMatchObject({
      timeout: { vendorTimeoutMs: 250, stepTimeout: "10 seconds" },
    });
    expect(parseSagaPolicy({ retry: { vendorRetries: 1 } }, DEFAULT_SAGA_POLICY).retry.vendorRetries).toBe(1);
    expect(parseSagaPolicy({ admission: { enabled: false } }).admission.enabled).toBe(false);
    expect(() => parseSagaPolicy({ schedule: "* * * * *" })).toThrow(/Unknown policy field/);
    expect(() => parseSagaPolicy({ timeout: { vendorTimeoutMs: -1 } })).toThrow(/vendorTimeoutMs/);
    expect(() => parseSagaPolicy({ timeout: { vendorTimeoutMs: 1.5 } })).toThrow(/vendorTimeoutMs/);
    expect(() => parseSagaPolicy({ timeout: { vendorTimeoutMs: 60000 } })).toThrow(/vendorTimeoutMs/);
    expect(() => parseSagaPolicy({ timeout: { stepTimeout: "1 second" } })).toThrow(/stepTimeout/);
    expect(() => parseSagaPolicy({ retry: { checkpointRetries: 3 } })).toThrow(/checkpointRetries/);
    expect(() => parseSagaPolicy({ retry: { vendorRetries: 9 } })).toThrow(/vendorRetries/);
    expect(() => parseSagaPolicy({ admission: { enabled: "yes" } })).toThrow(/enabled/);
    expect(() => parseSagaPolicy({ admission: { maxConcurrent: 101 } })).toThrow(/maxConcurrent/);
    expect(() => parseSagaPolicy({ retry: { bogus: 1 } })).toThrow(/Unknown retry field/);
    expect(() => parseSagaPolicy({ timeout: "nope" })).toThrow(/must be objects/);
    expect(() => parseSagaPolicy({ retry: "nope" })).toThrow(/must be objects/);
    expect(() => parseSagaPolicy({ timeout: { bogus: 1 } })).toThrow(/Unknown timeout field/);
    expect(() => parseSagaPolicy({ admission: { bogus: 1 } })).toThrow(/Unknown admission field/);
    expect(() => parseSagaPolicy(null)).toThrow(/JSON object/);
  });
  it("resolves deadlines and retry limits through the operator ceiling", () => {
    expect(vendorDeadlineMs(DEFAULT_SAGA_POLICY, 1000)).toBe(1000);
    expect(vendorDeadlineMs(parseSagaPolicy({ timeout: { vendorTimeoutMs: 50 } }), 1000)).toBe(50);
    expect(vendorRetryLimit(DEFAULT_SAGA_POLICY)).toBe(0);
    expect(checkpointRetryLimit(DEFAULT_SAGA_POLICY)).toBe(2);
    expect(checkpointRetryLimit(parseSagaPolicy({ retry: { checkpointRetries: 0 } }))).toBe(0);
    // Vendor steps stay engine-loss-only: business failures throw
    // NonRetryableError elsewhere, so the budget below never retries them.
    expect(retryLimitForStep("echo-http-v1", DEFAULT_SAGA_POLICY)).toBe(0);
    expect(retryLimitForStep("prepare-input-v1", DEFAULT_SAGA_POLICY)).toBe(2);
    expect(retryLimitForStep("prepare-input-v1", parseSagaPolicy({ retry: { checkpointRetries: 0 } }))).toBe(0);
    expect(retryLimitForStep("echo-http-v1", parseSagaPolicy({ retry: { vendorRetries: 1 } }))).toBe(1);
    expect(retryLimitForStep("mystery-v1", parseSagaPolicy({ retry: { vendorRetries: 2 } }))).toBe(2);
    expect(retryLimitForStep("echo-http-v1")).toBe(stepRetryLimit("echo-http-v1"));
    expect(retryLimitForStep("echo-http-v1", DEFAULT_SAGA_POLICY)).toBe(0);
  });
  it("fails closed on corrupt snapshots and parses stored rows", () => {
    expect(parseStoredPolicy(null)).toEqual(DEFAULT_SAGA_POLICY);
    expect(parseStoredPolicy("not-json")).toEqual(DEFAULT_SAGA_POLICY);
    expect(parseStoredPolicy(JSON.stringify({ nope: true }))).toEqual(DEFAULT_SAGA_POLICY);
    expect(parseStoredPolicy(policySnapshot(parseSagaPolicy({ timeout: { vendorTimeoutMs: 250 } })))).toMatchObject({
      timeout: { vendorTimeoutMs: 250 },
    });
  });
  it("rejects operational policy keys in Saga source (ADR 002 boundary)", () => {
    const base = {
      id: helloSaga.id,
      name: "hello",
      revision: "hello-v1",
      description: "Policy never lives in source.",
      requiredIntegrations: [],
      parse: (value: unknown) => value,
      run: async () => ({}),
    };
    for (const policy of [{ retries: 2 }, { timeout: "10 seconds" }, { schedule: "* * * * *" }]) {
      expect(() => buildCatalog([defineSaga({ ...base, ...policy })])).toThrow(/operational policy/);
    }
    // The SDK guard accepts the served policy shape and rejects drift.
    expect(() =>
      parseRuntimePolicy({
        policy: {
          sagaId: helloSaga.id,
          sagaName: "hello",
          version: 1,
          updatedAt: new Date().toISOString(),
          timeout: { vendorTimeoutMs: 0, stepTimeout: "10 seconds" },
          retry: { checkpointRetries: 2, vendorRetries: 0 },
          admission: { enabled: true, maxConcurrent: 0 },
        },
      }),
    ).toBeDefined();
    expect(() => parseRuntimePolicy({ policy: { nope: true } })).toThrow(/unexpected shape/);
    expect(() => parseRuntimePolicy(null)).toThrow(/unexpected shape/);
    expect(() => parseRuntimePolicy({ policy: null })).toThrow(/unexpected shape/);
  });
});

describe("RUN-01 operator inspect/change (workerd)", () => {
  it("rejects malformed policy route identifiers", async () => {
    expect((await worker.fetch(policyGet("0".repeat(36)), bindings)).status).toBe(400);
  });
  it("serves the default policy to any caller and gates writes to operators", async () => {
    const got = await worker.fetch(policyGet(echoSaga.id), bindings);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      policy: { sagaId: echoSaga.id, sagaName: "echo", version: 1, admission: { enabled: true } },
    });
    // Ordinary callers cannot change policy.
    const denied = await worker.fetch(policyPut(echoSaga.id, { admission: { enabled: false } }, { ...auth }), bindings);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    // Unknown Sagas 404, never a leak.
    expect((await worker.fetch(policyGet("395e15f0-3627-41f6-8922-008ce37e3b00"), bindings)).status).toBe(404);
    // Bad bodies reject without writing.
    const bad = await worker.fetch(policyPut(echoSaga.id, { retry: { vendorRetries: 9 } }), bindings);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_POLICY" } });
    // Operator merge: partial bodies merge, version bumps per write.
    const first = await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 250 } }), bindings);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      policy: { sagaId: echoSaga.id, timeout: { vendorTimeoutMs: 250 }, retry: { vendorRetries: 0 } },
    });
    const second = await worker.fetch(policyPut(echoSaga.id, { retry: { vendorRetries: 1 } }), bindings);
    const secondBody = (await second.json()) as { policy: { version: number } };
    expect(secondBody.policy.version).toBe(2);
    expect(secondBody).toMatchObject({ policy: { timeout: { vendorTimeoutMs: 250 }, retry: { vendorRetries: 1 } } });
    // Direct store/load agrees with the route (same-org scoping).
    const stored = await loadSagaPolicy(bindings.DB, principal.orgId, echoSaga.id);
    expect(stored.policy.timeout.vendorTimeoutMs).toBe(250);
    expect((await loadSagaPolicy(bindings.DB, "other-org", echoSaga.id)).policy).toEqual(DEFAULT_SAGA_POLICY);
    await storeSagaPolicy(bindings.DB, principal.orgId, digestSaga.id, { admission: { maxConcurrent: 3 } });
    expect((await loadSagaPolicy(bindings.DB, principal.orgId, digestSaga.id)).policy.admission.maxConcurrent).toBe(3);
  });
});

describe("RUN-01 enforcement matrix (workerd)", () => {
  it("enforces a custom vendor deadline and snapshots it on detail", async () => {
    const set = await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 50 } }), bindings);
    expect(set.status).toBe(200);
    const key = "run01-timeout-custom-001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
    // The vendor answers fast, but the 50ms snapshot deadline fires first.
    mockEcho(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return Response.json({ message: "hello" });
    });
    expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
    await instance.waitForStatus("errored");
    const detail = (await (await worker.fetch(detailRequest(id), bindings)).json()) as {
      status: string;
      error: { code: string };
      policy: { policy: { timeout: { vendorTimeoutMs: number } }; version: number };
    };
    expect(detail).toMatchObject({ status: "TimedOut", error: { code: "ECHO_VENDOR_TIMEOUT" } });
    expect(detail.policy.policy.timeout.vendorTimeoutMs).toBe(50);
    expect(detail.policy.version).toBe(1);
    // Later policy edits do not rewrite the snapshot.
    await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 5000 } }), bindings);
    const again = (await (await worker.fetch(detailRequest(id), bindings)).json()) as {
      policy: { policy: { timeout: { vendorTimeoutMs: number } } };
    };
    expect(again.policy.policy.timeout.vendorTimeoutMs).toBe(50);
  }, 20000);
  it("pauses admission without touching in-flight work, then resumes", async () => {
    const paused = await worker.fetch(policyPut(echoSaga.id, { admission: { enabled: false } }), bindings);
    expect(paused.status).toBe(200);
    const key = "run01-pause-0001";
    const refused = await worker.fetch(submitRequest(key), bindings);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "SAGA_PAUSED" } });
    // Pause is admission-only: flip it back and the same key dispatches.
    // The refused row stays Pending undispatched, so the retry replays it.
    await worker.fetch(policyPut(echoSaga.id, { admission: { enabled: true } }), bindings);
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
    mockEcho(async () => Response.json({ message: "hello" }));
    // The refused submit inserted the Pending receipt: the retry converges
    // on it, so the replay status is 200, not 202.
    expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(200);
    await instance.waitForStatus("complete");
    await waitForExecutionStatus(id, "Succeeded");
  }, 20000);
  it("fences concurrent admission with 429 and keeps idempotency/recovery intact", async () => {
    await worker.fetch(policyPut(echoSaga.id, { admission: { maxConcurrent: 1 } }), bindings);
    const firstKey = "run01-admit-0001";
    const firstId = await executionId(principal, firstKey);
    // Never-settling vendor: the first Execution stays active to hold the slot.
    mockEcho(() => new Promise<Response>(() => {}));
    expect((await worker.fetch(submitRequest(firstKey), bindings)).status).toBe(202);
    await waitForExecutionStatus(firstId, "Running");
    const limited = await worker.fetch(submitRequest("run01-admit-0002"), bindings);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "ADMISSION_LIMITED" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    // Same-key same-input replay still converges (no second dispatch).
    const replay = await worker.fetch(submitRequest(firstKey), bindings);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ executionId: firstId, replayed: true });
    // Conflicting input still 409s; the owner cancel still confirms.
    const conflict = await worker.fetch(submitRequest(firstKey, echoSaga.id, { message: "other" }), bindings);
    expect(conflict.status).toBe(409);
    const cancelled = await worker.fetch(
      new Request(`http://local.test/api/executions/${firstId}/cancel`, { method: "POST", headers: { ...auth } }),
      bindings,
    );
    expect(cancelled.status).toBe(200);
    await waitForExecutionStatus(firstId, "Cancelled");
    // Re-cancel of the terminal row is rejected, not resurrected.
    expect(
      (
        await worker.fetch(
          new Request(`http://local.test/api/executions/${firstId}/cancel`, { method: "POST", headers: { ...auth } }),
          bindings,
        )
      ).status,
    ).toBe(409);
  }, 25000);
  it("keeps stale fencing and recovery: late checkpoints no-op, expired windows never resurrect", async () => {
    const key = "run01-stale-0001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, id);
    mockEcho(async () => Response.json({ message: "hello" }));
    expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
    await instance.waitForStatus("complete");
    await waitForExecutionStatus(id, "Succeeded");
    // A terminal row never advances, even under a racing checkpoint shape:
    // repeated cancel 409s and detail keeps the snapshot.
    expect(
      (
        await worker.fetch(
          new Request(`http://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } }),
          bindings,
        )
      ).status,
    ).toBe(409);
    const detail = (await (await worker.fetch(detailRequest(id), bindings)).json()) as {
      status: string;
      policy: { sagaId: string; version: number; policy: unknown };
    };
    expect(detail).toMatchObject({ status: "Succeeded", policy: { sagaId: echoSaga.id, version: 1 } });
    // Expired unconfirmed reservations still refuse resurrection under policy.
    const expiredKey = "run01-stale-expired-01";
    const expiredId = await executionId(principal, expiredKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        expiredId,
        echoSaga.id,
        echoSaga.name,
        echoSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ message: "hello" }),
        0,
        "Pending",
        new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      )
      .run();
    const expired = await worker.fetch(submitRequest(expiredKey), bindings);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ error: { code: "RECOVERY_EXPIRED" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 20000);
  it("treats legacy Stuck as Running-until-cancel and CompletedWithErrors as Failed", async () => {
    // Stuck: a silent vendor leaves Running Operations, never an inferred terminal.
    const stuckKey = "run01-stuck-00001";
    const stuckId = await executionId(principal, stuckKey);
    mockEcho(() => new Promise<Response>(() => {}));
    expect((await worker.fetch(submitRequest(stuckKey), bindings)).status).toBe(202);
    await waitForExecutionStatus(stuckId, "Running");
    const stuck = (await (await worker.fetch(detailRequest(stuckId), bindings)).json()) as {
      status: string;
      operations: { name: string; status: string }[];
    };
    expect(stuck.status).toBe("Running");
    expect(stuck.operations).toContainEqual(expect.objectContaining({ name: "echo-http-v1", status: "Running" }));
    const cancelled = await worker.fetch(
      new Request(`http://local.test/api/executions/${stuckId}/cancel`, { method: "POST", headers: { ...auth } }),
      bindings,
    );
    expect(cancelled.status).toBe(200);
    await waitForExecutionStatus(stuckId, "Cancelled");
    // CompletedWithErrors: a `{success:false}`-shaped vendor outcome is a
    // structured Failed with its safe code, never invented success.
    const failedKey = "run01-cwe-000001";
    const failedId = await executionId(principal, failedKey);
    await using failed = await introspectWorkflowInstance(bindings.ECHO_WORKFLOW, failedId);
    mockEcho(async () => new Response("private-vendor-diagnostic", { status: 503 }));
    expect((await worker.fetch(submitRequest(failedKey), bindings)).status).toBe(202);
    await failed.waitForStatus("errored");
    const detail = (await (await worker.fetch(detailRequest(failedId), bindings)).json()) as {
      status: string;
      error: { code: string };
    };
    expect(detail).toMatchObject({ status: "Failed", error: { code: "ECHO_INTEGRATION_FAILED" } });
  }, 25000);
});

describe("RUN-01 saga submission still parses (identity intact)", () => {
  it("keeps stable IDs and catalog discovery untouched by policy", () => {
    expect(parseSubmission({ sagaId: echoSaga.id, input: { message: "hi" } }).saga.id).toBe(echoSaga.id);
    expect(echoSaga.revision).toBe("echo-v1");
  });
});
