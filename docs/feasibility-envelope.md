# Cloudflare feasibility envelope (LIMITS-01, issue #177)

Dated: 2026-09-12. Baseline: upstream `gobifrost/bifrost@3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f` vs Wrangnarok `origin/main@3ed297a`.

This is the dated capability-versus-limit matrix LIMITS-01 requires. It answers one question per capability:

> Can a small but useful deployment exercise this capability indefinitely within Cloudflare Free allowances?

Classifications: **free** (fits Free for a small useful deployment), **paid-adaptation** (needs a paid tier or a TypeScript/native adaptation), **redesign** (needs a redesigned user journey), **unresolved** (blocked, no accepted path yet). Every entry names the binding limit. Allowance numbers below are the repo's best reading on the check date; verify vs current Cloudflare pricing before claiming headroom. Do not hard-code new numbers from memory.

## Measured local usage (not provider meters)

- `test/smoke.test.ts` pins the deterministic smoke path: D1 reads 4, writes 8, operation rows 4, Workflow steps 4, instances 1, with per-run budgets (reads ≤ 10, writes ≤ 20, rows ≤ 10, instances = 1, steps ≤ 10) failing closed on growth. These are application-observed counters, not D1 `meta.rows_read`/`meta.rows_written` billing telemetry.
- `src/usage.ts` emits one `WRANGNAROK_USAGE` block per Execution (counts/IDs/durations only, SEC-01 scrubbed). Worker requests and CPU-ms are `null` locally (not exposed by workerd); a deployed smoke artifact using D1 `meta` plus Workers analytics is still required before claiming production metering accuracy.
- Worker bundle: ~567 KiB measured locally via `npm run check:bundle` (budget 575 KiB, deliberate feature headroom per `scripts/check-bundle-budget.mjs`). Bundle size is a deploy limit, not a Free-tier billing dimension, but growth is the early warning for CPU/memory pressure.

## Primitive envelope

| Primitive | Free allowance (checked 2026-09-10..12) | Smoke/local actual | Headroom note |
| --- | --- | --- | --- |
| Workers requests | 100,000 requests/day | `null` locally (not exposed by workerd) | One request per API call plus one Cron tick per minute (1,440/day for the TRG-01 tick). Small deployments fit; high-frequency polling does not. |
| Workers CPU | 10 ms CPU per invocation | `null` locally | Pure request shaping plus D1/Workflow calls; no measured pressure. Heavy per-request computation (embeddings, large transforms) is unproven. |
| Workers bundle | Deploy limit (plan-dependent), not billing | ~567 KiB of 575 KiB budget | Growth is deliberate per-lane headroom; no new dependencies since the 100 KiB baseline. |
| Workflows instances | 100,000 executions/day (Free limit) | 1 per smoke run | One instance per Execution by design. Fits unless per-minute schedules fan out across many orgs. |
| Workflows steps | 3,000 steps/day (billing allowance) | 4 per smoke run | Bounded Operations per Saga (serial, fanout cap 8). Fits small deployments. |
| Workflows history retention | Completed state retained 3 days | Not archived by local/CI tests | The 15-minute same-revision refusal window plus retained D1 receipts carry recovery; native history older than retention surfaces as unavailable, never invented success (ADR 001). |
| D1 stored data | 5 GB total | 3 application Operation rows observed; storage not metered locally | 10 GB per-database limit bounds Execution/Operation history retention: retention/partitioning policy is a pre-production gate (ADR 001 open question). |
| D1 rows read/written | 5,000,000 read/day; 100,000 written/day | 4 reads / 8 writes per smoke run (application-observed) | Bounded scans per route (history pages ≤ 50, tick scan ≤ 50, repairs inspect-then-act). Fits small deployments. |
| D1 transactions | Single-statement plus explicit batch discipline | `createBatch` retained-ID dedup; no multi-statement transactions | No cross-row atomicity beyond PRIMARY KEY/UNIQUE fencing. Complex multi-entity writes need explicit design. |
| R2 objects | Plan-dependent; local Miniflare in tests | FILE-01/FILE-02 surfaces; per-surface 5 MiB caps | Earned by ADR 018/019. Bytes never ride D1 or Worker memory; multipart/abort parity is unproven and out of scope. |
| Access users | Plan-dependent seat count | Fixture auth locally; Access verification in `src/access.ts` | Delegated human identity (SSO/MFA/passkeys) stays the IdP's job (ADR 014). No local user password store exists by design. |
| Egress | Per-Integration allowlist; no private registries or IP allowlists | Echo fixture plus NinjaOne vendor boundary | Non-HTTP transports, private endpoints, and self-hosted registries are explicit non-goals (Phase 2 egress note). |

