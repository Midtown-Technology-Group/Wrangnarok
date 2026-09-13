// SPDX-License-Identifier: AGPL-3.0
// AUTH-02 (issue #143, ADR 018): unit pins for the resource-role control
// plane plus the route-level validation branches in src/index.ts. Direct
// domain calls against the real D1 binding (no HTTP overhead); route shapes
// go through the Worker like every other suite. Complements
// test/resource-roles.test.ts, which proves the end-to-end matrices.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Bindings } from "../src/bindings";
import { echoSaga, Fault, helloSaga } from "../src/domain";
import type { CallerCtx } from "../src/orgs";
import {
  addGrant,
  assignRole,
  can,
  canPrincipal,
  createPolicyRule,
  createRole,
  deletePolicyRule,
  deleteRole,
  ensureRoleTables,
  listAssignments,
  listGrants,
  listPolicyRules,
  listRoles,
  parseGrantTriple,
  parseRoleId,
  parseRoleName,
  parseRuleId,
  parseSubject,
  policyConsumers,
  removeGrant,
  requireGrant,
  revokeAll,
  revokeAssignment,
  roleConsumers,
} from "../src/roles";
import migration1 from "../migrations/0001_initial.sql?raw";
import migration2 from "../migrations/0002_cancelling.sql?raw";
import migration5 from "../migrations/0005_forms.sql?raw";
import migration6 from "../migrations/0006_apps.sql?raw";
import migration7 from "../migrations/0007_org_membership.sql?raw";
import migration9 from "../migrations/0013_resource_roles.sql?raw";
import seed from "../scripts/seed-local.sql?raw";

const bindings = env as unknown as Bindings;
const TOKEN = "a".repeat(64);
const ORG_A = "00000000-0000-4000-8000-000000000001";
const USER_ADMIN = "00000000-0000-4000-8000-000000000002";
const USER_ORDINARY = "00000000-0000-4000-8000-000000000003";
const USER_EXTERNAL = "00000000-0000-4000-8000-000000000004";
const APP_ID = "12345678-1234-4234-8234-123456789012";

function ctxFor(userId: string, admin = false): CallerCtx {
  return {
    principal: { userId, orgId: ORG_A },
    role: admin ? "admin" : "member",
    kind: userId === USER_EXTERNAL ? "external" : "ordinary",
    isInstanceAdmin: false,
    isOrgAdmin: admin,
  };
}

const ADMIN_CTX = ctxFor(USER_ADMIN, true);
const MEMBER_CTX = ctxFor(USER_ORDINARY);
const EXTERNAL_CTX = ctxFor(USER_EXTERNAL);
const INSTANCE_CTX: CallerCtx = {
  principal: { userId: "provider", orgId: ORG_A },
  role: null,
  kind: null,
  isInstanceAdmin: true,
  isOrgAdmin: false,
};

