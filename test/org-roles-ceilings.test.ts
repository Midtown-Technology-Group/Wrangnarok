// SPDX-License-Identifier: AGPL-3.0
// AUTH-02 narrow profile (issue #143, ADR 035 addendum): fixed org roles
// admin/operator/viewer with closed ceilings, the viewer inert-grant rule,
// per-action composition of the tables/files legs under the role ceiling,
// and scoped delegation (form-handle/app-serve/schedule-run-as/
// endpoint-key/app-grant). Runs in real workerd with a real D1 binding;
// the only doubles are LAB fixture identities and the admin list.
//
// Companion to test/resource-roles.test.ts (grant engine, matrices,
// revocation, listings, hidden references) and test/schedule-lifecycle.test.ts
// (S3 run-as revalidation): those suites pin the shared machinery, this one
// pins the narrow ceilings. SQL-seeded `member` rows below double as
// legacy-row coverage (migration 0039): reads map them to operator.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, helloSaga } from "../src/domain";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migrationTables from "../migrations/0009_tables.sql?raw";
import migrationPolicies from "../migrations/0012_saga_policies.sql?raw";
import migrationRoles from "../migrations/0013_resource_roles.sql?raw";
import migrationFiles from "../migrations/0019_files.sql?raw";
import migrationOrgRoles from "../migrations/0039_org_roles.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const USER_OPERATOR = "00000000-0000-4000-8000-000000000013";
const USER_VIEWER = "00000000-0000-4000-8000-000000000014";
const USER_LEGACY = "00000000-0000-4000-8000-000000000015";
const FORM_NAME = "ceiling-form";

