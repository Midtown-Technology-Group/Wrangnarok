// SPDX-License-Identifier: AGPL-3.0
// RUN-03 (issue #150, ADR 023): bounded synchronous and data-provider
// execution. Runs in real workerd via @cloudflare/vitest-plugin; D1
// bindings are never replaced, only outbound vendor HTTP is intercepted.
// A client-side poll is never represented as server sync parity: the
// provider route returns inline results, the async route returns receipts.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import {
  digestSaga,
  echoSaga,
  ECHO_INTEGRATION_ID,
  executionId,
  Fault,
  helloSaga,
  ninjaSaga,
  smokeSaga,
} from "../src/domain";
import {
  isProviderEligible,
  mapActionError,
  parseProviderSubmission,
  PROVIDER_DEADLINE_MS,
  runProvider,
} from "../src/sync";
import { resolveSubmissionSaga } from "../src/domain";
import { createSdkClient, parseProviderOutcome } from "../src/sdk";
import migration from "../migrations/0001_initial.sql?raw";
import migrationCancelling from "../migrations/0002_cancelling.sql?raw";
import migrationPolicies from "../migrations/0012_saga_policies.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const TOKEN = "a".repeat(64);
const TOKEN_SENTINEL = "test-access-token-sentinel";

function providerRequest(sagaId: string, input: unknown, key: string, extra: Record<string, unknown> = {}) {
  return new Request("http://local.test/api/executions/provider", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ sagaId, input, ...extra }),
  });
}

function asyncRequest(sagaId: string, input: unknown, key: string, extra: Record<string, unknown> = {}) {
  return new Request("http://local.test/api/executions", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ sagaId, input, ...extra }),
  });
}

function mockNinjaCensus(orgs: unknown, orgsStatus = 200, orgsDelayMs = 0) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return new Response(JSON.stringify({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      if (orgsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, orgsDelayMs));
      return new Response(typeof orgs === "string" ? orgs : JSON.stringify(orgs), {
        status: orgsStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
}

function mockEcho() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://127.0.0.1:8788/echo") throw new Error(`Unexpected outbound request: ${url}`);
    return Response.json({ message: "sync-proof" });
  });
}

