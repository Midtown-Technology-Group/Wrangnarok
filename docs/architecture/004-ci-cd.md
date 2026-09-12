# ADR 004: CI/CD and deployment safety

- **Status:** Accepted for initial implementation
- **Date:** 2026-09-09

## Context

Wrangnarök is intended to be Cloudflare-native while remaining useful on Cloudflare Free. CI should therefore obtain high confidence without requiring Cloudflare credentials or consuming production resources for every pull request. Deployment should be intentionally boring: test the same runtime model locally, deploy through Wrangler, migrate D1 deliberately, and verify the deployed control plane with a safe Saga.

Cloudflare infrastructure terminology remains visible. CI should test Workers in `workerd` and use local Cloudflare bindings rather than maintaining hand-written mocks of D1 or Workflows.

## Decision

### Pull requests are credential-free CI

Normal pull-request CI MUST NOT require Cloudflare account credentials or real Integration credentials.

The baseline PR pipeline is:

1. checkout;
2. install pinned Node dependencies;
3. lint;
4. TypeScript typecheck;
5. unit tests;
6. Worker-runtime integration tests using Cloudflare's Vitest/workerd tooling and local bindings;
7. `wrangler deploy --dry-run` or the closest current non-mutating build validation;
8. Worker bundle budget (`npm run check:bundle`, see below).

External Integration/vendor behavior is mocked or served by deterministic fixtures. Cloudflare services are locally emulated wherever Cloudflare provides supported local bindings.

### Merge queue: speculative batching

Mergify owns merging into `main` (native GitHub merge queue is unavailable to
personal-account repos). Branch protection requires the `Validate` check but
does NOT require branches to be up to date (`strict: false`). The queue runs
up to 3 speculative checks in parallel (`max_parallel_checks: 3`,
`batch_size: 3`): each queued PR is tested against predicted main (main +
PRs ahead of it), so merging PR1 never invalidates PR2 behind it. What merges
is exactly what was tested — no check-then-merge race.

Rationale: under the old strict-plus-serial setup, every merge invalidated
each queued PR behind it, costing the tail PR one full update + CI cycle per
PR ahead of it. Speculative batching removes that serial tax without
weakening the gate (identical queue/merge conditions: `check-success=Validate`).

No-update policy: lanes rebase ONLY on reported conflict, never for currency.
An "out of date" PR still queues and merges — Mergify tests it against
predicted main on a temp branch. Every manual branch update burns a full
fresh CI cycle and resets queue position, so updating for currency is pure
waste. There is intentionally no Mergify auto-update rule for the same reason.

### Deployment is separate from validation

Only trusted deployment workflows receive Cloudflare credentials. Deployment credentials MUST be scoped API tokens rather than global account credentials where Cloudflare supports the required permissions.

Real Integration/Connection credentials MUST NOT be stored as GitHub deployment secrets merely to run application CI.

### Environments

Initial implementation SHOULD use two logical environments once live deployment begins:

- `dev` — first deployment target and smoke-test environment;
- `production` — promoted after dev smoke tests succeed.

The environments MUST use distinct mutable data resources where practical, especially D1 databases. A smoke test must never mutate production tenant/Connection data.

For the MVP slice, production promotion may initially be manual or omitted until a dev deployment is stable. The architecture should not require elaborate progressive delivery before there is real traffic.

### D1 migration rule

Database migration safety is stricter than Worker rollback safety.

Production migrations SHOULD be forward-compatible with both the newly deployed Worker and the immediately previous Worker version. Prefer additive changes. Destructive/semantic changes should be staged across releases rather than coupled to a single deploy.

Typical staged change:

1. add new schema;
2. deploy code capable of old + new reads and appropriate writes;
3. migrate/backfill as needed;
4. deploy code that relies only on new schema;
5. remove obsolete schema in a later release.

D1 recovery features are a safety net, not a substitute for compatible migrations.

### Worker bundle budget

The Worker bundle MUST stay under 100 KiB of raw emitted bytes, enforced by `npm run check:bundle` in PR CI. The script measures the exact bundle `wrangler deploy --dry-run --outfile` produces (no CLI output parsing), so a heavy dependency or cold-start creep breaks the build instead of drifting.

The budget is deliberately generous against the current ~62 KiB bundle. Shrink the bundle first when it trips; raise the budget only with the reason recorded alongside the bump — never silently to make a red run green.

### Observability

Workers Logs and traces are enabled in `wrangler.jsonc` (`observability.enabled`, sampling rate 1 at experiment scale). Every request additionally emits one `WRANGNAROK_REQUEST` JSON log line — method, route, status, duration only — scraped the same way as the `WRANGNAROK_USAGE` block. Access logs MUST NEVER carry headers, bodies, query strings, or secrets, mirroring the usage-block posture in the cost-logging section above.

