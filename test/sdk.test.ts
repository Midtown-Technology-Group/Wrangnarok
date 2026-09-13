// SPDX-License-Identifier: AGPL-3.0
// DEV-01 (issue #140): versioned SDK contract drift tests plus local
// happy/denied/error examples. Runs in real workerd via
// @cloudflare/vitest-plugin; D1/Workflow bindings are never replaced, only
// outbound vendor HTTP is intercepted. No production deployment.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga } from "../src/domain";
import {
  createSdkClient,
  describeContract,
  inspectSaga,
  localCatalog,
  parseAuditPage,
  parseExecutionDetail,
  parseFormDetail,
  parseFormList,
  parseFormProviders,
  parseFormStartup,
  parseFormSubmit,
  parseHistoryPage,
  parseNotification,
  parseNotifications,
  parseRuntimePolicy,
  parseScheduleDelivery,
  parseScheduleDetail,
  parseScheduleList,
  parseOpsConnectionHealth,
  parseOpsHealth,
  parseOpsJobs,
  parseOpsMetrics,
  parseOpsPreflight,
  parseOpsRepairOutcome,
  parseOpsScheduledTasks,
  parseOpsVersion,
  parseSagaCatalog,
  parseSdkError,
  scaffoldSaga,
  SdkError,
  SDK_DOC_PATH,
  SDK_ERROR_CODES,
  SDK_VERSION,
  validateAgainstSchema,
} from "../src/sdk";
import { SAGA_CATALOG } from "../src/sagas";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

describe("SDK contract version and descriptor (issue #140)", () => {
  afterEach(async () => {
    await reset();
  });
  it("pins the contract version and serves it over GET /api/sdk", async () => {
    expect(SDK_VERSION).toBe("1");
    expect(SDK_DOC_PATH).toBe("/api/sdk");
    const descriptor = describeContract();
    expect(descriptor.contract).toBe("wrangnarok.sdk");
    expect(descriptor.version).toBe(SDK_VERSION);
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["GET /api/sdk", "GET /api/sagas", "POST /api/executions", "POST /api/dev/preview"]),
    );
    // DEV-02 (issue #141): local preview is a supported capability; the OPS-01
    // routes and error codes stay in the contract list.
    expect(descriptor.capabilities.find((entry) => entry.name === "local-preview")?.status).toBe("supported");
    expect(descriptor.capabilities.find((entry) => entry.name === "ops-audit-notifications")?.status).toBe("supported");
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["GET /api/audit", "GET /api/notifications", "DELETE /api/notifications/:id"]),
    );
    // OPS-02 (issue #173): diagnostics/repair routes and codes stay in the
    // contract list alongside the OPS-01 surface.
    expect(descriptor.capabilities.find((entry) => entry.name === "ops-diagnostics-repairs")?.status).toBe("supported");
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining([
        "GET /api/ops/version",
        "GET /api/ops/health",
        "GET /api/ops/metrics",
        "GET /api/ops/scheduled-tasks",
        "GET /api/ops/jobs",
        "GET /api/ops/preflight",
        "GET /api/ops/connections",
        "POST /api/ops/repairs",
      ]),
    );
    for (const code of [
      "CANCELLATION_UNCONFIRMED",
      "STABLE_IDENTITY_REMAP_REQUIRED",
      "SYNC_CONFLICT",
      "INVALID_GIT_TARGET",
      "DEPLOY_BLOCKED",
      "INVALID_ACTION_PREFIX",
      "INVALID_OUTCOME",
      "INVALID_SEARCH",
      "INVALID_NOTIFICATION",
      "INVALID_NOTIFICATION_ID",
      "NOTIFICATION_NOT_FOUND",
      "INVALID_REPAIR",
      "INVALID_REPAIR_KIND",
      "INVALID_REPAIR_TARGET",
      "INVALID_REPAIR_KEY",
      "EXECUTION_NOT_REPAIRABLE",
      "REPAIR_FORBIDDEN",
      "REPAIR_UNAVAILABLE",
    ]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
    // CON-02 (issue #147): scoped config is a supported capability with its
    // routes in the descriptor and its codes in the contract list.
    expect(descriptor.capabilities.find((entry) => entry.name === "author-config")?.status).toBe("supported");
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["GET /api/config", "POST /api/config", "PUT /api/config/:id"]),
    );
    for (const code of ["CONFIG_REQUIREMENT_UNSATISFIED", "SECRET_NOT_CONFIGURED", "MANAGED_RESOURCE"]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
    // FORM-02 (issue #155): dynamic forms are a supported capability with
    // designer, startup, provider, and submit routes plus error codes.
    expect(descriptor.capabilities.find((entry) => entry.name === "dynamic-forms")?.status).toBe("supported");
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining([
        "GET /api/forms",
        "POST /api/forms",
        "GET /api/forms/:name",
        "PUT /api/forms/:name",
        "DELETE /api/forms/:name",
        "POST /api/forms/:name/startup",
        "GET /api/forms/:name/providers",
        "POST /api/forms/:name/submit",
      ]),
    );
    for (const code of [
      "INVALID_FORM",
      "FORM_NOT_FOUND",
      "STALE_FORM_HANDLE",
      "INVALID_PREFILL",
      "PREFILL_NOT_ALLOWED",
      "INVALID_SCHEDULE",
      "IDEMPOTENCY_CONFLICT",
    ]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
    // RUN-01 (ADR 018): persisted runtime policy is a supported capability
    // with its routes and error codes in the contract.
    expect(descriptor.capabilities.find((entry) => entry.name === "runtime-policy")?.status).toBe("supported");
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(["GET /api/sagas/:id/policy", "PUT /api/sagas/:id/policy"]),
    );
    for (const code of ["INVALID_POLICY", "SAGA_PAUSED", "ADMISSION_LIMITED"]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
    // TRG-01 (issue #137, ADR 012): schedules are a supported capability
    // with operator routes, delivery visibility, and error codes.
    expect(descriptor.capabilities.find((entry) => entry.name === "scheduled-triggers")?.status).toBe("supported");
    expect(descriptor.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining([
        "GET /api/schedules",
        "POST /api/schedules",
        "GET /api/schedules/:name",
        "DELETE /api/schedules/:name",
        "POST /api/schedules/:name/enable",
        "POST /api/schedules/:name/disable",
        "GET /api/schedules/:name/deliveries",
      ]),
    );
    for (const code of ["INVALID_SCHEDULE", "SCHEDULE_CONFLICT", "SCHEDULE_IDENTITY_FORBIDDEN"]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
    for (const code of ["STABLE_IDENTITY_REMAP_REQUIRED", "SYNC_CONFLICT", "INVALID_GIT_TARGET", "DEPLOY_BLOCKED"]) {
      expect(SDK_ERROR_CODES).toContain(code);
    }
    for (const capability of descriptor.capabilities) {
      expect(["supported", "git-owned", "tracked"]).toContain(capability.status);
    }
    // Resource-management SDK commands stay tracked to their owning parity
    // issues; the descriptor must never declare them complete.
    const resources = descriptor.capabilities.find((entry) => entry.name === "resource-management");
    expect(resources?.status).toBe("tracked");
  });

  it("serves the same descriptor through the authenticated Worker route", async () => {
    await bindings.DB.exec(migration1);
    await bindings.DB.exec(migration2);
    await bindings.DB.exec(seed);
    const denied = await worker.fetch(new Request("http://local.test/api/sdk"), bindings);
    expect(denied.status).toBe(401);
    const ok = await worker.fetch(new Request("http://local.test/api/sdk", { headers: authHeaders() }), bindings);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(describeContract());
  });

  it("keeps SDK_ERROR_CODES covering every served error code", async () => {
    await bindings.DB.exec(migration1);
    await bindings.DB.exec(migration2);
    await bindings.DB.exec(seed);
    // Force representative failures through the real routes and assert each
    // served code is in the contract list.
    const unauth = await worker.fetch(new Request("http://local.test/api/sagas"), bindings);
    expect(SDK_ERROR_CODES).toContain(((await unauth.json()) as { error: { code: string } }).error.code);
    const badJson = await worker.fetch(
      new Request("http://local.test/api/executions", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": "sdk-drift-test-0001" }),
        body: "{not json",
      }),
      bindings,
    );
    expect(SDK_ERROR_CODES).toContain(((await badJson.json()) as { error: { code: string } }).error.code);
    const badInput = await worker.fetch(
      new Request("http://local.test/api/executions", {
        method: "POST",
        headers: authHeaders({ "Idempotency-Key": "sdk-drift-test-0002" }),
        body: JSON.stringify({ sagaId: helloSaga.id, input: { name: "" } }),
      }),
      bindings,
    );
    expect(SDK_ERROR_CODES).toContain(((await badInput.json()) as { error: { code: string } }).error.code);
    const notFound = await worker.fetch(
      new Request(`http://local.test/api/executions/${"f".repeat(64)}`, { headers: authHeaders() }),
      bindings,
    );
    expect(SDK_ERROR_CODES).toContain(((await notFound.json()) as { error: { code: string } }).error.code);
  });
});