function authed(path: string, method: string, body?: unknown, orgId?: string, key?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(orgId === undefined ? {} : { "X-Organization-Id": orgId }),
    ...(key === undefined ? {} : { "Idempotency-Key": key }),
  };
  return new Request(`https://local.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(path: string, method: string, userId: string, body?: unknown, orgId?: string, key?: string) {
  const b = {
    ...bindings,
    LAB_USER_ID: userId,
    LAB_FIXTURE_USER_ID: USER_ADMIN,
    ADMIN_USER_IDS: USER_ADMIN,
  };
  const res = await worker.fetch(authed(path, method, body, orgId, key), b);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function submitSaga(userId: string, sagaId: string, input: unknown, key: string) {
  return call("/api/executions", "POST", userId, { sagaId, input }, ORG_A, key);
}

async function submitProvider(userId: string, sagaId: string, input: unknown, key: string) {
  return call("/api/executions/provider", "POST", userId, { sagaId, input }, ORG_A, key);
}

/** form_startups rows in scope. The table is created lazily on first
 * startup (ensureStartupTable), so a missing table reads as zero. */
async function startupCount(): Promise<number> {
  try {
    const row = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM form_startups WHERE org_id=?")
      .bind(ORG_A)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function makeRole(name: string): Promise<string> {
  const created = await call(`/api/orgs/${ORG_A}/roles`, "POST", USER_ADMIN, { name });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

async function grant(roleId: string, resourceKind: string, resourceId: string, action: string) {
  return call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind,
    resourceId,
    action,
  });
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migrationTables);
  await bindings.DB.exec(migrationPolicies);
  await bindings.DB.exec(migrationRoles);
  await bindings.DB.exec(migrationFiles);
  await bindings.DB.exec(migrationOrgRoles);
  // Pilot form for the delegation chain (FORM-01 shape).
  await bindings.DB.prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(
      "c1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      ORG_A,
      FORM_NAME,
      helloSaga.id,
      '[{"name":"name","type":"text","required":true,"maxLength":1024}]',
      "2026-09-11T00:00:00.000Z",
    )
    .run();
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

it("speaks the closed role vocabulary on invite and update", async () => {
  // Default invite is operator.
  expect(await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR })).toMatchObject({
    status: 201,
    body: { role: "operator", kind: "ordinary" },
  });
  // Viewer invites work for both kinds; external members can never be admin.
  expect(
    await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_VIEWER, role: "viewer" }),
  ).toMatchObject({ status: 201, body: { role: "viewer" } });
  expect(
    await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, {
      userId: "ext-viewer@example.com",
      role: "viewer",
      kind: "external",
    }),
  ).toMatchObject({ status: 201, body: { role: "viewer", kind: "external" } });
  expect(
    await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, {
      userId: "ext-admin@example.com",
      role: "admin",
      kind: "external",
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  // The old label is gone from the write vocabulary.
  expect(
    await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: "old@example.com", role: "member" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(
    await call(`/api/orgs/${ORG_A}/members/${USER_OPERATOR}`, "PATCH", USER_ADMIN, { role: "member" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  // Operator/viewer transitions work; demoting to viewer while holding
  // action grants stays legal (the grants go inert, they do not block).
  expect(
    await call(`/api/orgs/${ORG_A}/members/${USER_OPERATOR}`, "PATCH", USER_ADMIN, { role: "viewer" }),
  ).toMatchObject({ status: 200, body: { role: "viewer" } });
  expect(
    await call(`/api/orgs/${ORG_A}/members/${USER_OPERATOR}`, "PATCH", USER_ADMIN, { role: "operator" }),
  ).toMatchObject({ status: 200, body: { role: "operator" } });
});

it("reads legacy member rows as operators (migration 0039 compatibility)", async () => {
  const stamp = new Date().toISOString();
  await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
    .bind(USER_LEGACY, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?, 'member','active','ordinary',?,?)",
  )
    .bind(ORG_A, USER_LEGACY, stamp, stamp)
    .run();
  const roleId = await makeRole("legacy-runners");
  expect(await grant(roleId, "saga", echoSaga.id, "execute")).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_LEGACY }),
  ).toMatchObject({ status: 201 });
  // A pre-migration row executes exactly like an operator's.
  expect(await submitSaga(USER_LEGACY, echoSaga.id, { message: "legacy" }, "ceil-legacy-0001")).toMatchObject({
    status: 202,
  });
});

it("keeps viewer action grants inert on both execution ingresses", async () => {
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR });
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_VIEWER, role: "viewer" });
  const roleId = await makeRole("viewer-runners");
  expect(await grant(roleId, "saga", echoSaga.id, "execute")).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_VIEWER }),
  ).toMatchObject({
    status: 400,
    body: { error: { code: "VIEWER_CEILING" } },
  });
  // Force the inert shape past the admin guard to prove the evaluator
  // ignores it: a direct assignment row naming a viewer authorizes nothing.
  await bindings.DB.prepare(
    "INSERT INTO role_assignments(role_id,org_id,user_id,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)",
  )
    .bind(roleId, ORG_A, USER_VIEWER, new Date().toISOString(), new Date().toISOString())
    .run();
  expect(await submitSaga(USER_VIEWER, echoSaga.id, { message: "v" }, "ceil-viewer-deny-0001")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  expect(await submitProvider(USER_VIEWER, echoSaga.id, { message: "v" }, "ceil-viewer-deny-0002")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  const rows = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM executions WHERE org_id=? AND user_id=?")
    .bind(ORG_A, USER_VIEWER)
    .first<{ n: number }>();
  expect(rows?.n ?? -1).toBe(0);
  // Promoting the same viewer to operator activates the identical grant.
  expect(
    await call(`/api/orgs/${ORG_A}/members/${USER_VIEWER}`, "PATCH", USER_ADMIN, { role: "operator" }),
  ).toMatchObject({ status: 200 });
  expect(await submitSaga(USER_VIEWER, echoSaga.id, { message: "v" }, "ceil-viewer-allow-0001")).toMatchObject({
    status: 202,
  });
});

it("narrows wide policy subjects by ceiling: one kind rule serves operators, denies viewers", async () => {
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR });
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_VIEWER, role: "viewer" });
  // kind: rules stay creatable (they serve operators); the evaluator
  // narrows them per caller ceiling instead of the admin surface refusing.
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
      subjectType: "kind",
      subjectRef: "ordinary",
    }),
  ).toMatchObject({ status: 201 });
  expect(await submitSaga(USER_OPERATOR, echoSaga.id, { message: "op" }, "ceil-kind-allow-0001")).toMatchObject({
    status: 202,
  });
  expect(await submitSaga(USER_VIEWER, echoSaga.id, { message: "v" }, "ceil-kind-deny-0001")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Direct user: rules naming a viewer are refused instead of persisted inert.
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
      subjectType: "user",
      subjectRef: USER_VIEWER,
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "VIEWER_CEILING" } } });
});

it("lets viewers read but never act on forms and apps", async () => {
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR });
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_VIEWER, role: "viewer" });
  // Zero grants: startup denies and mints no handle row.
  expect(await call(`/api/forms/${FORM_NAME}/startup`, "POST", USER_VIEWER, {}, ORG_A)).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  expect(await startupCount()).toBe(0);
  const readRole = await makeRole("viewer-readers");
  expect(await grant(readRole, "form", FORM_NAME, "read")).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${readRole}/assignments`, "POST", USER_ADMIN, { userId: USER_VIEWER }),
  ).toMatchObject({ status: 201 });
  // Read-class grants evaluate for viewers: detail and startup open.
  expect(await call(`/api/forms/${FORM_NAME}`, "GET", USER_VIEWER, undefined, ORG_A)).toMatchObject({ status: 200 });
  const started = await call(`/api/forms/${FORM_NAME}/startup`, "POST", USER_VIEWER, {}, ORG_A);
  expect(started.status).toBe(201);
  expect(started.body.handle as string).toMatch(/^[a-f0-9]{64}$/);
  // Submit is an action: denied on the known reference, handle or not.
  expect(
    await call(
      `/api/forms/${FORM_NAME}/submit`,
      "POST",
      USER_VIEWER,
      { values: { name: "V" } },
      ORG_A,
      "ceil-form-viewer-0001",
    ),
  ).toMatchObject({ status: 403, body: { error: { code: "GRANT_REQUIRED" } } });
  // Apps mirror the split: read opens detail, serve stays an action.
  const created = await call("/api/apps", "POST", USER_ADMIN, { name: "Ceil", slug: "ceil" });
  expect(created.status).toBe(201);
  const appId = (created.body.app as { id: string }).id;
  const appRead = await makeRole("viewer-app-readers");
  expect(await grant(appRead, "app", appId, "read")).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${appRead}/assignments`, "POST", USER_ADMIN, { userId: USER_VIEWER }),
  ).toMatchObject({ status: 201 });
  expect(await call(`/api/apps/${appId}`, "GET", USER_VIEWER)).toMatchObject({ status: 200 });
  const serveRole = await makeRole("viewer-servers");
  expect(await grant(serveRole, "app", appId, "serve")).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${serveRole}/assignments`, "POST", USER_ADMIN, { userId: USER_VIEWER }),
  ).toMatchObject({ status: 400, body: { error: { code: "VIEWER_CEILING" } } });
});

