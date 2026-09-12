# ADR 011: Solutions — portable bundles, install reconciliation, activation

- **Status:** Accepted (2026-09-10; gates production promotion per issue #35; dev deploy unaffected)
- **Date:** 2026-09-10
- **Extends:** upstream findings 9–11, ADR 002 (stable identity), ADR 003 (Integration vs Connection), ADR 005 (secret storage)
- **Upstream compatibility:** verified against `gobifrost/bifrost` Solutions machinery (`api/src/services/solutions/`, ORM + contracts, Sep 2026 mirror). Ideology preserved throughout; divergences below are explicit and Cloudflare-driven.

**Implementation audit, 2026-09-11 ([#132](https://github.com/MTG-Thomas/Wrangnarok/issues/132)):** this is an accepted target, not a statement that every guarantee shipped with #35. `src/solutions.ts:300-442` currently preflights/reconciles declared Connection endpoints and appends an install ledger. The inspected implementation/schema do not supply absent-managed-row deletion, an active-install pointer/execution gate or atomic multi-row visibility. Re-running converges, but partial failure can leave earlier row writes visible. The parity map tracks these gaps without silently weakening the target or adopting a new architecture.

**SOL-01 shipped, 2026-09-11 (issue #161):** migration `0010_solutions_activation.sql` (renumbered from colliding 0005 on 2026-09-11; see docs/migration-ledger.md) plus the `src/solutions.ts` rework close the gaps above. `bundle_active` is the per-org activation pointer (moved only on full reconcile success through a fenced conditional write), `bundle_config` persists the manifest config list as desired state per org, `bundle_sagas` persists saga pins per org, `connections.config_json` persists the full non-secret connection config, and `bundle_installs` is immutable install evidence (SQLite triggers reject UPDATE/DELETE). `requireActiveInstall` fails execution closed against the applicable active install/revision with the explicit local/loose exception (orgs with no install rows). The corrected upstream attribution below is unchanged: everything in this paragraph stays a Wrangnarök local decision.

## Context

Upstream Bifrost separates a portable Solution definition (apps, workflows, forms, integrations, config declarations, claims) from each Organization installation (independent identity, config, credentials, runtime data). Managed entities reject live mutation; deploy reconciles by full replacement while environment data follows separate rules.

Wrangnarök currently has half of this: stable Saga/Integration IDs, D1 snapshots in Execution rows, and seed scripts. It lacks a manifest (what *is* the bundle?), an install path (remote state today is seeded by hand-run scripts with no reconciliation), any owned-vs-loose distinction (every D1 row is effectively loose), and activation semantics. Production promotion without these means hand-built tenant state with no source of truth — the exact failure the standing rule (no hand-mutated remote state) exists to prevent.

## Decision

### 1. Manifest: `solution.manifest.json`, versioned, environment-free by construction

A bundle is one manifest file plus the Git tree it points at. Schema (v1):

```json
{
  "manifestVersion": 1,
  "bundle": { "id": "00000000-0000-0000-0000-000000000000", "name": "acme-starter", "version": "1.2.0" },
  "sagas": [{ "id": "<stable-saga-uuid>", "revision": "echo-v1" }],
  "integrations": [{ "id": "<stable-integration-uuid>", "connections": [{
    "org": "default",
    "config": { "endpoint": "https://api.example.com" },
    "secretsRequired": ["clientSecret"]
  }] }],
  "config": [{ "key": "supportEmail", "value": "ops@example.com" }]
}
```

Structural exclusions (rejected by validation, not convention): credential/token *values* (only `secretsRequired` names), Execution/Operation/history rows, Workflow instance IDs, environment URLs that embed tenant identity. Secrets resolve at install time from env/Secrets Store per ADR 005 — the manifest never carries them and `secretsRequired` names must exist in the Integration's declared secret schema.

**Explicit divergence — format:** upstream ships `bifrost.solution.yaml` plus `.bifrost/*.yaml` declarations inside a zip. Wrangnarök uses a single JSON manifest: Worker-native parsing with no YAML dependency, and no packaging step in v1 (Section 5). Same ideology (source + declarations only, values excluded); different container.

### 2. Install is reconciliation, not seeding

`installBundle(db, manifest, { strict })` is idempotent per row and restart-safe:

1. Validate manifest (schema version, UUIDs resolve against the static code catalog, no environment values).
2. Ensure the Organization row; record the install in `bundle_installs(bundle_id, version, org_id, manifest_hash, installed_at)` (immutable: triggers reject UPDATE/DELETE).
3. For each declared Connection: INSERT missing managed rows; UPDATE drifted managed rows to manifest values **iff** the row's `managed_by` matches this bundle (same bundle id); DELETE managed absentees scoped to this bundle install; never INSERT credentials, never touch `executions`/`operations`/`usage_blocks` or any row with `managed_by = NULL` created outside install. Desired Connection state is the full non-secret config (persisted as `connections.config_json`), and the manifest `config` list plus saga pins persist per org (`bundle_config`, `bundle_sagas`).
4. Move the per-org activation pointer (`bundle_active`) only on full reconcile success through a fenced conditional write; same-version divergent content is refused (`INSTALL_CONFLICT`) at preflight and at activation.
5. Report a drift plan first (`--dry-run` lists create/update/skip/delete); apply only on explicit invocation.

Execution runs only against the applicable active install/revision (`requireActiveInstall`, checked in `submit` before the Execution row write): `NO_ACTIVE_INSTALL` when no install covers the org + saga, `STALE_INSTALL_REVISION` when the active pin disagrees with deployed code. Orgs with no install rows at all keep working under the explicit local/loose development exception.

Re-running converges for declared values; every install still appends a ledger row as immutable evidence. Restart-safe per-row reconciliation does **not** establish atomic visibility or absence of partial state: an interrupted install leaves earlier row writes visible while the pointer still names the previous complete version (or nothing). No cross-service transaction spans D1 + Workflows; the guarantee is staged activation (pointer moves only on full reconcile success) plus interruption/race tests proving it.

### 3. Owned vs loose: one flag, enforced in code

Upstream marks ownership with a nullable install id (`solution_id NULL` = loose,
non-NULL = owned by exactly one install): live mutation of owned rows is
blocked (409 plus a persistence-layer backstop), redeploy upserts owned rows in
place and deletes absentees scoped to the install (`solution_id == sid AND id
NOT IN bundle`), installed entities get deterministic stable IDs, and file
payloads are never deleted. Wrangnarök copies this shape with D1 means:

- **Managed:** `connections` config columns + `bundle_installs` ledger carry `managed_by = <bundle_id>@<version>`. Ordinary application/API write paths MUST reject writes to managed rows (`MANAGED_RESOURCE` error); only the installer writes them.
- **Loose:** `executions`, `operations`, `usage_blocks`, and any row with `managed_by IS NULL`. The app owns these freely.
- Live mutation of a managed row outside install is rejected at the repository layer (centralize Connection writes through one function that checks the flag), demonstrated by test — not by policy prose.
- Redeploy deletes managed absentees scoped to the bundle install (entities in D1 but no longer in the manifest), except payload-like rows, which are never deleted (applies to future Artifacts; nothing qualifies in v1).
- Installed entity identity is deterministic (`uuid5`-style over install + manifest identity) so reinstall converges instead of forking duplicates.

### 4. Activation and rollback are install operations

**Corrected upstream attribution:** at `3543c7e`, Solution deploy reconciles and compiles before the caller's database commit, then retries post-commit source/dist writes. Exhaustion raises `SolutionFinalizeIncomplete`; a later deploy/sync can heal (`api/src/services/solutions/deploy.py:301-325,427-433,456-511`). Independent V2 App deployment has a separate `Application.active_deployment_id` and deletes superseded compiled artifacts (`api/src/jobs/platform/application_deploy.py:103-149`). These are distinct lifecycles. The inspected Solution paths do not establish the previously asserted immutable-deployment/CAS/`conflicted`/`recovery_required` protocol.

The following remain **Wrangnarök's local target guarantees**, not claims of current upstream implementation or of completeness in our v1 installer:

- Upgrade = install a newer bundle version (reconcile, bump `bundle_installs.version`). Rollback = install the previous manifest (same code path, downgrades managed rows to recorded values). No separate rollback machinery in v1.
- Each install writes an immutable install record (bundle id/version, manifest hash, resolved IDs); the install pointer moves only on full reconcile success, and a lost race surfaces `conflicted`, never silent overwrite. Downgrades are refused unless forced.
- Saga *behavior* versions travel with code deploys (Worker bundle), not manifests: the manifest pins expected `revision` strings and install **fails closed** (`REVISION_MISMATCH`) when code and manifest disagree, so a deploy can never silently serve undeclared behavior.
- Execution fail-closes with no active install for the referenced bundle, with one exception: local/loose development (no install present) keeps working, mirroring upstream's legacy-repo exception. The boundary is explicit, not a silent fallback.

### 5. Install preflight fails closed before any write

Upstream gates deploy on preflight (missing modules, downgrade, pending-capture blockers, locks, scope). Wrangnarök's install preflight, all checked before the first write:

- manifest resolves against the static code catalog (every saga/integration ID exists);
- pinned revisions match deployed code, else `REVISION_MISMATCH`;
- every `secretsRequired` name exists in the Integration's secret schema and has a value available (env/Secrets Store), else fail closed — never install half-credentialed;
- no ownership conflicts (a managed row owned by a *different* bundle id aborts with `INSTALL_CONFLICT`; hijack by re-install is refused);
- downgrade without explicit force is refused.

### 6. v1 implementation slice (what #35 ships)

- Manifest parser/validator (hand-rolled, no new deps — mirrors the saga-catalog validation style) + one checked-in example bundle (echo saga + echo fixture Integration, `default` org only).
- `installBundle` + local runner (`npm run install:local`, D1-local, fixture secrets from env) + `--dry-run` drift report. SOL-01 extends the slice with staged activation, absentee deletion, config/saga-pin persistence, same-version fencing, immutable evidence, and the fail-closed execution gate (all proven in `test/solutions-activation.test.ts` against real local D1).
- `managed_by` column migration (additive, nullable → all existing rows loose by default, zero behavior change on upgrade), plus the additive activation schema (migration 0005: pointer, config, saga pins, `config_json`, ledger immutability triggers).
- workerd tests: fresh-org install from manifest; re-run no-op; managed-row live mutation rejected; rollback = reinstall v1 after v2 with managed values restored; secretsRequired-without-value fails closed.
- Explicitly deferred: cross-org shared fallback, export/import packaging, UI, per-Operation `required` wiring (see ADR 010 — the manifest's saga list and the `required` declaration must agree; the implementation lane resolves which is authoritative on conflict).

## Consequences

- Remote state gains a source of truth before production exists; the standing rule becomes enforceable by code instead of discipline.
- Dev flow is unchanged (seed scripts keep working locally); install is additive, first exercised against dev.
- Adds manifest/installer complexity — earned by the production gate, not before; v1 is deliberately install-only, no packaging format beyond versioned JSON.

## Alternatives considered

- **Keep seed scripts forever:** rejected — seeds are write-once with no drift detection, no ownership, and no rollback story. They stay for local fixtures only.
- **Full upstream parity (loose entities, solution-owned apps/forms/agents, cross-org fallback):** rejected for v1 — no Forms/agents/Tables exist yet to own; fallback semantics need the Phase 3 auth model first.
- **Two-phase/atomic activation across D1 + Workflows:** rejected — D1 has no cross-service transactions with Workflows; idempotent per-row reconciliation gives restart-safety without pretending atomicity.