describe("SDK offline authoring helpers", () => {
  it("scaffolds a defineSaga module with stable identity markers", () => {
    const scaffolded = scaffoldSaga({
      name: "hello-again",
      id: "395e15f0-3627-41f6-8922-008ce37e3b99",
      description: "A fresh author scaffold.",
    });
    expect(scaffolded.files).toHaveLength(1);
    const file = scaffolded.files[0];
    expect(file?.path).toBe("src/sagas/hello-again.ts");
    for (const marker of [
      "defineSaga",
      "requiredIntegrations",
      'step.do("prepare-input-v1"',
      "prepareExecution",
      "executeSaga",
      "395e15f0-3627-41f6-8922-008ce37e3b99",
    ]) {
      expect(file?.content).toContain(marker);
    }
    expect(scaffolded.next.join("\n")).toContain("sagas.manifest.json");
    expect(() => scaffoldSaga({ name: "Bad Name", id: "not-a-uuid", description: "x" })).toThrow(SdkError);
    expect(() => scaffoldSaga({ name: "ok", id: "not-a-uuid", description: "x" })).toThrow(/stable UUID/);
  });

  it("inspects the offline catalog by id and exact name only", () => {
    const catalog = localCatalog();
    expect(catalog).toHaveLength(SAGA_CATALOG.length);
    const hello = inspectSaga(catalog, "hello");
    expect(hello.id).toBe(helloSaga.id);
    expect(inspectSaga(catalog, helloSaga.id)).toEqual(hello);
    expect(() => inspectSaga(catalog, "no-such-saga")).toThrow(/No Saga named/);
    expect(() => inspectSaga(catalog, "395e15f0-3627-41f6-8922-008ce37e3b00")).toThrow(/stable id/);
  });

  it("validates inputs against served schemas before submit", () => {
    const hello = inspectSaga(localCatalog(), "hello");
    expect(validateAgainstSchema({ name: "Ada" }, hello.inputSchema)).toEqual({ ok: true });
    expect(validateAgainstSchema({}, hello.inputSchema).ok).toBe(false);
    expect(validateAgainstSchema({ name: 7 }, hello.inputSchema).ok).toBe(false);
    expect(validateAgainstSchema({ nickname: "Ada" }, hello.inputSchema).ok).toBe(false);
    expect(validateAgainstSchema("anything", undefined)).toEqual({ ok: true });
  });

  it("resolves the SDK scaffold offline with no network", () => {
    const scaffolded = scaffoldSaga({
      name: "cli-check",
      id: "395e15f0-3627-41f6-8922-008ce37e3b98",
      description: "CLI parity check.",
      revision: "cli-check-v1",
    });
    for (const marker of ["defineSaga", "requiredIntegrations", 'step.do("prepare-input-v1"']) {
      expect(scaffolded.files[0]?.content).toContain(marker);
    }
  });

  it("surfaces SDK error codes for unknown refs without network", async () => {
    const client = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    // Offline catalog helpers fail before any fetch.
    expect(() => inspectSaga([], "hello")).toThrow(/No Saga named/);
    await expect(client.inspectSaga("no-such-saga")).rejects.toMatchObject({ code: "SDK_CLIENT_NETWORK" });
  });
});

describe("SDK automation client: local happy/denied/error examples", () => {
  beforeEach(async () => {
    await bindings.DB.exec(migration1);
    await bindings.DB.exec(migration2);
    await bindings.DB.exec(seed);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== "http://127.0.0.1:8788/echo") throw new Error("Unexpected outbound request");
      return Response.json({ message: "hello" });
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  it("lists, inspects, submits, polls, and diagnoses a happy Execution", async () => {
    const key = "sdk-client-happy-001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(
        new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }),
        {
          ...bindings,
        },
      )) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl, pollMs: 0 });
    const sagas = await client.listSagas();
    expect(parseSagaCatalog({ sagas })).toHaveLength(SAGA_CATALOG.length);
    const hello = await client.inspectSaga("hello");
    expect(hello.inputSchema).toBeDefined();
    const submitted = await client.submitExecution({ saga: "hello", input: { name: "Ada" }, key });
    expect(submitted).toMatchObject({ executionId: id, status: "Succeeded" });
    await instance.waitForStatus("complete");
    const settled = await client.getExecution(id);
    expect(parseExecutionDetail(JSON.parse(JSON.stringify(settled)))).toMatchObject({
      status: "Succeeded",
      result: { greeting: "Hello, Ada!", name: "Ada" },
    });
    const diagnosis = await client.diagnoseExecution(id);
    expect(diagnosis.hint).toBeNull();
    const page = await client.listHistory({});
    expect(parseHistoryPage(JSON.parse(JSON.stringify(page))).executions.length).toBeGreaterThan(0);
  }, 25000);

  it("keeps the same caller policy as the UI: denied callers get 401/404, never data", async () => {
    const key = "sdk-client-denied-001";
    const id = await executionId(principal, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
    const authed = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(
        new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }),
        {
          ...bindings,
        },
      )) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl: authed, pollMs: 0 });
    await client.submitExecution({ saga: "hello", input: { name: "Bo" }, key, wait: false });
    await instance.waitForStatus("complete");
    // No token: 401 UNAUTHORIZED.
    const anonFetch = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(new Request(url, init ?? {}), { ...bindings })) as typeof fetch;
    const anon = createSdkClient({ base: "http://local.test", token: "wrong-token", fetchImpl: anonFetch });
    await expect(anon.getExecution(id)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Foreign owner with a valid token shape: 404 EXECUTION_NOT_FOUND, never a leak.
    const foreignFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = authHeaders(init?.headers as Record<string, string>);
      return worker.fetch(new Request(url, { ...(init ?? {}), headers }), {
        ...bindings,
        LAB_USER_ID: "00000000-0000-4000-8000-000000000003",
      });
    }) as typeof fetch;
    const foreign = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl: foreignFetch });
    await expect(foreign.getExecution(id)).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    const error = await foreign.getExecution(id).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SdkError);
    expect(
      (
        await parseSdkError(
          new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "No." } }), { status: 403 }),
        )
      ).code,
    ).toBe("FORBIDDEN");
  }, 25000);

  it("surfaces validation and contract errors with stable codes", async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) =>
      worker.fetch(
        new Request(url, { ...(init ?? {}), headers: authHeaders(init?.headers as Record<string, string>) }),
        {
          ...bindings,
        },
      )) as typeof fetch;
    const client = createSdkClient({ base: "http://local.test", token: TOKEN, fetchImpl, pollMs: 0 });
    await expect(client.inspectSaga("no-such-saga")).rejects.toMatchObject({ code: "SDK_SAGA_NOT_FOUND" });
    await expect(client.getExecution("abc")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    await expect(
      client.submitExecution({ saga: "hello", input: { name: "" }, key: "sdk-client-error-001" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.getContract()).resolves.toMatchObject({ version: SDK_VERSION });
  });
});

