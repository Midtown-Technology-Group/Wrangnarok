// SPDX-License-Identifier: AGPL-3.0
// Resource roles, claims, and delegated authorization (ADR 018, AUTH-02).
//
// Membership (ADR 015) answers "may this caller reach this Organization".
// This module answers "may this caller use this resource": named
// Organization-scoped Roles bundle action grants, direct policy rules cover
// the cases roles overserve, and `can` evaluates both per request with deny
// by absence. No implicit cross-org fallback, no global roles.
//
// A claim here is the subject side of one allow tuple: reusable and
// inspectable, whether it arrives via a role assignment or a direct rule.
// There is deliberately no separate claims table — a third store for the
// same allow tuple would be clever wrapping over boring typed rows.
import { Fault, UUID, type Principal } from "./domain";
import type { CallerCtx } from "./orgs";

export type ResourceKind = "saga" | "form" | "app";
export type ResourceAction = "execute" | "read" | "submit" | "write" | "serve";
export type SubjectType = "user" | "kind" | "all";
export type AssignmentStatus = "active" | "revoked";

/** Closed action set per resource kind. `table` and `file` are reserved names
 * only (no such resources exist yet): TABLE-01/FILE-01 extend the kind set
 * with their own ADR. Discovery stays open metadata: listing Sagas, Forms, or
 * Apps never grants any action. */
const ACTIONS: Readonly<Record<ResourceKind, readonly ResourceAction[]>> = {
  saga: ["execute"],
  form: ["read", "submit", "write"],
  app: ["read", "write", "serve"],
};
const KINDS: readonly string[] = ["saga", "form", "app"];
const SUBJECTS: readonly string[] = ["user", "kind", "all"];
/** Wildcard: kind-wide grant ("may execute every Saga in this Organization"). */
export const WILDCARD = "*";

export interface RoleSummary {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
}

export interface GrantRow {
  readonly id: string;
  readonly roleId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly action: ResourceAction;
  readonly createdAt: string;
}

export interface AssignmentRow {
  readonly roleId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: AssignmentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PolicyRule {
  readonly id: string;
  /** Null means a global rule (instance admins only); set means that Org. */
  readonly orgId: string | null;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly action: ResourceAction;
  readonly subjectType: SubjectType;
  readonly subjectRef: string;
  readonly createdAt: string;
}

export interface RoleCheck {
  readonly orgId: string;
  readonly resourceKind: ResourceKind;
  readonly resourceId: string;
  readonly action: ResourceAction;
}

interface RoleRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  created_at: string;
}

interface GrantDbRow {
  id: string;
  role_id: string;
  resource_kind: string;
  resource_id: string;
  action: string;
  created_at: string;
}

interface AssignmentDbRow {
  role_id: string;
  org_id: string;
  user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RuleDbRow {
  id: string;
  org_id: string | null;
  resource_kind: string;
  resource_id: string;
  action: string;
  subject_type: string;
  subject_ref: string;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function fail503(): Fault {
  return new Fault(503, "ROLE_STORE_NOT_MIGRATED", "Resource-role storage is not migrated: apply migration 0013.");
}

/**
 * Shared D1 failure mapping for the role store (one site, not one per
 * function): domain Faults thrown inside a try pass through, missing
 * migration-0013 tables answer 503, and anything else rethrows. Callers with
 * duplicate-key callers map 409.
 */
function storeError(error: unknown): never {
  if (error instanceof Fault) throw error;
  if (isMissingTable(error)) throw fail503();
  throw error;
}

/** Role names are operator-chosen labels: 1-64 chars, no whitespace games. */
export function parseRoleName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 64) {
    throw new Fault(400, "INVALID_ROLE", "Role name must be 1 to 64 characters.");
  }
  return value.trim();
}

export function parseRoleId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value.trim().toLowerCase())) {
    throw new Fault(400, "INVALID_ROLE", "Role ID must be a UUID.");
  }
  return value.trim().toLowerCase();
}

export function parseRuleId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value.trim().toLowerCase())) {
    throw new Fault(400, "INVALID_RULE", "Policy rule ID must be a UUID.");
  }
  return value.trim().toLowerCase();
}

