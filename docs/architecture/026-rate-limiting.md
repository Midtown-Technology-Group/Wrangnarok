# ADR 026: Native Workers Rate Limiting

- **Status:** Partially implemented (NinjaOne Execution admission); ADR 037 migration remains proposed
- **Date:** 2026-09-12
- **Extends:** ADR 037 (Endpoint and webhook Triggers)

## Context

ADR 037 currently uses per-endpoint minute counters in D1 before creating an Execution. Those counters are intentionally approximate under concurrency and consume D1 reads/writes for transient request-control state.

Cloudflare provides a Rate Limiting binding for Workers. A Worker calls the bound limiter with a bounded key; bindings may share a namespace across Workers. Cloudflare documents the limiter as low-latency and intentionally eventually consistent, so it is appropriate for request protection but not exact accounting.

## Decision

Prefer the native Rate Limiting binding for endpoint, webhook, agent-facing, and similar HTTP request limits when available. The D1 minute-counter implementation becomes a compatibility fallback, not the target architecture.

Rate limiting is policy, not durable application state. Execution idempotency, authorization, and other correctness rules remain independent and authoritative.

### Keys and namespaces

Use bounded, non-secret identifiers such as endpoint ID, organization ID, authenticated principal ID, or another documented resource identifier as limiter keys. Never use raw credentials or request bodies as limiter keys.

Namespace IDs and configured limits are deployment/runtime policy. Sharing a namespace across Workers is intentional only when the same logical limit should apply across those Workers.

### Not an accounting system

The limiter must not be used for exact billing/licensing counts, exact concurrency control, idempotency, or authorization. Its permissive/eventually consistent behavior is acceptable because the current ADR 037 limit is likewise protective rather than correctness-critical.

### NinjaOne Execution admission

All three Sagas that can use the provider-global NinjaOne credential are
protected before a new Execution row or Workflow exists:

- `ninjaone-orgs`, `ninjaone-org-lookup`, and `ninjaone-echo-digest` consume a
  principal budget of 5 requests per 60 seconds, keyed by environment,
  Organization, and authenticated user;
- the same requests then consume a shared provider budget of 30 requests per
  60 seconds, keyed by the constant `ninjaone:provider`;
- the principal check runs first so a caller already over its own budget does
  not consume shared provider capacity;
- a denial returns `429 ADMISSION_LIMITED`; a binding failure fails closed with
  `503 ADMISSION_UNAVAILABLE`, before persistence or dispatch;
- an exact existing Execution replay bypasses both checks. The existing row and
  retained Workflow ID prevent a second vendor call, while the replay remains
  available to recover an ambiguous dispatch response.

`submit` and `runProvider` share one `enforceNinjaOneExecutionBudget` gate, so
asynchronous and inline-provider entry points cannot drift. The engine retry
ceiling remains separately bounded at 2 and vendor retries default to 0.
Concurrent same-key requests can conservatively consume more than one token,
but Execution uniqueness still prevents duplicate work.

The deployed `dev` and `preview` bindings deliberately share stable namespace
IDs because they can share provider credentials and quota. Principal keys
include the environment; the provider key intentionally does not. Local/test
configuration keeps the binding shape with a high ceiling, while tests inject
deterministic limiter outcomes.

### Migration from ADR 037

When implemented:

1. add a rate-limit binding for public endpoint delivery;
2. map endpoint policy onto supported limiter windows/tiers;
3. keep Execution idempotency and endpoint replay records unchanged;
4. remove D1 counter writes from the normal delivery path once parity tests pass;
5. retain a clearly labeled D1 fallback only where the native binding is unavailable or cannot represent a required deployment policy.

If every endpoint's arbitrary dynamic rate cannot map cleanly to static binding configuration, prefer a small number of policy tiers rather than one binding per endpoint.

### Observability

Emit stable allowed/denied telemetry without logging limiter keys. Request diagnosis belongs in Workers Logs/Traces; aggregate counts can move to Analytics Engine if ADR 025 is adopted.

## Consequences

- Removes transient counter traffic from D1.
- Uses a Cloudflare primitive designed for request limiting.
- Keeps rate limiting separate from product truth and idempotency.
- Requires policy-tier design where endpoint limits vary dynamically.
- Distributed limits remain intentionally approximate.
- Bounds one caller and shared NinjaOne credential pressure per Cloudflare
  location; it is not a global exact quota and distributed callers can consume
  capacity in more than one location.

## Invariants

1. Rate limiting never substitutes for authorization or idempotency.
2. Approximate limiter behavior cannot protect a correctness invariant.
3. Limiter keys contain no credentials or arbitrary payloads.
4. D1 is not the preferred store for transient request counters once the binding is available.

## References

- Cloudflare Workers Rate Limiting binding documentation.
- ADR 037 for the existing endpoint delivery and replay model.
