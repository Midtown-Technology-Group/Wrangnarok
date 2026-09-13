// SPDX-License-Identifier: AGPL-3.0
// Organization and user lifecycle (ADR 015, AUTH-01).
//
// Access stays the identity source and the Principal stays the immutable
// caller context: this module only resolves what that identity may do.
// Membership rows (D1 org_memberships) replace the ADR-014 allowlist as the
// authorization gate — an allowlisted email with no membership row fails
// closed. Every request re-resolves membership, so revocation applies to the
// next request with no redeploy and no server sessions to expire.
//
// Roles are deliberately small: member vs admin per Organization, plus an
// instance admin list (ADMIN_USER_IDS env, install state like D1 IDs, never
// in Git) for creating/disabling Organizations and recovering stuck tenants.
// External users are first-class members whose kind is recorded and who can
// never hold admin: scope selection can never elevate privilege.
import { encodeHistoryCursor, Fault, UUID, type HistoryQuery, type Principal } from "./domain";
import { summary } from "./executions";
import type { ExecutionRow } from "./executions";

export interface AdminEnv {
  ADMIN_USER_IDS?: string;
}

export type OrgRole = "member" | "admin";
export type MembershipStatus = "invited" | "active" | "suspended" | "revoked";
export type MembershipKind = "ordinary" | "external";
export type OrgStatus = "active" | "disabled";
export type UserStatus = "active" | "disabled";

export interface CallerCtx {
  readonly principal: Principal;
  readonly role: OrgRole | null;
  readonly kind: MembershipKind | null;
  readonly isInstanceAdmin: boolean;
  readonly isOrgAdmin: boolean;
}

export interface OrgSummary {
  readonly id: string;
  readonly name: string;
  readonly status: OrgStatus;
  readonly createdAt: string;
  readonly disabledAt: string | null;
}

export interface MemberRow {
  readonly userId: string;
  readonly role: OrgRole;
  readonly status: MembershipStatus;
  readonly kind: MembershipKind;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface OrgRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
  disabled_at: string | null;
}

interface UserRow {
  user_id: string;
  status: string;
}

