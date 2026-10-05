// SPDX-License-Identifier: AGPL-3.0
// RUN-01 persisted per-Saga runtime policy (ADR 018): operator inspect/change
// independent of Saga source, applied-policy snapshots on Execution detail,
// and enforcement of timeout/retry/admission plus stale fencing and recovery.
// All gates run in real workerd with real D1/Workflow bindings; only outbound
// vendor HTTP is mocked.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import {
  checkpointRetryLimit,
  DEFAULT_SAGA_POLICY,
  digestSaga,
  echoSaga,
  ECHO_INTEGRATION_ID,
  executionId,
  helloSaga,
  parseInput,
  parseSagaPolicy,
  parseSubmission,
  POLICY_VERSION,
  stepRetryLimit,
  vendorDeadlineMs,
  vendorRetryLimit,
} from "../src/domain";
import {
  loadExecutionPolicy,
  loadSagaPolicy,
  parseStoredPolicy,
  policySnapshot,
  storeSagaPolicy,
} from "../src/executions";
import { integrationOperation, prepareInput } from "../src/saga-helpers";
import type { SagaEventContext } from "../src/saga";
import { echoSagaDef } from "../src/sagas/echo";
import { retryLimitForStep } from "../src/saga";
import { buildCatalog, defineSaga } from "../src/saga";
import { parseRuntimePolicy } from "../src/sdk";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN = "a".repeat(64);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
function submitRequest(key: string, sagaId: string = echoSaga.id, input: unknown = { message: "hello" }) {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: { ...auth, "Idempotency-Key": key },
    body: JSON.stringify({ sagaId, input }),
  });
}
function detailRequest(id: string) {
  return new Request(`https://local.test/api/executions/${id}`, { method: "GET", headers: { ...auth } });
}
function policyGet(sagaId: string) {
  return new Request(`https://local.test/api/sagas/${sagaId}/policy`, { method: "GET", headers: { ...auth } });
}
function policyPut(sagaId: string, body: unknown, headers: Record<string, string> = auth) {
  return new Request(`https://local.test/api/sagas/${sagaId}/policy`, {
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
useWorkflowHarness(bindings.DB);

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
  it("serves the default policy to any caller and gates writes to Organization admins", async () => {
    const got = await worker.fetch(policyGet(echoSaga.id), bindings);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      policy: { sagaId: echoSaga.id, sagaName: "echo", version: 1, admission: { enabled: true } },
    });
    // A member cannot forge operator authority through a request header.
    const memberId = "00000000-0000-4000-8000-000000000099";
    const stamp = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(memberId, stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'member','active','ordinary',?,?)",
    )
      .bind(principal.orgId, memberId, stamp, stamp)
      .run();
    const memberBindings = { ...bindings, LAB_USER_ID: memberId, LAB_FIXTURE_USER_ID: principal.userId };
    const denied = await worker.fetch(
      policyPut(echoSaga.id, { admission: { enabled: false } }, { ...auth, "X-Operator": "allow-policy-write" }),
      memberBindings,
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "ADMIN_ONLY" } });
    // Unknown Sagas 404, never a leak.
    expect((await worker.fetch(policyGet("395e15f0-3627-41f6-8922-008ce37e3b00"), bindings)).status).toBe(404);
    // Bad bodies reject without writing.
    const bad = await worker.fetch(policyPut(echoSaga.id, { retry: { vendorRetries: 9 } }), bindings);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "INVALID_POLICY" } });
    // Organization-admin merge: partial bodies merge, version bumps per write.
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
    const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
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
    const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
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
      new Request(`https://local.test/api/executions/${firstId}/cancel`, { method: "POST", headers: { ...auth } }),
      bindings,
    );
    expect(cancelled.status).toBe(200);
    await waitForExecutionStatus(firstId, "Cancelled");
    // Re-cancel of the terminal row is rejected, not resurrected.
    expect(
      (
        await worker.fetch(
          new Request(`https://local.test/api/executions/${firstId}/cancel`, { method: "POST", headers: { ...auth } }),
          bindings,
        )
      ).status,
    ).toBe(409);
  }, 25000);
  it("keeps stale fencing and recovery: late checkpoints no-op, expired windows never resurrect", async () => {
    const key = "run01-stale-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
    mockEcho(async () => Response.json({ message: "hello" }));
    expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
    await instance.waitForStatus("complete");
    await waitForExecutionStatus(id, "Succeeded");
    // A terminal row never advances, even under a racing checkpoint shape:
    // repeated cancel 409s and detail keeps the snapshot.
    expect(
      (
        await worker.fetch(
          new Request(`https://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } }),
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
      new Request(`https://local.test/api/executions/${stuckId}/cancel`, { method: "POST", headers: { ...auth } }),
      bindings,
    );
    expect(cancelled.status).toBe(200);
    await waitForExecutionStatus(stuckId, "Cancelled");
    // CompletedWithErrors: a `{success:false}`-shaped vendor outcome is a
    // structured Failed with its safe code, never invented success.
    const failedKey = "run01-cwe-000001";
    const failedId = await executionId(principal, failedKey);
    const { inner: failed } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, failedId);
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

describe("RUN-01 Slice B long-wait lifetime + timeout=0 (issue #135)", () => {
  // Upstream ca669e3 invariant in Cloudflare-native shape:
  // timeout.vendorTimeoutMs = 0 keeps the Integration default — it is NOT
  // upstream's no-execution-timeout — and an Execution that waits past short
  // request/vendor windows keeps the authority it started with (stamped
  // snapshot, org Connection, D1 terminal gates) across sleep/resume and
  // mid-flight operator edits. Real workerd Workflows + D1; only vendor HTTP
  // is mocked.
  it("treats timeout=0 as the Integration default, not no-timeout", async () => {
    expect((await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 0 } }), bindings)).status).toBe(
      200,
    );
    const key = "run01-sliceb-zero-0001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
    // The vendor answers at ~1200ms: past the 1000ms echo default, so a
    // no-timeout reading of 0 would succeed while the Integration-default
    // reading surfaces ECHO_VENDOR_TIMEOUT through failSagaExecution.
    mockEcho(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return Response.json({ message: "hello" });
    });
    expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
    await instance.waitForStatus("errored");
    const detail = (await (await worker.fetch(detailRequest(id), bindings)).json()) as {
      status: string;
      error: { code: string };
      policy: { policy: { timeout: { vendorTimeoutMs: number } } };
    };
    expect(detail).toMatchObject({ status: "TimedOut", error: { code: "ECHO_VENDOR_TIMEOUT" } });
    expect(detail.policy.policy.timeout.vendorTimeoutMs).toBe(0);
  }, 20000);
  it("keeps snapshot authority across a wait past the default window despite a mid-flight edit", async () => {
    const set = await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 5000 } }), bindings);
    expect(set.status).toBe(200);
    const key = "run01-sliceb-wait-00001";
    const id = await executionId(principal, key);
    const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
    // Slow vendor: answers at ~1200ms, past the 1000ms Integration default.
    // The 5000ms snapshot stamped at submit must govern the whole wait; the
    // mid-flight edit to 50ms below must not rewrite in-flight behavior, and
    // the post-sleep terminal persist still runs under the original snapshot.
    mockEcho(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return Response.json({ message: "hello" });
    });
    const started = Date.now();
    expect((await worker.fetch(submitRequest(key), bindings)).status).toBe(202);
    const edited = await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 50 } }), bindings);
    expect(edited.status).toBe(200);
    await instance.waitForStatus("complete");
    await waitForExecutionStatus(id, "Succeeded");
    // The ~1200ms vendor wait plus the 1s native settle-wait run sequentially,
    // so reaching terminal in under ~2s would mean the sleep was skipped.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    const detail = (await (await worker.fetch(detailRequest(id), bindings)).json()) as {
      status: string;
      policy: { policy: { timeout: { vendorTimeoutMs: number } }; version: number };
    };
    expect(detail).toMatchObject({ status: "Succeeded", policy: { policy: { timeout: { vendorTimeoutMs: 5000 } } } });
    // Reset the live row so later suites start from defaults.
    await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 0 } }), bindings);
  }, 25000);
});

