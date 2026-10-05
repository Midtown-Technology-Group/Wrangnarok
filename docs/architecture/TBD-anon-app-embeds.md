# ADR TBD: Anonymous public forms + signed app embeds (revocable external capabilities, slice 2)

- **Status:** Proposed (slice-2 implementation rides this ADR; steward
  acceptance at merge)
- **Date:** 2026-09-17
- **Issue:** #156 (`[parity EMBED-01] Publish and embed forms/apps with
  revocable external capabilities`, slice 2)
- **Extends:** the slice-1 ADR (`TBD-form-embed-capabilities.md`), ADR 005
  (secret storage, v0 digests-only posture), ADR 015 (form binding — see
  #225 for the number collision; this reference means
  `015-form-binding.md`), ADR 037 endpoint-triggers
  (`037-endpoint-triggers.md`, renumbered from 018 by issue #225), ADR 017 (authored apps),
  ADR 019 (app runtime SDK), `docs/upstream-spec.md` §17
- **Numbering note:** this document carries no ADR number until the steward
  reserves one. Per the #225 convention, unreserved decisions stay at
  non-numeric filenames (the `TBD-saga-authoring-ergonomics.md` and
  slice-1 `TBD-form-embed-capabilities.md` precedent).
- **Phase gate:** EMBED-01 is Phase 4 (Partial through this slice — app
  embeds and anonymous publication land, authenticated external-user access
  stays missing by owner decision). The one-diagram checkpoint below
  applies (new authorization boundary + persistence-model change),
  recorded here per `docs/architecture/000-steward-checklist.md`.

## Context

Upstream Bifrost separates three external-access shapes (issue #156
ledger): authenticated external-user access, signed app/form embed
secrets (`api/src/routers/form_embed_secrets.py`,
`app_embed_secrets.py`, `embed.py`), and public-form publication/review
(`api/src/routers/forms.py`, `test_form_publication.py`). Slice 1 shipped
the signed form-embed grant. This slice ships the other two local shapes
while keeping the three authority classes distinct:

1. **Signed app-embed grants** — the app analogue of slice 1, staged
   independently per the issue acceptance.
2. **Anonymous public-form publication** — credential-free admission with
   confirmation-only disclosure, its own anti-abuse story, and republish
   review.

Authenticated external-user access (operator-session onboarding for
outsiders via AUTH-01 invitation + Access seat/cost posture) stays
missing: it is a cost decision for the owner, not a capability gap this
slice can close, and nothing in this slice presumes it.

Upstream pins reused from slice 1 (`docs/upstream-spec.md` §17):

- Startup handles are random, session-bound, 30-minute TTL; submitting
  without one is 422 (`form_runtime.py:178-231`).
- Public/embed forms need a fresh capability fingerprint and exact-match
  origins, no wildcards (`form_runtime.py:358-441`).
- Form submit uses the form gate as authoritative, bypassing workflow RBAC
  anchored to the form org (`api/src/routers/forms.py:1322-1337`).

Local substrate reused — not rebuilt:

- Slice-1 grant shape (`src/embeds.ts`): SHA-256 digest storage, show-once
  raw secret, constant-time verify, rotate via digest swap, revoke via
  disable, no readback, exact-match origin parsing, fingerprint helpers,
  `embed:<grantId>` principals, FILE_NOT_SESSION_OWNED file posture.
- FORM-02 startup handles (`src/forms.ts`): hash persistence, expiry,
  single-use fence, `claimed_key` idempotency, `STALE_FORM_HANDLE`.
- Shared submit core (`runFormSubmit` in `src/index.ts`): peek, provider
  re-resolution, declaration gate, file posture, Saga parse gate, standard
  submit protocol, consume-after-admission.
- `serveAsset` (`src/apps.ts`): active-deployment-only bundle reads,
  same-org scoping, `APP_NOT_LIVE` / `ASSET_NOT_FOUND` contract.

## Decision

### 1. Signed app-embed grants are a distinct grant class

One UUID row in `app_embeds` (migration 0036) binds (org, app id, app
slug) to a secret digest, an exact-match origin allowlist (at most 10,
the shared `parseAllowedOrigins` rule — one origin rule, one
`INVALID_EMBED` shape-code across both signed classes), and a capability
fingerprint (SHA-256 over the bound app id plus the active deployment
`content_hash`). The raw secret is returned once at create/rotate and
never again.

The grant class is distinct by construction, not by convention:

- Separate table: form-embed IDs answer 404 on the app-asset route and
  app-embed IDs answer 404 on the form-embed bootstrap route (proven both
  ways in tests).
- Separate principal (`appembed:<grantId>` vs `embed:<grantId>` vs
  `anon:<publicationId>`): the parsers answer null for each other's
  prefixes, so sessions never cross-accept.
- Separate failure codes (`APP_EMBED_REVOKED` 410,
  `APP_EMBED_SECRET_EXPIRED` / `APP_EMBED_UNAUTHORIZED` 401,
  `APP_EMBED_ORIGIN_DENIED` 403, `APP_EMBED_CAPABILITY_CHANGED` 409).

App embeds mint no startup session — there is no submission here, only
static asset bytes. `GET /api/app-embeds/:grantId/assets/:path`
verifies secret, origin, and deployment fingerprint, then serves the
ACTIVE deployment's stored bundle file through the existing `serveAsset`
with the grant principal (same-org scoping rides along). CORS mirrors
slice 1 (preflight reflects Origin, POST... GET receipts and failures
carry `Access-Control-Allow-Origin` plus `Vary: Origin`).

Fingerprint rotation: a redeploy (new `content_hash`), or a
delete/recreate that changes the app id under the same slug, fails
closed with 409 until the admin rotates, which re-fingerprints against
the live deployment and mints a fresh secret. Revocation is terminal
(no re-enable; rotating a revoked grant answers 410) and immediate on
reads (the grant re-resolves per read — no TTL grace, the FILE-01
posture). Issuance requires a live deployment (404 `APP_NOT_FOUND`
otherwise — a grant fingerprints the live deployment, so there must be
one).

The app-embed principal holds no membership, no roles, and no grants:
`serveAsset` needs no grant beyond org scoping, and nothing in the
asset path resolves Tables, Sagas, or other tenants, so a grant can
never traverse beyond its bound app's bundle bytes.

### 2. Anonymous publication is a separate class with no secrets

One row in `form_publications` (migration 0036) per (org, form) binds
(org, form id, form name) to a capability fingerprint (the slice-1
`fingerprintFormDef` — same serializer `saveForm` persists) and a
honeypot field name. The publication ID is a public link identifier
(unguessable UUID lookup key, the public-branding org-UUID precedent),
never a credential. Publishing opens an anonymous admission path, so the
admin inventory is `requireManageOrg`-gated like the signed inventories;
ordinary members neither read nor change it.

Anonymous bootstrap (`POST /api/public/:pubId/startup`) mints a standard
FORM-02 startup handle bound to (org, `anon:<pubId>`, form) — the handle
IS the submission nonce (random 64-hex, SHA-256 persisted, 30-minute
TTL, peek-then-consume fence with `claimed_key`). The response carries
the snapshot, options, server-authoritative declaration, fingerprint,
and the honeypot field the client must leave empty. Unknown publications
answer 404; disabled ones answer 404 `FORM_NOT_PUBLISHED` (blocked means
gone to the outside world); drifted ones answer 409
`PUBLICATION_STALE`.

Anonymous submit (`POST /api/public/submit`) binds the handle to its
session before any other check (unknown/foreign/replayed handles answer
422 `STALE_FORM_HANDLE`), re-resolves the publication every time
(disabling and drift kill outstanding sessions with STALE — no grace),
runs the honeypot verdict on the raw values, then enters the shared
submit core with `disclosure: "confirmation-only"` and the `refuse`
file posture. The receipt is `{ form, received: true }` with no
execution ID, no status URL, and no Location header — the Execution row
still admits through the standard protocol (one execution path), but
the receipt discloses no execution/history. Anonymous callers hold no
session, so the authenticated execution/history routes stay unreachable
to them.

The honeypot spam trap answers the identical confirmation without
dispatching and without consuming the session (same posture as a
validation failure — a corrected retry stays possible). The trap
teaches bots nothing: 202 and the same body either way.

Upload ownership: anonymous submissions refuse any caller-supplied file
reference (`FILE_NOT_SESSION_OWNED`) — this slice ships no anonymous
upload path, so no reference can prove session ownership (the slice-1
posture over an empty session-owned set). Author-declared defaults
merge server-side and re-validate identically.

Republish review: any designer edit (fields, metadata, prefill opt-in,
Saga rebind) or delete/recreate changes the fingerprint input, so the
publication fails closed (409 at bootstrap, STALE at submit) until the
admin deliberately re-binds through `POST
/api/forms/:name/publication/review` with `{ approve: true }` (anything
else answers 400, never a rebind). The admin summary carries the live
`stale` bit the review UX keys on. Re-publishing heals identically.

### 3. Anti-abuse without a CAPTCHA binding (explicit deferral)

The anonymous class carries honeypot + single-use nonce + 30-minute TTL
+ confirmation-only disclosure (no oracle: success, trap, and validation
outcomes are indistinguishable beyond the 422 validation channel the
operator path already exposes) + per-organization standard submit
accounting. A Turnstile/CAPTCHA binding is deliberately deferred: it
needs a new secret binding, a vendor round-trip, and a pre-write
verification hop that this Worker + D1 slice cannot justify while the
cheap abuse shapes (naive bots, handle replay, execution enumeration)
are closed by the means above. Adopting Turnstile later is a new
primitive decision with its own ADR; this slice must not be read as
deciding it.

### 4. What this slice is NOT

- Authenticated external-user access (owner cost decision, still missing).
- Per-request HMAC signatures on signed grants (slice-1 rationale
  stands: TLS plus short-lived single-use handles plus exact origins
  already bind the session).
- Session-owned anonymous uploads (refusal is the ownership enforcement).
- Per-grant rate limits (secret-gated like api-key endpoints, which carry
  them only optionally; anonymous admission inherits the standard submit
  accounting, and a dedicated anonymous limiter is future work with its
  own ADR).

## Consequences

- Worker + D1 only: two tables, bounded allowlists, no new Cloudflare
  primitive, Free-tier neutral (tiny rows, no new bindings). File bytes
  stay on the FILE-01 path; D1 holds grant/publication metadata only.
- Admin inventory: `/api/apps/:id/embeds` (issue/list/rotate/revoke) and
  `/api/forms/:name/publication` (publish/read/block) plus
  `/publication/review`, all `requireManageOrg`-gated. Unknown or foreign
  apps/forms answer 404; dangling app grants and publications are inert
  (asset reads 404, anonymous bootstrap 404, outstanding submits STALE)
  and stay invisible until a future prune; no delete endpoints.
- The operator submit path is untouched (the disclosure parameter
  defaults to `standard`); the refactor is the added confirmation-only
  return shape, proven by the unchanged FORM-02 and slice-1 suites.
- Console: per-app embed section on the application detail page and a
  publication section (publish/review/block, staleness-gated) next to
  the signed-embed section on the form detail page. Show-once secrets
  for app grants; no secrets exist for publications.

## One-diagram checkpoint (steward checklist, self-assessment for review)

1. **Authentication / authorization:** one path, three credential classes
   on one store shape. Operator sessions via Access/LAB plus the AUTH-01
   membership gate (unchanged); signed form and app callers via
   per-grant secrets resolving to `embed:<id>` / `appembed:<id>`
   principals through the same digest-compare shape as TRG-02 endpoint
   keys (new credential class of the same kind slice 1 earned — D1
   digests only, not a parallel session store); anonymous callers via
   `anon:<id>` principals that authenticate nothing and are authorized
   only by the publication's liveness, freshness, honeypot, and nonce.
   Admin writes ride the existing `requireManageOrg`; all three external
   principals are grant-less by construction.
2. **Execution:** one path. The shared submit core (`runFormSubmit`) is
   entered by the operator route (submit grant), the form-embed route
   (secret + origin + fingerprint), and the anonymous route (live,
   fresh publication + nonce + honeypot); dispatch is always the
   standard submit protocol (Execution row before Workflow dispatch),
   and the only anonymous delta is the receipt shape. App-embed reads
   dispatch nothing.
3. **Persistence:** one path. Single D1 schema, 0036 uncontested
   (0035 landed in slice 1, 0017 still reserved per the ledger).
4. **Secrets:** digests only, show-once; the anonymous class holds no
   secrets at all.
5. **Deployment:** unchanged (single Worker + Static Assets + D1).
6. **Recovery:** existing replay/fence mechanics (`STALE_FORM_HANDLE`
   everywhere, consume-after-admission, same-key idempotent replay with
   confirmation-only receipts).

Stop conditions re-checked: no second auth path (no parallel credential
store or session), no second execution path (shared core + standard
protocol), coverage gate must stay green, this lane touches only
form/app-embed, anonymous-route, and capability files (scope file
`scopes/embed-156-slice2.scope`), and no LIMITS-01 Free violation (tiny
metadata rows, bounded allowlists, no new bindings).