## Capability classifications

| Capability | Classification | Binding limit / rationale |
| --- | --- | --- |
| Durable Execution (Saga/Execution/Operations over Workflows + D1) | free | Fits the envelope above; proven by the smoke budgets and the FULL coverage gate. |
| Schedules (TRG-01: minute Cron tick + D1 due rows) | free | 1,440 Cron invocations/day plus one bounded scan (≤ 50 rows) per tick. No Queue/DO adopted. |
| Webhook/API-key endpoints (TRG-02) | free | Worker fetch plus D1 only; per-endpoint rate windows bound writes. |
| Runtime policy, child Sagas, sync/data-provider execution (RUN-01..03) | free | D1 rows plus existing Workflow bindings; no new primitives. |
| Tables over D1 (TABLE-01/02) | free | Bounded keyset queries; subject to the 10 GB retention gate at scale. |
| Forms, file locations, artifacts over R2 (FORM-01/02, FILE-01/02) | free | R2 earned by ADR 018/019; per-surface size caps bound bytes. |
| Full-stack UI as Static Assets (ADR 008) | free | Served from the same Worker; client bundle ~337 KiB JS. |
| MCP gateway, Code Mode, agent tooling (TOOL-01/02, AI-01..06) | paid-adaptation | External model inference is never in Cloudflare Free; Connections carry the vendor cost. Host-mediated execution keeps credentials out of model code. |
| OAuth refresh lifecycle (OAUTH-01) | free | Token rows plus bounded refresh calls; central refresh must prove its D1 write rate. |
| Usage metering/billing accuracy (OPS-04) | redesign | Application-observed counters are honest estimates, not provider meters. Financial claims need deployed metering plus explicit assumptions. |
| Encrypted export/restore (OPS-03) | free | Bounded durable export jobs with download expiry; ciphertext never in portable source. |
| Python workload import (arbitrary upstream packages/process pool) | redesign | Full product parity is not Python import compatibility. TypeScript/native adaptation per Saga; `process_pool.py` has no Cloudflare mapping. |
| Access-gated operator/user identity | free | Cloudflare Access service-token verification in the Worker; seat count follows the account plan. No local password store exists by design; delegated human identity (SSO/MFA/passkeys) stays the IdP's job (ADR 014). |
| Permission-scoped knowledge / vector search (AI-05) | paid-adaptation | Vectorize (or any vector index) is a separate Cloudflare primitive with its own storage/query billing, earned only by an explicit child issue and ADR. Until then, knowledge stays out of scope; no in-D1 embedding hack. |
| Build/CI costs (Vite UI, workerd test matrix) | free | Local `vite build` plus GitHub-hosted CI minutes; no Cloudflare build product is adopted. Bundle budget (575 KiB) bounds deploy size. |
| Self-host-anywhere deployment | unresolved | Cloudflare-native is the experiment (AGENTS.md 13). No portability abstraction is planned. |
| Tenant scale beyond Free D1/Workflow daily caps | paid-adaptation | Paid tier or sharded databases; the MVP stays Free-viable by design. |

## Reproducible acceptance

1. `npm run test:coverage` (all four metrics ≥ 95) plus `test/smoke.test.ts` budgets green: the per-run envelope holds.
2. `npm run build:ui` then `npm run check:bundle`: the deploy envelope holds (575 KiB budget; raise deliberately with the reason recorded, never to make red green).
3. Every deferred capability above keeps its issue or this matrix entry; a feature label or green unrelated tests never count as parity.
4. Review cadence: re-check allowance numbers against current Cloudflare pricing on every upstream-revision review (#132) and on any lane that adds a primitive, a Cron schedule, or a per-request D1 scan. Allowance drift that breaks a **free** classification opens a parity exception issue before the lane merges.

## What still requires an explicitly authorized dev measurement

- Deployed D1 `meta.rows_read`/`meta.rows_written` vs application-observed counters.
- Deployed Workers request counts and CPU-ms per route (null in workerd).
- Multi-org load fixtures proving the daily caps hold under representative schedules, webhooks, and history querying.
- R2 signing latency and byte throughput under browser upload/download.
