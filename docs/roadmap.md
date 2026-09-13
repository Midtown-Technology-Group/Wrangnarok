# Roadmap

Wrangnarök grows by proving Bifrost-like product capabilities on Cloudflare primitives without prematurely recreating Bifrost's infrastructure.

## Phase 0 — MVP slice

Goal: prove the minimal durable execution loop on Cloudflare Free.

- Worker API
- D1 catalog/ExecutionHistory with `org_id` column on all Execution/Connection/ExecutionHistory rows from day one
- single default Organization (`default` stub ID); explicit propagation via `ctx`; no multi-tenancy/auth yet
- one TypeScript Saga
- one Execution
- multiple durable Operations backed by Workflow steps
- one simple HTTP Integration
- execution status/results (JSON history + detail API; first read-only UI slices — history view, sagas catalog — served from the same Worker per ADR 008; fuller author-facing UI stays Phase 4)
- idempotency conflict (409) + 15-minute same-revision retry gate (Pending never swept) + HTTP hardening per ADR 001
- failure test
- documented Free-tier consumption

Tracked by issue #1.

## Phase 1 — Identity before features

Before adding lots of integrations, settle the contracts that are expensive to change later:

- stable Saga identity independent of source edits — Implemented (#80, #85)
- Saga discovery/registration model — Implemented (#83, #85)
- Execution and Operation state model — Implemented (#83)
- Organization context propagation via `ctx` (builds on Phase 0 `default` stub; still no multi-tenancy/auth) — Implemented (#80, #83)
- Integration vs Connection contract — Implemented (#80, #83, #88)
- local-development behavior — Implemented (#80)
- source metadata vs persisted runtime policy — Implemented (#80, #83)

## Phase 2 — Real orchestration

Prove that the model handles useful API automation:

- second Integration
- multi-Integration Saga
- retries and actionable downstream errors
- sleeps/waits
- cancellation/timeout investigation
- concurrency and idempotency rules
- ExecutionHistory querying
- schedules/webhook Triggers
- egress/resource-limits note: document allowed outbound hosts, redirect/timeout/byte-bound policy per Integration, non-HTTP and private-registry/IP-allowlist limits, and per-Operation timeout/retry/concurrency caps (lift-and-shift lesson: working dependencies do not guarantee connectivity)

Only introduce Queues or Durable Objects when a demonstrated orchestration requirement needs them.

## Phase 3 — Multi-tenant Connections

- full Organization model: multi-tenancy, isolation, and authorization (extends Phase 0 `default` stub and `org_id` columns; no schema retrofit)
- Connection resolution
- secure credential storage decision (see ADR 005; Proposed, not production-approved)
- first OAuth Integration
- token refresh lifecycle
- tenant isolation tests
- authorization model

Security design is a gate here, not cleanup afterward.

Phase 0's `default` stub exists precisely to avoid retrofitting `org_id` later.

## Phase 4 — Author-facing platform surfaces

Investigate/adapt upstream capabilities:

- Tables over D1 (with retention/partitioning policy for the 10 GB per-database limit; atomic batch-write authz; counts/pagination; visibility-transition and revocation handling)
- Forms
- Artifacts/files over R2 (verify uploads, signed access, multipart, metadata, cleanup, authorization at operation level; container/Worker-local files are temporary)
- richer Triggers/topics (durable state for reconnects; events are not the source of truth)
- search/indexing when earned (organization scope, permissions, filtering, explicit reindex operation; async-index consistency documented)
- full-stack web UI (Vite + React tentpole, served as Workers Static Assets from the same Worker; see ADR 008)
- role/policy model as justified

## Phase 5 — Portable bundles

Explore the strongest ideas from Bifrost Solutions without blindly cloning their implementation:

- portable definition vs Organization installation
- manifests/catalog
- one definition installed in many Organizations
- environment state excluded from source packages
- declarative ownership/reconciliation
- atomic version activation with rollback and cache invalidation (persist inputs/outputs outside execution; interrupted activation restarts, never half-activates)
- versioning/export/install

## Phase 6 — AI/tool surface

Only after the ordinary orchestration platform is coherent:

- opt-in tool exposure for Sagas/Integration Actions
- authorized inbound MCP gateway with permission preservation through AI callers
- progressive OpenAPI Code Mode for broad vendor APIs rather than one handwritten MCP/tool wrapper per endpoint (ADR 022)
- host-mediated Integration execution: model code gets a constrained request capability, never Connection credentials or unrestricted network access
- HaloPSA proof: natural-language discovery + authorized read/mutation against Halo's OpenAPI surface with no endpoint-specific tool wrapper
- curated semantic tools/Sagas retained for stable business operations, orchestration, validation, and compensation
- tool discovery metadata, operation risk classification, audit/provenance, and deny-by-default mutation policy

## Continuous upstream-spec work

For every phase, compare against current `gobifrost/bifrost` docs, source, and tests. Record behavioral invariants in `docs/upstream-spec.md`. Upstream is allowed to teach Wrangnarök product lessons without dictating its infrastructure.