/** Validate one (kind, resourceId, action) grant triple. `resourceId` is the
 * stable identity callers already use (Saga UUID, Form name, App UUID) or the
 * kind-wide wildcard. Table/file kinds are reserved until their issues land. */
export function parseGrantTriple(kind: unknown, resourceId: unknown, action: unknown): RoleCheck & { orgId: "" } {
  if (typeof kind !== "string" || !KINDS.includes(kind)) {
    throw new Fault(400, "INVALID_GRANT", "Resource kind must be saga, form, or app (table/file are reserved).");
  }
  const resourceKind = kind as ResourceKind;
  const allowed = ACTIONS[resourceKind];
  if (typeof action !== "string" || !allowed.includes(action as ResourceAction)) {
    throw new Fault(400, "INVALID_GRANT", `Action must be one of ${allowed.join(", ")} for ${resourceKind} resources.`);
  }
  if (typeof resourceId !== "string" || resourceId.length === 0 || resourceId.length > 320) {
    throw new Fault(400, "INVALID_GRANT", "Resource ID must be 1 to 320 characters, or the * wildcard.");
  }
  let canonicalId = resourceId;
  if (canonicalId !== WILDCARD) {
    if (resourceKind === "saga" && !UUID.test(canonicalId.toLowerCase())) {
      throw new Fault(400, "INVALID_GRANT", "Saga grants name a stable Saga UUID or *.");
    }
    if (resourceKind === "form" && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(canonicalId)) {
      throw new Fault(400, "INVALID_GRANT", "Form grants name a Form name or *.");
    }
    if (resourceKind === "app" && !UUID.test(canonicalId.toLowerCase())) {
      throw new Fault(400, "INVALID_GRANT", "App grants name an App UUID or *.");
    }
    // Canonicalize UUID resource IDs to lowercase: execution and App routes
    // match canonical lowercase IDs, so an accepted uppercase UUID would
    // persist yet never match during `can` and deny every request.
    if (resourceKind === "saga" || resourceKind === "app") canonicalId = canonicalId.toLowerCase();
  }
  return { orgId: "", resourceKind, resourceId: canonicalId, action: action as ResourceAction };
}

/** Validate a rule subject: one user (`user:<id>`), one membership kind
 * (`kind:ordinary` / `kind:external`), or every member (`all`). External
 * callers are reachable as a class here even though they can never be admins. */