it("refuses operators and viewers on every administration surface", async () => {
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR });
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_VIEWER, role: "viewer" });
  for (const user of [USER_OPERATOR, USER_VIEWER]) {
    expect(await call(`/api/orgs/${ORG_A}/roles`, "GET", user)).toMatchObject({
      status: 403,
      body: { error: { code: "ADMIN_ONLY" } },
    });
    expect(await call(`/api/orgs/${ORG_A}/roles`, "POST", user, { name: "nope" })).toMatchObject({
      status: 403,
      body: { error: { code: "ADMIN_ONLY" } },
    });
    expect(
      await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", user, {
        resourceKind: "saga",
        resourceId: echoSaga.id,
        action: "execute",
        subjectType: "all",
        subjectRef: "all",
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "ADMIN_ONLY" } } });
    expect(await call(`/api/orgs/${ORG_A}/members`, "POST", user, { userId: "peer@example.com" })).toMatchObject({
      status: 403,
    });
  }
});

it("composes the table leg under the ceiling: grants narrow, viewers read", async () => {
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR });
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_VIEWER, role: "viewer" });
  // Operator owns the table and holds every action through ownership.
  expect(await call("/api/tables", "POST", USER_OPERATOR, { name: "ceil" }, ORG_A)).toMatchObject({ status: 201 });
  expect(await call("/api/tables/ceil/rows/r1", "PUT", USER_OPERATOR, { data: { v: 1 } }, ORG_A)).toMatchObject({
    status: 201,
  });
  // An insert grant naming a viewer stays inert: the owner layer never runs.
  expect(
    await call(
      "/api/tables/ceil/grants",
      "POST",
      USER_OPERATOR,
      { action: "insert", granteeUserId: USER_VIEWER },
      ORG_A,
    ),
  ).toMatchObject({ status: 200 });
  expect(await call("/api/tables/ceil/rows/r2", "PUT", USER_VIEWER, { data: { v: 2 } }, ORG_A)).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
  // A read grant evaluates: the viewer reads the operator's row.
  expect(
    await call("/api/tables/ceil/grants", "POST", USER_OPERATOR, { action: "read", granteeUserId: USER_VIEWER }, ORG_A),
  ).toMatchObject({ status: 200 });
  expect(await call("/api/tables/ceil/rows/r1", "GET", USER_VIEWER, undefined, ORG_A)).toMatchObject({
    status: 200,
    body: { row: { data: { v: 1 } } },
  });
  // The ceiling precedes even owner-implicit authority: a viewer-owned
  // table still refuses viewer writes. Creation stays creator-accountable;
  // use is what the ceiling narrows.
  expect(await call("/api/tables", "POST", USER_VIEWER, { name: "viewer-owned" }, ORG_A)).toMatchObject({
    status: 201,
  });
  expect(await call("/api/tables/viewer-owned/rows/r1", "PUT", USER_VIEWER, { data: { v: 1 } }, ORG_A)).toMatchObject({
    status: 403,
    body: { error: { code: "TABLE_FORBIDDEN" } },
  });
});

