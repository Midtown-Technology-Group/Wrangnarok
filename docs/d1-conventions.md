# D1 query cost conventions (living doc, issue #302)

D1 bills by rows read, rows written, and storage. Query shape is a cost
question, not just a latency question.

## Observe first

- Wrap D1 terminal calls (`all`/`run`/`batch`) with `observeD1` from
  `src/d1-observe.ts`, giving a stable operation name (`"<area>.<action>"`,
  e.g. `usage.persist`).
- Every wrapped call emits one `WRANGNAROK_D1` JSON log line with
  rows read/written/returned and duration. Operation names only — never
  SQL text, bound values, or payload bodies.
- Migration is opt-in, one call site at a time, hottest paths first.

## Write predictable queries

- Prefer indexed `WHERE` predicates over full-table scans; check
  `rowsRead` vs `rowsReturned` on the observation line — a wide gap means
  the index is missing or unused.
- Use `batch()` for independent statements that can share a round trip.
- Chunk large backfills/migrations (bounded batches, tuned by measurement).
- Avoid `ORDER BY RANDOM()` on large sets, leading-wildcard `LIKE` on
  large tables, and N+1 D1 calls where a join works.

## Query-plan review

- `node scripts/d1-plan.mjs [--operation <name>]` runs `EXPLAIN QUERY PLAN`
  for the registered hot-path queries against the local D1 (run
  `npm run db:migrate:local` first) and prints a coarse SCAN/SEARCH
  verdict per query. Baseline (2026-09-17): `saga-policy.load` and
  `executions.admission-count` both SEARCH.
- A `REVIEW` verdict means a human looks at the plan, not a CI failure:
  EQP output is debugging-oriented and not a stable machine API, so this
  script stays a local aid and out of CI gates.
- When adding a hot-path query, register its exact SQL plus representative
  bind values in `scripts/d1-plan.mjs` and record the confirmed expectation.
- Programmatic callers use `explainQueryPlan` / `reviewHotPaths` from
  `src/d1-plan.ts`, covered by `test/d1-plan.test.ts`.

## Hot-path review record (Slice C, 2026-09-17)

| Operation | Plan | Index |
|---|---|---|
| `saga-policy.load` | SEARCH | `saga_policies` PK `(org_id, saga_id)` |
| `executions.admission-count` | SEARCH | `executions_history (org_id, …)` |
| `children.list` | SEARCH | `executions_parent (parent_execution_id)` — restored by 0032 |
| `executions.detail` | SEARCH | `executions` PK `(id)` |
| `executions.history` | SEARCH (covering) | `executions_history (org_id, user_id, …)` |

No new indexes were needed: the one gap (`children.list`) was a missing
column, not a missing index — migration 0026 rebuilt `executions` without
`policy_json` (0012) and `parent_execution_id`/`parent_step` (0015), so
child lineage statements failed on fully migrated databases while
à-la-carte tests stayed green. Fixed by 0032; guarded by
`test/migrations-chain.test.ts`, which applies the whole chain.

## Migration rules

- Rebuilds (`CREATE TABLE … new` + copy + `RENAME TO`) must carry every
  column added by earlier migrations. The chain test enforces this.
- Keep migration files bare SQL (no `--` comments): the in-test
  `db.exec` path rejects comment-only statements.
- Large `UPDATE`/`DELETE` backfills must be chunked (see below), never one
  giant statement: D1 execution limits will abort it midway.

## Planner statistics (Slice D)

- `npm run db:migrate:local` runs `PRAGMA optimize` after applying
  migrations; `npm run db:optimize:local` reruns it alone. Planner stats
  are per-connection, so this belongs in maintenance tooling, never in
  request hot paths.
- After creating an index against preview/prod, run
  `PRAGMA optimize` there via an authenticated
  `wrangler d1 execute <DB> --remote --command "PRAGMA optimize"`.
- SQLite also benefits from a periodic re-run as data distribution shifts;
  monthly alongside dependency updates is plenty until telemetry says
  otherwise.

## Chunked backfills (Slice E)

Template for bounded batches (tune `LIMIT` by measurement; ~1k rows is the
starting point, not doctrine):

```sql
DELETE FROM <table> WHERE <predicate> AND id NOT IN (SELECT id FROM <table> WHERE <predicate> LIMIT 1000);
/* repeat until changes() = 0, or loop keyset: WHERE id > :last ORDER BY id LIMIT 1000 */
```

- Run from a script with progress output (rows affected per batch), never
  silently; stop and page a human if a batch affects 0 rows unexpectedly
  or errors twice in a row.
- Prefer keyset pagination (`WHERE id > :last ORDER BY id LIMIT n`) over
  `OFFSET` for large tables.
- Never wrap a backfill around remote API calls: saga/workflow durability
  belongs in Workflows/Queues/DOs, not in a D1 emulation.

## Finding the most expensive operations (Slice F)

- Primary source: Cloudflare's D1 dashboard / GraphQL Analytics API
  (query counts, rows read/written, latency, DB size) — use those, not a
  second billing estimator.
- Application cut: every `observeD1`-wrapped call emits a `WRANGNAROK_D1`
  line with operation + rows read/written/returned + duration. Aggregate
  with `wrangler tail` output piped through JSON scraping, grouped by
  `operation`, sorted by total `rowsRead`. When an operation's
  rows-read/rows-returned ratio climbs, run it through `d1-plan.mjs`.

## Do not

- Recreate PostgreSQL coordination (advisory locks, job claiming,
  `LISTEN/NOTIFY`, long transactions) in D1. Durability belongs in
  Workflows/Queues/Durable Objects.
- Put schema/index creation on request hot paths.
- Log bound values, secrets, or PII in telemetry (see `scrubValueWithSecrets`).
