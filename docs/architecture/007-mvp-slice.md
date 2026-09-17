# ADR 007: MVP slice submission and local execution slice

**Status: Conforming to ADR 001 (reconciled per issue #15, resilience per issue #16, 2026-09-09). Runtime validation: 32/32 workerd tests (see Verification).**

Related: [#4](https://github.com/MTG-Thomas/Wrangnarok/issues/4), [#2](https://github.com/MTG-Thomas/Wrangnarok/issues/2), [#15](https://github.com/MTG-Thomas/Wrangnarok/issues/15), [#16](https://github.com/MTG-Thomas/Wrangnarok/issues/16). Implements a narrow slice of ADRs 001-004; does not replace them or claim their open questions are settled. All divergence decisions defer to ADR 001 canonical rules.

## Primitive and identity boundaries

Use only Worker + Workflows + D1. The echo Saga has an explicit UUID in the static code catalog, separate from its source name/revision and Workflow binding. D1 snapshots that metadata in each Execution, so deleting or renaming source does not erase history. A separate catalog table is unnecessary for the single built-in Saga.

D1 is the product's query, authorization and history surface. Workflows owns durable execution/checkpoints. The Execution ID (deterministic SHA-256 hex per ADR 001, not UUIDv7) is also the native instance ID. No process worker, portability runtime or competing scheduler is introduced.

The fixture principal is configured locally, not supplied by the request. Every public Execution read checks both Organization and requester. The Workflow loads the Organization from its immutable Execution row, not from a client-provided execution context. Integration Connection resolution is exact-Organization with no upstream global/provider bypass semantics.

## Admission and ambiguous failure

Conforming to ADR 001 canonical rules (issue #15):

An Idempotency-Key is required: 16-128 ASCII alphanumeric or `._:-` characters (`400 INVALID_IDEMPOTENCY_KEY` otherwise). A SHA-256 hash of a versioned tuple of Organization, requester and key identifies one Execution. The same key with changed Saga/input returns `409 IDEMPOTENCY_CONFLICT` with the original lookup path; stored input is immutable. JSON input is validated before any write; HTTP bodies are capped at 4096 bytes and message text at 1024 UTF-8 bytes.

D1 reserves the immutable Execution before native dispatch. `Workflow.createBatch` with one instance provides retained-ID deduplication. A durable D1 dispatch marker (`dispatched = 1`) is written only after that call acknowledges. First dispatch returns `202 { executionId, replayed: false, statusUrl }`; same-key same-input replay returns `200 { executionId, replayed: true, statusUrl }` without forking. D1 and Workflows are not one atomic transaction.

If creation or marker persistence fails, return 503 `DISPATCH_UNCONFIRMED` + `Retry-After: 5`: work may have started, and the caller must retry the original key/input. No autonomous outbox, Cron, or reconciler is implemented (deferred per ADR 001). Reads never launch work. An unconfirmed reservation (`dispatched = 0`) may be retried only within 15 minutes and under the same Saga revision; later ambiguity returns `409 RECOVERY_EXPIRED` without relaunching and without auto-failing the row. `Pending` is durable and never swept; `Scheduled` is a distinct deferred state (immediate start only in this slice). Confirmed rows never dispatch again, even if native history has expired; missing/expired native history surfaces as unavailable (`runtimeStatus: null`), never as invented success.

This safety argument assumes Cloudflare retains instance IDs throughout that recovery window and nobody manually deletes/resets native instances or D1 records. Operators must not shorten retention below the window. Concurrent submission and ambiguous-failure behavior remain native-runtime test gates (same-key replay, conflicting-key 409, expired-window no-resurrect), not guarantees proved by unit doubles.

## Operations and history

Two product Operations are persisted in order: `prepare-input-v1` and `echo-http-v1` (ninja slice: `prepare-input-v1` and `ninja-list-orgs-v1`). Separate native steps persist terminal success/failure; not every infrastructure checkpoint is a product Operation. Prepared input and the echo outcome are checkpointed JSON. Expected Integration failures return a structured outcome so their code survives replay without relying on Error subclass transport.

Retry gate (ADR 001, upstream finding 14): every step.do retry limit resolves through the `stepRetryLimit()` code table — vendor/Integration steps 0 (fixture echo and Ninja list both resolve 0), only idempotent D1 checkpoint steps (`prepare-input-v1`, `persist-success-v1`, `persist-failure-v1`) up to the operator ceiling 2 (`timeout-mark-v1` retired under ADR-033-3/issue #414), unknown names fail closed to 0; all business failures throw `NonRetryableError`. A workerd test counts exactly one outbound vendor call on failure. The fixture Action has zero configured retries. It is a read-like echo POST, not a mutating vendor integration. A stable operation ID is sent, but the implementation does not claim exactly-once external effects. Future retryable mutations require destination-side idempotency and a deliberate policy.

Resilience (issue #16): the echo success path waits on the native `step.sleep("settle-wait-v1", "1 second")` primitive — an infrastructure checkpoint, not a product Operation. The echo vendor step enforces its own deadline (`VENDOR_TIMEOUT_MS`); a slow vendor surfaces `ECHO_VENDOR_TIMEOUT`, persisted as `TimedOut` solely by `failSagaExecution`'s explicit classification (ADR-033-3, issue #414; the `timeout-mark-v1` step retired). Owner-only `POST /api/executions/:id/cancel` (same fixture auth + org/requester scoping as reads; 404 for foreign owners) moves `Pending`/`Running -> Cancelling -> Cancelled` onto native `terminate()` (proven in local workerd), is idempotent while `Cancelling`, answers 409 on terminal states, and never lets a cancelled Execution dispatch (again).

List results omit input/results and return a maximum of 20 records plus `hasMore`. Cursor pagination is deferred. Detail exposes stored status, Operation records and a separate advisory `runtimeStatus` when native inspection succeeds. Native exception bodies are never public.

Normal success and expected failure are persisted in D1. If D1 or the runtime fails during the terminal checkpoint, D1 can remain Pending/Running. A missing native status is not interpreted as success, failure or expiry. Autonomous reconciliation stays deferred; caller-driven retry on `503` plus the refusal gate above is the complete MVP lifecycle. `TimedOut`/`Cancelled`/`Cancelling` are implemented controls per issue #16 (see above); `Scheduled` is the remaining deferred distinct state per ADR 001 (no delayed-start path, no promotion).

Admission/history records currently have no automatic cleanup. Growth is bounded by usage, not by a retention policy; this is another pre-production gate. Workflow source/step changes need versioning discipline before in-flight deployment upgrades are supported.

## Local fixture and safety

The only supported Connection endpoint is `http://127.0.0.1:8788/echo`. Redirects are rejected, HTTP has a five-second timeout and response byte bounds, and vendor failures become safe codes/messages. The demo cannot reach an arbitrary URL supplied by a caller. No real secret format or OAuth design is implied.

The default configuration disables the lab. An explicit local setup script creates an ignored random token and fixture identity without overwriting an existing file. This is not a production identity provider. A future deployed smoke Saga should avoid the loopback/vendor dependency, as required by ADR 004.

## Verification and Free-tier gate

Use the repo's Cloudflare Vitest plugin with real local bindings, not fake D1/Workflow implementations. Only the vendor HTTP boundary is mocked.

Gates (all in real workerd; D1/Workflow bindings never replaced):

- `npm run typecheck`, `npm test` (32/32: same-key replay `200 replayed:true` with single vendor call, conflicting-key `409 IDEMPOTENCY_CONFLICT`, expired-window `409 RECOVERY_EXPIRED` with no resurrection and no invented success, plus the issue #16 resilience suite — native sleep wake+continue, vendor zero-retry call count, slow-vendor `TimedOut` with `ECHO_VENDOR_TIMEOUT`, owner-only cancel `Running -> Cancelling -> Cancelled` via proven native `terminate()`, Pending immediate-cancel with no redispatch, terminal 409s — plus existing happy-path/failure/auth/tenant/ninja suites), `npm run build` (wrangler dry-run).

The design avoids paid-only primitives (no Cron/outbox, no extra index), but Free-tier viability has not been demonstrated. Measure Worker CPU, Workflow steps/requests, D1 rows read/written and retained storage for a full Execution and retries on the actual runtime. Do not equate the absence of an account ID with proven cost or performance behavior.

Platform API references used while authoring (checked 2026-09-09):

- https://developers.cloudflare.com/workflows/build/workers-api/
- https://developers.cloudflare.com/workers/testing/vitest-integration/
- https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
