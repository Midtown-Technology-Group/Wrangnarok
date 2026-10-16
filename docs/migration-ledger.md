# Migration ledger (steward-owned numbering)

One sequence, no gaps, no collisions. The steward assigns every number.
Lanes never invent filenames: request the next number before writing DDL.
Wrangler applies `migrations/*.sql` in filename order, so a collision means
ambiguous schema. Tests import migrations by explicit filename, so a rename
must update every importing test in the same commit.

Reservation workflow (enforced by `scripts/check-migration-numbers.mjs`):
1. Lane requests a number from the steward before writing any DDL.
2. Steward lands a `Reserved` row for that lane/issue on main.
3. Lane writes `migrations/NNNN_*.sql` using only the reserved number.
4. The same PR moves the `Reserved` row to `Landed` (number+filename match).
5. CI fails closed on unreserved, mismatched-owner, or ledger-drift numbers.

## Landed on main

| Number | File                            | Owner   | Content                              |
| ------ | ------------------------------- | ------- | ------------------------------------ |
| 0001   | 0001_initial.sql                | core    | base schema                          |
| 0002   | 0002_cancelling.sql             | core    | execution cancellation               |
| 0003   | 0003_usage_blocks.sql           | core    | usage blocks                         |
| 0004   | 0004_solutions_install.sql      | SOL-01  | bundle_installs ledger               |
| 0005   | 0005_forms.sql                  | FORM-01 | forms table                          |
| 0006   | 0006_apps.sql                   | APP-01  | apps table                           |
| 0007   | 0007_org_membership.sql         | AUTH-01 | organizations, membership            |
| 0008   | 0008_executions_org_fk.sql      | AUTH-01 | executions org foreign key           |
| 0009   | 0009_tables.sql                 | TABLE-02| managed tables                       |
| 0014   | 0014_execution_logs.sql         | OBS-02  | execution logs (renumbered from colliding 0009 on 2026-09-11; was 0009_execution_logs.sql from #200) |
| 0010   | 0010_solutions_activation.sql   | SOL-01  | bundle_active pointer, managed rows, immutability triggers (renumbered from colliding 0005 on 2026-09-11) |
| 0021   | 0021_endpoints.sql              | TRG-02  | webhook endpoints (renumbered from colliding 0009 on 2026-09-11; was 0009_endpoints.sql from #210) |
| 0019   | 0019_files.sql                  | FILE-01 | managed file locations, policies, capabilities (renumbered from colliding 0007 on 2026-09-11; was 0007_files.sql from #203) |
| 0023   | 0023_config.sql                 | CON-02  | scoped config + secret references (issue #147) |
| 0024   | 0024_tool_enrollments.sql       | TOOL-01 | opt-in Saga tool enrollments (issue #170) |
| 0011   | 0011_connection_admin.sql         | CON-01  | connection admin (issue #146)        |
| 0012   | 0012_saga_policies.sql          | RUN-01  | per-Saga runtime policy rows + executions.policy_json snapshot (issue #135) |
| 0013   | 0013_resource_roles.sql         | AUTH-02 | resource roles (issue #143)          |
| 0015   | 0015_child_lineage.sql          | RUN-02  | child invocation lineage (issue #136) |
| 0016   | 0016_schedules.sql              | TRG-01  | schedules (issue #137)               |
| 0018   | 0018_ops.sql                    | OPS-01  | ops audit (issue #172)               |
| 0020   | 0020_artifacts.sql              | FILE-02 | artifacts (issue #158)               |
| 0022   | 0022_app_runtime.sql            | APP-02  | app runtime (issue #160)             |
| 0025   | 0025_audit_retention.sql        | OPS-01  | audit_events without org FK (issue #350) |
| 0026   | 0026_cancelling_repair.sql      | codex-migration-replay | cancelling FK repair: child-preserving executions rebuild (issue #381) |
| 0027   | 0027_rename_replay_repair.sql   | codex-migration-replay | rename-replay convergence, IF NOT EXISTS (issues #367-371) |
| 0028   | 0028_ai_profiles.sql            | AI-01  | model profiles, assignments, embedding config, behavior rows (issue #164) |
| 0029   | 0029_connection_secrets.sql       | SEC-02 #411 | per-Organization envelope ciphertext (ciphertext/nonce/wrapped_dek/key_version/algorithm), FK-cascaded off connections |
| 0030   | 0030_events.sql                 | TRG-03  | event-source registry + org-scoped event log (issue #139, S1) |
| 0031   | 0031_oauth_tokens.sql           | OAUTH-01 #149 | per-Connection encrypted OAuth tokens + health (envelope columns, monotonic generation, FK-cascaded off connections) |
| 0032   | 0032_executions_column_restore.sql | #302 | restore execution policy and child-lineage columns after rebuild |
| 0033   | 0033_event_subscriptions.sql      | TRG-03  | org-scoped event subscriptions + per-subscription delivery receipts (issue #139, S2) |
| 0034   | 0034_branding_profile.sql         | UX-01   | org_branding + user_profiles: branding metadata, profile/theme, logo/avatar metadata with R2 bytes (issue #176, slice 1) |
| 0035   | 0035_embeds.sql                   | EMBED-01 | form_embeds: signed form-embed grants (secret digest, exact-match origins, capability fingerprint, enable/expiry) (issue #156, slice 1) |
| 0036   | 0036_anon_app_embeds.sql          | EMBED-01 | app_embeds: signed app-embed grants (secret digest, exact-match origins, deployment fingerprint, enable/expiry) + form_publications: anonymous publication (honeypot field, capability fingerprint, enable) (issue #156, slice 2) |
| 0037   | 0037_executions_org_fk_drop.sql   | #493     | drop reintroduced executions org FK (issue #493): 0008-pattern rebuild without REFERENCES organizations(id), carrying policy_json + parent_execution_id/parent_step |
| 0038   | 0038_capability_resolution.sql      | #262     | capability assignments + external entity mappings (issue #262, PR #515; grandfathered per #528, no renumber) |
| 0039   | 0039_org_roles.sql                  | AUTH-02  | narrow org-role profile, member rows migrate to operator (issue #143; grandfathered per #528, no renumber) |
| 0040   | 0040_session_uploads.sql            | EMBED-01 | form_session_uploads: session-owned upload claims (session hash, org, location, path, field, size/type bounds) for external form sessions (issue #156, slice 3) |
| 0041   | 0041_mcp_external.sql               | TOOL-02  | external MCP servers, org tools, per-user consent, secret envelopes (issue #171, PR #534; grandfathered per #528, no renumber) |
| 0042   | 0042_table_row_revision_index.sql   | TABLE-02 | composite revision index for bounded writes and change polling (security findings 121/122) |

## Stuck-database recovery (codex findings #381, #367-371)

Wrangler records applied migrations by filename in `d1_migrations` and sends
each pending file plus its journal INSERT as one atomic batch: a file whose
DDL fails is never recorded, and later files never run. Two stuck states and
their recoveries:

- #381 (cancelling FK): databases that attempted migration 0002 with operation
  history failed inside the 0002 batch, stranding `executions_new` next to the
  old `executions` table. Recovery needs no journal edit: applying 0026 drops
  the stranded table, reruns the same rebuild while briefly removing and
  restoring the `operations` child (rows preserved), and converges healthy,
  pre-0002, fresh, and rerun states.
- #367-370 (additive renamed files): databases that applied an old filename
  (`0010_ops`, `0007_files`, `0010_artifacts`, or `0009_endpoints`) treat the
  new filename (`0018`, `0019`, `0020`, or `0021`) as pending. Those four
  migrations now use `CREATE ... IF NOT EXISTS`; applying them preserves the
  existing objects and rows, records the new names, and lets later migrations
  continue. Migration 0027 remains a defense-in-depth repair for a genuinely
  missing renamed object.
- #371 (Solution activation rename): a database whose journal contains
  `0005_solutions_activation.sql` already has `connections.config_json`, so
  replaying the pending `0010_solutions_activation.sql` would fail at its
  `ALTER TABLE ... ADD COLUMN`. Do not rebuild `connections`: later migrations
  add columns and tenant-scoped foreign-key children that a historical-table
  rebuild could discard. Before applying migrations, reconcile only this
  proven old-name state with:

  ```sql
  INSERT INTO d1_migrations(name)
  SELECT '0010_solutions_activation.sql'
  WHERE EXISTS (
    SELECT 1 FROM d1_migrations
    WHERE name = '0005_solutions_activation.sql'
  )
  AND NOT EXISTS (
    SELECT 1 FROM d1_migrations
    WHERE name = '0010_solutions_activation.sql'
  );
  ```

  Then run `wrangler d1 migrations apply`. If the old name is absent, do not
  insert the alias: the new migration must run to add `config_json`.

Correction to the 2026-09-11 collision notes above: renamed files are never
recognized as already applied. The four additive carriers now converge on
replay; the activation carrier requires the conditional journal alias above.

## Resolved collisions

- 0007_org_membership.sql vs 0007_files.sql: resolved 2026-09-11 by
  renumbering the files file to the reserved 0019_files.sql plus its test
  imports. Both files are additive CREATE TABLE statements, so
  already-applied local/dev databases converge on re-application.
- 0009_tables.sql vs 0009_endpoints.sql: resolved 2026-09-11 by renumbering
  the endpoints file to 0021_endpoints.sql plus its two test imports. Both
  files are additive CREATE TABLE IF NOT EXISTS, so already-applied local/dev
  databases converge on re-application.
- 0009_tables.sql vs 0009_execution_logs.sql: resolved 2026-09-11 by
  renumbering the logs file to the reserved 0014_execution_logs.sql plus its
  test import. Additive CREATE TABLE plus CREATE INDEX statements, so
  already-applied local/dev databases converge on re-application.

## Reserved (assigned, not yet merged — do not reuse)

| Number | Lane                           | Issue                | Planned content                       |
| ------ | ------------------------------ | -------------------- | ------------------------------------- |
| 0017   | SOL-03                         | #163                 | solution export (if DDL needed)       |
| 0043   | codex-execution-restore-repair | security finding 635 | renamed execution restore convergence |

Rule: a lane renames its migration file to the reserved number, updates its
test imports, and runs the full gate before opening its PR. The ledger is
updated in the same PR that lands the migration.

## Overrides (break-glass, steward-authorized only)

An urgent repair migration may land without a prior `Reserved` row only after
the steward lands its authorization row in this table on `main` in a separate
PR. The consuming PR must retain that row byte-for-byte, cite its exact Issue in
the matching `Landed` row, and include both trailers below in one branch commit:

```text
Migration-Override: NNNN
Migration-Override-Reason: exact reason from the trusted row
```

The authorization row remains after consumption as an audit record. A row
introduced or edited by the consuming PR, arbitrary sign-off text, PR-body
prose, and "next free" prose are not authorization. No override rows currently
exist.

| Number | Issue | Reason | Steward sign-off |
| ------ | ----- | ------ | ---------------- |
