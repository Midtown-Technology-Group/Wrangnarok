# ADR number ledger

This file is the steward-owned reservation source for Wrangnarok ADR numbers.

`docs/architecture/000-steward-checklist.md` is a reserved control/sentinel document, not ADR 000. The assignable ADR namespace begins at 001.

## Rules

1. An assigned ADR number is a permanent identity. Never reuse it, including after rejection, supersession, or renumbering history.
2. Reserve a number here before naming a file `docs/architecture/NNN-*.md` or changing an ADR heading to `ADR NNN`.
3. Unreserved proposals use `ADR TBD` and a non-numeric filename until a steward reserves a number.
4. For numbered ADRs, the three-digit filename prefix and `# ADR NNN` heading must agree.
5. CI fails closed on duplicate numbers, filename/header mismatches, numbered ADRs missing from this ledger, and numeric ADR headings in non-numeric files.
6. Renumbering is steward work. When unavoidable, preserve the old mapping in the repair history below and update unambiguous references in the same change.

## Canonical reservations

| ADR | File |
| --- | --- |
| 001 | `docs/architecture/001-execution-model.md` |
| 002 | `docs/architecture/002-saga-identity.md` |
| 003 | `docs/architecture/003-integrations-connections.md` |
| 004 | `docs/architecture/004-ci-cd.md` |
| 005 | `docs/architecture/005-secret-storage.md` |
| 006 | `docs/architecture/006-naming.md` |
| 007 | `docs/architecture/007-mvp-slice.md` |
| 008 | `docs/architecture/008-full-stack-app.md` |
| 009 | `docs/architecture/009-workers-builds-evaluation.md` |
| 010 | `docs/architecture/010-phase1b-design.md` |
| 011 | `docs/architecture/011-solutions-contract.md` |
| 012 | `docs/architecture/012-phase2-triggers.md` |
| 013 | `docs/architecture/013-phase2-egress-limits.md` |
| 014 | `docs/architecture/014-access-auth.md` |
| 015 | `docs/architecture/015-org-lifecycle.md` |
| 016 | `docs/architecture/016-dev-preview-sync.md` |
| 017 | `docs/architecture/017-authored-apps.md` |
| 018 | `docs/architecture/018-child-invocation.md` |
| 019 | `docs/architecture/019-app-runtime-sdk.md` |
| 020 | `docs/architecture/020-ops-audit-notifications.md` |
| 021 | `docs/architecture/021-user-code-source-runtime.md` |
| 022 | `docs/architecture/022-openapi-codemode-mcp.md` |
| 023 | `docs/architecture/023-sync-providers.md` |
| 024 | `docs/architecture/024-private-connectivity-workers-vpc.md` |
| 025 | `docs/architecture/025-analytics-engine-observability.md` |
| 026 | `docs/architecture/026-rate-limiting.md` |
| 027 | `docs/architecture/027-heavy-runtime.md` |
| 028 | `docs/architecture/028-email-service.md` |
| 029 | `docs/architecture/029-workflow-external-events.md` |
| 030 | `docs/architecture/030-vectorize-semantic-index.md` |
| 031 | `docs/architecture/031-form-binding.md` |
| 032 | `docs/architecture/032-solution-export.md` |
| 033 | `docs/architecture/033-endpoint-triggers.md` |
| 034 | `docs/architecture/034-managed-files.md` |
| 035 | `docs/architecture/035-resource-roles.md` |
| 036 | `docs/architecture/036-runtime-policy.md` |
| 037 | `docs/architecture/037-artifacts.md` |
| 038 | `docs/architecture/038-scoped-config.md` |
| 039 | `docs/architecture/039-cloudflare-agents-runtime.md` |

**Next available reservation: 040.**

`docs/architecture/worker-authority-boundaries.md` remains intentionally unreserved as `ADR TBD`. It receives a number only through this ledger.

## Collision repair — 2026-09-14

The repository accumulated parallel ADR numbering during concurrent implementation lanes. The repair keeps semantically entrenched or authoritative occupants where that matters and otherwise keeps the earlier established occupant, then moves displaced ADRs above the previous high-water mark (`030`).

| Historical file | Canonical file | Reason |
| --- | --- | --- |
| `015-form-binding.md` | `031-form-binding.md` | Preserve `ADR 015` as Organization lifecycle; downstream auth docs already use that meaning. |
| `016-solution-export.md` | `032-solution-export.md` | Preserve the earlier DEV-02 preview ADR at 016. |
| `018-endpoint-triggers.md` | `033-endpoint-triggers.md` | Preserve the earlier RUN-02 child-invocation ADR at 018. |
| `018-managed-files.md` | `034-managed-files.md` | Same five-way 018 collision repair. |
| `018-resource-roles.md` | `035-resource-roles.md` | Same five-way 018 collision repair. |
| `018-runtime-policy.md` | `036-runtime-policy.md` | Same five-way 018 collision repair; RUN-01 remains authoritative by title/file, not by the historical duplicate number. |
| `019-artifacts.md` | `037-artifacts.md` | Preserve the earlier APP-02 runtime SDK ADR at 019. |
| `020-scoped-config.md` | `038-scoped-config.md` | Preserve the earlier OPS audit/notifications ADR at 020. |
| `023-cloudflare-agents-runtime.md` | `039-cloudflare-agents-runtime.md` | Preserve implemented RUN-03 sync providers at 023; Agents ADR is still Proposed. |

Historical references that say only `ADR 018`, `ADR 019`, `ADR 020`, or `ADR 023` without a title/file are inherently ambiguous. Do not mechanically rewrite them. Resolve them by topic against this table and then update the reference explicitly.
