# ADR 018: Resource Roles, Claims, and Delegated Authorization (AUTH-02)

- **Status:** Accepted
- **Date:** 2026-09-11
- **Extends:** ADR 015 (Organization membership), ADR 014 (Access identity), `docs/upstream-spec.md` auth rows, `docs/upstream-parity.md` AUTH-02
- **Steward review requested** on the implementing PR (security-adjacent; Phase 3 gate).

## Context

ADR 015 ships the two-role membership model (`member`/`admin` per Organization,
plus instance admins) and gates every `/api/*` request on live membership rows.
That answers "may this caller reach this Organization" but not "may this caller
use this resource": any active member can execute any Saga, read and submit any
Form, and mutate or serve any App in their Organization. Upstream Bifrost has a
granular control plane for exactly this (`api/src/routers/roles.py`,
`claims.py`, `policy_rules.py`, plus form-scoped delegation in `forms.py`).

## Decision

### Vocabulary (lexicon-conformant)

- **Resource**: an addressable domain object of one **resource kind**:
  `saga`, `form`, or `app`. `table` and `file` kinds are reserved names only —
  no Tables or managed files exist yet, so no grant may name them (rejected as
  `INVALID_GRANT`); TABLE-01/FILE-01 extend the kind set with their own ADR.
- **Action**: what is done with a resource. Closed per kind:
  - `saga`: `execute` (discovery via `GET /api/sagas` stays open metadata —
    listings never grant execution).
  - `form`: `read` (declaration), `submit` (bound Execution).
  - `app`: `read` (detail), `write` (create/edit/validate/build/swap/delete),
    `serve` (active-deployment assets).