describe("RUN-01 saga submission still parses (identity intact)", () => {
  it("keeps stable IDs and catalog discovery untouched by policy", () => {
    expect(parseSubmission({ sagaId: echoSaga.id, input: { message: "hi" } }).saga.id).toBe(echoSaga.id);
    expect(echoSaga.revision).toBe("echo-v1");
  });
});

describe("RUN-01 Slice A fail-closed loader (issue #135)", () => {
  const someId = "f".repeat(64);
  // Minimal D1 doubles: the loader only uses prepare/bind/first.
  function fakeDb(firstImpl: () => Promise<unknown>): D1Database {
    return {
      prepare: () => ({ bind: () => ({ first: firstImpl }) }),
    } as unknown as D1Database;
  }
  function throwingDb(message: string): D1Database {
    return fakeDb(() => {
      throw new Error(message);
    });
  }

  it("keeps the legacy NULL snapshot on code defaults", async () => {
    await expect(
      loadExecutionPolicy(
        fakeDb(async () => ({ policy_json: null })),
        someId,
      ),
    ).resolves.toEqual(DEFAULT_SAGA_POLICY);
  });

  it("rejects unknown Executions instead of inventing a policy", async () => {
    await expect(
      loadExecutionPolicy(
        fakeDb(async () => null),
        someId,
      ),
    ).rejects.toThrow(/Unknown Execution/);
  });

  it("returns the stamped snapshot, failing closed on corrupt JSON to defaults", async () => {
    const custom = policySnapshot(parseSagaPolicy({ timeout: { vendorTimeoutMs: 250 } }));
    await expect(
      loadExecutionPolicy(
        fakeDb(async () => ({ policy_json: custom })),
        someId,
      ),
    ).resolves.toMatchObject({
      timeout: { vendorTimeoutMs: 250 },
    });
    await expect(
      loadExecutionPolicy(
        fakeDb(async () => ({ policy_json: "not-json" })),
        someId,
      ),
    ).resolves.toEqual(DEFAULT_SAGA_POLICY);
  });

  it("never conflates a D1 read failure with a missing snapshot", async () => {
    // A genuine read failure propagates: the caller must fail or retry
    // before running Saga/vendor work, never execute under defaults.
    await expect(loadExecutionPolicy(throwingDb("D1_UNAVAILABLE_SIM"), someId)).rejects.toThrow(/D1_UNAVAILABLE_SIM/);
    // A pre-migration database without the column keeps the legacy default.
    await expect(loadExecutionPolicy(throwingDb("D1_ERROR: no such column: policy_json"), someId)).resolves.toEqual(
      DEFAULT_SAGA_POLICY,
    );
  });

  it("recovers onto the original non-default snapshot after a transient read failure", async () => {
    const custom = policySnapshot(parseSagaPolicy({ timeout: { vendorTimeoutMs: 250 } }));
    let calls = 0;
    const flaky = fakeDb(async () => {
      calls += 1;
      if (calls === 1) throw new Error("D1_UNAVAILABLE_SIM");
      return { policy_json: custom };
    });
    await expect(loadExecutionPolicy(flaky, someId)).rejects.toThrow(/D1_UNAVAILABLE_SIM/);
    await expect(loadExecutionPolicy(flaky, someId)).resolves.toMatchObject({
      timeout: { vendorTimeoutMs: 250 },
    });
  });

  it("fails submit-time policy loading closed except on a missing table", async () => {
    await expect(
      loadSagaPolicy(throwingDb("D1_ERROR: no such table: saga_policies"), principal.orgId, echoSaga.id),
    ).resolves.toMatchObject({ policy: DEFAULT_SAGA_POLICY });
    await expect(loadSagaPolicy(throwingDb("D1_UNAVAILABLE_SIM"), principal.orgId, echoSaga.id)).rejects.toThrow(
      /D1_UNAVAILABLE_SIM/,
    );
  });
});

