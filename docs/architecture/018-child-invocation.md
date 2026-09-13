# ADR 018: Nested Saga invocation (RUN-02)

**Status:** Accepted (RUN-02, issue #136).

## Context

Upstream `gobifrost/bifrost@3543c7e` has two distinct nested-execution shapes,
pinned from source (inspected, not executed):

- **Inline/local:** the engine executes a `func` passed directly
  (`ExecutionRequest.func` in `api/src/services/execution/engine.py`) with the
  caller's `ExecutionContext` carried in a `ContextVar`
  (`api/bifrost/_context.py`). No new execution row, no new ID.
- **Remote registered:** `workflows.execute(workflow, input_data, org_id,
  run_as, ...)` (`api/bifrost/workflows.py`) POSTs
  `/api/workflows/execute` with `sync: False` and returns an execution ID
  (fire-and-forget receipt; status follows via `workflows.get`).
  It auto-includes the ambient `org_id` and `solution_id` (install scope);
  `org_id`/`run_as` overrides are admin-only. Scope tests
  (`api/tests/e2e/api/test_scope_execution.py`) prove org-scoped executions
  see only their own org data, and explicit scope override requires the
  platform-admin or provider-org gate (`resolve_scope`).

Upstream completion vocabulary (`api/src/models/enums.py`) includes
`CompletedWithErrors` alongside `Success`/`Failed`/`Timeout`; Wrangnarok keeps
its narrower taxonomy (ADR 001) as an explicit adaptation.

## Decision

Wrangnarok adopts the **remote-registered shape only**, mapped onto
Cloudflare-native primitives. There is no inline function-import path (no
shared-process function passing exists between Workflow instances), and no
process-pool infrastructure is copied.

- **Author surface:** `ctx.children.invoke(childRef, input, { key, step })`
  inside `step.do(...)` returns a queued receipt `{ executionId, sagaId,
  replayed, statusUrl }`; `awaitChildResult(ctx, step, receipt, ...)` polls
  the child D1 row to terminal through `step.sleep` intervals and returns
  the typed JSON output. Dispatch (async receipt) and completion (sync
  result) stay distinct surfaces, mirroring upstream's `execute`/`get`
  split. `ctx.children` joins the determinism scanner's forbidden-outside-
  `step.do()` list alongside `ctx.integrations`/`ctx.db`/`ctx.secrets`.
- **Caller/Organization context:** the child inherits `org_id`/`user_id`
  from the parent D1 Execution row, never from author input: `invokeChild`
  takes no org parameter, so a foreign-org child is unconstructable. Child
  identity is a UUID-or-exact-name catalog lookup; unknown refs fail with
  `CHILD_SAGA_NOT_FOUND`. No AUTH-02 role model exists yet; every catalog
  Saga is invokable from its own Organization. That is documented here, not
  hidden.
- **Parent-child identity:** one deterministic child Execution ID per
  `(parent, step, child, key)` tuple
  (`sha256(["wrangnarok.child.v1", ...])`, submitted as the child's
  `Idempotency-Key`), so step retries and duplicate dispatches converge on
  one child row via the existing `ON CONFLICT DO NOTHING` + retained-ID +
  `dispatched` protocol (ADR 001). Lineage persists as
  `executions.parent_execution_id` / `parent_step`; detail serves
  `parentExecutionId` plus a `children` list. History summaries are
  unchanged.
- **Completion/failure:** child terminal `Succeeded` yields its JSON output
  (parse failure is `CHILD_RESULT_CORRUPT`, never invented success). Child
  terminal `Failed`/`TimedOut`/`Cancelled` yields `CHILD_FAILED` carrying
  `{ childExecutionId, status, code }`; the parent persists its own `Failed`
  checkpoint. The await deadline yields `CHILD_AWAIT_TIMEOUT`; the child
  keeps running and stays inspectable. Dispatch ambiguity yields
  `CHILD_DISPATCH_UNCONFIRMED` (retry the parent under the same key).
- **Timeout/cancel propagation:** vendor deadlines stay per-Saga
  (`timeout-mark-v1` remains the sole `TimedOut` writer). Awaiting does not
  cancel. Parent cancellation fans out best-effort to still-active direct
  children through the same mark-then-terminate-then-classify protocol as
  the parent (RUN-04); ambiguous children stay active and inspectable, and
  parent confirmation never depends on child outcomes.
- **Policy surface:** the dispatch step `child-dispatch-v1` joins the
  `stepRetryLimit` checkpoint set (convergent retry); poll steps are reads
  (limit 0). No new Cloudflare primitive: Worker + Workflows + D1 only.

## Consequences

- A `hello-parent` demo Saga exercises the contract end to end on real
  local bindings; `test/child-invocation.test.ts` proves duplicate
  dispatch, parent cancel, and child timeout in workerd.
- Free-tier posture unchanged: one extra D1 row per child plus bounded
  poll steps; no Cron, Queue, or DO.
- Deferred: cross-org invocation, role-gated child visibility (AUTH-02),
  bounded synchronous HTTP submit (RUN-03), `CompletedWithErrors`.
