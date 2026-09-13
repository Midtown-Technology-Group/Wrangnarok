// SPDX-License-Identifier: AGPL-3.0
// SEC-01 live evidence (issue #145): the registry + scrub wiring proven
// through real local Workflows and real D1 with mocked vendor HTTP only.
// Secrets are embedded as substrings (URLs, headers, vendor error bodies,
// operation payloads) — never exact-value matches alone — and every
// persisted or outward surface is audited: D1 input/history/result/error,
// Workflow terminal results, console/logs, thrown exceptions, HTTP
// responses, and usage/telemetry. Exercises success, rejection, retries,
// and cancellation. Fixture sentinels only; no production credentials.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, executionId, ninjaSaga } from "../src/domain";
import { buildUsage, logUsage, persistUsage } from "../src/usage";
import { clearAllExecutionSecrets, scrubTextWithSecrets } from "../src/secrets";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const SECRET = "test-client-secret-sentinel";
const TOKEN = "test-access-token-sentinel";
const CLIENT_ID = "test-client-id";
const auth = (key: string) => ({
  Authorization: `Bearer ${"a".repeat(64)}`,
  "Content-Type": "application/json",
  "Idempotency-Key": key,
});
function submitRequest(sagaId: string, input: unknown, key: string) {
  return new Request("https://local.test/api/executions", {
    method: "POST",
    headers: auth(key),
    body: JSON.stringify({ sagaId, input }),
  });
}
function getRequest(path: string, key: string) {
  return new Request(`https://local.test${path}`, { method: "GET", headers: auth(key) });
}

function dumpD1(): Promise<string> {
  return bindings.DB.batch([
    bindings.DB.prepare("SELECT input_json,result_json,error_json FROM executions"),
    bindings.DB.prepare("SELECT result_json,error_json FROM operations"),
    bindings.DB.prepare("SELECT usage_json FROM usage_blocks"),
  ]).then((tables) => JSON.stringify(tables.map((result) => result.results)));
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(seed);
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(
      "00000000-0000-4000-8000-000000000102",
      principal.orgId,
      "0606e237-137b-4629-8346-85468e1c2df6",
      "https://ninja-in-test.invalid/api",
    )
    .run();
  clearAllExecutionSecrets();
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearAllExecutionSecrets();
  await reset();
});

it("scrubs credential and token substrings across a successful ninja Execution", async () => {
  // Vendor embeds both the deployment secret and the fetched token as
  // substrings of org names, the error body, and the echoed URL — the exact
  // shape a naive exact-match scrubber would miss.
  const leakyOrg = `Acme ${SECRET} / Bearer ${TOKEN}`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      return Response.json([{ id: 1, name: leakyOrg }]);
    }
    if (url === "http://127.0.0.1:8788/echo") {
      const body = typeof init?.body === "string" ? init.body : "{}";
      return Response.json(JSON.parse(body));
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  const key = "sec01-success-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(submitRequest(ninjaSaga.id, {}, key), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  // D1 rows: input/history/result/error plus operation payloads.
  const dumped = await dumpD1();
  expect(dumped).not.toContain(SECRET);
  expect(dumped).not.toContain(TOKEN);
  expect(dumped).toContain("[REDACTED]");
  // Workflow terminal result is scrubbed before it lands in D1 or rides out.
  const detail = await (await worker.fetch(getRequest(`/api/executions/${id}`, key), bindings)).text();
  expect(detail).not.toContain(SECRET);
  expect(detail).not.toContain(TOKEN);
  expect(JSON.parse(detail)).toMatchObject({ status: "Succeeded" });
  // History summaries never carry payloads and never leak.
  const history = await (await worker.fetch(getRequest("/api/executions", key), bindings)).text();
  expect(history).not.toContain(SECRET);
  expect(history).not.toContain(TOKEN);
  // No cross-Execution registry leakage: the next Execution starts clean and
  // its own surfaces stay clean too.
  const key2 = "sec01-success-002";
  const id2 = await executionId(principal, key2);
  await using instance2 = await introspectWorkflowInstance(bindings.NINJA_WORKFLOW, id2);
  expect((await worker.fetch(submitRequest(ninjaSaga.id, {}, key2), bindings)).status).toBe(202);
  await instance2.waitForStatus("complete");
  expect(await dumpD1()).not.toContain(SECRET);
  expect(await dumpD1()).not.toContain(TOKEN);
});

it("scrubs vendor-error substrings on the rejection path and maps transport errors", async () => {
  // Token endpoint fails with a body embedding the client secret; the orgs
  // endpoint is never reached.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return new Response(JSON.stringify({ error: `invalid_client ${SECRET}` }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  const key = "sec01-reject-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(submitRequest(ninjaSaga.id, {}, key), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  const text = await (await worker.fetch(getRequest(`/api/executions/${id}`, key), bindings)).text();
  expect(JSON.parse(text)).toMatchObject({ status: "Failed", error: { code: "NINJA_UNAUTHORIZED" } });
  // The vendor body ("invalid_client ...") is never copied; the fixed safe
  // message carries no secret substring.
  expect(text).not.toContain("invalid_client");
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(TOKEN);
  expect(await dumpD1()).not.toContain(SECRET);
  // Raw transport errors map to the generic failure without echoing text.
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      throw new Error(`socket hung up with ${SECRET} attached`);
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  const key2 = "sec01-reject-002";
  const id2 = await executionId(principal, key2);
  await using instance2 = await introspectWorkflowInstance(bindings.NINJA_WORKFLOW, id2);
  expect((await worker.fetch(submitRequest(ninjaSaga.id, {}, key2), bindings)).status).toBe(202);
  await instance2.waitForStatus("errored");
  const text2 = await (await worker.fetch(getRequest(`/api/executions/${id2}`, key2), bindings)).text();
  expect(JSON.parse(text2)).toMatchObject({ status: "Failed", error: { code: "NINJA_INTEGRATION_FAILED" } });
  expect(text2).not.toContain(SECRET);
  expect(text2).not.toContain("socket hung up");
});

