// Guard rails around dispatch and request parsing: dispatch confirmation
// failures, prepareExecution preconditions, local-auth configuration, and
// malformed request shapes. Real D1 and Worker fetch; the only double is a
// Workflow binding whose createBatch throws (a native control, not data).
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings, RequestRateLimiter } from "../src/bindings";
import { authenticate } from "../src/auth";
import { boundedJson, echoSaga, ninjaSaga, parseInput, parseKey, parseNinjaOrgsInput } from "../src/domain";
import { enforceNinjaOneExecutionBudget, prepareExecution } from "../src/executions";
import migration from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const PRINCIPAL = {
  orgId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
};

function postExecutions(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "edge-guard-00001",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function limiter(success: boolean): RequestRateLimiter {
  return { limit: vi.fn(async () => ({ success })) };
}

function withLimiters(principal: RequestRateLimiter, provider: RequestRateLimiter): Bindings {
  return {
    ...bindings,
    ENVIRONMENT: "dev",
    NINJAONE_PRINCIPAL_RATE_LIMITER: principal,
    NINJAONE_PROVIDER_RATE_LIMITER: provider,
  };
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

it("emits a structured request log line without request detail", async () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  const response = await worker.fetch(
    new Request("https://local.test/api/sagas", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    bindings,
  );
  expect(response.status).toBe(200);
  const line = lines.find((entry) => entry.startsWith("WRANGNAROK_REQUEST "));
  expect(line).toBeDefined();
  const logged = JSON.parse(line!.slice("WRANGNAROK_REQUEST ".length)) as Record<string, unknown>;
  expect(logged).toMatchObject({ method: "GET", route: "GET /api/sagas", status: 200 });
  expect(typeof logged.durationMs).toBe("number");
  expect(JSON.stringify(logged)).not.toContain(TOKEN);
});

it("serves 404 for non-API routes when no assets binding exists", async () => {
  const response = await worker.fetch(new Request("https://local.test/"), {
    ...bindings,
    ASSETS: undefined,
  } as unknown as Bindings);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
});

it("delegates non-API routes to the assets binding when present", async () => {
  const response = await worker.fetch(new Request("https://local.test/"), bindings);
  // Miniflare serves Static Assets if configured, else 404: either way the
  // request routes past the API gate without authentication.
  expect([200, 404]).toContain(response.status);
});

it("maps corrupt persisted input to an internal error, never a leak", async () => {
  const id = "ef".repeat(32);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      PRINCIPAL.orgId,
      PRINCIPAL.userId,
      "not-json",
      1,
      "Succeeded",
      new Date().toISOString(),
    )
    .run();
  const detail = await worker.fetch(
    new Request(`https://local.test/api/executions/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    bindings,
  );
  expect(detail.status).toBe(500);
  expect(await detail.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
});

it("requires unencoded JSON on submission", async () => {
  const body = { sagaId: echoSaga.id, input: { message: "hi" } };
  const wrongType = await worker.fetch(postExecutions(body, { "Content-Type": "text/plain" }), bindings);
  expect(wrongType.status).toBe(415);
  expect(await wrongType.json()).toMatchObject({ error: { code: "JSON_REQUIRED" } });

  const encoded = await worker.fetch(postExecutions(body, { "Content-Encoding": "gzip" }), bindings);
  expect(encoded.status).toBe(415);
});

it("rejects missing idempotency keys and malformed JSON bodies", async () => {
  const noKey = new Request("https://local.test/api/executions", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "hi" } }),
  });
  const noKeyResponse = await worker.fetch(noKey, bindings);
  expect(noKeyResponse.status).toBe(400);
  expect(await noKeyResponse.json()).toMatchObject({ error: { code: "INVALID_IDEMPOTENCY_KEY" } });
  expect(() => parseKey("short")).toThrow(/Idempotency-Key/);

  const malformed = postExecutions("{oops");
  const malformedResponse = await worker.fetch(malformed, bindings);
  expect(malformedResponse.status).toBe(400);
  expect(await malformedResponse.json()).toMatchObject({ error: { code: "INVALID_JSON" } });

  await expect(boundedJson(null)).rejects.toMatchObject({ code: "INVALID_JSON" });
});

it("reports dispatch confirmation failures as retryable 503s", async () => {
  const failing = {
    ...bindings,
    NINJA_WORKFLOW: {
      createBatch: async () => {
        throw new Error("control plane down");
      },
    },
  } as unknown as Bindings;
  const response = await worker.fetch(
    postExecutions({ sagaId: ninjaSaga.id, input: {} }, { "Idempotency-Key": "edge-dispatch-001" }),
    failing,
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "DISPATCH_UNCONFIRMED" } });
});

it("budgets new NinjaOne executions by principal before shared provider", async () => {
  const principal = limiter(true);
  const provider = limiter(true);
  await enforceNinjaOneExecutionBudget(withLimiters(principal, provider), PRINCIPAL, ninjaSaga.id, "ab".repeat(32));

  expect(principal.limit).toHaveBeenCalledWith({
    key: `environment:dev:org:${PRINCIPAL.orgId}:user:${PRINCIPAL.userId}`,
  });
  expect(provider.limit).toHaveBeenCalledWith({ key: "ninjaone:provider" });
});

it("does not budget Sagas that cannot call NinjaOne", async () => {
  const principal = limiter(false);
  const provider = limiter(false);
  await enforceNinjaOneExecutionBudget(withLimiters(principal, provider), PRINCIPAL, echoSaga.id, "bc".repeat(32));

  expect(principal.limit).not.toHaveBeenCalled();
  expect(provider.limit).not.toHaveBeenCalled();
});

it("keeps exact NinjaOne execution replays available without consuming budget", async () => {
  const id = "ca".repeat(32);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      ninjaSaga.id,
      ninjaSaga.name,
      ninjaSaga.revision,
      PRINCIPAL.orgId,
      PRINCIPAL.userId,
      "{}",
      1,
      "Pending",
      new Date().toISOString(),
    )
    .run();
  const principal = limiter(false);
  const provider = limiter(false);

  await enforceNinjaOneExecutionBudget(withLimiters(principal, provider), PRINCIPAL, ninjaSaga.id, id);

  expect(principal.limit).not.toHaveBeenCalled();
  expect(provider.limit).not.toHaveBeenCalled();
});

it("rejects a principal over budget without consuming shared provider budget", async () => {
  const principal = limiter(false);
  const provider = limiter(true);

  await expect(
    enforceNinjaOneExecutionBudget(withLimiters(principal, provider), PRINCIPAL, ninjaSaga.id, "de".repeat(32)),
  ).rejects.toMatchObject({ status: 429, code: "ADMISSION_LIMITED" });
  expect(provider.limit).not.toHaveBeenCalled();
});

it("rejects a NinjaOne execution when the shared provider budget is exhausted", async () => {
  await expect(
    enforceNinjaOneExecutionBudget(
      withLimiters(limiter(true), limiter(false)),
      PRINCIPAL,
      ninjaSaga.id,
      "ef".repeat(32),
    ),
  ).rejects.toMatchObject({ status: 429, code: "ADMISSION_LIMITED" });
});

it("fails closed when native admission control is unavailable", async () => {
  const unavailable: RequestRateLimiter = {
    limit: vi.fn(async () => {
      throw new Error("binding unavailable");
    }),
  };

  await expect(
    enforceNinjaOneExecutionBudget(withLimiters(unavailable, limiter(true)), PRINCIPAL, ninjaSaga.id, "fa".repeat(32)),
  ).rejects.toMatchObject({ status: 503, code: "ADMISSION_UNAVAILABLE" });
});

it("fences async and inline NinjaOne routes before persistence or vendor work", async () => {
  const fenced = withLimiters(limiter(false), limiter(true));
  const vendorFetch = vi.spyOn(globalThis, "fetch");
  const asyncResponse = await worker.fetch(
    postExecutions({ sagaId: ninjaSaga.id, input: {} }, { "Idempotency-Key": "budget-async-fenced-001" }),
    fenced,
  );
  const providerResponse = await worker.fetch(
    new Request("https://local.test/api/executions/provider", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "budget-provider-fenced-001",
      },
      body: JSON.stringify({ sagaId: ninjaSaga.id, input: {} }),
    }),
    fenced,
  );

  expect(asyncResponse.status).toBe(429);
  expect(providerResponse.status).toBe(429);
  expect(await asyncResponse.json()).toMatchObject({ error: { code: "ADMISSION_LIMITED" } });
  expect(await providerResponse.json()).toMatchObject({ error: { code: "ADMISSION_LIMITED" } });
  expect(vendorFetch).not.toHaveBeenCalled();
  const receipts = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM executions WHERE saga_id=?")
    .bind(ninjaSaga.id)
    .first<{ count: number }>();
  expect(receipts?.count).toBe(0);
});

it("refuses to prepare unknown revisions and cancelled executions", async () => {
  const id = "cd".repeat(32);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      PRINCIPAL.orgId,
      PRINCIPAL.userId,
      '{"message":"hi"}',
      1,
      "Pending",
      new Date().toISOString(),
    )
    .run();
  await expect(
    prepareExecution(bindings.DB, id, ninjaSaga.id, ninjaSaga.revision, parseNinjaOrgsInput),
  ).rejects.toThrow("Unknown Saga revision.");

  await bindings.DB.prepare("UPDATE executions SET status='Cancelled' WHERE id=?").bind(id).run();
  await expect(prepareExecution(bindings.DB, id, echoSaga.id, echoSaga.revision, parseInput)).rejects.toThrow(
    "Execution was cancelled.",
  );
});

it("requires local auth configuration before comparing tokens", async () => {
  const request = new Request("https://local.test/api/sagas", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  await expect(authenticate(request, { LAB_ENABLED: "true" })).rejects.toMatchObject({
    code: "LOCAL_AUTH_NOT_CONFIGURED",
  });
  await expect(authenticate(request, { LAB_ENABLED: "false" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  // Oversized and missing credentials both fail closed without comparing.
  const longToken = new Request("https://local.test/api/sagas", {
    headers: { Authorization: `Bearer ${"b".repeat(129)}` },
  });
  await expect(authenticate(longToken, bindings)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const missingToken = new Request("https://local.test/api/sagas");
  await expect(authenticate(missingToken, bindings)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
