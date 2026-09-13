// SPDX-License-Identifier: AGPL-3.0
// Dynamic forms (FORM-02, issue #155): designer CRUD, startup handles,
// providers, and submissions over the real local workerd runtime (D1 +
// Workflow bindings are never replaced). Applies migrations 0001 + 0005 +
// 0007 + 0008 + 0009 + 0019 so forms compose with the org-membership gate,
// author Tables (providers), and managed file locations (file fields).
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { executionId, helloSaga } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0009_tables.sql?raw";
import migration19 from "../migrations/0019_files.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const OTHER_USER = "00000000-0000-4000-8000-000000000003";
const OTHER_ORG = "00000000-0000-4000-8000-000000000009";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...extra };
}

function call(path: string, method = "GET", body?: unknown, orgId = ORG, userId = OWNER, key?: string) {
  return worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: headers(key ? { "Idempotency-Key": key } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...bindings, LAB_ORG_ID: orgId, LAB_USER_ID: userId },
  );
}

const CONTACT_FIELDS = [
  { name: "name", type: "text", required: true },
  { name: "nickname", type: "text", required: false, default: "Al" },
  { name: "title", type: "heading", required: false, content: "Contact" },
  { name: "kind", type: "select", required: true, options: ["real", "other"] },
  { name: "nick", type: "text", required: false, visibleWhen: { field: "kind", equals: "other" } },
];

async function createForm(
  name = "contact",
  fields: unknown[] = CONTACT_FIELDS,
  extra: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const response = await call("/api/forms", "POST", { name, sagaId: helloSaga.id, fields, ...extra });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { form: { id: string; name: string } };
  expect(body.form.name).toBe(name);
  return { id: body.form.id };
}

interface StartupReceipt {
  handle: string;
  snapshot: Record<string, unknown>;
  options: Record<string, string[]>;
  expiresAt: string;
}

