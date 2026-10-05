# ADR TBD: Session-owned uploads for external form sessions (slice 3)

- **Status:** Proposed (slice-3 implementation rides this ADR; steward
  acceptance at merge)
- **Date:** 2026-09-18
- **Issue:** #156 (`[parity EMBED-01] Publish and embed forms/apps with
  revocable external capabilities`, slice 3)
- **Extends:** the slice-1 ADR (`TBD-form-embed-capabilities.md`), the
  slice-2 ADR (`TBD-anon-app-embeds.md`), ADR 005 (secret storage, v0
  digests-only posture), ADR 015 (form binding), ADR 036 (managed files:
  R2 FILES binding, D1 metadata only), `docs/upstream-spec.md` §17
- **Numbering note:** this document carries no ADR number until the steward
  reserves one. Per the #225 convention, unreserved decisions stay at
  non-numeric filenames (the slice-1 and slice-2 `TBD-*` precedent).
- **Phase gate:** EMBED-01 is Phase 4 (Partial through this slice —
  authenticated external-user access and the Turnstile/CAPTCHA binding
  stay missing by owner decision, recorded below). The one-diagram
  checkpoint below applies (new authorization boundary + persistence-model
  change), recorded here per `docs/architecture/000-steward-checklist.md`.

## Context

Slices 1–2 shipped signed form-embed grants, signed app-embed grants, and
anonymous public-form publication. Both external submit paths refused
every caller-supplied file reference (`FILE_NOT_SESSION_OWNED` over an
empty session-owned set): with no upload path, no reference could prove
session ownership. That fail-closed posture was correct but incomplete —
the issue acceptance demands "session-owned file uploads" and "upload
ownership", and forms with file fields were unsubmittable from embeds and
public links. This slice is that upload path, for form sessions only
(app embeds serve static bytes and dispatch nothing, so there is nothing
to attach an upload to).

Local substrate reused — not rebuilt:

- Slice-1/2 session binding (`src/embeds.ts`, `src/public-forms.ts`):
  grant secret + exact-match origin, publication liveness, capability
  fingerprints, FORM-02 startup handles (`embed:<grantId>` / `anon:<pubId>`
  principals), revocation with no grace.
- Shared submit core (`runFormSubmit` in `src/index.ts`): peek,
  provider re-resolution, declaration gate, file posture, Saga parse
  gate, standard submit protocol, consume-after-admission.
- FILE-01 upload machinery (`src/files.ts`): org-wide write policy,
  single-use capability tokens (hashed storage, expiry, policy
  re-checked at consume), staging keys, finalize-after-upload server
  verification (measured size/digest, never trusted assertions).
  `issueUploadSlot` / `consumeUploadToken` / `finalizeUpload` accept any
  principal: the org-wide policy rows the location declaration mints are
  the gate, and non-member session principals pass the viewer ceiling by
  absence exactly like any grant-less caller.

## Decision

A startup session may stage bytes into its form field's declared FILE-01
location and submit references to exactly what it staged — nothing else.
Four sub-decisions:

### 1. Server-minted paths plus an ownership table

Issuance (`POST /api/embeds/:grantId/uploads`,
`POST /api/public/:pubId/uploads`) resolves the named field against the
live declaration (unknown or non-file names answer 400 `INVALID_UPLOAD`),
mints a server-chosen path (`session-uploads/<uuid>` — the client never
picks paths, so sessions cannot alias operator files or each other),
issues a single-use FILE-01 upload token (10-minute TTL), and records
the (session hash, org, location, path) claim plus the field's size/type
bounds in `form_session_uploads` (migration 0040). At most 10 claims per
session (`SESSION_UPLOADS_MAX`): one per file field with headroom for
retries, without letting an anonymous session fill a location one slot
at a time.

### 2. The token stages, the session finalizes, the session submits

`PUT /api/session-uploads/content?token=` consumes the single-use token
(policy re-checked, FILE-01 shape) and stages bytes — pre-gate, because
the token is the credential. `POST /api/session-uploads/finalize`
re-binds the presented handle to its session exactly like the submit
routes (live grant/publication re-resolved: revocation, expiry, origin,
and capability drift kill outstanding finalizes with STALE, no grace;
every other handle class answers STALE), requires the claimed triple to
name a path this session issued, enforces the issuing field's size/type
bounds before the standard finalize-after-upload verification measures
the bytes itself. Submit (`runFormSubmit` `"session"` mode, both
external routes) requires every presented file reference to name a
claimed triple for the submitting session, then re-validates the merged
remainder against the live FILE-01 rows unchanged — staged-only refs
still answer `FILE_NOT_READY`, over-bound or mistyped files still answer
`FILE_TOO_LARGE` / `FILE_TYPE_REJECTED`.

### 3. Traversal verdicts keep their shape

A reference staged by another session, by an operator, or by a sibling
Organization answers 422 `FILE_NOT_SESSION_OWNED` — the same code the
refusal used, so the slice-1/2 traversal verdicts are unchanged; only
the session-owned set is no longer empty. The three session classes
never cross-accept: embed handles are stale on the anonymous finalize
and vice versa. Author-declared file defaults stay server-side and merge
past the raw-values check exactly as before.

### 4. Explicitly out of scope (owner authority required)

- **Authenticated external-user access** stays missing: operator-session
  onboarding for outsiders is an Access seat/cost decision for the
  owner, not a capability gap this slice can close.
- **Turnstile/CAPTCHA binding** stays deferred per the slice-2 ADR: it
  needs a new secret binding plus a vendor round-trip the Free-tier
  slice cannot justify while single-use handles, per-session caps,
  confirmation-only disclosure (no oracle), and session-bound uploads
  close the cheap abuse shapes.
- **"Signed HMAC embed"** needs no new mechanism: upstream HMAC pins
  cover webhook body signatures (see `docs/upstream-spec.md` §webhooks),
  while the embed routers name stored-secret grants — the local
  Bearer-secret grants already satisfy "distinct grant, not anonymous
  publication" by construction (separate tables, principals, codes).

## One-diagram checkpoint (steward gate, Phase 4–6 rule)

1. **Authentication/authorization:** no new authority class. Issuance
   rides the existing grant secret + origin / publication liveness; the
   byte PUT rides single-use FILE-01 capability tokens; finalize rides
   the live startup session. One path per class, preserved.
2. **Execution:** unchanged — submits still enter the shared core down
   the standard submit protocol; uploads dispatch nothing.
3. **Persistence:** one additive D1 table (`form_session_uploads`,
   migration 0040 — next free number; 0017 stays reserved per the
   ledger). Single schema, steward-owned numbering.
4. **Secrets:** hashes only (session hash, token hash); raw handles and
   tokens never persist. ADR 005 v0 posture unchanged.
5. **Deployment:** same Worker + ASSETS binding (ADR 008 / ADR 042
   intact); the R2 FILES binding was already earned (ADR 036) — no new
   Cloudflare primitive.
6. **Recovery:** the 30-minute session TTL bounds every claim;
   single-use tokens cannot replay; consume-after-admission unchanged;
   revocation kills issuance, finalize, and submit with no grace.

Verdict: PASS — no second authoritative path appears; fan-out continues.
Free-tier posture unchanged (Worker + D1 + R2 only, all already in use).
