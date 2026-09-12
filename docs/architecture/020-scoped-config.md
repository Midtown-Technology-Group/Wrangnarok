# ADR 020: Scoped Configuration and Secret References

- **Status:** Accepted
- **Date:** 2026-09-11
- **Extends:** ADR 003 (Integrations and Connections), ADR 005 (secret storage v0), ADR 011 (Solutions install), `docs/upstream-spec.md` config rows
- **Implements:** CON-02 (issue #147)

## Context

Upstream Bifrost exposes general key/value configuration with types
(`string`, `int`, `bool`, `json`, `secret`), global versus
Organization-scoped rows, org-over-global resolution with cascade, list
masking (`[SECRET]`), and an SDK (`api/bifrost/config.py`) whose `get`
with no scope uses the execution context org plus global fallback, and
whose `set`/`delete` run through `POST /api/sdk/config/*` (observed at
baseline `3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f`: `api/bifrost/config.py`,
`api/src/routers/config.py`, `api/src/repositories/config.py`,
`api/src/models/contracts/config.py`,
`api/tests/e2e/api/test_config.py`).

Wrangnarok has only two config surfaces today: Connection `endpoint`
strings (per org, non-secret) and manifest `config` declarations (key/value
strings, credential-shaped keys rejected). There is no typed
key/value store, no org resolution order, and no Saga-visible config API.
CON-02 closes that gap Cloudflare-natively on Worker + D1.

## Decision

### Config declarations versus environment values

- A **Config declaration** is portable source: a `{ key }` name (and,
  following the existing manifest shape, no value for secret material).
  Manifests, Solutions, and Saga metadata carry declarations only.
- A **Config value** is environment state: a D1 `configs` row scoped to one
  Organization (`org_id NOT NULL`) carrying `{ key, type, value_json,
  description, managed_by, updated_at, updated_by }`.
- Divergence from upstream: **no global tier in v1**. ADR 003 deliberately
  rejected implicit global credential fallback; global config rows are the
  same hazard (one row silently shaping every Organization's Execution).
  Org/global precedence is therefore supported only where explicitly
  allowed: none today. The resolution contract is org-only, and any future
  global tier requires its own ADR with explicit lookup and write-boundary
  semantics. Upstream cascade behavior (`merged_for_sdk`, `get_config`
  org-over-global) is recorded as the adaptation, not reproduced.

### Typed validation and defaults

Types mirror the upstream vocabulary: `string`, `int`, `bool`, `json`,
`secret`. Validation is boring and explicit:

- Keys match `^[A-Za-z0-9_]+$` (upstream `SetConfigRequest.key` pattern).
- `string`: non-empty, at most 4096 UTF-8 bytes.
- `int`: canonical integer text (`/^-?\d+$/`), 32-bit range.
- `bool`: exactly `true` or `false`.
- `json`: at most 4096 UTF-8 bytes, parses as JSON, top level is an object,
  array, string, number, boolean, or null (never functions/undefined).
- `secret`: value is a **secret reference**, never a secret value (below).

`get` with a `default` preserves upstream's declared-versus-undeclared
lookup outcome: a missing key returns the caller's default (or null when no
default is given) with `found: false`; a present key returns its typed
value with `found: true`. Permission and server errors surface, never
collapse into the default. Saga authors see the same shape: an optional
`defaults` record applied only when the key is undeclared.

### Secret references (ADR 005 v0 compliant)

ADR 005 v0 is unchanged and unviolated: deployment-level secrets live in
env/Secrets Store; D1 holds no secret values in any column, plaintext or
otherwise; per-Organization ciphertext stays behind the SEC-02 tripwire.

A `secret`-typed config row therefore stores a **reference**: `{ ref }`
naming the provider-global deployment secret (for `ninjaone`, the declared
`secretFields` entry such as `clientSecret`), or empty `{}` when the
reference is declared but not yet provisioned. Provisioning means the
operator confirms the named deployment secret exists and is non-empty; the
value itself is never written to D1, never logged, and never returned
through any API. Reads resolve the reference transiently at the
Integration Action call boundary, exactly like today's NinjaOne handle.

Provisioning the wrong name (not in any Integration `secretFields`) fails
closed with `SECRET_SCHEMA_MISMATCH`. Provisioning when the deployment
secret itself is absent fails closed with `SECRET_NOT_CONFIGURED`.
Both keep the row's `ref` absent so a half-credentialed declaration can
never resolve.

### Operator API

Authenticated callers manage only their own Organization's rows (auth
context org, never a header or body field; foreign rows 404, mirroring
Execution/Connection scoping):

- `GET /api/config` lists declarations with typed values; `secret` rows
  answer `"[SECRET]"` (upstream list-masking parity), never the reference
  target and never a value.
- `POST /api/config` sets (upserts by natural key `(org_id, key)`) a
  non-secret value, or provisions a secret reference. Setting a
  credential-shaped value through a non-secret type fails closed with
  `CREDENTIAL_IN_VALUE`; secret material belongs in deployment secrets,
  never in a config row.
- `PUT /api/config/:id` updates one row by ID: rename, retype, description,
  or value. For `secret` rows, omitting the value (or sending empty string)
  preserves the existing reference (upstream partial-update parity);
  sending a new reference re-provisions it against the deployment secret.
- `DELETE /api/config/:id` deletes one row by ID (404 when missing or
  foreign).

`managed_by` (`<bundle_id>@<version>`, NULL for loose rows) follows the
ADR 011 owned/loose contract: the installer owns managed rows (install
reconciles them, including delete of manifest-dropped declarations);
ordinary operator writes to managed rows reject with `MANAGED_RESOURCE`.
Solution export excludes all config values (declarations and `managed_by`
markers only); there is no secret material to exclude because none is ever
stored.

### Saga resolution

Sagas resolve config only inside `step.do()` through a new `ctx.config`
handle, mirroring the Integration Connection pattern:

- `get(key, defaults?)`: exact-org row lookup, typed parse, reference
  resolution for `secret` rows. Declared-but-missing without a default
  fails loud with `CONFIG_REQUIREMENT_UNSATISFIED` (the config analogue of
  `INTEGRATION_REQUIREMENT_UNSATISFIED`); undeclared access with a default
  resolves to the default and never throws. Cross-org or global lookups do
  not exist: the handle is built from the Execution's own org context.
- Every resolved secret value registers with the execution-scoped secret
  registry (`src/secrets.ts`), so write-time scrubbing covers config
  secrets on every egress path by mechanism, not call-site discipline.

`ctx.config` access outside `step.do()` is a determinism violation and
fails the contract test, like `ctx.integrations`, `ctx.db`, and
`ctx.secrets`.

### What this ADR does NOT do

- No global config tier, no cascade, no cross-org reads.
- No per-Organization secret values in D1 (still SEC-02 tripwire-gated).
- No OAuth token persistence or caching (still 3.1-gated per ADR 005).
- No runtime Saga registration of config requirements (Saga source stays
  identity/discovery only per ADR 002; declaration tracking arrives when a
  Saga actually declares config needs).

## Consequences

- Operators get typed, scoped, secret-aware configuration with upstream
  list-masking and partial-update semantics, without weakening ADR 005.
- Sagas get a boring typed `ctx.config` handle with explicit
  declared-versus-undeclared outcomes and automatic secret scrubbing.
- The installer owns manifest-declared config rows; operator edits to
  managed rows fail closed; exports carry declarations only.
- A future global tier, per-tenant secrets, or Saga-declared config
  requirements each need their own ADR; this one explicitly does not
  pre-authorize them.
