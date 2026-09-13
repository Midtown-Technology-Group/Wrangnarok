# ADR 016: Solution source capture, export, and import

- **Status:** Accepted (2026-09-11; issue #163, SOL-03)
- **Date:** 2026-09-11
- **Extends:** ADR 011 (solutions contract), ADR 002 (stable identity), ADR 003 (Integration vs Connection), ADR 005 (secret storage)
- **Upstream compatibility:** mapped against `gobifrost/bifrost@3543c7e` (`api/src/routers/solutions.py`, `api/src/services/solutions/export.py`, `api/src/services/solutions/export_jobs.py`). Inspected for product behavior only; no upstream code is vendored.

## Context

Upstream Bifrost separates a portable Solution definition (apps, workflows,
forms, integrations, config declarations, claims) from each Organization
installation (independent identity, config, credentials, runtime data).
Shareable exports exclude secrets, table rows, and runtime file bytes; a
separate encrypted export/import path covers operational data.

Wrangnarök had half of this: the v1 JSON manifest plus `installBundle`
reconciliation (ADR 011, SOL-01) and the workspace-to-manifest bridge
(`src/migration.ts`, MIG-01). It lacked source capture (what is the
shareable package?), a preview that fails closed before adoption, an
export/import round-trip, and any enforcement that tenant state cannot leak
into shared source.

## Decision

### 1. One versioned JSON document, not a zip

A shareable source package is `wrangnarok.solution-source` format 1
(`src/solution-export.ts`): source identity (stable UUID, slug, semver,
readme, inline SVG logo, requirements, informational git pointer), the v1
install manifest, per-Saga module metadata (id, name, revision,
description, requiredIntegrations), small text assets, and export metadata
(exporter, instant, upstream baseline, notes).

**Explicit divergence — packaging:** upstream ships a zip of
`bifrost.solution.yaml` plus `.bifrost/*.yaml` declarations. Wrangnarök
ships one JSON document: Workers parse JSON natively with no YAML or zip
dependency, and the 64 KB package cap keeps source sharing inside
Free-tier-shaped payloads. Same ideology (source plus declarations only,
values excluded); different container. The difference is additionally
stated inside every package (`metadata.notes`), not only here.

**No workflow DSL.** Module entries pin revisions against the static code
catalog; they never embed behavior. Sagas stay code-first TypeScript in
the Git tree the manifest points at (AGENTS.md constraint 4).

### 2. Capture is read-only and fails closed

`previewCaptureSource` / `captureSource` run SELECTs only over D1. They
verify every declared Connection against live install state and report
actionable gaps:

- `MISSING_MANAGED_ROW` (nothing installed yet — install first),
- `DRIFTED_CONNECTION` (live endpoint differs — reconcile first),
- `OWNERSHIP_MISMATCH` (managed by a different bundle — cross-org and
  cross-ownership capture is refused),
- `LOOSE_RESOURCE_NOT_ADOPTED` (a `managed_by NULL` row is reported and
  left out; adoption happens only through an explicit install, never by
  capture).

Any blocking gap throws `CAPTURE_BLOCKED` with the gaps as details.
Capture never writes managed rows and never adopts loose resources across
org or ownership boundaries.

### 3. Export and import validate the same way

`exportSourcePackage` serializes (canonical key order, 2-space JSON) into
`solution.source.json` plus the extracted `solution.manifest.json` for the
installer, enforces the byte cap, and fails closed when any caller-known
secret value appears in the bytes. `importSourcePackage` validates without
touching D1 and without installing. Both walk untrusted input first:
prototype-pollution keys, tenant-state sections (table rows, executions,
operations, artifact bytes, secrets), and credential-shaped keys are
rejected at any depth before schema validation.

The dependency closure (`checkClosure`) pins every Saga against the code
catalog with matching revisions, requires every Saga requirement to be
declared by the manifest, and checks every `secretsRequired` name against
the Integration secret schema. Unknown platform requirements fail closed.

### 4. Adoption is a separate explicit install

Import does not install. Adoption is `installBundle` with its own
preflights (catalog resolution, revision pins, secret availability,
ownership, downgrade gate). The author journey is therefore
capture → preview → share → import → explicit install, with the deploy
blockers firing at the install step, never silently at share time.

### 5. Identity mapping is shared, not duplicated

`mapSourceToInstall(bundleId, orgId, integrationId)` derives the managed
Connection id with the same `wrangnarok.connection.v1` derivation the
installer uses. The round-trip test proves the mapper predicts the exact
row id the installer writes, so reinstalls converge instead of forking.

### 6. Source export is not a backup

Portable source carries no table rows, no execution state, no artifact
bytes, and no credential values — enforced by validation, not convention.
Encrypted operational backup and restore (rows, secrets, bytes, keys) is
tracked separately under OPS-03. Source export must never be called a
complete data backup.

## Consequences

- Sharing a Solution is a validated document exchange, provable locally
  with no Cloudflare deployment (`test/solution-export.test.ts` runs in
  workerd against real local D1; `scripts/export-local.mjs` exercises the
  same implementation from plain node).
- New primitives: none. No Queue, DO, R2, or KV — source packages are
  small JSON, staged through a caller-supplied sink (`runExportJob`
  guarantees cleanup exactly-once semantics on failure).
- Deferred: app source hosting, forms/tables/agents ownership in
  packages (each stays an unchecked subcase under SOL-02, never a silent
  manifest key), UI for capture/export, encrypted operational backup
  (OPS-03).

## Alternatives considered

- **Zip of YAML like upstream:** rejected — adds YAML/zip dependencies to
  the Worker runtime for no product gain; JSON carries the same
  declarations.
- **Capture-that-installs (auto-adopt loose rows):** rejected — silent
  cross-boundary adoption is exactly the failure the owned/loose split
  exists to prevent.
- **Merging export with encrypted backup:** rejected — shareable source
  and credential-bearing backups have opposite visibility rules; one
  format cannot serve both.
