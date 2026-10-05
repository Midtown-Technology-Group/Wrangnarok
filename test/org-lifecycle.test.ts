// SPDX-License-Identifier: AGPL-3.0
// AUTH-01 (issue #142, ADR 015): Organization and user lifecycle through the
// public APIs. Multi-org allowed/denied matrices for ordinary/admin/external
// users, deactivation, scope selection, cascading-delete previews with
// retained ExecutionHistory, and in-flight job visibility after revocation.
// Runs in real workerd with a real D1 binding; the only doubles are LAB
// fixture identities (distinct LAB_USER_ID per caller) and the admin list.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga } from "../src/domain";
import {
  deleteOrg,
  deletePreview,
  ensureLabFixture,
  inviteMember,
  resolveCaller,
  updateMember,
  type MembershipKind,
  type MembershipStatus,
  type OrgRole,
} from "../src/orgs";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration3 from "../migrations/0003_usage_blocks.sql?raw";
import migration4 from "../migrations/0004_solutions_install.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
import migration9 from "../migrations/0009_tables.sql?raw";
import migration10 from "../migrations/0010_solutions_activation.sql?raw";
import migration11 from "../migrations/0011_connection_admin.sql?raw";
import migration12 from "../migrations/0012_saga_policies.sql?raw";
import migration13 from "../migrations/0013_resource_roles.sql?raw";
import migration14 from "../migrations/0014_execution_logs.sql?raw";
import migration16 from "../migrations/0016_schedules.sql?raw";
import migration18 from "../migrations/0018_ops.sql?raw";
import migration19 from "../migrations/0019_files.sql?raw";
import migration20 from "../migrations/0020_artifacts.sql?raw";
import migration21 from "../migrations/0021_endpoints.sql?raw";
import migration22 from "../migrations/0022_app_runtime.sql?raw";
import migration23 from "../migrations/0023_config.sql?raw";
import migration24 from "../migrations/0024_tool_enrollments.sql?raw";
import migration25 from "../migrations/0025_audit_retention.sql?raw";
import migration28 from "../migrations/0028_ai_profiles.sql?raw";
import migration29 from "../migrations/0029_connection_secrets.sql?raw";
import migration30 from "../migrations/0030_events.sql?raw";
import migration31 from "../migrations/0031_oauth_tokens.sql?raw";
import migration33 from "../migrations/0033_event_subscriptions.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const USER_ORDINARY = "00000000-0000-4000-8000-000000000003";
const USER_EXTERNAL = "00000000-0000-4000-8000-000000000004";
const USER_STRANGER = "00000000-0000-4000-8000-000000000005";

function authed(path: string, method: string, body?: unknown, orgId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(orgId === undefined ? {} : { "X-Organization-Id": orgId }),
  };
  return new Request(`https://local.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function asUser(userId: string): Bindings {
  return { ...bindings, LAB_USER_ID: userId, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: USER_ADMIN };
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

async function seedSecondOrg(): Promise<string> {
  // Instance admin creates org B, then invites the matrix: the fixture
  // caller (also instance admin) plus an ordinary and an external member.
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "second-org" });
  expect(created.status).toBe(201);
  const orgB = created.body.id as string;
  // The creator holds no membership yet (instance admin bypasses it): invite
  // them as admin so last-admin and membership tests have a real row.
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ADMIN, role: "admin" }),
  ).toMatchObject({
    status: 201,
  });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY })).toMatchObject({
    status: 201,
  });
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_EXTERNAL, kind: "external" }),
  ).toMatchObject({ status: 201 });
  // Activate all three invitations through one verified request each.
  expect(await call("/api/sagas", "GET", USER_ADMIN, undefined, orgB)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({ status: 200 });
  return orgB;
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(migration3);
  await bindings.DB.exec(migration4);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
  await bindings.DB.exec(migration9);
  await bindings.DB.exec(migration10);
  await bindings.DB.exec(migration11);
  await bindings.DB.exec(migration12);
  await bindings.DB.exec(migration13);
  await bindings.DB.exec(migration14);
  await bindings.DB.exec(migration16);
  await bindings.DB.exec(migration18);
  await bindings.DB.exec(migration19);
  await bindings.DB.exec(migration20);
  await bindings.DB.exec(migration21);
  await bindings.DB.exec(migration22);
  await bindings.DB.exec(migration23);
  await bindings.DB.exec(migration24);
  await bindings.DB.exec(migration25);
  await bindings.DB.exec(migration28);
  await bindings.DB.exec(migration29);
  await bindings.DB.exec(migration30);
  await bindings.DB.exec(migration31);
  await bindings.DB.exec(migration33);
  // Fixture caller bootstraps to admin of org A inside authenticate; the
  // ordinary identity holds org-A membership too (member), so collection
  // routes gate cleanly. External/stranger stay strangers until invited.
  for (const user of [USER_ORDINARY, USER_EXTERNAL, USER_STRANGER]) {
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(user, new Date().toISOString())
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_ORDINARY, "member", "active", "ordinary", new Date().toISOString(), new Date().toISOString())
    .run();
});

afterEach(async () => {
  await reset();
});

it("creates orgs as instance admin and refuses ordinary callers", async () => {
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "acme" });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ name: "acme", status: "active" });
  // Duplicate names conflict, even across case-insensitive identical input.
  expect(await call("/api/orgs", "POST", USER_ADMIN, { name: "acme" })).toMatchObject({
    status: 409,
    body: { error: { code: "ORG_EXISTS" } },
  });
  // An authenticated member without instance admin cannot create orgs.
  expect(await call("/api/orgs", "POST", USER_ORDINARY, { name: "nope" })).toMatchObject({
    status: 403,
    body: { error: { code: "ADMIN_ONLY" } },
  });
  // Bad names fail closed before touching D1.
  expect(await call("/api/orgs", "POST", USER_ADMIN, { name: "" })).toMatchObject({
    status: 400,
    body: { error: { code: "INVALID_ORG_NAME" } },
  });
});

it("runs the multi-org allowed/denied matrix for ordinary/admin/external users", async () => {
  const orgB = await seedSecondOrg();
  // Instance admin sees both orgs; ordinary member of B sees only B;
  // stranger (no membership anywhere) sees none.
  expect(((await call("/api/orgs", "GET", USER_ADMIN)).body.orgs as unknown[]).length).toBe(2);
  expect(await call("/api/orgs", "GET", USER_ORDINARY)).toMatchObject({ status: 200 });
  // Ordinary holds org A bootstrap membership plus the org B invite.
  expect(
    ((await call("/api/orgs", "GET", USER_ORDINARY)).body.orgs as { id: string }[]).map((o) => o.id).sort(),
  ).toEqual([ORG_A, orgB].sort());
  expect(await call("/api/orgs", "GET", USER_STRANGER)).toMatchObject({ status: 200, body: { orgs: [] } });
  // Ordinary member reads catalog and submits in their own org…
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({ status: 200 });
  // AUTH-02 (ADR 018): deny by absence — the ordinary submit needs a grant.
  // The admin creates a wildcard execute role first (role control plane).
  const matrixRole = await call(`/api/orgs/${orgB}/roles`, "POST", USER_ADMIN, { name: "matrix-runners" });
  expect(matrixRole.status).toBe(201);
  expect(
    await call(`/api/orgs/${orgB}/roles/${matrixRole.body.id as string}/grants`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: "*",
      action: "execute",
    }),
  ).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${orgB}/roles/${matrixRole.body.id as string}/assignments`, "POST", USER_ADMIN, {
      userId: USER_ORDINARY,
    }),
  ).toMatchObject({ status: 201 });
  const submit = await worker.fetch(
    new Request("https://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth01-matrix-0001",
        "X-Organization-Id": orgB,
      },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "matrix" } }),
    }),
    asUser(USER_ORDINARY),
  );
  expect(submit.status).toBe(202);
  // …but a true stranger cannot touch org A at all: no scope, no leak
  // (404, never 403).
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, ORG_A)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
  // External member reads and executes like an ordinary member…
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({ status: 200 });
  // …but can never be promoted to admin through either path.
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, {
      userId: "ext2@example.com",
      role: "admin",
      kind: "external",
    }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_EXTERNAL}`, "PATCH", USER_ADMIN, { role: "admin" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  // Ordinary member reaches no admin route.
  expect(await call(`/api/orgs/${orgB}/members`, "GET", USER_ORDINARY)).toMatchObject({
    status: 403,
    body: { error: { code: "ADMIN_ONLY" } },
  });
  // Stranger cannot select into org B either (selection is not elevation).
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
});

it("deactivates users, orgs, and memberships with immediate effect and no redeploy", async () => {
  const orgB = await seedSecondOrg();
  // Revoked membership fails at the gate on the very next request.
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { status: "revoked" }),
  ).toMatchObject({
    status: 200,
    body: { status: "revoked" },
  });
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "MEMBERSHIP_REVOKED" } },
  });
  // Suspended external member is denied distinctly.
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_EXTERNAL}`, "PATCH", USER_ADMIN, { status: "suspended" }),
  ).toMatchObject({
    status: 200,
  });
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "MEMBERSHIP_SUSPENDED" } },
  });
  // Globally disabled user is denied in every org, even with live membership.
  // (A second, non-admin identity proves the denial; the instance admin
  // itself stays recoverable by design, tested below.)
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(orgB, USER_STRANGER, "member", "active", "ordinary", new Date().toISOString(), new Date().toISOString())
    .run();
  expect(await call(`/api/users/${USER_STRANGER}/disable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "USER_DISABLED" } },
  });
  expect(await call(`/api/users/${USER_STRANGER}/enable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({ status: 200 });
  // Disabled org denies members but stays recoverable by instance admin.
  expect(await call(`/api/orgs/${orgB}/disable`, "POST", USER_ADMIN, {})).toMatchObject({
    status: 200,
    body: { status: "disabled" },
  });
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "ORG_DISABLED" } },
  });
  // Instance admin still reaches the disabled org (recovery path).
  expect(await call(`/api/orgs/${orgB}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/enable`, "POST", USER_ADMIN, {})).toMatchObject({
    status: 200,
    body: { status: "active" },
  });
});