interface MembershipRow {
  org_id: string;
  user_id: string;
  role: string;
  status: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

const ROLES: readonly string[] = ["member", "admin"];
const MEMBER_STATUSES: readonly string[] = ["invited", "active", "suspended", "revoked"];
const KINDS: readonly string[] = ["ordinary", "external"];

function now(): string {
  return new Date().toISOString();
}

/** Instance admins: comma-separated user IDs from env (install state, never
 * Git). Compared lowercased, like every other user ID in this module. */
export function instanceAdmins(env: AdminEnv): ReadonlySet<string> {
  return new Set(
    (env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function parseOrgName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 128) {
    throw new Fault(400, "INVALID_ORG_NAME", "Organization name must be 1 to 128 characters.");
  }
  return name.trim();
}

/** User IDs are Access emails (lowercased by verification) or LAB UUIDs.
 * Anything else is rejected before it can become a membership row. */
export function parseUserId(value: unknown): string {
  if (typeof value !== "string") throw new Fault(400, "INVALID_USER_ID", "A user ID string is required.");
  const id = value.trim().toLowerCase();
  if (id.length === 0 || id.length > 320 || /[\s<>"]/.test(id)) {
    throw new Fault(400, "INVALID_USER_ID", "A user ID of 1 to 320 characters without whitespace is required.");
  }
  return id;
}

export function parseOrgId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value.trim().toLowerCase())) {
    throw new Fault(400, "INVALID_ORG_ID", "Organization ID must be a UUID.");
  }
  return value.trim().toLowerCase();
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function toOrgSummary(row: OrgRow): OrgSummary {
  const status = (row as { status?: string }).status === "disabled" ? "disabled" : "active";
  return { id: row.id, name: row.name, status, createdAt: row.created_at, disabledAt: row.disabled_at };
}

function toMember(row: MembershipRow): MemberRow {
  return {
    userId: row.user_id,
    role: (row.role === "admin" ? "admin" : "member") as OrgRole,
    status: MEMBER_STATUSES.includes(row.status) ? (row.status as MembershipStatus) : "suspended",
    kind: (row.kind === "external" ? "external" : "ordinary") as MembershipKind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getOrg(db: D1Database, orgId: string): Promise<OrgRow | null> {
  try {
    return await db.prepare("SELECT * FROM organizations WHERE id=?").bind(orgId).first<OrgRow>();
  } catch (error) {
    if (isMissingTable(error)) {
      throw new Fault(503, "ORG_STORE_NOT_MIGRATED", "Organization storage is not migrated: apply migration 0007.");
    }
    throw error;
  }
}

/**
 * Membership gate for every /api/* request. Resolves the effective
 * Organization (explicit X-Organization-Id selection or the auth-context org),
 * then fails closed: unknown orgs and non-members answer 404 (no existence
 * leak), while suspended/revoked memberships, disabled users, and disabled
 * orgs answer 403. Invited memberships activate on first verified use.
 * Scope selection can never elevate: selection only narrows to Organizations
 * the caller already belongs to (or instance-admin recovery).
 */
export async function resolveCaller(
  db: D1Database,
  env: AdminEnv,
  principal: Principal,
  requestedOrgId?: string,
): Promise<CallerCtx> {
  const orgId = requestedOrgId ?? principal.orgId;
  let org: OrgRow | null;
  try {
    org = await getOrg(db, orgId);
  } catch (error) {
    // Pre-migration database: the organizations table predates the status
    // column. Reading through the failure answers 503 with the migration
    // code instead of leaking driver text.
    if (isMissingTable(error)) {
      throw new Fault(503, "ORG_STORE_NOT_MIGRATED", "Organization storage is not migrated: apply migration 0007.");
    }
    throw error;
  }
  if (!org) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  // Pre-migration rows predate the status column: treat a missing status as
  // active so old databases fail on the users table (503) rather than here.
  const orgStatus = (org as { status?: string }).status ?? "active";
  const isInstanceAdmin = instanceAdmins(env).has(principal.userId);
  if (orgStatus === "disabled" && !isInstanceAdmin) {
    throw new Fault(403, "ORG_DISABLED", "This Organization is disabled.");
  }
  let user: UserRow | null;
  try {
    user = await db.prepare("SELECT * FROM users WHERE user_id=?").bind(principal.userId).first<UserRow>();
  } catch (error) {
    if (isMissingTable(error)) {
      throw new Fault(503, "ORG_STORE_NOT_MIGRATED", "Organization storage is not migrated: apply migration 0007.");
    }
    throw error;
  }
  if (!user) {
    if (isInstanceAdmin) {
      return {
        principal: { userId: principal.userId, orgId },
        role: null,
        kind: null,
        isInstanceAdmin,
        isOrgAdmin: false,
      };
    }
    throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  }
  // Disabled users are denied — except the instance admin list, which must
  // stay usable for recovery (including self-disable recovery). Instance
  // admin is env-held install state, so this is not a membership bypass.
  if (user.status !== "active" && !isInstanceAdmin) {
    throw new Fault(403, "USER_DISABLED", "This user is disabled.");
  }
  let membership: MembershipRow | null;
  try {
    membership = await db
      .prepare("SELECT * FROM org_memberships WHERE org_id=? AND user_id=?")
      .bind(orgId, principal.userId)
      .first<MembershipRow>();
  } catch (error) {
    if (isMissingTable(error)) {
      throw new Fault(503, "ORG_STORE_NOT_MIGRATED", "Organization storage is not migrated: apply migration 0007.");
    }
    throw error;
  }
  if (!membership) {
    if (isInstanceAdmin) {
      return {
        principal: { userId: principal.userId, orgId },
        role: null,
        kind: null,
        isInstanceAdmin,
        isOrgAdmin: false,
      };
    }
    throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  }
  if (membership.status === "suspended") throw new Fault(403, "MEMBERSHIP_SUSPENDED", "Membership is suspended.");
  if (membership.status === "revoked") throw new Fault(403, "MEMBERSHIP_REVOKED", "Membership is revoked.");
  if (membership.status === "invited") {
    // Invitation consumed by first verified use: the identity is proven by
    // Access/LAB verification above, so flip invited -> active here.
    await db
      .prepare(
        "UPDATE org_memberships SET status='active',updated_at=? WHERE org_id=? AND user_id=? AND status='invited'",
      )
      .bind(now(), orgId, principal.userId)
      .run();
    membership = { ...membership, status: "active" };
  }
  if (membership.status !== "active") throw new Fault(403, "MEMBERSHIP_SUSPENDED", "Membership is not active.");
  const member = toMember(membership);
  return {
    principal: { userId: principal.userId, orgId },
    role: member.role,
    kind: member.kind,
    isInstanceAdmin,
    isOrgAdmin: member.role === "admin",
  };
}

export function requireInstanceAdmin(ctx: CallerCtx): void {
  if (!ctx.isInstanceAdmin) throw new Fault(403, "ADMIN_ONLY", "Instance admin only.");
}

/**
 * User-level gate for collection routes (GET/POST /api/orgs) that address no
 * single Organization. Any known active user (or instance admin) passes with
 * an org-agnostic context; unknown identities get the same 404 as strangers
 * elsewhere. Callers still need instance admin for POST — enforced by the
 * route, not here.
 */
export async function resolveUser(db: D1Database, env: AdminEnv, principal: Principal): Promise<CallerCtx> {
  const isInstanceAdmin = instanceAdmins(env).has(principal.userId);
  let user: UserRow | null;
  try {
    user = await db.prepare("SELECT * FROM users WHERE user_id=?").bind(principal.userId).first<UserRow>();
  } catch (error) {
    if (isMissingTable(error)) {
      throw new Fault(503, "ORG_STORE_NOT_MIGRATED", "Organization storage is not migrated: apply migration 0007.");
    }
    throw error;
  }
  if (!user) {
    if (isInstanceAdmin) {
      return { principal, role: null, kind: null, isInstanceAdmin, isOrgAdmin: false };
    }
    throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  }
  if (user.status !== "active" && !isInstanceAdmin) {
    throw new Fault(403, "USER_DISABLED", "This user is disabled.");
  }
  return { principal, role: null, kind: null, isInstanceAdmin, isOrgAdmin: false };
}

/** True when the caller may administer an Organization: instance admin, or an
 * active admin membership in that Organization. Never consults the caller's
 * selected org — the target org is always checked directly, so selecting
 * another org cannot smuggle admin rights across the boundary. */
export async function canManageOrg(db: D1Database, ctx: CallerCtx, orgId: string): Promise<boolean> {
  // Instance admins manage every org including disabled ones (recovery).
  // User-status was already enforced in resolveCaller, so no re-check here.
  if (ctx.isInstanceAdmin) return true;
  const membership = await db
    .prepare("SELECT role,status FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(orgId, ctx.principal.userId)
    .first<{ role: string; status: string }>();
  if (!membership || membership.status !== "active" || membership.role !== "admin") return false;
  const user = await db.prepare("SELECT status FROM users WHERE user_id=?").bind(ctx.principal.userId).first<UserRow>();
  return !user || user.status === "active";
}

export async function requireManageOrg(db: D1Database, ctx: CallerCtx, orgId: string): Promise<void> {
  if (!(await canManageOrg(db, ctx, orgId))) throw new Fault(403, "ADMIN_ONLY", "Organization admin only.");
}

export async function createOrg(db: D1Database, name: string): Promise<OrgSummary> {
  const clean = parseOrgName(name);
  const existing = await db.prepare("SELECT id FROM organizations WHERE name=?").bind(clean).first<{ id: string }>();
  if (existing) throw new Fault(409, "ORG_EXISTS", "An Organization with this name already exists.");
  const id = crypto.randomUUID().toLowerCase();
  const created = now();
  await db
    .prepare("INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,?,'active',?,NULL)")
    .bind(id, clean, created)
    .run();
  return { id, name: clean, status: "active", createdAt: created, disabledAt: null };
}

export async function getOrgSummary(db: D1Database, orgId: string): Promise<OrgSummary> {
  const org = await getOrg(db, parseOrgId(orgId));
  if (!org) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  return toOrgSummary(org);
}

/** Organizations visible to the caller: everything for instance admins, only
 * live memberships otherwise. Revoked rows stay hidden. */
export async function listOrgs(db: D1Database, ctx: CallerCtx): Promise<OrgSummary[]> {
  try {
    if (ctx.isInstanceAdmin) {
      const rows = await db.prepare("SELECT * FROM organizations ORDER BY name").all<OrgRow>();
      return rows.results.map(toOrgSummary);
    }
    const rows = await db
      .prepare(
        "SELECT o.* FROM organizations o JOIN org_memberships m ON m.org_id=o.id WHERE m.user_id=? AND m.status IN ('invited','active','suspended') ORDER BY o.name",
      )
      .bind(ctx.principal.userId)
      .all<OrgRow>();
    return rows.results.map(toOrgSummary);
  } catch (error) {
    if (isMissingTable(error)) {
      throw new Fault(503, "ORG_STORE_NOT_MIGRATED", "Organization storage is not migrated: apply migration 0007.");
    }
    throw error;
  }
}

export async function setOrgStatus(db: D1Database, orgId: string, disabled: boolean): Promise<OrgSummary> {
  const id = parseOrgId(orgId);
  const org = await getOrg(db, id);
  if (!org) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  const stamp = now();
  await db
    .prepare("UPDATE organizations SET status=?,disabled_at=? WHERE id=?")
    .bind(disabled ? "disabled" : "active", disabled ? stamp : null, id)
    .run();
  const updated = await getOrg(db, id);
  if (!updated) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  return toOrgSummary(updated);
}

export async function listMembers(db: D1Database, orgId: string): Promise<MemberRow[]> {
  const id = parseOrgId(orgId);
  const org = await getOrg(db, id);
  if (!org) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  const rows = await db
    .prepare("SELECT * FROM org_memberships WHERE org_id=? ORDER BY user_id")
    .bind(id)
    .all<MembershipRow>();
  return rows.results.map(toMember);
}

/**
 * Invite (onboard) a user into an Organization. Creates the user row when
 * unknown; disabled users cannot be (re-)invited. External-kind members can
 * never be admins — the check lives here and in updateMember so no path
 * elevates them. Re-inviting a revoked/suspended membership resets it to
 * invited; an already live membership conflicts.
 */
export async function inviteMember(
  db: D1Database,
  orgId: string,
  userId: string,
  role: OrgRole = "member",
  kind: MembershipKind = "ordinary",
): Promise<MemberRow> {
  const id = parseOrgId(orgId);
  const user = parseUserId(userId);
  if (!ROLES.includes(role)) throw new Fault(400, "INVALID_MEMBERSHIP", "Role must be member or admin.");
  if (!KINDS.includes(kind)) throw new Fault(400, "INVALID_MEMBERSHIP", "Kind must be ordinary or external.");
  if (kind === "external" && role === "admin") {
    throw new Fault(400, "INVALID_MEMBERSHIP", "External users cannot hold admin.");
  }
  const org = await getOrg(db, id);
  if (!org) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  if (org.status !== "active") throw new Fault(409, "ORG_DISABLED", "Cannot invite into a disabled Organization.");
  const userRow = await db.prepare("SELECT status FROM users WHERE user_id=?").bind(user).first<UserRow>();
  if (userRow && userRow.status !== "active") {
    throw new Fault(409, "USER_DISABLED", "Cannot invite a disabled user.");
  }
  const stamp = now();
  if (!userRow) {
    await db.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)").bind(user, stamp).run();
  }
  const existing = await db
    .prepare("SELECT status FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(id, user)
    .first<{ status: string }>();
  if (existing && (existing.status === "invited" || existing.status === "active")) {
    throw new Fault(409, "MEMBERSHIP_EXISTS", "This user already has a live membership.");
  }
  if (existing) {
    await db
      .prepare("UPDATE org_memberships SET role=?,status='invited',kind=?,updated_at=? WHERE org_id=? AND user_id=?")
      .bind(role, kind, stamp, id, user)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,?,'invited',?,?,?)",
      )
      .bind(id, user, role, kind, stamp, stamp)
      .run();
  }
  const row = await db
    .prepare("SELECT * FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(id, user)
    .first<MembershipRow>();
  if (!row) throw new Fault(500, "INTERNAL_ERROR", "The request could not be completed.");
  return toMember(row);
}

export interface MemberUpdate {
  readonly role?: OrgRole;
  readonly status?: MembershipStatus;
  readonly kind?: MembershipKind;
}

/** Change role/status/kind. Unknown keys are rejected by the route parser, so
 * this only sees the three known fields. Guards: external+admin is refused,
 * and the last active admin cannot be demoted, suspended, or revoked. */
export async function updateMember(
  db: D1Database,
  orgId: string,
  userId: string,
  update: MemberUpdate,
): Promise<MemberRow> {
  const id = parseOrgId(orgId);
  const user = parseUserId(userId);
  if (update.role !== undefined && !ROLES.includes(update.role)) {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Role must be member or admin.");
  }
  if (update.status !== undefined && !MEMBER_STATUSES.includes(update.status)) {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Status must be invited, active, suspended, or revoked.");
  }
  if (update.kind !== undefined && !KINDS.includes(update.kind)) {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Kind must be ordinary or external.");
  }
  if (update.role === undefined && update.status === undefined && update.kind === undefined) {
    throw new Fault(400, "INVALID_MEMBERSHIP", "Provide role, status, or kind to change.");
  }
  const current = await db
    .prepare("SELECT * FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(id, user)
    .first<MembershipRow>();
  if (!current) throw new Fault(404, "USER_NOT_FOUND", "No membership for this user.");
  const nextRole = update.role ?? current.role;
  const nextKind = update.kind ?? current.kind;
  const nextStatus = update.status ?? current.status;
  if (nextKind === "external" && nextRole === "admin") {
    throw new Fault(400, "INVALID_MEMBERSHIP", "External users cannot hold admin.");
  }
  const wasLiveAdmin = current.role === "admin" && current.status === "active";
  const staysLiveAdmin = nextRole === "admin" && nextStatus === "active";
  if (wasLiveAdmin && !staysLiveAdmin) {
    const others = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM org_memberships WHERE org_id=? AND user_id!=? AND role='admin' AND status='active'",
      )
      .bind(id, user)
      .first<{ n: number }>();
    if (!others || others.n === 0) {
      throw new Fault(409, "LAST_ADMIN", "Promote another admin before removing the last one.");
    }
  }
  await db
    .prepare("UPDATE org_memberships SET role=?,status=?,kind=?,updated_at=? WHERE org_id=? AND user_id=?")
    .bind(nextRole, nextStatus, nextKind, now(), id, user)
    .run();
  const row = await db
    .prepare("SELECT * FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(id, user)
    .first<MembershipRow>();
  if (!row) throw new Fault(404, "USER_NOT_FOUND", "No membership for this user.");
  return toMember(row);
}

export async function setUserStatus(
  db: D1Database,
  userId: string,
  disabled: boolean,
): Promise<{ userId: string; status: UserStatus }> {
  const user = parseUserId(userId);
  const row = await db.prepare("SELECT status FROM users WHERE user_id=?").bind(user).first<UserRow>();
  if (!row) throw new Fault(404, "USER_NOT_FOUND", "User not found.");
  // Disabling is self-applicable (an admin can disable themselves and is
  // denied on the next request); recovery is by a second admin or direct DB
  // access, which the lifecycle test exercises explicitly.
  await db
    .prepare("UPDATE users SET status=?,disabled_at=? WHERE user_id=?")
    .bind(disabled ? "disabled" : "active", disabled ? now() : null, user)
    .run();
  return { userId: user, status: disabled ? "disabled" : "active" };
}

/**
 * LAB bootstrap (local/CI only): ensure the fixture identity exists as an
 * active ordinary user with an active admin membership in the fixture org,
 * creating user/org/membership rows when missing. Disabled orgs/users are
 * never resurrected here — failing closed preserves deactivation tests that
 * run against the same binding.
 *
 * Test databases built from older migrations predate the org tables entirely.
 * Creating them here (CREATE TABLE IF NOT EXISTS, migration 0007 shape) keeps
 * the pre-existing suite passing unmodified: the ADR-014 allowlist era never
 * had these tables, and production always migrates them via
 * `migrations_dir`, so absence only means a hand-built local/test database.
 * Anything that is not the LAB fixture identity still fails closed with
 * ORG_STORE_NOT_MIGRATED in resolveCaller/resolveUser below.
 */
export async function ensureLabFixture(db: D1Database, orgId: string, userId: string): Promise<void> {
  const org = parseOrgId(orgId);
  const user = parseUserId(userId);
  // Bootstrap the migration-0007 tables when a hand-built database predates
  // them (older-migration test databases, or none at all). Column lists mirror
  // migrations/0001_initial.sql plus migrations/0007_org_membership.sql. Each
  // statement is independent: ALTERs fail on already-migrated databases,
  // CREATEs are IF NOT EXISTS, and D1 applies exec batches statement by
  // statement, so failures must never abort the survivors.
  const stmts = [
    "CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',disabled_at TEXT)",
    "ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE organizations ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
    "ALTER TABLE organizations ADD COLUMN disabled_at TEXT",
    "CREATE TABLE IF NOT EXISTS users(user_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,disabled_at TEXT)",
    "CREATE TABLE IF NOT EXISTS org_memberships(org_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT NOT NULL REFERENCES users(user_id),role TEXT NOT NULL DEFAULT 'member',status TEXT NOT NULL DEFAULT 'invited',kind TEXT NOT NULL DEFAULT 'ordinary',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,user_id))",
    "CREATE INDEX IF NOT EXISTS org_memberships_user ON org_memberships(user_id,status)",
    "CREATE INDEX IF NOT EXISTS org_memberships_org ON org_memberships(org_id,status)",
  ];
  for (const ddl of stmts) {
    try {
      await db.exec(ddl);
    } catch {
      // Already-migrated databases reject the duplicate-column ALTERs; the
      // rows below only need the tables to exist.
    }
  }
  const existing = await getOrg(db, org);
  if (existing && existing.status !== "active") return;
  const userRow = await db.prepare("SELECT status FROM users WHERE user_id=?").bind(user).first<UserRow>();
  if (userRow && userRow.status !== "active") return;
  const stamp = now();
  if (!existing) {
    await db
      .prepare("INSERT INTO organizations(id,name,status,created_at,disabled_at) VALUES (?,?,'active',?,NULL)")
      .bind(org, "Local demo", stamp)
      .run();
  }
  if (!userRow) {
    await db.prepare("INSERT INTO users(user_id,status,created_at) VALUES (?,'active',?)").bind(user, stamp).run();
  }
  const membership = await db
    .prepare("SELECT status FROM org_memberships WHERE org_id=? AND user_id=?")
    .bind(org, user)
    .first<{ status: string }>();
  if (!membership) {
    await db
      .prepare(
        "INSERT INTO org_memberships(org_id,user_id,role,status,kind,created_at,updated_at) VALUES (?,?,'admin','active','ordinary',?,?)",
      )
      .bind(org, user, stamp, stamp)
      .run();
  } else if (membership.status !== "active") {
    await db
      .prepare(
        "UPDATE org_memberships SET role='admin',status='active',kind='ordinary',updated_at=? WHERE org_id=? AND user_id=?",
      )
      .bind(stamp, org, user)
      .run();
  }
}

export interface DeletePreview {
  readonly orgId: string;
  readonly orgName: string;
  readonly executions: number;
  readonly operations: number;
  readonly connectionsLoose: number;
  readonly connectionsManaged: number;
  readonly bundleInstalls: number;
  readonly memberships: number;
  /** Owned resources removed with the org (loose rows plus dependents). */
  readonly forms: number;
  readonly apps: number;
  readonly appsManaged: number;
  readonly tables: number;
  readonly tableRows: number;
  readonly fileLocations: number;
  readonly files: number;
  readonly artifacts: number;
  readonly endpoints: number;
  readonly configsLoose: number;
  readonly configsManaged: number;
  readonly auditEvents: number;
  readonly notifications: number;
  readonly bundleActive: number;
  readonly bundleOwnedRows: number;
  /** ExecutionHistory (executions + operations) is always retained. */
  readonly retained: readonly string[];
  readonly canDelete: boolean;
  readonly blockedBy: readonly string[];
}

async function count(db: D1Database, sql: string, ...binds: (string | number)[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Tolerant count for tables that postdate AUTH-01 (#142): 0 when the
 * migration has not been applied, so old databases preview cleanly. Real
 * query errors still throw. */
async function optionalCount(db: D1Database, sql: string, ...binds: (string | number)[]): Promise<number> {
  try {
    return await count(db, sql, ...binds);
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

/** Tolerant delete for the same post-AUTH-01 tables. */
async function optionalExec(db: D1Database, sql: string, ...binds: (string | number)[]): Promise<void> {
  try {
    await db
      .prepare(sql)
      .bind(...binds)
      .run();
  } catch (error) {
    if (isMissingTable(error)) return;
    throw error;
  }
}

/** Tolerant select for the same post-AUTH-01 tables. */
async function selectAll<T>(db: D1Database, sql: string, ...binds: (string | number)[]): Promise<T[]> {
  try {
    const rows = await db
      .prepare(sql)
      .bind(...binds)
      .all<T>();
    return rows.results;
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** R2 key for a managed file object. The canonical layout lives in files.ts
 * objectKey; duplicated here so the org lifecycle owns its delete path
 * without importing the FILE-01 lane. */
function fileObjectKey(orgId: string, location: string, path: string): string {
  return `${orgId}/${location}/${path}`;
}

/** R2 key for one artifact version. The canonical layout lives in
 * artifacts.ts artifactObjectKey; duplicated here for the same reason. */
function artifactObjectKey(artifactId: string, version: number): string {
  return `artifacts/${artifactId}/v${version}`;
}

export interface OrgDeleteStores {
  readonly files?: R2Bucket | null;
  readonly artifacts?: R2Bucket | null;
}

/**
 * Cascading-delete preview: counts everything the delete path would touch and
 * names what is retained. ExecutionHistory rows are never deleted — the
 * executions/operations tables keep their rows (dangling org_id, unreachable
 * through the API once the org row is gone).
 *
 * Managed Connections, bundle install records, and Solution-owned rows
 * (solution-owned apps, managed bundle rows) block deletion until the owning
 * bundle is uninstalled. Every other org-owned row (forms, loose apps,
 * tables, files, artifacts, endpoints, configs, audit) is counted and removed
 * with the org; the empty-tables fallback (`.catch(() => 0)`) keeps old
 * databases previewing cleanly.
 */
export async function deletePreview(db: D1Database, orgId: string): Promise<DeletePreview> {
  const id = parseOrgId(orgId);
  const org = await getOrg(db, id);
  if (!org) throw new Fault(404, "ORG_NOT_FOUND", "Organization not found.");
  const executions = await count(db, "SELECT COUNT(*) AS n FROM executions WHERE org_id=?", id);
  const operations = await count(
    db,
    "SELECT COUNT(*) AS n FROM operations WHERE execution_id IN (SELECT id FROM executions WHERE org_id=?)",
    id,
  );
  const loose = await count(
    db,
    "SELECT COUNT(*) AS n FROM connections WHERE org_id=? AND managed_by IS NULL",
    id,
  ).catch(async () => count(db, "SELECT COUNT(*) AS n FROM connections WHERE org_id=?", id));
  const managed = await count(
    db,
    "SELECT COUNT(*) AS n FROM connections WHERE org_id=? AND managed_by IS NOT NULL",
    id,
  ).catch(() => 0);
  const installs = await count(db, "SELECT COUNT(*) AS n FROM bundle_installs WHERE org_id=?", id).catch(() => 0);
  const memberships = await count(db, "SELECT COUNT(*) AS n FROM org_memberships WHERE org_id=?", id);
  const forms = await optionalCount(db, "SELECT COUNT(*) AS n FROM forms WHERE org_id=?", id);
  const apps = await optionalCount(db, "SELECT COUNT(*) AS n FROM apps WHERE org_id=?", id);
  const appsManaged = await optionalCount(
    db,
    "SELECT COUNT(*) AS n FROM apps WHERE org_id=? AND owner_kind='solution'",
    id,
  );
  const tables = await optionalCount(db, "SELECT COUNT(*) AS n FROM tables WHERE org_id=?", id);
  const tableRows = await optionalCount(db, "SELECT COUNT(*) AS n FROM table_rows WHERE org_id=?", id);
  const fileLocations = await optionalCount(db, "SELECT COUNT(*) AS n FROM file_locations WHERE org_id=?", id);
  const files = await optionalCount(db, "SELECT COUNT(*) AS n FROM files WHERE org_id=?", id);
  const artifacts = await optionalCount(db, "SELECT COUNT(*) AS n FROM artifacts WHERE org_id=?", id);
  const endpoints = await optionalCount(db, "SELECT COUNT(*) AS n FROM endpoints WHERE org_id=?", id);
  const configsLoose = await optionalCount(
    db,
    "SELECT COUNT(*) AS n FROM configs WHERE org_id=? AND managed_by IS NULL",
    id,
  );
  const configsManaged = await optionalCount(
    db,
    "SELECT COUNT(*) AS n FROM configs WHERE org_id=? AND managed_by IS NOT NULL",
    id,
  ).catch(() => 0);
  const auditEvents = await optionalCount(db, "SELECT COUNT(*) AS n FROM audit_events WHERE org_id=?", id);
  const notifications = await optionalCount(db, "SELECT COUNT(*) AS n FROM notifications WHERE org_id=?", id);
  const bundleActive = await optionalCount(db, "SELECT COUNT(*) AS n FROM bundle_active WHERE org_id=?", id);
  const bundleConfig = await optionalCount(db, "SELECT COUNT(*) AS n FROM bundle_config WHERE org_id=?", id);
  const bundleSagas = await optionalCount(db, "SELECT COUNT(*) AS n FROM bundle_sagas WHERE org_id=?", id);
  const blockedBy: string[] = [];
  if (managed > 0) blockedBy.push(`${managed} managed Connection(s): uninstall the owning bundle first.`);
  if (installs > 0) blockedBy.push(`${installs} bundle install record(s): uninstall bundles first.`);
  if (appsManaged > 0) blockedBy.push(`${appsManaged} Solution-owned app(s): uninstall the owning bundle first.`);
  const bundleOwnedRows = bundleActive + bundleConfig + bundleSagas;
  if (bundleOwnedRows > 0) {
    blockedBy.push(`${bundleOwnedRows} managed bundle row(s): uninstall bundles first.`);
  }
  if (configsManaged > 0) {
    blockedBy.push(`${configsManaged} managed config(s): uninstall the owning bundle first.`);
  }
  return {
    orgId: id,
    orgName: org.name,
    executions,
    operations,
    connectionsLoose: loose,
    connectionsManaged: managed,
    bundleInstalls: installs,
    memberships,
    forms,
    apps,
    appsManaged,
    tables,
    tableRows,
    fileLocations,
    files,
    artifacts,
    endpoints,
    configsLoose,
    configsManaged,
    auditEvents,
    notifications,
    bundleActive,
    bundleOwnedRows,
    retained: ["executions", "operations"],
    canDelete: blockedBy.length === 0,
    blockedBy: Object.freeze(blockedBy),
  };
}

export interface OrgDeleteResult {
  readonly orgId: string;
  readonly deletedMemberships: number;
  readonly deletedConnections: number;
  readonly deletedForms: number;
  readonly deletedApps: number;
  readonly deletedTables: number;
  readonly deletedTableRows: number;
  readonly deletedFileLocations: number;
  readonly deletedFiles: number;
  readonly deletedArtifacts: number;
  readonly deletedArtifactBindings: number;
  readonly deletedEndpoints: number;
  readonly deletedConfigs: number;
  readonly deletedNotifications: number;
  readonly deletedFileObjects: number;
  readonly deletedArtifactObjects: number;
}

/** Delete an Organization: removes memberships, loose Connections, and every
 * other org-owned row the preview counts, plus the org row itself.
 *
 * Refuses while managed Connections, bundle installs, Solution-owned apps,
 * managed bundle rows, or managed configs exist. ExecutionHistory is retained,
 * never cascaded. Audit events are retained for the same reason (audit of a
 * deleted org must outlive it); notifications are org-scoped inbox rows and
 * are removed.
 *
 * R2 bytes go first (FILES/FINAL objects, then artifact versions): an
 * interruption between the byte deletes and the D1 batch leaves D1 rows the
 * next delete (or artifact retention cleanup) picks up, never a deleted org
 * over surviving bytes. R2 deletes are idempotent. Missing buckets are a
 * 503: bytes must not be silently abandoned. */
export async function deleteOrg(db: D1Database, orgId: string, stores?: OrgDeleteStores): Promise<OrgDeleteResult> {
  const preview = await deletePreview(db, orgId);
  if (!preview.canDelete) {
    throw new Fault(409, "DELETE_BLOCKED", `Organization cannot be deleted: ${preview.blockedBy.join(" ")}`);
  }
  const id = preview.orgId;
  let deletedFileObjects = 0;
  let deletedArtifactObjects = 0;
  const fileRows = await selectAll<{ location: string; path: string }>(
    db,
    "SELECT location, path FROM files WHERE org_id=?",
    id,
  );
  if (fileRows.length > 0) {
    const files = stores?.files ?? null;
    if (!files) throw new Fault(503, "ORG_DELETE_STORE_MISSING", "File bytes cannot be removed: FILES is unavailable.");
    for (const row of fileRows) {
      await files.delete(fileObjectKey(id, row.location, row.path));
      deletedFileObjects += 1;
    }
  }
  const staging = await selectAll<{ staging_key: string | null }>(
    db,
    "SELECT staging_key FROM file_capabilities WHERE org_id=? AND staging_key IS NOT NULL",
    id,
  );
  if (staging.length > 0) {
    const files = stores?.files ?? null;
    if (!files) throw new Fault(503, "ORG_DELETE_STORE_MISSING", "File bytes cannot be removed: FILES is unavailable.");
    for (const row of staging) {
      if (row.staging_key) {
        await files.delete(row.staging_key);
        deletedFileObjects += 1;
      }
    }
  }
  const artifactRows = await selectAll<{ id: string; version: number }>(
    db,
    "SELECT id, version FROM artifacts WHERE org_id=?",
    id,
  );
  if (artifactRows.length > 0) {
    const artifacts = stores?.artifacts ?? null;
    if (!artifacts) {
      throw new Fault(503, "ORG_DELETE_STORE_MISSING", "Artifact bytes cannot be removed: ARTIFACTS is unavailable.");
    }
    for (const row of artifactRows) {
      const versions = await selectAll<{ version: number }>(
        db,
        "SELECT version FROM artifact_versions WHERE artifact_id=?",
        row.id,
      );
      const seen = new Set<number>();
      const keys: string[] = [];
      for (const entry of versions) {
        if (!seen.has(entry.version)) {
          seen.add(entry.version);
          keys.push(artifactObjectKey(row.id, entry.version));
        }
      }
      if (!seen.has(row.version)) keys.push(artifactObjectKey(row.id, row.version));
      for (const key of keys) {
        await artifacts.delete(key);
        deletedArtifactObjects += 1;
      }
    }
  }
  const artifactIds = await selectAll<{ id: string }>(db, "SELECT id FROM artifacts WHERE org_id=?", id);
  let deletedArtifactBindings = 0;
  if (artifactIds.length > 0) {
    const placeholders = artifactIds.map(() => "?").join(",");
    const bound = await db
      .prepare(`SELECT COUNT(*) AS n FROM artifact_bindings WHERE artifact_id IN (${placeholders})`)
      .bind(...artifactIds.map((row) => row.id))
      .first<{ n: number }>()
      .catch(() => ({ n: 0 }));
    deletedArtifactBindings = bound?.n ?? 0;
  }
  const tableIds = await selectAll<{ id: string }>(db, "SELECT id FROM tables WHERE org_id=?", id);
  // Core tables exist on every migrated database (forms is 0005, before the
  // 0007 org store). Everything newer than AUTH-01 goes through optionalExec
  // so old databases delete cleanly.
  await db.batch([
    db.prepare("DELETE FROM org_memberships WHERE org_id=?").bind(id),
    db.prepare("DELETE FROM connections WHERE org_id=?").bind(id),
    db.prepare("DELETE FROM forms WHERE org_id=?").bind(id),
  ]);
  await optionalExec(db, "DELETE FROM file_capabilities WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM file_policies WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM files WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM file_locations WHERE org_id=?", id);
  await optionalExec(
    db,
    "DELETE FROM endpoint_events WHERE endpoint_id IN (SELECT id FROM endpoints WHERE org_id=?)",
    id,
  );
  await optionalExec(
    db,
    "DELETE FROM endpoint_rate_windows WHERE endpoint_id IN (SELECT id FROM endpoints WHERE org_id=?)",
    id,
  );
  await optionalExec(db, "DELETE FROM endpoints WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM configs WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM notifications WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM table_grants WHERE table_id IN (SELECT id FROM tables WHERE org_id=?)", id);
  await optionalExec(db, "DELETE FROM table_rows WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM tables WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM artifact_retention WHERE org_id=?", id);
  if (tableIds.length > 0) {
    // D1 batch() caps at ~100 statements; grants/rows keyed by org are
    // already gone above, so only per-table overflow rows remain here.
    for (const table of tableIds) {
      await optionalExec(db, "DELETE FROM table_grants WHERE table_id=?", table.id);
      await optionalExec(db, "DELETE FROM table_rows WHERE table_id=?", table.id);
    }
  }
  for (const row of artifactIds) {
    await optionalExec(db, "DELETE FROM artifact_bindings WHERE artifact_id=?", row.id);
    await optionalExec(db, "DELETE FROM artifact_versions WHERE artifact_id=?", row.id);
  }
  await optionalExec(db, "DELETE FROM artifacts WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM app_rows WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM app_file_tokens WHERE file_id IN (SELECT id FROM app_files WHERE org_id=?)", id);
  await optionalExec(db, "DELETE FROM app_files WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM app_tables WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM app_grants WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM app_executions WHERE org_id=?", id);
  await optionalExec(db, "DELETE FROM app_jobs WHERE app_id IN (SELECT id FROM apps WHERE org_id=?)", id);
  await optionalExec(db, "DELETE FROM app_deployments WHERE app_id IN (SELECT id FROM apps WHERE org_id=?)", id);
  await optionalExec(db, "DELETE FROM app_revisions WHERE app_id IN (SELECT id FROM apps WHERE org_id=?)", id);
  await optionalExec(db, "DELETE FROM apps WHERE org_id=?", id);
  await db.batch([db.prepare("DELETE FROM organizations WHERE id=?").bind(id)]);
  return {
    orgId: id,
    deletedMemberships: preview.memberships,
    deletedConnections: preview.connectionsLoose,
    deletedForms: preview.forms,
    deletedApps: preview.apps,
    deletedTables: preview.tables,
    deletedTableRows: preview.tableRows,
    deletedFileLocations: preview.fileLocations,
    deletedFiles: preview.files,
    deletedArtifacts: preview.artifacts,
    deletedArtifactBindings,
    deletedEndpoints: preview.endpoints,
    deletedConfigs: preview.configsLoose,
    deletedNotifications: preview.notifications,
    deletedFileObjects,
    deletedArtifactObjects,
  };
}

const ADMIN_HISTORY_COLUMNS =
  "id,saga_id,saga_name,saga_revision,org_id,user_id,dispatched,status,created_at,started_at,completed_at";

/** Org-scoped ExecutionHistory for administrators (AUTH-01 admin surface).
 * Same filters/cursor shape as the owner listing, minus the user fence — so
 * an org admin can see in-flight jobs after a member is revoked. Ordinary
 * members never reach this: routes gate on requireManageOrg. */
export async function listOrgHistory(
  db: D1Database,
  orgId: string,
  query: HistoryQuery,
): Promise<{ executions: ReturnType<typeof summary>[]; hasMore: boolean; nextCursor: string | null }> {
  const clauses = ["org_id=?"];
  const binds: (string | number)[] = [parseOrgId(orgId)];
  if (query.statuses.length > 0) {
    clauses.push(`status IN (${query.statuses.map(() => "?").join(",")})`);
    binds.push(...query.statuses);
  }
  if (query.sagaId !== undefined) {
    clauses.push("saga_id=?");
    binds.push(query.sagaId);
  }
  if (query.cursor !== undefined) {
    clauses.push("((created_at < ?) OR (created_at = ? AND id < ?))");
    binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT ${ADMIN_HISTORY_COLUMNS} FROM executions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<Omit<ExecutionRow, "input_json" | "result_json" | "error_json">>();
  const page = rows.results.slice(0, query.limit);
  const hasMore = rows.results.length > query.limit;
  const last = page[page.length - 1];
  return {
    executions: page.map(summary),
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeHistoryCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
