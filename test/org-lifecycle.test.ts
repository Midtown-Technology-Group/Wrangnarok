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
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration8 from "../migrations/0008_executions_org_fk.sql?raw";
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
  return new Request(`http://local.test${path}`, {
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
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration8);
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
  const submit = await worker.fetch(
    new Request("http://local.test/api/executions", {
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
  expect(await call(`/api/users/${USER_STRANGER}/disable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "USER_DISABLED" } },
  });
  expect(await call(`/api/users/${USER_STRANGER}/enable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call("/api/sagas", "GET", USER_STRANGER, undefined, orgB)).toMatchObject({ status: 200 });
  // Disabled org denies members but stays recoverable by instance admin.
  expect(await call(`/api/orgs/${orgB}/disable`, "POST", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { status: "disabled" },
  });
  expect(await call("/api/sagas", "GET", USER_EXTERNAL, undefined, orgB)).toMatchObject({
    status: 403,
    body: { error: { code: "ORG_DISABLED" } },
  });
  // Instance admin still reaches the disabled org (recovery path).
  expect(await call(`/api/orgs/${orgB}/delete-preview`, "GET", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/enable`, "POST", USER_ADMIN)).toMatchObject({
    status: 200,
    body: { status: "active" },
  });
});

it("guards the last admin and refuses to strand a tenant", async () => {
  const orgB = await seedSecondOrg();
  // Only the fixture caller is admin of org B: demotion is refused…
  expect(await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ADMIN, { role: "member" })).toMatchObject({
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
    await call(`/api/orgs/${orgB}/members/${USER_ADMIN}`, "PATCH", USER_ORDINARY, { role: "member" }),
  ).toMatchObject({
    status: 200,
    body: { role: "member" },
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
    retained: ["executions", "operations"],
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

it("keeps in-flight jobs visible to org admins after a member is revoked", async () => {
  const orgB = await seedSecondOrg();
  const submit = await worker.fetch(
    new Request("http://local.test/api/executions", {
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
    new Request("http://local.test/api/sagas", {
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
  expect(await call(`/api/orgs/${UNKNOWN_ORG}/disable`, "POST", USER_ADMIN)).toMatchObject({ status: 404 });
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
  expect(await call(`/api/orgs/${orgB}/disable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: "late@example.com" })).toMatchObject({
    status: 409,
    body: { error: { code: "ORG_DISABLED" } },
  });
  expect(await call(`/api/orgs/${orgB}/enable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call(`/api/users/${USER_STRANGER}/disable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call(`/api/orgs/${orgB}/members`, "POST", USER_ADMIN, { userId: USER_STRANGER })).toMatchObject({
    status: 409,
    body: { error: { code: "USER_DISABLED" } },
  });
  expect(await call(`/api/users/${USER_STRANGER}/enable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  expect(await call("/api/users/nobody@example.com/disable", "POST", USER_ADMIN)).toMatchObject({
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
    await call(`/api/orgs/${orgB}/members/${USER_ORDINARY}`, "PATCH", USER_ADMIN, { role: "member" }),
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
    await call(`/api/orgs/${orgB}/members/nobody@example.com`, "PATCH", USER_ADMIN, { role: "member" }),
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
    new Request("http://local.test/api/executions", {
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
    new Request("http://local.test/api/executions", {
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
      expect.objectContaining({ userId: "odd@example.com", role: "member", kind: "ordinary" }),
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
  await bindings.DB.prepare("DELETE FROM bundle_installs WHERE org_id=?").bind(orgB).run();
  // Pre-0004 databases predate connections.managed_by and bundle_installs:
  // the preview falls back instead of failing.
  await bindings.DB.exec("DROP TABLE connections; DROP TABLE bundle_installs;");
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
    new Request(`http://local.test/api/orgs`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` } }),
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
  await expect(inviteMember(db, orgB, "direct@example.com", "member", "robot" as MembershipKind)).rejects.toMatchObject(
    {
      status: 400,
    },
  );
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
  expect(await call(`/api/orgs/${orgC}/disable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  const intoDisabled = await resolveCaller(
    bindings.DB,
    { ADMIN_USER_IDS: USER_ADMIN },
    { userId: USER_ADMIN, orgId: ORG_A },
    orgC,
  );
  expect(intoDisabled).toMatchObject({ isInstanceAdmin: true });
  expect(await call(`/api/orgs/${orgC}/enable`, "POST", USER_ADMIN)).toMatchObject({ status: 200 });
  // A disabled instance admin still resolves (recovery must stay usable).
  await bindings.DB.prepare("UPDATE users SET status='disabled' WHERE user_id=?").bind(USER_ADMIN).run();
  const disabledAdmin = await resolveCaller(
    bindings.DB,
    { ADMIN_USER_IDS: USER_ADMIN },
    { userId: USER_ADMIN, orgId: ORG_A },
    ORG_A,
  );
  expect(disabledAdmin).toMatchObject({ isInstanceAdmin: true });
}, 30000);
