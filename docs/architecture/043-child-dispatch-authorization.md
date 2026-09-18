# ADR 043: Child dispatch authorization (RUN-02 / AUTH-02)

- **Status:** Accepted
- **Date:** 2026-09-18
- **Decides:** Issue #136 (parity RUN-02, remaining authorization slice)
- **Related:** ADR 039 (nested Saga invocation), AUTH-02 role model
  (`src/roles.ts`: `can`, `requireGrant`, `resolveCurrentAuthority`),
  RUN-01 admission (`admitExecution`), schedule promotion fence
  (`promoteWindow`, `src/schedules.ts`)

## Context

ADR 039 adopted the remote-registered invocation shape and recorded, as an
explicit deferral, that every catalog Saga was invokable from its own
Organization because no AUTH-02 role model existed yet. AUTH-02 has since
landed: direct submits (`POST /api/executions`, provider route, tool
execution) require the saga `execute` grant, and unattended schedule
promotion re-resolves run-as authority at action time through
`resolveCurrentAuthority` with the scheduled Saga's `execute` RoleCheck.
Child dispatch (`invokeChild`, `src/children.ts`) still ran without either
check, so a caller authorized on a parent could reach a child the
Organization had hidden from them, and a revoked caller could keep
dispatching through an in-flight parent.

## Decision

Child dispatch consumes AUTH-02 and RUN-01 as-is (no changes to
`src/roles.ts`, `src/orgs.ts`, or `src/executions.ts`):

- After the child ref resolves and its input parses (route order:
  parse-then-authorize), `invokeChild` re-resolves the persisted parent
  principal through `resolveCurrentAuthority` with the child Saga's
  `execute` RoleCheck. Denials (`ORG_NOT_FOUND`, lifecycle codes,
  `GRANT_REQUIRED`) fail before any row is reserved; instance/org admins
  bypass through `can` like every other route.
- The check reads live authority, not the parent snapshot: a grant revoked
  mid-flight fences the next dispatch, matching per-request evaluation on
  the direct path and revocation-at-use on the schedule path.
- Cross-org dispatch stays unconstructable (the child inherits
  `org_id`/`user_id` from the parent D1 row; `invoke` takes no org
  parameter) and child reads stay org-scoped through `visibleExecution`.
- Saga-authoring rule (observed against workerd, issue #136): a `step.do`
  boundary rehydrates a thrown `Fault` as a plain `Error` rebuilt from
  `String(error)`, dropping the code. Dispatch/await faults must therefore
  be mapped to `SafeError` outcomes and persisted *inside* their step
  callbacks — while the `Fault` is intact — with only the safe code
  crossing the boundary as a `NonRetryableError`. The `hello-parent` demo
  implements this; future parent Sagas must do the same or their
  actionable child codes degrade to generic `EXECUTION_FAILED`.

## Consequences

- Allowed callers (admin bypass, direct rule, role assignment) dispatch
  exactly as before; denied callers fail with the same codes as the direct
  submit path, and no child row is reserved.
- `test/child-invocation.test.ts` carries the allowed+denied caller matrix
  plus an HTTP hidden-child end-to-end (parent persists `GRANT_REQUIRED`,
  no child row, no fabricated greeting) against real local bindings.
- No new Cloudflare primitive: Worker + Workflows + D1 only. Free-tier
  posture unchanged (a few bounded D1 reads per dispatch).