describe("RUN-01 Slice A submit-time fail-closed (workerd, issue #135)", () => {
  // Throw for one SELECT shape while delegating every other statement to the
  // real binding, so the failure is a read fault, not a broken database.
  function selectiveFailure(matcher: RegExp, message: string): D1Database {
    const real = bindings.DB;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === "string" && matcher.test(sql)) throw new Error(message);
            return (target.prepare as (...args: unknown[]) => unknown)(sql, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("refuses to dispatch when the policy read fails: 500, no receipt mutation, zero vendor calls", async () => {
    const vendor = mockEcho(async () => Response.json({ message: "hello" }));
    const key = "run01-slicea-submitfail-001";
    const failing = { ...bindings, DB: selectiveFailure(/FROM saga_policies/, "D1_UNAVAILABLE_SIM") };
    const refused = await worker.fetch(submitRequest(key), failing);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    // The refusal lands before the Execution insert: no receipt to replay.
    const row = await bindings.DB.prepare("SELECT id,dispatched FROM executions WHERE id=?")
      .bind(await executionId(principal, key))
      .first<{ id: string; dispatched: number }>();
    expect(row).toBeNull();
    expect(vendor).not.toHaveBeenCalled();
    // Recovery uses the live policy surface, not an invented default: a
    // normal submit right after still dispatches under operator policy.
    const set = await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 5000 } }), bindings);
    expect(set.status).toBe(200);
    await worker.fetch(policyPut(echoSaga.id, { timeout: { vendorTimeoutMs: 0 } }), bindings);
  });

  it("refuses to over-admit when the admission count fails, keeping the stamped snapshot", async () => {
    await worker.fetch(policyPut(echoSaga.id, { admission: { maxConcurrent: 1 } }), bindings);
    const firstKey = "run01-slicea-countfail-01";
    const firstId = await executionId(principal, firstKey);
    // Never-settling vendor: the first Execution stays active to hold the slot.
    const vendor = mockEcho(() => new Promise<Response>(() => {}));
    expect((await worker.fetch(submitRequest(firstKey), bindings)).status).toBe(202);
    await waitForExecutionStatus(firstId, "Running");
    // A blind count fault must not read as zero and admit a second Execution.
    const failing = { ...bindings, DB: selectiveFailure(/COUNT\(\*\)/, "D1_UNAVAILABLE_SIM") };
    const refused = await worker.fetch(submitRequest("run01-slicea-countfail-02"), failing);
    expect(refused.status).toBe(500);
    expect(vendor).toHaveBeenCalledTimes(1);
    // The held Execution keeps its original non-default snapshot after the
    // fault: recovery replays stored behavior, never re-derived defaults.
    expect((await loadExecutionPolicy(bindings.DB, firstId)).admission.maxConcurrent).toBe(1);
    const cancelled = await worker.fetch(
      new Request(`https://local.test/api/executions/${firstId}/cancel`, { method: "POST", headers: { ...auth } }),
      bindings,
    );
    expect(cancelled.status).toBe(200);
    await waitForExecutionStatus(firstId, "Cancelled");
    await worker.fetch(policyPut(echoSaga.id, { admission: { maxConcurrent: 0 } }), bindings);
  }, 25000);
});

