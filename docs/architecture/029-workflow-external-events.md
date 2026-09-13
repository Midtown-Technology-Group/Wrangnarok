# ADR 029: Workflow external events and approval waits

- **Status:** Proposed
- **Date:** 2026-09-12
- **Extends:** ADR 001 (Saga/Execution/Operation model), ADR 012 (Triggers)

## Context

Some automations need to pause durably for information that arrives after execution starts: a human approval, vendor webhook, asynchronous provisioning completion, callback, or other external signal.

Cloudflare Workflows supports `step.waitForEvent(...)`. A running Workflow can wait for a typed event with a timeout; callers can deliver that event through the Workflow binding (`instance.sendEvent`) or the Workflows API. Events may arrive before the Workflow reaches the matching wait and are buffered for later delivery.

Without this primitive Wrangnarok could recreate the behavior with D1 status rows, polling, schedules, and custom resume logic, but that would duplicate execution-state machinery Workflows already provides.

## Decision

### Use `waitForEvent` for in-flight Saga waits

When an already-running Saga must pause for an external event, prefer a Workflow event wait rather than implementing database polling/resumption.

```text
Saga step(s)
   -> waitForEvent("approval", timeout)
        [Workflow persists wait]
             <- authorized event delivery
   -> continue Saga
```

D1 remains the product/history query surface, but it is not the scheduler/resume engine for native Workflow waits.

### Trigger and in-flight event are distinct concepts

A **Trigger** starts a new Saga/Agent execution.

An **Execution Event** resumes or advances an existing Execution/Workflow instance.

Do not overload endpoint/webhook Trigger records to mean both. A vendor webhook may be configured either to start a new execution or, after explicit correlation/authorization, to deliver an event to an existing execution.

### All event delivery goes through a Wrangnarok authorization boundary

External callers do not receive arbitrary Workflows REST/binding authority. Wrangnarok resolves:

- the target Execution;
- Organization and requester/endpoint authority;
- allowed event type;
- correlation/replay identity;
- bounded payload schema;
- whether the Execution is currently eligible to receive that event.

Only then does platform code call `sendEvent`.

### Event types are stable runtime contract

Event type names are code/runtime identifiers with Cloudflare's naming constraints, not user-facing prose. Use stable bounded names (for example `approval`, `vendor_callback`, `device_ready`) and version them deliberately if payload semantics change.

Human-readable wait labels may change independently.

### Approval is a specialized event, not a separate execution engine

Human approval flows use the same event mechanism with stronger policy:

- identify the approver principal at delivery time;
- enforce the required role/organization/scope;
- record the approval/denial decision and provenance durably in D1 before or alongside event delivery;
- keep free-form comments bounded and scrubbed;
- define explicit timeout behavior (fail, branch, or escalate) in Saga/runtime policy.

A browser/UI action must never call the native Workflow event endpoint directly.

### Timeout is explicit domain behavior

`waitForEvent` can wait from seconds up to long-lived periods, but Wrangnarok must choose a bounded timeout for every event wait. On timeout, the Saga must deliberately map the native exception to product semantics rather than leaking Cloudflare error details.

Examples:

- approval timeout -> structured failure or explicit escalation branch;
- vendor callback timeout -> retry/reconcile branch if safe;
- optional human input -> catch timeout and continue with a documented default.

### Event payload is immutable input; durable derived state comes from steps

Treat the delivered event payload as input to the resumed computation. Any state that must survive and be queried later should be returned/persisted through normal durable Workflow steps and D1 history, rather than mutating the event object.

### Replay/idempotency remains required

An external event source must have a stable delivery/correlation identity where redelivery is plausible. Wrangnarok should reject conflicting duplicate events and avoid delivering one logical vendor/approval event multiple times merely because HTTP delivery retried.

Exact event-inbox schema is deferred to implementation, but correctness cannot rely solely on Workflow buffering.

## Consequences

### Positive

- Removes the need for custom poll/resume state machines in D1.
- Supports human-in-the-loop Sagas naturally.
- Vendor callbacks can resume the original durable execution rather than starting compensating polling jobs.
- Keeps Cloudflare Workflow internals behind Wrangnarok Execution semantics.

### Costs / risks

- Requires an explicit event-delivery API and authorization model.
- Correlation and duplicate delivery need durable product-level records.
- Long waits need clear retention/cancellation/operator UX.
- Native wait failure/timeout semantics must be adapted into stable Wrangnarok error/status behavior.

## Invariants

1. Triggers start executions; Execution Events resume existing executions.
2. External callers never get direct Workflow binding/API authority.
3. Every delivered event is Organization/Execution scoped and schema-bounded.
4. Human approval provenance is durably recorded outside transient Workflow state.
5. Every wait has explicit timeout semantics.
6. D1 does not poll to emulate a Workflow event wait.
7. Event redelivery must not create duplicate logical side effects.

## References

- Cloudflare Workflows events and parameters: `step.waitForEvent`, `instance.sendEvent`, buffering, event-type constraints, and configurable timeouts.
- ADR 001 for Wrangnarok Execution semantics.
- ADR 012 for the distinction between event sources/Triggers and execution behavior.
