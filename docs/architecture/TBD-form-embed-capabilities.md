# ADR TBD: Signed form-embed grants (revocable external capabilities)

- **Status:** Proposed (slice-1 implementation rides this ADR; steward
  acceptance at merge)
- **Date:** 2026-09-17
- **Issue:** #156 (`[parity EMBED-01] Publish and embed forms/apps with
  revocable external capabilities`, slice 1)
- **Extends:** ADR 005 (secret storage, v0 digests-only posture), ADR 015
  (form binding — see #225 for the number collision; this reference means
  `015-form-binding.md`), ADR 037 endpoint-triggers (`037-endpoint-triggers.md`,
  renumbered from 018 by issue #225), `docs/upstream-spec.md` §17
- **Numbering note:** this document carries no ADR number until the steward
  reserves one. Issue #225 (ADR number governance) renumbered the
  015/016/018/019/023 collisions to 034-041; per the #225 convention,
  unreserved decisions stay at non-numeric filenames. This file follows the
  `TBD-saga-authoring-ergonomics.md` precedent deliberately.
- **Phase gate:** EMBED-01 is Phase 4 (Missing → Partial in this slice).
  Phase 4–6 lanes earn merge per-lane with no presumption from
  work-started; the one-diagram checkpoint below applies (new
  authorization boundary + persistence-model change), recorded here per
  `docs/architecture/000-steward-checklist.md`.

## Context

Upstream Bifrost separates three external-access shapes (issue #156
ledger): authenticated external-user access, signed app/form embed
secrets (`api/src/routers/form_embed_secrets.py`,
`app_embed_secrets.py`, `embed.py`), and public-form publication/review.
The re-audit on #156 keeps those three authority classes distinct and
orders the work: signed form-embed grants first, app embeds second,
anonymous publication last. Slice 1 implements only the first.

Upstream pins for the grant shape (see `docs/upstream-spec.md` §17):

- Startup handles are random, session-bound, 30-minute TTL; submitting
  without one is 422 (`form_runtime.py:178-231`).
- Public/embed forms need a fresh capability fingerprint and exact-match
  origins, no wildcards (`form_runtime.py:358-441`).
- Form submit uses the form gate as authoritative, bypassing workflow RBAC
  anchored to the form org (`api/src/routers/forms.py:1322-1337`).

Local substrate already proven (surveyed on #156, reused — not rebuilt):

- FORM-02 startup handles (`src/forms.ts`): random 64-hex token, SHA-256
  hash persisted in `form_startups`, bound to (org, user, form), 30-min
  TTL, peek-then-consume single-use fence with `claimed_key` idempotency
  binding, `STALE_FORM_HANDLE` on unknown/expired/foreign/replayed.
- TRG-02 endpoint credentials (`src/endpoints.ts`): SHA-256 digest
  storage, show-once raw secret, rotate via digest swap, revoke via
  disable, no readback, `endpoint:<id>` scoped principals.
- FILE-01 revocation posture: revocation deletes outstanding tokens with
  no TTL grace.
- `can()` (`src/roles.ts`) deny-by-absence: principals without grants get
  nothing, with 404-on-foreign reads across forms, apps, endpoints, files.

## Decision

A **signed form-embed grant** is a revocable external capability: one UUID
row in `form_embeds` (migration 0035) binding (org, form id, form name) to
a secret digest, an exact-match origin allowlist, and a capability
fingerprint. The raw secret is returned once at create/rotate and never
again; D1 keeps only the digest. Five sub-decisions:

### 1. Grant identity

One grant serves one form in one Organization; a form may hold many
grants (one per embed host). Lookup is global by UUID on the pre-gate
bootstrap route — the ID is a lookup key, never the credential — exactly
like TRG-02 same-named endpoint resolution ("names are not secret;
credentials are"). Unknown IDs answer 404. Secrets are 32 random bytes
(64 hex), verified by single-hash constant-time digest comparison after
the enabled/expiry checks (410 `EMBED_REVOKED`, 401
`EMBED_SECRET_EXPIRED`, 401 `EMBED_UNAUTHORIZED`).

### 2. Origin binding

Bootstrap and submit both require an `Origin` header exactly matching one
allowlist entry (at most 10 per grant). No wildcards, no suffix matching,
no `Referer` fallback, no path/query/fragment/userinfo in registrations —
anything else fails closed at grant creation with `INVALID_EMBED`, never
at request time. The allowlist is admin state: the 403
`EMBED_ORIGIN_DENIED` message never names an allowed origin. The submit
check is the real browser fence (a third-party page cannot spoof the
victim's `Origin`); the bootstrap check binds the declaring host to the
same list.

### 3. Fingerprint rotation

The fingerprint is SHA-256 over the bound Saga id plus the canonical
declaration bytes (the same `serializeFormDeclaration` serializer
`saveForm` persists, so the two cannot drift). Any designer edit —
fields, metadata, prefill opt-in, or a Saga rebind — changes the input.
A stale grant fails closed: bootstrap answers 409
`EMBED_CAPABILITY_CHANGED`, and sessions minted before the change answer
`STALE_FORM_HANDLE` at submit (the FORM-02 definition-mismatch contract;
409 exists only at bootstrap, where no session exists to be stale).
Rotating mints a fresh secret and re-fingerprints against the live
declaration, which also heals delete/recreate (new form id) drift. There
is no republish-review queue in slice 1 (deferred on #156); fail-closed
plus rotate is the whole stale-capability story.

### 4. Startup binding

Embed sessions ARE FORM-02 sessions. Bootstrap mints a standard startup
handle bound to (org, `embed:<grantId>`, form) through `startFormSession`
and returns the snapshot, options, the server-authoritative declaration
(the external host cannot call the authed designer routes), and the
fingerprint. Submit runs the shared submit core (`runFormSubmit` in
`src/index.ts`): peek, provider re-resolution, declaration gate, file
posture, Saga gate, schedule-or-dispatch down the standard submit
protocol (Execution row before Workflow dispatch), consume-after-admission.
Unknown, expired, foreign, already-used, or definition-mismatched handles
answer 422 `STALE_FORM_HANDLE` and dispatch nothing — the same contract
as the operator path. Path separation runs both ways: operator handles
are rejected on the embed route exactly as embed handles are rejected on
the operator route.

The embed principal holds no membership, no roles, and no grants, so
Table providers resolve through the same caller-scoped gate as the
operator path and deny by absence: a form grant can never traverse to
Tables, live file bytes, another form, an unrelated Saga, or another
tenant. The single deliberate fork in the shared core is the file
posture: operator submissions re-validate merged file references against
the live FILE-01 rows, while embed submissions first refuse any
caller-supplied reference (`FILE_NOT_SESSION_OWNED`) — slice 1 ships no
embed upload path, so no reference can prove session ownership — and then
re-validate the merged remainder identically (a ref past the refusal can
only come from an author-declared default, and stale defaults fail the
same on both paths).

Browser delivery rides CORS on the two embed routes only (PR review,
slice 1): `OPTIONS` preflights reflect the request `Origin` with the
route's methods/headers (cached 10 minutes) without touching D1 — the
submit preflight has no body to resolve a handle from, and preflight
authorizes nothing either way — while `POST` receipts and `POST` failures
both carry `Access-Control-Allow-Origin` plus `Vary: Origin` so browsers
can read embed results instead of surfacing opaque TypeErrors. Reflection
never substitutes for the allowlist: the `POST` handlers enforce
`checkEmbedOrigin` before doing anything, and error bodies carry codes
and fixed messages, never secrets. No other route gains CORS headers.

### 5. Revocation semantics

Revoke sets `enabled=0` and is terminal in slice 1: there is no re-enable,
and rotating a revoked grant answers 410. Revoked grants deny bootstrap
with 410, and the grant re-resolves on every submit, so outstanding
sessions die with `STALE_FORM_HANDLE` — no TTL grace (the FILE-01
posture). Revoke is idempotent. Expiry behaves the same (401 at
bootstrap, `STALE` at submit).

### 6. Signed grants are not anonymous publication

The signed bearer-secret grant class and any future anonymous/public-form
publication are distinct grants with distinct threat models. Anonymous
admission is a new unauthenticated path and needs its own ADR proving one
execution path (standard submit), confirmation-only disclosure (no
execution/history), anti-abuse (Turnstile vs upstream CAPTCHA vs
honeypot/nonce — no binding adopted), session-owned upload ownership, and
per-endpoint rate limits. Slice 1 ships NO anonymous route: every
external call presents the grant secret. Signed-embed callers receive the
standard submit receipt (they are authenticated-by-grant and org-bound);
confirmation-only disclosure applies to the future anonymous class only.

## Consequences

- Worker + D1 only: metadata and digests in D1, no new Cloudflare
  primitive, Free-tier neutral (tiny rows, bounded allowlists, no new
  bindings). File bytes stay on the FILE-01 path; D1 holds grant metadata
  only.
- Admin inventory (`/api/forms/:name/embeds`, rotate, revoke) is
  `requireManageOrg`-gated: ordinary members neither list nor mint.
  Unknown or foreign forms answer 404 `FORM_NOT_FOUND`. Dangling grants
  (form deleted) are inert — bootstrap answers 404, outstanding submits
  answer `STALE` — and stay invisible until a future prune; slice 1 adds
  no delete endpoint.
- The operator submit route now enters the shared core; the refactor is
  behavior-preserving (proven by the unchanged FORM-02 suites) and is
  itself the one-execution-path evidence.
- Considered and deferred: per-request HMAC signatures (TLS plus
  short-lived single-use handles plus exact origins already bind the
  session; HMAC adds clock-skew/replay machinery without changing the
  trust root — the host still holds a bearer secret); per-session origin
  pinning (a new `form_startups` column for marginal gain over the
  grant-level fence, since handles are unguessable and single-use);
  optional per-grant rate limits (secret-gated like api-key endpoints,
  which carry them only optionally); an embed providers-refresh route
  (startup already returns options; re-bootstrap is cheap).

## One-diagram checkpoint (steward checklist, self-assessment for review)

1. **Authentication / authorization:** one path. Operator sessions via
   Access/LAB plus the AUTH-01 membership gate (unchanged); external
   embed callers via per-grant secrets resolving to `embed:<id>`
   principals through the same digest-compare shape as TRG-02 endpoint
   keys (new credential class, same store shape — D1 digests only — not a
   parallel session store). Admin writes ride the existing
   `requireManageOrg`; the embed principal is grant-less by construction.
2. **Execution:** one path. The shared submit core (`runFormSubmit`) is
   entered by the operator route (submit grant) and the embed route
   (secret + origin + fingerprint); dispatch is always the standard
   submit protocol. No anon dispatch exists.
3. **Persistence:** one path. Single D1 schema; migration 0035
   (`form_embeds`) verified uncontested at branch time (0034 landed on
   `main` via the UX-01 lane first; this lane renumbered per the steward
   rule). Ledger row + chain-test entry ride the PR.
4. **Secrets:** one path. ADR 005 v0 deployment store plus D1 digests
   only; show-once issuance; scrub discipline untouched (no secret
   substrings in Fault paths — the 403 names no origin, digests never
   leave create/rotate).
5. **Deployment:** unchanged (Worker + static assets; no new primitive).
6. **Recovery:** the existing mechanism. Same-key replay convergence,
   `STALE_FORM_HANDLE` fencing, revocation with no grace, idempotent
   revoke, rotate-to-heal after capability changes.

Stop conditions re-checked at lane start and at PR time: no second
authoritative path (one credential-store shape, one submit core); the
coverage gate is green locally (see the PR); this lane touches only its
scope (scope file `scopes/embed-156-slice1.scope`, no out-of-scope
touches); no LIMITS-01 Free violation (Worker + D1 only, no new binding).
Evidence: `src/embeds.ts`, `src/index.ts` (embed routes + shared core),
`src/forms.ts` (`peekStartupIdentity`, `serializeFormDeclaration`),
`migrations/0035_embeds.sql`, `test/embeds.test.ts` (16 workerd tests),
`test/embeds-ui.test.tsx` (6 UI tests).

## Deferred (stays open on #156)

App embeds (slice 2, `src/apps.ts` untouched here); anonymous/public-form
publication with the anti-abuse/CAPTCHA mechanism choice;
honeypot/submission nonce; session-owned uploads; capability-changing
republish review; confirmation-only disclosure rules; embed
providers-refresh route; per-grant rate limits; dangling-grant prune UX.
