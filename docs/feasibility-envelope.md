# Cloudflare feasibility envelope (LIMITS-01, issue #177)

Dated: 2026-09-17. Baseline: upstream `gobifrost/bifrost@3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f` vs Wrangnarok `origin/main@0331492` (lane `lane/parity-177-limits`).

<!-- LIMITS-META {"budgetKiB":710,"measuredBytes":716545,"measuredDate":"2026-09-17","minHeadroomBytes":8192} -->

This is the dated capability-versus-limit matrix LIMITS-01 requires. It answers one question per capability:

> Can a small but useful deployment exercise this capability indefinitely within Cloudflare Free allowances?

Classifications: **free** (fits Free for a small useful deployment), **paid-adaptation** (needs a paid tier or a TypeScript/native adaptation), **redesign** (needs a redesigned user journey), **unresolved** (blocked, no accepted path yet). Every entry names the binding limit. Allowance numbers below were re-checked against current Cloudflare developer documentation on 2026-09-17 (source links inline); verify again vs current pricing before claiming headroom. Do not hard-code new numbers from memory.

## Evidence classes

Every number in this matrix carries one of four labels. They are not interchangeable:

- **provider-published** — a limit or allowance copied from Cloudflare developer documentation on the check date, with the source page linked. The only numbers that can prove Free-tier fit.
- **locally measured** — an application-observed counter from the local workerd/D1/Workflow stack (`test/smoke.test.ts` budgets, `src/usage.ts` blocks, `npm run check:bundle` bytes). Honest about the local path, never presented as provider metering.
- **estimate** — arithmetic built by us on top of measured actuals (the multi-org workload models below) or on upstream analogues. Labeled as ours, never as upstream's or Cloudflare's.
- **requires deployment authority** — a measurement that needs an explicitly authorized dev deployment (D1 `meta`, Workers analytics, R2 signing latency, multi-org load). Listed, never assumed. No lane may claim production metering accuracy without one.

## Provider-published Free allowances (checked 2026-09-17)

| Primitive | Free allowance | Source |
| --- | --- | --- |
| Workers requests | 100,000 / day | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers CPU | 10 ms per invocation | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Worker script size | 3 MB max (Paid: 10 MB) | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) via Worker size limits |
| Workers egress | No charge for data transfer | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workflows steps | 3,000 / day (Paid: 500k / mo) | [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) |
| Workflows executions | 100,000 / day, shared with Workers daily limit | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Workflows concurrency | 100 concurrent instances; 100 creations / second | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Workflows per-workflow steps | 1,024 max steps | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Workflows step caps | 10 ms CPU, 1 MiB result / event payload, 100 MB persisted state | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Workflows retention | Completed state retained 3 days (Paid: 30) | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| D1 rows read / written | 5,000,000 / day; 100,000 / day | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 storage | 5 GB total per account; 500 MB max per database (Paid: 10 GB) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 databases | 10 per account (Free) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 per-invocation queries | 50 (Free subrequest cap) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 row / statement caps | 2 MB max row; 100 KB max statement; 100 bound params | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Durable Objects compute | 100,000 requests / day; 13,000 GB-s / day; SQLite-backed only on Free; over-limit fails with error, resets 00:00 UTC | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| R2 (Standard) | 10 GB-month storage / mo; 1M class-A + 10M class-B ops / mo; egress free | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Vectorize | 30M queried dims / mo; 5M stored dims / mo (NOT adopted — no binding) | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Workers Paid base | $5 / mo: 10M requests + 30M CPU-ms included | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Access seats | Plan-dependent seat count — verify vs current Zero Trust pricing before claiming headroom | Unverified: no number asserted |