export function parseSubject(type: unknown, ref: unknown): { subjectType: SubjectType; subjectRef: string } {
  if (typeof type !== "string" || !SUBJECTS.includes(type)) {
    throw new Fault(400, "INVALID_SUBJECT", "Subject type must be user, kind, or all.");
  }
  const subjectType = type as SubjectType;
  if (subjectType === "all") return { subjectType, subjectRef: "all" };
  if (subjectType === "kind") {
    if (ref !== "ordinary" && ref !== "external") {
      throw new Fault(400, "INVALID_SUBJECT", "Kind subjects must be ordinary or external.");
    }
    return { subjectType, subjectRef: ref };
  }
  if (typeof ref !== "string") {
    throw new Fault(400, "INVALID_SUBJECT", "User subjects need a user ID of 1 to 320 characters.");
  }
  // Trimmed before validating (same posture as parseUserId in orgs.ts):
  // surrounding whitespace never becomes part of the identity.
  const user = ref.trim().toLowerCase();
  if (user.length === 0 || user.length > 320 || /[\s<>"]/.test(user)) {
    throw new Fault(400, "INVALID_SUBJECT", "User subjects need a user ID of 1 to 320 characters.");
  }
  return { subjectType, subjectRef: user };
}

function toRole(row: RoleRow): RoleSummary {
  return { id: row.id, orgId: row.org_id, name: row.name, description: row.description, createdAt: row.created_at };
}

function toGrant(row: GrantDbRow): GrantRow {
  return {
    id: row.id,
    roleId: row.role_id,
    resourceKind: row.resource_kind as ResourceKind,
    resourceId: row.resource_id,
    action: row.action as ResourceAction,
    createdAt: row.created_at,
  };
}

function toAssignment(row: AssignmentDbRow): AssignmentRow {
  return {
    roleId: row.role_id,
    orgId: row.org_id,
    userId: row.user_id,
    status: row.status === "revoked" ? "revoked" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRule(row: RuleDbRow): PolicyRule {
  return {
    id: row.id,
    orgId: row.org_id,
    resourceKind: row.resource_kind as ResourceKind,
    resourceId: row.resource_id,
    action: row.action as ResourceAction,
    subjectType: row.subject_type as SubjectType,
    subjectRef: row.subject_ref,
    createdAt: row.created_at,
  };
}

async function getRole(db: D1Database, orgId: string, roleId: string): Promise<RoleRow | null> {
  try {
    return await db
      .prepare("SELECT * FROM resource_roles WHERE id=? AND org_id=?")
      .bind(roleId, orgId)
      .first<RoleRow>();
  } catch (error) {
    storeError(error);
  }
}

/**
 * Authorization check for one (org, kind, resource, action). Re-resolved per
 * request from D1, so policy changes and revocations apply to the next
 * request. Order: instance admin, org admin, direct rule (org or global),
 * role path. Anything else denies by absence. Membership stays the outer
 * gate: callers pass the ADR-015 CallerCtx, and strangers never reach here.
 */
export async function can(db: D1Database, ctx: CallerCtx, check: RoleCheck): Promise<boolean> {
  if (ctx.isInstanceAdmin) return true;
  // Org admin allow is fenced on a live admin membership in the TARGET org,
  // never the caller's selected org — selecting another org cannot smuggle
  // rights across the boundary. Mirrors canManageOrg (orgs.ts).
  try {
    if (ctx.isOrgAdmin && ctx.principal.orgId === check.orgId) return true;
    const target =
      ctx.principal.orgId === check.orgId
        ? null
        : await db
            .prepare("SELECT role,status FROM org_memberships WHERE org_id=? AND user_id=?")
            .bind(check.orgId, ctx.principal.userId)
            .first<{ role: string; status: string }>();
    if (target !== null && target.status === "active" && target.role === "admin") return true;
    const userId = ctx.principal.userId;
    // Membership kind for kind-subject rules: live row in the target org.
    // External-kind callers match kind:external; ordinary match kind:ordinary.
    const kindRow = await db
      .prepare("SELECT kind FROM org_memberships WHERE org_id=? AND user_id=? AND status='active'")
      .bind(check.orgId, userId)
      .first<{ kind: string }>();
    const kind = kindRow?.kind === "external" ? "external" : kindRow ? "ordinary" : null;
    // Direct rule: this Organization's rule, or any global rule. No implicit
    // cross-org fallback — org A's rule never authorizes org B.
    const rules = await db
      .prepare(
        "SELECT * FROM policy_rules WHERE resource_kind=? AND resource_id IN (?,?) AND action=? AND (org_id=? OR org_id IS NULL)",
      )
      .bind(check.resourceKind, check.resourceId, WILDCARD, check.action, check.orgId)
      .all<RuleDbRow>();
    for (const row of rules.results) {
      if (row.subject_type === "all" && kind !== null) return true;
      if (row.subject_type === "user" && row.subject_ref === userId) return true;
      if (row.subject_type === "kind" && kind !== null && row.subject_ref === kind) return true;
    }
    // Role path: an active assignment in this Organization whose role holds a
    // matching grant (exact resource or kind-wide wildcard).
    const grants = await db
      .prepare(
        "SELECT g.resource_kind,g.resource_id,g.action FROM role_grants g JOIN role_assignments a ON a.role_id=g.role_id WHERE a.org_id=? AND a.user_id=? AND a.status='active' AND g.resource_kind=? AND g.resource_id IN (?,?) AND g.action=? LIMIT 1",
      )
      .bind(check.orgId, userId, check.resourceKind, check.resourceId, WILDCARD, check.action)
      .first<{ resource_kind: string }>();
    return grants !== null;
  } catch (error) {
    storeError(error);
  }
}

/** Same as `can` but throws 403 GRANT_REQUIRED on denial (action on a known
 * reference). Discovery-shaped denials (unknown references) stay 404 at the
 * route, which resolves the reference before calling here. */
export async function requireGrant(
  db: D1Database,
  ctx: CallerCtx,
  check: RoleCheck,
  what = "This action requires a grant.",
): Promise<void> {
  if (!(await can(db, ctx, check))) throw new Fault(403, "GRANT_REQUIRED", what);
}

// --- Role administration (org admins via requireManageOrg at the route) ------

export async function createRole(db: D1Database, orgId: string, name: string, description = ""): Promise<RoleSummary> {
  const clean = parseRoleName(name);
  if (typeof description !== "string" || description.length > 256) {
    throw new Fault(400, "INVALID_ROLE", "Role description must be at most 256 characters.");
  }
  const id = crypto.randomUUID().toLowerCase();
  const stamp = now();
  try {
    await db
      .prepare("INSERT INTO resource_roles(id,org_id,name,description,created_at) VALUES (?,?,?,?,?)")
      .bind(id, orgId, clean, description, stamp)
      .run();
  } catch (error) {
    if (isMissingTable(error)) throw fail503();
    throw new Fault(409, "ROLE_EXISTS", "A role with this name already exists in this Organization.");
  }
  return { id, orgId, name: clean, description, createdAt: stamp };
}

export async function listRoles(db: D1Database, orgId: string): Promise<RoleSummary[]> {
  try {
    const rows = await db
      .prepare("SELECT * FROM resource_roles WHERE org_id=? ORDER BY name")
      .bind(orgId)
      .all<RoleRow>();
    return rows.results.map(toRole);
  } catch (error) {
    storeError(error);
  }
}

export async function deleteRole(
  db: D1Database,
  orgId: string,
  roleId: string,
): Promise<{ roleId: string; deletedGrants: number; deletedAssignments: number }> {
  const id = parseRoleId(roleId);
  const role = await getRole(db, orgId, id);
  if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  try {
    const grants = await db
      .prepare("SELECT COUNT(*) AS n FROM role_grants WHERE role_id=?")
      .bind(id)
      .first<{ n: number }>();
    const assignments = await db
      .prepare("SELECT COUNT(*) AS n FROM role_assignments WHERE role_id=? AND org_id=?")
      .bind(id, orgId)
      .first<{ n: number }>();
    await db.batch([
      db.prepare("DELETE FROM role_assignments WHERE role_id=? AND org_id=?").bind(id, orgId),
      db.prepare("DELETE FROM role_grants WHERE role_id=?").bind(id),
      db.prepare("DELETE FROM resource_roles WHERE id=? AND org_id=?").bind(id, orgId),
    ]);
    return { roleId: id, deletedGrants: grants?.n ?? 0, deletedAssignments: assignments?.n ?? 0 };
  } catch (error) {
    storeError(error);
  }
}

export async function addGrant(
  db: D1Database,
  orgId: string,
  roleId: string,
  kind: unknown,
  resourceId: unknown,
  action: unknown,
): Promise<GrantRow> {
  const id = parseRoleId(roleId);
  const triple = parseGrantTriple(kind, resourceId, action);
  const role = await getRole(db, orgId, id);
  if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  const grantId = crypto.randomUUID().toLowerCase();
  const stamp = now();
  try {
    await db
      .prepare("INSERT INTO role_grants(id,role_id,resource_kind,resource_id,action,created_at) VALUES (?,?,?,?,?,?)")
      .bind(grantId, id, triple.resourceKind, triple.resourceId, triple.action, stamp)
      .run();
  } catch (error) {
    if (isMissingTable(error)) throw fail503();
    throw new Fault(409, "GRANT_EXISTS", "This grant already exists on this role.");
  }
  return {
    id: grantId,
    roleId: id,
    resourceKind: triple.resourceKind,
    resourceId: triple.resourceId,
    action: triple.action,
    createdAt: stamp,
  };
}

export async function listGrants(db: D1Database, orgId: string, roleId: string): Promise<GrantRow[]> {
  const id = parseRoleId(roleId);
  const role = await getRole(db, orgId, id);
  if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  try {
    const rows = await db.prepare("SELECT * FROM role_grants WHERE role_id=?").bind(id).all<GrantDbRow>();
    return rows.results.map(toGrant);
  } catch (error) {
    storeError(error);
  }
}

export async function removeGrant(db: D1Database, orgId: string, roleId: string, grantId: string): Promise<void> {
  const rid = parseRoleId(roleId);
  if (typeof grantId !== "string" || !UUID.test(grantId.trim().toLowerCase())) {
    throw new Fault(400, "INVALID_GRANT", "Grant ID must be a UUID.");
  }
  const role = await getRole(db, orgId, rid);
  if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  try {
    const done = await db
      .prepare("DELETE FROM role_grants WHERE id=? AND role_id=?")
      .bind(grantId.trim().toLowerCase(), rid)
      .run();
    if (done.meta.changes === 0) throw new Fault(404, "GRANT_NOT_FOUND", "Grant not found on this role.");
  } catch (error) {
    storeError(error);
  }
}

/** Assign a role to a user. The user row must exist (invited via the member
 * API first): assignments never invent identities. Re-assigning a revoked
 * row reactivates it; assigning a live row conflicts. */
export async function assignRole(
  db: D1Database,
  orgId: string,
  roleId: string,
  userId: string,
): Promise<AssignmentRow> {
  const rid = parseRoleId(roleId);
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Fault(400, "INVALID_USER_ID", "Provide a userId string to assign.");
  }
  const user = userId.trim().toLowerCase();
  const role = await getRole(db, orgId, rid);
  if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  try {
    // Org-scoped membership check: the assignee must hold an org_memberships
    // row for THIS org, not merely exist in the global users table. A global
    // lookup would let an admin probe foreign-tenant identities and would
    // create dormant authority effective the moment the user joins this org.
    const member = await db
      .prepare("SELECT user_id FROM org_memberships WHERE org_id=? AND user_id=?")
      .bind(orgId, user)
      .first<{ user_id: string }>();
    if (!member) throw new Fault(404, "USER_NOT_FOUND", "Invite this user as a member first.");
    const stamp = now();
    const existing = await db
      .prepare("SELECT status FROM role_assignments WHERE role_id=? AND org_id=? AND user_id=?")
      .bind(rid, orgId, user)
      .first<{ status: string }>();
    if (existing?.status === "active") throw new Fault(409, "ASSIGNMENT_EXISTS", "This user already holds this role.");
    if (existing) {
      await db
        .prepare("UPDATE role_assignments SET status='active',updated_at=? WHERE role_id=? AND org_id=? AND user_id=?")
        .bind(stamp, rid, orgId, user)
        .run();
    } else {
      await db
        .prepare(
          "INSERT INTO role_assignments(role_id,org_id,user_id,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)",
        )
        .bind(rid, orgId, user, stamp, stamp)
        .run();
    }
    return { roleId: rid, orgId, userId: user, status: "active", createdAt: stamp, updatedAt: stamp };
  } catch (error) {
    storeError(error);
  }
}

/** Revoke one assignment (status flip, never a delete — inspection keeps history). */
export async function revokeAssignment(
  db: D1Database,
  orgId: string,
  roleId: string,
  userId: string,
): Promise<AssignmentRow> {
  const rid = parseRoleId(roleId);
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Fault(400, "INVALID_USER_ID", "Provide a userId string to revoke.");
  }
  const user = userId.trim().toLowerCase();
  const role = await getRole(db, orgId, rid);
  if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  try {
    const stamp = now();
    const done = await db
      .prepare(
        "UPDATE role_assignments SET status='revoked',updated_at=? WHERE role_id=? AND org_id=? AND user_id=? AND status='active'",
      )
      .bind(stamp, rid, orgId, user)
      .run();
    if (done.meta.changes === 0) throw new Fault(404, "ASSIGNMENT_NOT_FOUND", "No active assignment for this user.");
    return { roleId: rid, orgId, userId: user, status: "revoked", createdAt: stamp, updatedAt: stamp };
  } catch (error) {
    storeError(error);
  }
}

export async function listAssignments(db: D1Database, orgId: string, roleId: string): Promise<AssignmentRow[]> {
  const rid = parseRoleId(roleId);
  const role = await getRole(db, orgId, rid);
  if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  try {
    const rows = await db
      .prepare("SELECT * FROM role_assignments WHERE role_id=? AND org_id=? ORDER BY user_id")
      .bind(rid, orgId)
      .all<AssignmentDbRow>();
    return rows.results.map(toAssignment);
  } catch (error) {
    storeError(error);
  }
}

/**
 * Bulk revocation: flip every ACTIVE assignment for one user in an
 * Organization to revoked (incident response: "remove this user everywhere in
 * this org now"), or every active assignment OF one role. One of userId /
 * roleId is required, never both. Returns the revoked count receipt.
 */
export async function revokeAll(
  db: D1Database,
  orgId: string,
  filter: { userId?: string; roleId?: string },
): Promise<{ orgId: string; revoked: number }> {
  const stamp = now();
  try {
    if (filter.userId !== undefined && filter.roleId !== undefined) {
      throw new Fault(400, "INVALID_REVOCATION", "Revoke by user or by role, not both.");
    }
    if (filter.userId !== undefined) {
      if (typeof filter.userId !== "string" || filter.userId.trim().length === 0) {
        throw new Fault(400, "INVALID_USER_ID", "Provide a userId string to revoke.");
      }
      const done = await db
        .prepare(
          "UPDATE role_assignments SET status='revoked',updated_at=? WHERE org_id=? AND user_id=? AND status='active'",
        )
        .bind(stamp, orgId, filter.userId.trim().toLowerCase())
        .run();
      return { orgId, revoked: done.meta.changes };
    }
    if (filter.roleId !== undefined) {
      const rid = parseRoleId(filter.roleId);
      const role = await getRole(db, orgId, rid);
      if (!role) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
      const done = await db
        .prepare(
          "UPDATE role_assignments SET status='revoked',updated_at=? WHERE role_id=? AND org_id=? AND status='active'",
        )
        .bind(stamp, rid, orgId)
        .run();
      return { orgId, revoked: done.meta.changes };
    }
    throw new Fault(400, "INVALID_REVOCATION", "Revoke by user or by role.");
  } catch (error) {
    storeError(error);
  }
}

/**
 * Consumer inspection for safe grant removal: a role's grants plus every
 * assigned user and status, so an operator sees dependents before deleting.
 */
export async function roleConsumers(
  db: D1Database,
  orgId: string,
  roleId: string,
): Promise<{ role: RoleSummary; grants: GrantRow[]; assignments: AssignmentRow[] }> {
  const rid = parseRoleId(roleId);
  const row = await getRole(db, orgId, rid);
  if (!row) throw new Fault(404, "ROLE_NOT_FOUND", "Role not found.");
  return {
    role: toRole(row),
    grants: await listGrants(db, orgId, rid),
    assignments: await listAssignments(db, orgId, rid),
  };
}

// --- Policy rules (org admins own org rules; instance admins own globals) ----

export async function createPolicyRule(
  db: D1Database,
  scopeOrgId: string | null,
  kind: unknown,
  resourceId: unknown,
  action: unknown,
  subjectType: unknown,
  subjectRef: unknown,
): Promise<PolicyRule> {
  const triple = parseGrantTriple(kind, resourceId, action);
  const subject = parseSubject(subjectType, subjectRef);
  const id = crypto.randomUUID().toLowerCase();
  const stamp = now();
  try {
    const existing =
      scopeOrgId === null
        ? await db
            .prepare(
              "SELECT id FROM policy_rules WHERE org_id IS NULL AND resource_kind=? AND resource_id=? AND action=? AND subject_type=? AND subject_ref=?",
            )
            .bind(triple.resourceKind, triple.resourceId, triple.action, subject.subjectType, subject.subjectRef)
            .first<{ id: string }>()
        : await db
            .prepare(
              "SELECT id FROM policy_rules WHERE org_id=? AND resource_kind=? AND resource_id=? AND action=? AND subject_type=? AND subject_ref=?",
            )
            .bind(
              scopeOrgId,
              triple.resourceKind,
              triple.resourceId,
              triple.action,
              subject.subjectType,
              subject.subjectRef,
            )
            .first<{ id: string }>();
    if (existing) throw new Fault(409, "RULE_EXISTS", "This policy rule already exists.");
    await db
      .prepare(
        "INSERT INTO policy_rules(id,org_id,resource_kind,resource_id,action,subject_type,subject_ref,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        scopeOrgId,
        triple.resourceKind,
        triple.resourceId,
        triple.action,
        subject.subjectType,
        subject.subjectRef,
        stamp,
      )
      .run();
  } catch (error) {
    // Race loser: answer 409, not a driver leak. Only UNIQUE violations map.
    if (error instanceof Error && /unique constraint failed/i.test(`${error.message} ${error.cause ?? ""}`))
      throw new Fault(409, "RULE_EXISTS", "This policy rule already exists.");
    storeError(error);
  }
  return {
    id,
    orgId: scopeOrgId,
    resourceKind: triple.resourceKind,
    resourceId: triple.resourceId,
    action: triple.action,
    subjectType: subject.subjectType,
    subjectRef: subject.subjectRef,
    createdAt: stamp,
  };
}

/** List rules visible in an Organization: its own rules plus global rules.
 * Passing null lists globals only (the instance-admin surface). */
export async function listPolicyRules(db: D1Database, scopeOrgId: string | null): Promise<PolicyRule[]> {
  try {
    const rows =
      scopeOrgId === null
        ? await db
            .prepare("SELECT * FROM policy_rules WHERE org_id IS NULL ORDER BY resource_kind,resource_id")
            .all<RuleDbRow>()
        : await db
            .prepare("SELECT * FROM policy_rules WHERE org_id=? OR org_id IS NULL ORDER BY resource_kind,resource_id")
            .bind(scopeOrgId)
            .all<RuleDbRow>();
    return rows.results.map(toRule);
  } catch (error) {
    storeError(error);
  }
}

export async function deletePolicyRule(db: D1Database, scopeOrgId: string | null, ruleId: string): Promise<void> {
  const id = parseRuleId(ruleId);
  try {
    const done =
      scopeOrgId === null
        ? await db.prepare("DELETE FROM policy_rules WHERE id=? AND org_id IS NULL").bind(id).run()
        : await db.prepare("DELETE FROM policy_rules WHERE id=? AND org_id=?").bind(id, scopeOrgId).run();
    if (done.meta.changes === 0) throw new Fault(404, "RULE_NOT_FOUND", "Policy rule not found.");
  } catch (error) {
    storeError(error);
  }
}

/**
 * Policy-consumer inspection: "who may do this action on this resource".
 * Answers across direct rules (org + global) and the role path, so an
 * operator removing a grant sees every dependent first. Subjects only —
 * never secret values, never unrelated rows.
 */
export interface PolicyConsumer {
  readonly via: "rule" | "role";
  readonly subjectType: SubjectType;
  readonly subjectRef: string;
  readonly roleId: string | null;
  readonly roleName: string | null;
  readonly assignmentStatus: AssignmentStatus | null;
}

export async function policyConsumers(
  db: D1Database,
  orgId: string,
  kind: unknown,
  resourceId: unknown,
  action: unknown,
): Promise<{ consumers: readonly PolicyConsumer[] }> {
  const triple = parseGrantTriple(kind, resourceId, action);
  try {
    const consumers: PolicyConsumer[] = [];
    const rules = await db
      .prepare(
        "SELECT * FROM policy_rules WHERE resource_kind=? AND resource_id IN (?,?) AND action=? AND (org_id=? OR org_id IS NULL)",
      )
      .bind(triple.resourceKind, triple.resourceId, WILDCARD, triple.action, orgId)
      .all<RuleDbRow>();
    for (const row of rules.results) {
      consumers.push({
        via: "rule",
        subjectType: row.subject_type as SubjectType,
        subjectRef: row.subject_ref,
        roleId: null,
        roleName: null,
        assignmentStatus: null,
      });
    }
    const rows = await db
      .prepare(
        "SELECT r.id,r.name,a.user_id,a.status FROM resource_roles r JOIN role_grants g ON g.role_id=r.id JOIN role_assignments a ON a.role_id=r.id WHERE r.org_id=? AND a.org_id=? AND g.resource_kind=? AND g.resource_id IN (?,?) AND g.action=? ORDER BY r.name,a.user_id",
      )
      .bind(orgId, orgId, triple.resourceKind, triple.resourceId, WILDCARD, triple.action)
      .all<{ id: string; name: string; user_id: string; status: string }>();
    for (const row of rows.results) {
      consumers.push({
        via: "role",
        subjectType: "user",
        subjectRef: row.user_id,
        roleId: row.id,
        roleName: row.name,
        assignmentStatus: row.status === "revoked" ? "revoked" : "active",
      });
    }
    return { consumers: Object.freeze(consumers) };
  } catch (error) {
    storeError(error);
  }
}

/** Ensure the migration-0013 tables exist on hand-built databases (same
 * standing pattern as ensureLabFixture in orgs.ts): LAB/test databases built
 * from older migrations predate these tables, and production always migrates
 * via `migrations_dir`. Called from authenticate's fixture bootstrap path so
 * the existing suite keeps passing unmodified. */
export async function ensureRoleTables(db: D1Database): Promise<void> {
  const stmts = [
    "CREATE TABLE IF NOT EXISTS resource_roles(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS resource_roles_org_name ON resource_roles(org_id,name)",
    "CREATE TABLE IF NOT EXISTS role_grants(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL)",
    "CREATE UNIQUE INDEX IF NOT EXISTS role_grants_unique ON role_grants(role_id,resource_kind,resource_id,action)",
    "CREATE TABLE IF NOT EXISTS role_assignments(role_id TEXT NOT NULL,org_id TEXT NOT NULL,user_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(role_id,org_id,user_id))",
    "CREATE INDEX IF NOT EXISTS role_assignments_user ON role_assignments(org_id,user_id,status)",
    "CREATE INDEX IF NOT EXISTS role_assignments_role ON role_assignments(role_id,status)",
    "CREATE TABLE IF NOT EXISTS policy_rules(id TEXT PRIMARY KEY,org_id TEXT,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,action TEXT NOT NULL,subject_type TEXT NOT NULL,subject_ref TEXT NOT NULL,created_at TEXT NOT NULL)",
    // Mirrors migration 0013.
    "CREATE UNIQUE INDEX IF NOT EXISTS policy_rules_unique ON policy_rules(COALESCE(org_id, ''),resource_kind,resource_id,action,subject_type,subject_ref)",
  ];
  for (const ddl of stmts) {
    try {
      await db.exec(ddl);
    } catch {
      // Already-migrated databases reject nothing here (all IF NOT EXISTS);
      // anything else means the rows below fail loudly at first use.
    }
  }
}

/** Flat principal view for Workflow-adjacent checks that hold a Principal
 * rather than a CallerCtx (no membership row in hand). Instance admins pass
 * through; everyone else evaluates rules and roles exactly like `can`. */
export async function canPrincipal(db: D1Database, caller: Principal, check: RoleCheck): Promise<boolean> {
  try {
    const membership = await db
      .prepare("SELECT role,status FROM org_memberships WHERE org_id=? AND user_id=?")
      .bind(check.orgId, caller.userId)
      .first<{ role: string; status: string }>();
    if (!membership || membership.status !== "active") return false;
    const ctx: CallerCtx = {
      principal: { userId: caller.userId, orgId: check.orgId },
      role: (membership.role === "admin" ? "admin" : "member") as CallerCtx["role"],
      kind: null,
      isInstanceAdmin: false,
      isOrgAdmin: membership.role === "admin",
    };
    return can(db, ctx, check);
  } catch (error) {
    storeError(error);
  }
}
