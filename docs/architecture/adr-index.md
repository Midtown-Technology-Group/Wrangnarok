# ADR index and number ledger

Machine-checkable ledger of Architecture Decision Record numbers. Enforced by
`scripts/check-adr-numbers.mjs` (fail-closed in CI, issue #225).

## Numbering rule

- Each ADR owns exactly one three-digit number; the file is named
  `<number>-<slug>.md` and its H1 is `# ADR <number>: <title>`.
- New ADRs take the number in **Next free** below, then advance that line.
- Unreserved decisions stay at non-numeric `TBD-*.md` filenames and are not
  listed in the table. `000-*` is reserved steward tooling, not an ADR, and
  is likewise out of scope for the guard.
- On a collision, the steward decides; the #225 convention (delegated) is
  earliest-landed keeps the number, later-landed moves to the next free
  numbers in landing order, with a renumber note in each moved file.

Next free ADR number: 044.

## Index

| Number | File | Title |
| --- | --- | --- |
| 001 | 001-execution-model.md | Saga, Execution, and Operation execution model |
| 002 | 002-saga-identity.md | Stable Saga identity and discovery |
| 003 | 003-integrations-connections.md | Integrations and Connections |
| 004 | 004-ci-cd.md | CI/CD and deployment safety |
| 005 | 005-secret-storage.md | Per-Organization Secret Storage |
| 006 | 006-naming.md | Boring names for load-bearing concepts |
| 007 | 007-mvp-slice.md | MVP slice submission and local execution slice |
| 008 | 008-full-stack-app.md | Full-stack app on a single Worker |
| 009 | 009-workers-builds-evaluation.md | Stay on GitHub Actions, not Workers Builds |
| 010 | 010-phase1b-design.md | Phase 1b design for #58 — ctx, states, Connections, source boundary |
| 011 | 011-solutions-contract.md | Solutions — portable bundles, install reconciliation, activation |
| 012 | 012-phase2-triggers.md | Phase 2 Trigger investigation — schedules and webhooks |
| 013 | 013-phase2-egress-limits.md | Phase 2 egress and resource limits per Integration |
| 014 | 014-access-auth.md | Human Authentication via Cloudflare Access |
| 015 | 015-form-binding.md | Forms-to-Saga input binding (FORM-01) |
| 016 | 016-solution-export.md | Solution source capture, export, and import |
| 017 | 017-authored-apps.md | Authored Applications — independent vs Solution-owned lifecycle, ownership, recovery, build security |
| 018 | 018-runtime-policy.md | Persisted per-Saga runtime policy (RUN-01) |
| 019 | 019-app-runtime-sdk.md | Browser App SDK runtime — scoped workflows, Tables, files, live updates |
| 020 | 020-ops-audit-notifications.md | Administrative audit trail and operational notifications (OPS-01 slice) |
| 021 | 021-user-code-source-runtime.md | Git-Authored User Code and Immutable Runtime Artifacts |
| 022 | 022-openapi-codemode-mcp.md | OpenAPI Code Mode for Agent-Driven Integration Calls |
| 023 | 023-sync-providers.md | Bounded synchronous and data-provider execution (RUN-03) |
| 024 | 024-private-connectivity-workers-vpc.md | Private connectivity with Workers VPC |
| 025 | 025-analytics-engine-observability.md | Analytics Engine for high-cardinality operational telemetry |
| 026 | 026-rate-limiting.md | Native Workers Rate Limiting |
| 027 | 027-heavy-runtime.md | Cloudflare Containers as an earned runtime escape hatch |
| 028 | 028-email-service.md | Cloudflare Email Service for email Triggers and notifications |
| 029 | 029-workflow-external-events.md | Workflow external events and approval waits |
| 030 | 030-vectorize-semantic-index.md | Vectorize as the semantic index for Wrangnarok knowledge |
| 031 | 031-scoped-config.md | Scoped Configuration and Secret References |
| 032 | 032-ai-provider-model.md | AI Provider Connections, Model Profiles, and Capability Assignments |
| 033 | 033-saga-authoring-ergonomics.md | Saga authoring ergonomics — less ceremony over the canonical contract |
| 034 | 034-org-lifecycle.md | Organization and User Lifecycle (AUTH-01) |
| 035 | 035-dev-preview-sync.md | Local-first preview, sync, and deploy validation (DEV-02) |
| 036 | 036-managed-files.md | Managed file locations over R2 with D1 metadata, policy-checked proxy access, and finalize-after-upload |
| 037 | 037-endpoint-triggers.md | Endpoint and webhook Triggers |
| 038 | 038-resource-roles.md | Resource Roles, Claims, and Delegated Authorization (AUTH-02) |
| 039 | 039-child-invocation.md | Nested Saga invocation (RUN-02) |
| 040 | 040-artifacts.md | Generated Artifacts — D1 identity plus R2 bytes, attachment bindings, retention |
| 041 | 041-cloudflare-agents-runtime.md | Cloudflare Agents SDK as the Platform-Agent Runtime |
| 042 | 042-frontend-split-decision.md | Frontend/static-assets split — keep the single deployment |
| 043 | 043-child-dispatch-authorization.md | Child dispatch authorization (RUN-02 / AUTH-02) |

## Renumber history (issue #225)

- ADR 020 collision: later-landed scoped-config moved 020 → 031 (2026-09-15).
- ADR 015 collision: later-landed org-lifecycle moved 015 → 034 (2026-09-18).
- ADR 016 collision: later-landed dev-preview-sync moved 016 → 035 (2026-09-18).
- ADR 018 collision (five files): managed-files → 036, endpoint-triggers →
  037, resource-roles → 038, child-invocation → 039, in landing order
  (2026-09-18). Earliest-landed runtime-policy keeps 018.
- ADR 019 collision: later-landed artifacts moved 019 → 040 (2026-09-18).
- ADR 023 collision: later-landed cloudflare-agents-runtime moved 023 → 041
  (2026-09-18).