Correction vs the 2026-09-12 matrix: the Free per-database cap is **500 MB**, not 10 GB (the 10 GB figure is the Paid cap per [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). The retention/partitioning pre-production gate is therefore tighter than previously recorded, and the paid path for history scale is explicit below.

## Locally measured usage (not provider meters)

- `test/smoke.test.ts` pins the deterministic smoke path: D1 reads 4, writes 8, operation rows 4, Workflow steps 4, instances 1, with per-run budgets (reads ≤ 10, writes ≤ 20, rows ≤ 10, instances = 1, steps ≤ 10) failing closed on growth. These are application-observed counters, not D1 `meta.rows_read`/`meta.rows_written` billing telemetry.
- `src/usage.ts` emits one `WRANGNAROK_USAGE` block per Execution (counts/IDs/durations only, SEC-01 scrubbed). Worker requests and CPU-ms are `null` locally (not exposed by workerd); a deployed smoke artifact using D1 `meta` plus Workers analytics is still required before claiming production metering accuracy.
- Worker bundle: **716,545 bytes raw** measured 2026-09-17 via `npm run check:bundle` against a **710 KiB** soft budget (see headroom rule below). The provider hard cap is 3 MB, so the soft budget — not Cloudflare — is the binding constraint, by design: it is the early warning for CPU/memory pressure.
- Client JS: 367,436 bytes raw / 105.12 kB gzip (measured 2026-09-17 via `npm run build:ui`). Served as Static Assets from the same Worker; asset requests are free and unlimited per Workers pricing.

### Soft-budget headroom rule (mechanical, not advisory)

`scripts/check-bundle-budget.mjs` enforces two fail-closed gates: the bundle must fit `BUDGET_BYTES`, and it must leave at least `MIN_HEADROOM_BYTES` (8 KiB) of margin below it. A feature PR must either fit the current soft budget with real headroom or carry a deliberate `BUDGET_BYTES` raise **plus** a same-PR update of the `LIMITS-META` block above; post-merge budget-only repairs are not the path. The script fails CI when `BUDGET_BYTES` / `MIN_HEADROOM_BYTES` disagree with `LIMITS-META`, so prose cannot silently trail code. The soft budget stays separate from Cloudflare's 3 MB hard deploy ceiling and from billing limits.

## Primitive envelope

| Primitive | Free allowance (checked 2026-09-17) | Smoke/local actual | Headroom note |
| --- | --- | --- | --- |
| Workers requests | 100,000 requests/day | `null` locally (not exposed by workerd) | One request per API call plus one Cron tick per minute (1,440/day for the TRG-01 tick). Small deployments fit; high-frequency polling does not. |
| Workers CPU | 10 ms CPU per invocation | `null` locally | Pure request shaping plus D1/Workflow calls; no measured pressure. Heavy per-request computation (embeddings, large transforms) is unproven. |
| Workers bundle | 3 MB hard cap; 710 KiB soft budget + 8 KiB min headroom | 716,545 bytes raw of 727,040 | Soft budget binds first by design; ~10.3 KiB margin. Growth is deliberate per-lane headroom; no new dependencies. |
| Workflows instances | 100,000 executions/day (shared with Workers) | 1 per smoke run | One instance per Execution by design. Fits unless per-minute schedules fan out across many orgs. |
| Workflows steps | 3,000 steps/day (billing allowance) | 4 per smoke run | Bounded Operations per Saga (serial, fanout cap 8). ~750 smoke-runs/day is the first Free ceiling (see workloads). |
| Workflows history retention | Completed state retained 3 days | Not archived by local/CI tests | The 15-minute same-revision refusal window plus retained D1 receipts carry recovery; native history older than retention surfaces as unavailable, never invented success (ADR 001). |
| Durable Objects | 100k req/day; 13,000 GB-s/day; SQLite-only on Free | Fence is memory-only: ~1 RPC per refresh round, ms-scale duration, zero storage | OAUTH-01 fence only (no storage, no D1). Fits with large margin at refresh-round frequency; deployed duration metering is still requires-deployment-authority. |
| D1 stored data | 5 GB / account; 500 MB per database (Free) | 3 application Operation rows observed; storage not metered locally | 500 MB per-database cap (corrected 2026-09-17) bounds Execution/Operation history retention: retention/partitioning policy is a pre-production gate (ADR 001 open question). |
| D1 rows read/written | 5,000,000 read/day; 100,000 written/day | 4 reads / 8 writes per smoke run (application-observed) | Bounded scans per route (history pages ≤ 50, tick scan ≤ 50, repairs inspect-then-act). Fits small deployments. |
| D1 transactions | Single-statement plus explicit batch discipline | `createBatch` retained-ID dedup; no multi-statement transactions | No cross-row atomicity beyond PRIMARY KEY/UNIQUE fencing. Complex multi-entity writes need explicit design. |
| D1 per-invocation queries | 50 (Free subrequest cap) | Smoke path uses a handful per request | Routes that fan out per-row queries must stay under 50; batch where possible. Unproven for wide history scans. |
| R2 objects | 10 GB-month + 1M/10M ops per month; egress free | FILE-01/FILE-02 surfaces; per-surface 5 MiB caps | Earned by ADR 018/019. Bytes never ride D1 or Worker memory; multipart/abort parity is unproven and out of scope. |
| Access users | Plan-dependent seat count (unverified) | Fixture auth locally; Access verification in `src/access.ts` | Delegated human identity (SSO/MFA/passkeys) stays the IdP's job (ADR 014). No local user password store exists by design. |
| Egress | Per-Integration allowlist; no private registries or IP allowlists; no platform egress charge | Echo fixture plus NinjaOne vendor boundary | Non-HTTP transports, private endpoints, and self-hosted registries are explicit non-goals (Phase 2 egress note). |

## Representative multi-org workloads (estimates, not meters)

All workload math is **estimate**: smoke actuals (4 steps, 4 reads, 8 writes, ~2 API requests per Execution) extrapolated linearly. Real Sagas cost more per run; re-derive from deployed `meta` before any production claim. The fixed daily overhead is the TRG-01 minute tick: 1,440 Cron invocations plus one bounded scan (≤ 50 rows) per tick, i.e. up to 72,000 rows read/day worst case (1.4% of the 5M cap) — provider-published caps, our arithmetic.

- **W0 single-org baseline (locally measured):** 1 Execution costs 4 steps, 4 reads, 8 writes. Fits trivially.
- **W1 small multi-org (estimate):** 5 orgs × 20 Executions/day = 100 runs/day → 400 steps/day (13% of 3,000), 400 reads + 800 writes (≪ caps), ~200 API requests + 1,440 tick = ~1,640 requests/day (1.6% of 100k). Classification: **free**.
- **W2 schedule-heavy (estimate):** 50 orgs × 1 hourly Saga = 1,200 runs/day → 4,800 steps/day **exceeds** the 3,000-step Free allowance. Classification: **paid-adaptation** (fewer schedules, coarser cadence, or Workers Paid) — the step cap binds before D1 or request caps do.
- **W3 webhook burst (estimate):** per-endpoint rate windows bound writes; a 10× burst over W1 stays inside D1/request caps but consumes the step allowance in hours. Classification: **free** within rate windows, **paid-adaptation** beyond them.
- **Break-even (estimate):** at smoke cost, the first Free ceiling is Workflow steps (~750 runs/day), then requests (~60k runs/day at ~1.6 req/run incl. tick share), then D1 writes (~12,500 runs/day). Any workload above ~750 real runs/day needs the paid path or a slimmer per-run step count. Multi-org load fixtures proving this curve are requires-deployment-authority.

## Capability classifications

| Capability | Classification | Binding limit / rationale |
| --- | --- | --- |
| Durable Execution (Saga/Execution/Operations over Workflows + D1) | free | Fits the envelope above; proven by the smoke budgets and the FULL coverage gate. |
| Schedules (TRG-01: minute Cron tick + D1 due rows) | free | 1,440 Cron invocations/day plus one bounded scan (≤ 50 rows) per tick. No Queue/DO adopted. |
| Webhook/API-key endpoints (TRG-02) | free | Worker fetch plus D1 only; per-endpoint rate windows bound writes. |
| Runtime policy, child Sagas, sync/data-provider execution (RUN-01..03) | free | D1 rows plus existing Workflow bindings; no new primitives. |
| OAuth refresh fence (OAUTH-01 DO) | free | Memory-only SQLite-backed DO: ~1 RPC per refresh round, no storage. Earned by the distributed-execution requirement (Workers gives no single-instance guarantee); classified here explicitly — no silent inheritance. |
| Tables over D1 (TABLE-01/02) | free | Bounded keyset queries; subject to the 500 MB Free per-database retention gate at scale. |
| Forms, file locations, artifacts over R2 (FORM-01/02, FILE-01/02) | free | R2 earned by ADR 018/019; per-surface size caps bound bytes. |
| Full-stack UI as Static Assets (ADR 008) | free | Served from the same Worker; client JS 367 kB raw / 105 kB gzip; asset requests free. |
| MCP gateway, Code Mode, agent tooling (TOOL-01/02, AI-01..06) | paid-adaptation | External model inference is never in Cloudflare Free; Connections carry the vendor cost. Host-mediated execution keeps credentials out of model code. |
| Usage metering/billing accuracy (OPS-04) | redesign | Application-observed counters are honest estimates, not provider meters. Financial claims need deployed metering plus explicit assumptions. |
| Encrypted export/restore (OPS-03) | free | Bounded durable export jobs with download expiry; ciphertext never in portable source. |
| Python workload import (arbitrary upstream packages/process pool) | redesign | Full product parity is not Python import compatibility. TypeScript/native adaptation per Saga; `process_pool.py` has no Cloudflare mapping. |
| Access-gated operator/user identity | free | Cloudflare Access service-token verification in the Worker; seat count follows the account plan (verify current pricing). No local password store exists by design; delegated human identity (SSO/MFA/passkeys) stays the IdP's job (ADR 014). |
| Permission-scoped knowledge / vector search (AI-05) | paid-adaptation | Vectorize is a separate primitive with its own dimension billing (30M queried / 5M stored per month on Free), earned only by an explicit child issue and ADR — not adopted. Until then, knowledge stays out of scope; no in-D1 embedding hack. |
| Build/CI costs (Vite UI, workerd test matrix) | free | Local `vite build` plus GitHub-hosted CI minutes; no Cloudflare build product is adopted. Soft bundle budget (710 KiB + 8 KiB headroom rule) bounds deploy size well under the 3 MB hard cap. |
| Self-host-anywhere deployment | unresolved | Cloudflare-native is the experiment (AGENTS.md 13). No portability abstraction is planned. |
| Tenant scale beyond Free D1/Workflow daily caps | paid-adaptation | Workers Paid ($5 base) or sharded databases; the MVP stays Free-viable by design. Break-even ≈ 750 smoke-runs/day on the step cap. |

### External analogue notes (architecture reviews #254–#259, estimates labeled ours)

- **Pocketflare (#256):** publishes ~8.9 MiB gzip deployed bundle exceeding the 3 MB Workers Free script cap, hence requiring Workers Paid ($5/mo base). Lesson for us: our 716,545-byte raw bundle (≈ 0.68 MB, gzip smaller) fits Free with large provider margin — the binding constraint is our own soft budget, which is exactly where governance belongs.
- **EdgeBase (#255):** publishes a Cloudflare-vs-Supabase/Appwrite comparison but warns its own estimate is optimistic; real costs hinge on write volume, R2 ops, and DO duration. Same caution applies to our W1–W3 models: they are estimates until deployed metering exists.
- **OpenConnector (#254), Ottabase (#257), Nodrix (#258):** no published operating-cost model found in triage; any figures constructed for them are ours, not upstream's.
- **VibeSDK / Workers for Platforms (#259):** first-party examples note some remote D1/R2 features may require a paid plan; do not assume first-party examples are cost-optimized or Free-viable.

## Reproducible acceptance

1. `npm run test:coverage` (all four metrics ≥ 95) plus `test/smoke.test.ts` budgets green: the per-run envelope holds.
2. `npm run build:ui` then `npm run check:bundle`: the deploy envelope holds — fits the 710 KiB soft budget **with** the 8 KiB minimum headroom, and `BUDGET_BYTES`/`MIN_HEADROOM_BYTES` agree with the `LIMITS-META` block above (CI fails closed on drift). Raise deliberately with the reason recorded, never to make red green; post-merge budget-only repairs are not the path.
3. `npx vitest run test/limits-envelope.test.ts`: the matrix covers every required capability row, names the evidence class of each number, carries a current Durable Objects row, and keeps the META block in sync with the budget script — all without credentials or deployment.
4. Every deferred capability above keeps its issue or this matrix entry; a feature label or green unrelated tests never count as parity.
5. Review cadence: re-check allowance numbers against current Cloudflare pricing on every upstream-revision review (#132) and on any lane that adds a primitive, a Cron schedule, or a per-request D1 scan. Allowance drift that breaks a **free** classification opens a parity exception issue before the lane merges.

## What still requires an explicitly authorized dev measurement

- Deployed D1 `meta.rows_read`/`meta.rows_written` vs application-observed counters.
- Deployed Workers request counts and CPU-ms per route (null in workerd).
- Deployed Durable Object request/duration metering for the OAuth fence vs the ms-scale local assumption.
- Multi-org load fixtures proving the daily caps hold under representative schedules, webhooks, and history querying (W1–W3 are estimates until then).
- R2 signing latency and byte throughput under browser upload/download.
