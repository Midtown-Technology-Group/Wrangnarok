# Migration ledger (steward-owned numbering)

One sequence, no gaps, no collisions. The steward assigns every number.
Lanes never invent filenames: request the next number before writing DDL.
Wrangler applies `migrations/*.sql` in filename order, so a collision means
ambiguous schema. Tests import migrations by explicit filename, so a rename
must update every importing test in the same commit.

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
| 0012   | 0012_saga_policies.sql          | RUN-01  | per-Saga runtime policy rows + executions.policy_json snapshot (issue #135) |

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

| Number | Lane    | Issue | Planned content              |
| ------ | ------- | ----- | ---------------------------- |
| 0011   | CON-01  | #146  | connection admin             |
| 0012   | RUN-01  | #135  | saga runtime policies        |
| 0013   | AUTH-02 | #143  | resource roles               |
| 0015   | RUN-02  | #136  | child invocation lineage     |
| 0016   | TRG-01  | #137  | schedules                    |
| 0017   | SOL-03  | #163  | solution export (if DDL needed) |
| 0018   | OPS-01  | #172  | ops audit                    |
| 0019   | FILE-01 | #157  | managed files                |
| 0020   | FILE-02 | #158  | artifacts                    |
| 0022   | APP-02  | #160  | app runtime                  |

Rule: a lane renames its migration file to the reserved number, updates its
test imports, and runs the full gate before opening its PR. The ledger is
updated in the same PR that lands the migration.