it("composes the file leg under the ceiling: policy narrows, never widens", async () => {
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR });
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_VIEWER, role: "viewer" });
  // Location creation mints read/write/delete policy rows for the org.
  expect(await call("/api/file-locations", "POST", USER_OPERATOR, { name: "ceil" }, ORG_A)).toMatchObject({
    status: 201,
  });
  // Viewers cannot mint upload slots even with a write policy row present,
  // and no capability row escapes with the denial.
  const denied = await call(
    "/api/files/uploads",
    "POST",
    USER_VIEWER,
    { entries: [{ location: "ceil", path: "a.txt" }] },
    ORG_A,
  );
  expect(denied.status).toBe(207);
  expect(denied.body.entries).toEqual([{ path: "a.txt", allowed: false, code: "FORBIDDEN", message: "Forbidden." }]);
  const caps = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM file_capabilities WHERE org_id=?")
    .bind(ORG_A)
    .first<{ n: number }>();
  expect(caps?.n ?? -1).toBe(0);
  // Hidden references answer 404 before the ceiling denies: viewers cannot
  // probe location names through the issuance surface.
  const hidden = await call(
    "/api/files/uploads",
    "POST",
    USER_VIEWER,
    { entries: [{ location: "no-such-place", path: "a.txt" }] },
    ORG_A,
  );
  expect(hidden.status).toBe(207);
  expect(hidden.body.entries).toEqual([{ path: "a.txt", allowed: false, code: "NOT_FOUND", message: "Not found." }]);
  // Operators mint normally with an expiry bound on the capability.
  const allowed = await call(
    "/api/files/uploads",
    "POST",
    USER_OPERATOR,
    { entries: [{ location: "ceil", path: "a.txt" }] },
    ORG_A,
  );
  expect(allowed.status).toBe(200);
  const entry = (allowed.body.entries as Record<string, unknown>[])[0]!;
  expect(entry.allowed).toBe(true);
  expect(typeof entry.token).toBe("string");
  expect(Date.parse(entry.expiresAt as string)).toBeGreaterThan(Date.now());
  // Read-class delivery stays open to viewers under policy: seed one ready
  // row and prove the download slot issues.
  const stamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ready',?,?)",
  )
    .bind(ORG_A, "ceil", "ready.txt", 1, 5, "text/plain", "0".repeat(64), stamp, stamp)
    .run();
  const readable = await call(
    "/api/files/downloads",
    "POST",
    USER_VIEWER,
    { entries: [{ location: "ceil", path: "ready.txt" }] },
    ORG_A,
  );
  expect(readable.status).toBe(200);
  expect((readable.body.entries as Record<string, unknown>[])[0]!.allowed).toBe(true);
  // Delete is an action: viewers deny, operators proceed.
  expect(
    await call("/api/files", "DELETE", USER_VIEWER, { location: "ceil", path: "ready.txt", expectedVersion: 1 }, ORG_A),
  ).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
  expect(
    await call(
      "/api/files",
      "DELETE",
      USER_OPERATOR,
      { location: "ceil", path: "ready.txt", expectedVersion: 1 },
      ORG_A,
    ),
  ).toMatchObject({ status: 200 });
});

it("delegates form submission explicitly: submit grant suffices, handle carries the scope", async () => {
  await call(`/api/orgs/${ORG_A}/members`, "POST", USER_ADMIN, { userId: USER_OPERATOR });
  const submitRole = await makeRole("form-submitters");
  expect(await grant(submitRole, "form", FORM_NAME, "submit")).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${submitRole}/assignments`, "POST", USER_ADMIN, { userId: USER_OPERATOR }),
  ).toMatchObject({ status: 201 });
  // Startup mints the scoped handle (org+user+form bound, 30-minute TTL,
  // single-use) with no direct Saga grant anywhere in the chain.
  const before = await startupCount();
  const started = await call(`/api/forms/${FORM_NAME}/startup`, "POST", USER_OPERATOR, {}, ORG_A);
  expect(started.status).toBe(201);
  expect(typeof started.body.handle).toBe("string");
  expect(Date.parse(started.body.expiresAt as string) - Date.now()).toBeGreaterThan(20 * 60 * 1000);
  expect((await startupCount()) - before).toBe(1);
  // The live handle dispatches the bound Saga: 202 with no saga execute
  // grant for the submitter.
  expect(
    await call(
      `/api/forms/${FORM_NAME}/submit`,
      "POST",
      USER_OPERATOR,
      { handle: started.body.handle, values: { name: "Ada" } },
      ORG_A,
      "ceil-delegation-0001",
    ),
  ).toMatchObject({ status: 202, body: { form: FORM_NAME, replayed: false } });
});
