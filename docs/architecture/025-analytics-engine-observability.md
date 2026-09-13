# ADR 025: Analytics Engine for high-cardinality operational telemetry

- **Status:** Proposed
- **Date:** 2026-09-12
- **Extends:** ADR 004 (CI/CD and native observability), ADR 001 (Execution/Operation model)

## Context

Wrangnarok already has two different kinds of observability data:

1. durable product truth that operators must be able to query reliably later (Executions, Operations, author logs, audit/provenance); and
2. high-volume analytical telemetry such as latency distributions, per-Integration request counts, rows-read/rows-written cost signals, rate-limit events, model/tool usage, and per-Organization service-health dimensions.

D1 is appropriate for the first category, but using it as a metrics warehouse would increase row-write/read cost and couple operational analytics to product-state retention. Workers Logs/Traces are useful diagnostic streams but are not the ideal user-defined, high-cardinality analytics store.

Cloudflare Workers Analytics Engine provides a binding for non-blocking custom data-point writes and a SQL query surface designed for high-cardinality service analytics and usage measurement.

## Decision

### Analytics Engine is the preferred store for aggregate operational telemetry

Use Analytics Engine for data that is valuable in aggregate but is not itself authoritative application state.

Representative events include:

- Integration call latency/outcome/provider/status class;
- D1 `rows_read`, `rows_written`, query duration and serving-region signals;
- rate-limit allowed/denied events;
- Workflow/Saga duration and step-performance summaries;
- model/provider/token/tool usage for agents;
- queue lag/consumer processing summaries where measured;
- per-Organization and per-capability usage suitable for capacity or cost analysis.

D1 remains authoritative for Executions, Operations, durable author logs, configuration, Connections, audit records required for product behavior, and any record whose loss would change what Wrangnarok believes happened.

### Telemetry writes must never be on the correctness path

Analytics Engine writes are observational side effects. Failure to emit a metric must not fail a Saga, Integration call, endpoint delivery, or authorization decision.

```text
operation
  |-- durable state/audit -> D1 (correctness)
  `-- metric point ------> Analytics Engine (observation)
```

Telemetry instrumentation must be bounded and best-effort.

### Use stable dimensions, not arbitrary payloads

Datasets should use a documented, low-surprise schema with stable operation names and bounded dimension values. Never emit raw request/response bodies, prompts, secrets, tokens, free-form exception dumps, or unbounded user strings.

Useful dimensions include stable IDs/slugs such as:

- environment;
- organization ID (only where operator-visible analytics requires it);
- saga/integration/capability name;
- operation name;
- outcome/error code;
- model/provider name;
- region/primary-replica indicator.

High-cardinality support is not permission to create a second event log.

### Redaction and privacy policy applies before emission

ADR 005's secret registry/redaction contract applies to telemetry just as it applies to logs and HTTP responses. Where a metric can be represented by an enum/counter instead of a potentially sensitive string, prefer the enum/counter.

### Logs/traces, D1, and Analytics Engine have distinct roles

- **Workers Logs/Traces:** request-level diagnosis and trace correlation.
- **D1:** durable application/audit truth.
- **Analytics Engine:** aggregate/high-cardinality metrics and usage analysis.

No one store should be treated as a complete substitute for the other two.

### D1 cost/performance instrumentation should emit here

The query-cost tooling tracked separately should expose D1 result metadata under stable operation names. Production aggregate analysis of rows read/written and latency should target Analytics Engine rather than persisting one metric row per query into D1.

### Retention and billing semantics are not product state

Analytics Engine retention/availability may evolve independently of Wrangnarok's durable history policy. User-facing compliance/audit requirements must therefore remain in D1 or another explicitly durable product store.

## Consequences

### Positive

- Avoids turning D1 into a metrics database.
- Enables high-cardinality per-Organization/integration cost and health analysis.
- Supports cost optimization using actual observed rows-read/written and latency signals.
- Keeps metrics writes off latency-critical paths.
- Provides a natural target for future operator dashboards and usage reports.

### Costs / risks

- Introduces another Cloudflare primitive and query surface.
- Dataset schema discipline is required to prevent telemetry drift.
- Analytics data must not accidentally become an undocumented source of truth.
- Local/dev behavior needs a simple fallback or fixture strategy where Analytics Engine emulation is incomplete.

## Invariants

1. Analytics Engine is never required to determine whether an operation succeeded.
2. Durable audit/product history stays in D1 (or another explicitly durable product primitive).
3. Raw secrets, prompts, provider bodies and arbitrary user payloads are not telemetry dimensions.
4. Telemetry emission is best-effort and bounded.
5. Stable operation/capability names are preferred over raw SQL or free-form messages.

## References

- Cloudflare Workers Analytics Engine overview and Workers binding examples.
- Cloudflare positions Analytics Engine for high-cardinality service health, per-customer usage, and usage-based measurement, with non-blocking writes.