beforeEach(async () => {
  await bindings.DB.exec(migration);
  await bindings.DB.exec(migrationCancelling);
  await bindings.DB.exec(migrationPolicies);
  await bindings.DB.exec(seed);
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(
      "00000000-0000-4000-8000-000000000102",
      principal.orgId,
      "0606e237-137b-4629-8346-85468e1c2df6",
      "https://ninja-in-test.invalid/api",
    )
    .run();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("provider eligibility (ADR 023 closed allowlist)", () => {
  it("admits only read-only provider Sagas, never caller choice", () => {
    expect(isProviderEligible(ninjaSaga.id)).toBe(true);
    expect(isProviderEligible(echoSaga.id)).toBe(true);
    expect(isProviderEligible(digestSaga.id)).toBe(false);
    expect(isProviderEligible(smokeSaga.id)).toBe(false);
    expect(isProviderEligible(helloSaga.id)).toBe(false);
    expect(isProviderEligible("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("rejects malformed provider bodies and unknown Sagas before admission", () => {
    expect(() => parseProviderSubmission(null, resolveSubmissionSaga)).toThrow(/built-in Saga ID/);
    expect(() => parseProviderSubmission({ sagaId: ninjaSaga.id, input: {}, extra: 1 }, resolveSubmissionSaga)).toThrow(
      /built-in Saga ID/,
    );
    expect(() =>
      parseProviderSubmission({ sagaId: "00000000-0000-4000-8000-000000000000", input: {} }, resolveSubmissionSaga),
    ).toThrow(/built-in Saga ID/);
    const parsed = parseProviderSubmission(
      { sagaId: ninjaSaga.id, input: {}, sync: true, transient: false },
      resolveSubmissionSaga,
    );
    expect(parsed.saga.id).toBe(ninjaSaga.id);
    expect(parsed.rejected).toEqual({ sync: true, transient: false });
    // Non-object bodies, wrong-typed sagaId, and bad input all fail closed
    // before admission touches D1.
    for (const bad of [[], "nope", { sagaId: 7, input: {} }, { input: {} }]) {
      expect(() => parseProviderSubmission(bad, resolveSubmissionSaga)).toThrow(/built-in Saga ID/);
    }
    expect(() =>
      parseProviderSubmission({ sagaId: echoSaga.id, input: { message: 7 } }, resolveSubmissionSaga),
    ).toThrow(/message/);
    expect(
      parseProviderSubmission({ sagaId: echoSaga.id, input: { message: "x" } }, resolveSubmissionSaga).rejected,
    ).toEqual({});
    // A resolver that throws still answers UNKNOWN_SAGA, never a leak.
    expect(() =>
      parseProviderSubmission({ sagaId: ninjaSaga.id, input: {} }, () => {
        throw new Error("resolver down");
      }),
    ).toThrow(/built-in Saga ID/);
    // Direct mapping table: Fault timeouts, Fault failures, deadline aborts,
    // and unexpected throws each map distinctly.
    const probe = "f".repeat(64);
    expect(mapActionError(new Fault(504, "ECHO_VENDOR_TIMEOUT", "slow"), probe)).toMatchObject({
      ok: false,
      timedOut: true,
    });
    expect(mapActionError(new Fault(502, "NINJA_VENDOR_FAILED", "down"), probe)).toMatchObject({
      ok: false,
      timedOut: false,
    });
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(mapActionError(abort, probe)).toMatchObject({ ok: false, timedOut: true });
    expect(mapActionError(new Error("transport exploded"), probe)).toMatchObject({
      ok: false,
      timedOut: false,
      error: { code: "EXECUTION_FAILED" },
    });
    expect(mapActionError("string failure", probe)).toMatchObject({
      ok: false,
      timedOut: false,
      error: { code: "EXECUTION_FAILED" },
    });
  });

  it("covers paused admission, cancelled keys, and racing cancel markers", async () => {
    mockNinjaCensus([{ id: 1, name: "Acme" }]);
    // Paused admission fences before any vendor call.
    await bindings.DB.prepare(
      "INSERT INTO saga_policies(org_id,saga_id,policy_json,version,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(org_id,saga_id) DO UPDATE SET policy_json=excluded.policy_json",
    )
      .bind(
        principal.orgId,
        ninjaSaga.id,
        JSON.stringify({
          version: 1,
          policy: {
            timeout: { vendorTimeoutMs: 0, stepTimeout: "10 seconds" },
            retry: { checkpointRetries: 2, vendorRetries: 0 },
            admission: { enabled: false, maxConcurrent: 0 },
          },
        }),
        1,
        new Date().toISOString(),
      )
      .run();
    const paused = await worker.fetch(providerRequest(ninjaSaga.id, {}, "run-03-provider-paused-001"), bindings);
    expect(paused.status).toBe(409);
    expect(await paused.json()).toMatchObject({ error: { code: "SAGA_PAUSED" } });
    await bindings.DB.prepare("DELETE FROM saga_policies WHERE org_id=? AND saga_id=?")
      .bind(principal.orgId, ninjaSaga.id)
      .run();
    // A cancelled key never dispatches inline.
    const cancelledKey = "run-03-provider-cancelled-001";
    const cancelledId = await executionId(principal, cancelledKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        cancelledId,
        ninjaSaga.id,
        "ninjaone-orgs",
        "ninjaone-orgs-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({}),
        0,
        "Cancelled",
        new Date().toISOString(),
      )
      .run();
    const cancelled = await worker.fetch(providerRequest(ninjaSaga.id, {}, cancelledKey), bindings);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: { code: "EXECUTION_CANCELLED" } });
    // Same-key replay while a previous call sits Pending answers
    // PROVIDER_IN_FLIGHT with the durable receipt path, never a fork.
    const flightKey = "run-03-provider-inflight-001";
    const flightId = await executionId(principal, flightKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        flightId,
        ninjaSaga.id,
        "ninjaone-orgs",
        "ninjaone-orgs-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({}),
        0,
        "Pending",
        new Date().toISOString(),
      )
      .run();
    const flight = await worker.fetch(providerRequest(ninjaSaga.id, {}, flightKey), bindings);
    expect(flight.status).toBe(409);
    expect(await flight.json()).toMatchObject({ error: { code: "PROVIDER_IN_FLIGHT" } });
    // The route fences eligibility before runProvider, so the module fence
    // is covered directly: no D1 write, no vendor call.
    const digestDef = resolveSubmissionSaga(digestSaga.id);
    if (!digestDef) throw new Error("digest Saga missing from catalog");
    await expect(runProvider(bindings, principal, "run-03-direct-fence-0001", digestDef, {})).rejects.toMatchObject({
      code: "PROVIDER_NOT_SUPPORTED",
    });
    // A racing owner cancel between the read and the Running-mark write
    // answers EXECUTION_CANCELLED, never an inline dispatch.
    const raceKey = "run-03-provider-race-cancel-01";
    const raceId = await executionId(principal, raceKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        raceId,
        ninjaSaga.id,
        "ninjaone-orgs",
        "ninjaone-orgs-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({}),
        0,
        "Cancelling",
        new Date().toISOString(),
      )
      .run();
    const race = await worker.fetch(providerRequest(ninjaSaga.id, {}, raceKey), bindings);
    expect(race.status).toBe(409);
    expect(await race.json()).toMatchObject({ error: { code: "EXECUTION_CANCELLED" } });
    // A cancel that lands between the Running-mark write and the Action —
    // simulated by calling runProvider against a row that is already
    // Cancelling but reads as active through the replay check — still fences
    // at the conditional mark: the row below is Cancelling with dispatched=1
    // (an inline run started, then the owner cancelled), so the
    // Running-mark no-ops and the direct call answers EXECUTION_CANCELLED.
    const markerKey = "run-03-provider-marker-cancel-01";
    const markerId = await executionId(principal, markerKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        markerId,
        ninjaSaga.id,
        "ninjaone-orgs",
        "ninjaone-orgs-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({}),
        1,
        "Cancelling",
        new Date().toISOString(),
      )
      .run();
    const ninjaDef = resolveSubmissionSaga(ninjaSaga.id);
    if (!ninjaDef) throw new Error("ninja Saga missing from catalog");
    await expect(runProvider(bindings, principal, markerKey, ninjaDef, {})).rejects.toMatchObject({
      code: "EXECUTION_CANCELLED",
    });
    // A Cancelled row at the Running-mark write answers EXECUTION_CANCELLED
    // through the second fence arm (the admission fence above covers the
    // first arm; the marker row below is Cancelling for that arm).
    const markerCancelledKey = "run-03-provider-marker-cancelled-01";
    const markerCancelledId = await executionId(principal, markerCancelledKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        markerCancelledId,
        ninjaSaga.id,
        "ninjaone-orgs",
        "ninjaone-orgs-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({}),
        1,
        "Cancelled",
        new Date().toISOString(),
      )
      .run();
    await expect(runProvider(bindings, principal, markerCancelledKey, ninjaDef, {})).rejects.toMatchObject({
      code: "EXECUTION_CANCELLED",
    });
    // A terminal row racing the Running-mark write serves its receipt.
    const racedKey = "run-03-provider-raced-0001";
    const racedId = await executionId(principal, racedKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        racedId,
        ninjaSaga.id,
        "ninjaone-orgs",
        "ninjaone-orgs-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({}),
        1,
        "Succeeded",
        new Date().toISOString(),
        JSON.stringify({ organizationCount: 0, organizations: [] }),
      )
      .run();
    const raced = await worker.fetch(providerRequest(ninjaSaga.id, {}, racedKey), bindings);
    expect(raced.status).toBe(200);
    expect(await raced.json()).toMatchObject({ status: "Succeeded" });
    // A Running row at the mark write returns the live receipt: the
    // conditional mark no-ops (row is not Pending) and the re-read serves
    // the current row instead of dispatching a second inline run.
    const runningKey = "run-03-provider-running-mark-01";
    const runningId = await executionId(principal, runningKey);
    await bindings.DB.prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        runningId,
        ninjaSaga.id,
        "ninjaone-orgs",
        "ninjaone-orgs-v1",
        principal.orgId,
        principal.userId,
        JSON.stringify({}),
        1,
        "Running",
        new Date().toISOString(),
      )
      .run();
    const running = await worker.fetch(providerRequest(ninjaSaga.id, {}, runningKey), bindings);
    expect(running.status).toBe(409);
    expect(await running.json()).toMatchObject({ error: { code: "PROVIDER_IN_FLIGHT" } });
  });
});

describe("inline provider execution (POST /api/executions/provider)", () => {
  it("returns an authorized read-only census inline with the durable receipt", async () => {
    mockNinjaCensus([
      { id: 1, name: "Acme" },
      { id: 2, name: "Globex" },
    ]);
    const key = "run-03-provider-happy-001";
    const id = await executionId(principal, key);
    const response = await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings);
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBe(`/api/executions/${id}`);
    const text = await response.clone().text();
    expect(text).not.toContain(TOKEN_SENTINEL);
    expect(text).not.toContain("test-client-secret-sentinel");
    const body = parseProviderOutcome(JSON.parse(text) as unknown);
    expect(body).toMatchObject({
      executionId: id,
      sagaId: ninjaSaga.id,
      sagaName: "ninjaone-orgs",
      status: "Succeeded",
      dispatch: { inline: true, workflow: false },
      statusUrl: `/api/executions/${id}`,
    });
    expect(body.result).toEqual({
      organizationCount: 2,
      organizations: [
        { id: 1, name: "Acme" },
        { id: 2, name: "Globex" },
      ],
    });
    expect(typeof body.durationMs).toBe("number");
    // The receipt persists: detail shows the same terminal result, and the
    // provider never touched a Workflow binding (no sleeps, no dispatch).
    const detail = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      bindings,
    );
    expect(await detail.json()).toMatchObject({ executionId: id, status: "Succeeded", dispatchConfirmed: true });
    const operations = await bindings.DB.prepare(
      "SELECT name,status FROM operations WHERE execution_id=? ORDER BY name",
    )
      .bind(id)
      .all<{ name: string; status: string }>();
    expect(operations.results).toEqual([
      { name: "prepare-input-v1", status: "Succeeded" },
      { name: "provider-inline-v1", status: "Succeeded" },
    ]);
  });

  it("returns a completed terminal receipt on same-key replay without redispatch", async () => {
    mockNinjaCensus([{ id: 1, name: "Acme" }]);
    const key = "run-03-provider-replay-001";
    const first = await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings);
    expect(first.status).toBe(200);
    const replay = await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "Succeeded" });
    // Terminal replay serves the persisted receipt: no second vendor call.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("answers 409 on same-key different-input and 401/404 on bad callers", async () => {
    mockNinjaCensus([{ id: 1, name: "Acme" }]);
    const key = "run-03-provider-conflict-001";
    expect((await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings)).status).toBe(200);
    const conflict = await worker.fetch(providerRequest(echoSaga.id, { message: "sync-proof" }, key), bindings);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    // Unknown Saga IDs answer UNKNOWN_SAGA, never a leak.
    const unknown = await worker.fetch(
      providerRequest("00000000-0000-4000-8000-000000000000", {}, "run-03-provider-unknown-01"),
      bindings,
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "UNKNOWN_SAGA" } });
    // Missing auth answers 401; query strings stay denied.
    expect(
      (
        await worker.fetch(
          new Request("http://local.test/api/executions/provider", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": "run-03-provider-noauth-01" },
            body: JSON.stringify({ sagaId: ninjaSaga.id, input: {} }),
          }),
          bindings,
        )
      ).status,
    ).toBe(401);
    const queried = await worker.fetch(
      new Request("http://local.test/api/executions/provider?limit=1", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "run-03-provider-query-001",
        },
        body: JSON.stringify({ sagaId: ninjaSaga.id, input: {} }),
      }),
      bindings,
    );
    expect(queried.status).toBe(400);
    expect(await queried.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  });

  it("denies foreign-org callers the Connection without leaking (scope denial)", async () => {
    mockNinjaCensus([{ id: 1, name: "Acme" }]);
    const foreign = await worker.fetch(
      new Request("http://local.test/api/executions/provider", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "run-03-provider-foreign-01",
        },
        body: JSON.stringify({ sagaId: ninjaSaga.id, input: {} }),
      }),
      { ...bindings, LAB_ORG_ID: "00000000-0000-4000-8000-000000000004" },
    );
    // No Connection row for the foreign org: declared-required fails loud.
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toMatchObject({ status: "Failed" });
    const detail = await worker.fetch(
      new Request(
        `http://local.test/api/executions/${await executionId({ orgId: "00000000-0000-4000-8000-000000000004", userId: principal.userId }, "run-03-provider-foreign-01")}`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      ),
      { ...bindings, LAB_ORG_ID: "00000000-0000-4000-8000-000000000004" },
    );
    expect(await detail.json()).toMatchObject({ error: { code: "INTEGRATION_REQUIREMENT_UNSATISFIED" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces vendor failure as a named Failed receipt without vendor bodies", async () => {
    mockNinjaCensus("private-vendor-diagnostic", 503);
    const key = "run-03-provider-failed-001";
    const response = await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "Failed" });
    const text = JSON.stringify(body);
    expect(text).not.toContain("private-vendor-diagnostic");
    const detail = await worker.fetch(
      new Request(`http://local.test/api/executions/${await executionId(principal, key)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      bindings,
    );
    expect(await detail.json()).toMatchObject({ status: "Failed", error: { code: "NINJA_VENDOR_FAILED" } });
  });

  it("routes a vendor-shaped timeout through TimedOut, not generic failure", async () => {
    // Fast vendor-side timeout: the Action maps its own deadline to
    // NINJA_VENDOR_TIMEOUT, which the provider persists as TimedOut.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://ninja-in-test.invalid/oauth/token") {
        return new Response(JSON.stringify({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
        const timeout = new DOMException("aborted", "AbortError");
        throw timeout;
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const key = "run-03-provider-vendor-timeout-01";
    const response = await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings);
    expect(response.status).toBe(504);
    const detail = await worker.fetch(
      new Request(`http://local.test/api/executions/${await executionId(principal, key)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      bindings,
    );
    expect(await detail.json()).toMatchObject({ status: "TimedOut", error: { code: "NINJA_VENDOR_TIMEOUT" } });
  });

  it("times out a slow vendor with 504 and a durable Pending receipt", async () => {
    expect(PROVIDER_DEADLINE_MS).toBe(5000);
    mockNinjaCensus([{ id: 1, name: "Acme" }], 200, PROVIDER_DEADLINE_MS + 2000);
    const key = "run-03-provider-timeout-001";
    const response = await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_TIMEOUT" } });
    const id = await executionId(principal, key);
    const detail = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      bindings,
    );
    // Terminal fence owns the outcome: TimedOut via the provider path, never
    // invented success and never a late overwrite. The persisted code is the
    // inline-deadline code (PROVIDER_TIMEOUT): the Action never resolved, so
    // there is no vendor-shaped timeout to surface.
    expect(await detail.json()).toMatchObject({ status: "TimedOut", error: { code: "PROVIDER_TIMEOUT" } });
  }, 15000);

  it("rejects oversized provider output with 413 and no persisted result", async () => {
    const big = Array.from({ length: 30 }, (_, index) => ({ id: index, name: `org-${"x".repeat(200)}` }));
    mockNinjaCensus(big);
    const key = "run-03-provider-output-001";
    const response = await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_OUTPUT_TOO_LARGE" } });
    const id = await executionId(principal, key);
    const row = await bindings.DB.prepare("SELECT status,result_json FROM executions WHERE id=?")
      .bind(id)
      .first<{ status: string; result_json: string | null }>();
    expect(row?.status).toBe("Failed");
    expect(row?.result_json).toBeNull();
  });

  it("fails an echo provider without its Connection and maps unexpected errors", async () => {
    mockEcho();
    // Delete the seeded echo Connection: declared-required fails loud with
    // no vendor call.
    await bindings.DB.prepare("DELETE FROM connections WHERE org_id=? AND integration_id=?")
      .bind(principal.orgId, ECHO_INTEGRATION_ID)
      .run();
    const missing = await worker.fetch(
      providerRequest(echoSaga.id, { message: "sync-proof" }, "run-03-provider-echo-missing-01"),
      bindings,
    );
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ status: "Failed" });
    // Unexpected (non-Fault, non-timeout) Action errors map to the generic
    // EXECUTION_FAILED receipt, never a leak.
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind("00000000-0000-4000-8000-000000000103", principal.orgId, ECHO_INTEGRATION_ID, "http://127.0.0.1:8788/echo")
      .run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("transport exploded");
    });
    const broken = await worker.fetch(
      providerRequest(echoSaga.id, { message: "sync-proof" }, "run-03-provider-echo-broken-01"),
      bindings,
    );
    expect(broken.status).toBe(200);
    const detail = await worker.fetch(
      new Request(
        `http://local.test/api/executions/${await executionId(principal, "run-03-provider-echo-broken-01")}`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      ),
      bindings,
    );
    expect(await detail.json()).toMatchObject({ status: "Failed", error: { code: "ECHO_INTEGRATION_FAILED" } });
  });

  it("refuses unsafe mutation admission: async-only Sagas answer 501 with the async path", async () => {
    for (const [sagaId, input, key] of [
      [digestSaga.id, {}, "run-03-provider-digest-001"],
      [smokeSaga.id, {}, "run-03-provider-smoke-0001"],
      [helloSaga.id, { name: "Ada" }, "run-03-provider-hello-0001"],
    ] as const) {
      const response = await worker.fetch(providerRequest(sagaId, input, key), bindings);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_NOT_SUPPORTED" } });
    }
    // No vendor traffic: the 501 fires before any Integration Action runs.
    // (fetch is only a spy in suites that install a mock; assert the durable
    // side effect instead — no Execution row was written.)
    const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
    expect(rows?.n ?? 0).toBe(0);
  });

  it("keeps unsupported modes as named exceptions with a migration path", async () => {
    mockEcho();
    // Caller-chosen sync on the async route: 400, never a silent poll.
    const syncFlag = await worker.fetch(
      asyncRequest(echoSaga.id, { message: "sync-proof" }, "run-03-sync-flag-000001", { sync: true }),
      bindings,
    );
    expect(syncFlag.status).toBe(400);
    expect(await syncFlag.json()).toMatchObject({ error: { code: "SYNC_NOT_SUPPORTED" } });
    // Transient on the async route: 501, never silent no-persistence.
    const transientFlag = await worker.fetch(
      asyncRequest(echoSaga.id, { message: "sync-proof" }, "run-03-transient-flag-001", { transient: true }),
      bindings,
    );
    expect(transientFlag.status).toBe(501);
    expect(await transientFlag.json()).toMatchObject({ error: { code: "TRANSIENT_NOT_SUPPORTED" } });
    // Same flags on the provider route: sync is chosen by route, transient
    // never skips persistence.
    const providerSync = await worker.fetch(
      providerRequest(echoSaga.id, { message: "sync-proof" }, "run-03-provider-sync-001", { sync: true }),
      bindings,
    );
    expect(providerSync.status).toBe(400);
    expect(await providerSync.json()).toMatchObject({ error: { code: "SYNC_NOT_SUPPORTED" } });
    const providerTransient = await worker.fetch(
      providerRequest(echoSaga.id, { message: "sync-proof" }, "run-03-provider-trans-001", { transient: true }),
      bindings,
    );
    expect(providerTransient.status).toBe(501);
    expect(await providerTransient.json()).toMatchObject({ error: { code: "TRANSIENT_NOT_SUPPORTED" } });
    // Arbitrary submitted source execution has no route: unknown body keys
    // fail closed on both routes.
    const codeSmuggle = await worker.fetch(
      providerRequest(echoSaga.id, { message: "sync-proof" }, "run-03-provider-code-0001", {
        code: "import os",
      } as unknown as Record<string, unknown>),
      bindings,
    );
    expect(codeSmuggle.status).toBe(400);
    expect(await codeSmuggle.json()).toMatchObject({ error: { code: "INVALID_SUBMISSION" } });
  });

  it("proves the echo fixture inline path and the SDK client against it", async () => {
    mockEcho();
    const key = "run-03-provider-echo-0001";
    const response = await worker.fetch(providerRequest(echoSaga.id, { message: "sync-proof" }, key), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { message: "sync-proof" } });
    const client = createSdkClient({
      base: "https://local.test",
      token: TOKEN,
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
        worker.fetch(
          new Request(input, {
            ...(init ?? {}),
            headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
          }),
          bindings,
        )) as typeof fetch,
    });
    const outcome = await client.runProvider({
      saga: "echo",
      input: { message: "sync-proof" },
      key: "run-03-sdk-provider-0001",
    });
    expect(outcome.status).toBe("Succeeded");
    expect(outcome.result).toEqual({ message: "sync-proof" });
    expect(outcome.dispatch).toEqual({ inline: true, workflow: false });
    await expect(client.runProvider({ saga: "hello", input: { name: "Ada" } })).rejects.toMatchObject({
      code: "PROVIDER_NOT_SUPPORTED",
    });
  });

  it("denies query strings and non-JSON bodies on the provider route", async () => {
    mockEcho();
    // Query strings stay denied by the global gate: routing identity lives
    // in the path only.
    const queried = await worker.fetch(
      new Request("http://local.test/api/executions/provider?window=2026-09-12T09:00", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "run-03-provider-query-001",
        },
        body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "sync-proof" } }),
      }),
      bindings,
    );
    expect(queried.status).toBe(400);
    expect(await queried.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
    // Unencoded bodies stay denied before any admission write.
    const encoded = await worker.fetch(
      new Request("http://local.test/api/executions/provider", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "text/plain",
          "Idempotency-Key": "run-03-provider-415-001",
        },
        body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "sync-proof" } }),
      }),
      bindings,
    );
    expect(encoded.status).toBe(415);
    expect(await encoded.json()).toMatchObject({ error: { code: "JSON_REQUIRED" } });
    const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>();
    expect(rows?.n ?? 0).toBe(0);
  });

  it("cancels an inline terminal receipt through the standard cancel route", async () => {
    mockNinjaCensus([{ id: 1, name: "Acme" }]);
    const key = "run-03-provider-cancel-001";
    const id = await executionId(principal, key);
    expect((await worker.fetch(providerRequest(ninjaSaga.id, {}, key), bindings)).status).toBe(200);
    const cancel = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      bindings,
    );
    // Terminal rows are never rewritten: 409, and the Succeeded result stands.
    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toMatchObject({ error: { code: "EXECUTION_NOT_CANCELLABLE" } });
    const detail = await worker.fetch(
      new Request(`http://local.test/api/executions/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      bindings,
    );
    expect(await detail.json()).toMatchObject({ status: "Succeeded" });
  });
});