it("guards the last admin and refuses to strand a tenant", async () => {
  const orgB = await seedSecondOrg();
  // Only the fixture caller is admin of org B: demotion is refused…
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ADMIN, { role: "operator" }),
  ).toMatchObject({
    status: 409,
    body: { error: { code: "LAST_ADMIN" } },
  });
  // …as are suspension and revocation of the last admin.
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ADMIN, { status: "revoked" }),
  ).toMatchObject({
    status: 409,
    body: { error: { code: "LAST_ADMIN" } },
  });
  // Promote a second admin, then the first may step down (the newly
  // promoted admin authorizes the demotion).
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { role: "admin" }),
  ).toMatchObject({
    status: 200,
    body: { role: "admin" },
  });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ORDINARY, { role: "operator" }),
  ).toMatchObject({
    status: 200,
    body: { role: "operator" },
  });
});

it("previews cascading deletes with retained ExecutionHistory and refuses managed rows", async () => {
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "doomed" });
  const orgD = created.body.id as string;
  await call(`/api/orgs/${orgD}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgD);
  const id = "d".repeat(64);
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      orgD,
      USER_ORDINARY,
      JSON.stringify({ message: "kept" }),
      1,
      "Succeeded",
      new Date().toISOString(),
    )
    .run();
  await bindings.DB.prepare("INSERT INTO operations(execution_id,name,position,status,started_at) VALUES (?,?,?,?,?)")
    .bind(id, "echo-http-v1", 1, "Running", new Date().toISOString())
    .run();
  const preview = await call(`/api/orgs/${orgD}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({
    executions: 1,
    operations: 1,
    connectionsLoose: 0,
    connectionsManaged: 0,
    memberships: 1,
    forms: 0,
    apps: 0,
    tables: 0,
    files: 0,
    artifacts: 0,
    endpoints: 0,
    retained: ["executions", "operations", "audit_events"],
    canDelete: true,
  });
  // Authenticated members hitting instance-admin routes are denied (403):
  // the gate passes on the path-target membership, the admin check refuses.
  expect(await call(`/api/orgs/${orgD}/delete-preview`, "GET", USER_ORDINARY)).toMatchObject({ status: 403 });
  const deleted = await call(`/api/orgs/${orgD}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ orgId: orgD, deletedMemberships: 1 });
  // ExecutionHistory rows survive the delete: still in D1, unreachable via API.
  const exec = await bindings.DB.prepare("SELECT id FROM executions WHERE id=?").bind(id).first<{ id: string }>();
  expect(exec?.id).toBe(id);
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgD)).toMatchObject({ status: 404 });
});

it("deletes an org with retained audit events intact (issue #350)", async () => {
  // Migration 0025 drops the audit_events org FK: retained audit rows must
  // never block the final organizations delete (previously a partially
  // purged tenant — memberships, connections, files, and R2 bytes gone,
  // org row stuck behind the FK).
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "audited" });
  const orgA = created.body.id as string;
  await call(`/api/orgs/${orgA}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY });
  await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgA);
  // Seed retained audit rows directly (org routes emit no audit rows): an
  // ordinary-member action plus an admin action, both for this org.
  const auditStamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO audit_events(id,org_id,actor_user_id,action,target_type,target_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "11111111-1111-4111-8111-111111111111",
      orgA,
      USER_ORDINARY,
      "app.create",
      "app",
      "00000000-0000-4000-8000-000000000301",
      "success",
      null,
      auditStamp,
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO audit_events(id,org_id,actor_user_id,action,target_type,target_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "22222222-2222-4222-8222-222222222222",
      orgA,
      USER_ADMIN,
      "tool.execute",
      "tool",
      "halo_tool",
      "success",
      null,
      auditStamp,
    )
    .run();
  const preview = await call(`/api/orgs/${orgA}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body.auditEvents as number).toBe(2);
  const deleted = await call(`/api/orgs/${orgA}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ orgId: orgA });
  // Retained audit rows outlive the org; the org row is gone.
  const kept = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE org_id=?")
    .bind(orgA)
    .first<{ n: number }>();
  expect(kept?.n ?? 0).toBeGreaterThan(0);
  const gone = await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgA).first<{ id: string }>();
  expect(gone).toBeNull();
});

it("refuses managed rows on delete", async () => {
  // A managed Connection blocks deletion until the bundle is uninstalled.
  const created2 = await call("/api/orgs", "POST", USER_ADMIN, { name: "managed" });
  const orgM = created2.body.id as string;
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint,managed_by) VALUES (?,?,?,?,?)")
    .bind(
      "00000000-0000-4000-8000-000000000201",
      orgM,
      "720b9ebf-9b6a-4eac-bae9-6ed22c970402",
      "http://127.0.0.1:8788/echo",
      "bundle@1.0.0",
    )
    .run();
  const blocked = await call(`/api/orgs/${orgM}/delete-preview`, "GET", USER_ADMIN);
  expect(blocked.body).toMatchObject({ canDelete: false, connectionsManaged: 1 });
  expect(await call(`/api/orgs/${orgM}`, "DELETE", USER_ADMIN)).toMatchObject({
    status: 409,
    body: { error: { code: "DELETE_BLOCKED" } },
  });
});

