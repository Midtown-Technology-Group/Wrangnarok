# ADR 034: Org Roles (Admin/Operator/Viewer) and Scoped Delegation (AUTH-02 Narrow)

- **Status:** Proposed
- **Date:** 2026-09-18
- **Issue:** #143 (AUTH-02)
- **Extends:** ADR 014 (Access identity), ADR 015 (Organization membership), ADR 018 (Resource Roles, Claims, and Delegated Authorization — constrains, does not rewrite), `docs/upstream-spec.md` auth rows
- **Steward review requested** on the landing PR (security-adjacent; Phase 3 gate).

## Context

ADR 018 defines the full resource-grant evaluator (`can` / `requireGrant` in
`src/roles.ts`) plus the shared non-request resolver
(`resolveCurrentAuthority`), and proves it for Sagas, Forms, and Apps. Two
things remain open on #143:

1. There is no closed org-role set for operator-facing work: membership knows
   `member`/`admin`, while named resource roles are free-form bundles. The
   #135 policy lane and operator surfaces need a fixed vocabulary first.
2. Tables (`table_grants`, `src/tables.ts`) and managed files
   (`file_policies`, `src/files.ts`) authorize through stores that never pass
   through `can()`, with no written rule saying which layer is authoritative
   for each action (S4).

The 2026-09-17 steward decision scopes this ADR narrowly: fixed org roles
plus explicit scoped delegation grants with deny-by-absence semantics. The
full reusable claims/policy engine is deferred to its own ADR and number.

## Decision

### (a) Three fixed org roles with closed ceilings

- `admin` — current `can()` Organization-admin bypass plus the org admin
  surfaces (`requireManageOrg` routes), unchanged.
- `operator` — may hold action grants (`execute`, `submit`, `write`, `serve`,
  table `insert`/`update`/`delete`, file `write`/`delete`) via role assignment
  or direct rule. May never manage roles, grants, rules, or membership.
- `viewer` — read-only ceiling. Only `read`-class grants are evaluable for a
  viewer (Saga discovery, `form:read`, `app:read`, table `read`, file `read`).
  An action-grant row naming a viewer is inert: the evaluator ignores it and
  the admin surface rejects it.

External-kind members may be `operator` or `viewer`, never `admin` (standing
ADR 015 rule, restated here so the closed set is complete). No other
membership roles are introduced by this slice.

### (b) Delegation scope shape — explicit, bounded, inspectable

Every delegation names
`{ kind, resourceId | '*', action, subject, via, issuedBy, expiresAt }` with
`via` one of `form-handle`, `app-serve`, `schedule-run-as`, `endpoint-key`,
`app-grant`. The five existing carriers already satisfy this shape with no new
table: the Form startup handle (bound to org + user + form, 30-minute TTL),
the App serve grant, schedule run-as (Saga `execute` `RoleCheck` at tick),
endpoint delivery keys, and `app_grants` rows. A new carrier must state its
`via` and expiry or it does not ship.

Delegation narrows, never widens: an authorized Form submit needs the Form
`submit` grant and never the bound Saga's `execute` grant — but the Form's
binding is operator/admin-authored, so the chain stays auditable.

### (c) Deny by absence, on every leg

Unknown or foreign references answer 404 before grant evaluation; known but
ungranted actions answer 403 `GRANT_REQUIRED`; no implicit cross-org fallback;
listings never authorize; role/policy/revocation changes apply to the next
request (request path) or the next action tick (resolver path). Running
Workflow instances are unaffected once dispatched (standing posture).

### (d) One composition invariant (answers S4 with no new tables)

```text
live membership -> org role ceiling -> resource grant / delegation
  -> resource-specific policy (table_grants / file_policies)
  -> delegated runtime capability (handles, tokens, app_grants)
```

Each layer narrows the one above; no layer widens. Per-action authority:

| Action surface                        | Authoritative layer(s)                              |
| ------------------------------------- | --------------------------------------------------- |
| Saga `execute` (both ingresses)       | grant layer (`can`)                                 |
| Form `read` / `write`                 | grant layer (`can`)                                 |
| Form `submit` dispatch                | delegation layer (live handle + `submit` grant)     |
| App `read` / `write`                  | grant layer (`can`)                                 |
| App `serve`                           | delegation layer (serve grant, no Saga grant)       |
| Table row actions                     | role ceiling, then `table_grants`                   |
| File location actions                 | role ceiling, then `file_policies`                  |
| Byte delivery (upload/download)       | capability token plus policy re-check at use        |

`table_grants` and `file_policies` are retained as the resource-policy layer
under this hierarchy. Extending `can()` to `table`/`file` kinds is deferred,
not chosen here.

## What this ADR does NOT do

- No full reusable claims/policy engine: arbitrary claim types, deny-override
  rules, cross-org roles, and global role bundles stay out. The existing
  `policy_rules` subject vocabulary (`user:` / `kind:` / `all`) is frozen as
  the narrow set.
- No new Cloudflare primitive, no migration, no enforcement change. This is a
  docs-only contract; the implementing lanes prove it against the matrix
  below.
- No agent delegation model and no live-subscription enforcement (standing
  ADR 018 non-goals, unchanged).

## Consequences

- Operator/viewer work (#135) builds against a closed role set with a
  stated ceiling for each role.
- Acceptance proof for the implementing lane: a caller matrix covering
  ordinary, external, operator, viewer, org-admin, and instance-admin callers
  across the table above, including revocation taking effect on the next
  request/tick and hidden references answering 404.
- Free-tier fit unchanged: no new tables, no new primitives.