- **Grant**: one allow tuple `(resourceKind, resourceId | '*', action)`.
  `resourceId` is the stable identity callers already use: Saga UUID, Form
  name, App UUID. `'*'` is the kind-wide wildcard (e.g. "may execute every
  Saga in this Organization").
- **Role**: a named, Organization-scoped bundle of grants (`resource_roles`).
  Roles exist so operators grant a job function once and assign people to it.
- **Assignment**: `(role, org, user) -> active | revoked`. Bulk revocation
  revokes every assignment for a user (or every assignment of a role) in one
  call with a count receipt.
- **Policy rule**: a direct allow tuple that skips roles —
  `(scope, resourceKind, resourceId | '*', action, subject)` where subject is
  one user (`user:<id>`), one membership kind (`kind:ordinary` /
  `kind:external`), or every member (`all`). Rules cover the cases roles
  overserve: one external partner on one Form, every ordinary member on one
  Saga.
- **Claim** in this ADR means exactly the subject side above: the reusable,
  inspectable statement "this subject may do this action on this resource",
  whether it arrives via a role assignment or a direct rule. No separate
  claims table exists on purpose — a third store for the same allow tuple
  would be clever wrapping over boring typed rows.

### Stores (migration `0013_resource_roles.sql`, Worker + D1 only)

- `resource_roles(id, org_id, name, description, created_at)` — org-scoped;
  `(org_id, name)` unique. There are deliberately no global roles: a role
  bundles org-local grants, and a cross-org role would smuggle authority
  across the tenant boundary this project keeps explicit.
- `role_grants(id, role_id, resource_kind, resource_id, action, created_at)` —
  unique per `(role_id, resource_kind, resource_id, action)`.
- `role_assignments(role_id, org_id, user_id, status, created_at, updated_at)` —
  `status` is `active` or `revoked`; revocation is a status flip, never a
  delete, so inspection keeps history.
- `policy_rules(id, org_id NULL, resource_kind, resource_id, action,
  subject_type, subject_ref, created_at)` — `org_id NULL` is a **global** rule
  (managed by instance admins only); a set `org_id` is an Organization rule
  (managed by that Organization's admins). Unique per
  `(COALESCE(org_id,''), resource_kind, resource_id, action, subject_type,
  subject_ref)`.

### Evaluation (`can`, re-resolved per request)

For caller `ctx` (ADR 015 `CallerCtx`) and check
`(orgId, resourceKind, resourceId, action)`:

1. Instance admin (`ADMIN_USER_IDS` env, the provider-admin matrix row) —
   allow everywhere, including globals management.
2. Organization admin (active `admin` membership in the target Organization) —
   allow everything in that Organization. External-kind callers can never be
   admins (ADR 015), so the external matrix row always falls through.
3. Direct rule: an Organization rule for this `orgId`, or any global rule,
   whose subject matches (`all`, this user, or this membership kind) —
   allow. No implicit cross-org fallback: org A's rule never authorizes org B.
4. Role path: an `active` assignment of this user in this Organization whose
   role holds a grant matching `(kind, resourceId | '*', action)` — allow.
5. Otherwise deny (**deny by absence**). Discovery-shaped denials answer 404
   (`ROLE_NOT_FOUND`-style non-disclosure where the reference itself is
   hidden); action denials on a known reference answer 403 `GRANT_REQUIRED`.

Membership stays the outer gate: `resolveCaller` runs first, so a revoked
member or stranger never reaches grant evaluation. Grants never widen
membership — they only narrow what a live member may do. Every request
re-resolves assignments and rules from D1, so policy changes and revocations
apply to the next request with no redeploy and no sessions to expire. Running
Workflow instances are unaffected once dispatched (same in-flight posture as
ADR 015 membership revocation): the Execution row keeps its stored
`org_id`/`user_id`, and the org admin history surface keeps it visible.

### Delegation (forms and apps are entry points)

An authorized Form submit requires the Form `submit` grant — **not** a Saga
`execute` grant on the bound Saga. The Form declaration is the explicit,
scoped delegation: the operator chose the Saga, the fields, and who may
submit. Requiring the direct-workflow grant as well would make delegation
meaningless. The same holds for Apps: `serve` authorizes asset delivery
without any Saga grant. Hidden references cannot bypass grants: a Form name
or App id from another Organization resolves to null in the caller's
Organization scope and answers 404 before grant evaluation runs.

### Administration and inspection

- Org admins manage their Organization's roles, grants, assignments, bulk
  revocation, and Organization policy rules (`/api/orgs/:id/roles…`,
  `/api/orgs/:id/policy-rules…`, all fenced by `requireManageOrg`).
- Instance admins additionally manage global policy rules (`/api/policy-rules…`).
- Consumer inspection: `GET …/roles/:roleId/consumers` shows a role's grants
  plus every assigned user and status; `GET …/policy-consumers` answers "who
  may do this action on this resource" across rules and role paths, so an
  operator removing a grant sees its dependents first. Deleting a role
  removes its grants and assignments in one batch and returns the counts.

## What this ADR does NOT do

- No `table`/`file` enforcement: those resources do not exist. Their kinds
  are reserved and rejected until TABLE-01/FILE-01 land with their own ADR.
- No agent delegation model: later agents (AI-02) reuse `can` at their own
  entry points; this ADR only proves Sagas, Forms, and Apps.
- No live-subscription enforcement: there is no subscription surface yet
  (TRG-03/OBS-02). When it lands, subscribe-time checks call `can` and
  revocation applies to the next subscribe/poll, never retroactively to
  delivered events.
- No explicit deny rules: absence denies, so there is nothing to order or
  override. If a future need earns deny-override semantics, it gets its own ADR.
- No bulk user create/update/delete endpoints (same standing decision as
  ADR 015): bulk revocation of assignments is the only bulk op, because
  incident response ("remove this user everywhere in this org now") is the
  demonstrated operator need.
- No new Cloudflare primitive: Worker + D1 only (migration
  `0013_resource_roles.sql`).

## Consequences

- Ordinary and external members reach exactly what they are granted, nothing
  more; owners keep owner-scoped Execution reads; org admins keep full
  org scope; instance admins keep recovery scope. The caller matrix is pinned
  by `test/resource-roles.test.ts`.
- The pre-existing suite keeps passing unmodified except the AUTH-01 matrix
  submit-as-ordinary case, which now grants first (deny-by-absence is the
  point of this ADR).
- Free-tier fit: four small D1 tables plus per-request point reads inside the
  existing request budget; no new billable primitive.