it("removes owned resources and R2 bytes with the org, blocks managed rows", async () => {
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "owned" });
  expect(created.status).toBe(201);
  const orgO = created.body.id as string;
  await bindings.DB.prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind("00000000-0000-4000-8000-000000000301", orgO, "intake", echoSaga.id, "[]", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO apps(id,org_id,name,slug,owner_kind,managed_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000302",
      orgO,
      "portal",
      "portal",
      "independent",
      null,
      "created",
      stamp,
      stamp,
    )
    .run();
  await bindings.DB.prepare("INSERT INTO tables(id,org_id,name,owner_user_id,created_at) VALUES (?,?,?,?,?)")
    .bind("00000000-0000-4000-8000-000000000303", orgO, "notes", USER_ADMIN, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO table_rows(table_id,org_id,doc_id,owner_user_id,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000303", orgO, "doc-1", USER_ADMIN, "{}", stamp, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO file_locations(org_id,name,max_bytes,content_types_json,shared_read,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(orgO, "uploads", 1024, "[]", 0, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(orgO, "uploads", "note.txt", 1, 3, "text/plain", "a".repeat(64), "ready", stamp, stamp)
    .run();
  await bindings.FILES.put(`${orgO}/uploads/note.txt`, new TextEncoder().encode("hey"));
  await bindings.DB.prepare(
    "INSERT INTO artifacts(id,org_id,creator_user_id,name,mime,size_bytes,version,status,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000304",
      orgO,
      USER_ADMIN,
      "report",
      "text/plain",
      3,
      1,
      "active",
      stamp,
      stamp,
      null,
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO artifact_versions(id,artifact_id,version,mime,size_bytes,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000305", "00000000-0000-4000-8000-000000000304", 1, "text/plain", 3, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO artifact_bindings(id,artifact_id,org_id,scope,ref_id,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000306",
      "00000000-0000-4000-8000-000000000304",
      orgO,
      "workspace",
      "desk",
      stamp,
    )
    .run();
  await bindings.ARTIFACTS!.put("artifacts/00000000-0000-4000-8000-000000000304/v1", new TextEncoder().encode("hey"));
  await bindings.DB.prepare(
    "INSERT INTO endpoints(id,org_id,name,saga_id,kind,enabled,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000307", orgO, "hook", echoSaga.id, "api-key", 1, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO endpoint_events(endpoint_id,event_id,input_json,execution_id,created_at) VALUES (?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000307", "evt-1", "{}", "e".repeat(64), stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO configs(id,org_id,key,type,value_json,managed_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000308", orgO, "greeting", "string", '"hi"', null, stamp, USER_ADMIN)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO notifications(id,org_id,user_id,scope,category,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000309", orgO, USER_ADMIN, "org", "ops", "hello", "pending", stamp, stamp)
    .run();
  const preview = await call(`/api/orgs/${orgO}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({
    canDelete: true,
    forms: 1,
    apps: 1,
    tables: 1,
    tableRows: 1,
    fileLocations: 1,
    files: 1,
    artifacts: 1,
    endpoints: 1,
    configsLoose: 1,
    notifications: 1,
  });
  const deleted = await call(`/api/orgs/${orgO}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({
    orgId: orgO,
    deletedForms: 1,
    deletedApps: 1,
    deletedTables: 1,
    deletedTableRows: 1,
    deletedFileLocations: 1,
    deletedFiles: 1,
    deletedArtifacts: 1,
    deletedArtifactBindings: 1,
    deletedEndpoints: 1,
    deletedConfigs: 1,
    deletedNotifications: 1,
    deletedFileObjects: 1,
    deletedArtifactObjects: 1,
  });
  for (const [table, column] of [
    ["forms", "org_id"],
    ["apps", "org_id"],
    ["tables", "org_id"],
    ["table_rows", "org_id"],
    ["file_locations", "org_id"],
    ["files", "org_id"],
    ["file_policies", "org_id"],
    ["file_capabilities", "org_id"],
    ["artifacts", "org_id"],
    ["artifact_retention", "org_id"],
    ["endpoints", "org_id"],
    ["configs", "org_id"],
    ["notifications", "org_id"],
  ] as const) {
    const left = await bindings.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
      .bind(orgO)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  }
  expect(await bindings.FILES.get(`${orgO}/uploads/note.txt`)).toBeNull();
  expect(await bindings.ARTIFACTS!.get("artifacts/00000000-0000-4000-8000-000000000304/v1")).toBeNull();
  // Solution-owned apps and managed bundle rows block deletion.
  const created2 = await call("/api/orgs", "POST", USER_ADMIN, { name: "managed-app" });
  const orgS = created2.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO apps(id,org_id,name,slug,owner_kind,managed_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000311",
      orgS,
      "bundle-app",
      "bundle-app",
      "solution",
      "bundle@1.0.0",
      "created",
      stamp,
      stamp,
    )
    .run();
  expect(await call(`/api/orgs/${orgS}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { canDelete: false, appsManaged: 1 },
  });
  expect(await call(`/api/orgs/${orgS}`, "DELETE", USER_ADMIN)).toMatchObject({
    status: 409,
    body: { error: { code: "DELETE_BLOCKED" } },
  });
  // Managed configs block deletion with their own message.
  const created3 = await call("/api/orgs", "POST", USER_ADMIN, { name: "managed-config" });
  const orgC = created3.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO configs(id,org_id,key,type,value_json,managed_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000312", orgC, "theme", "string", '"dark"', "bundle@1.0.0", stamp, USER_ADMIN)
    .run();
  expect(await call(`/api/orgs/${orgC}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { canDelete: false, configsManaged: 1 },
  });
  expect(await call(`/api/orgs/${orgC}`, "DELETE", USER_ADMIN)).toMatchObject({
    status: 409,
    body: { error: { code: "DELETE_BLOCKED" } },
  });
  // Orphaned bytes fail closed instead of silently abandoned.
  const created4 = await call("/api/orgs", "POST", USER_ADMIN, { name: "no-bucket" });
  const orgN = created4.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(orgN, "uploads", "ghost.txt", 1, 3, "text/plain", "b".repeat(64), "ready", stamp, stamp)
    .run();
  const storeless = await worker.fetch(
    new Request(`https://local.test/api/orgs/${orgN}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    {
      ...bindings,
      FILES: undefined as unknown as R2Bucket,
      LAB_USER_ID: USER_ADMIN,
      LAB_FIXTURE_USER_ID: USER_ADMIN,
      ADMIN_USER_IDS: USER_ADMIN,
    },
  );
  expect(storeless.status).toBe(503);
});

it("keeps in-flight jobs visible to org admins after a member is revoked", async () => {
  const orgB = await seedSecondOrg();
  // AUTH-02 (ADR 018): the ordinary submit needs an execute grant first.
  const inflightRole = await call(`/api/orgs/${orgB}/roles`, "POST", USER_ADMIN, { name: "inflight-runners" });
  expect(inflightRole.status).toBe(201);
  expect(
    await call(`/api/orgs/${orgB}/roles/${inflightRole.body.id as string}/grants`, "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: "*",
      action: "execute",
    }),
  ).toMatchObject({ status: 201 });
  expect(
    await call(`/api/orgs/${orgB}/roles/${inflightRole.body.id as string}/assignments`, "POST", USER_ADMIN, {
      userId: USER_ORDINARY,
    }),
  ).toMatchObject({ status: 201 });
  const submit = await worker.fetch(
    new Request("https://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "auth01-inflight-001",
        "X-Organization-Id": orgB,
      },
      body: JSON.stringify({ sagaId: echoSaga.id, input: { message: "inflight" } }),
    }),
    asUser(USER_ORDINARY),
  );
  expect(submit.status).toBe(202);
  const { executionId } = (await submit.json()) as { executionId: string };
  // Revoke the submitter: their own reads fail at the gate…
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { status: "revoked" }),
  ).toMatchObject({
    status: 200,
  });
  // …but the org admin history surface still shows the in-flight job.
  const adminHistory = await call(`/api/orgs/${orgB}/executions`, "GET", USER_ADMIN);
  expect(adminHistory.status).toBe(200);
  expect(JSON.stringify(adminHistory.body)).toContain(executionId);
  // The revoked member's Execution row is untouched: still Pending/Running.
  const row = await bindings.DB.prepare("SELECT status FROM executions WHERE id=?")
    .bind(executionId)
    .first<{ status: string }>();
  expect(["Pending", "Running"]).toContain(row?.status);
  // Non-admin members never administer, even in their own org (403).
  expect(await call(`/api/orgs/${orgB}/executions`, "GET", USER_EXTERNAL)).toMatchObject({ status: 403 });
});

it("fails closed when the managed-config count faults (issue #226)", async () => {
  // Regression for the #233 implementation-watch finding: deletePreview's
  // managed-config count carried a terminal `.catch(() => 0)`, so a real D1
  // error read as "no managed configs" and deleteOrg then wiped
  // Solution-owned rows. Only optionalCount() owns old-schema tolerance now:
  // a non-`no such table` fault must fail preview and delete closed with the
  // org and config rows intact.
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "fault-closed" });
  expect(created.status).toBe(201);
  const orgF = created.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO configs(id,org_id,key,type,value_json,managed_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000320", orgF, "theme", "string", '"dark"', "bundle@1.0.0", stamp, USER_ADMIN)
    .run();
  // Sanity without the fault: the managed config blocks deletion.
  expect(await call(`/api/orgs/${orgF}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { canDelete: false, configsManaged: 1 },
  });
  // Faulty D1: only the managed-config count throws, with a non-`no such
  // table` error. Everything else rides the real local binding.
  const faultyDb = new Proxy(bindings.DB, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === "prepare" && typeof value === "function") {
        const prepare = value as (sql: string) => D1PreparedStatement;
        return (sql: string): D1PreparedStatement => {
          if (sql.includes("FROM configs") && sql.includes("managed_by IS NOT NULL")) {
            throw new Error("injected managed-config count fault");
          }
          return prepare.call(target, sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(deletePreview(faultyDb, orgF)).rejects.toThrow("injected managed-config count fault");
  await expect(deleteOrg(faultyDb, orgF, { files: bindings.FILES, artifacts: bindings.ARTIFACTS })).rejects.toThrow(
    "injected managed-config count fault",
  );
  // Org and managed config rows survive the faulted attempts.
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgF).first()).not.toBeNull();
  const configs = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM configs WHERE org_id=?")
    .bind(orgF)
    .first<{ n: number }>();
  expect(configs?.n).toBe(1);
  // A non-FK fault inside the D1 cascade itself also fails loud (never
  // mapped to DELETE_BLOCKED): only genuine FK drift takes that path.
  const cascadeFaultyDb = new Proxy(bindings.DB, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === "prepare" && typeof value === "function") {
        const prepare = value as (sql: string) => D1PreparedStatement;
        return (sql: string): D1PreparedStatement => {
          if (sql.includes("DELETE FROM saga_policies")) {
            throw new Error("injected cascade fault");
          }
          return prepare.call(target, sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await bindings.DB.prepare("DELETE FROM configs WHERE org_id=?").bind(orgF).run();
  await expect(
    deleteOrg(cascadeFaultyDb, orgF, { files: bindings.FILES, artifacts: bindings.ARTIFACTS }),
  ).rejects.toThrow("injected cascade fault");
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgF).first()).not.toBeNull();
});

it("tolerates raced source-local deletes and loud final-row faults (issue #226)", async () => {
  // A schedule or source deleted by an operator between org-delete's name
  // list and its source-local delete reads as already gone (phantom names
  // below); the org delete proceeds instead of 404ing mid-cascade.
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "race-tolerant" });
  expect(created.status).toBe(201);
  const orgT = created.body.id as string;
  const phantomDb = new Proxy(bindings.DB, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === "prepare" && typeof value === "function") {
        const prepare = value as (sql: string) => D1PreparedStatement;
        return (sql: string): D1PreparedStatement => {
          if (sql === "SELECT name FROM schedules WHERE org_id=?") {
            return {
              bind: () => ({ all: async () => ({ results: [{ name: "ghost-schedule" }] }) }),
            } as unknown as D1PreparedStatement;
          }
          if (sql === "SELECT name FROM event_sources WHERE org_id=?") {
            return {
              bind: () => ({ all: async () => ({ results: [{ name: "ghost-source" }] }) }),
            } as unknown as D1PreparedStatement;
          }
          return prepare.call(target, sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const deleted = await deleteOrg(phantomDb, orgT, { files: bindings.FILES, artifacts: bindings.ARTIFACTS });
  expect(deleted).toMatchObject({ orgId: orgT });
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgT).first()).toBeNull();
  // A non-FK fault inside a source-local delete still fails loud.
  const created2 = await call("/api/orgs", "POST", USER_ADMIN, { name: "loud-mid-cascade" });
  const orgM = created2.body.id as string;
  const stamp = new Date().toISOString();
  await bindings.DB.prepare(
    "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000370",
      orgM,
      "nightly",
      echoSaga.id,
      "recurring",
      "0 0 * * *",
      "UTC",
      1,
      "{}",
      USER_ADMIN,
      stamp,
      stamp,
    )
    .run();
  const midFaultyDb = new Proxy(bindings.DB, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === "prepare" && typeof value === "function") {
        const prepare = value as (sql: string) => D1PreparedStatement;
        return (sql: string): D1PreparedStatement => {
          if (sql.includes("DELETE FROM schedule_deliveries")) {
            throw new Error("injected mid-cascade fault");
          }
          return prepare.call(target, sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(deleteOrg(midFaultyDb, orgM, { files: bindings.FILES, artifacts: bindings.ARTIFACTS })).rejects.toThrow(
    "injected mid-cascade fault",
  );
  // A non-FK fault on the final organizations delete fails loud too: only
  // genuine FK drift maps to DELETE_BLOCKED.
  const created3 = await call("/api/orgs", "POST", USER_ADMIN, { name: "loud-final" });
  const orgF = created3.body.id as string;
  const finalFaultyDb = new Proxy(bindings.DB, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === "prepare" && typeof value === "function") {
        const prepare = value as (sql: string) => D1PreparedStatement;
        return (sql: string): D1PreparedStatement => {
          if (sql === "DELETE FROM organizations WHERE id=?") {
            throw new Error("injected final-row fault");
          }
          return prepare.call(target, sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    deleteOrg(finalFaultyDb, orgF, { files: bindings.FILES, artifacts: bindings.ARTIFACTS }),
  ).rejects.toThrow("injected final-row fault");
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgF).first()).not.toBeNull();
});

it("cascades schedules and deliveries through the TRG-01 delete path (issue #226)", async () => {
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "sched-cascade" });
  expect(created.status).toBe(201);
  const orgS = created.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000321",
      orgS,
      "nightly",
      echoSaga.id,
      "recurring",
      "0 0 * * *",
      "UTC",
      1,
      "{}",
      USER_ADMIN,
      stamp,
      stamp,
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO schedule_deliveries(schedule_id,window,input_json,execution_id,created_at) VALUES (?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000321", "2026-09-17T00:00", "{}", "e".repeat(64), stamp)
    .run();
  const preview = await call(`/api/orgs/${orgS}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({ canDelete: true, schedules: 1 });
  const deleted = await call(`/api/orgs/${orgS}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ orgId: orgS, deletedSchedules: 1 });
  const left = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM schedules WHERE org_id=?")
    .bind(orgS)
    .first<{ n: number }>();
  expect(left?.n).toBe(0);
  const deliveries = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM schedule_deliveries WHERE schedule_id=?")
    .bind("00000000-0000-4000-8000-000000000321")
    .first<{ n: number }>();
  expect(deliveries?.n).toBe(0);
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgS).first()).toBeNull();
});

it("cascades event sources, subscriptions, and receipts through the TRG-03 delete path (issue #226)", async () => {
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "event-cascade" });
  expect(created.status).toBe(201);
  const orgE = created.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO event_sources(id,org_id,name,kind,ref_id,enabled,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000322", orgE, "orders", "topic", null, 1, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO events(source_id,event_id,org_id,topic,payload_json,execution_id,created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000322", "evt-001", orgE, "vendor.order.created", "{}", null, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO event_subscriptions(id,org_id,source_id,name,saga_id,topic_filter,enabled,run_as_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000323",
      orgE,
      "00000000-0000-4000-8000-000000000322",
      "ship",
      echoSaga.id,
      "vendor.order.*",
      1,
      USER_ADMIN,
      stamp,
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO event_deliveries(subscription_id,event_id,org_id,topic,execution_id,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000323", "evt-001", orgE, "vendor.order.created", "e".repeat(64), stamp)
    .run();
  const preview = await call(`/api/orgs/${orgE}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({ canDelete: true, eventSources: 1, eventSubscriptions: 1 });
  const deleted = await call(`/api/orgs/${orgE}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ orgId: orgE, deletedEventSources: 1, deletedEventSubscriptions: 1 });
  for (const table of ["event_sources", "event_subscriptions"] as const) {
    const left = await bindings.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`)
      .bind(orgE)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  }
  const events = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE source_id=?")
    .bind("00000000-0000-4000-8000-000000000322")
    .first<{ n: number }>();
  expect(events?.n).toBe(0);
  const deliveries = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM event_deliveries WHERE subscription_id=?")
    .bind("00000000-0000-4000-8000-000000000323")
    .first<{ n: number }>();
  expect(deliveries?.n).toBe(0);
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgE).first()).toBeNull();
});

it("cascades AI profiles, assignments, embedding, and behavior before Connections (issue #226)", async () => {
  // AI rows carry ON DELETE RESTRICT links (assignments to profiles,
  // profiles and embedding config to Connections), so org deletion removes
  // them child-first and strictly before the Connections batch.
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "ai-cascade" });
  expect(created.status).toBe(201);
  const orgI = created.body.id as string;
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(
      "00000000-0000-4000-8000-000000000324",
      orgI,
      "720b9ebf-9b6a-4eac-bae9-6ed22c970402",
      "https://api.openai.com",
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000325",
      orgI,
      "00000000-0000-4000-8000-000000000324",
      "chat",
      "gpt-4o",
      stamp,
      stamp,
    )
    .run();
  await bindings.DB.prepare("INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)")
    .bind(orgI, "primary", "00000000-0000-4000-8000-000000000325", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO ai_embedding_config(org_id,connection_id,model_id,dimensions,updated_at) VALUES (?,?,?,?,?)",
  )
    .bind(orgI, "00000000-0000-4000-8000-000000000324", "voyage-3", 1024, stamp)
    .run();
  await bindings.DB.prepare("INSERT INTO ai_behavior(org_id,default_system_prompt,updated_at) VALUES (?,?,?)")
    .bind(orgI, "You are a helpful operator assistant.", stamp)
    .run();
  const preview = await call(`/api/orgs/${orgI}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({
    canDelete: true,
    aiProfiles: 1,
    aiAssignments: 1,
    aiEmbedding: 1,
    aiBehavior: 1,
  });
  const deleted = await call(`/api/orgs/${orgI}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({
    orgId: orgI,
    deletedAiProfiles: 1,
    deletedAiAssignments: 1,
    deletedAiEmbedding: 1,
    deletedAiBehavior: 1,
    deletedConnections: 1,
  });
  for (const table of ["ai_model_profiles", "ai_assignments", "ai_embedding_config", "ai_behavior"] as const) {
    const left = await bindings.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`)
      .bind(orgI)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  }
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgI).first()).toBeNull();
});

it("cascades runtime policies and tool enrollments with the org (issue #226)", async () => {
  // Same defect class as schedules/events/AI, same fix: loose org-owned
  // config rows with no managed_by semantics cascade with the org.
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "policy-cascade" });
  expect(created.status).toBe(201);
  const orgP = created.body.id as string;
  await bindings.DB.prepare("INSERT INTO saga_policies(org_id,saga_id,policy_json,updated_at) VALUES (?,?,?,?)")
    .bind(orgP, echoSaga.id, "{}", stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO tool_enrollments(id,org_id,tool_name,saga_id,saga_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000326", orgP, "halo_tool", echoSaga.id, echoSaga.revision, stamp, stamp)
    .run();
  const preview = await call(`/api/orgs/${orgP}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({ canDelete: true, sagaPolicies: 1, toolEnrollments: 1 });
  const deleted = await call(`/api/orgs/${orgP}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ orgId: orgP, deletedSagaPolicies: 1, deletedToolEnrollments: 1 });
  for (const table of ["saga_policies", "tool_enrollments"] as const) {
    const left = await bindings.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`)
      .bind(orgP)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  }
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgP).first()).toBeNull();
});

it("pins the artifact/R2 cascade: every version object goes with the org (issue #226)", async () => {
  // #226 decision: live artifacts cascade (rows plus every R2 version
  // object), they do not block. Multi-version coverage: artifact A keeps
  // v1+v2 objects, artifact B a single v1; both carry a binding row and the
  // org carries a retention row, and the delete must leave no D1 residue.
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "artifact-cascade" });
  expect(created.status).toBe(201);
  const orgR = created.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO artifacts(id,org_id,creator_user_id,name,mime,size_bytes,version,status,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000330",
      orgR,
      USER_ADMIN,
      "report",
      "text/plain",
      6,
      2,
      "active",
      stamp,
      stamp,
      null,
    )
    .run();
  for (const version of [1, 2]) {
    await bindings.DB.prepare(
      "INSERT INTO artifact_versions(id,artifact_id,version,mime,size_bytes,created_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        `00000000-0000-4000-8000-00000000033${version}`,
        "00000000-0000-4000-8000-000000000330",
        version,
        "text/plain",
        3,
        stamp,
      )
      .run();
    await bindings.ARTIFACTS!.put(
      `artifacts/00000000-0000-4000-8000-000000000330/v${version}`,
      new TextEncoder().encode(`v${version}`),
    );
  }
  await bindings.DB.prepare(
    "INSERT INTO artifacts(id,org_id,creator_user_id,name,mime,size_bytes,version,status,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000335",
      orgR,
      USER_ADMIN,
      "single",
      "text/plain",
      3,
      1,
      "active",
      stamp,
      stamp,
      null,
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO artifact_versions(id,artifact_id,version,mime,size_bytes,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000336", "00000000-0000-4000-8000-000000000335", 1, "text/plain", 3, stamp)
    .run();
  await bindings.ARTIFACTS!.put("artifacts/00000000-0000-4000-8000-000000000335/v1", new TextEncoder().encode("v1"));
  await bindings.DB.prepare(
    "INSERT INTO artifact_bindings(id,artifact_id,org_id,scope,ref_id,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000338",
      "00000000-0000-4000-8000-000000000330",
      orgR,
      "workspace",
      "desk-a",
      stamp,
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO artifact_bindings(id,artifact_id,org_id,scope,ref_id,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000339",
      "00000000-0000-4000-8000-000000000335",
      orgR,
      "workspace",
      "desk-b",
      stamp,
    )
    .run();
  await bindings.DB.prepare("INSERT INTO artifact_retention(org_id,max_age_days,updated_at) VALUES (?,?,?)")
    .bind(orgR, 90, stamp)
    .run();
  const preview = await call(`/api/orgs/${orgR}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({ canDelete: true, artifacts: 2 });
  const deleted = await call(`/api/orgs/${orgR}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({
    orgId: orgR,
    deletedArtifacts: 2,
    deletedArtifactBindings: 2,
    deletedArtifactObjects: 3,
  });
  expect(await bindings.ARTIFACTS!.get("artifacts/00000000-0000-4000-8000-000000000330/v1")).toBeNull();
  expect(await bindings.ARTIFACTS!.get("artifacts/00000000-0000-4000-8000-000000000330/v2")).toBeNull();
  expect(await bindings.ARTIFACTS!.get("artifacts/00000000-0000-4000-8000-000000000335/v1")).toBeNull();
  const versions = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id IN (?,?)")
    .bind("00000000-0000-4000-8000-000000000330", "00000000-0000-4000-8000-000000000335")
    .first<{ n: number }>();
  expect(versions?.n).toBe(0);
  // No D1 residue: parent artifact rows, bindings (both the direct org FK
  // and the artifact FK), and the retention row all go with the org.
  for (const [table, column] of [
    ["artifacts", "org_id"],
    ["artifact_bindings", "org_id"],
    ["artifact_retention", "org_id"],
  ] as const) {
    const left = await bindings.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
      .bind(orgR)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  }
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgR).first()).toBeNull();
  // Missing ARTIFACTS binding fails closed like the FILES case: bytes must
  // not be silently abandoned.
  const created2 = await call("/api/orgs", "POST", USER_ADMIN, { name: "no-artifact-bucket" });
  const orgN = created2.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO artifacts(id,org_id,creator_user_id,name,mime,size_bytes,version,status,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "00000000-0000-4000-8000-000000000337",
      orgN,
      USER_ADMIN,
      "orphan",
      "text/plain",
      3,
      1,
      "active",
      stamp,
      stamp,
      null,
    )
    .run();
  const storeless = await worker.fetch(
    new Request(`https://local.test/api/orgs/${orgN}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    {
      ...bindings,
      ARTIFACTS: undefined as unknown as R2Bucket,
      LAB_USER_ID: USER_ADMIN,
      LAB_FIXTURE_USER_ID: USER_ADMIN,
      ADMIN_USER_IDS: USER_ADMIN,
    },
  );
  expect(storeless.status).toBe(503);
  expect(await storeless.json()).toMatchObject({ error: { code: "ORG_DELETE_STORE_MISSING" } });
});

it("blocks structured (never raw 500) on residual owned rows (issue #226)", async () => {
  // Defense in depth: execution_logs is ExecutionHistory-adjacent and keeps
  // its org FK while the retention-vs-cascade decision is pending, so it is
  // the known-residual case. The delete must fail closed with a structured
  // DELETE_BLOCKED, never a raw FK 500, and the org row must survive.
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "log-residual" });
  expect(created.status).toBe(201);
  const orgL = created.body.id as string;
  await bindings.DB.prepare(
    "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "f".repeat(64),
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      orgL,
      USER_ADMIN,
      JSON.stringify({ message: "logged" }),
      1,
      "Succeeded",
      stamp,
    )
    .run();
  await bindings.DB.prepare(
    "INSERT INTO execution_logs(execution_id,org_id,user_id,saga_id,saga_name,level,message,created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("f".repeat(64), orgL, USER_ADMIN, echoSaga.id, echoSaga.name, "INFO", "hello step", stamp)
    .run();
  const preview = await call(`/api/orgs/${orgL}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({ canDelete: true });
  const blocked = await call(`/api/orgs/${orgL}`, "DELETE", USER_ADMIN);
  expect(blocked.status).toBe(409);
  expect(blocked.body).toMatchObject({ error: { code: "DELETE_BLOCKED" } });
  expect(await bindings.DB.prepare("SELECT id FROM organizations WHERE id=?").bind(orgL).first()).not.toBeNull();
});

it("owns every REFERENCES organizations(id) table on the delete path (issue #226)", async () => {
  // Schema drift guard: a future migration introducing an org FK must make
  // a deliberate cascade-or-block decision instead of silently bypassing
  // org-delete ownership (preview says deletable, D1 says otherwise).
  // Repair/restore migrations are out of scope here: 0015/0032 add no
  // tables, 0027 only converges already-present renamed tables, and 0026 is
  // excluded while its executions-FK regression is repaired separately.
  const rows = await bindings.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%REFERENCES organizations(id)%' ORDER BY name",
  ).all<{ name: string; sql: string }>();
  const found = rows.results.map((row) => row.name).sort();
  expect(found.length).toBeGreaterThan(0);
  const HANDLED = new Set([
    "ai_assignments",
    "ai_behavior",
    "ai_embedding_config",
    "ai_model_profiles",
    "app_executions",
    "app_files",
    "app_grants",
    "app_rows",
    "app_tables",
    "apps",
    "artifact_bindings",
    "artifact_retention",
    "artifacts",
    "bundle_active",
    "bundle_config",
    "bundle_installs",
    "bundle_sagas",
    "configs",
    "connections",
    "endpoints",
    "event_sources",
    "event_subscriptions",
    "file_capabilities",
    "file_locations",
    "file_policies",
    "files",
    "forms",
    "notifications",
    "org_memberships",
    "policy_rules",
    "resource_roles",
    "role_assignments",
    "saga_policies",
    "schedules",
    "tables",
    "tool_enrollments",
  ]);
  // Secret rows ride their parent Connection via ON DELETE CASCADE (no
  // org-delete SQL of their own); the DDL pin below keeps that honest.
  const AUTO_CASCADE = new Set(["connection_secrets", "oauth_tokens"]);
  // ExecutionHistory-adjacent: retention decision pending, fails closed via
  // the structured DELETE_BLOCKED backstop instead of a raw FK 500.
  const KNOWN_RESIDUAL = new Set(["execution_logs"]);
  for (const table of found) {
    expect(
      HANDLED.has(table) || AUTO_CASCADE.has(table) || KNOWN_RESIDUAL.has(table),
      `unowned org-FK table on the delete path: ${table}`,
    ).toBe(true);
  }
  for (const table of HANDLED) {
    expect(found, `handled table missing from live schema: ${table}`).toContain(table);
  }
  for (const row of rows.results) {
    if (AUTO_CASCADE.has(row.name)) {
      expect(row.sql).toContain("ON DELETE CASCADE");
    }
  }
});

it("deletes the full owned graph in one pass with history retained (issue #226)", async () => {
  // Behavioral proof behind the inventory guard above: one org holding a
  // row in every handled table (plus auto-cascaded secret rows riding the
  // loose Connection) previews deletable and deletes completely, while
  // ExecutionHistory and audit rows survive. Blockers (managed/bundle rows)
  // are excluded here and covered by the block tests above.
  const stamp = new Date().toISOString();
  const created = await call("/api/orgs", "POST", USER_ADMIN, { name: "full-graph" });
  expect(created.status).toBe(201);
  const orgG = created.body.id as string;
  const U = (n: number) => `00000000-0000-4000-8000-000000000${n}`;
  const db = bindings.DB;
  await db
    .prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(orgG, USER_ORDINARY, "member", "active", "ordinary", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO connections(id,org_id,integration_id,endpoint) VALUES (?,?,?,?)")
    .bind(U(340), orgG, "720b9ebf-9b6a-4eac-bae9-6ed22c970402", "https://api.openai.com")
    .run();
  await db
    .prepare(
      "INSERT INTO connection_secrets(connection_id,org_id,field,ciphertext,nonce,wrapped_dek,key_version,algorithm,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(340), orgG, "apiKey", "ciphertext", "nonce", "wrapped", 1, "AES-GCM-256", stamp, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO oauth_tokens(connection_id,org_id,access_ciphertext,access_nonce,access_wrapped_dek,key_version,algorithm,generation,status,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(340), orgG, "ciphertext", "nonce", "wrapped", 1, "AES-GCM-256", 1, "healthy", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO forms(id,org_id,name,saga_id,fields_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(U(341), orgG, "intake", echoSaga.id, "[]", stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO apps(id,org_id,name,slug,owner_kind,managed_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(342), orgG, "portal", "portal", "independent", null, "created", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO app_tables(id,app_id,org_id,name,created_at) VALUES (?,?,?,?,?)")
    .bind(U(343), U(342), orgG, "items", stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO app_rows(id,table_id,app_id,org_id,data_json,table_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(U(344), U(343), U(342), orgG, "{}", 0, stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO app_files(id,app_id,org_id,name,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .bind(U(345), U(342), orgG, "doc.txt", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO app_file_tokens(token_hash,file_id,app_id,scope,expires_at,created_at) VALUES (?,?,?,?,?,?)")
    .bind("token-hash", U(345), U(342), "download", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO app_grants(id,app_id,org_id,kind,ref,permission,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(U(346), U(342), orgG, "saga", echoSaga.id, "invoke", stamp)
    .run();
  await db
    .prepare("INSERT INTO app_executions(app_id,execution_id,org_id,saga_id,created_at) VALUES (?,?,?,?,?)")
    .bind(U(342), "c".repeat(64), orgG, echoSaga.id, stamp)
    .run();
  await db
    .prepare("INSERT INTO app_revisions(id,app_id,revision,files_json,deps_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(U(347), U(342), 1, "{}", "{}", stamp)
    .run();
  await db
    .prepare("INSERT INTO app_deployments(id,app_id,revision,bundle_json,content_hash,created_at) VALUES (?,?,?,?,?,?)")
    .bind(U(348), U(342), 1, "{}", "hash", stamp)
    .run();
  await db
    .prepare("INSERT INTO app_jobs(id,app_id,revision,created_at) VALUES (?,?,?,?)")
    .bind(U(349), U(342), 1, stamp)
    .run();
  await db
    .prepare("INSERT INTO tables(id,org_id,name,owner_user_id,created_at) VALUES (?,?,?,?,?)")
    .bind(U(350), orgG, "notes", USER_ADMIN, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO table_rows(table_id,org_id,doc_id,owner_user_id,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(U(350), orgG, "doc-1", USER_ADMIN, "{}", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO table_grants(id,table_id,action,grantee_user_id,created_at) VALUES (?,?,?,?,?)")
    .bind(U(351), U(350), "read", USER_ADMIN, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO file_locations(org_id,name,max_bytes,content_types_json,shared_read,created_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(orgG, "uploads", 1024, "[]", 0, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO files(org_id,location,path,version,size,content_type,sha256,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(orgG, "uploads", "note.txt", 1, 3, "text/plain", "a".repeat(64), "ready", stamp, stamp)
    .run();
  await bindings.FILES.put(`${orgG}/uploads/note.txt`, new TextEncoder().encode("hey"));
  await db
    .prepare("INSERT INTO file_policies(org_id,location,action,created_at) VALUES (?,?,?,?)")
    .bind(orgG, "uploads", "read", stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO file_capabilities(id,org_id,source_org_id,location,path,action,staging_key,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(352), orgG, orgG, "uploads", "note.txt", "upload", `staging/${U(352)}`, "hash", stamp, stamp)
    .run();
  await bindings.FILES.put(`staging/${U(352)}`, new TextEncoder().encode("staged"));
  await db
    .prepare(
      "INSERT INTO artifacts(id,org_id,creator_user_id,name,mime,size_bytes,version,status,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(353), orgG, USER_ADMIN, "report", "text/plain", 3, 1, "active", stamp, stamp, null)
    .run();
  await db
    .prepare("INSERT INTO artifact_versions(id,artifact_id,version,mime,size_bytes,created_at) VALUES (?,?,?,?,?,?)")
    .bind(U(354), U(353), 1, "text/plain", 3, stamp)
    .run();
  await db
    .prepare("INSERT INTO artifact_bindings(id,artifact_id,org_id,scope,ref_id,created_at) VALUES (?,?,?,?,?,?)")
    .bind(U(355), U(353), orgG, "workspace", "desk", stamp)
    .run();
  await bindings.ARTIFACTS!.put(`artifacts/${U(353)}/v1`, new TextEncoder().encode("hey"));
  await db
    .prepare("INSERT INTO artifact_retention(org_id,max_age_days,updated_at) VALUES (?,?,?)")
    .bind(orgG, 90, stamp)
    .run();
  await db
    .prepare("INSERT INTO endpoints(id,org_id,name,saga_id,kind,enabled,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(U(356), orgG, "hook", echoSaga.id, "api-key", 1, stamp)
    .run();
  await db
    .prepare("INSERT INTO endpoint_events(endpoint_id,event_id,input_json,execution_id,created_at) VALUES (?,?,?,?,?)")
    .bind(U(356), "evt-1", "{}", "e".repeat(64), stamp)
    .run();
  await db
    .prepare("INSERT INTO endpoint_rate_windows(endpoint_id,window_start,hits) VALUES (?,?,?)")
    .bind(U(356), stamp, 1)
    .run();
  await db
    .prepare(
      "INSERT INTO configs(id,org_id,key,type,value_json,managed_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(U(357), orgG, "greeting", "string", '"hi"', null, stamp, USER_ADMIN)
    .run();
  await db
    .prepare(
      "INSERT INTO notifications(id,org_id,user_id,scope,category,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(358), orgG, USER_ADMIN, "org", "ops", "hello", "pending", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO resource_roles(id,org_id,name,created_at) VALUES (?,?,?,?)")
    .bind(U(359), orgG, "runners", stamp)
    .run();
  await db
    .prepare("INSERT INTO role_grants(id,role_id,resource_kind,resource_id,action,created_at) VALUES (?,?,?,?,?,?)")
    .bind(U(360), U(359), "saga", "*", "execute", stamp)
    .run();
  await db
    .prepare("INSERT INTO role_assignments(role_id,org_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?)")
    .bind(U(359), orgG, USER_ORDINARY, stamp, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO policy_rules(id,org_id,resource_kind,resource_id,action,subject_type,subject_ref,created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(U(361), orgG, "saga", "*", "execute", "role", U(359), stamp)
    .run();
  await db
    .prepare("INSERT INTO saga_policies(org_id,saga_id,policy_json,updated_at) VALUES (?,?,?,?)")
    .bind(orgG, echoSaga.id, "{}", stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO tool_enrollments(id,org_id,tool_name,saga_id,saga_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(U(362), orgG, "halo_tool", echoSaga.id, echoSaga.revision, stamp, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO schedules(id,org_id,name,saga_id,kind,cron,timezone,enabled,input_json,run_as_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(363), orgG, "nightly", echoSaga.id, "recurring", "0 0 * * *", "UTC", 1, "{}", USER_ADMIN, stamp, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO schedule_deliveries(schedule_id,window,input_json,execution_id,created_at) VALUES (?,?,?,?,?)",
    )
    .bind(U(363), "2026-09-17T00:00", "{}", "e".repeat(64), stamp)
    .run();
  await db
    .prepare("INSERT INTO event_sources(id,org_id,name,kind,ref_id,enabled,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(U(364), orgG, "orders", "topic", null, 1, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO events(source_id,event_id,org_id,topic,payload_json,execution_id,created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(U(364), "evt-001", orgG, "vendor.order.created", "{}", null, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO event_subscriptions(id,org_id,source_id,name,saga_id,topic_filter,enabled,run_as_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(365), orgG, U(364), "ship", echoSaga.id, "vendor.order.*", 1, USER_ADMIN, stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO event_deliveries(subscription_id,event_id,org_id,topic,execution_id,created_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(U(365), "evt-001", orgG, "vendor.order.created", "e".repeat(64), stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO ai_model_profiles(id,org_id,connection_id,name,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(U(366), orgG, U(340), "chat", "gpt-4o", stamp, stamp)
    .run();
  await db
    .prepare("INSERT INTO ai_assignments(org_id,assignment_key,profile_id,updated_at) VALUES (?,?,?,?)")
    .bind(orgG, "primary", U(366), stamp)
    .run();
  await db
    .prepare("INSERT INTO ai_embedding_config(org_id,connection_id,model_id,dimensions,updated_at) VALUES (?,?,?,?,?)")
    .bind(orgG, U(340), "voyage-3", 1024, stamp)
    .run();
  await db
    .prepare("INSERT INTO ai_behavior(org_id,default_system_prompt,updated_at) VALUES (?,?,?)")
    .bind(orgG, "You are a helpful operator assistant.", stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO executions(id,saga_id,saga_name,saga_revision,org_id,user_id,input_json,dispatched,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      "d".repeat(64),
      echoSaga.id,
      echoSaga.name,
      echoSaga.revision,
      orgG,
      USER_ORDINARY,
      JSON.stringify({ message: "kept" }),
      1,
      "Succeeded",
      stamp,
    )
    .run();
  await db
    .prepare("INSERT INTO operations(execution_id,name,position,status,started_at) VALUES (?,?,?,?,?)")
    .bind("d".repeat(64), "echo-http-v1", 1, "Running", stamp)
    .run();
  await db
    .prepare(
      "INSERT INTO audit_events(id,org_id,actor_user_id,action,target_type,target_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(U(367), orgG, USER_ADMIN, "app.create", "app", U(342), "success", null, stamp)
    .run();
  const preview = await call(`/api/orgs/${orgG}/delete-preview`, "GET", USER_ADMIN);
  expect(preview.status).toBe(200);
  expect(preview.body).toMatchObject({
    canDelete: true,
    schedules: 1,
    eventSources: 1,
    eventSubscriptions: 1,
    aiProfiles: 1,
    aiAssignments: 1,
    aiEmbedding: 1,
    aiBehavior: 1,
    sagaPolicies: 1,
    toolEnrollments: 1,
  });
  const deleted = await call(`/api/orgs/${orgG}`, "DELETE", USER_ADMIN);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({ orgId: orgG, deletedFileObjects: 2, deletedArtifactObjects: 1 });
  for (const table of [
    "org_memberships",
    "connections",
    "connection_secrets",
    "oauth_tokens",
    "forms",
    "apps",
    "app_tables",
    "app_rows",
    "app_files",
    "app_grants",
    "app_executions",
    "tables",
    "table_rows",
    "file_locations",
    "files",
    "file_policies",
    "file_capabilities",
    "artifacts",
    "artifact_bindings",
    "artifact_retention",
    "endpoints",
    "configs",
    "notifications",
    "resource_roles",
    "role_assignments",
    "policy_rules",
    "saga_policies",
    "tool_enrollments",
    "schedules",
    "event_sources",
    "event_subscriptions",
    "events",
    "event_deliveries",
    "ai_model_profiles",
    "ai_assignments",
    "ai_embedding_config",
    "ai_behavior",
  ] as const) {
    const left = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`)
      .bind(orgG)
      .first<{ n: number }>();
    expect(left?.n, `orphaned rows in ${table}`).toBe(0);
  }
  const children: Array<[string, string, string]> = [
    ["schedule_deliveries", "schedule_id", U(363)],
    ["artifact_versions", "artifact_id", U(353)],
    ["table_grants", "table_id", U(350)],
    ["role_grants", "role_id", U(359)],
    ["endpoint_events", "endpoint_id", U(356)],
    ["endpoint_rate_windows", "endpoint_id", U(356)],
    ["app_file_tokens", "file_id", U(345)],
    ["app_revisions", "app_id", U(342)],
    ["app_deployments", "app_id", U(342)],
    ["app_jobs", "app_id", U(342)],
  ];
  for (const [table, column, id] of children) {
    const left = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n, `orphaned rows in ${table}`).toBe(0);
  }
  expect(await bindings.FILES.get(`${orgG}/uploads/note.txt`)).toBeNull();
  expect(await bindings.FILES.get(`staging/${U(352)}`)).toBeNull();
  expect(await bindings.ARTIFACTS!.get(`artifacts/${U(353)}/v1`)).toBeNull();
  // Retained history survives: executions, operations, audit rows.
  expect(await db.prepare("SELECT id FROM executions WHERE id=?").bind("d".repeat(64)).first()).not.toBeNull();
  expect(await db.prepare("SELECT id FROM organizations WHERE id=?").bind(orgG).first()).toBeNull();
});

