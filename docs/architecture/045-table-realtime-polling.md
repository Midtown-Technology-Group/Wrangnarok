# ADR 045: Table realtime stays on bounded revision polling (TABLE-02)

- **Status:** Accepted (lane decision, issue #154; no new primitive, no steward exception needed)
- **Date:** 2026-09-21
- **Decides:** Issue #154 retained realtime subcase (authorized table-change subscriptions)
- **Related:** `src/tables.ts` (L70-73 interim-polling note), TABLE-02 parity row
  (`docs/upstream-parity.md`), TRG-03 (`docs/upstream-parity.md`, issue #139),
  AUTH-02 / ADR 038 (resource roles, claims, `resolveCurrentAuthority`),
  OBS-02 (polling-only, issue #153), LIMITS-01 (`docs/feasibility-envelope.md`,
  issue #177), upstream PR #760 (`f1ed2e99`, per-subscription claim re-resolution)

## Context

Issue #154 retains one open subcase after the query/count/batch slice landed
(#205): authorized table-change subscriptions with visibility enter/leave
transitions, immediate revocation, reconnect reconciliation, and
never-broadcast-hidden rows — plus the upstream #760 tightening that
realtime policy checks must resolve custom claims per subscription/evaluation,
never from a snapshot taken at socket/session creation.

`src/tables.ts` L70-73 says polling via repeated authorized queries is the
interim path and any push design needs its own ADR. This is that ADR.

## Decision: stay on poll

Table realtime is **bounded revision polling over D1**, no push transport:

- New read surface: `GET /api/tables/:name/changes?since=<ISO>&limit=` for
  initial subscribe, `?sync_token=<opaque>&limit=` for continuation. One
  bounded scan per poll over `(table_id, updated_at, doc_id)` keyset order,
  page plus one lookahead row, opaque token fail-closed (`RESYNC_REQUIRED`)
  on garbage. Reconnect reconciles against D1 as the single source of truth;
  there is no server-side subscription record to go stale.
- **Token/table binding:** the marker carries a format version plus the
  immutable `table.id`. A token from another table — or from a deleted and
  recreated instance under the same name — fails closed instead of silently
  filtering the wrong row set. `since` subscribes stay unbound (a bare
  instant is never a cross-table position; the route already loaded the
  table).
- **Monotonic write stamps:** row writes stamp `max(now, max(updated_at)+1ms)`
  per table (one revision SELECT per write request), so same-millisecond
  bursts still sort in commit order and no post-cursor write can fall behind
  an issued cursor. Residual: concurrent same-ms writers can still tie; that
  miss reconciles via re-list, same as deletes.
- **Per-evaluation claim freshness (fail closed):** every poll re-resolves
  the full authorization stack from current D1 state — org-role ceiling
  (`isViewer`), then table grants (`canAct`) — and denies on whatever is
  stale or missing at evaluation time. No principal, claim, or grant snapshot
  survives across polls, because there is nothing held across polls. This is
  the local equivalent of upstream #760's empty-claim-cache copy: the
  "cache" does not exist.
- **Immediate revocation:** a revoked grant (or a flipped viewer ceiling)
  denies the very next poll — read denials answer 404 like a missing table,
  never an empty feed that leaks existence.
- **Never-broadcast-hidden:** the policy check runs before any row is
  touched; a poll response contains only rows of the named table in the
  caller's own Organization. Cross-Organization names resolve to null and
  answer 404.
- **Enter/leave transitions:** table-level visibility is the transition
  granularity (row visibility follows table visibility in this slice). A
  fresh grant makes the next poll return current state as upserts (enter);
  a revocation makes the next poll 404 (leave). Clients detect deleted rows
  by reconciling poll output against an authoritative re-list
  (`GET rows`), not by a delete event.

## Rejected alternatives

- **WebSocket (Worker + long-lived socket):** needs Durable Objects for
  fan-out state to survive, adds a second authoritative delivery path (the
  steward stop condition), and recreates exactly the long-lived-principal
  claim-snapshot hazard upstream #760 had to fix. Rejected.
- **Durable Object per table/subscriber set:** a new platform primitive for
  a notification optimization, with per-Object storage and duration metering
  that LIMITS-01 has not classified. Unearned; rejected.
- **Queue producer/consumer:** Queues deliver at-least-once async dispatch,
  not live reads; still needs a read-side rendezvous (poll or socket) and a
  second event wiring beside TRG-03. Rejected.
- **Tombstone/delete-event log:** unbounded growth against the 500 MB Free
  per-database gate for information a re-list already provides. Rejected;
  deletes reconcile via re-list (documented on the route).

## D1 as source of truth, TRG-03 ownership

D1 `table_rows` (with existing `updated_at`) is the only change record.
Table polls **do not write to the TRG-03 event log** and TRG-03 owns that
log exclusively: no duplicate event wiring, no post-commit table-change
emissions in this slice (the parity-row "no event wiring" posture stands).
If platform-level table notifications are ever needed, they go through
TRG-03 as the single event path, not a parallel table feed.

## 500 MB Free retention/partitioning posture

Unchanged from the TABLE-02 parity row: retention is org-owned explicit
deletion (`deleteTable` drops rows and grants; no TTL, no partitioning, no
sweeper). The 500 MB Free per-database cap (10 GB Paid) stays a recorded
blocker for large Tables, shared with OPS-03. This slice adds no stored
bytes per poll (no subscription rows, no tombstones, no new migration), so
it does not move the retention gate.

## Free-tier query budget (no stop-condition break)

One poll costs at most 4 queries against the 50-query Free invocation cap:
1 declaration load, up to 2 policy checks (`isViewer` + grant row), 1
bounded scan of at most `limit + 1` rows (`limit` 1–50, no `QUERY_ROW_CAP`
scan needed — the page window is the scan). No `batch()` statements, no
bind-list pressure (3 binds). The full-size batch budget moves 29 to 30
queries (the revision SELECT above) with 20 of margin; the 25 doc_ids pin,
the 25-doc batch pin, and the 50-query Free cap are otherwise untouched.

## Consequences

- `src/tables.ts`: `pollRowChanges` + `parseChangesQuery` + opaque sync
  tokens; header realtime note points here instead of deferring.
- `src/index.ts`: `GET /api/tables/:name/changes` (table-level path, so no
  document-ID shadowing under `/rows/`).
- Tests pin revocation immediacy, reconnect continuity (token walk, no gaps
  or dupes; garbage token fails closed), hidden-never-broadcast (404
  posture), and claim freshness (grant revoke/re-grant and viewer-ceiling
  flips take effect on the next poll).
- `docs/upstream-parity.md` TABLE-02 records bounded-poll as the landed
  realtime posture with the push alternatives rejected above.
- The single-diagram steward posture holds: one delivery path (Worker +
  Workflows + D1, polling reads), one event log owner (TRG-03).
