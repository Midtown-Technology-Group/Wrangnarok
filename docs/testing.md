# Testing strategy

Wrangnarök should get as close to the real Cloudflare runtime as practical before deploying anything.

## Principle

**Mock vendors; emulate Cloudflare.**

Cloudflare's local tooling runs Workers under `workerd` and provides local implementations of bindings. Prefer those implementations to hand-written fake D1/Workflow/Queue/etc. interfaces whenever they are available.

## Layers

### 1. Pure TypeScript tests

Use ordinary Vitest tests for domain behavior that does not need bindings:

- Saga catalog/identity rules;
- Execution state transitions;
- structured errors;
- Integration request/response shaping;
- validation and serialization.

### 2. Worker-runtime tests

Use Cloudflare's current `@cloudflare/vitest-plugin` integration so tests execute in the Workers runtime and can access configured bindings.

Primary targets:

- HTTP routing;
- D1 repositories/migrations;
- authorization/context propagation;
- Integration code that depends on Worker runtime APIs.

### 3. Local D1

Run migrations against a local D1 binding. Test persistence and queries against Cloudflare's local D1 implementation rather than SQLite mocks.

Tests must be repeatable from an empty database and must not depend on production data.

Executable SQL fed to workerd D1 `exec()` in tests must contain no header comments — it rejects leading comment-only input (the wrangler CLI tolerates them, tests do not). Document SQL files in code or markdown, not in the SQL.

### 4. Local Workflows

Use `wrangler dev` local Workflows support for end-to-end Execution tests. Exercise creation, execution and inspection of Workflow instances locally.

MVP slice should prove:

```text
HTTP request
  -> Worker
  -> D1 Execution row
  -> local Workflow instance
  -> multiple durable Operations
  -> mocked external HTTP Integration
  -> terminal Execution state/result in D1
```

- Dual-write fault test (Worker-runtime + local D1 + local Workflow binding): crash between D1 `Pending` insert and `Workflow.create()`, then assert retry with the same `Idempotency-Key` returns the same `executionId` and reconciliation adopt-or-fails the `Pending` row (no second Workflow instance). Cover `create()`-throws and callback-never-arrives cases.
- Idempotency conflict test: same key + different canonical input => 409 `IDEMPOTENCY_CONFLICT` + original lookup path; stored input immutable; concurrent conflicting submits never both launch.
- Expiry test: `Pending` older than 10 minutes with absent Workflow history is never silently recreated; surfaces expired lookup path and requires a fresh key.
- Determinism authoring test: static assertion + runtime test that Saga `run` bodies contain no direct `Date.now()` / `Math.random()` / `fetch()` / top-level `ctx.integrations.*` outside `ctx.step.do()` / `defineOperation`, and that Saga `input`/`output` fixtures round-trip through `JSON.stringify` (serializable contract).
- Runtime smoke skeleton (local Wrangler, no login/deploy, temp config + temp state, teardown after): duplicate-submit, conflict-submit (409), cross-principal isolation (404 without touching Workflow binding), completion with bounded Operations, restart persistence (same key => same Execution + same result). Model on the lab spike's `scripts/runtime-smoke.mjs` crash/ambiguity windows: simultaneous same-key submits, lost create response, receipt-write failure, quota failure, retained receipt after history loss.

### 5. External Integration mocks

External APIs are the mock boundary. Tests should provide deterministic HTTP behavior for:

- success;
- validation/client error;
- transient server/rate-limit error;
- timeout/network failure where practical;
- malformed/unexpected response.

Do not make the core test suite require NinjaOne, Microsoft, Halo, or other vendor credentials.

### 6. Live Cloudflare smoke tests

After local MVP slice is green, deploy a minimal development instance to Cloudflare and repeat a small smoke path within Free-tier allowances. Live tests should remain sparse and must not become necessary for ordinary development.

## Tooling baseline

Use current versions at implementation time, but the intended stack is:

- TypeScript
- Wrangler
- Vitest 4+
- `@cloudflare/vitest-plugin`
- workerd/Miniflare through Cloudflare tooling

Avoid older `@cloudflare/vitest-pool-workers` examples when newer plugin documentation applies.

## Coverage

