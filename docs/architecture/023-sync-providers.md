# ADR 023: Bounded synchronous and data-provider execution (RUN-03)

- **Status:** Implemented (RUN-03, issue #150)
- **Date:** 2026-09-12
- **Extends:** ADR 001 (execution model), ADR 002 (stable Saga identity), ADR 010 (source boundary), ADR 018 (runtime policy); upstream pins at `gobifrost/bifrost@3543c7e`

## Context

Local submission is async-only: `POST /api/executions` returns `202 { executionId, replayed, statusUrl }` (or `200` on replay), the Workflow advances D1 through its own steps, and callers poll detail. Current upstream is not async-only:

- `api/src/models/contracts/executions.py:134-179` carries `sync` (block-and-return inline, overriding the persisted mode) and `transient` (skip database persistence, for editor debugging).
- `api/src/routers/workflows.py:976-1083`: data providers always run sync (small payloads, no UI poll flow) while honoring the caller's transient flag, and ordinary workflows honor `request.sync`. Sync still dispatches through the worker queue and waits on Redis BLPOP, bounded by the workflow timeout plus 60 seconds (`api/src/services/execution/service.py:482-491`); a wait expiry returns `Timeout`, never invented success. Scheduling rejects `sync` and inline `code` together (`contracts/executions.py:175-179`).
- `api/src/routers/endpoints.py:212-232`: configured HTTP endpoints dispatch by persisted `execution_mode` (`sync` with a Redis wait versus `async` receipt). Sync/async is persisted workflow state, never caller choice.
- `api/src/models/contracts/workflows.py:92,139`: `timeout_seconds` defaults 1800s (workflows) / 300s (providers), range 0-86400, where 0 means no timeout (capped at a 24h BLPOP guard upstream).
- Data-provider cache (`test_data_providers.py:145-216`): transient provider calls with a positive `cache_ttl_seconds` short-circuit on `(org, name, inputs)`; non-transient calls always produce a tracked row and bypass the cache. Inline `code` execution requires platform admin (`routers/workflows.py:836-842`) and always runs async (`service.py:435-436`).
- A client-side poll is not server sync parity: the browser SDK's async invoke/stream/poll path is one client workflow, not the server contract (`docs/upstream-spec.md` finding 17).

Local constraints narrow the mapping: a Worker request cannot hold a Redis BLPOP wait; `workflows.py` sync is queue-plus-wait, not in-request compute. The local vendor legs are already bounded and read-only (echo POST-echo fixture, NinjaOne monitoring-scope census), so the safe local equivalent is bounded inline execution of provider-eligible read-only Sagas inside the request, plus a durable receipt for the async remainder.

## Decision

Two named modes on the same submit admission (install gate, idempotency, policy snapshot):

1. **Async receipt (default, unchanged):** `POST /api/executions` returns `202` (first) or `200` replay with `{ executionId, replayed, statusUrl }`. No inline result. This is the only mode for Sagas that mutate, sleep, or touch unproven destinations.
2. **Inline provider (`POST /api/executions/provider`, new):** authorized read-only callers receive the result inline (`200 { executionId, sagaId, status, result, durationMs, dispatch }`) or a named failure envelope. The Execution row is the same durable receipt; provider mode never skips persistence (upstream `transient` is an explicit non-adoption below). Provider dispatch never touches a Workflow binding: the Integration Action runs inside the request deadline and checkpoints terminal state directly.

Provider eligibility is a closed allowlist, never caller choice and never Saga source metadata:

- `ninjaone-orgs` (read-only OAuth census, monitoring scope) is eligible.
- `echo` (fixture POST-echo) is eligible only as the local harness proof; production callers use provider Sagas, not the fixture.
- `ninjaone-echo-digest`, `system.smoke`, and `hello` stay async-only: digest composes a vendor call plus a mutation-shaped transform, smoke writes usage/verification probes, hello is the migration pilot with no provider contract. Any future provider earns eligibility through its own ADR plus destination-side idempotency proof; arbitrary submitted Python/source execution stays rejected (no `code` parameter on any route).

Response deadline: one bounded inline budget of 5000ms per provider call (the tightest proven vendor leg, `NINJA_TIMEOUT_MS`), enforced with `AbortSignal.timeout` at the Action boundary. Exceeding it answers `504 PROVIDER_TIMEOUT` with the durable Pending receipt; the late vendor outcome never overwrites the row (the same fenced conditional writes as async terminal checkpoints). Caller context: the standard membership gate plus the Saga's own Connection requirement; `org_id`/`run_as` overrides stay rejected (admin impersonation has no local equivalent). Failure envelope: safe `{ code, message }` only, scrubbed; declared-but-missing Connections persist `Failed` with the mapped requirement code and answer `200` with the receipt (never `403`/`424`); oversized output persists `Failed` via failExecution then answers `413 PROVIDER_OUTPUT_TOO_LARGE`; timeouts persist `TimedOut` and answer `504 PROVIDER_TIMEOUT`; `409` for idempotency conflict or cancelled keys (plus `409 PROVIDER_IN_FLIGHT` for same-key replays against a non-terminal receipt); `501` for async-only Sagas (`PROVIDER_NOT_SUPPORTED` with the async receipt path as the migration); `503` for ambiguous dispatch.

Unsupported modes stay named exceptions with a migration path: `transient` (no-persistence execution) answers `501 TRANSIENT_NOT_SUPPORTED` — use the provider receipt; caller-chosen `sync:true` on the async route answers `400 SYNC_NOT_SUPPORTED` — use the provider route for eligible Sagas or poll the receipt. Inline `code` has no route at all.

Persistence: provider calls write the same Execution row shape (`dispatched=1` once the inline run starts, `Running` then terminal, one `prepare-input-v1` plus one `provider-inline-v1` Operation row). Cancellation of an inline call is vacuous-by-design: the request already returned or timed out, and the terminal fence owns the outcome. Polling a provider Execution reuses the standard detail route; the provider response is never a substitute for ExecutionHistory.

## Behavioral matrix (proven by `test/sync-provider.test.ts` plus existing suites)

| Case | Expectation |
| --- | --- |
| Authorized read-only provider | `200` with the inline census result plus the durable receipt fields (`executionId`, `statusUrl`). Detail shows `Succeeded` with the same result. |
| Async Saga receipt | `202` first / `200` replay, no inline result. Unchanged. |
| Timeout | Slow vendor (past 5000ms) persists `TimedOut` and answers `504 PROVIDER_TIMEOUT` with the receipt; no invented success, no late overwrite. |
| Cancellation | Provider rows cancel through the standard cancel route only while still active; inline completion wins the fence, never a rewrite. |
| Scope denial | Foreign org/user Connection rows fail the requirement check and persist `Failed` with the mapped code, answered `200` with the receipt; unknown Saga IDs 404; `org_id`/`run_as` fields 400. |
| Output size | Persisted results stay under the 4096-byte D1 bound; oversized vendor shapes persist `Failed` via failExecution then answer `413 PROVIDER_OUTPUT_TOO_LARGE`. |
| Unexpected failure | Vendor `5xx`/bad-shape answers the mapped safe code (`NINJA_*`) as `Failed` with the receipt; vendor bodies and secrets never persist. |
| Unsafe mutation admission | Digest/smoke/hello (and any unlisted Saga) answer `501 PROVIDER_NOT_SUPPORTED` naming the async route; no `code` parameter exists to smuggle execution. |
| Unsupported modes | `sync` on the async route is `400 SYNC_NOT_SUPPORTED`; a `transient` flag is `501 TRANSIENT_NOT_SUPPORTED`. Both name the supported path. |

## Consequences

- Operators and authors gain a real sync equivalent without a queue, Redis, or background wait: one request, one deadline, one receipt. Free-tier cost stays flat (one D1 row plus two Operation rows, zero new primitives).
- The async path is untouched: same ordering, same idempotency, same fences, same Workflow bindings. Provider eligibility is code review plus ADR, not a runtime flag.
- `transient` (no-persistence execution), caller-chosen sync on the async route, endpoint persisted `execution_mode`, provider result caching, and inline `code` execution remain explicit non-adoptions with the named exceptions above. Each earns its own ADR and cost proof if a concrete use case needs it.
- Upstream `CompletedWithErrors`/`Stuck`/`Scheduled` semantics are unchanged by this lane (ADR 001/018 carry them).
