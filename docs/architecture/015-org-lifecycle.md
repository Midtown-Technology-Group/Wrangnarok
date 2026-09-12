# ADR 015: Organization and User Lifecycle (AUTH-01)

- **Status:** Accepted
- **Date:** 2026-09-11
- **Extends:** ADR 014 (Access authentication), ADR 003 (Integrations and Connections), ADR 005 (secret storage), `docs/upstream-spec.md` auth rows, `docs/upstream-parity.md` AUTH-01
- **Steward review requested** on the implementing PR (security-adjacent; Phase 3 gate).

## Context

ADR 014 verified human identity via Cloudflare Access (`Cf-Access-Jwt-Assertion`, verified in-Worker) and mapped
verified emails to a single `ACCESS_ORG_ID` behind an `ACCESS_ALLOWED_EMAILS` allowlist. That allowlist is deploy-time
configuration, not Organization membership: there are no Organizations to create, no invitations, no roles, no
revocation short of redeploy, and no multi-organization users.

Upstream Bifrost (`api/src/routers/organizations.py`, `api/src/routers/users.py`, `api/src/core/auth.py`) has real
lifecycle: Organizations are created/disabled/deleted, users are onboarded/invited/suspended/revoked, invitations are
consumed, cascading deletes preview retained ExecutionHistory, and bulk user operations exist. Wrangnarok keeps Access
as the identity source and the `Principal` (`{userId, orgId}`) as the immutable caller context, and ports the
lifecycle semantics onto D1 (Worker + Workflows + D1 only; no new primitive).

## Decision

### Principals

- A **principal** is the verified caller identity: `{userId, orgId}` as today. `userId` is the lowercased Access
  email, a `service:<client-id>` service identity, or the LAB fixture user UUID. `orgId` is the effective
  Organization after scope selection (below). Access verification and LAB fixture handling are unchanged (ADR 014).
- Principals are identity, not permission. What a principal may do is resolved per request from D1 membership rows
  (`resolveCaller`), never embedded in the identity itself.

### Organization membership and provider scope

- `organizations(id, name, status, created_at, disabled_at)`: `status` is `active` or `disabled`. Names are unique,
  1 to 128 characters. Disabling is reversible; deletion removes the row (see cascading rules).
- `users(user_id, status, created_at, disabled_at)`: a global identity ledger keyed by the same `userId` string the
  `Principal` carries. Disabling a user denies every Organization at the gate (403 `USER_DISABLED`), distinct from
  per-Organization revocation.
- `org_memberships(org_id, user_id, role, status, kind, created_at, updated_at)`: the authorization gate.
  `role` is `member` or `admin`. `status` is `invited`, `active`, `suspended`, or `revoked`. `kind` is `ordinary`
  or `external`. An invited membership activates on first verified use (invitation consumed); suspended/revoked
  memberships answer 403; non-members answer 404 (no existence leak: foreign orgs are indistinguishable from
  missing ones, preserving the owner-scoped 404-on-foreign discipline).
- **Scope selection cannot elevate:** callers may pass `X-Organization-Id` to select among Organizations they already
  belong to. Selection only narrows — a caller with no live membership in the target org gets the same 404 as a
  stranger. Admin routes (`/api/orgs/:id/…`) resolve the caller against the path-target org, not the header: an org
  admin acts on their own org without switching a header, and the target-org membership is always checked directly
  so selecting another org cannot smuggle admin rights across the boundary. Every Execution keeps its own stored
  `org_id`: in-flight jobs are unaffected by later membership changes and stay visible through the admin org
  history surface.
- **Provider scope is unchanged** by this ADR: Integration Connection resolution stays exact-org (`resolveConnection`
  already refuses cross-org fallback). Multi-Organization callers do not merge Connection visibility.

### Ordinary and external users

- **Ordinary users** are members (`kind: ordinary`) who may hold `member` or `admin` in an Organization.
- **External users** (`kind: external`) are first-class members for read/execute flows but can never hold `admin`:
  both `inviteMember` and `updateMember` refuse external+admin with `INVALID_MEMBERSHIP`. There is no path from
  external to admin without first changing kind, which itself requires admin rights over the target Organization.
- Upstream email-address user records map to Access-verified emails here: the app never stores passwords, never
  resets passwords (AUTH-03 owns sessions/keys; this ADR creates no session, cookie, or API-key surface).

### Administrative lifecycle

- **Instance admins** (`ADMIN_USER_IDS` env, comma-separated lowercased user IDs) create/disable Organizations,
  onboard users globally, and recover tenants where the last admin was lost. The value is install state like D1
  IDs: documented, never in Git. Instance admin is checked against the caller's user row directly, never through
  the selected Organization, so disabled orgs remain recoverable.
- **Organization admins** (active `admin` membership) invite members, change roles/status/kind, suspend/revoke,
  and read org-scoped ExecutionHistory (including in-flight jobs after a member is revoked). Ordinary members
  reach no admin route (`ADMIN_ONLY`).
- **Last-admin guard:** demoting, suspending, or revoking the last active admin of an Organization is refused
  (`LAST_ADMIN`). A stuck tenant is recovered by an instance admin.