Coverage must use the Istanbul provider (`@vitest/coverage-istanbul`, `npm run test:coverage`).
Native V8 coverage is not supported under workerd: it needs `node:inspector`, which the Workers
runtime does not implement (Cloudflare documents this as a known Vitest-integration limitation).
`coverage/lcov.info` is uploaded to Codecov from CI.

Every metric (lines, functions, branches, statements) must stay at or above
95%. The floor is enforced in `vitest.config.ts` (`coverage.thresholds`), so
`npm run test:coverage` exits non-zero on a regression — locally and in the
CI runtime gate. Raise coverage with the change, never lower the floor to
make a red run green.

## Workflow test harness (issues #332/#333)

Full-suite runs execute 87 files against real local D1 + Workflow bindings.
The engine reports step failures, hung-request cancels, and introspector
lifecycle events as workerd-level unhandled exceptions even when the test
already asserted the terminal D1 state — noisy, but inherent to the runtime,
not to the product. Three pieces keep that noise isolated and honest:

- `test/helpers/workflow-harness.ts` — `useWorkflowHarness(db, options)`
  applies the FULL migration set in filename order in `beforeEach` (a
  Workflow step touching a table outside an ad-hoc subset used to fail with
  `D1_ERROR: no such table` as an unhandled exception instead of a readable
  failure), tracks every introspector via `trackWorkflowInstance`, and in
  `afterEach` drains each instance to a terminal status (bounded 2s waits,
  last-awaited status first) before disposing and calling `reset()`. No
  fire-and-forget waits cross the reset boundary.
- `test/setup-unhandled-guard.ts` — loaded via `test.setupFiles`, records
  every rejection escaping a test with an explicit allowlist for asserted
  stress paths (unknown-revision / vendor-fault NonRetryableErrors,
  not-found introspection, partial-migration gates, engine abort/cancel
  telemetry) and logs a `[unhandled-guard] HARD-FAIL` marker for anything
  outside it. Never broaden the allowlist to silence new noise without an
  asserted stress path behind it; fix the harness instead.
- Focused groups — `npm run test:unit` (pure TypeScript suites, no Worker
  surface) and `npm run test:workflow` (suites driving local Workflow
  instances). Membership is computed from file contents by
  `scripts/test-group.mjs`, so new files join the right group without a
  manifest update. Focused runs skip the coverage floor; the gates stay
  `npm test` and `npm run test:coverage`.

Files with intentional partial-migration coverage (pre-migration 503 gates,
DROP-rebuild sequences) keep their hand-built setup and must NOT adopt the
harness: applying the full set would mask the gate under test.

## Adversarial lifecycle track (issue #250)

`test/workflow-lifecycle.test.ts` provokes mid-lifecycle death against the
real local Workflow engine and pins the two invariants nothing else covers:

- terminating an instance mid-run never reads as success: detail keeps the
  engine `runtimeStatus` (`"terminated"`) beside the D1 checkpoint, `result`
  stays null, and operation checkpoints stay inspectable for reproduction;
- a same-key resubmit after mid-flight death replays the receipt without
  redispatching: the `dispatched` marker holds, so no second Workflow
  instance and no second vendor call.

Technique: the mocked vendor fetch is gated on a deferred promise, so
termination always lands with a vendor call provably in flight (scripted
interleaving, no sleeps, no timing assumptions); termination goes through
the native binding handle (`binding.get(id).terminate()`), the same call
the cancel route makes. `terminate` prints workerd `Aborting engine` noise
to stderr — expected, covered by the harness drain, not a failure.

Explicitly out of scope: duplicate/out-of-order *events*. `waitForEvent`
is not part of the Saga contract (`src/saga.ts`), so there is no
event-driven path to exercise; the determinism scanner already fails
closed on it.

Local-emulation limits: Miniflare runs real Workflow code but termination,
restart, and history-expiry timing are emulated — a green local run proves
the D1/engine contract, not production timing. The real-edge subset (retry
and durability behavior that depends on production Workflow semantics) is
periodic, uses only disposable test data and synthetic credentials, and is
never required for ordinary development or merges.

## CI direction

Initial CI should require:

- formatting/linting once configured;
- TypeScript typecheck;
- unit/Worker-runtime tests;
- local D1 migration/application tests;
- a local end-to-end Execution test once Workflows harnessing is stable in CI.

Production deployment should not be required to merge ordinary PRs.