Retention and quotas follow the account plan, not this ADR: verify vs current Cloudflare pricing before claiming Free-tier headroom for log/trace volume, and revisit sampling before any real load.

### PR preview environments

Every pull request deploys to one shared disposable preview Worker (`preview` env in `wrangler.jsonc`, `.github/workflows/preview.yml`) and smokes `system.smoke` against its workers.dev URL. Previews catch binding/config drift that `wrangler deploy --dry-run` cannot: real account calls, real D1 migrations, real Workflow dispatch.

Design rules:

- One shared preview Worker + one disposable preview D1, last-wins across PRs at experiment scale. Per-PR environments graduate only when contention demands it.
- The preview D1 is disposable: smoke writes land under the disposable smoke Organization and test data is never promoted anywhere.
- Fixture credentials are ephemeral per run: the workflow generates a random `LAB_TOKEN`, masks it, plants it with `wrangler secret put`, and smokes with it. The next run replaces it, so there is nothing to rotate on leak. Demo org/user IDs ship as committed non-secret `vars`, matching the local fixture pattern.
- Without secrets (forks) the workflow skips gracefully; credential-free CI on the PR itself stays the merge gate.

Token lifecycle (least privilege, no dashboard clicking after bootstrap):

1. Once, a human creates a parent token (dashboard) with `API Tokens Write` + `Workers Scripts Write` + `D1 Write`, scoped to the account.
2. `CLOUDFLARE_API_TOKEN=<parent> node scripts/mint-preview-token.mjs --account-id <id>` mints the CI child (Workers Scripts Write + D1 Write, account-scoped, 1-year expiry) and prints its value exactly once. The parent token is never printed, logged, or committed.
3. Store the child as the `CLOUDFLARE_PREVIEW_TOKEN` GitHub Actions secret and the account ID as the `CLOUDFLARE_ACCOUNT_ID` variable, then delete the parent token (or keep it offline for rotation).
4. Rotation = rerun the mint, update the secret, delete the old child. Real Integration/Connection credentials MUST NEVER take this path — preview secrets are fixture-only by construction.

Human setup before the first preview run: `wrangler d1 create wrangnarok-preview`, paste its database ID over the placeholder in the `preview` env, complete the token lifecycle above. Until then `--env preview` commands fail closed.

### Platform smoke Saga

Wrangnarök SHOULD permanently include a safe internal `system.smoke` Saga once the execution model supports it.

The smoke Saga should prove the deployed control plane rather than merely return HTTP 200. It should exercise, at minimum:

1. Worker/API request handling;
2. Execution creation (202-only-after-confirm; ambiguous create reconciled by status lookup, never treated as duplicate on unknown);
3. D1 write (Pending row + input fingerprint);
4. Cloudflare Workflow execution;
5. multiple Operations with stable names/operation IDs;
6. D1 read/write verification;
7. terminal Execution persistence;
8. Execution status/detail retrieval;
9. duplicate-submit (same key + same input => same Execution, `replayed: true`), conflict-submit (same key + different input => 409 + lookup path), and isolation-submit (different Organization/principal => different Execution, foreign inspect => 404 without touching Workflow binding);
10. restart persistence (stop/restart local Wrangler, replay same key => same Execution + same result).

It MUST run in a dedicated disposable organization (e.g. `org_system_smoke`) with identifiable `smoke_`-prefixed Execution IDs/records, never touch production tenant/Connection data, and MUST NOT require an external vendor, tenant credentials, or destructive production data.

Cost-logging requirement (Free-tier rule enforcement):

1. `system.smoke` MUST emit a machine-readable `usage` block per run (JSON log + persisted ExecutionHistory-adjacent record without secrets) containing: D1 rows written/read and read/write/query counts; Workflow instances started, steps executed, and Execution duration; Worker requests handled and CPU-ms where exposed.
2. Post-deploy smoke (`dev` and `production` promotion per ladder below) MUST archive that `usage` block as a CI artifact and update the docs allowance-vs-actuals table referenced in `docs/upstream-spec.md#free-tier-rule-measurable`.
3. Smoke MUST NOT log secret material, Connection plaintext, or full vendor payloads — counts, IDs, durations, and status codes only.
4. Tracked Free limits, minimum set: D1 (stored rows/data, reads, writes), Workflows (steps, instances), Workers (requests, CPU-ms). Use `[verify vs current Cloudflare pricing]` placeholders for allowance figures; record the docs URL + check date alongside each figure.

### CI/CD ladder

Target shape:

```text
Pull request
  |
  +-- lint
  +-- typecheck
  +-- unit tests
  +-- workerd integration tests
  +-- Wrangler dry-run/build validation
  +-- preview deploy + smoke (with secrets; skipped on forks)
  |
  v
merge to main
  |
  +-- repeat required validation
  +-- apply dev D1 migrations
  +-- deploy dev Worker version
  +-- run system.smoke
  |
  v
production promotion
  |
  +-- apply compatible production migrations
  +-- deploy/promote Worker version
  +-- run system.smoke
```