async function call(path: string, method: string, userId: string, body?: unknown, adminIds = USER_ADMIN) {
  const b = { ...bindings, LAB_USER_ID: userId, LAB_FIXTURE_USER_ID: USER_ADMIN, ADMIN_USER_IDS: adminIds };
  const res = await worker.fetch(
    new Request(`http://local.test${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    b,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await bindings.DB.exec(migration1);
  await bindings.DB.exec(migration2);
  await bindings.DB.exec(seed);
  await bindings.DB.exec(migration5);
  await bindings.DB.exec(migration6);
  await bindings.DB.exec(migration7);
  await bindings.DB.exec(migration9);
  const stamp = new Date().toISOString();
  for (const user of [USER_ORDINARY, USER_EXTERNAL]) {
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(user, stamp)
      .run();
  }
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_ORDINARY, "member", "active", "ordinary", stamp, stamp)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(ORG_A, USER_EXTERNAL, "member", "active", "external", stamp, stamp)
    .run();
});

afterEach(async () => {
  await reset();
});

describe("role parsers fail closed", () => {
  it("validates role names, ids, and rule ids", () => {
    expect(parseRoleName(" runners ")).toBe("runners");
    expect(() => parseRoleName("")).toThrowError(Fault);
    expect(() => parseRoleName(7)).toThrowError(Fault);
    expect(() => parseRoleName("x".repeat(65))).toThrowError(Fault);
    expect(parseRoleId(USER_ADMIN.toUpperCase())).toBe(USER_ADMIN);
    expect(() => parseRoleId("nope")).toThrowError(Fault);
    expect(() => parseRoleId(7)).toThrowError(Fault);
    expect(parseRuleId(USER_ADMIN)).toBe(USER_ADMIN);
    expect(() => parseRuleId("nope")).toThrowError(Fault);
    expect(() => parseRuleId(null)).toThrowError(Fault);
  });

  it("validates every grant triple shape", () => {
    expect(parseGrantTriple("saga", echoSaga.id, "execute")).toMatchObject({ resourceKind: "saga" });
    expect(parseGrantTriple("saga", "*", "execute").resourceId).toBe("*");
    expect(parseGrantTriple("form", "hello-greeting", "read")).toMatchObject({ action: "read" });
    expect(parseGrantTriple("form", "hello-greeting", "submit")).toMatchObject({ action: "submit" });
    expect(parseGrantTriple("app", APP_ID, "write")).toMatchObject({ action: "write" });
    expect(parseGrantTriple("app", APP_ID, "serve")).toMatchObject({ action: "serve" });
    expect(() => parseGrantTriple("table", "customers", "read")).toThrowError(Fault);
    expect(() => parseGrantTriple("file", "x", "read")).toThrowError(Fault);
    expect(() => parseGrantTriple("robot", "x", "read")).toThrowError(Fault);
    expect(() => parseGrantTriple(7, "x", "read")).toThrowError(Fault);
    expect(() => parseGrantTriple("saga", echoSaga.id, "serve")).toThrowError(Fault);
    expect(() => parseGrantTriple("saga", echoSaga.id, 7)).toThrowError(Fault);
    expect(() => parseGrantTriple("form", "form", "execute")).toThrowError(Fault);
    expect(() => parseGrantTriple("app", APP_ID, "execute")).toThrowError(Fault);
    expect(() => parseGrantTriple("saga", "", "execute")).toThrowError(Fault);
    expect(() => parseGrantTriple("saga", 7, "execute")).toThrowError(Fault);
    expect(() => parseGrantTriple("saga", "x".repeat(321), "execute")).toThrowError(Fault);
    expect(() => parseGrantTriple("saga", "not-a-uuid", "execute")).toThrowError(Fault);
    expect(() => parseGrantTriple("form", "Bad Name!", "read")).toThrowError(Fault);
    expect(() => parseGrantTriple("app", "not-a-uuid", "read")).toThrowError(Fault);
  });

  it("validates every rule subject shape", () => {
    expect(parseSubject("all", undefined)).toEqual({ subjectType: "all", subjectRef: "all" });
    expect(parseSubject("kind", "ordinary")).toEqual({ subjectType: "kind", subjectRef: "ordinary" });
    expect(parseSubject("kind", "external")).toEqual({ subjectType: "kind", subjectRef: "external" });
    expect(parseSubject("user", "Someone@Example.com ")).toEqual({
      subjectType: "user",
      subjectRef: "someone@example.com",
    });
    expect(() => parseSubject("robot", "x")).toThrowError(Fault);
    expect(() => parseSubject(7, "x")).toThrowError(Fault);
    expect(() => parseSubject("kind", "robot")).toThrowError(Fault);
    expect(() => parseSubject("user", "")).toThrowError(Fault);
    expect(() => parseSubject("user", "has space")).toThrowError(Fault);
    expect(() => parseSubject("user", 7)).toThrowError(Fault);
    expect(() => parseSubject("user", "x".repeat(321))).toThrowError(Fault);
  });
});

describe("role administration branches", () => {
  it("creates, duplicates, describes, lists, and deletes roles", async () => {
    const role = await createRole(bindings.DB, ORG_A, " runners ", "Runs things.");
    expect(role).toMatchObject({ orgId: ORG_A, name: "runners", description: "Runs things." });
    await expect(createRole(bindings.DB, ORG_A, "runners")).rejects.toMatchObject({ code: "ROLE_EXISTS" });
    await expect(createRole(bindings.DB, ORG_A, "other", "x".repeat(257))).rejects.toMatchObject({
      code: "INVALID_ROLE",
    });
    await expect(createRole(bindings.DB, ORG_A, "")).rejects.toMatchObject({ code: "INVALID_ROLE" });
    expect(await listRoles(bindings.DB, ORG_A)).toHaveLength(1);
    const deleted = await deleteRole(bindings.DB, ORG_A, role.id);
    expect(deleted).toMatchObject({ roleId: role.id, deletedGrants: 0, deletedAssignments: 0 });
    await expect(deleteRole(bindings.DB, ORG_A, role.id)).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
    await expect(deleteRole(bindings.DB, ORG_A, "nope")).rejects.toMatchObject({ code: "INVALID_ROLE" });
  });

  it("manages grants including duplicates and unknown ids", async () => {
    const role = await createRole(bindings.DB, ORG_A, "runners");
    const grant = await addGrant(bindings.DB, ORG_A, role.id, "saga", echoSaga.id, "execute");
    expect(grant).toMatchObject({ roleId: role.id, resourceKind: "saga" });
    await expect(addGrant(bindings.DB, ORG_A, role.id, "saga", echoSaga.id, "execute")).rejects.toMatchObject({
      code: "GRANT_EXISTS",
    });
    await expect(
      addGrant(bindings.DB, ORG_A, "aaaaaaaa-1111-4111-8111-111111111111", "saga", echoSaga.id, "execute"),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
    await expect(addGrant(bindings.DB, ORG_A, "nope", "saga", echoSaga.id, "execute")).rejects.toMatchObject({
      code: "INVALID_ROLE",
    });
    await expect(addGrant(bindings.DB, ORG_A, role.id, "table", "x", "read")).rejects.toMatchObject({
      code: "INVALID_GRANT",
    });
    expect(await listGrants(bindings.DB, ORG_A, role.id)).toHaveLength(1);
    await expect(listGrants(bindings.DB, ORG_A, "aaaaaaaa-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND",
    });
    await removeGrant(bindings.DB, ORG_A, role.id, grant.id);
    await expect(removeGrant(bindings.DB, ORG_A, role.id, grant.id)).rejects.toMatchObject({
      code: "GRANT_NOT_FOUND",
    });
    await expect(removeGrant(bindings.DB, ORG_A, role.id, "nope")).rejects.toMatchObject({ code: "INVALID_GRANT" });
    await expect(
      removeGrant(bindings.DB, ORG_A, "aaaaaaaa-1111-4111-8111-111111111111", grant.id),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("assigns, reactivates, refuses duplicates, and revokes", async () => {
    const role = await createRole(bindings.DB, ORG_A, "runners");
    const first = await assignRole(bindings.DB, ORG_A, role.id, USER_ORDINARY);
    expect(first).toMatchObject({ status: "active" });
    await expect(assignRole(bindings.DB, ORG_A, role.id, USER_ORDINARY)).rejects.toMatchObject({
      code: "ASSIGNMENT_EXISTS",
    });
    const revoked = await revokeAssignment(bindings.DB, ORG_A, role.id, USER_ORDINARY);
    expect(revoked).toMatchObject({ status: "revoked" });
    const revived = await assignRole(bindings.DB, ORG_A, role.id, USER_ORDINARY);
    expect(revived).toMatchObject({ status: "active" });
    await expect(revokeAssignment(bindings.DB, ORG_A, role.id, USER_EXTERNAL)).rejects.toMatchObject({
      code: "ASSIGNMENT_NOT_FOUND",
    });
    await expect(assignRole(bindings.DB, ORG_A, role.id, "ghost@example.com")).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
    await expect(assignRole(bindings.DB, ORG_A, role.id, "")).rejects.toMatchObject({ code: "INVALID_USER_ID" });
    await expect(
      assignRole(bindings.DB, ORG_A, "aaaaaaaa-1111-4111-8111-111111111111", USER_ORDINARY),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
    await expect(revokeAssignment(bindings.DB, ORG_A, role.id, "")).rejects.toMatchObject({ code: "INVALID_USER_ID" });
    await expect(
      revokeAssignment(bindings.DB, ORG_A, "aaaaaaaa-1111-4111-8111-111111111111", USER_ORDINARY),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
    expect(await listAssignments(bindings.DB, ORG_A, role.id)).toHaveLength(1);
    await expect(listAssignments(bindings.DB, ORG_A, "aaaaaaaa-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND",
    });
  });

  it("bulk-revokes by user, by role, and refuses bad filters", async () => {
    const first = await createRole(bindings.DB, ORG_A, "first");
    const second = await createRole(bindings.DB, ORG_A, "second");
    await assignRole(bindings.DB, ORG_A, first.id, USER_ORDINARY);
    await assignRole(bindings.DB, ORG_A, second.id, USER_ORDINARY);
    await assignRole(bindings.DB, ORG_A, second.id, USER_EXTERNAL);
    expect(await revokeAll(bindings.DB, ORG_A, { userId: USER_ORDINARY })).toMatchObject({ revoked: 2 });
    expect(await revokeAll(bindings.DB, ORG_A, { roleId: second.id })).toMatchObject({ revoked: 1 });
    expect(await revokeAll(bindings.DB, ORG_A, { roleId: second.id })).toMatchObject({ revoked: 0 });
    await expect(revokeAll(bindings.DB, ORG_A, {})).rejects.toMatchObject({ code: "INVALID_REVOCATION" });
    await expect(revokeAll(bindings.DB, ORG_A, { userId: USER_ORDINARY, roleId: first.id })).rejects.toMatchObject({
      code: "INVALID_REVOCATION",
    });
    await expect(revokeAll(bindings.DB, ORG_A, { userId: "" })).rejects.toMatchObject({ code: "INVALID_USER_ID" });
    await expect(revokeAll(bindings.DB, ORG_A, { roleId: "nope" })).rejects.toMatchObject({ code: "INVALID_ROLE" });
    await expect(
      revokeAll(bindings.DB, ORG_A, { roleId: "aaaaaaaa-1111-4111-8111-111111111111" }),
    ).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
  });

  it("inspects role consumers and refuses unknown roles", async () => {
    const role = await createRole(bindings.DB, ORG_A, "runners");
    await addGrant(bindings.DB, ORG_A, role.id, "saga", echoSaga.id, "execute");
    await assignRole(bindings.DB, ORG_A, role.id, USER_ORDINARY);
    const seen = await roleConsumers(bindings.DB, ORG_A, role.id);
    expect(seen.role).toMatchObject({ name: "runners" });
    expect(seen.grants).toHaveLength(1);
    expect(seen.assignments).toMatchObject([{ userId: USER_ORDINARY, status: "active" }]);
    await expect(roleConsumers(bindings.DB, ORG_A, "aaaaaaaa-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND",
    });
    await expect(roleConsumers(bindings.DB, ORG_A, "nope")).rejects.toMatchObject({ code: "INVALID_ROLE" });
  });
});

describe("policy rule branches", () => {
  it("creates org and global rules with duplicate discipline", async () => {
    const orgRule = await createPolicyRule(bindings.DB, ORG_A, "saga", echoSaga.id, "execute", "user", USER_ORDINARY);
    expect(orgRule).toMatchObject({ orgId: ORG_A, subjectType: "user" });
    await expect(
      createPolicyRule(bindings.DB, ORG_A, "saga", echoSaga.id, "execute", "user", USER_ORDINARY),
    ).rejects.toMatchObject({ code: "RULE_EXISTS" });
    // Same tuple as a global rule is distinct, not a conflict.
    const global = await createPolicyRule(bindings.DB, null, "saga", echoSaga.id, "execute", "user", USER_ORDINARY);
    expect(global.orgId).toBeNull();
    await expect(
      createPolicyRule(bindings.DB, null, "saga", echoSaga.id, "execute", "user", USER_ORDINARY),
    ).rejects.toMatchObject({ code: "RULE_EXISTS" });
    await expect(createPolicyRule(bindings.DB, ORG_A, "table", "x", "read", "all", "all")).rejects.toMatchObject({
      code: "INVALID_GRANT",
    });
    await expect(
      createPolicyRule(bindings.DB, ORG_A, "saga", echoSaga.id, "execute", "kind", "robot"),
    ).rejects.toMatchObject({ code: "INVALID_SUBJECT" });
    // Org listing sees org + global rules; global listing sees globals only.
    expect((await listPolicyRules(bindings.DB, ORG_A)).length).toBe(2);
    expect((await listPolicyRules(bindings.DB, null)).length).toBe(1);
    await deletePolicyRule(bindings.DB, ORG_A, orgRule.id);
    // An org scope cannot delete a global rule and vice versa.
    await expect(deletePolicyRule(bindings.DB, ORG_A, global.id)).rejects.toMatchObject({ code: "RULE_NOT_FOUND" });
    await deletePolicyRule(bindings.DB, null, global.id);
    await expect(deletePolicyRule(bindings.DB, null, global.id)).rejects.toMatchObject({ code: "RULE_NOT_FOUND" });
    await expect(deletePolicyRule(bindings.DB, ORG_A, "nope")).rejects.toMatchObject({ code: "INVALID_RULE" });
  });

  it("inspects policy consumers across rules and role paths", async () => {
    await createPolicyRule(bindings.DB, ORG_A, "saga", echoSaga.id, "execute", "user", USER_ORDINARY);
    await createPolicyRule(bindings.DB, null, "saga", "*", "execute", "all", "all");
    const role = await createRole(bindings.DB, ORG_A, "runners");
    await addGrant(bindings.DB, ORG_A, role.id, "saga", echoSaga.id, "execute");
    await assignRole(bindings.DB, ORG_A, role.id, USER_EXTERNAL);
    const seen = await policyConsumers(bindings.DB, ORG_A, "saga", echoSaga.id, "execute");
    expect(seen.consumers.filter((entry) => entry.via === "rule")).toHaveLength(2);
    expect(seen.consumers.filter((entry) => entry.via === "role")).toHaveLength(1);
    // Revoked assignments stay visible with their status, like the role
    // consumer surface.
    await revokeAssignment(bindings.DB, ORG_A, role.id, USER_EXTERNAL);
    const after = await policyConsumers(bindings.DB, ORG_A, "saga", echoSaga.id, "execute");
    expect(
      after.consumers.filter((entry) => entry.via === "role" && entry.assignmentStatus === "revoked"),
    ).toHaveLength(1);
    await expect(policyConsumers(bindings.DB, ORG_A, "table", "x", "read")).rejects.toMatchObject({
      code: "INVALID_GRANT",
    });
  });
});

describe("grant evaluation branches", () => {
  it("resolves instance admin, org admin, rules, roles, and absence", async () => {
    const check = { orgId: ORG_A, resourceKind: "saga" as const, resourceId: echoSaga.id, action: "execute" as const };
    expect(await can(bindings.DB, INSTANCE_CTX, check)).toBe(true);
    expect(await can(bindings.DB, ADMIN_CTX, check)).toBe(true);
    expect(await can(bindings.DB, MEMBER_CTX, check)).toBe(false);
    await expect(requireGrant(bindings.DB, MEMBER_CTX, check)).rejects.toMatchObject({ code: "GRANT_REQUIRED" });
    await requireGrant(bindings.DB, ADMIN_CTX, check);
    // Org admin of ANOTHER org authorizes through the target membership.
    const otherOrg = "aaaaaaaa-1111-4111-8111-111111111111";
    const stamp = new Date().toISOString();
    await bindings.DB.prepare(
      "INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,'other','active',?,NULL)",
    )
      .bind(otherOrg, stamp)
      .run();
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind("other-admin", stamp)
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(otherOrg, "other-admin", "admin", "active", "ordinary", stamp, stamp)
      .run();
    const crossCtx: CallerCtx = {
      principal: { userId: "other-admin", orgId: otherOrg },
      role: "admin",
      kind: "ordinary",
      isInstanceAdmin: false,
      isOrgAdmin: true,
    };
    // Same-org admin flag alone is not enough for a foreign org; the direct
    // target membership grants it.
    expect(await can(bindings.DB, crossCtx, { ...check, orgId: otherOrg })).toBe(true);
    expect(await can(bindings.DB, MEMBER_CTX, { ...check, orgId: otherOrg })).toBe(false);
    // A live but non-admin membership in the target org grants nothing by
    // itself: target found, status active, role not admin — all three arms.
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(otherOrg, USER_EXTERNAL, "member", "active", "external", stamp, stamp)
      .run();
    expect(await can(bindings.DB, EXTERNAL_CTX, { ...check, orgId: otherOrg })).toBe(false);
    // An admin membership in the target org authorizes even when the
    // caller's selected org says otherwise: the direct target row wins.
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(otherOrg, USER_ORDINARY, "admin", "active", "ordinary", stamp, stamp)
      .run();
    expect(await can(bindings.DB, MEMBER_CTX, { ...check, orgId: otherOrg })).toBe(true);
    // Kind rule reaches externals as a class; user rule reaches one caller.
    await createPolicyRule(bindings.DB, ORG_A, "saga", echoSaga.id, "execute", "kind", "external");
    expect(await can(bindings.DB, EXTERNAL_CTX, check)).toBe(true);
    expect(await can(bindings.DB, MEMBER_CTX, check)).toBe(false);
    await createPolicyRule(bindings.DB, ORG_A, "saga", echoSaga.id, "execute", "user", USER_ORDINARY);
    expect(await can(bindings.DB, MEMBER_CTX, check)).toBe(true);
    // Wildcard rule covers the exact resource.
    await createPolicyRule(bindings.DB, ORG_A, "saga", "*", "execute", "all", "all");
    expect(
      await can(bindings.DB, MEMBER_CTX, {
        orgId: ORG_A,
        resourceKind: "saga",
        resourceId: helloSaga.id,
        action: "execute",
      }),
    ).toBe(true);
  });

  it("evaluates the role path including wildcards and revoked rows", async () => {
    const check = { orgId: ORG_A, resourceKind: "saga" as const, resourceId: echoSaga.id, action: "execute" as const };
    const role = await createRole(bindings.DB, ORG_A, "runners");
    await addGrant(bindings.DB, ORG_A, role.id, "saga", "*", "execute");
    await assignRole(bindings.DB, ORG_A, role.id, USER_ORDINARY);
    expect(await can(bindings.DB, MEMBER_CTX, check)).toBe(true);
    await revokeAssignment(bindings.DB, ORG_A, role.id, USER_ORDINARY);
    expect(await can(bindings.DB, MEMBER_CTX, check)).toBe(false);
    // Revoked rows stay visible to inspection with their status.
    expect(await listAssignments(bindings.DB, ORG_A, role.id)).toMatchObject([
      { userId: USER_ORDINARY, status: "revoked" },
    ]);
  });

  it("resolves flat principals with membership fencing", async () => {
    const check = { orgId: ORG_A, resourceKind: "saga" as const, resourceId: echoSaga.id, action: "execute" as const };
    // No membership row, no authority — even for the fixture admin identity,
    // which holds no row in this file's hand-built setup.
    expect(await canPrincipal(bindings.DB, { userId: USER_ADMIN, orgId: ORG_A }, check)).toBe(false);
    expect(await canPrincipal(bindings.DB, { userId: USER_ORDINARY, orgId: ORG_A }, check)).toBe(false);
    expect(
      await canPrincipal(bindings.DB, { userId: "00000000-0000-4000-8000-000000000099", orgId: ORG_A }, check),
    ).toBe(false);
    // An active admin membership resolves; suspension fences it.
    await bindings.DB.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)")
      .bind(USER_ADMIN, new Date().toISOString())
      .run();
    await bindings.DB.prepare(
      "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(ORG_A, USER_ADMIN, "admin", "active", "ordinary", new Date().toISOString(), new Date().toISOString())
      .run();
    expect(await canPrincipal(bindings.DB, { userId: USER_ADMIN, orgId: ORG_A }, check)).toBe(true);
    await bindings.DB.prepare("UPDATE org_memberships SET status='suspended' WHERE org_id=? AND user_id=?")
      .bind(ORG_A, USER_ADMIN)
      .run();
    expect(await canPrincipal(bindings.DB, { userId: USER_ADMIN, orgId: ORG_A }, check)).toBe(false);
    await bindings.DB.prepare("UPDATE org_memberships SET status='suspended' WHERE org_id=? AND user_id=?")
      .bind(ORG_A, USER_ORDINARY)
      .run();
    expect(await canPrincipal(bindings.DB, { userId: USER_ORDINARY, orgId: ORG_A }, check)).toBe(false);
  });

  it("fails closed without migration 0013", async () => {
    await bindings.DB.exec(
      "DROP TABLE policy_rules; DROP TABLE role_assignments; DROP TABLE role_grants; DROP TABLE resource_roles;",
    );
    const check = {
      orgId: ORG_A,
      resourceKind: "saga" as const,
      resourceId: echoSaga.id,
      action: "execute" as const,
    };
    // Every store entry point maps the missing tables to 503 with the
    // migration code — never an open allow and never a driver leak.
    await expect(listRoles(bindings.DB, ORG_A)).rejects.toMatchObject({ code: "ROLE_STORE_NOT_MIGRATED" });
    await expect(createRole(bindings.DB, ORG_A, "x")).rejects.toMatchObject({ code: "ROLE_STORE_NOT_MIGRATED" });
    await expect(deleteRole(bindings.DB, ORG_A, USER_ADMIN)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(addGrant(bindings.DB, ORG_A, USER_ADMIN, "saga", echoSaga.id, "execute")).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(listGrants(bindings.DB, ORG_A, USER_ADMIN)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(removeGrant(bindings.DB, ORG_A, USER_ADMIN, USER_ADMIN)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(assignRole(bindings.DB, ORG_A, USER_ADMIN, USER_ORDINARY)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(revokeAssignment(bindings.DB, ORG_A, USER_ADMIN, USER_ORDINARY)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(listAssignments(bindings.DB, ORG_A, USER_ADMIN)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(revokeAll(bindings.DB, ORG_A, { userId: USER_ORDINARY })).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(roleConsumers(bindings.DB, ORG_A, USER_ADMIN)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(
      createPolicyRule(bindings.DB, ORG_A, "saga", echoSaga.id, "execute", "user", USER_ORDINARY),
    ).rejects.toMatchObject({ code: "ROLE_STORE_NOT_MIGRATED" });
    await expect(listPolicyRules(bindings.DB, ORG_A)).rejects.toMatchObject({ code: "ROLE_STORE_NOT_MIGRATED" });
    await expect(deletePolicyRule(bindings.DB, ORG_A, USER_ADMIN)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(policyConsumers(bindings.DB, ORG_A, "saga", echoSaga.id, "execute")).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    await expect(can(bindings.DB, MEMBER_CTX, check)).rejects.toMatchObject({ code: "ROLE_STORE_NOT_MIGRATED" });
    await expect(canPrincipal(bindings.DB, { userId: USER_ORDINARY, orgId: ORG_A }, check)).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
    // Bootstrap recreates the tables (same standing pattern as orgs.ts).
    await ensureRoleTables(bindings.DB);
    expect(await listRoles(bindings.DB, ORG_A)).toHaveLength(0);
  });

  it("rethrows unexpected store failures instead of masking them", async () => {
    // Unknown org UUID: the INSERT violates the organizations foreign key —
    // a genuine store failure, not a duplicate, not a missing table. Routes
    // can never reach this (requireManageOrg gates the org first); the unit
    // pin proves the shared mapper does not invent a 409 for it.
    await expect(
      createPolicyRule(
        bindings.DB,
        "aaaaaaaa-1111-4111-8111-111111111111",
        "saga",
        echoSaga.id,
        "execute",
        "user",
        USER_ORDINARY,
      ),
    ).rejects.toThrow();
  });

  it("maps a missing grants table on the grant write path", async () => {
    const role = await createRole(bindings.DB, ORG_A, "runners");
    await bindings.DB.exec("DROP TABLE role_grants;");
    // The role row still resolves; only the grant INSERT fails closed.
    await expect(addGrant(bindings.DB, ORG_A, role.id, "saga", echoSaga.id, "execute")).rejects.toMatchObject({
      code: "ROLE_STORE_NOT_MIGRATED",
    });
  });
});

describe("role route validation branches", () => {
  it("rejects malformed role, grant, assignment, and revoke bodies", async () => {
    expect(await call(`/api/orgs/${ORG_A}/roles`, "POST", USER_ADMIN, {})).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_ROLE" } },
    });
    expect(await call(`/api/orgs/${ORG_A}/roles`, "POST", USER_ADMIN, { name: "x", bogus: 1 })).toMatchObject({
      status: 400,
      body: { error: { code: "UNSUPPORTED_FIELD" } },
    });
    expect(
      await call(`/api/orgs/${ORG_A}/roles`, "POST", USER_ADMIN, { name: "x", description: "y".repeat(257) }),
    ).toMatchObject({ status: 400, body: { error: { code: "INVALID_ROLE" } } });
    const role = await call(`/api/orgs/${ORG_A}/roles`, "POST", USER_ADMIN, { name: "runners" });
    const roleId = role.body.id as string;
    expect(await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {})).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_GRANT" } },
    });
    expect(
      await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, {
        resourceKind: "saga",
        resourceId: echoSaga.id,
        action: "execute",
        bogus: 1,
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "UNSUPPORTED_FIELD" } } });
    expect(await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants`, "POST", USER_ADMIN, "nope")).toMatchObject({
      status: 400,
    });
    expect(await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, {})).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_USER_ID" } },
    });
    expect(
      await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments`, "POST", USER_ADMIN, {
        userId: USER_ORDINARY,
        bogus: 1,
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "UNSUPPORTED_FIELD" } } });
    expect(await call(`/api/orgs/${ORG_A}/assignments/revoke`, "POST", USER_ADMIN, {})).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_REVOCATION" } },
    });
    expect(await call(`/api/orgs/${ORG_A}/assignments/revoke`, "POST", USER_ADMIN, { bogus: 1 })).toMatchObject({
      status: 400,
      body: { error: { code: "UNSUPPORTED_FIELD" } },
    });
    expect(
      await call(`/api/orgs/${ORG_A}/assignments/revoke`, "POST", USER_ADMIN, {
        userId: USER_ORDINARY,
        roleId,
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "INVALID_REVOCATION" } } });
    expect(await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {})).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_RULE" } },
    });
    expect(
      await call(`/api/orgs/${ORG_A}/policy-rules`, "POST", USER_ADMIN, {
        resourceKind: "saga",
        resourceId: echoSaga.id,
        action: "execute",
        subjectType: "user",
        subjectRef: USER_ORDINARY,
        bogus: 1,
      }),
    ).toMatchObject({ status: 400, body: { error: { code: "UNSUPPORTED_FIELD" } } });
    // Unsupported verbs on role paths answer 400, never fall through.
    expect(await call(`/api/orgs/${ORG_A}/roles`, "PUT", USER_ADMIN, {})).toMatchObject({ status: 400 });
  });

  it("answers 404 on unknown roles, grants, assignments, and rules", async () => {
    const missing = "aaaaaaaa-1111-4111-8111-111111111111";
    const grant = "bbbbbbbb-2222-4222-8222-222222222222";
    expect(await call(`/api/orgs/${ORG_A}/roles/${missing}`, "DELETE", USER_ADMIN)).toMatchObject({
      status: 404,
      body: { error: { code: "ROLE_NOT_FOUND" } },
    });
    expect(await call(`/api/orgs/${ORG_A}/roles/${missing}/consumers`, "GET", USER_ADMIN)).toMatchObject({
      status: 404,
    });
    expect(await call(`/api/orgs/${ORG_A}/roles/${missing}/grants`, "GET", USER_ADMIN)).toMatchObject({ status: 404 });
    expect(await call(`/api/orgs/${ORG_A}/roles/${missing}/assignments`, "GET", USER_ADMIN)).toMatchObject({
      status: 404,
    });
    const role = await call(`/api/orgs/${ORG_A}/roles`, "POST", USER_ADMIN, { name: "runners" });
    const roleId = role.body.id as string;
    expect(await call(`/api/orgs/${ORG_A}/roles/${roleId}/grants/${grant}`, "DELETE", USER_ADMIN)).toMatchObject({
      status: 404,
      body: { error: { code: "GRANT_NOT_FOUND" } },
    });
    expect(
      await call(`/api/orgs/${ORG_A}/roles/${roleId}/assignments/${USER_ORDINARY}`, "DELETE", USER_ADMIN),
    ).toMatchObject({ status: 404, body: { error: { code: "ASSIGNMENT_NOT_FOUND" } } });
    expect(await call(`/api/orgs/${ORG_A}/policy-rules/${missing}`, "DELETE", USER_ADMIN)).toMatchObject({
      status: 404,
      body: { error: { code: "RULE_NOT_FOUND" } },
    });
    expect(await call(`/api/orgs/${ORG_A}/policy-consumers`, "GET", USER_ADMIN)).toMatchObject({ status: 400 });
    expect(await call(`/api/orgs/${ORG_A}/policy-consumers?resourceKind=saga`, "GET", USER_ADMIN)).toMatchObject({
      status: 400,
    });
    expect(
      await call(
        `/api/orgs/${ORG_A}/policy-consumers?resourceKind=saga&resourceId=x&action=execute&bogus=1`,
        "GET",
        USER_ADMIN,
      ),
    ).toMatchObject({ status: 400, body: { error: { code: "UNSUPPORTED_QUERY" } } });
  });

  it("fences global policy rules to instance admins", async () => {
    expect(await call(`/api/orgs/${ORG_A}/roles`, "GET", USER_ADMIN)).toMatchObject({ status: 200 });
    expect(await call(`/api/orgs/${ORG_A}/policy-rules`, "GET", USER_ADMIN)).toMatchObject({ status: 200 });
    expect(await call("/api/policy-rules", "GET", USER_ORDINARY)).toMatchObject({
      status: 403,
      body: { error: { code: "ADMIN_ONLY" } },
    });
    expect(await call("/api/policy-rules", "POST", USER_ORDINARY, {})).toMatchObject({ status: 403 });
    const created = await call("/api/policy-rules", "POST", USER_ADMIN, {
      resourceKind: "saga",
      resourceId: echoSaga.id,
      action: "execute",
      subjectType: "all",
    });
    expect(created.status).toBe(201);
    expect(await call("/api/policy-rules", "GET", USER_ADMIN)).toMatchObject({ status: 200 });
    const missing = "aaaaaaaa-1111-4111-8111-111111111111";
    expect(await call(`/api/policy-rules/${missing}`, "DELETE", USER_ADMIN)).toMatchObject({
      status: 404,
      body: { error: { code: "RULE_NOT_FOUND" } },
    });
    expect(
      await call(`/api/policy-rules/${(created.body as { id: string }).id}`, "DELETE", USER_ORDINARY),
    ).toMatchObject({
      status: 403,
    });
    expect(await call(`/api/policy-rules/${(created.body as { id: string }).id}`, "DELETE", USER_ADMIN)).toMatchObject({
      status: 200,
    });
  });
});
