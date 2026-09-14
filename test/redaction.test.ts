// SPDX-License-Identifier: AGPL-3.0
// Issue #110 redaction items folded into workerd tests: console logs,
// structured errors, Workflow results, history, HTTP responses, and the
// observability hook. Each test names its enforcement location — absence
// alone is not the gate; the pinning mechanism is.
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { trackWorkflowInstance, useWorkflowHarness } from "./helpers/workflow-harness";
import { echoSaga, executionId, ninjaSaga, smokeSaga } from "../src/domain";
import { buildUsage } from "../src/usage";

const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const SECRET_SENTINEL = "test-client-secret-sentinel";
const TOKEN_SENTINEL = "test-access-token-sentinel";
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

useWorkflowHarness(bindings.DB, {
  setup: async () => {
    await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
      .bind(
        "00000000-0000-4000-8000-000000000102",
        principal.orgId,
        "0606e237-137b-4629-8346-85468e1c2df6",
        "https://ninja-in-test.invalid/api",
      )
      .run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "http://127.0.0.1:8788/echo") return Response.json({ message: "hello" });
      if (url === "https://ninja-in-test.invalid/oauth/token") {
        return Response.json({ access_token: TOKEN_SENTINEL, expires_in: 3600, token_type: "Bearer" });
      }
      if (url === "https://ninja-in-test.invalid/api/v2/organizations") {
        return Response.json([{ id: 1, name: "Acme" }]);
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
  },
});

it("pins the observability hook schema: counts, IDs, durations only", () => {
  // Enforcement location: buildUsage allowlist (src/usage.ts). The hook can
  // only emit these keys; there is no free-text field for a secret to land in.
  const usage = buildUsage({
    saga: smokeSaga.name,
    sagaRevision: smokeSaga.revision,
    executionId: "0".repeat(64),
    orgId: principal.orgId,
    status: "Succeeded",
    operationRows: 4,
    reads: 4,
    writes: 8,
    stepsExecuted: 4,
    durationMs: 7,
  });
  expect(Object.keys(usage).sort()).toEqual(
    ["d1", "executionId", "note", "orgId", "saga", "sagaRevision", "status", "version", "workflows", "workers"].sort(),
  );
  expect(Object.keys(usage.d1).sort()).toEqual(["operationRows", "reads", "writes"]);
  expect(Object.keys(usage.workflows).sort()).toEqual(["durationMs", "instancesStarted", "stepsExecuted"]);
  expect(Object.keys(usage.workers).sort()).toEqual(["cpuMs", "requestsHandled"]);
  for (const value of [usage.d1.operationRows, usage.d1.reads, usage.d1.writes, usage.workflows.stepsExecuted]) {
    expect(typeof value).toBe("number");
  }
  const text = JSON.stringify(usage);
  expect(text).not.toContain(SECRET_SENTINEL);
  expect(text).not.toContain(TOKEN_SENTINEL);
  expect(text).not.toMatch(/password|authorization/i);
});

it("keeps the console hook free of secret material on a live run", async () => {
  // Enforcement location: logUsage logs the pinned UsageBlock only
  // (src/usage.ts); nothing else in src/ logs at runtime.
  const seen: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(" "));
    });
  }
  const key = "redaction-console-001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.SMOKE_WORKFLOW, id);
  expect((await worker.fetch(submitRequest(smokeSaga.id, {}, key), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  // The hook must actually have fired: a vacuous capture proves nothing.
  expect(seen.some((line) => line.includes("WRANGNAROK_USAGE"))).toBe(true);
  for (const line of seen) {
    expect(line).not.toContain(SECRET_SENTINEL);
    expect(line).not.toContain(TOKEN_SENTINEL);
  }
});

it("shapes structured errors to exactly {code, message} on every path", async () => {
  // Enforcement location: Fault + the index.ts error envelope + the
  // failExecution serializer. No path interpolates vendor bodies, inputs, or
  // secrets — the shape itself is the redaction.
  const key = "redaction-errors-001";
  const badInput = await worker.fetch(submitRequest(echoSaga.id, { message: 42 }, key), bindings);
  expect(badInput.status).toBe(400);
  const bodies: string[] = [await badInput.text()];
  const noAuth = await worker.fetch(new Request("https://local.test/api/executions"), bindings);
  expect(noAuth.status).toBe(401);
  bodies.push(await noAuth.text());
  const missing = await worker.fetch(getRequest(`/api/executions/${"0".repeat(64)}`, "redaction-errors-002"), bindings);
  expect(missing.status).toBe(404);
  bodies.push(await missing.text());
  for (const text of bodies) {
    expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
    expect(Object.keys(JSON.parse(text).error).sort()).toEqual(["code", "message"]);
    expect(text).not.toContain(SECRET_SENTINEL);
    expect(text).not.toContain(TOKEN_SENTINEL);
  }
});

it("shapes Workflow results to exact vendor-free summaries", async () => {
  // Enforcement location: listOrganizations shaping (NINJA_ORGS_MAX cap,
  // {id, name} projection) in src/integrations/ninjaone.ts. Detail result
  // carries exactly the shaped summary — no token, no raw vendor document.
  const key = "redaction-result-001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.NINJA_WORKFLOW, id);
  expect((await worker.fetch(submitRequest(ninjaSaga.id, {}, key), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  const text = await (await worker.fetch(getRequest(`/api/executions/${id}`, key), bindings)).text();
  const body = JSON.parse(text) as {
    result: { organizationCount: number; organizations: Record<string, unknown>[] };
  };
  expect(Object.keys(body.result).sort()).toEqual(["organizationCount", "organizations"]);
  for (const org of body.result.organizations) {
    expect(Object.keys(org).sort()).toEqual(["id", "name"]);
  }
  expect(text).not.toContain(SECRET_SENTINEL);
  expect(text).not.toContain(TOKEN_SENTINEL);
});

it("shapes history rows to the summary allowlist, never input/result", async () => {
  // Enforcement location: summary() in src/executions.ts plus the list
  // SELECT column list. History rows cannot carry payloads by construction.
  const key = "redaction-history-001";
  const id = await executionId(principal, key);
  const { inner: instance } = await trackWorkflowInstance(bindings.ECHO_WORKFLOW, id);
  expect((await worker.fetch(submitRequest(echoSaga.id, { message: "hello" }, key), bindings)).status).toBe(202);
  await instance.waitForStatus("complete");
  const text = await (await worker.fetch(getRequest("/api/executions", key), bindings)).text();
  const body = JSON.parse(text) as { executions: Record<string, unknown>[] };
  expect(body.executions.length).toBeGreaterThan(0);
  for (const row of body.executions) {
    expect(row).not.toHaveProperty("input");
    expect(row).not.toHaveProperty("result");
    expect(row).not.toHaveProperty("error");
  }
  expect(text).not.toContain(SECRET_SENTINEL);
  expect(text).not.toContain(TOKEN_SENTINEL);
});