describe("RUN-01 Slice A execution-time fail-closed (workerd, issue #135)", () => {
  it("fails before any vendor work when the snapshot read fails", async () => {
    const id = "e".repeat(64);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        echoSaga.id,
        echoSaga.name,
        echoSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ message: "hello" }),
        1,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const realCtx = { executionId: id, db: bindings.DB } as SagaEventContext;
    // A stale row (NULL snapshot) still runs under code defaults: legacy.
    const prepared = await prepareInput(realCtx, echoSaga, parseInput);
    const real = bindings.DB;
    const failingDb = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === "string" && sql.includes("policy_json")) throw new Error("D1_UNAVAILABLE_SIM");
            return (target.prepare as (...args: unknown[]) => unknown)(sql, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingCtx = { executionId: id, db: failingDb } as SagaEventContext;
    const vendorCall = vi.fn(async () => ({ message: "hello" }));
    await expect(
      integrationOperation(failingCtx, echoSagaDef, prepared, {
        op: "echo-http-v1",
        position: 1,
        integrationId: ECHO_INTEGRATION_ID,
        vendorDefaultMs: 1000,
        failureCode: "ECHO_INTEGRATION_FAILED",
        failureMessage: "The echo Integration could not complete.",
        call: vendorCall,
      }),
    ).rejects.toThrow(/D1_UNAVAILABLE_SIM/);
    expect(vendorCall).not.toHaveBeenCalled();
  });
});

