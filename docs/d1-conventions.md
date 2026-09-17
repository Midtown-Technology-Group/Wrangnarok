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

## Do not

- Recreate PostgreSQL coordination (advisory locks, job claiming,
  `LISTEN/NOTIFY`, long transactions) in D1. Durability belongs in
  Workflows/Queues/Durable Objects.
- Put schema/index creation on request hot paths.
- Log bound values, secrets, or PII in telemetry (see `scrubValueWithSecrets`).