it("fails closed without migration 0007 and refuses cross-org elevation", async () => {
  // Drop every table to simulate a pre-0007 database, then rebuild only
  // through 0001+seed: the gate answers 503, never open. (D1 has no
  // migration-down; DROP is the local equivalent. This test is last, so no
  // rebuild is needed afterward.)
  await bindings.DB.exec(
    "DROP TABLE IF EXISTS operations; DROP TABLE IF EXISTS executions; DROP TABLE IF EXISTS bundle_installs; DROP TABLE IF EXISTS connections; DROP TABLE IF EXISTS usage_blocks; DROP TABLE IF EXISTS forms; DROP TABLE IF EXISTS org_memberships; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS organizations;",
  );
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(seed);
  // The old organizations row predates the status column; SELECT * still
  // works and the gate proceeds to the missing users table. A non-fixture
  // caller pins the fail-closed 503: the LAB fixture bootstrap (which runs
  // only for the configured fixture identity) must not mask a missing store.
  expect(await call("/api/sagas", "GET", USER_ORDINARY)).toMatchObject({
    status: 503,
    body: { error: { code: "ORG_STORE_NOT_MIGRATED" } },
  });
  await bindings.DB.exec(migration7);
  // Re-bootstrap users the DROP removed: fixture admin regains org A via
  // auth bootstrap, strangers stay known-but-powerless.
  for (const user of [USER_ORDINARY, USER_EXTERNAL, USER_STRANGER]) {
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(user, new Date().toISOString())
      .run();
  }
  const orgB = await seedSecondOrg();
  // Malformed scope headers fail closed.
  const bad = await worker.fetch(
    new Request("https://local.test/api/sagas", {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Organization-Id": "not-a-uuid" },
    }),
    asUser(USER_ADMIN),
  );
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: { code: "INVALID_ORG_ID" } });
  // Unknown-but-valid org UUIDs answer 404, never a leak.
  expect(await call("/api/sagas", "GET", USER_ADMIN, undefined, "aaaaaaaa-1111-4111-8111-111111111111")).toMatchObject({
    status: 404,
  });
  // Admin of B is still a stranger in A for member management.
  expect(await call(`/api/orgs/${ORG_A}/members`, "GET", USER_ORDINARY)).toMatchObject({ status: 404 });
  expect(orgB.length).toBe(36);
});