describe("SDK client branches over stub fetch (issue #140)", () => {
  function stub(scenarios: unknown[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      const next = scenarios.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`Unexpected fetch: ${url}`);
      return next as Response;
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  }

  const catalog = {
    sagas: [
      {
        id: helloSaga.id,
        name: "hello",
        revision: "hello-v1",
        description: "hi",
        requiredIntegrations: [],
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
  };

  function detail(overrides: Record<string, unknown> = {}) {
    const id = "a".repeat(64);
    return {
      executionId: id,
      sagaId: helloSaga.id,
      sagaName: "hello",
      sagaRevision: "hello-v1",
      orgId: "org",
      userId: "user",
      status: "Succeeded",
      dispatchConfirmed: true,
      createdAt: "2026-09-11T00:00:00.000Z",
      startedAt: "2026-09-11T00:00:01.000Z",
      completedAt: "2026-09-11T00:00:02.000Z",
      runtimeStatus: null,
      policy: {
        sagaId: helloSaga.id,
        version: 1,
        policy: {
          timeout: { vendorTimeoutMs: 0, stepTimeout: "10 seconds" },
          retry: { checkpointRetries: 2, vendorRetries: 0 },
          admission: { enabled: true, maxConcurrent: 0 },
        },
      },
      input: { name: "Ada" },
      result: { greeting: "Hello, Ada!", name: "Ada" },
      error: null,
      operations: [
        {
          name: "prepare-input-v1",
          status: "Succeeded",
          startedAt: "2026-09-11T00:00:01.000Z",
          completedAt: "2026-09-11T00:00:02.000Z",
          result: { name: "Ada" },
          error: null,
        },
      ],
      ...overrides,
    };
  }

  it("rejects bad client options before any fetch", () => {
    expect(() => createSdkClient({ base: "not-a-url", token: "tok" })).toThrow(/http\(s\)/);
    expect(() => createSdkClient({ base: "http://local.test", token: "" })).toThrow(/bearer token/);
    expect(() => createSdkClient({ base: "http://local.test///", token: "tok" })).not.toThrow();
  });

  it("forwards Access credentials and resolves sagas by UUID without listing", async () => {
    const { calls, fetchImpl } = stub([json(detail({ status: "Running" }))]);
    const client = createSdkClient({
      base: "http://local.test",
      token: "tok",
      access: { clientId: "id", clientSecret: "secret" },
      fetchImpl,
    });
    const seen = await client.getExecution("a".repeat(64));
    expect(seen.status).toBe("Running");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe("id");
    const uuidClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    const listed = stub([json(catalog)]);
    const byUuid = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: listed.fetchImpl });
    expect((await byUuid.inspectSaga(helloSaga.id)).name).toBe("hello");
    expect(uuidClient).toBeDefined();
  });

  it("flags ambiguous catalog names instead of guessing", async () => {
    const dupes = {
      sagas: [
        { id: helloSaga.id, name: "dup", revision: "v1", description: "a", requiredIntegrations: [] },
        {
          id: "395e15f0-3627-41f6-8922-008ce37e3b98",
          name: "dup",
          revision: "v1",
          description: "b",
          requiredIntegrations: [],
        },
      ],
    };
    const { fetchImpl } = stub([json(dupes), json(dupes)]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    await expect(client.inspectSaga("dup")).rejects.toMatchObject({ code: "SDK_SAGA_AMBIGUOUS" });
    expect(() =>
      inspectSaga(
        [
          { id: helloSaga.id, name: "dup", revision: "v1", description: "a", requiredIntegrations: [] },
          {
            id: "395e15f0-3627-41f6-8922-008ce37e3b98",
            name: "dup",
            revision: "v1",
            description: "b",
            requiredIntegrations: [],
          },
        ],
        "dup",
      ),
    ).toThrow(/pass a stable UUID/);
  });

  it("submits with generated keys, receipts, and stable submit errors", async () => {
    const id = "b".repeat(64);
    const { calls, fetchImpl } = stub([
      json(catalog),
      json({ executionId: id, replayed: true, statusUrl: `/api/executions/${id}` }, 202),
    ]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    const receipt = await client.submitExecution({ saga: "hello", wait: false });
    expect(receipt).toMatchObject({ executionId: id, replayed: true });
    const sentHeaders = calls[1]?.init.headers as Record<string, string> | undefined;
    expect(typeof sentHeaders?.["Idempotency-Key"]).toBe("string");
    expect((sentHeaders?.["Idempotency-Key"] ?? "").length).toBeGreaterThan(16);
    const badKey = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    await expect(badKey.submitExecution({ saga: helloSaga.id, key: "short" })).rejects.toMatchObject({
      code: "SDK_INVALID_REF",
    });
    const noId = stub([json({ replayed: false }, 202)]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: noId.fetchImpl }).submitExecution({
        saga: helloSaga.id,
        key: "sdk-branch-test-0001",
        wait: false,
      }),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
    const html = stub([json(catalog), new Response("nope", { status: 202 })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: html.fetchImpl }).submitExecution({
        saga: "hello",
        key: "sdk-branch-test-0002",
        wait: false,
      }),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
    const denied = stub([json({ error: { code: "INVALID_INPUT", message: "bad" } }, 400)]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: denied.fetchImpl }).submitExecution({
        saga: helloSaga.id,
        key: "sdk-branch-test-0003",
        wait: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const bare = stub([new Response(JSON.stringify({ nope: true }), { status: 400 })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: bare.fetchImpl }).submitExecution({
        saga: helloSaga.id,
        key: "sdk-branch-test-0004",
        wait: false,
      }),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
  });

  it("times out a slow poll and wraps network failures", async () => {
    const id = "e".repeat(64);
    const running = stub([
      json({ executionId: id, replayed: false, statusUrl: `/api/executions/${id}` }, 202),
      json(detail({ executionId: id, status: "Running" })),
    ]);
    const slow = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: running.fetchImpl,
      timeoutMs: 0,
      pollMs: 0,
      sleep: async () => {},
    });
    await expect(slow.submitExecution({ saga: helloSaga.id, key: "sdk-branch-timeout-001" })).rejects.toMatchObject({
      code: "SDK_CLIENT_TIMEOUT",
    });
    const down = stub([new Error("boom")]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: down.fetchImpl }).listSagas(),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_NETWORK" });
  });

  it("reads and writes saga runtime policy through the typed client", async () => {
    const served = {
      policy: {
        sagaId: helloSaga.id,
        sagaName: "hello",
        version: 2,
        updatedAt: "2026-09-11T00:00:00.000Z",
        timeout: { vendorTimeoutMs: 250, stepTimeout: "10 seconds" },
        retry: { checkpointRetries: 2, vendorRetries: 1 },
        admission: { enabled: true, maxConcurrent: 3 },
      },
    };
    const got = stub([json(catalog), json(served)]);
    const reader = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: got.fetchImpl });
    expect(await reader.getSagaPolicy("hello")).toMatchObject({ sagaId: helloSaga.id, version: 2 });
    expect(got.calls[1]?.url).toBe(`http://local.test/api/sagas/${helloSaga.id}/policy`);
    const put = stub([json(served)]);
    const writer = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: put.fetchImpl });
    expect(await writer.updateSagaPolicy(helloSaga.id, { admission: { maxConcurrent: 3 } })).toMatchObject({
      admission: { maxConcurrent: 3 },
    });
    expect(put.calls[0]?.init.method).toBe("PUT");
    expect(String(put.calls[0]?.init.body)).toContain("maxConcurrent");
    const fallback = stub([json(catalog), json(served)]);
    const fallbackClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: fallback.fetchImpl });
    expect(await fallbackClient.updateSagaPolicy("hello", undefined)).toMatchObject({ version: 2 });
    expect(String(fallback.calls[1]?.init.body)).toBe("{}");
  });

  it("cancels with exact IDs and guards the cancel shape", async () => {
    const id = "c".repeat(64);
    const { calls, fetchImpl } = stub([json({ executionId: id, status: "Cancelled", cancelled: true })]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    expect(await client.cancelExecution(id)).toMatchObject({ status: "Cancelled", cancelled: true });
    expect(calls[0]?.url).toBe(`http://local.test/api/executions/${id}/cancel`);
    await expect(client.cancelExecution("abc")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    const malformed = stub([json({ nope: true })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: malformed.fetchImpl }).cancelExecution(id),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
  });

  it("lists audit events and the notifications inbox through the typed client", async () => {
    const audit = { events: [], hasMore: false, nextCursor: null };
    const { calls, fetchImpl } = stub([json(audit)]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    const seen = await client.listAuditEvents({ action: "app.", outcome: "success", limit: 5 });
    expect(seen.events).toEqual([]);
    const url = calls[0]?.url ?? "";
    expect(url).toContain("/api/audit?");
    expect(url).toContain("action=app.");
    expect(url).toContain("outcome=success");
    const inbox = stub([json({ notifications: [] })]);
    const inboxClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: inbox.fetchImpl });
    expect(await inboxClient.listNotifications(5)).toEqual([]);
    expect(inbox.calls[0]?.url).toBe("http://local.test/api/notifications?limit=5");
    const noteId = "11111111-1111-4111-8111-111111111111";
    const one = stub([
      json({
        notification: {
          id: noteId,
          orgId: "org",
          userId: "user",
          scope: "personal",
          category: "app_build",
          title: "App build succeeded",
          body: null,
          status: "completed",
          progressPercent: null,
          detail: null,
          createdAt: "2026-09-11T00:00:00.000Z",
          updatedAt: "2026-09-11T00:00:01.000Z",
          dismissedAt: null,
        },
      }),
    ]);
    const oneClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: one.fetchImpl });
    expect((await oneClient.getNotification(noteId)).id).toBe(noteId);
    const gone = stub([json({ dismissed: true })]);
    const goneClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: gone.fetchImpl });
    await goneClient.dismissNotification(noteId);
    expect(gone.calls[0]?.init.method).toBe("DELETE");
    await expect(client.getNotification("abc")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    await expect(client.dismissNotification("abc")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    const malformed = stub([json({ nope: true })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: malformed.fetchImpl }).listAuditEvents(),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
  });

  it("reads diagnostics and repairs through the typed client", async () => {
    const counters = {
      total: 1,
      pending: 0,
      pendingUndispatched: 0,
      running: 0,
      cancelling: 0,
      succeeded: 0,
      failed: 1,
      timedOut: 0,
      cancelled: 0,
    };
    const versionStub = stub([
      json({ version: { sdkVersion: "1", sagaCatalog: { count: 5, revision: "r" }, migrationsApplied: [] } }),
    ]);
    const versionClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: versionStub.fetchImpl,
    });
    expect((await versionClient.getOpsVersion()).sdkVersion).toBe("1");
    expect(versionStub.calls[0]?.url).toBe("http://local.test/api/ops/version");
    const healthStub = stub([
      json({ status: "ok", database: "ok", worker: "ok", checkedAt: "2026-09-12T00:00:00.000Z" }),
    ]);
    const healthClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: healthStub.fetchImpl,
    });
    expect((await healthClient.getOpsHealth()).status).toBe("ok");
    const metricsStub = stub([
      json({ metrics: { generatedAt: "2026-09-12T00:00:00.000Z", executions: counters, recentFailures: [] } }),
    ]);
    const metricsClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: metricsStub.fetchImpl,
    });
    expect((await metricsClient.getOpsMetrics(5)).executions.failed).toBe(1);
    expect(metricsStub.calls[0]?.url).toBe("http://local.test/api/ops/metrics?recent=5");
    await expect(metricsClient.getOpsMetrics(99)).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    const tasksStub = stub([json({ tasks: [] })]);
    const tasksClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: tasksStub.fetchImpl,
    });
    expect(await tasksClient.listOpsScheduledTasks()).toEqual([]);
    const jobsStub = stub([
      json({
        jobs: {
          generatedAt: "2026-09-12T00:00:00.000Z",
          executions: counters,
          appBuilds: { queued: 0, running: 0, succeeded: 0, failed: 0, interrupted: [] },
        },
      }),
    ]);
    const jobsClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: jobsStub.fetchImpl });
    expect((await jobsClient.getOpsJobs()).appBuilds.succeeded).toBe(0);
    const preflightStub = stub([json({ checkedAt: "2026-09-12T00:00:00.000Z", integrations: [] })]);
    const preflightClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: preflightStub.fetchImpl,
    });
    expect((await preflightClient.getOpsPreflight()).integrations).toEqual([]);
    const connsStub = stub([json({ connections: [] })]);
    const connsClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: connsStub.fetchImpl,
    });
    expect((await connsClient.getOpsConnectionHealth()).connections).toEqual([]);
    // Repairs inspect by default (dryRun:true) and commit explicitly.
    const repairBody = {
      repair: { kind: "cleanup-pending-uploads", dryRun: true, targetId: null, action: "a", result: {} },
    };
    const inspectStub = stub([json(repairBody)]);
    const inspectClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: inspectStub.fetchImpl,
    });
    const inspected = await inspectClient.runOpsRepair({ kind: "cleanup-pending-uploads" });
    expect(inspected.dryRun).toBe(true);
    expect(JSON.parse(String(inspectStub.calls[0]?.init.body)).dryRun).toBe(true);
    const executeStub = stub([json({ repair: { ...repairBody.repair, dryRun: false } })]);
    const executeClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: executeStub.fetchImpl,
    });
    const executed = await executeClient.runOpsRepair({ kind: "cleanup-pending-uploads", dryRun: false });
    expect(executed.dryRun).toBe(false);
    expect(inspectStub.calls[0]?.init.method).toBe("POST");
    // Malformed diagnostics payloads fail as SDK_CLIENT_MISMATCH.
    const malformedVersion = stub([json({ nope: true })]);
    const malformedVersionClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: malformedVersion.fetchImpl,
    });
    await expect(malformedVersionClient.getOpsVersion()).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
    const malformedMetrics = stub([json({ nope: true })]);
    const malformedMetricsClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: malformedMetrics.fetchImpl,
    });
    await expect(malformedMetricsClient.getOpsMetrics()).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
  });

  it("lists history with filters, cursors, and saga resolution", async () => {
    const page = {
      executions: [{ executionId: "d".repeat(64), sagaId: helloSaga.id, status: "Failed" }],
      hasMore: false,
    };
    const { calls, fetchImpl } = stub([json(catalog), json(page)]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    const seen = await client.listHistory({
      status: "Failed,TimedOut",
      saga: "hello",
      from: "2026-09-01",
      to: "2026-09-10",
      limit: 5,
    });
    expect(seen.executions).toHaveLength(1);
    const url = calls[1]?.url ?? "";
    expect(url).toContain("status=Failed%2CTimedOut");
    expect(url).toContain("startDate=2026-09-01");
    expect(url).toContain("endDate=2026-09-10");
    const unknown = stub([json(catalog)]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: unknown.fetchImpl }).listHistory({
        saga: "missing",
      }),
    ).rejects.toMatchObject({ code: "SDK_SAGA_NOT_FOUND" });
  });

  it("previews through the typed client without dispatching", async () => {
    const seen = {
      preview: {
        saga: { id: helloSaga.id, name: "hello", revision: "hello-v1" },
        input: { name: "Ada" },
        environmentChecked: false,
        environment: [],
        persisted: false,
        dispatched: false,
      },
    };
    const { calls, fetchImpl } = stub([json(catalog), json(seen)]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    const previewed = await client.previewSaga({ saga: "hello", input: { name: "Ada" } });
    expect(previewed.persisted).toBe(false);
    expect(previewed.dispatched).toBe(false);
    expect(calls[1]?.url).toBe("http://local.test/api/dev/preview");
    const malformed = stub([json(catalog), json({ preview: { nope: true } })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: malformed.fetchImpl }).previewSaga({
        saga: helloSaga.id,
      }),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
  });

  it("diagnoses every known failure code and returns null hints otherwise", async () => {
    const codes = [
      "INTEGRATION_REQUIREMENT_UNSATISFIED",
      "ECHO_VENDOR_TIMEOUT",
      "NINJA_VENDOR_TIMEOUT",
      "NINJA_UNAUTHORIZED",
      "NINJA_NOT_CONFIGURED",
      "EXECUTION_CANCELLED",
      "SAGA_PAUSED",
      "ADMISSION_LIMITED",
      "DISPATCH_UNCONFIRMED",
    ];
    for (const code of codes) {
      const { fetchImpl } = stub([json(detail({ error: { code, message: code } }))]);
      const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
      const diagnosis = await client.diagnoseExecution("a".repeat(64));
      expect(typeof diagnosis.hint).toBe("string");
    }
    const { fetchImpl } = stub([json(detail({ error: { code: "SOME_OTHER_CODE", message: "x" } }))]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    expect((await client.diagnoseExecution("a".repeat(64))).hint).toBeNull();
  });

  it("rejects contract skew and malformed descriptors", async () => {
    const skewed = stub([json({ contract: "wrangnarok.sdk", version: "999" })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: skewed.fetchImpl }).getContract(),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
    const html = stub([new Response("nope", { status: 200 })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: html.fetchImpl }).getContract(),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
  });

  it("parses failed responses without ever throwing", async () => {
    expect((await parseSdkError(new Response("nope", { status: 500 }))).code).toBe("SDK_CLIENT_MISMATCH");
    expect((await parseSdkError(json({ nope: true }, 400))).code).toBe("SDK_CLIENT_MISMATCH");
    expect((await parseSdkError(json({ error: { code: "NOPE", message: "" } }, 400))).code).toBe("SDK_CLIENT_MISMATCH");
    const shaped = await parseSdkError(json({ error: { code: "FORBIDDEN", message: "No." } }, 403));
    expect(shaped.status).toBe(403);
    expect(shaped.toJSON()).toEqual({ error: { code: "FORBIDDEN", message: "No." } });
  });

  it("guards every wire shape against drift", () => {
    expect(() => parseSagaCatalog({})).toThrow(/unexpected shape/);
    expect(() => parseSagaCatalog({ sagas: [{ id: 1 }] })).toThrow(/unexpected shape/);
    expect(() => parseSagaCatalog(null)).toThrow(/unexpected shape/);
    expect(() => parseExecutionDetail(null)).toThrow(/unexpected shape/);
    expect(() => parseExecutionDetail({ ...detail(), operations: [{ name: 1 }] })).toThrow(/unexpected shape/);
    expect(() => parseExecutionDetail({ ...detail(), operations: "x" })).toThrow(/unexpected shape/);
    expect(() => parseExecutionDetail({ ...detail(), policy: undefined })).toThrow(/unexpected shape/);
    expect(() => parseRuntimePolicy({ policy: { nope: true } })).toThrow(/unexpected shape/);
    expect(
      parseRuntimePolicy({
        policy: {
          sagaId: helloSaga.id,
          sagaName: "hello",
          version: 1,
          updatedAt: "2026-09-11T00:00:00.000Z",
          timeout: { vendorTimeoutMs: 0, stepTimeout: "10 seconds" },
          retry: { checkpointRetries: 2, vendorRetries: 0 },
          admission: { enabled: true, maxConcurrent: 0 },
        },
      }).sagaId,
    ).toBe(helloSaga.id);
    expect(() => parseHistoryPage({})).toThrow(/unexpected shape/);
    expect(() => parseHistoryPage({ executions: [{ sagaId: 1 }], hasMore: false })).toThrow(/unexpected shape/);
    expect(() => parseHistoryPage({ executions: [], hasMore: false, nextCursor: 7 })).toThrow(/unexpected shape/);
    expect(parseHistoryPage({ executions: [], hasMore: false }).nextCursor).toBeNull();
    expect(parseHistoryPage({ executions: [], hasMore: false, nextCursor: "c" }).nextCursor).toBe("c");
    // OPS-01 wire guards (issue #172): audit pages and notifications.
    expect(() => parseAuditPage({})).toThrow(/unexpected shape/);
    expect(() => parseAuditPage({ events: [{ id: 1 }], hasMore: false })).toThrow(/unexpected shape/);
    expect(() => parseAuditPage({ events: [], hasMore: false, nextCursor: 7 })).toThrow(/unexpected shape/);
    expect(parseAuditPage({ events: [], hasMore: false }).nextCursor).toBeNull();
    expect(() => parseNotifications({})).toThrow(/unexpected shape/);
    expect(() => parseNotifications({ notifications: [{ id: 1 }] })).toThrow(/unexpected shape/);
    expect(() => parseNotification({})).toThrow(/unexpected shape/);
    // OPS-02 wire guards (issue #173): diagnostics and repair payloads.
    expect(() => parseOpsVersion({})).toThrow(/unexpected shape/);
    expect(() => parseOpsVersion({ version: { sdkVersion: 1 } })).toThrow(/unexpected shape/);
    expect(() => parseOpsHealth({})).toThrow(/unexpected shape/);
    expect(() => parseOpsMetrics({})).toThrow(/unexpected shape/);
    expect(() => parseOpsMetrics({ metrics: { generatedAt: "x", executions: {}, recentFailures: [] } })).toThrow(
      /unexpected shape/,
    );
    expect(() =>
      parseOpsMetrics({
        metrics: {
          generatedAt: "x",
          executions: {
            total: 0,
            pending: 0,
            pendingUndispatched: 0,
            running: 0,
            cancelling: 0,
            succeeded: 0,
            failed: 0,
            timedOut: 0,
            cancelled: 0,
          },
          recentFailures: [{ executionId: 1 }],
        },
      }),
    ).toThrow(/unexpected shape/);
    expect(() => parseOpsScheduledTasks({})).toThrow(/unexpected shape/);
    expect(() => parseOpsScheduledTasks({ tasks: [{ id: 1 }] })).toThrow(/unexpected shape/);
    expect(() => parseOpsJobs({})).toThrow(/unexpected shape/);
    expect(() => parseOpsJobs({ jobs: { generatedAt: "x" } })).toThrow(/unexpected shape/);
    expect(() => parseOpsPreflight({})).toThrow(/unexpected shape/);
    expect(() => parseOpsPreflight({ checkedAt: "x", integrations: [{ integrationId: 1 }] })).toThrow(
      /unexpected shape/,
    );
    expect(() => parseOpsConnectionHealth({})).toThrow(/unexpected shape/);
    expect(() => parseOpsConnectionHealth({ connections: [{ integrationId: 1 }] })).toThrow(/unexpected shape/);
    expect(() => parseOpsRepairOutcome({})).toThrow(/unexpected shape/);
    expect(() => parseOpsRepairOutcome({ repair: { kind: 1 } })).toThrow(/unexpected shape/);
    // OPS-02 guard arms (issue #173): boundary and entry shapes.
    expect(() => parseOpsVersion({ version: 1 })).toThrow(/unexpected shape/);
    expect(() => parseOpsVersion({ version: { sdkVersion: "1", sagaCatalog: {}, migrationsApplied: [] } })).toThrow(
      /unexpected shape/,
    );
    expect(() =>
      parseOpsVersion({ version: { sdkVersion: "1", sagaCatalog: { count: 1 }, migrationsApplied: [] } }),
    ).toThrow(/unexpected shape/);
    expect(() => parseOpsHealth({ status: "ok", database: "ok", worker: 1, checkedAt: "x" })).toThrow(
      /unexpected shape/,
    );
    expect(() => parseOpsMetrics({ metrics: 1 })).toThrow(/unexpected shape/);
    expect(() => parseOpsMetrics({ metrics: { generatedAt: 1, executions: {}, recentFailures: [] } })).toThrow(
      /unexpected shape/,
    );
    expect(() =>
      parseOpsMetrics({
        metrics: {
          generatedAt: "x",
          executions: {
            total: 0,
            pending: 0,
            pendingUndispatched: 0,
            running: 0,
            cancelling: 0,
            succeeded: 0,
            failed: 0,
            timedOut: 0,
            cancelled: 0,
          },
          recentFailures: [{ executionId: "a", sagaName: "s", status: "Failed", code: 1, completedAt: null }],
        },
      }),
    ).toThrow(/unexpected shape/);
    expect(() => parseOpsScheduledTasks({ tasks: 1 })).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsScheduledTasks({
        tasks: [{ id: "a", name: "n", kind: "endpoint", enabled: true, cadence: 1, detail: "d" }],
      }),
    ).toThrow(/unexpected shape/);
    expect(() => parseOpsJobs({ jobs: { generatedAt: "x", executions: {}, appBuilds: {} } })).toThrow(
      /unexpected shape/,
    );
    expect(() =>
      parseOpsJobs({
        jobs: {
          generatedAt: "x",
          executions: {
            total: 0,
            pending: 0,
            pendingUndispatched: 0,
            running: 0,
            cancelling: 0,
            succeeded: 0,
            failed: 0,
            timedOut: 0,
            cancelled: 0,
          },
          appBuilds: { queued: 0, running: 0, succeeded: 0, failed: 0, interrupted: [{ appId: 1 }] },
        },
      }),
    ).toThrow(/unexpected shape/);
    expect(() => parseOpsPreflight({ checkedAt: "x", integrations: 1 })).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsPreflight({
        checkedAt: "x",
        integrations: [
          {
            integrationId: "i",
            integrationName: "n",
            connected: true,
            enabled: true,
            missingSecrets: "x",
            ready: true,
          },
        ],
      }),
    ).toThrow(/unexpected shape/);
    expect(() => parseOpsConnectionHealth({ connections: 1 })).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsRepairOutcome({ repair: { kind: "k", dryRun: true, targetId: 1, action: "a", result: null } }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsRepairOutcome({ repair: { kind: "k", dryRun: "yes", targetId: null, action: "a", result: null } }),
    ).toThrow(/unexpected shape/);
    // OPS-02 guard entry arms (issue #173): malformed list entries.
    const counters = {
      total: 0,
      pending: 0,
      pendingUndispatched: 0,
      running: 0,
      cancelling: 0,
      succeeded: 0,
      failed: 0,
      timedOut: 0,
      cancelled: 0,
    };
    expect(() =>
      parseOpsMetrics({
        metrics: {
          generatedAt: "x",
          executions: counters,
          recentFailures: [{ executionId: "a", sagaName: "s", status: "Failed", code: null, completedAt: 7 }],
        },
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsScheduledTasks({
        tasks: [{ id: "a", name: "n", kind: 7, enabled: true, cadence: null, detail: "d" }],
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsScheduledTasks({
        tasks: [{ id: "a", name: "n", kind: "endpoint", enabled: "yes", cadence: null, detail: "d" }],
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsScheduledTasks({
        tasks: [{ id: "a", name: "n", kind: "endpoint", enabled: true, cadence: null, detail: 7 }],
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsJobs({
        jobs: {
          generatedAt: "x",
          executions: counters,
          appBuilds: { queued: 0, running: 0, succeeded: 0, failed: 0, interrupted: [{ appId: "a" }] },
        },
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsPreflight({
        checkedAt: "x",
        integrations: [
          {
            integrationId: "i",
            integrationName: "n",
            connected: true,
            enabled: true,
            missingSecrets: [],
            ready: "yes",
          },
        ],
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsConnectionHealth({
        connections: [
          {
            integrationId: "i",
            integrationName: "n",
            connected: true,
            enabled: true,
            testHint: "t",
            remediation: 7,
          },
        ],
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      parseOpsRepairOutcome({ repair: { kind: "k", dryRun: true, targetId: null, action: 7, result: null } }),
    ).toThrow(/unexpected shape/);
  });

  it("validates every schema branch offline", () => {
    expect(validateAgainstSchema("x", { type: "object", properties: {} })).toEqual({
      ok: false,
      error: "Input must be a JSON object.",
    });
    expect(validateAgainstSchema({ extra: 1 }, { type: "object", properties: {} })).toEqual({ ok: true });
    expect(
      validateAgainstSchema({ extra: 1 }, { type: "object", properties: {}, additionalProperties: false }),
    ).toEqual({ ok: false, error: 'Unknown input field "extra".' });
    expect(validateAgainstSchema({}, { type: "object", properties: {}, required: ["a"] })).toEqual({
      ok: false,
      error: 'Missing required input field "a".',
    });
    const schema = {
      type: "object" as const,
      properties: {
        s: { type: "string" },
        n: { type: "number" },
        b: { type: "boolean" },
        a: { type: "array" },
        o: { type: "object" },
        w: { type: "weird" },
      },
    };
    expect(validateAgainstSchema({ s: 1 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ n: "x" }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ b: 1 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ a: {} }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ o: [] }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ w: 1 }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ s: "x", n: 1, b: true, a: [], o: {} }, schema)).toEqual({ ok: true });
  });

  it("rejects bad scaffold input on every field", () => {
    const good = { name: "ok", id: helloSaga.id, description: "d" };
    expect(scaffoldSaga(good).files).toHaveLength(1);
    expect(() => scaffoldSaga({ ...good, name: "Bad Name" })).toThrow(/simple slug/);
    expect(() => scaffoldSaga({ ...good, id: "x" })).toThrow(/stable UUID/);
    expect(() => scaffoldSaga({ ...good, description: "" })).toThrow(/1-280/);
    expect(() => scaffoldSaga({ ...good, revision: "" })).toThrow(/diagnostic marker/);
    expect(localCatalog()).toHaveLength(SAGA_CATALOG.length);
  });

  it("guards every form wire shape against drift", () => {
    expect(() => parseFormList({})).toThrow(/unexpected shape/);
    expect(() => parseFormList({ forms: [{ id: 1 }] })).toThrow(/unexpected shape/);
    expect(parseFormList({ forms: [] })).toEqual([]);
    const detail = {
      form: {
        id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
        name: "contact",
        sagaId: helloSaga.id,
        allowPrefill: false,
        fields: [{ name: "name", type: "text", required: true, maxLength: 1024 }],
      },
    };
    expect(parseFormDetail(detail).name).toBe("contact");
    expect(() => parseFormDetail({})).toThrow(/unexpected shape/);
    expect(() => parseFormDetail({ form: { name: 1 } })).toThrow(/unexpected shape/);
    expect(() =>
      parseFormDetail({
        form: { ...detail.form, fields: [{ name: "x", type: "watermelon", required: false, maxLength: 8 }] },
      }),
    ).toThrow(/unexpected shape/);
    const started = { form: "contact", handle: "h", expiresAt: "t", snapshot: {}, options: {} };
    expect(() => parseFormStartup(started)).toThrow(/unexpected shape/);
    expect(parseFormStartup({ ...started, handle: "a".repeat(64) }).handle).toBe("a".repeat(64));
    expect(() => parseFormStartup({})).toThrow(/unexpected shape/);
    expect(parseFormProviders({ form: "c", options: {} }).errors).toEqual({});
    expect(() => parseFormProviders({})).toThrow(/unexpected shape/);
    expect(() => parseFormList({ forms: [{ id: "x", name: "contact", sagaId: helloSaga.id }] })).toThrow(
      /unexpected shape/,
    );
    // TRG-01 (issue #137): schedule guards accept the served shape and reject drift.
    const scheduleShape = {
      id: "a".repeat(64),
      name: "morning-digest",
      sagaId: helloSaga.id,
      sagaName: "hello",
      kind: "recurring",
      cron: "* * * * *",
      timezone: "UTC",
      enabled: true,
      input: { name: "sched" },
      runAt: null,
      nextDueAt: "2026-09-12T10:01:00.000Z",
      lastWindow: null,
      createdAt: "2026-09-12T10:00:00.000Z",
      updatedAt: "2026-09-12T10:00:00.000Z",
    };
    expect(parseScheduleList({ schedules: [scheduleShape] })).toHaveLength(1);
    expect(parseScheduleDetail({ schedule: scheduleShape }).name).toBe("morning-digest");
    expect(
      parseScheduleDelivery({
        delivery: { schedule: "morning-digest", window: "2026-09-12T10:01", executionId: "a".repeat(64) },
      }).executionId,
    ).toBe("a".repeat(64));
    expect(() => parseScheduleList({})).toThrow(/unexpected shape/);
    expect(() => parseScheduleList({ schedules: [{ name: 1 }] })).toThrow(/unexpected shape/);
    expect(() => parseScheduleList({ schedules: [{ ...scheduleShape, id: "not-hex" }] })).toThrow(/unexpected shape/);
    expect(() => parseScheduleList({ schedules: [{ ...scheduleShape, enabled: "yes" }] })).toThrow(/unexpected shape/);
    expect(() => parseScheduleDetail({})).toThrow(/unexpected shape/);
    expect(() => parseScheduleDetail({ schedule: { ...scheduleShape, kind: "whenever" } })).toThrow(/unexpected shape/);
    expect(() => parseScheduleDetail({ schedule: { ...scheduleShape, name: "UPPER" } })).toThrow(/unexpected shape/);
    expect(() => parseScheduleDelivery({})).toThrow(/unexpected shape/);
    expect(() => parseScheduleDelivery({ delivery: { schedule: "x", window: "y" } })).toThrow(/unexpected shape/);
    const receipt = {
      form: "contact",
      executionId: "a".repeat(64),
      replayed: false,
      statusUrl: `/api/executions/${"a".repeat(64)}`,
    };
    expect(parseFormSubmit(receipt).executionId).toBe("a".repeat(64));
    expect(() => parseFormSubmit({ ...receipt, replayed: "yes" })).toThrow(/unexpected shape/);
    expect(() => parseFormSubmit({ ...receipt, scheduled: 1 })).toThrow(/unexpected shape/);
    expect(() => parseFormSubmit({})).toThrow(/unexpected shape/);
    // Guard chains short-circuit on non-records and on every field failure,
    // so malformed wire shapes fail loud instead of trusting partial data.
    expect(() => parseFormList(null)).toThrow(/unexpected shape/);
    expect(() => parseFormList({ forms: [null] })).toThrow(/unexpected shape/);
    expect(() => parseFormDetail(null)).toThrow(/unexpected shape/);
    expect(() => parseFormStartup({ ...started, snapshot: null })).toThrow(/unexpected shape/);
    expect(() => parseFormStartup({ ...started, options: null })).toThrow(/unexpected shape/);
    expect(() => parseFormProviders({ form: "c", options: null })).toThrow(/unexpected shape/);
    expect(() => parseFormSubmit({ ...receipt, executionId: "short" })).toThrow(/unexpected shape/);
    expect(() => parseFormSubmit({ ...receipt, statusUrl: 7 })).toThrow(/unexpected shape/);
  });

  it("drives forms through the typed client with offline guards", async () => {
    const detail = {
      form: {
        id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
        name: "contact",
        sagaId: helloSaga.id,
        allowPrefill: false,
        fields: [{ name: "name", type: "text", required: true, maxLength: 1024 }],
      },
    };
    const started = { form: "contact", handle: "a".repeat(64), expiresAt: "t", snapshot: {}, options: {} };
    const receiptId = "b".repeat(64);
    const receipt = {
      form: "contact",
      executionId: receiptId,
      replayed: false,
      statusUrl: `/api/executions/${receiptId}`,
    };
    const { fetchImpl } = stub([
      json({
        forms: [{ id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5", name: "contact", sagaId: helloSaga.id }],
      }),
      json(detail),
      json(detail),
      json(detail),
      json({ deleted: "contact" }),
      json(started),
      json({ form: "contact", options: {}, errors: {} }),
      json(receipt),
    ]);
    const client = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl });
    expect(await client.listForms()).toHaveLength(1);
    expect((await client.getForm("contact")).name).toBe("contact");
    const fields = [{ name: "name", type: "text", required: true }];
    expect((await client.createForm({ name: "contact", sagaId: helloSaga.id, fields })).name).toBe("contact");
    expect((await client.updateForm("contact", { sagaId: helloSaga.id, fields })).name).toBe("contact");
    await client.deleteForm("contact");
    expect((await client.startForm("contact")).handle).toBe("a".repeat(64));
    expect((await client.getFormProviders("contact")).form).toBe("contact");
    const submitted = await client.submitForm({ form: "contact", handle: "a".repeat(64), key: "form-sdk-test-0001" });
    expect(submitted.executionId).toBe(receiptId);
    await expect(client.getForm("Bad Name")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    await expect(client.submitForm({ form: "contact", handle: "nope" })).rejects.toMatchObject({
      code: "SDK_INVALID_REF",
    });
    const malformed = stub([json({ nope: true })]);
    await expect(
      createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: malformed.fetchImpl }).listForms(),
    ).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
  });

  it("covers client optional branches: history, config, forms, submit, readJson", async () => {
    // listHistory with no query sends a bare URL (empty suffix branch).
    const bare = stub([json({ executions: [], hasMore: false, nextCursor: null })]);
    const bareClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: bare.fetchImpl });
    expect((await bareClient.listHistory()).executions).toEqual([]);
    expect(bare.calls[0]?.url).toBe("http://local.test/api/executions");
    // listHistory with a cursor appends the cursor param.
    const paged = stub([
      json(catalog),
      json({
        executions: [{ executionId: "d".repeat(64), sagaId: helloSaga.id, status: "Failed" }],
        hasMore: false,
        nextCursor: null,
      }),
    ]);
    const pagedClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: paged.fetchImpl });
    await pagedClient.listHistory({ saga: "hello", cursor: "abc" });
    expect(paged.calls[1]?.url).toContain("cursor=abc");
    // listNotifications with and without a limit (suffix branches).
    const noLimit = stub([json({ notifications: [] })]);
    const noLimitClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: noLimit.fetchImpl });
    expect(await noLimitClient.listNotifications()).toEqual([]);
    expect(noLimit.calls[0]?.url).toBe("http://local.test/api/notifications");
    const withLimit = stub([json({ notifications: [] })]);
    const withLimitClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: withLimit.fetchImpl,
    });
    await withLimitClient.listNotifications(5);
    expect(withLimit.calls[0]?.url).toContain("limit=5");
    // setConfig without value/description omits both keys (spread branches).
    const entry = {
      config: {
        id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
        key: "k",
        type: "int",
        value: 1,
        description: null,
        managedBy: null,
        updatedAt: "t",
        updatedBy: "u",
      },
    };
    const setBare = stub([json(entry)]);
    const setBareClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: setBare.fetchImpl });
    await setBareClient.setConfig({ key: "k", type: "int" });
    expect(JSON.parse(String(setBare.calls[0]?.init.body))).toEqual({ key: "k", type: "int" });
    // updateConfig with a full patch sends every key; bad ids fail offline.
    const setFull = stub([json(entry)]);
    const setFullClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: setFull.fetchImpl });
    await setFullClient.updateConfig({
      id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      key: "k",
      type: "int",
      value: 2,
      description: "d",
    });
    expect(JSON.parse(String(setFull.calls[0]?.init.body))).toMatchObject({ key: "k", value: 2 });
    await expect(setFullClient.updateConfig({ id: "nope" })).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    await expect(setFullClient.deleteConfig("nope")).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    // Form create/update with all optional metadata sends every key.
    const detailAll = {
      form: {
        id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
        name: "contact",
        sagaId: helloSaga.id,
        title: "T",
        description: "D",
        allowPrefill: true,
        fields: [],
      },
    };
    const formStub = stub([
      json(detailAll),
      json(detailAll),
      json({ form: "contact", handle: "a".repeat(64), expiresAt: "t", snapshot: {}, options: {} }),
    ]);
    const formClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: formStub.fetchImpl });
    const fullFields = [{ name: "name", type: "text", required: true }];
    await formClient.createForm({
      name: "contact",
      sagaId: helloSaga.id,
      title: "T",
      description: "D",
      allowPrefill: true,
      fields: fullFields,
    });
    expect(JSON.parse(String(formStub.calls[0]?.init.body))).toMatchObject({ title: "T", allowPrefill: true });
    await formClient.updateForm("contact", {
      sagaId: helloSaga.id,
      title: "T",
      description: "D",
      allowPrefill: true,
      fields: fullFields,
    });
    expect(JSON.parse(String(formStub.calls[1]?.init.body))).toMatchObject({ title: "T", allowPrefill: true });
    // startForm with prefill wraps it; submitForm with all optionals sends them.
    await formClient.startForm("contact", { name: "Ada" });
    expect(JSON.parse(String(formStub.calls[2]?.init.body))).toEqual({ prefill: { name: "Ada" } });
    const receiptId = "c".repeat(64);
    const receiptStub = stub([
      json({ form: "contact", executionId: receiptId, replayed: false, statusUrl: `/api/executions/${receiptId}` }),
    ]);
    const receiptClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: receiptStub.fetchImpl,
    });
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    await receiptClient.submitForm({
      form: "contact",
      handle: "a".repeat(64),
      values: { name: "Ada" },
      scheduleAt: future,
      key: "form-sdk-full-0001",
    });
    expect(JSON.parse(String(receiptStub.calls[0]?.init.body))).toMatchObject({ scheduleAt: future });
    await expect(
      receiptClient.submitForm({ form: "contact", handle: "a".repeat(64), key: "bad key!!" }),
    ).rejects.toMatchObject({ code: "SDK_INVALID_REF" });
    // readJson on a failed response without an envelope keeps the fallback
    // message; a non-Error throw becomes SDK_CLIENT_NETWORK.
    const failedBare = stub([json({ nope: true }, 422)]);
    const failedClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: failedBare.fetchImpl,
    });
    await expect(failedClient.getForm("contact")).rejects.toMatchObject({ code: "SDK_CLIENT_MISMATCH" });
    const boom = stub([new Error("down")]);
    const boomClient = createSdkClient({ base: "http://local.test", token: "tok", fetchImpl: boom.fetchImpl });
    await expect(boomClient.listForms()).rejects.toMatchObject({ code: "SDK_CLIENT_NETWORK" });
    // previewSaga without input sends {} (default-arg branch).
    const previewStub = stub([
      json(catalog),
      json({
        preview: {
          saga: { id: helloSaga.id, name: "hello", revision: "hello-v1" },
          input: {},
          environmentChecked: false,
          environment: [],
          persisted: false,
          dispatched: false,
        },
      }),
    ]);
    const previewClient = createSdkClient({
      base: "http://local.test",
      token: "tok",
      fetchImpl: previewStub.fetchImpl,
    });
    expect((await previewClient.previewSaga({ saga: "hello" })).input).toEqual({});
    expect(JSON.parse(String(previewStub.calls[1]?.init.body))).toMatchObject({ input: {} });
  });
});
