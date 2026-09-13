// SPDX-License-Identifier: AGPL-3.0
// AUTH-02 (issue #143, ADR 018): resource roles, claims, and explicit
// delegated authorization end to end. Caller matrices (ordinary, owner, org
// admin, provider/instance admin, external), deny by absence, form/app
// delegation without separate direct-workflow grants, policy change and
// revocation during discovery/execution, listings-never-grant, hidden
// references, and role/policy administration with consumer inspection.
// Runs in real workerd with a real D1 binding; the only doubles are LAB
// fixture identities (distinct LAB_USER_ID per caller) and the admin list.
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
import migration9 from "../migrations/0013_resource_roles.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const USER_ORDINARY = "00000000-0000-4000-8000-000000000003";
const USER_EXTERNAL = "00000000-0000-4000-8000-000000000004";
const USER_OWNER = "00000000-0000-4000-8000-000000000006";
const USER_STRANGER = "00000000-0000-4000-8000-000000000005";
const FORM_NAME = "hello-greeting";

function authed(path: string, method: string, body?: unknown, orgId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(orgId === undefined ? {} : { "X-Organization-Id": orgId }),
  };
  return new Request(`http://local.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(
  path: string,
  method: string,
  userId: string,
  body?: unknown,
  orgId?: string,
  adminIds = USER_ADMIN,
) {
  const b = {
    ...bindings,
    LAB_USER_ID: userId,
    LAB_FIXTURE_USER_ID: USER_ADMIN,
    ADMIN_USER_IDS: adminIds,
  };
  const res = await worker.fetch(authed(path, method, body, orgId), b);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function submitSaga(userId: string, orgId: string, sagaId: string, input: unknown, key: string) {
  const b = { ...bindings, LAB_USER_ID: userId, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: USER_ADMIN };
  const res = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Organization-Id": orgId,
      },
      body: JSON.stringify({ sagaId, input }),
    }),
    b,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
  await bindings.DB.exec(migration9);
  // Matrix identities: ordinary member, external member, and an owner (a
  // member who will hold a grant but no admin). Stranger stays unknown.
  for (const user of [USER_ORDINARY, USER_EXTERNAL, USER_OWNER, USER_STRANGER]) {
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(user, new Date().toISOString())
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_ORDINARY, "member", "active", "ordinary", new Date().toISOString(), new Date().toISOString())
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_EXTERNAL, "member", "active", "external", new Date().toISOString(), new Date().toISOString())
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_OWNER, "member", "active", "ordinary", new Date().toISOString(), new Date().toISOString())
    .run();
  // Pilot form declaration for the delegation chain (FORM-01 shape).
  await bindings.DB.prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(
      "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
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

async function makeRole(orgId = ORG_A): Promise<string> {
  const created = await call(`/api/orgs/${orgId}/roles`, "POST", USER_ADMIN, { name: `runners-${Math.random()}` });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

it("denies direct Saga execution by absence and grants it through roles", async () => {
  // Ordinary member with no grant: denied on a known reference (403, not 404).
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "x" }, "auth02-deny-0001")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Admin builds the chain: role, exact-saga grant, assignment.
  const roleId = await makeRole();
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
    }),
  ).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY }),
  ).toMatchObject({ status: 201 });
  // Now the ordinary member executes; the other Saga stays denied.
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "x" }, "auth02-allow-0001")).toMatchObject({
    status: 202,
  });
  expect(await submitSaga(USER_ORDINARY, ORG_A, helloSaga.id, { name: "x" }, "auth02-deny-0002")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
});

it("grants kind-wide wildcards, direct user/kind rules, and global rules", async () => {
  // Wildcard execute covers every Saga in the org.
  const roleId = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: "*",
    action: "execute",
  });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_OWNER });
  expect(await submitSaga(USER_OWNER, ORG_A, helloSaga.id, { name: "wild" }, "auth02-wild-0001")).toMatchObject({
    status: 202,
  });
  // Direct user rule (a claim without a role) authorizes one caller.
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
      subjectType: "user",
      subjectRef: USER_ORDINARY,
    }),
  ).toMatchObject({ status: 201 });
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "ruled" }, "auth02-rule-0001")).toMatchObject({
    status: 202,
  });
  // Kind rule: every external member may read the form.
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "form",
      resourceId: FORM_NAME,
      action: "read",
      subjectType: "kind",
      subjectRef: "external",
    }),
  ).toMatchObject({ status: 201 });
  expect(await call(`/api/forms/${FORM_NAME}`, "GET", USER_EXTERNAL)).toMatchObject({ status: 200 });
  // Ordinary member (no kind:external) still cannot read the form.
  expect(await call(`/api/forms/${FORM_NAME}`, "GET", USER_ORDINARY)).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Global rule from the provider admin reaches across orgs.
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "second-org" });
  const orgB = created.body.id as string;
  expect(
    await call("/api/policy-rules", "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
      subjectType: "all",
    }),
  ).toMatchObject({ status: 201 });
  // Invite the ordinary member to org B, then the global rule authorizes them.
  await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({ status: 200 });
  expect(await submitSaga(USER_ORDINARY, orgB, echoSaga.id, { message: "global" }, "auth02-global-0001")).toMatchObject(
    {
      status: 202,
    },
  );
});

it("proves no implicit cross-org fallback for grants or rules", async () => {
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "other-org" });
  const orgB = created.body.id as string;
  await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ADMIN, role: "admin" });
  await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({ status: 200 });
  // Org-A role grant never authorizes org B.
  const roleId = await makeRole(ORG_A);
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: echoSaga.id,
    action: "execute",
  });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(await submitSaga(USER_ORDINARY, orgB, echoSaga.id, { message: "leak" }, "auth02-leak-0001")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Org-A rule never authorizes org B either.
  await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: echoSaga.id,
    action: "execute",
    subjectType: "user",
    subjectRef: USER_ORDINARY,
  });
  expect(await submitSaga(USER_ORDINARY, orgB, echoSaga.id, { message: "leak" }, "auth02-leak-0002")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
});

it("delegates through authorized forms without a separate direct-workflow grant", async () => {
  // Form read/submit grants only: no saga execute grant anywhere.
  const roleId = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind: "form",
    resourceId: FORM_NAME,
    action: "submit",
  });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind: "form",
    resourceId: FORM_NAME,
    action: "read",
  });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(await call(`/api/forms/${FORM_NAME}`, "GET", USER_ORDINARY)).toMatchObject({ status: 200 });
  const b = { ...bindings, LAB_USER_ID: USER_ORDINARY, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: USER_ADMIN };
  // FORM-02 lifecycle (issue #155): startup mints the session-bound handle,
  // submit presents it back with the values. The delegation assertion is
  // unchanged: the form submit grant authorizes dispatch, no Saga grant.
  const started = await worker.fetch(
    new Request(`http://local.test/api/forms/${FORM_NAME}/startup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    b,
  );
  expect(started.status).toBe(201);
  const { handle } = (await started.json()) as { handle: string };
  const accepted = await worker.fetch(
    new Request(`http://local.test/api/forms/${FORM_NAME}/submit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth02-deleg-0001",
      },
      body: JSON.stringify({ handle, values: { name: "Ada" } }),
    }),
    b,
  );
  expect(accepted.status).toBe(202);
  // Direct execution of the SAME bound Saga stays denied: the delegation is
  // scoped to the form, not a backdoor to the workflow.
  expect(await submitSaga(USER_ORDINARY, ORG_A, helloSaga.id, { name: "Ada" }, "auth02-deleg-0002")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Hidden references cannot bypass grants: a foreign form name 404s before
  // grant evaluation (no GRANT_REQUIRED-shaped existence confirm).
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "form-org" });
  const orgB = created.body.id as string;
  await bindings.DB.prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(
      "b1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5",
      orgB,
      "foreign-form",
      helloSaga.id,
      '[{"name":"name","type":"text","required":true,"maxLength":1024}]',
      "2026-09-11T00:00:00.000Z",
    )
    .run();
  expect(await call("/api/forms/foreign-form", "GET", USER_ORDINARY)).toMatchObject({ status: 404 });
});

it("enforces app read/write/serve grants with hidden-reference 404s", async () => {
  // Admin creates the app (instance-admin bypass), ordinary member is denied.
  const created = await call("/api/apps", "POST", USER_ADMIN, { name: "Papers", slug: "papers" });
  expect(created.status).toBe(201);
  const appId = (created.body.app as { id: string }).id;
  expect(await call(`/api/apps/${appId}`, "GET", USER_ORDINARY)).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Read grant opens detail; write stays denied.
  const readRole = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${readRole}/grants`, "POST", USER_ADMIN, {
    resourceKind: "app",
    resourceId: appId,
    action: "read",
  });
  await call(`/api/orgs/${ORG_A}/roles/${readRole}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(await call(`/api/apps/${appId}`, "GET", USER_ORDINARY)).toMatchObject({ status: 200 });
  expect(await call(`/api/apps/${appId}/source`, "PUT", USER_ORDINARY, { files: [], dependencies: [] })).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Write grant opens mutation.
  const writeRole = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${writeRole}/grants`, "POST", USER_ADMIN, {
    resourceKind: "app",
    resourceId: appId,
    action: "write",
  });
  await call(`/api/orgs/${ORG_A}/roles/${writeRole}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(
    await call(`/api/apps/${appId}/source`, "PUT", USER_ORDINARY, {
      files: [{ path: "index.html", content: "hello" }],
      dependencies: [],
    }),
  ).toMatchObject({ status: 200 });
  // Serving needs serve, not write: still denied without it.
  await call(`/api/apps/${appId}/validate`, "POST", USER_ORDINARY);
  await call(`/api/apps/${appId}/builds`, "POST", USER_ORDINARY);
  expect(await call(`/api/apps/${appId}/assets/index.html`, "GET", USER_ORDINARY)).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Foreign app ids 404, never a grant-shaped confirm.
  const createdB = await call("/api/orgs", "POST", USER_ADMIN, { name: "app-org" });
  const orgB = createdB.body.id as string;
  const other = await call("/api/apps", "POST", USER_ADMIN, { name: "Other", slug: "other" }, orgB);
  const otherId = (other.body.app as { id: string }).id;
  expect(await call(`/api/apps/${otherId}`, "GET", USER_ORDINARY)).toMatchObject({ status: 404 });
});

it("applies policy changes and revocation to the next request, keeping listings grant-free", async () => {
  const roleId = await makeRole();
  const grant = await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: echoSaga.id,
    action: "execute",
  });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "v1" }, "auth02-revoke-0001")).toMatchObject({
    status: 202,
  });
  // Discovery stays open metadata the whole time: catalog 200 with no grant.
  expect(await call("/api/sagas", "GET", USER_ORDINARY)).toMatchObject({
    status: 200,
  });
  // Revoking the assignment denies the very next submit.
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments/${USER_ORDINARY}`, "DELETE", USER_ADMIN),
  ).toMatchObject({
    status: 200,
    body: { status: "revoked" },
  });
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "v2" }, "auth02-revoke-0002")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Re-assign, then remove the grant itself: denied again (rule out).
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants/${grant.body.id as string}`, "DELETE", USER_ADMIN);
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "v3" }, "auth02-revoke-0003")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  // Bulk revocation by user across roles returns the count receipt.
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: echoSaga.id,
    action: "execute",
  });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  const second = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${second}/grants`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: echoSaga.id,
    action: "execute",
  });
  await call(`/api/orgs/${ORG_A}/roles/${second}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(
    await call(`/api/orgs/${ORG_A}/assignments/revoke`, "POST", USER_ADMIN, { userId: USER_ORDINARY }),
  ).toMatchObject({
    status: 200,
    body: { revoked: 2 },
  });
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "v4" }, "auth02-revoke-0004")).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
});

it("exercises the owner/admin/provider-admin/external matrices", async () => {
  // Owner: a plain member with a direct user rule executes; nothing else.
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: helloSaga.id,
      action: "execute",
      subjectType: "user",
      subjectRef: USER_OWNER,
    }),
  ).toMatchObject({ status: 201 });
  expect(await submitSaga(USER_OWNER, ORG_A, helloSaga.id, { name: "owner" }, "auth02-owner-0001")).toMatchObject({
    status: 202,
  });
  expect(await submitSaga(USER_OWNER, ORG_A, echoSaga.id, { message: "owner" }, "auth02-owner-0002")).toMatchObject({
    status: 403,
  });
  // Org admin bypass: fixture admin executes with no grant at all.
  expect(await submitSaga(USER_ADMIN, ORG_A, echoSaga.id, { message: "admin" }, "auth02-admin-0001")).toMatchObject({
    status: 202,
  });
  // Provider admin (instance admin, no membership): same bypass. LAB fixture
  // identities are UUIDs (auth.ts), so the provider is a UUID outside the
  // membership table, authorized purely through the admin list.
  const PROVIDER = "00000000-0000-4000-8000-000000000007";
  const providerDenied = await submitSaga(
    PROVIDER,
    ORG_A,
    echoSaga.id,
    { message: "provider" },
    "auth02-provider-0001",
  );
  expect(providerDenied).toMatchObject({ status: 404 });
  const withProvider = {
    ...bindings,
    LAB_USER_ID: PROVIDER,
    LAB_FIXTURE_USER_ID: USER_ADMIN,
    ADMIN_USER_IDS: `${USER_ADMIN},${PROVIDER}`,
  };
  const providerRes = await worker.fetch(
    new Request("http://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth02-provider-0002",
      },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "provider" } }),
    }),
    withProvider,
  );
  expect(providerRes.status).toBe(202);
  // External caller: kind rule authorizes the matrix, admin promotion stays refused.
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
      subjectType: "kind",
      subjectRef: "external",
    }),
  ).toMatchObject({ status: 201 });
  expect(await submitSaga(USER_EXTERNAL, ORG_A, echoSaga.id, { message: "ext" }, "auth02-external-0001")).toMatchObject(
    {
      status: 202,
    },
  );
  expect(await call(`/api/orgs/${ORG_A}/roles`, "GET", USER_EXTERNAL)).toMatchObject({
    status: 403,
    body: { error: { code: "ADMIN_ONLY" } },
  });
});

it("inspects consumers before removing a grant and refuses bad triples", async () => {
  const roleId = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: echoSaga.id,
    action: "execute",
  });
  await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
    resourceKind: "saga",
    resourceId: echoSaga.id,
    action: "execute",
    subjectType: "user",
    subjectRef: USER_OWNER,
  });
  // Role consumers show the grant plus the assigned user.
  const consumers = await call(`/api/orgs/${ORG_A}/roles/${roleId}/consumers`, "GET", USER_ADMIN);
  expect(consumers.status).toBe(200);
  expect(JSON.stringify(consumers.body)).toContain(USER_ORDINARY);
  expect(JSON.stringify(consumers.body)).toContain(echoSaga.id);
  // Policy consumers span rules and role paths.
  const seen = await call(
    `/api/orgs/${ORG_A}/policy-consumers?resourceKind=saga&resourceId=${echoSaga.id}&action=execute`,
    "GET",
    USER_ADMIN,
  );
  expect(seen.status).toBe(200);
  expect(JSON.stringify(seen.body)).toContain(USER_ORDINARY);
  expect(JSON.stringify(seen.body)).toContain(USER_OWNER);
  // Deleting the role returns counts and revokes access immediately.
  const deleted = await call(`/api/orgs/${ORG_A}/roles/${roleId}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ deletedGrants: 1, deletedAssignments: 1 });
  expect(await submitSaga(USER_ORDINARY, ORG_A, echoSaga.id, { message: "gone" }, "auth02-deleted-0001")).toMatchObject(
    {
      status: 403,
    },
  );
  // Reserved kinds and mismatched actions fail closed as INVALID_GRANT.
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "table",
      resourceId: "customers",
      action: "read",
      subjectType: "all",
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_GRANT" } } });
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "serve",
      subjectType: "all",
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_GRANT" } } });
  // Unknown keys, bad subjects, and stranger assignment fail closed.
  expect(await call(`/api/orgs/${ORG_A}/roles`, "POST", USER_ADMIN, { name: "x", bogus: true })).toMatchObject({
    status: 400,
    body: { error: { code: "UNSUPPORTED_FIELD" } },
  });
  expect(
    await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
      subjectType: "kind",
      subjectRef: "robot",
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_SUBJECT" } } });
  const fresh = await makeRole();
  expect(
    await call(`/api/orgs/${ORG_A}/roles/${fresh}/assignments`, "POST", USER_ADMIN, { userId: "ghost@example.com" }),
  ).toMatchObject({ status: 404, body: { error: { code: "USER_NOT_FOUND" } } });
  // Ordinary members reach no role/policy admin route.
  expect(await call(`/api/orgs/${ORG_A}/roles`, "GET", USER_ORDINARY)).toMatchObject({ status: 403 });
  expect(await call("/api/policy-rules", "POST", USER_ORDINARY, {})).toMatchObject({ status: 403 });
});