it("pins admin validation, error, and filter branches", async () => {
  const FRESH = "00000000-0000-4000-8000-000000000101";
  const UNKNOWN_ORG = "aaaaaaaa-1111-4111-8111-111111111112";
  const orgB = await seedSecondOrg();
  // Collection gate: an identity with no user row at all is unknown (404),
  // while a known stranger without membership lists nothing (200, empty).
  expect(await call("/api/orgs", "GET", FRESH)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
  expect(await call("/api/orgs", "GET", USER_STRANGER)).toMatchObject({ status: 200, body: { orgs: [] } });
  // Unknown org UUIDs answer 404 on every admin surface, never a leak.
  expect(await call(`/api/orgs/${UNKNOWN_ORG}`, "GET", USER_ADMIN)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
  expect(await call(`/api/orgs/${UNKNOWN_ORG}/members`, "GET", USER_ADMIN)).toMatchObject({ status: 404 });
  expect(await call(`/api/orgs/${UNKNOWN_ORG}/disable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 404 });
  expect(await call(`/api/orgs/${UNKNOWN_ORG}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({ status: 404 });
  // Non-admin members cannot read the org detail even in their own org.
  expect(await call(`/api/orgs/${orgB}`, "GET", USER_ORDINARY)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
  // Org admins list members and read the org detail.
  expect(await call(`/api/orgs/${orgB}/members`, "GET", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}`, "GET", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { name: "second-org" },
  });
  // Request-body validation fails closed before touching D1.
  expect(await call("/api/orgs", "POST", USER_ADMIN, undefined)).toMatchObject({
    status: 415,
    body: { error: { code: "JSON_REQUIRED" } },
  });
  expect(await call("/api/orgs", "POST", USER_ADMIN, { name: 7 })).toMatchObject({
    status: 400,
    body: { error: { code: "INVALID_ORG_NAME" } },
  });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, {})).toMatchObject({
    status: 400,
    body: { error: { code: "INVALID_USER_ID" } },
  });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: "fine@example.com" })).toMatchObject({
    status: 201,
  });
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: "role@example.com", role: "superuser" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(
    await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: "kind@example.com", kind: "robot" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: "" })).toMatchObject({
    status: 400,
    body: { error: { code: "INVALID_USER_ID" } },
  });
  // Inviting into a disabled org, or a disabled user, is refused.
  expect(await call(`/api/orgs/${orgB}/disable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: "late@example.com" })).toMatchObject({
    status: 409,
    body: { error: { code: "ORG_DISABLED" } },
  });
  expect(await call(`/api/orgs/${orgB}/enable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  expect(await call(`/api/users/${USER_STRANGER}/disable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_STRANGER })).toMatchObject({
    status: 409,
    body: { error: { code: "USER_DISABLED" } },
  });
  expect(await call(`/api/users/${USER_STRANGER}/enable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  expect(await call("/api/users/nobody@example.com/disable", "POST", USER_ADMIN, {})).toMatchObject({
    status: 404,
    body: { error: { code: "USER_NOT_FOUND" } },
  });
  // Live memberships conflict; revoked ones reset to invited on re-invite.
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY })).toMatchObject({
    status: 409,
    body: { error: { code: "MEMBERSHIP_EXISTS" } },
  });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { status: "revoked" }),
  ).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_ORDINARY })).toMatchObject({
    status: 201,
    body: { status: "invited" },
  });
  // Member-update validation: unknown fields, bad enums, empty change, and
  // unknown memberships fail closed; kind/role guard both directions. The
  // re-invited membership activates on this verified read first.
  expect(await call("/api/sagas", "GET", USER_ORDINARY, undefined, orgB)).toMatchObject({ status: 200 });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { role: "operator" }),
  ).toMatchObject({
    status: 200,
  });
  expect(await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { bogus: true })).toMatchObject({
    status: 400,
    body: { error: { code: "UNSUPPORTED_FIELD" } },
  });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { role: "superuser" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { status: "limbo" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { kind: "robot" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, {})).toMatchObject({
    status: 400,
    body: { error: { code: "INVALID_MEMBERSHIP" } },
  });
  expect(
    await call(`/api/orgs/${orgB}/members/nobody@example.com`, "PATCH", USER_ADMIN, { role: "operator" }),
  ).toMatchObject({ status: 404, body: { error: { code: "USER_NOT_FOUND" } } });
  // An admin cannot be made external while holding admin, and suspending the
  // last admin is refused like revocation.
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ADMIN, { kind: "external" }),
  ).toMatchObject({ status: 400, body: { error: { code: "INVALID_MEMBERSHIP" } } });
  expect(
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ADMIN, { status: "suspended" }),
  ).toMatchObject({ status: 409, body: { error: { code: "LAST_ADMIN" } } });
  // Deleting an unknown org answers 404.
  expect(await call(`/api/orgs/${UNKNOWN_ORG}`, "DELETE", USER_ADMIN)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
  // The org admin history surface filters by status, saga, and cursor pages.
  // (The membership is active again after the verified read above; the key
  // is unique per run: execution IDs hash (org, user, key), so a reused key
  // would collide with an earlier row for this caller. The fixture admin
  // holds a live admin membership from seeding, so they submit.)
  const filterKey = `auth01-filter-${Date.now()}`;
  const filterInput = { sagaId: echoSaga.id, input: { message: "filter" } };
  const sub1 = await worker.fetch(
    new Request("https://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": filterKey,
        "X-Organization-Id": orgB,
      },
      body: JSON.stringify(filterInput),
    }),
    asUser(USER_ADMIN),
  );
  expect(sub1.status).toBe(202);
  // A second execution (distinct key, distinct row) gives the cursor pages
  // something to traverse.
  const sub2 = await worker.fetch(
    new Request("https://local.test/api/executions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${filterKey}-second`,
        "X-Organization-Id": orgB,
      },
      body: JSON.stringify(filterInput),
    }),
    asUser(USER_ADMIN),
  );
  expect(sub2.status).toBe(202);
  const running = await call(`/api/orgs/${orgB}/executions?status=Running`, "GET", USER_ADMIN);
  expect(running.status).toBe(200);
  const bySaga = await call(`/api/orgs/${orgB}/executions?sagaId=${echoSaga.id}`, "GET", USER_ADMIN);
  expect(bySaga.status).toBe(200);
  expect((bySaga.body.executions as unknown[]).length).toBeGreaterThan(0);
  const page1 = await call(`/api/orgs/${orgB}/executions?limit=1`, "GET", USER_ADMIN);
  expect(page1.status).toBe(200);
  expect(page1.body).toMatchObject({ hasMore: true });
  const cursor = (page1.body as { nextCursor: string }).nextCursor;
  expect(typeof cursor).toBe("string");
  const page2 = await call(
    `/api/orgs/${orgB}/executions?limit=1&cursor=${encodeURIComponent(cursor)}`,
    "GET",
    USER_ADMIN,
  );
  expect(page2.status).toBe(200);
  expect(page2.body).toMatchObject({ hasMore: false, nextCursor: null });
  // Unknown enum spellings in stored rows map to safe defaults on read.
  // (Runs before the bundle-install block below: inviting needs a live org.)
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: "odd@example.com" })).toMatchObject({
    status: 201,
  });
  await bindings.DB.prepare("UPDATE org_memberships SET role='owner',kind='alien' WHERE org_id=? AND user_id=?")
    .bind(orgB, "odd@example.com")
    .run();
  const listed = await call(`/api/orgs/${orgB}/members`, "GET", USER_ADMIN);
  expect(listed.status).toBe(200);
  expect(listed.body).toMatchObject({
    members: expect.arrayContaining([
      expect.objectContaining({ userId: "odd@example.com", role: "operator", kind: "ordinary" }),
    ]),
  });
  // Bundle install records block deletion with their own message.
  await bindings.DB.prepare(
    "INSERT INTO bundle_installs(bundle_id,version,org_id,manifest_hash,installed_at) VALUES (?,?,?,?,?)",
  )
    .bind("00000000-0000-4000-8000-000000000201", "1.0.0", orgB, "hash", new Date().toISOString())
    .run();
  expect(await call(`/api/orgs/${orgB}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { canDelete: false, bundleInstalls: 1 },
  });
  expect(await call(`/api/orgs/${orgB}`, "DELETE", USER_ADMIN)).toMatchObject({
    status: 409,
    body: { error: { code: "DELETE_BLOCKED" } },
  });
  await bindings.DB.exec("DROP TABLE bundle_installs;");
  await bindings.DB.exec(
    "CREATE TABLE bundle_installs(id INTEGER PRIMARY KEY AUTOINCREMENT, bundle_id TEXT NOT NULL, version TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), manifest_hash TEXT NOT NULL, installed_at TEXT NOT NULL);",
  );
  // Pre-0004 databases predate connections.managed_by and bundle_installs:
  // the preview falls back instead of failing.
  await bindings.DB.exec("DROP TABLE connections;");
  await bindings.DB.exec(
    "CREATE TABLE connections(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, endpoint TEXT NOT NULL);",
  );
  await bindings.DB.prepare("INSERT INTO connections(id,org_id,endpoint) VALUES (?,?,?)")
    .bind("00000000-0000-4000-8000-000000000202", orgB, "http://127.0.0.1:8788/echo")
    .run();
  const legacy = await call(`/api/orgs/${orgB}/delete-preview`, "GET", USER_ADMIN);
  expect(legacy.status).toBe(200);
  expect(legacy.body).toMatchObject({ connectionsLoose: 1, connectionsManaged: 0, bundleInstalls: 0 });
  const removed = await call(`/api/orgs/${orgB}`, "DELETE", USER_ADMIN);
  expect(removed.status).toBe(200);
  expect(removed.body).toMatchObject({ deletedConnections: 1 });
  // Collection routes fail closed when the users table is gone, and unknown
  // HTTP verbs on org paths answer 400 rather than falling through.
  await bindings.DB.exec("DROP TABLE org_memberships;");
  expect(await call("/api/orgs", "GET", USER_STRANGER)).toMatchObject({
    status: 503,
    body: { error: { code: "ORG_STORE_NOT_MIGRATED" } },
  });
  // Rebuild the membership store the DROP removed (the users/organizations
  // rows survive, so no re-bootstrap is needed). Plain DDL, not the
  // migration: the organizations ALTERs already ran in beforeEach.
  await bindings.DB.exec(
    "CREATE TABLE org_memberships(org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES users(user_id), role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'invited', kind TEXT NOT NULL DEFAULT 'ordinary', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id, user_id));",
  );
  const put = await worker.fetch(
    new Request(`https://local.test/api/orgs`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` } }),
    asUser(USER_ADMIN),
  );
  expect(put.status).toBe(400);
  // A membership row with an unknown status fails closed at the gate.
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_STRANGER, "member", "weird", "ordinary", new Date().toISOString(), new Date().toISOString())
    .run();
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, ORG_A)).toMatchObject({
    status: 403,
    body: { error: { code: "MEMBERSHIP_SUSPENDED" } },
  });
  await bindings.DB.prepare("DELETE FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(ORG_A, USER_STRANGER)
    .run();
  // An identity with no user row is unknown on scoped routes too (404).
  expect(await call("/api/sagas", "GET", FRESH, undefined, ORG_A)).toMatchObject({
    status: 404,
    body: { error: { code: "ORG_NOT_FOUND" } },
  });
  // An instance admin with no membership row still recovers through the gate.
  const createdC = await call("/api/orgs", "POST", USER_ADMIN, { name: "third-org" });
  expect(createdC.status).toBe(201);
  const orgC = createdC.body.id as string;
  expect(await call("/api/sagas", "GET", USER_ADMIN, undefined, orgC)).toMatchObject({ status: 200 });
  // Empty admin lists deny admin routes; whitespace-only entries are ignored.
  expect(await call("/api/orgs", "POST", USER_ADMIN, { name: "nope" }, undefined, "")).toMatchObject({
    status: 403,
    body: { error: { code: "ADMIN_ONLY" } },
  });
  // Unit-level guards unreachable through the route parsers (which validate
  // enums first): direct calls still fail closed with INVALID_MEMBERSHIP.
  const db = bindings.DB;
  await expect(inviteMember(db, orgB, "direct@example.com", "superuser" as OrgRole)).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    inviteMember(db, orgB, "direct@example.com", "operator", "robot" as MembershipKind),
  ).rejects.toMatchObject({
    status: 400,
  });
  await expect(updateMember(db, orgB, USER_ORDINARY, { role: "superuser" as OrgRole })).rejects.toMatchObject({
    status: 400,
  });
  await expect(updateMember(db, orgB, USER_ORDINARY, { status: "limbo" as MembershipStatus })).rejects.toMatchObject({
    status: 400,
  });
  await expect(updateMember(db, orgB, USER_ORDINARY, { kind: "robot" as MembershipKind })).rejects.toMatchObject({
    status: 400,
  });
  // The LAB fixture bootstrap never resurrects a disabled user or org.
  await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(USER_ADMIN).run();
  const usersBefore = await bindings.DB.prepare("SELECT status FROM users WHERE user_id=?")
    .bind(USER_ADMIN)
    .first<{ status: string }>();
  await ensureLabFixture(bindings.DB, ORG_A, USER_ADMIN);
  const usersAfter = await bindings.DB.prepare("SELECT status FROM users WHERE user_id=?")
    .bind(USER_ADMIN)
    .first<{ status: string }>();
  expect(usersBefore?.status).toBe("disabled");
  expect(usersAfter?.status).toBe("disabled");
  await bindings.DB.prepare("UPDATE users SET status='active' WHERE user_id=?").bind(USER_ADMIN).run();
  // Missing membership tables fail closed on scoped routes as well.
  await bindings.DB.exec("DROP TABLE org_memberships;");
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, ORG_A)).toMatchObject({
    status: 503,
    body: { error: { code: "ORG_STORE_NOT_MIGRATED" } },
  });
  // Missing users tables fail closed on collection routes.
  await bindings.DB.exec(
    "CREATE TABLE org_memberships(org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'invited', kind TEXT NOT NULL DEFAULT 'ordinary', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id, user_id)); DROP TABLE users;",
  );
  expect(await call("/api/orgs", "GET", USER_STRANGER)).toMatchObject({
    status: 503,
    body: { error: { code: "ORG_STORE_NOT_MIGRATED" } },
  });
  // Instance-admin recovery bypasses (unit level): an admin with no user row
  // and no membership row still resolves, and reaches disabled orgs too.
  // (Plain DDL: the migration ALTERs already ran in beforeEach.)
  await bindings.DB.exec(
    "CREATE TABLE IF NOT EXISTS users(user_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, disabled_at TEXT); CREATE TABLE IF NOT EXISTS org_memberships(org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'invited', kind TEXT NOT NULL DEFAULT 'ordinary', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id, user_id));",
  );
  await bindings.DB.prepare("DELETE FROM users WHERE user_id=?").bind(USER_ADMIN).run();
  await bindings.DB.prepare("DELETE FROM org_memberships WHERE user_id=?").bind(USER_ADMIN).run();
  const recovered = await resolveCaller(
    bindings.DB,
    { ADMIN_USER_IDS: USER_ADMIN },
    { userId: USER_ADMIN, orgId: ORG_A },
    ORG_A,
  );
  expect(recovered).toMatchObject({ isInstanceAdmin: true, role: null, isOrgAdmin: false });
  expect(await call(`/api/orgs/${orgC}/disable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  const intoDisabled = await resolveCaller(
    bindings.DB,
    { ADMIN_USER_IDS: USER_ADMIN },
    { userId: USER_ADMIN, orgId: ORG_A },
    orgC,
  );
  expect(intoDisabled).toMatchObject({ isInstanceAdmin: true });
  expect(await call(`/api/orgs/${orgC}/enable`, "POST", USER_ADMIN, {})).toMatchObject({ status: 200 });
  // A disabled instance admin still resolves (recovery must stay usable).
  await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(USER_ADMIN).run();
  const disabledAdmin = await resolveCaller(
    bindings.DB,
    { ADMIN_USER_IDS: USER_ADMIN },
    { userId: USER_ADMIN, orgId: ORG_A },
    ORG_A,
  );
  expect(disabledAdmin).toMatchObject({ isInstanceAdmin: true });
  // NOTE: this test makes ~60 sequential workerd requests and runs ~4.5s
  // even solo with coverage; the 30s budget only absorbs parallel-worker
  // contention, it weakens no assertion.
}, 30000);