- **No redeploy revocation:** every request re-resolves user status, org status, and membership status from D1.
  There are no server sessions or token TTLs in this design, so deactivation applies to the next request. Stale
  sessions cannot outlive the check because there is nothing stale to hold: identity is re-verified (Access) and
  authorization is re-read (D1) on every request. One deliberate exception: the env-held instance admin list stays
  usable while disabled, so a self-disabled admin (or a tenant with no live admin) is always recoverable without
  direct database surgery. Ordinary and org-admin callers get no such exception.
- **In-flight jobs:** Executions carry their own `org_id`/`user_id`. Revoking a member does not cancel, rewrite,
  or hide their rows: terminal checkpoints stay fenced on status (owner-cancel still wins), and the org admin
  history surface keeps the rows visible for audit. A revoked member's own owner-scoped reads fail at the gate.

### Cascading delete

- Deleting an Organization previews first (`GET /api/orgs/:id/delete-preview`): counts of Executions, Operations,
  loose vs managed Connections, bundle install records, memberships, forms, apps (independent vs Solution-owned),
  tables plus table rows, file locations plus files plus outstanding staging capabilities, artifacts (plus versions
  and bindings), endpoints plus delivery events, loose vs managed configs, audit events (retained), notifications,
  and managed bundle rows (active pointers, bundle config, bundle Sagas).
- **ExecutionHistory and audit events are always retained** (`retained: ["executions", "operations"]`): Execution,
  Operation, and audit-event rows are never deleted by the org-delete path. Once the org row is gone they are
  unreachable through the API (every read is org-gated) but remain for audit/restore. Retention is structural, not
  just policy: migration `0008_executions_org_fk.sql` drops the `executions.org_id` foreign key (table rebuild,
  same pattern as 0002) so the delete is not blocked by a dangling reference. `operations.execution_id` keeps its
  foreign key — operations are never orphaned because their execution row is never deleted.
- Deletion refuses while managed Connections, bundle install records, Solution-owned apps, managed bundle rows, or
  managed configs exist (`DELETE_BLOCKED`): the owning bundle must be uninstalled first. Loose Connections,
  memberships, every other org-owned row, and the org row are removed in one D1 batch sequence.
- **R2 bytes go first**: managed-file objects (plus outstanding staging objects) and every artifact version object
  are deleted before the D1 batch. An interruption leaves D1 rows the next delete (or artifact retention cleanup)
  picks up, never a deleted org over surviving bytes. R2 deletes are idempotent. Missing buckets fail closed
  (`ORG_DELETE_STORE_MISSING`, 503): bytes must not be silently abandoned.
- **Old-database tolerance**: counts and deletes for tables that postdate AUTH-01 treat a missing table as zero
  rows, so old databases preview and delete cleanly. Real query errors still throw.

### Claim boundary (what this ADR does not do)

Upstream exposes granular Role/Permission/Claim/policy-rule management (`roles.py`, `claims.py`, `policy_rules.py`,
form-scoped delegation). This slice deliberately ships only the two-role model above. Resource claims, sharing
grants, and delegated form/app authorization belong to AUTH-02, which builds on the membership table defined here.
That deferral is explicit, not an oversight.

### Upstream bulk operations not in this slice

Upstream `test_users_bulk.py` covers bulk user create/update/delete. The initial slice omits bulk endpoints on
purpose: every bulk op is a loop over the single-row admin APIs with per-item status, which the CLI documents.
Bulk endpoints return if a demonstrated operator need (hundreds of seats at once) earns them; the D1 batch path
is ready. This is recorded here per the acceptance requirement.

## What this ADR does NOT do

- No password database, no sessions, no cookies, no API keys, no MFA/passkey code: Access and the IdP own all of
  that (AUTH-03 verifies the parity, this ADR only consumes verified identity).
- No per-Organization Connection credentials: still ADR-005, still gated (SEC-02).
- No resource-level claims/roles beyond member/admin: AUTH-02.
- No change to service paths: Workflow steps, cron, and D1-local flows never traverse membership.
- No new Cloudflare primitive: Worker + D1 only (migrations `0007_org_membership.sql` and
  `0008_executions_org_fk.sql`; renumbered from 0005/0006 after DEV-01 #185 claimed `0005_forms.sql`
  and APP-01 #189 claimed `0006_apps.sql`).

## Consequences

- Admin provisions Organizations and memberships through the new admin UI (`/admin`) and noninteractive APIs
  (`/api/orgs`, `/api/users`), or the CLI (`scripts/wrangnarok.mjs orgs/members`): no redeploy, no env edit.
- The ADR-014 allowlist becomes a bootstrap fallback: with migration 0007 applied, verified Access identities must
  hold a live membership (or instance admin) or they fail closed. LAB fixture callers in local/CI are auto-seeded
  into the fixture org so the existing suite keeps passing unmodified. The fixture bootstrap (`ensureLabFixture`)
  also creates the migration-0007 tables when a hand-built test database predates them; anything that is not the
  LAB fixture identity still fails closed with `ORG_STORE_NOT_MIGRATED` on such databases.
- Free-tier fit: three small D1 tables plus per-request point reads inside the existing request budget; no new
  billable primitive.
- Audit: lifecycle mutations are ordinary admin API calls with machine-readable codes; durable audit trails are
  OPS-01 and stay deferred.
