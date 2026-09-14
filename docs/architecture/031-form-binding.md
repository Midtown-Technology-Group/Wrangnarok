# ADR 031: Forms-to-Saga input binding (FORM-01)

- **Status:** Accepted
- **Date:** 2026-09-11
- **Decides:** Issue #118 (FORM-01); parity map FORM-01
- **Extends:** ADR 001 (Execution model), ADR 002 (Saga identity), ADR 010 (Phase 1b design); `docs/upstream-spec.md` finding 17

## Context

Upstream Bifrost binds workspace forms to workflows by field name: each form
field name is a workflow parameter name, and the server validates submissions
against the persisted field declarations with unknown names rejected
(upstream `api/src/services/shared/form_runtime.py`, `api/src/models/contracts/forms.py`).
Wrangnarök Sagas take JSON input validated in code; there is no form layer at
all. FORM-01 owns the binding only. Renderer, provider, and publication parity
stay with FORM-02.

## Decision

A Form is a persisted, Organization-scoped declaration that names the Saga it
feeds plus the fields it accepts:

- New D1 `forms` table (`migrations/0005_forms.sql`): stable UUID id,
  `org_id`, unique `(org_id, name)`, target `saga_id`, `fields_json` (4 KB
  bound like execution payloads). Storage placement is decided here, not
  implied by the original binding note.
- Closed v1 field set: `text` only, with `name`, `type`, `required`, and
  optional `maxLength` (1 to 1024 UTF-8 bytes). New types arrive with FORM-02.
- Field names bind to Saga inputs by name. The server validates a submission
  against the persisted declaration first (unknown names rejected, per-type
  checks, 200-key and per-field byte caps); only validated input reaches the
  Saga `parse` gate. A declaration that drifts from its Saga schema surfaces
  the Saga 400 `INVALID_INPUT`, distinct from field-level 422s.
- Validation failures are one 422 `FORM_VALIDATION_FAILED` Fault whose
  `details` carry the structured per-field list (`{ field, code, message }`;
  whole-body errors use an empty field name). `Fault` gains an optional
  `details` channel; no other Fault sets it, so existing error bodies are
  unchanged and the client ignores unknown keys.
- Routes: `GET /api/forms/:name` reads the persisted declaration for the
  caller Organization; `POST /api/forms/:name/submit` validates then submits
  the bound Saga input down the standard Execution path (deterministic ID,
  idempotency replay, `Idempotency-Key`). The submit gate is authoritative.
- Organization isolation matches Execution reads: unknown or
  foreign-Organization names answer 404 on both routes, never a leak.
- Pilot form: `hello-greeting` bound to the `hello` Saga (single required
  `name` field). Chosen because `hello` is vendor-free, so the binding test
  proves the contract without Integration noise.

## What this ADR does NOT do

- No form renderer, designer UI, or browser form surface.
- No dynamic option providers, auto-fill, or startup/session handles.
- No scheduled/deferred submit, no public/embed publication, no file fields.
- No per-Organization form administration UI or CRUD API (the pilot
  declaration is D1/test-fixture state, like the seed Connection).
- All of the above stay with FORM-02 (parity map), which additionally depends
  on RUN-03, TRG-01, AUTH-02, and FILE-01.

## Consequences

- `test/forms.test.ts` proves the binding on the real local runtime: read the
  persisted declaration, submit end to end through `HELLO_WORKFLOW` to
  persisted success, structured 422 details, and cross-Organization 404s.
- `test/form-binding.test.ts` pins the declaration contract and the
  two-gate outcome (form 422 vs Saga 400 on drift) as pure unit tests.
- Free-tier fit: one D1 table plus two Worker routes; no new primitive.
  Local and CI runs remain credential-free and consume no production allowance.