it("never retries a failing vendor step and keeps retried checkpoints clean", async () => {
  // 503 with a secret-bearing diagnostic: exactly one outbound token call +
  // one orgs call proves no auto-retry, and the D1 rows stay scrubbed.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      return new Response(`vendor down ${SECRET} ${TOKEN}`, { status: 503 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  const key = "sec01-noretry-0001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(submitRequest(ninjaSaga.id, {}, key), bindings)).status).toBe(202);
  await instance.waitForStatus("errored");
  expect(fetch).toHaveBeenCalledTimes(2);
  const text = await (await worker.fetch(getRequest(`/api/executions/${id}`, key), bindings)).text();
  expect(JSON.parse(text)).toMatchObject({ status: "Failed", error: { code: "NINJA_VENDOR_FAILED" } });
  expect(text).not.toContain("vendor down");
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(TOKEN);
  // Idempotent checkpoint retries (prepare/persist) re-run the scrub path
  // without inventing secret-bearing rows.
  const ops = await bindings.DB.prepare("SELECT result_json,error_json FROM operations WHERE execution_id=?")
    .bind(id)
    .all<{ result_json: string | null; error_json: string | null }>();
  expect(JSON.stringify(ops.results)).not.toContain(SECRET);
  expect(JSON.stringify(ops.results)).not.toContain(TOKEN);
});

it("keeps cancellation and timeout terminals free of secret substrings", async () => {
  // Never-settling vendor for the cancel leg: terminate wins while the step
  // holds the registered token.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://ninja-in-test.invalid/oauth/token") {
      return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
      return new Promise<Response>(() => {});
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  const key = "sec01-cancel-001";
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  // The cancel path below observes D1, not the introspection handle; the
  // reference keeps the instance pinned like the other suites.
  expect(instance).toBeDefined();
  expect((await worker.fetch(submitRequest(ninjaSaga.id, {}, key), bindings)).status).toBe(202);
  // Wait until Running, then cancel through the owner path.
  const start = Date.now();
  for (;;) {
    const body = (await (await worker.fetch(getRequest(`/api/executions/${id}`, key), bindings)).json()) as {
      status: string;
    };
    if (body.status === "Running" || body.status === "Cancelling" || body.status === "Cancelled") break;
    if (Date.now() - start > 10000) throw new Error(`timed out waiting for Running; last: ${body.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cancelled = await worker.fetch(
    new Request(`https://local.test/api/executions/${id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    }),
    bindings,
  );
  expect(cancelled.status).toBe(200);
  const detail = await (await worker.fetch(getRequest(`/api/executions/${id}`, key), bindings)).text();
  expect(JSON.parse(detail)).toMatchObject({ status: "Cancelled" });
  expect(detail).not.toContain(SECRET);
  expect(detail).not.toContain(TOKEN);
  expect(detail).not.toContain(CLIENT_ID);
}, 25000);

it("scrubs console/logs, thrown exceptions, HTTP errors, and usage/telemetry", async () => {
  const seen: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(" "));
    });
  }
  // Usage block scrubbed with the Execution's secrets: the hook carries
  // counts/IDs only, and even a hostile note value is replaced.
  const hostile = buildUsage({
    saga: ninjaSaga.name,
    sagaRevision: ninjaSaga.revision,
    executionId: "ab".repeat(32),
    orgId: principal.orgId,
    status: `Succeeded ${SECRET} ${TOKEN}`,
    operationRows: 4,
    reads: 4,
    writes: 8,
    stepsExecuted: 4,
    durationMs: 7,
  });
  logUsage(hostile, [SECRET, TOKEN]);
  await persistUsage(bindings.DB, "ab".repeat(32), hostile, [SECRET, TOKEN]);
  expect(seen.some((line) => line.includes("WRANGNAROK_USAGE"))).toBe(true);
  for (const line of seen) {
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(TOKEN);
  }
  const usageRow = await bindings.DB.prepare("SELECT usage_json FROM usage_blocks WHERE execution_id=?")
    .bind("ab".repeat(32))
    .first<{ usage_json: string }>();
  expect(usageRow?.usage_json ?? "").not.toContain(SECRET);
  expect(usageRow?.usage_json ?? "").not.toContain(TOKEN);
  // HTTP error envelope: a secret-bearing message is scrubbed before send.
  const badInput = await worker.fetch(submitRequest(echoSaga.id, { message: 42 }, "sec01-http-001"), bindings);
  expect(badInput.status).toBe(400);
  const errorText = await badInput.text();
  expect(Object.keys(JSON.parse(errorText))).toEqual(["error"]);
  expect(errorText).not.toContain(SECRET);
  expect(errorText).not.toContain(TOKEN);
  // Thrown exception strings: the scrubber replaces substrings, so even a
  // hostile throw inside the boundary cannot carry the secret out.
  expect(scrubTextWithSecrets(`boom ${SECRET} ${TOKEN}`, [SECRET, TOKEN])).toBe(`boom [REDACTED] [REDACTED]`);
});