Progressive/canary traffic deployment is deferred until real usage makes it useful.

### Platform deployment vs content deployment

For the MVP, Sagas ship inside the Worker/application bundle. Deploying Wrangnarök deploys its built-in Sagas.

Do not create a second deployment system for Saga/Integration content yet. If Wrangnarök later supports portable bundles analogous to Bifrost Solutions, content installation/versioning becomes a separate architecture problem from deploying the Wrangnarök platform itself.

## Runbook: dev deployment + system.smoke (issue #18)

Credential-free CI proves everything below except the actual Cloudflare
account calls. A human with account access runs these in order; no step
requires committing secrets or IDs.

```bash
# 0. Local gates first (no credentials needed).
npm ci
npm run typecheck
npm test
npx vitest run test/smoke.test.ts
npx wrangler deploy --dry-run
npx wrangler deploy --dry-run --env dev

# 1. Create the distinct dev D1 database (one-time).
wrangler d1 create wrangnarok-dev
# Paste the returned UUID into wrangler.jsonc env.dev d1_databases,
# replacing REPLACE-ME-wrangler-d1-create-wrangnarok-dev. Never invent,
# forge, or reuse another environment's ID.

# 2. Apply migrations to dev (forward-compatible; 0002 is additive-only).
wrangler d1 migrations apply DB --env dev --remote
# Verify: `wrangler d1 migrations list DB --env dev --remote` shows none
# unapplied; `executions` + `operations` + `usage_blocks` exist.

# 3. Set dev secrets (values never committed; smoke itself needs none).
wrangler secret put LAB_TOKEN --env dev
wrangler secret put LAB_ORG_ID --env dev
wrangler secret put LAB_USER_ID --env dev
# Optional, only for the ninjaone-orgs path: NINJA_CLIENT_ID / NINJA_CLIENT_SECRET.

# 4. Deploy dev.
wrangler deploy --env dev

# 5. Run system.smoke against dev (disposable org_system_smoke only).
SMOKE_SAGA_ID=7a1f3c5e-9b2d-4f6a-8c1e-5d3b7a9f1c2e
curl -X POST "$DEV_WORKER_URL/api/executions" \
  -H "Authorization: Bearer $LAB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: dev-smoke-001" \
  -d "{\"sagaId\":\"$SMOKE_SAGA_ID\",\"input\":{}}"
# Expect 202 + { executionId, replayed:false, statusUrl }. Poll statusUrl
# until status Succeeded; expect operations prepare-input-v1, smoke-write-v1,
# smoke-verify-v1 all Succeeded and result { d1WriteOk:true, d1ReadOk:true }.

# 6. Archive the usage block: capture the WRANGNAROK_USAGE JSON log line and
# the usage_blocks row, store as a CI artifact, and update the
# allowance-vs-actuals table in docs/upstream-spec.md#free-tier-rule-measurable.
```

What to verify: 202-then-Succeeded lifecycle, D1 write/read verification in
the result, terminal persistence, detail retrieval, the usage block (console +
`usage_blocks` row, counts/IDs/durations only, no secrets), and that no
production tenant/Connection row was touched. Restart persistence
(stop/restart, replay same key => same Execution + same result) is a manual
post-deploy check, not covered by workerd CI.

Expected consumption per smoke run (Free-tier viable): ~1 Workflow instance
with 4 steps, ~12 application-observed D1 statements over a handful of rows,
and a handful of Worker requests. Allowance figures are placeholders until
verified against current Cloudflare pricing; record the docs URL + check date
with each figure.

## Consequences

### Positive

- Public PRs can run meaningful CI without privileged secrets.
- Tests execute against Cloudflare's runtime model rather than Node-only approximations.
- Vendor outages do not block ordinary development.
- Deployment credentials exist only at the mutation boundary.
- D1 schema evolution is treated as an explicit compatibility concern.
- `system.smoke` becomes a reusable production canary for the actual orchestration path.

### Costs

- Local Cloudflare emulation can still differ from production; deployed smoke tests remain necessary.
- Two environments consume additional free-tier resource allowance and configuration complexity.
- Forward-compatible D1 migration discipline requires more staged changes than destructive one-shot migrations.
- CI configuration must evolve with Wrangler and Cloudflare's testing tooling.

## MVP slice implementation

Issue #4 should establish the PR validation half of this ADR first. Live deployment automation should be added only after the TypeScript scaffold can pass locally.

The first GitHub Actions workflow may tolerate missing `package.json` while the repository is specification-only, but MUST become a required real validation workflow once implementation lands.
