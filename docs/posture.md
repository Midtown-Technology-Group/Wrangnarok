# Cloudflare account posture (issue #252)

Wrangnarok can be secure at the code level while being deployed into an
unsafe Cloudflare account or zone configuration. This slice answers:
**"Is the Cloudflare account/zone hosting Wrangnarok configured securely
and according to our intended baseline?"**

Divergence line: this is a **new Wrangnarok-native surface, no upstream
counterpart** — Bifrost is self-hosted Python with no Cloudflare-account
concept, so no upstream invariant applies.

Scope: Worker + Workflows + D1 only. No new primitive, no new D1 tables,
no new secrets path. S4 (Terraform drift) is a deliberate **no-build**:
the repo has no `.tf` files and no IaC-authoritative resource set, so there
is nothing to plan against. Reopen S4 only when Cloudflare resources become
Terraform-managed.

## Sagas

All three are read-only Actions on the existing `cloudflare` Integration
(same `getJson` discipline as `verifyConnection`/`inventoryZones`: exact-base
endpoint, Bearer token as a transient secret handle, bounded JSON, shaped
safe fields, scrubbed errors) plus Sagas that persist shaped summaries via
the standard submit/ExecutionHistory path.

| Saga | Name | Purpose |
| --- | --- | --- |
| S1 | `cloudflare-audit-logs` | Bounded Audit Logs v2 summary with filter classes (`token`, `membership`, `zone-config`, `other`) and actor-vs-service attribution. Scheduled + on-demand; scheduled rows omit `since` and read the trailing 24h at execution. |
| S2 | `cloudflare-security-insights` | Insights list + severity counts + unresolved-Critical tracking. Advisory-first: Critical promotes to CI-failing ONLY after a recorded baseline exists. |
| S3 | `cloudflare-posture-benchmark` | Typed checks over already-called APIs (token-verify, zone inventory, zone settings vs the baseline file) plus honestly-manual and deferred items. NOT Steampipe: Steampipe/Powerpipe is a new external binary outside the local-Cloudflare-tooling direction. |

Vendor shapes (verified against the Cloudflare API reference 2026-09-19):

- Audit Logs v2: `GET /accounts/{id}/logs/audit` with `since`/`before` plus
  filters; entry shape `id`, `account{id,name}`,
  `action{description,result,time,type}`,
  `actor{id,email,ip_address,token_id,token_name,type,context}`,
  `raw{cf_ray_id,method,status_code,uri,user_agent}`,
  `resource{id,product,request,response,scope,type}`, `zone{id,name}`.
  Available on all plan types including API access (Free-compatible).
  Token needs Account Settings Read (audit list requires Account Settings
  Read or Write).
- Security Insights: `GET /accounts/{id}/security-center/insights` with
  `dismissed`, `issue_class`, `issue_type` filters and pagination. No
  plan-gating statement was found in the API reference at build time, so
  unknown insight classes are shaped generically and unknown severities land
  in `unknown` (advisory-only) — paid-gated classes stay out of scope until
  a live-account verification run rather than failing closed on them.
- Zone settings: `GET /zones/{id}/settings/{setting}` for the allowlisted
  Free-available settings `ssl`, `min_tls_version`, `always_use_https`,
  `automatic_https_rewrites`, `security_header`. Anything else rejects
  locally and is never sent to the vendor.

## Credentials (one shared token, one ADR 005 discipline)

The posture slice reuses the single provider-global `CLOUDFLARE_API_TOKEN`
deployment secret (stdin-provisioned, never in D1/logs/source). Operators
MAY provision a least-privilege read-only-scoped token value with zero code
change — every posture Action is a GET. A per-Organization posture token
would be the ADR 005 tripwire firing condition and is NOT added silently.

Suggested least-privilege scopes for a dedicated posture value: Account
Settings Read (audit logs), Zone Read + SSL/TLS read equivalents (zone
settings), Security Center read. Confirm the exact Security Center
permission name on the first live run; the doctena-style per-endpoint
permission mapping is the technique to copy.

## Cadence

- On-demand: submit any of the three Sagas (see `docs/demo.md` conventions
  for the executions API) with the reviewed baseline as input where
  applicable.
- Scheduled: create a recurring Schedule row (TRG-01/ADR 012, no new
  primitive) binding the Saga UUID with the baseline as `input_json`.
- Recurring CI: `.github/workflows/posture.yml` runs weekly and validates
  the checked-in baseline plus the posture unit tests — credential-free.
  Live vendor runs stay operator-triggered (no production token in CI).

## Severity handling

- S2 verdict is `advisory` until `baseline.recordedAt` is set; then
  `failing` iff an unacknowledged unresolved Critical remains.
- S3 verdict is `failing` iff an unsuppressed automated check fails
  (unhealthy token, development mode left on, zone-settings drift).
  `manual` and `deferred` entries never fail.
- Unknown vendor shapes (severities, insight classes) degrade to
  `unknown`/advisory, never to failure. Zone-settings reads are stricter:
  a zone whose read errored counts as unreadable evidence and fails that
  setting check (missing evidence never passes); only a fully-unreadable
  setting degrades to `unknown`.

## Baseline and suppressions

Canonical file: `docs/posture/baseline.json` (validated by
`scripts/validate-posture-baseline.mjs`, also run as `npm run
posture:baseline`). It travels as Saga input, so scheduled rows carry the
reviewed baseline as `input_json`.

- `recordedAt: null` (the starting state) means "no baseline recorded":
  everything stays advisory.
- `acknowledgedCriticalIds` names known unresolved Critical insight IDs.
- `suppressions` name a check ID plus `reason`, `reviewer`, and `expiresAt`.
  Unknown check IDs fail closed at submit; expired rows are ignored, never
  applied.
- `zoneExpectations` pins the TLS baseline (defaults: `ssl: ["strict"]`,
  `min_tls_version >= 1.2`, `always_use_https: on`,
  `automatic_https_rewrites: on`, HSTS enabled).

Reviewers: the steward plus security PR review (the repo has no CODEOWNERS
file; baseline changes land as reviewed PRs like code).

## Honestly-manual controls (never faked)

Global API Key non-use is procedural — no API reports it. Likewise token
least-privilege scoping, env binding separation, membership staleness, and
DNS origin-exposure review are `manual` entries with dashboard pointers.
The benchmark reports them; it never invents a passing signal.

## Retention

Findings persist only as bounded shaped summaries on ExecutionHistory
(max 100 audit entries, 100 insights, 25 checked zones x 5 settings per
run; vendor prose truncated; `truncated` flags set) under the existing
Execution lifecycle. No posture D1 tables exist, so no new retention story
was added — the 10 GB D1 bound is unaffected.