describe("RUN-01 Slice C lost-runtime-history convergence (issue #135)", () => {
  // Upstream e9b66020 invariant in Cloudflare-native shape: terminal
  // processing converges from authoritative D1 when ephemeral native Workflow
  // history/status is missing or unavailable. No native instance is ever
  // dispatched below, so the real local Workflow binding has nothing to
  // report and detail must serve stored D1 state with advisory runtimeStatus
  // null — never invented success, never a D1 rewrite, fences intact. Only
  // outbound vendor HTTP is mocked, to assert zero calls.
  async function seedTerminalExecution(options: { key: string; status: "Succeeded" | "Failed" }): Promise<string> {
    const id = await executionId(principal, options.key);
    const now = new Date().toISOString();
    const terminal = options.status === "Succeeded";
    const outcomeJson = terminal
      ? JSON.stringify({ message: "hello" })
      : JSON.stringify({
          code: "ECHO_INTEGRATION_FAILED",
          message: "The echo Integration could not complete.",
        });
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,started_at,completed_at,result_json,error_json,policy_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        echoSaga.id,
        echoSaga.name,
        echoSaga.revision,
        principal.orgId,
        principal.userId,
        JSON.stringify({ message: "hello" }),
        1,
        options.status,
        now,
        now,
        now,
        terminal ? outcomeJson : null,
        terminal ? null : outcomeJson,
        policySnapshot(parseSagaPolicy({ timeout: { vendorTimeoutMs: 250 } })),
      )
      .run();
    await bindings.DB.prepare(
      "INSERT INTO operations(execution_id,name,position,status,started_at,completed_at,result_json,error_json) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(id, "prepare-input-v1", 0, "Succeeded", now, now, JSON.stringify({ message: "hello" }), null)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO operations(execution_id,name,position,status,started_at,completed_at,result_json,error_json) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        "echo-http-v1",
        1,
        options.status,
        now,
        now,
        terminal ? outcomeJson : null,
        terminal ? null : outcomeJson,
      )
      .run();
    return id;
  }
  function cancelRequest(id: string) {
    return new Request(`https://local.test/api/executions/${id}/cancel`, { method: "POST", headers: { ...auth } });
  }

  it("serves terminal Succeeded history from D1 with advisory null runtime and keeps every fence", async () => {
    const vendor = mockEcho(async () => Response.json({ message: "hello" }));
    const key = "run01-slicec-succeeded-001";
    const id = await seedTerminalExecution({ key, status: "Succeeded" });
    const detail = await worker.fetch(detailRequest(id), bindings);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      executionId: id,
      status: "Succeeded",
      dispatchConfirmed: true,
      runtimeStatus: null,
      result: { message: "hello" },
      error: null,
      policy: { sagaId: echoSaga.id, version: 1, policy: { timeout: { vendorTimeoutMs: 250 } } },
      operations: [
        { name: "prepare-input-v1", status: "Succeeded" },
        { name: "echo-http-v1", status: "Succeeded" },
      ],
    });
    // Read-only convergence: missing native history rewrites nothing.
    const stored = await bindings.DB.prepare("SELECT status,dispatched,result_json FROM executions WHERE id=?")
      .bind(id)
      .first<{ status: string; dispatched: number; result_json: string }>();
    expect(stored).toMatchObject({
      status: "Succeeded",
      dispatched: 1,
      result_json: JSON.stringify({ message: "hello" }),
    });
    // Idempotency fence: same-key replay converges without redispatch or vendor work.
    const replay = await worker.fetch(submitRequest(key), bindings);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ executionId: id, replayed: true });
    expect(vendor).not.toHaveBeenCalled();
    // Cancel fence: terminal rows answer 409 and are never rewritten.
    const cancelled = await worker.fetch(cancelRequest(id), bindings);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: { code: "EXECUTION_NOT_CANCELLABLE" } });
    const after = (await (await worker.fetch(detailRequest(id), bindings)).json()) as { status: string };
    expect(after.status).toBe("Succeeded");
  }, 20000);

  it("serves terminal Failed history from D1 with advisory null runtime and keeps every fence", async () => {
    const vendor = mockEcho(async () => Response.json({ message: "hello" }));
    const key = "run01-slicec-failed-0001";
    const id = await seedTerminalExecution({ key, status: "Failed" });
    const detail = await worker.fetch(detailRequest(id), bindings);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      executionId: id,
      status: "Failed",
      dispatchConfirmed: true,
      runtimeStatus: null,
      result: null,
      error: { code: "ECHO_INTEGRATION_FAILED", message: "The echo Integration could not complete." },
      policy: { sagaId: echoSaga.id, version: 1, policy: { timeout: { vendorTimeoutMs: 250 } } },
      operations: [
        { name: "prepare-input-v1", status: "Succeeded" },
        { name: "echo-http-v1", status: "Failed" },
      ],
    });
    const stored = await bindings.DB.prepare("SELECT status,dispatched,error_json FROM executions WHERE id=?")
      .bind(id)
      .first<{ status: string; dispatched: number; error_json: string }>();
    expect(stored?.status).toBe("Failed");
    expect(stored?.dispatched).toBe(1);
    expect(JSON.parse(stored?.error_json ?? "")).toEqual({
      code: "ECHO_INTEGRATION_FAILED",
      message: "The echo Integration could not complete.",
    });
    const replay = await worker.fetch(submitRequest(key), bindings);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ executionId: id, replayed: true });
    expect(vendor).not.toHaveBeenCalled();
    const cancelled = await worker.fetch(cancelRequest(id), bindings);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: { code: "EXECUTION_NOT_CANCELLABLE" } });
    const after = (await (await worker.fetch(detailRequest(id), bindings)).json()) as { status: string };
    expect(after.status).toBe("Failed");
  }, 20000);
});