it("requires write grants on both slug-swap peers (issue #143)", async () => {
  // Same-org Apps A/B; ordinary member gets write on A only.
  const createdA = await call("/api/apps", "POST", USER_ADMIN, { name: "SwapA", slug: "swap-a" });
  expect(createdA.status).toBe(201);
  const appA = (createdA.body.app as { id: string }).id;
  const createdB = await call("/api/apps", "POST", USER_ADMIN, { name: "SwapB", slug: "swap-b" });
  expect(createdB.status).toBe(201);
  const appB = (createdB.body.app as { id: string }).id;
  const writeA = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${writeA}/grants`, "POST", USER_ADMIN, {
    resourceKind: "app",
    resourceId: appA,
    action: "write",
  });
  await call(`/api/orgs/${ORG_A}/roles/${writeA}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  // Swap naming B as peer: denied, both slugs unchanged.
  expect(await call(`/api/apps/${appA}/swap`, "POST", USER_ORDINARY, { otherAppId: appB })).toMatchObject({
    status: 403,
    body: { error: { code: "GRANT_REQUIRED" } },
  });
  const slugA = await bindings.DB.prepare("SELECT slug FROM apps WHERE id = ?").bind(appA).first<{ slug: string }>();
  const slugB = await bindings.DB.prepare("SELECT slug FROM apps WHERE id = ?").bind(appB).first<{ slug: string }>();
  expect(slugA?.slug).toBe("swap-a");
  expect(slugB?.slug).toBe("swap-b");
  // Foreign/unknown peer 404s, never a grant-shaped confirm.
  expect(
    await call(`/api/apps/${appA}/swap`, "POST", USER_ORDINARY, { otherAppId: "00000000-0000-4000-8000-000000000099" }),
  ).toMatchObject({ status: 404 });
  // Write on B as well: the swap succeeds.
  const writeB = await makeRole();
  await call(`/api/orgs/${ORG_A}/roles/${writeB}/grants`, "POST", USER_ADMIN, {
    resourceKind: "app",
    resourceId: appB,
    action: "write",
  });
  await call(`/api/orgs/${ORG_A}/roles/${writeB}/assignments`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  expect(await call(`/api/apps/${appA}/swap`, "POST", USER_ORDINARY, { otherAppId: appB })).toMatchObject({
    status: 200,
  });
  const slugA2 = await bindings.DB.prepare("SELECT slug FROM apps WHERE id = ?").bind(appA).first<{ slug: string }>();
  const slugB2 = await bindings.DB.prepare("SELECT slug FROM apps WHERE id = ?").bind(appB).first<{ slug: string }>();
  expect(slugA2?.slug).toBe("swap-b");
  expect(slugB2?.slug).toBe("swap-a");
});
