# ADR 001: Saga, Execution, and Operation execution model

**Status:** Draft — reconciled per issue #15 (2026-09-09); resilience semantics implemented per issue #16 (2026-09-09). Canonical rules below replace the former UUIDv7 / optional-key / 10-minute-expiry / create()+reconciler proposals, which are recorded as rejected alternatives with rationale.

## Context

Wrangnarök needs a durable execution contract that belongs to the application rather than leaking Cloudflare Workflows terminology into every public/domain surface.

Upstream Bifrost provides several useful behavioral invariants:

- asynchronous workflow invocation returns an execution ID; current upstream also supports synchronous/data-provider results;
- execution summaries and full execution detail are separate surfaces;
- executions retain caller/organization provenance and are authorization-scoped;
- deferred/scheduled execution is a runtime concern, not workflow source identity;
- durable work exposes status, result/error, timestamps and observability;
- cancellation, timeout and retry are explicit semantics;
- retry after ambiguous infrastructure loss is only safe for idempotent side effects.

The following are **Wrangnarök safety choices**, retained from the reconciliation. The 2026-09-11 source audit corrected their earlier attribution to upstream (see `docs/upstream-spec.md` finding 14 and parity tracker [#132](https://github.com/MTG-Thomas/Wrangnarok/issues/132)). Current upstream sweeps some database Pending rows, its retry metadata is future-use, and the inspected paths do not establish the previously claimed universal attempt-token/broker-confirm protocol. Correcting that provenance does not relax local rules:

- retry is OFF by default, engine-loss-only when on, plus an operator ceiling; business-error retry is never automatic;
- `Pending` is published-but-unclaimed and is never swept; `Scheduled` is a durable pre-publish row distinct from `Pending`;
- `Cancelling` is an explicit transient state with stale-token rejection; terminal states are not cancellable;
- ambiguity is fenced, never guessed: missing/expired history surfaces as unavailable/expired, never as invented success.

Cloudflare Workflows provides durable instances and steps, but Wrangnarök should not make Cloudflare's API shape its permanent product contract.

## Decision

### Saga

A **Saga** is a stable, discoverable TypeScript automation definition.

A Saga has durable identity independent of ordinary source edits. Registration is settled in ADR 002 (Accepted): a static Git-owned Catalog built at Worker startup (duplicate stable IDs/names are fatal boot errors), mirrored by D1 metadata but never driven by it. Callers and Triggers must not depend solely on a mutable export name or source path.

Saga `run` bodies execute under Cloudflare Workflows determinism constraints (see ADR 002 example). All I/O, nondeterminism, and Integration calls MUST live inside Operations (`step.do(...)`); direct `fetch()` / `Date.now()` / `Math.random()` / top-level `ctx.integrations.*` in `run` fails review. Saga inputs/outputs MUST be serializable JSON.

### Execution

An **Execution** is one durable execution of a Saga.

An Execution is backed initially by a Cloudflare Workflow instance but has its own Wrangnarök record in D1 for discovery, authorization, history, and product-level state.

An Execution record must include `org_id` from day one. MVP slice ships a single default Organization (`default` stub ID) propagated explicitly via `ctx`; multi-tenancy and authorization are deferred to Phase 3. The Workflow loads the Organization from its immutable D1 Execution row, never from client-supplied context.

Initial state model (MVP slice implemented `Pending`, `Running`, `Succeeded`, `Failed`; issue #16 implemented `TimedOut` via an explicit timeout checkpoint (the `timeout-mark-v1` step, retired under ADR-033-3/issue #414 with the sole-writer handoff to `failSagaExecution`) and `Cancelling`/`Cancelled` via the owner-only cancel endpoint + native `terminate`; `Scheduled` remains the one deferred distinct state — see below):

```text
Pending -> Running -> Succeeded
                  \-> Failed
                  \-> TimedOut (explicit classification only)
Pending -> Cancelling -> Cancelled
Running -> Cancelling -> Cancelled
```

`Scheduled` (durable pre-publish, promotable when due) is intentionally NOT in the CHECK constraint. It is a distinct future state, not an alias of `Pending`. `Cancelling` joined the CHECK constraint via `migrations/0002_cancelling.sql`.

Allowed transitions (implemented; unit-tested as pure TypeScript via `canTransition`):

```text
Pending -> Running | Failed | Cancelling
Running -> Succeeded | Failed | TimedOut | Cancelling
Cancelling -> Cancelled
```

No other transitions are legal. Unit-test the transition table as pure TypeScript. `Pending` is never swept by any background job: there is no autonomous `Pending -> Failed` expiry. `Pending -> Failed` only occurs via an explicit Workflow failure checkpoint (`failExecution`), never via a timer.

`CompletedWithErrors` is intentionally omitted until a concrete Saga use case demonstrates semantics distinct from `Succeeded` with structured warnings or `Failed`.

The full Execution record (MVP slice, matches `migrations/0001_initial.sql`):

- stable Execution ID (`id`, deterministic SHA-256 hex, 64 chars, TEXT PRIMARY KEY; also used as the Cloudflare Workflow instance `id`) — see `Execution identity` below;
- Saga ID, name, and revision snapshot (`saga_id`, `saga_name`, `saga_revision`) sufficient for diagnosis; deleting/renaming source never erases history;
- Organization and requester (`org_id`, `user_id`, required; explicit authorization boundary on every read);
- `dispatched` marker (`INTEGER 0/1`): durable dispatch confirmation, written only after the native `createBatch` acknowledges;
- status (`Pending` default; `Running`, `Succeeded`, `Failed`, `TimedOut`, `Cancelled` reserved);
- `input_json` (≤4096 bytes), `result_json` (≤4096 bytes), `error_json` (safe code/message only);
- `created_at`, `started_at`, `completed_at` as applicable;
- ExecutionHistory/observability linkage via `operations` rows.

There is deliberately NO separate `idempotency_key` column, NO `input_fingerprint` column, NO `workflow_instance_id` column, and NO `create_attempts` counter in the MVP slice. The deterministic ID plus `dispatched` marker subsume them (see rationale). A future binding that diverges Workflow instance ID from Execution ID may add `workflow_instance_id`; a future keyless/Scheduled path may add `idempotency_key UNIQUE`.

### Execution identity (divergence 1 — canonical)

**Canonical: deterministic SHA-256 Execution ID** (`sha256(JSON(["wrangnarok.execution.v1", orgId, userId, key]))`, 64 lowercase hex), scoped to `(org_id, user_id, Idempotency-Key)`. Same key + same principal replays the same ID via `INSERT ... ON CONFLICT(id) DO NOTHING`; same key + different `(saga_id, input)` returns `409 IDEMPOTENCY_CONFLICT`; different principal yields a different ID.

**Rejected alternative: server-generated UUIDv7 + `UNIQUE(idempotency_key)`.** Rationale for rejection in the MVP slice: it adds a second unique index plus a separate lookup path (`SELECT` by key, then `INSERT` by random ID) with no demonstrated requirement. The deterministic ID gives atomic single-identifier idempotency, fewer D1 indexes/reads (Free-tier), explicit tenant scoping via the hash tuple, and is already proven in workerd tests. UUIDv7 time-ordering is not needed because history paginates by `(created_at, id)`. Revisit only when a keyless submit path (server-generated keys, durable pre-publish `Scheduled`) demonstrates a need for identity independent of a client key.

### Operation

An **Operation** is a durable unit of Saga execution owned by Wrangnarök semantics and normally backed by a Cloudflare Workflow step.

Operations should be named for diagnostic stability. Their persisted/public representation should not require exposing Cloudflare-internal step representation.

MVP slice Operation defaults:

- stable step names per Saga version (e.g. `prepare-input-v1`, `echo-http-v1`); never reorder/rename persisted v1 steps;
- stable `operation_id` per unit of work (e.g. `${executionId}-echo-http-v1`) passed as the outbound `Idempotency-Key` to the Integration Action; retries reuse the same ID;
- serial, bounded fanout (cap 8 targets/iterations for the MVP slice);
- step timeout 10 seconds; **local retry gate: the `stepRetryLimit()` table resolves every step.do limit — Integration/vendor steps `retries: 0` unless destination-side idempotency is proven and an explicit policy exists; idempotent D1 checkpoint steps (`prepare-input-v1`, `persist-success-v1`, `persist-failure-v1`) only may use `retries` up to the code-defined ceiling 2 (`timeout-mark-v1` retired under ADR-033-3/issue #414); every business/expected failure throws `NonRetryableError` so the engine never retries a non-idempotent mutation.** The former blanket `retries limit 2` on arbitrary steps is rejected for the same reason. Persisted operator-editable policy is not implemented yet;
- **no exactly-once external-side-effect guarantee:** a step may redeliver after a lost checkpoint. Integration Actions MUST enforce `operation_id` idempotency at the destination or refuse automatic retries for unsafe operations. The fixture echo Action is read-like (POST-echo, no external mutation) with `retries: 0`; future retryable mutations require destination-side idempotency and a deliberate policy.

### Invocation and creation protocol (D1 + Workflow instance)

Starting a Saga is asynchronous. The API acknowledges accepted work and returns the Execution identity without waiting for completion.

A later API may support delayed/scheduled start via a distinct durable `Scheduled` state, but MVP slice only requires immediate start. `Scheduled` stays deferred; do not overload `Pending` for pre-publish scheduling.

Worker `POST /api/executions` with `{ sagaId, input }` in the body MUST use this order because D1 + `Workflow.createBatch()` are non-atomic (dual-write). D1 is the idempotency record; the Cloudflare Workflow instance is the executor. Body-carried `sagaId` keeps one stable admission endpoint; the Workflow binding is never inferred from the request.

D1 schema (excerpt, canonical — matches migration):

```sql
CREATE TABLE executions (
  id TEXT PRIMARY KEY, -- deterministic SHA-256 hex, == Workflow instance id
  saga_id TEXT NOT NULL,
  saga_name TEXT NOT NULL,
  saga_revision TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(length(input_json) <= 4096),
  dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'Pending'
    CHECK(status IN ('Pending','Running','Succeeded','Failed','TimedOut','Cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  result_json TEXT CHECK(result_json IS NULL OR length(result_json) <= 4096),
  error_json TEXT
);
```

HTTP hardening (MVP slice API):

- `Idempotency-Key` required, `16-128` chars `[a-zA-Z0-9._:-]` (else `400 INVALID_IDEMPOTENCY_KEY`); `Content-Type` must be `application/json` (else 415); `Content-Encoding` rejected; body cap 4096 bytes streamed (else 413); invalid JSON/unknown Saga/bad input => 400/422 `INVALID_*`;
- same key + different `(saga_id, input_json)` => `409 IDEMPOTENCY_CONFLICT`; expired/unconfirmed retry => `409 RECOVERY_EXPIRED` without relaunch; ambiguous dispatch failure => `503 DISPATCH_UNCONFIRMED` + `Retry-After: 5` with "retry POST with the same Idempotency-Key";
- `Cache-Control: no-store` + `X-Content-Type-Options: nosniff` on Execution responses;
- authorization (Organization + requester check, `default`-Organization principal in Phase 0) runs BEFORE touching the Workflow binding; foreign owners get 404, not 403-with-existence-leak;
- query strings rejected (`400 UNSUPPORTED_QUERY`); list omits input/result; detail never copies vendor bodies, tokens, or binding errors.

Protocol:

1. Validate `Idempotency-Key` (required 16–128, see `Idempotency-Key` below) and `input` serializable JSON now (fail 400 before any write).
2. Compute `id = sha256(["wrangnarok.execution.v1", orgId, userId, key])`.
3. `INSERT INTO executions (id, saga_id, saga_name, saga_revision, org_id, user_id, input_json, created_at) ... ON CONFLICT(id) DO NOTHING`. Then `SELECT` the visible row (`org_id` + `user_id` scoped).
4. If `(saga_id, input_json)` differ from the stored row: `409 IDEMPOTENCY_CONFLICT`. Do NOT create a second Workflow instance and do NOT mutate stored input. Stored input is immutable.
5. If same key + same input and row already `dispatched = 1`: return the original Execution (`200`, `replayed: true`). Never fork a second Execution or Workflow instance. Concurrent identical submits converge via `ON CONFLICT DO NOTHING` + retained-ID dedup.
6. If `dispatched = 0`: enforce the same-revision + 15-minute refusal gate (see `Recovery window`). If the gate fails: `409 RECOVERY_EXPIRED` without dispatch. If the gate passes: call `await workflow.createBatch([{ id, params: { executionId: id } }])` on the Saga-pinned Workflow binding (never inferred from the request; `SAGA_WORKFLOW` per Saga). Cloudflare retained-ID dedup skips already-existing IDs without error-string parsing. On acknowledgement, `UPDATE executions SET dispatched = 1 WHERE id = ?`.
7. Return `202 { executionId, replayed: false, statusUrl }` on first dispatch, `200 { executionId, replayed: true, statusUrl }` on replay. Do NOT optimistically mark `Running`. `Running` is only written by the Workflow itself (`prepare-input-v1` conditional `Pending -> Running` + `started_at`).
8. The Workflow instance advances D1 via its own steps (same-Worker D1 binding): `prepare-input-v1` validates Saga ID + revision and marks `Running`; `echo-http-v1` / `ninja-list-orgs-v1` (retries 0) perform exact-Organization Connection lookup and the Integration call; `persist-success-v1` / `persist-failure-v1` write terminal state with bounded serializable payloads. Expected Integration failures return structured `{ ok: false, error }` step results so codes survive replay without relying on Error-subclass transport; unexpected loss throws `NonRetryableError` into `persist-failure-v1`.
9. If `createBatch()` throws after the D1 insert: leave the row `Pending` (`dispatched = 0`), return `503 DISPATCH_UNCONFIRMED`. Never delete the D1 row to "roll back". The caller retries the same key/input; the retry re-enters step 6 under the same gate. No autonomous outbox, no background resurrection. Reads never launch work.

### Result and error

Successful Execution output must be serializable and bounded (≤4096 bytes persisted; vendor transport caps may be higher, e.g. 256 KB for NinjaOne list, but only a shaped max-25 summary persists).

Expected failures use a structured `{ code, message }` shape with a stable machine-readable code plus safe human-readable message. Internal exception details, vendor bodies, tokens, and secrets must not be exposed by default.

### History versus detail

History/list endpoints return lightweight Execution summaries (no input/result, default limit 20 + `hasMore` + opaque `nextCursor`). OBS-01 (issue #152) implements keyset cursor pagination over `(created_at DESC, id DESC)` with server-side filters `status` (single or comma-separated multi, mirroring upstream), `sagaId`, exact `sagaName` (upstream `workflowName` parity), ISO `startDate`/`endDate` bounds on `created_at`, and `limit`/`cursor`; anything else stays `400 UNSUPPORTED_QUERY`. Full input/result/Operation detail belongs on an individual Execution endpoint. Detail exposes stored status, ordered Operation records, and a separate advisory `runtimeStatus` from native Workflow introspection when available. A missing/unavailable native status is never interpreted as success, failure, or expiry. This mirrors a useful upstream separation and avoids large D1 reads.

### Cancellation (RUN-04 canonical, issue #151)

Cancellation is a two-phase product protocol, never a blind native call. The
route first writes the owner-scoped logical marker (`Pending`/`Running ->
`Cancelling`, conditional write; foreign owners get 404, never an existence
leak), then attempts the native Workflow instance `terminate()` control, then
**classifies the native outcome before reporting anything**. A confirmed stop
is never reported unless one was observed. The classifier is
`classifyTerminateError()` in `src/domain.ts` (pure, unit-tested): the local
REST layer surfaces exact codes — `instance.cannot_terminate` when the
instance is already in a finite state (`complete`/`errored`/`terminated`), and
`instance.not_found` when no such native instance exists — and everything else
(transient/control-plane failures, timeouts, non-Error throws) fails closed to
ambiguous. Native diagnostics never leave the server (safe code/message only).

| Native outcome | D1 writes | Response |
|---|---|---|
| `terminate()` resolves (stop delivered) | `Cancelling -> Cancelled` (fenced) plus `EXECUTION_CANCELLED` operation markers | `200 { cancelled: true }` |
| throws `instance.cannot_terminate` (already settled) | same confirm writes: logical cancel wins, the native engine merely settled first, and any racing terminal checkpoint already no-ops against the fence | `200 { cancelled: true }` |
| throws `instance.not_found` on an **undispatched `Pending`** row | same confirm writes: vacuous stop — dispatch was never confirmed and the native side has nothing, so nothing is left running | `200 { cancelled: true }` |
| throws `instance.not_found` on a **dispatched** row (a confirmed instance vanished) | **no terminal or Operation writes**; roll back `Cancelling` to the prior active status | `503 CANCELLATION_UNCONFIRMED` + `Retry-After: 5` |
| any other throw (transient/control-plane, unknown code) | **no terminal or Operation writes**; roll back `Cancelling` to the prior active status | `503 CANCELLATION_UNCONFIRMED` + `Retry-After: 5` |

The ambiguous path is retry-safe by construction: the rollback restores the
prior active status, so retrying the cancel looks like a fresh cancel
(re-mark, re-terminate, re-classify). The rollback (`Cancelling` back to the
prior active status) is a compensating write owned by the route, not a product
transition — the `canTransition` table still admits only `Pending`/`Running ->
`Cancelling` and `Cancelling` -> `Cancelled`. A genuine racer that loses the marker
write while a cancel is in flight still answers idempotent `200 {
cancelled: false }`; terminal states still answer `409
EXECUTION_NOT_CANCELLABLE` and are never rewritten; a cancelled Execution
never dispatches (again) — resubmitting its key returns `409
EXECUTION_CANCELLED`. Late Saga checkpoints stay fenced by conditional writes
(`Running`-gated success, `Pending`/`Running`-gated failure), so a checkpoint
that lands after a confirmed cancellation cannot overwrite `Cancelled`, a
cancelled row never advances to `Running` (prepare-step guard), and after a
rollback the true terminal outcome can still land.

What logical cancellation does and does not guarantee for already-issued
external side effects: cancellation sends the native stop signal and fences
D1 state, but it cannot recall an in-flight vendor `fetch` — already-sent
bytes may still execute remotely, and the vendor may ignore the stop entirely.
`Cancelled` means the Execution will not advance further under its key, not
that no external call was ever issued. A late vendor callback that lands after
a confirmed cancel no-ops against the fenced `finishOperation` rows instead of
overwriting terminal history.

`Scheduled` stays deferred: there is no delayed-start path to cancel yet, so no `Scheduled` cancel semantics are claimed.

### Retry and idempotency

Do not transparently retry arbitrary Integration mutations merely because infrastructure can retry them. Retry policy must account for whether an Operation is safe/idempotent or has a caller-provided idempotency mechanism.

Cloudflare Workflow step retry behavior is an implementation tool; Wrangnarök exposes only semantics it can explain safely.

Public idempotency contract (canonical for MVP slice):

- Header `Idempotency-Key` is REQUIRED, `16–128` chars `[a-zA-Z0-9._:-]` (else `400 INVALID_IDEMPOTENCY_KEY`). **Rejected alternative: optional header + server-generated UUIDv7.** Rationale: the deterministic Execution ID cannot be derived without a client key; a required key makes replay explicit, avoids silent keyless forks, keeps validation to one pure check, and matches proven workerd tests. Optional/server-generated keys are deferred until a keyless or `Scheduled` use case needs them (which would also require the rejected UUIDv7 + `UNIQUE(idempotency_key)` path).
- Scope is `(org_id, user_id, key) -> execution ID` via the hash tuple. Cross-principal reuse yields a different Execution by construction; exact-Organization Connection lookup and per-read `(org_id, user_id)` scoping preserve the tenant boundary. Global `UNIQUE(idempotency_key)` scoping is rejected for the MVP slice for the same reason as UUIDv7 (extra index, cross-tenant existence questions, no demonstrated need).
- First submit returns `202 { executionId, replayed: false, statusUrl }`; retry with the same key + same canonical input returns the original Execution (`200`, `replayed: true`); it never forks a second Execution or Workflow instance (D1 `ON CONFLICT DO NOTHING` + retained-ID dedup).
- Same key + different `(saga_id, input_json)` returns `409 IDEMPOTENCY_CONFLICT` with the original lookup path. Stored input is immutable. Concurrent conflicting submits never both launch (single winner via PRIMARY KEY; loser gets 409).
- Same key + same input but `dispatched = 0` and gate failed returns `409 RECOVERY_EXPIRED` (see below), never a second dispatch.

### Recovery window (divergence 3 — canonical)

**Canonical: 15-minute same-revision caller-driven retry gate; `Pending` durable and never auto-swept; `Scheduled` distinct and deferred.**

- An unconfirmed reservation (`dispatched = 0`) may be retried only within 15 minutes of `created_at` (`RECOVERY_WINDOW_MS`) AND under the same Saga `revision`. Later ambiguity, or a revision change, returns `409 RECOVERY_EXPIRED` ("inspect the existing Execution; it must not be automatically relaunched") without dispatching. The row stays `Pending` (durable receipt); it is never auto-transitioned to `Failed` by a timer.
- **Rejected alternative: 10-minute expiry-to-`Failed` (`ADMISSION_RETRY_WINDOW_EXPIRED`) via reconciler sweep.** Rationale: per upstream finding 14, `Pending` is never swept — the 10-minute sweep conflates queue backup with lost dispatch and fabricates a terminal result from absence. The 15-minute refusal window (not an expiry-to-failed) bounds only the ambiguity of recreating a Workflow instance after native history retention, while the retained D1 receipt prevents restart-after-history-loss from inventing success: missing/expired native history surfaces as unavailable/expired (`runtimeStatus: null`, `Pending` with `dispatchConfirmed: false`), never as success.
- Confirmed rows (`dispatched = 1`) never dispatch again, even if native Workflow history has expired. Detail reports stored status plus advisory `runtimeStatus`; expiry of native history does not rewrite D1.
- `Scheduled` (durable pre-publish, promotable when due) is distinct from `Pending` and deferred: MVP slice has immediate start only and no `Scheduled` CHECK value, Cron, or promotion path. Introducing `Scheduled` without delayed-start semantics is rejected.

### Dispatch (divergence 4 — canonical)

**Canonical: `createBatch` retained-ID dedup + durable D1 `dispatched` marker; caller-driven retry; no autonomous reconciler.**

- D1 reserves the immutable Execution before native dispatch. `Workflow.createBatch([{ id, params }])` with one instance provides retained-ID deduplication (never parse error strings as duplicates). The durable `dispatched = 1` marker is written only after that call acknowledges. `202` is returned only after the marker persists.
- If creation or marker persistence fails: `503 DISPATCH_UNCONFIRMED` ("work may have started; retry the same request and Idempotency-Key"). No autonomous outbox/Cron. Reads never launch work.
- **Rejected alternative: `create()` + Cron/lazy reconciler (adopt-or-retry with `create_attempts`, 60 s staleness, 10-minute expiry).** Rationale for rejection in the MVP slice: it adds a 5-minute Cron (Free-tier requests + D1 reads when idle), a `/internal/reconcile` surface, and an autonomous resurrection path that risks recreating very old ambiguous launches after history retention. Caller-driven retry on `503` preserves idempotency with no background cost, and retained-ID dedup already converges concurrent submits. Autonomous reconciliation is deferred until a demonstrated lost-dispatch use case proves it cannot resurrect after history expiry and justifies the extra primitive/surface.
- Safety assumption (explicit): Cloudflare retains instance IDs throughout the 15-minute gate, and operators do not manually delete/reset native instances or D1 records below that window. Concurrent submission and ambiguous-failure behavior remain native-runtime test gates (same-key replay, conflicting-key 409, expired-window no-resurrect), not guarantees proved by unit doubles.

### Workflow status mapping (resolved for MVP slice)

Native Workflow introspection is advisory only. Detail exposes `runtimeStatus` (`queued | running | complete | errored | terminated | null`) alongside the stored D1 `status`, but introspection NEVER writes Execution status. Execution status is written only by Workflow steps (`prepare-input-v1` for `Running`, `persist-success-v1`/`persist-failure-v1` for terminal states).

| Cloudflare Workflow instance `status()` | Advisory `runtimeStatus` | D1 `status` written by |
|---|---|---|
| `queued`, `running` | `Running` (advisory) | Workflow `prepare` step writes `Running` |
| `complete` | `complete` (advisory) | Workflow `persist-success` writes `Succeeded` |
| `errored` | `errored` (advisory) | Workflow `persist-failure` writes `Failed` |
| `terminated` | `terminated` (advisory) | Cancel endpoint writes `Cancelled` after `terminate()` |

`TimedOut` is never inferred from Workflow introspection alone. It is only written by `failSagaExecution`'s explicit `*_VENDOR_TIMEOUT` classification (ADR-033-3, issue #414; the `timeout-mark-v1` step retired with the sole-writer handoff) carrying `{ status: "TimedOut" }` so Wrangnarök can explain what timed out. Operation-level history beyond Workflow introspection is deferred (see Open questions).

### Step retries and Cancelling (finding 14 — canonical)

- **Step retries gated to engine-loss-only with operator ceiling 2:** the retry policy is a code table, `stepRetryLimit()` in `src/domain.ts`, which every Saga `step.do` resolves its retry limit through. Integration/vendor Operations (`echo-http-v1`, `ninja-list-orgs-v1`) resolve to `retries: 0`; only idempotent D1 checkpoint Operations (`prepare-input-v1`, `persist-success-v1`, `persist-failure-v1`) resolve up to ceiling 2 (`STEP_RETRY_CEILING`; `timeout-mark-v1` retired under ADR-033-3/issue #414); unknown step names fail closed to 0. All expected/business failures (bad input, `CONNECTION_NOT_CONFIGURED`, vendor `NINJA_*`/`ECHO_*`) are returned as structured step results and thrown as `NonRetryableError`, so the engine never retries a non-idempotent mutation. Proven by a workerd test that counts exactly one outbound vendor call on failure. The prior blanket `retries: 2` on arbitrary steps is rejected per upstream "retry is engine-loss-only".
- **Sleep/wait primitive (issue #16):** the native `WorkflowStep.sleep(name, duration)` (verified in the pinned `worker-configuration.d.ts`) is used on the echo success path (`settle-wait-v1`, `"1 second"`). It is deliberately an infrastructure checkpoint, not a product Operation: ExecutionHistory still records only `prepare-input-v1` and `echo-http-v1`. A workerd test proves wake+continue (Succeeded after the sleep, with an elapsed lower bound).
- **Timeout (issue #16, writer handed off under ADR-033-3/issue #414):** `TimedOut` is written exclusively by `failSagaExecution`'s explicit `*_VENDOR_TIMEOUT` classification inside `persist-failure-v1`, carrying `{ status: "TimedOut" }` with the structured vendor timeout code. The echo vendor step enforces its own deadline (`VENDOR_TIMEOUT_MS`); a slow vendor surfaces the timeout code through the canonical terminal writer, never via native Workflow introspection. Operation rows stay within `('Running','Succeeded','Failed')`; the timeout code lives in `error_json`.
- **Cancelling implemented (issue #16):** see `Cancellation` above. The Phase 2 investigation it was deferred to is discharged by the cancel endpoint + `terminate` mapping + idempotent re-cancel + terminal non-cancellability, all proven in workerd.

## Local testing strategy

Prefer real local Cloudflare emulation over fake interfaces:

1. pure domain tests for state transitions/serialization;
2. Worker-runtime tests with Cloudflare's Vitest integration;
3. local D1 for persistence tests;
4. local Workflows through Wrangler for end-to-end Execution tests;
5. mock external vendor HTTP at the Integration boundary.

This gives us meaningful local confidence without requiring a Cloudflare deployment or vendor credentials. Native gates that must stay workerd-backed (never unit doubles): same-key replay (`200 replayed:true`, single vendor call), conflicting-key `409 IDEMPOTENCY_CONFLICT`, expired-window `409 RECOVERY_EXPIRED` with no resurrection and no invented success.

## Consequences

- D1 intentionally duplicates a small amount of Workflow instance metadata because it is Wrangnarök's query/auth/history surface.
- Cloudflare remains visible in implementation code; this ADR is not a portability abstraction.
- We can change Cloudflare adapter details without renaming product concepts.
- Saga registration/stable identity becomes an early design dependency.
- No background Cron/outbox in the MVP slice; Free-tier idle cost stays at zero beyond stored rows.

## Open questions

- Delayed-start design: `Scheduled` promotion, due-time indexing, and server-generated keys once keyless submits are needed.
- Input/result size limits and whether larger payloads graduate to R2.
- Operation-level persisted history versus relying partly on Workflow introspection/observability.
- Progress reporting and lost-run detection: Execution record carries status/result but no `progress` field yet; caller-driven retry covers admission only, not mid-run liveness. Decide whether progress is a first-class Execution field or derived from Operation history.
- Job-contract hygiene (lift-and-shift lesson): shared Operation/Execution contract must not assume processes, cgroups, local filesystem persistence, or synchronous transports. Concurrency, cancellation, timeouts, and resource limits must be explicit fields, not host behavior.
- Retention/partitioning policy: D1 10 GB per-database limit plus Workflow history retention bound how long Execution/Operation history can be kept in place. Decide retention windows, partitioning, and what "expired/missing history" surfaces as (never invented success) before Phase 4 Tables/History querying.

Resolved by this ADR (per #15):

- ~~Exact status mapping from Cloudflare Workflow instances.~~ See `Workflow status mapping` above (advisory only).
- ~~Public idempotency-key contract.~~ See `Retry and idempotency` + `Invocation and creation protocol` above (required key, deterministic ID, `200 replayed:true` / `202`, `409 IDEMPOTENCY_CONFLICT`, `409 RECOVERY_EXPIRED`, `503 DISPATCH_UNCONFIRMED`).
- ~~Execution identity.~~ Deterministic SHA-256; UUIDv7 + `UNIQUE(idempotency_key)` rejected for MVP (see `Execution identity`).
- ~~Recovery window.~~ 15-minute same-revision refusal gate, `Pending` never swept, `Scheduled` distinct deferred (see `Recovery window`).
- ~~Dispatch.~~ `createBatch` + `dispatched` marker, caller-driven retry; reconciler/Cron deferred (see `Dispatch`).
- ~~Step retries and Cancelling.~~ Engine-loss-only gate with ceiling 2 via the `stepRetryLimit()` table; `Cancelling` implemented per issue #16 (see `Step retries and Cancelling` + `Cancellation`).
- Issue #16 (resilience): native `step.sleep` wait on the echo success path; `TimedOut` solely via the explicit timeout checkpoint (the `timeout-mark-v1` step at the time; retired under ADR-033-3/issue #414 with the handoff to `failSagaExecution`); owner-only cancel endpoint with `Running -> Cancelling -> Cancelled` onto native `terminate()`; vendor steps proven at zero auto-retries; `Cancelling` CHECK value via `migrations/0002_cancelling.sql`. `Scheduled` remains the only deferred state in this model.
- Issue #76 (Phase 2 cancellation/timeout investigation): no sweeper exists and none is planned — no Cron trigger, background job, or reconciler writes `TimedOut` (proven by `test/timeout-sweeper.test.ts`, including a no-`"crons"` tripwire on `wrangler.jsonc`). A stuck `Running` Execution stays `Running` until its vendor responds, its step ends on its own terms, or its owner cancels it; expired native history surfaces as unavailable, never inferred. Cancellation guarantees for in-flight external HTTP calls: none at the transport — an in-flight `fetch` cannot be recalled (the abort signal is sent but the vendor may ignore it); cancellation is fenced state only (conditional writes plus `terminate()`), and late vendor callbacks no-op against fenced `finishOperation` rows instead of overwriting terminal history. `NINJA_VENDOR_TIMEOUT` routes to `TimedOut` through the canonical terminal writer on all vendor legs (at the time, the `timeout-mark-v1` checkpoint on echo, digest census, ninjaone-orgs).
