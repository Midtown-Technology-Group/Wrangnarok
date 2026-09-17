# Steward checklist (recurring simplicity review)

Run on every ADR-level change, new Cloudflare primitive, auth/security boundary change, persistence-model change, or major parity slice completion — with a periodic fallback every 10th merge to `main`. Record the outcome as a comment on the umbrella issue (#132) or the relevant ADR.

## One-diagram test

Draw (or update) the single platform diagram. It must show exactly one authoritative path each for:

1. Authentication / authorization
2. Execution (Saga -> Execution -> Operations)
3. Persistence (D1 schema ownership, migrations)
4. Secrets (registration, storage, scrubbing, tripwires)
5. Deployment (bundle install, activation, rollback)
6. Recovery (failure modes, retries, cancellation, restore)

## Pass criteria

- One path per concern, named files + tests as evidence.
- No "depending on which feature landed when" branches.
- Migration numbers owned by the steward; no duplicate or skipped numbers.
- Every lane scope file current; no repeated out-of-scope touches.
- LIMITS-01 classifications current (free / paid-adaptation / redesign / unresolved).
- Operator-journey harness (single reproducible script: allowed + denied + recovery paths) green against local workerd.
- Phase 4-6 lanes earn merge per-lane: no presumption from work-started; pause/rescope any that forces a premature contract or violates the spine.

## Failure action

Pause new parity lanes. Open a consolidation issue naming the duplicated paths and the single surviving design. Resume fan-out only when the diagram is single-pathed again.

## History

- 2026-09-11: checkpoint adopted per #193. Baseline: auth spine (AUTH-01 merged, AUTH-02 in flight), runtime policy (RUN-01/02), schedules (TRG-01), connections (CON-01), single D1 schema with steward-owned numbering, SEC-01 scrub baseline, Solution activation via SOL-01.
- 2026-09-17: TRG-02 follow-through (issue #138, auth/security boundary change). One-diagram verdict: PASS, single path each. Authentication/authorization: operator session via Access plus membership gate, machine callers via service allowlist, endpoint deliveries via per-endpoint credentials resolving to `endpoint:<id>` principals (ADR 014, ADR 018). Execution: standard submit protocol for every admission path including endpoint deliveries (ADR 001). Persistence: single D1 schema, steward-owned migration numbering (no new migration in this slice). Secrets: ADR 005 v0 deployment store plus D1 digests only, scrub discipline retained. Deployment: catalog plus bundle activation pointer, untouched here. Recovery: Execution row before Workflow dispatch, no Pending sweep, caller redelivery on 503, no automatic mutation retry. No second authoritative path appears; fan-out continues.
- 2026-09-17: LIMITS-01 review per #177 (stacked on the TRG-02 main above). One-diagram paths unchanged (no new primitive on this lane; the OAUTH-01 Durable Object fence is now explicitly classified free in `docs/feasibility-envelope.md`). LIMITS-01 classifications current: Free per-database cap corrected to 500 MB, DO row added, W1–W3 workload estimates published, soft bundle budget made mechanical (715 KiB stacked on the TRG-02 705 KiB line after the AI-01 union tripped the new gate at 6,244 B headroom + 8 KiB minimum headroom + LIMITS-META sync gate). Bundle/budget gates and targeted tests green locally; full coverage gate to be confirmed by CI on the lane PR. No second authoritative path; lane touches only its scope.
