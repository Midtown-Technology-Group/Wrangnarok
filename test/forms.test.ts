// SPDX-License-Identifier: AGPL-3.0
// FORM-01 (issue #118) through the FORM-02 lifecycle (issue #155): the
// persisted hello-greeting Form binds to the hello Saga end to end on the
// real local runtime. Field names bind to Saga inputs by name; the caller
// mints a session-bound startup handle, the server validates the
// submission against the persisted declaration, and only validated input
// reaches the Saga. No provider, no publication.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import seed from "../scripts/seed-local.sql?raw";
const bindings = env as unknown as Bindings;
const principal = { orgId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };
const key = "form-01-hello-001";
function authed(path: string, method = "GET", body?: unknown, idempotencyKey = key): Request {
  return new Request(`http://local.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}
/** FORM-02 startup handshake for the pilot form: mint a handle, then wrap
 * the raw values in the handle-bound submit envelope. */
async function startupHandle(): Promise<string> {
  const started = await worker.fetch(
    authed("/api/forms/hello-greeting/startup", "POST", {}, "form-01-startup"),
    bindings,
  );
  expect(started.status).toBe(201);
  return ((await started.json()) as { handle: string }).handle;
}
function submitBody(values: unknown, handle: string): Record<string, unknown> {
  return { handle, values };
}
beforeEach(async () => {
  // Real local D1 SQL statements, not an in-memory repository double.
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(seed);
  // The pilot declaration is FORM-01 test fixture state, not shared seed:
  // other suites apply only migration 0001 and must never see a forms table.
  await bindings.DB.prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(
      "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      principal.orgId,
      "hello-greeting",
      helloSaga.id,
      '[{"name":"name","type":"text","required":true,"maxLength":1024}]',
      "2026-09-11T00:00:00.000Z",
    )
    .run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("hello must not fetch");
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
it("reads the persisted pilot declaration", async () => {
  const res = await worker.fetch(authed("/api/forms/hello-greeting"), bindings);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    form: {
      id: "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      name: "hello-greeting",
      sagaId: helloSaga.id,
      allowPrefill: false,
      fields: [{ name: "name", type: "text", required: true, maxLength: 1024 }],
    },
  });
  expect((await worker.fetch(authed("/api/forms/no-such-form"), bindings)).status).toBe(404);
  expect(await worker.fetch(authed("/api/forms/no-such-form"), bindings).then((res) => res.json())).toMatchObject({
    error: { code: "FORM_NOT_FOUND" },
  });
});
it("submits the pilot form through the handle-bound gate: startup, bind, dispatch, persisted success", async () => {
  const id = await executionId(principal, key);
  await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
  const handle = await startupHandle();
  const accepted = await worker.fetch(
    authed("/api/forms/hello-greeting/submit", "POST", submitBody({ name: "Ada" }, handle)),
    bindings,
  );
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
  expect(await accepted.json()).toMatchObject({ form: "hello-greeting", executionId: id, replayed: false });
  await instance.waitForStatus("complete");
  const detail = await worker.fetch(authed(`/api/executions/${id}`), bindings);
  expect(await detail.json()).toMatchObject({
    executionId: id,
    sagaId: helloSaga.id,
    status: "Succeeded",
    input: { name: "Ada" },
    result: { greeting: "Hello, Ada!", name: "Ada" },
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects invalid submissions with structured per-field 422 details", async () => {
  const missing = await worker.fetch(
    authed("/api/forms/hello-greeting/submit", "POST", submitBody({}, await startupHandle()), "form-01-hello-002"),
    bindings,
  );
  expect(missing.status).toBe(422);
  expect(await missing.json()).toEqual({
    error: {
      code: "FORM_VALIDATION_FAILED",
      message: "The form submission did not pass validation.",
      details: [{ field: "name", code: "REQUIRED", message: "This field is required." }],
    },
  });
  const unknown = await worker.fetch(
    authed(
      "/api/forms/hello-greeting/submit",
      "POST",
      submitBody({ name: "Ada", nickname: "x" }, await startupHandle()),
      "form-01-hello-003",
    ),
    bindings,
  );
  expect(unknown.status).toBe(422);
  expect(await unknown.json()).toEqual({
    error: {
      code: "FORM_VALIDATION_FAILED",
      message: "The form submission did not pass validation.",
      details: [{ field: "nickname", code: "UNKNOWN_FIELD", message: "This field is not declared." }],
    },
  });
  const wrongType = await worker.fetch(
    authed(
      "/api/forms/hello-greeting/submit",
      "POST",
      submitBody({ name: 7 }, await startupHandle()),
      "form-01-hello-004",
    ),
    bindings,
  );
  expect(wrongType.status).toBe(422);
  expect(await wrongType.json()).toMatchObject({
    error: {
      code: "FORM_VALIDATION_FAILED",
      details: [{ field: "name", code: "NOT_STRING" }],
    },
  });
});
it("never resolves another Organization's form", async () => {
  const foreign = await worker.fetch(authed("/api/forms/hello-greeting", "GET"), {
    ...bindings,
    LAB_ORG_ID: "00000000-0000-4000-8000-000000000004",
  });
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
  const submitForeign = await worker.fetch(
    authed("/api/forms/hello-greeting/submit", "POST", submitBody({ name: "Ada" }, await startupHandle())),
    {
      ...bindings,
      LAB_ORG_ID: "00000000-0000-4000-8000-000000000004",
    },
  );
  expect(submitForeign.status).toBe(404);
  expect(await submitForeign.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
});
it("requires a live startup handle: unknown handles dispatch nothing", async () => {
  const bogus = await worker.fetch(
    authed(
      "/api/forms/hello-greeting/submit",
      "POST",
      submitBody({ name: "Ada" }, "b".repeat(64)),
      "form-01-hello-stale",
    ),
    bindings,
  );
  expect(bogus.status).toBe(422);
  expect(await bogus.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  const noHandle = await worker.fetch(
    authed("/api/forms/hello-greeting/submit", "POST", { values: { name: "Ada" } }, "form-01-hello-nohandle"),
    bindings,
  );
  expect(noHandle.status).toBe(422);
  expect(await noHandle.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  const badEnvelope = await worker.fetch(
    authed("/api/forms/hello-greeting/submit", "POST", { name: "Ada" }, "form-01-hello-badenvelope"),
    bindings,
  );
  expect(badEnvelope.status).toBe(422);
  expect(await badEnvelope.json()).toMatchObject({ error: { code: "FORM_VALIDATION_FAILED" } });
  const badValues = await worker.fetch(
    authed(
      "/api/forms/hello-greeting/submit",
      "POST",
      submitBody(["Ada"], await startupHandle()),
      "form-01-hello-badvalues",
    ),
    bindings,
  );
  expect(badValues.status).toBe(422);
  expect(await badValues.json()).toMatchObject({
    error: { code: "FORM_VALIDATION_FAILED", details: [{ field: "", code: "NOT_OBJECT" }] },
  });
});
it("bounds handle-bound submissions and answers 404 for unknown forms", async () => {
  const notObject = await worker.fetch(
    authed("/api/forms/hello-greeting/submit", "POST", ["Ada"], "form-01-hello-005"),
    bindings,
  );
  expect(notObject.status).toBe(422);
  expect(await notObject.json()).toMatchObject({
    error: { code: "FORM_VALIDATION_FAILED", details: [{ field: "", code: "NOT_OBJECT" }] },
  });
  const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`k${index}`, "x"]));
  const crowded = await worker.fetch(
    authed("/api/forms/hello-greeting/submit", "POST", submitBody(tooMany, await startupHandle()), "form-01-hello-006"),
    bindings,
  );
  expect(crowded.status).toBe(422);
  expect(await crowded.json()).toMatchObject({
    error: { code: "FORM_VALIDATION_FAILED", details: [{ field: "", code: "TOO_MANY_FIELDS" }] },
  });
  const tooLong = await worker.fetch(
    authed(
      "/api/forms/hello-greeting/submit",
      "POST",
      submitBody({ name: "x".repeat(1025) }, await startupHandle()),
      "form-01-hello-007",
    ),
    bindings,
  );
  expect(tooLong.status).toBe(422);
  expect(await tooLong.json()).toMatchObject({
    error: { code: "FORM_VALIDATION_FAILED", details: [{ field: "name", code: "TOO_LONG" }] },
  });
  const encoded = new Request(`http://local.test/api/forms/hello-greeting/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Idempotency-Key": "form-01-hello-008",
    },
    body: JSON.stringify({ name: "Ada" }),
  });
  const refused = await worker.fetch(encoded, bindings);
  expect(refused.status).toBe(415);
  expect(await refused.json()).toMatchObject({ error: { code: "JSON_REQUIRED" } });
  const missing = await worker.fetch(
    authed("/api/forms/no-such-form/submit", "POST", { name: "Ada" }, "form-01-hello-009"),
    bindings,
  );
  expect(missing.status).toBe(404);
});