async function startup(name: string, body?: unknown): Promise<StartupReceipt> {
  const response = await call(`/api/forms/${name}/startup`, "POST", body ?? {});
  expect(response.status).toBe(201);
  return (await response.json()) as StartupReceipt;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  await bindings.DB.exec(migration19);
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO organizations(id,name) VALUES (?,?)").bind(ORG, "Local demo").run();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(OTHER_USER, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG, OTHER_USER, "member", "active", "ordinary", stamp, stamp)
    .run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("hello must not fetch");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("FORM-02 designer: org-scoped CRUD with server-authoritative declarations", () => {
  it("creates, reads, lists, edits, and deletes a form", async () => {
    await createForm();
    const detail = await call("/api/forms/contact");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      form: { name: "contact", sagaId: helloSaga.id, allowPrefill: false, fields: expect.any(Array) },
    });
    const listed = await call("/api/forms");
    expect(await listed.json()).toMatchObject({ forms: [{ name: "contact", sagaId: helloSaga.id }] });
    const edited = await call("/api/forms/contact", "PUT", {
      sagaId: helloSaga.id,
      title: "Contact us",
      allowPrefill: true,
      fields: [{ name: "name", type: "text", required: true }],
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ form: { title: "Contact us", allowPrefill: true } });
    const deleted = await call("/api/forms/contact", "DELETE");
    expect(deleted.status).toBe(200);
    const gone = await call("/api/forms/contact");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
    expect(await call("/api/forms").then((res) => res.json())).toEqual({ forms: [] });
  });
  it("rejects bad declarations with INVALID_FORM and never leaks cross-org", async () => {
    const badName = await call("/api/forms", "POST", { name: "Bad Name", sagaId: helloSaga.id, fields: [] });
    expect(badName.status).toBe(400);
    const badSaga = await call("/api/forms", "POST", { name: "ok", sagaId: "nope", fields: CONTACT_FIELDS });
    expect(await badSaga.json()).toMatchObject({ error: { code: "INVALID_FORM" } });
    const noFields = await call("/api/forms", "POST", { name: "ok", sagaId: helloSaga.id, fields: [] });
    expect(await noFields.json()).toMatchObject({ error: { code: "INVALID_FORM" } });
    const bareDisplay = await call("/api/forms", "POST", {
      name: "ok",
      sagaId: helloSaga.id,
      fields: [{ name: "t", type: "heading", required: false }],
    });
    expect(await bareDisplay.json()).toMatchObject({ error: { code: "INVALID_FORM" } });
    await createForm();
    const foreignGet = await call("/api/forms/contact", "GET", undefined, OTHER_ORG);
    expect(foreignGet.status).toBe(404);
    expect(await foreignGet.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
    const foreignPut = await call(
      "/api/forms/contact",
      "PUT",
      { sagaId: helloSaga.id, fields: CONTACT_FIELDS },
      OTHER_ORG,
    );
    expect(foreignPut.status).toBe(404);
    expect(await foreignPut.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
    const foreignDelete = await call("/api/forms/contact", "DELETE", undefined, OTHER_ORG);
    expect(foreignDelete.status).toBe(404);
    expect(await foreignDelete.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
    expect(await call("/api/forms", "GET", undefined, OTHER_ORG).then((res) => res.json())).toEqual({ forms: [] });
    const emptyPut = await call("/api/forms/contact", "PUT", { sagaId: helloSaga.id, fields: [] });
    expect(emptyPut.status).toBe(400);
    const missingPut = await call("/api/forms/nope", "PUT", { sagaId: helloSaga.id, fields: CONTACT_FIELDS });
    expect(missingPut.status).toBe(404);
    expect(await missingPut.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
  });
  it("rejects query strings on form routes", async () => {
    expect((await call("/api/forms?x=1")).status).toBe(400);
    await createForm();
    expect((await call("/api/forms/contact?x=1")).status).toBe(400);
    expect((await call("/api/forms/contact/startup?x=1", "POST", {})).status).toBe(400);
    expect((await call("/api/forms/contact/providers?x=1")).status).toBe(400);
    const putQuery = await call("/api/forms/contact?x=1", "PUT", { sagaId: helloSaga.id, fields: CONTACT_FIELDS });
    expect(putQuery.status).toBe(400);
    expect(await putQuery.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
    expect((await call("/api/forms/contact?x=1", "DELETE")).status).toBe(400);
    const started = await startup("contact");
    const submitQuery = await call(
      "/api/forms/contact/submit?x=1",
      "POST",
      { handle: started.handle, values: { name: "Ada", kind: "real" } },
      ORG,
      OWNER,
      "form-02-query-submit",
    );
    expect(submitQuery.status).toBe(400);
    expect(await submitQuery.json()).toMatchObject({ error: { code: "UNSUPPORTED_QUERY" } });
  });
});

describe("FORM-02 startup: bounded handles, prefill opt-in, provider projection", () => {
  it("mints a handle with defaults snapshot and static options", async () => {
    await createForm();
    const started = await startup("contact");
    expect(started.handle).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(started.expiresAt)).toBeGreaterThan(Date.now());
    // Declared default merges into the snapshot; display-only never does.
    expect(started.snapshot).toMatchObject({ nickname: "Al" });
    expect(started.snapshot).not.toHaveProperty("title");
    expect(started.options).toMatchObject({ kind: ["real", "other"] });
  });
  it("merges opt-in prefill and rejects display-only, unknown, and non-opt-in prefill", async () => {
    await createForm("contact", CONTACT_FIELDS);
    // No opt-in: prefill is forbidden.
    expect((await call("/api/forms/contact/startup", "POST", { prefill: { name: "Ada" } })).status).toBe(403);
    const edited = await call("/api/forms/contact", "PUT", {
      sagaId: helloSaga.id,
      allowPrefill: true,
      fields: CONTACT_FIELDS,
    });
    expect(edited.status).toBe(200);
    const started = await startup("contact", { prefill: { name: "Ada" } });
    expect(started.snapshot).toMatchObject({ name: "Ada", nickname: "Al" });
    // Prefill values run the submission per-field gate: wrong types,
    // over-bound text, and unlisted options fail closed here.
    const badPrefills = [
      [{ name: 7 }, "NOT_STRING"],
      [{ nickname: "x".repeat(1025) }, "TOO_LONG"],
      [{ kind: "zzz" }, "INVALID_OPTION"],
    ] as const;
    for (const [prefill, code] of badPrefills) {
      const denied = await call("/api/forms/contact/startup", "POST", { prefill });
      expect(denied.status).toBe(422);
      expect(JSON.stringify(await denied.json())).toContain(code);
    }
    for (const prefill of [{ title: "Hi" }, { nope: "x" }]) {
      expect((await call("/api/forms/contact/startup", "POST", { prefill })).status).toBe(422);
    }
    expect((await call("/api/forms/contact/startup", "POST", { prefill: ["x"] })).status).toBe(400);
    expect((await call("/api/forms/nope/startup", "POST", {})).status).toBe(404);
  });
  it("resolves table providers through the caller Table gate without leaking", async () => {
    expect((await call("/api/tables", "POST", { name: "teams" })).status).toBe(201);
    expect((await call("/api/tables/teams/rows/t1", "PUT", { data: { team: "red" } })).status).toBe(201);
    expect((await call("/api/tables/teams/rows/t2", "PUT", { data: { team: "blue" } })).status).toBe(201);
    await createForm("team-pick", [
      { name: "name", type: "text", required: true },
      {
        name: "team",
        type: "select",
        required: true,
        provider: { kind: "table", table: "teams", valueField: "team" },
      },
    ]);
    const providers = await call("/api/forms/team-pick/providers");
    expect(providers.status).toBe(200);
    expect(await providers.json()).toMatchObject({ options: { team: ["blue", "red"] }, errors: {} });
    // A caller denied the table sees an empty list plus an error, never rows.
    const denied = await call("/api/forms/team-pick/providers", "GET", undefined, ORG, OTHER_USER);
    expect(await denied.json()).toMatchObject({ options: { team: [] }, errors: { team: expect.any(String) } });
    // Foreign orgs see 404, never the provider shape.
    expect((await call("/api/forms/team-pick/providers", "GET", undefined, OTHER_ORG)).status).toBe(404);
  });
});

describe("FORM-02 submit: handle-bound delegated dispatch with merge semantics", () => {
  it("submits immediate work end to end and links the execution", async () => {
    // The submit form mirrors its Saga inputs exactly (field names bind to
    // Saga inputs by name): defaults/conditional/provider merge semantics
    // are pinned at unit level plus the startup snapshot, because any extra
    // merged key is Saga drift (400) by the FORM-01 contract.
    await createForm("greet", [{ name: "name", type: "text", required: true }]);
    const started = await startup("greet");
    const key = "form-02-contact-001";
    const id = await executionId({ orgId: ORG, userId: OWNER }, key);
    await using instance = await introspectWorkflowInstance(bindings.HELLO_WORKFLOW, id);
    const accepted = await call(
      "/api/forms/greet/submit",
      "POST",
      { handle: started.handle, values: { name: "Ada" } },
      ORG,
      OWNER,
      key,
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ form: "greet", executionId: id, replayed: false });
    expect(accepted.headers.get("Location")).toBe(`/api/executions/${id}`);
    await instance.waitForStatus("complete");
    const detail = await call(`/api/executions/${id}`);
    expect(await detail.json()).toMatchObject({
      executionId: id,
      status: "Succeeded",
      input: { name: "Ada" },
      result: { greeting: "Hello, Ada!", name: "Ada" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unknown, foreign, reused, and payload-mismatched handles without dispatching", async () => {
    await createForm();
    const bogusBody = { handle: "b".repeat(64), values: {} };
    const bogus = await call("/api/forms/contact/submit", "POST", bogusBody, ORG, OWNER, "form-02-bogus-001");
    expect(bogus.status).toBe(422);
    expect(await bogus.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
    const noHandle = await call("/api/forms/contact/submit", "POST", { values: {} }, ORG, OWNER, "form-02-bogus-002");
    expect(noHandle.status).toBe(422);
    const started = await startup("contact");
    // Foreign user cannot use another session's handle.
    const foreignBody = { handle: started.handle, values: {} };
    const foreign = await call("/api/forms/contact/submit", "POST", foreignBody, ORG, OTHER_USER, "form-02-bogus-003");
    // AUTH-02 union (issue #143): the submit-grant gate runs before handle
    // validation, so a grantless caller answers 403 GRANT_REQUIRED instead
    // of 422 — authorization first, never a handle-validity oracle.
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: "GRANT_REQUIRED" } });
    // First use wins; the replay answers stale and dispatches nothing.
    // (Values stay hello-compatible so the first submit reaches dispatch.)
    await createForm("greet", [{ name: "name", type: "text", required: true }]);
    const greetStarted = await startup("greet");
    const greetBody = { handle: greetStarted.handle, values: { name: "Ada" } };
    const first = await call("/api/forms/greet/submit", "POST", greetBody, ORG, OWNER, "form-02-reuse-001");
    expect(first.status).toBe(202);
    const replay = await call("/api/forms/greet/submit", "POST", greetBody, ORG, OWNER, "form-02-reuse-002");
    expect(replay.status).toBe(422);
    expect(await replay.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
    // Unknown envelope keys and non-object bodies fail closed.
    const fresh = await startup("contact");
    const extraBody = { handle: fresh.handle, values: {}, bogus: 1 };
    const extra = await call("/api/forms/contact/submit", "POST", extraBody, ORG, OWNER, "form-02-bogus-004");
    expect(extra.status).toBe(422);
    const nopeBody = { handle: fresh.handle };
    const nope = await call("/api/forms/nope/submit", "POST", nopeBody, ORG, OWNER, "form-02-bogus-005");
    expect(nope.status).toBe(404);
    // A handle that fails validation stays live for a corrected retry:
    // the same handle succeeds once the values pass the gate.
    await createForm("greet", [{ name: "name", type: "text", required: true }]);
    const retryStarted = await startup("greet");
    const badBody = { handle: retryStarted.handle, values: {} };
    const bad = await call("/api/forms/greet/submit", "POST", badBody, ORG, OWNER, "form-02-retry-001");
    expect(bad.status).toBe(422);
    const goodBody = { handle: retryStarted.handle, values: { name: "Ada" } };
    const good = await call("/api/forms/greet/submit", "POST", goodBody, ORG, OWNER, "form-02-retry-002");
    expect(good.status).toBe(202);
  });
  it("validates against the declaration: display-only, hidden, options, oversized", async () => {
    await createForm();
    const cases: { values: Record<string, unknown>; code: string }[] = [
      { values: { name: "Ada", kind: "real", title: "Hi" }, code: "DISPLAY_ONLY_FIELD" },
      { values: { name: "Ada", kind: "real", nick: "Al" }, code: "HIDDEN_FIELD" },
      { values: { name: "Ada", kind: "zzz" }, code: "INVALID_OPTION" },
      { values: { kind: "real" }, code: "REQUIRED" },
      { values: { name: "Ada", kind: "real", bogus: "x" }, code: "UNKNOWN_FIELD" },
      { values: { name: "Ada", kind: "real", __form: "contact" }, code: "UNKNOWN_FIELD" },
    ];
    let index = 0;
    for (const entry of cases) {
      const started = await startup("contact");
      const body = { handle: started.handle, values: entry.values };
      const key = `form-02-invalid-${(index += 1)}`;
      const response = await call("/api/forms/contact/submit", "POST", body, ORG, OWNER, key);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "FORM_VALIDATION_FAILED" } });
    }
    const crowded = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, "x"]));
    const crowdedStarted = await startup("contact");
    const crowdedBody = { handle: crowdedStarted.handle, values: crowded };
    const crowdedRes = await call(
      "/api/forms/contact/submit",
      "POST",
      crowdedBody,
      ORG,
      OWNER,
      "form-02-invalid-crowd",
    );
    expect(crowdedRes.status).toBe(422);
  });
  it("re-checks provider membership at submit so stale client lists fail closed", async () => {
    expect((await call("/api/tables", "POST", { name: "teams" })).status).toBe(201);
    expect((await call("/api/tables/teams/rows/t1", "PUT", { data: { team: "red" } })).status).toBe(201);
    await createForm("team-pick", [
      { name: "name", type: "text", required: true },
      {
        name: "team",
        type: "select",
        required: true,
        provider: { kind: "table", table: "teams", valueField: "team" },
      },
    ]);
    const started = await startup("team-pick");
    expect(started.options).toMatchObject({ team: ["red"] });
    // The table changes between startup and submit: the smuggled value fails.
    expect((await call("/api/tables/teams/rows/t2", "PUT", { data: { team: "blue" } })).status).toBe(201);
    const smuggledBody = { handle: started.handle, values: { name: "Ada", team: "green" } };
    const smuggled = await call(
      "/api/forms/team-pick/submit",
      "POST",
      smuggledBody,
      ORG,
      OWNER,
      "form-02-provider-001",
    );
    expect(smuggled.status).toBe(422);
    expect(await smuggled.json()).toMatchObject({ error: { code: "FORM_VALIDATION_FAILED" } });
    const fresh = await startup("team-pick");
    // The listed value passes the form gate (membership re-checked live),
    // then the Saga gate refuses the drifted declaration: 400, not 422.
    // That split is the assertion — option membership passed, Saga drift did not.
    const okBody = { handle: fresh.handle, values: { name: "Ada", team: "blue" } };
    const ok = await call("/api/forms/team-pick/submit", "POST", okBody, ORG, OWNER, "form-02-provider-002");
    expect(ok.status).toBe(400);
    expect(await ok.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
  it("defers scheduled work with inspectable linkage and validates the instant", async () => {
    await createForm("greet", [{ name: "name", type: "text", required: true }]);
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const started = await startup("greet");
    const accepted = await call(
      "/api/forms/greet/submit",
      "POST",
      { handle: started.handle, values: { name: "Ada" }, scheduleAt: future },
      ORG,
      OWNER,
      "form-02-scheduled-001",
    );
    expect(accepted.status).toBe(202);
    const receipt = (await accepted.json()) as { executionId: string; scheduled: boolean; scheduleAt: string };
    expect(receipt.scheduled).toBe(true);
    expect(receipt.scheduleAt).toBe(new Date(Date.parse(future)).toISOString());
    const row = await bindings.DB.prepare("SELECT status,dispatched,input_json FROM executions WHERE id=?")
      .bind(receipt.executionId)
      .first<{ status: string; dispatched: number; input_json: string }>();
    expect(row?.status).toBe("Pending");
    expect(row?.dispatched).toBe(0);
    // The linkage is inspectable through the standard Execution detail.
    const detail = await call(`/api/executions/${receipt.executionId}`);
    expect(await detail.json()).toMatchObject({
      executionId: receipt.executionId,
      status: "Pending",
      input: { name: "Ada", __scheduleAt: receipt.scheduleAt },
    });
    // Past and far-future instants fail before consuming anything dispatchable.
    const badInstants = [
      ["2020-01-01T00:00:00.000Z", "form-02-sched-bad-1"],
      [new Date(Date.now() + 31 * 86400 * 1000).toISOString(), "form-02-sched-bad-2"],
    ] as const;
    for (const [scheduleAt, key] of badInstants) {
      const handle = (await startup("greet")).handle;
      const badBody = { handle, values: {}, scheduleAt };
      expect((await call("/api/forms/greet/submit", "POST", badBody, ORG, OWNER, key)).status).toBe(400);
    }
  });
  it("re-validates file references against live FILE-01 rows with bounds", async () => {
    expect((await call("/api/file-locations", "POST", { name: "uploads" })).status).toBe(201);
    await createForm("file-form", [
      { name: "name", type: "text", required: true },
      {
        name: "doc",
        type: "file",
        required: true,
        file: { location: "uploads", maxMb: 1, contentTypes: ["text/plain"] },
      },
    ]);
    const bytes = new TextEncoder().encode("hello");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "uploads", path: "doc.txt" }] });
    expect(slot.status).toBe(200);
    const { entries } = (await slot.json()) as { entries: { token: string }[] };
    const put = await worker.fetch(
      new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
        body: bytes as Uint8Array<ArrayBuffer>,
      }),
      { ...bindings, LAB_ORG_ID: ORG },
    );
    expect(put.status).toBe(200);
    const finalizeBody = {
      location: "uploads",
      path: "doc.txt",
      contentType: "text/plain",
      size: bytes.byteLength,
      sha256: digest,
    };
    const finalize = await call("/api/files/finalize", "POST", finalizeBody);
    expect(finalize.status).toBe(200);
    const started = await startup("file-form");
    // The ready file passes the file gate; the Saga gate then refuses the
    // drifted declaration (file fields are not hello inputs): 400, not 422.
    // That split pins the file check ran first and passed.
    const readyBody = {
      handle: started.handle,
      values: { name: "Ada", doc: { location: "uploads", path: "doc.txt" } },
    };
    const accepted = await call("/api/forms/file-form/submit", "POST", readyBody, ORG, OWNER, "form-02-file-001");
    expect(accepted.status).toBe(400);
    expect(await accepted.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    // Stale pointers and wrong locations fail the file gate first (422).
    const staleCases = [
      [{ name: "Ada", doc: { location: "uploads", path: "missing.txt" } }, "form-02-file-002", "FILE_NOT_READY"],
      [{ name: "Ada", doc: { location: "elsewhere", path: "doc.txt" } }, "form-02-file-003", "FILE_LOCATION_MISMATCH"],
    ] as const;
    for (const [values, key, code] of staleCases) {
      const handle = (await startup("file-form")).handle;
      const denied = await call("/api/forms/file-form/submit", "POST", { handle, values }, ORG, OWNER, key);
      expect(denied.status).toBe(422);
      const deniedBody = JSON.stringify(await denied.json());
      expect(deniedBody).toContain("FORM_VALIDATION_FAILED");
      expect(deniedBody).toContain(code);
    }
    // Foreign orgs never resolve this org's form (404 before any file check).
    const foreignBody = {
      handle: "c".repeat(64),
      values: { name: "Ada", doc: { location: "uploads", path: "doc.txt" } },
    };
    const foreign = await call(
      "/api/forms/file-form/submit",
      "POST",
      foreignBody,
      OTHER_ORG,
      OWNER,
      "form-02-file-004",
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "FORM_NOT_FOUND" } });
  });
  it("keeps the Saga gate authoritative on declaration drift", async () => {
    await createForm("drift", [{ name: "nickname", type: "text", required: false }]);
    const started = await startup("drift");
    // The declaration passes the form gate (nickname is declared) but the
    // hello Saga requires name: the Saga 400 surfaces, not a field 422.
    const driftBody = { handle: started.handle, values: {} };
    const response = await call("/api/forms/drift/submit", "POST", driftBody, ORG, OWNER, "form-02-drift-001");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
  it("fails handles closed on expiry, form mismatch, and corrupt sessions", async () => {
    await createForm("greet", [{ name: "name", type: "text", required: true }]);
    await createForm("other-greet", [{ name: "name", type: "text", required: true }]);
    // A handle minted for one form cannot submit another.
    const crossed = await startup("greet");
    const crossedBody = { handle: crossed.handle, values: { name: "Ada" } };
    const crossedRes = await call("/api/forms/other-greet/submit", "POST", crossedBody, ORG, OWNER, "form-02-edge-001");
    expect(crossedRes.status).toBe(422);
    expect(await crossedRes.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
    // An expired session row answers stale and dispatches nothing.
    const stale = await startup("greet");
    const past = new Date(Date.now() - 1000).toISOString();
    const staleHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stale.handle))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    await bindings.DB.prepare("UPDATE form_startups SET expires_at=? WHERE handle_hash=?").bind(past, staleHash).run();
    const staleBody = { handle: stale.handle, values: { name: "Ada" } };
    const staleRes = await call("/api/forms/greet/submit", "POST", staleBody, ORG, OWNER, "form-02-edge-002");
    expect(staleRes.status).toBe(422);
    expect(await staleRes.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
    // A corrupt persisted snapshot answers stale rather than dispatching.
    const corrupt = await startup("greet");
    const corruptHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(corrupt.handle))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    await bindings.DB.prepare("UPDATE form_startups SET options_json=? WHERE handle_hash=?")
      .bind("{{{", corruptHash)
      .run();
    const corruptBody = { handle: corrupt.handle, values: { name: "Ada" } };
    const corruptRes = await call("/api/forms/greet/submit", "POST", corruptBody, ORG, OWNER, "form-02-edge-003");
    expect(corruptRes.status).toBe(422);
    expect(await corruptRes.json()).toMatchObject({ error: { code: "STALE_FORM_HANDLE" } });
  });
  it("replays scheduled submits canonically and rejects malformed designer writes", async () => {
    await createForm("greet", [{ name: "name", type: "text", required: true }]);
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const firstHandle = (await startup("greet")).handle;
    const firstBody = { handle: firstHandle, values: { name: "Ada" }, scheduleAt: future };
    const first = await call("/api/forms/greet/submit", "POST", firstBody, ORG, OWNER, "form-02-sched-replay");
    expect(first.status).toBe(202);
    const secondHandle = (await startup("greet")).handle;
    const secondBody = { handle: secondHandle, values: { name: "Ada" }, scheduleAt: future };
    const second = await call("/api/forms/greet/submit", "POST", secondBody, ORG, OWNER, "form-02-sched-replay");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ replayed: true, scheduled: true });
    // A recycled key over different input answers 409, never a replay.
    const thirdHandle = (await startup("greet")).handle;
    const thirdBody = { handle: thirdHandle, values: { name: "Mallory" }, scheduleAt: future };
    const third = await call("/api/forms/greet/submit", "POST", thirdBody, ORG, OWNER, "form-02-sched-replay");
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    // Designer writes without fields, with unknown Sagas, with unknown
    // envelope keys, or with non-object startup bodies fail closed with
    // machine-readable codes.
    const noFields = await call("/api/forms", "POST", { name: "nofields", sagaId: helloSaga.id });
    expect(noFields.status).toBe(400);
    expect(await noFields.json()).toMatchObject({ error: { code: "INVALID_FORM" } });
    const extraKey = await call("/api/forms", "POST", {
      name: "extrakey",
      sagaId: helloSaga.id,
      fields: [{ name: "name", type: "text", required: true }],
      bogus: 1,
    });
    expect(extraKey.status).toBe(400);
    expect(await extraKey.json()).toMatchObject({ error: { code: "INVALID_FORM" } });
    const badSaga = await call("/api/forms", "POST", {
      name: "badsaga",
      sagaId: "00000000-0000-4000-8000-000000000000",
      fields: [{ name: "name", type: "text", required: true }],
    });
    expect(badSaga.status).toBe(400);
    expect(await badSaga.json()).toMatchObject({ error: { code: "INVALID_FORM" } });
    const badStartup = await call("/api/forms/greet/startup", "POST", ["x"]);
    expect(badStartup.status).toBe(400);
    expect(await badStartup.json()).toMatchObject({ error: { code: "INVALID_PREFILL" } });
    const extraStartup = await call("/api/forms/greet/startup", "POST", { bogus: 1 });
    expect(extraStartup.status).toBe(400);
    expect(await extraStartup.json()).toMatchObject({ error: { code: "INVALID_PREFILL" } });
    const flood = { prefill: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, "x"])) };
    const flooded = await call("/api/forms/greet/startup", "POST", flood);
    expect(flooded.status).toBe(422);
    const floodedBody = JSON.stringify(await flooded.json());
    expect(floodedBody).toContain("FORM_VALIDATION_FAILED");
    expect(floodedBody).toContain("TOO_MANY_FIELDS");
  });
  it("answers corrupt declarations with 500 and survives table deletion under providers", async () => {
    // A declaration row that fails server parsing is a server defect: 500,
    // never a cross-tenant leak or a fabricated submit.
    await bindings.DB.prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
      .bind(
        "b1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
        ORG,
        "corrupt",
        helloSaga.id,
        "not-json{{{",
        new Date().toISOString(),
      )
      .run();
    expect((await call("/api/forms/corrupt")).status).toBe(500);
    expect(await call("/api/forms/corrupt").then((res) => res.json())).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
    // Deleting the provider table between declaration and fetch degrades to
    // an empty list with a per-field error, never a leak or a crash.
    expect((await call("/api/tables", "POST", { name: "gone" })).status).toBe(201);
    expect((await call("/api/tables/gone/rows/r1", "PUT", { data: { v: "one" } })).status).toBe(201);
    await createForm("gone-pick", [
      { name: "name", type: "text", required: true },
      { name: "pick", type: "select", required: true, provider: { kind: "table", table: "gone", valueField: "v" } },
    ]);
    expect((await call("/api/tables/gone", "DELETE")).status).toBe(200);
    const providers = await call("/api/forms/gone-pick/providers");
    expect(await providers.json()).toMatchObject({ options: { pick: [] }, errors: { pick: expect.any(String) } });
  });
  it("bounds file fields by size and type against the live rows", async () => {
    expect((await call("/api/file-locations", "POST", { name: "tight" })).status).toBe(201);
    await createForm("tight-file", [
      { name: "name", type: "text", required: true },
      { name: "doc", type: "file", required: true, file: { location: "tight", maxMb: 0.000001 } },
    ]);
    await createForm("typed-file", [
      { name: "name", type: "text", required: true },
      { name: "doc", type: "file", required: true, file: { location: "tight", contentTypes: ["image/png"] } },
    ]);
    const bytes = new TextEncoder().encode("hello");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const slot = await call("/api/files/uploads", "POST", { entries: [{ location: "tight", path: "big.txt" }] });
    expect(slot.status).toBe(200);
    const { entries } = (await slot.json()) as { entries: { token: string }[] };
    const put = await worker.fetch(
      new Request(`http://local.test/api/files/content?token=${entries[0]!.token}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
        body: bytes as Uint8Array<ArrayBuffer>,
      }),
      { ...bindings, LAB_ORG_ID: ORG },
    );
    expect(put.status).toBe(200);
    const finalizeBody = {
      location: "tight",
      path: "big.txt",
      contentType: "text/plain",
      size: bytes.byteLength,
      sha256: digest,
    };
    expect((await call("/api/files/finalize", "POST", finalizeBody)).status).toBe(200);
    // text/plain is not image/png: the typed form rejects the ready file.
    const typeHandle = (await startup("typed-file")).handle;
    const typeBody = { handle: typeHandle, values: { name: "Ada", doc: { location: "tight", path: "big.txt" } } };
    const typeRes = await call("/api/forms/typed-file/submit", "POST", typeBody, ORG, OWNER, "form-02-tight-001");
    expect(typeRes.status).toBe(422);
    expect(JSON.stringify(await typeRes.json())).toContain("FILE_TYPE_REJECTED");
    // Five bytes exceed the one-byte field bound on the tight form.
    const sizeHandle = (await startup("tight-file")).handle;
    const sizeBody = { handle: sizeHandle, values: { name: "Ada", doc: { location: "tight", path: "big.txt" } } };
    const sizeRes = await call("/api/forms/tight-file/submit", "POST", sizeBody, ORG, OWNER, "form-02-tight-003");
    expect(sizeRes.status).toBe(422);
    expect(JSON.stringify(await sizeRes.json())).toContain("FILE_TOO_LARGE");
    // A pending (never finalized) upload is not ready.
    const pendingSlot = await call("/api/files/uploads", "POST", {
      entries: [{ location: "tight", path: "wait.txt" }],
    });
    const { entries: pendingEntries } = (await pendingSlot.json()) as { entries: { token: string }[] };
    const pendingPut = await worker.fetch(
      new Request(`http://local.test/api/files/content?token=${pendingEntries[0]!.token}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
        body: bytes as Uint8Array<ArrayBuffer>,
      }),
      { ...bindings, LAB_ORG_ID: ORG },
    );
    expect(pendingPut.status).toBe(200);
    const pendingHandle = (await startup("tight-file")).handle;
    const pendingBody = {
      handle: pendingHandle,
      values: { name: "Ada", doc: { location: "tight", path: "wait.txt" } },
    };
    const pendingRes = await call("/api/forms/tight-file/submit", "POST", pendingBody, ORG, OWNER, "form-02-tight-002");
    expect(pendingRes.status).toBe(422);
    expect(JSON.stringify(await pendingRes.json())).toContain("FILE_NOT_READY");
  });
  it("serializes every field facet and exercises the provider edge paths", async () => {
    // A fully-faceted declaration round-trips through the designer read:
    // label, maxLength, default, options, provider, visibleWhen, file, min,
    // max, pattern, and display content all serialize back to the caller.
    const full = await call("/api/forms", "POST", {
      name: "full",
      sagaId: helloSaga.id,
      title: "Full",
      description: "Every facet.",
      allowPrefill: true,
      fields: [
        { name: "nick", type: "text", required: false, label: "Nick", maxLength: 32, default: "Al" },
        { name: "kind", type: "select", required: true, options: ["real", "other"] },
        { name: "static_pick", type: "select", required: false, provider: { kind: "static", options: ["a"] } },
        { name: "dependent", type: "text", required: false, visibleWhen: { field: "kind", equals: "other" } },
        { name: "count", type: "number", required: false, min: 0, max: 9 },
        { name: "code", type: "text", required: false, pattern: "a+" },
        { name: "note", type: "heading", required: false, content: "Hi" },
      ],
    });
    expect(full.status).toBe(201);
    const read = await call("/api/forms/full");
    expect(await read.json()).toMatchObject({
      form: {
        fields: [
          { name: "nick", label: "Nick", maxLength: 32, default: "Al" },
          { name: "kind", options: ["real", "other"] },
          { name: "static_pick", provider: { kind: "static", options: ["a"] } },
          { name: "dependent", visibleWhen: { field: "kind", equals: "other" } },
          { name: "count", min: 0, max: 9 },
          { name: "code", pattern: "a+" },
          { name: "note", content: "Hi" },
        ],
      },
    });
    // Duplicate, over-long, and duplicate-table option values collapse to one
    // sorted entry: dedup plus the 129th-char and empty drops run.
    expect((await call("/api/tables", "POST", { name: "dupes" })).status).toBe(201);
    expect((await call("/api/tables/dupes/rows/r1", "PUT", { data: { v: "dup" } })).status).toBe(201);
    expect((await call("/api/tables/dupes/rows/r2", "PUT", { data: { v: "dup" } })).status).toBe(201);
    expect((await call("/api/tables/dupes/rows/r3", "PUT", { data: { v: "x".repeat(129) } })).status).toBe(201);
    expect((await call("/api/tables/dupes/rows/r4", "PUT", { data: { v: "" } })).status).toBe(201);
    expect((await call("/api/tables/dupes/rows/r5", "PUT", { data: { v: 7 } })).status).toBe(201);
    await createForm("dupe-pick", [
      { name: "name", type: "text", required: true },
      { name: "pick", type: "select", required: true, provider: { kind: "table", table: "dupes", valueField: "v" } },
    ]);
    expect(await call("/api/forms/dupe-pick/providers").then((res) => res.json())).toMatchObject({
      options: { pick: ["dup"] },
    });
    // An omitted optional file value skips the file gate at route level
    // (FILE_NOT_READY fires only for a present stale reference, pinned above).
    await createForm("file-skip", [
      { name: "name", type: "text", required: true },
      { name: "doc", type: "file", required: false, file: { location: "uploads" } },
    ]);
    const skipStarted = await startup("file-skip");
    const skipBody = { handle: skipStarted.handle, values: { name: "Ada" } };
    const skip = await call("/api/forms/file-skip/submit", "POST", skipBody, ORG, OWNER, "form-02-skip-001");
    // The file gate passes (nothing to check) and the hello Saga accepts the
    // name-only input, so the omitted optional file dispatches: 202 proves
    // the omission was not a file-gate failure.
    expect(skip.status).toBe(202);
    expect(await skip.json()).toMatchObject({ form: "file-skip", replayed: false });
  });
});
