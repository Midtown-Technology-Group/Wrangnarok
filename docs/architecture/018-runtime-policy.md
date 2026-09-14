# ADR 018: Persisted per-Saga runtime policy (RUN-01)

- **Status:** Implemented (RUN-01, issue #135)
- **Date:** 2026-09-11
- **Extends:** ADR 001 (execution model), ADR 002 (stable Saga identity), ADR 010 (source boundary), upstream finding 3 (runtime policy is environment state, not source trivia) and finding 14 (corrected retry/timeout/cancellation provenance)

## Context

Upstream Bifrost keeps workflow source metadata limited to identity and discovery. Timeouts, retries, schedules, endpoints, access, and cache behavior live on persisted entities rather than baked into decorators (`docs/upstream-spec.md` finding 3). The current upstream status vocabulary also includes `CompletedWithErrors` and `Stuck` alongside `Scheduled`, `Pending`, `Running`, `Success`, `Failed`, `Timeout`, `Cancelling`, and `Cancelled` (finding 14). Locally, Saga source already rejects operational policy keys at startup (`buildCatalog`), but every runtime knob stayed a code constant: `stepRetryLimit()`, `VENDOR_TIMEOUT_MS` / `NINJA_TIMEOUT_MS`, the native 10-second step timeout, and admission (always enabled, unbounded). There was no operator surface to inspect or change policy without editing source, and no Execution record of what policy applied.

## Decision

Persist one runtime policy row per `(org_id, saga_id)` in D1 (`migrations/0012_saga_policies.sql`), keyed by stable Saga UUID, never by export name or path:

```sql
CREATE TABLE saga_policies(org_id TEXT, saga_id TEXT, policy_json TEXT, version INTEGER, updated_at TEXT, PRIMARY KEY(org_id, saga_id));
```

The policy shape is intentionally narrow (boring, typed, Free-tier cheap):

```ts
type SagaRuntimePolicy = {
  timeout: { vendorTimeoutMs: number; stepTimeout: "10 seconds" };
  retry: { checkpointRetries: 0 | 1 | 2; vendorRetries: 0 | 1 | 2 };
  admission: { enabled: boolean; maxConcurrent: number };
};
```

- `timeout.vendorTimeoutMs`: per-Operation vendor deadline override in ms. `0` keeps the Integration default (echo 1000ms, ninjaone 5000ms); custom values cap at 30000ms. The explicit `timeout-mark-v1` checkpoint stays the sole writer of `TimedOut`; nothing is ever inferred from Workflow introspection.
- `timeout.stepTimeout`: fixed platform text (`"10 seconds"`). Recorded for inspectability, not operator-tunable: changing native step bounds is a platform decision with its own ADR, not a per-Saga knob.
- `retry.checkpointRetries` / `retry.vendorRetries`: engine-loss-only ceilings through the existing `STEP_RETRY_CEILING` (2). Vendor defaults stay 0; checkpoints default to 2. Business and expected failures still throw `NonRetryableError`, so the engine never retries a non-idempotent mutation.
- `admission.enabled`: pause is admission-only. `false` fences new dispatches with `409 SAGA_PAUSED`; in-flight Executions keep their snapshot and run to their own terminal. `admission.maxConcurrent` (`0` is unbounded, cap 100) fences overload with `429 ADMISSION_LIMITED`.
- `version` bumps on every operator write; partial PUT bodies merge over the current row; unknown keys reject with `400 INVALID_POLICY`.

Every Execution snapshots the effective policy into `executions.policy_json` at submit. The Workflow resolves step retry limits and vendor deadlines through that snapshot, never the live operator row: in-flight runs keep the behavior they started with when an operator edits policy mid-flight. Detail exposes the snapshot under `policy`; missing snapshots (pre-migration rows) report the code default, never an invented per-Saga guess.

Authorization follows the authoritative Organization membership boundary: any authenticated caller in the Organization may inspect policy (`GET /api/sagas/:id/policy`), while `PUT` requires an active Organization-admin membership or instance-admin identity through `requireManageOrg`. Ordinary members may read policy but cannot change it (`403 ADMIN_ONLY`), even if they supply forged operator headers. Unknown Saga IDs answer 404, never an existence leak across tenants.

## Behavioral matrix (proven by `test/runtime-policy.test.ts` plus existing suites)

| Case | Expectation |
| --- | --- |
| Timeout 0 (default) | Integration default applies (echo 1000ms, ninjaone 5000ms). Slow vendor surfaces `*_VENDOR_TIMEOUT` through `timeout-mark-v1` as `TimedOut`. |
| Timeout custom | A short custom override (e.g. 50ms) turns a normally-fast vendor into `TimedOut`; a long override lets a slow vendor succeed. The snapshot records the override; later edits do not rewrite history. |
| Engine-loss-only retry ceilings | Vendor steps default 0 (one outbound call on failure, proven by existing resilience tests). Operator `vendorRetries` raises only the native retry budget for lost checkpoints; checkpoint retries cap at 2. |
| Business-error non-retry | `NonRetryableError` on every expected failure (`INVALID_INPUT`, `424 INTEGRATION_REQUIREMENT_UNSATISFIED`, vendor `*_FAILED`); no automatic retry of mutations. |
| Pause / admission | `enabled=false` answers `409 SAGA_PAUSED` with no dispatch and no vendor call; re-enable resumes dispatch. `maxConcurrent=1` answers `429 ADMISSION_LIMITED` for the second active Execution. Pausing never touches in-flight rows. |
| CompletedWithErrors | Not a new status. A `{success:false}`-shaped vendor outcome maps to structured `Failed` with its safe code, matching the existing local taxonomy. The upstream name is recorded here as an explicit non-adoption, not silent parity. |
| Stuck (legacy) | Not a status. A silent vendor leaves the Execution `Running` with a `Running` Operation row until the vendor responds, the step ends on its own terms, or the owner cancels. No sweeper, no Cron, no inferred terminal (existing `test/timeout-sweeper.test.ts` tripwire retained). |
| Stale fencing | Terminal checkpoints stay conditional (`Pending`/`Running`-gated executions, `Running`-gated operations). A checkpoint racing a confirmed cancel no-ops; repeated cancel is idempotent (`200 cancelled:false` while `Cancelling`, `409` when terminal). |
| Crash / recovery | Dispatch stays `createBatch` retained-ID dedup plus the durable `dispatched` marker with caller-driven retry. The 15-minute same-revision refusal gate is unchanged; `409 RECOVERY_EXPIRED` never resurrects and never invents success. Policy snapshots ride the same row, so recovery replays under the original behavior. |
| Identity preservation | Policy edits never touch `saga_id`, `saga_name`, or `saga_revision`. Ordinary source edits keep the stable UUID; the manifest churn gate is untouched. |

## Consequences

- Operators gain a real runtime surface without forking Saga identity: policy rows are Organization-scoped environment state, portable bundles stay credential-free.
- Executions become self-describing: detail carries the applied policy, so post-incident review does not guess what the defaults were.
- Free-tier cost stays flat: one extra indexed D1 lookup per submit plus one snapshot column; no Cron, no Queue, no Durable Object, no background job.
- Policy writes reuse the single Organization-admin authorization path rather than introducing a header- or service-identity exception. `stepTimeout` stays fixed platform text because per-Saga native bounds need their own cost and venue decision.
- `CompletedWithErrors` and `Stuck` remain explicit non-adoptions with the semantics above. If a concrete Saga use case demonstrates behavior distinct from `Succeeded` with warnings, `Failed`, or `Running`-until-cancel, that case earns its own ADR and migration.
