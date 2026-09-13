# ADR 012: Phase 2 Trigger investigation — schedules and webhooks

**Status:** Schedule direction accepted and implemented (TRG-01, issue #137, 2026-09-12). Webhook direction ships separately (TRG-02, ADR 018). Implements the schedule slice; constrains later topic lanes. Defers to ADR 001 (Execution identity, idempotency) and ADR 010 (OrgCtx, declared requirements) where silent.

## Context

Roadmap Phase 2 asks for "schedules/webhook Triggers" on top of the
HTTP-submit loop. The lexicon defines a Trigger as "an event capable of
starting a Saga" and names HTTP requests and schedules as examples. Upstream
finding 7 (`docs/upstream-spec.md`) adds the invariant worth keeping: events
are source-plus-subscription (schedule, webhook, topic), and a subscription
targets one workflow or agent with metadata/payload carried into execution
context. Upstream finding 3 adds the counterweight: runtime policy
(timeouts, schedules, endpoints, access) is environment state, not Saga
source trivia — so Trigger configuration must never become Saga decorator
metadata.

## Decision direction (not yet decided)

### Webhook Triggers: a thin authenticated route over submit

A webhook Trigger is an HTTP route that authenticates the caller, shapes the
vendor payload into a Saga input, and enters the existing
`POST /api/executions` protocol with a deterministic Idempotency-Key derived
from the vendor event (delivery ID, event ID). Consequences, all already
covered by current contracts:

- Vendor redelivery with the same event ID converges via same-key replay
  (`200 replayed:true`); same key plus different payload answers `409
  IDEMPOTENCY_CONFLICT` instead of forking a second Execution.
- Connection resolution stays exact-org through the OrgCtx; a declared but
  unconfigured Connection fails loud with 424 rather than silently skipping.
- No new Cloudflare primitive: Worker fetch plus the existing submit path.
  HMAC verification (where the vendor signs) is per-Integration request
  normalization inside the Action boundary, not Saga code.

Open before implementation: per-route authentication scheme (fixture Bearer
does not survive multi-tenant webhooks), the key-derivation rule from vendor
event IDs (must satisfy the 16–128 `Idempotency-Key` alphabet), and the
payload-to-input shaping bound (4096-byte input CHECK already applies).

### Schedule Triggers: Cron plus a durable Scheduled state

A schedule Trigger pairs a Cloudflare Cron Trigger (the tick) with a durable
`Scheduled` Execution row (the intent): the tick promotes due rows through
the normal dispatch protocol. `Scheduled` stays what ADR 001 says it is — a
durable pre-publish row distinct from `Pending`, promotable when due — and
is still deferred: this investigation does not introduce it. Blockers,
in order:

1. **Keyless identity.** The deterministic Execution ID hashes
   `(orgId, userId, key)`; a schedule has no client-supplied key. Server-side
   key derivation (schedule ID plus window) or the rejected UUIDv7 plus
   `UNIQUE(idempotency_key)` path from ADR 001 must be settled first —
   whichever it is, it is an identity decision with an ADR, not a Cron
   annotation on a Saga.
2. **Due-time indexing and promotion.** A due index, a promotion claim that
   cannot double-dispatch (same fencing discipline as the submit path:
   single winner, retained-ID dedup), and the `Scheduled`-cancel semantics
   ADR 001 defers.
3. **Policy placement.** Cadence, enabled/disabled, and timezone live as
   persisted per-installation policy (upstream finding 3), never as Saga
   source properties — `buildCatalog` rejects schedule-shaped keys today
   and must keep rejecting them.

### Topic events: deferred

Upstream topic emission/subscription stays deferred per the capability map.
If a concrete multi-Saga fan-out need arrives, it must demonstrate why a
direct Saga-to-Saga submit (ordinary TypeScript calling the submit protocol)
is insufficient before any Queue or Durable Object is earned — per
AGENTS.md constraint 7, the primitive needs the requirement, not the
other way around.

### Same-window deduplication is not cross-window overlap policy

**Audit correction (2026-09-11, [#132](https://github.com/MTG-Thomas/Wrangnarok/issues/132)):** the rules below suppress duplicate delivery of the same window only. Current upstream `api/src/jobs/schedulers/cron_scheduler.py:166-203` skips a new window while an earlier delivery for the same source remains active. A deterministic key for W does not prevent W+1 from overlapping W. The schedule implementation must test both cases and decide cross-window policy explicitly; this investigation still implements neither. Upstream enum alternatives do not establish working queue/parallel overlap modes.

Schedule promotion derives the submit key deterministically from
(schedule ID, window), so the existing idempotency protocol does the
overlap work with no new mechanism:

- Tick for window W arrives while W's Execution is non-terminal
  (`Pending`, `Running`, `Cancelling`): the same-key submit replays
  (`200 replayed:true`) or is refused; no second Workflow instance is
  created. The tick is a no-op that returns the live Execution identity.
- Tick for W arrives after W's Execution reached a terminal state: normal
  same-key semantics apply (replay the receipt; a cancelled receipt stays
  `409 EXECUTION_CANCELLED` and needs a fresh key).
- Two ticks racing for the same window converge like concurrent identical
  submits today: single winner via the PRIMARY KEY plus retained-ID dedup.

Rationale: vendor mutations behind Operations are not safe to run twice
for one window, and the engine-loss-only retry rule (ADR 001) already
refuses automatic re-execution — overlap-skip is the schedule-shaped
instance of the same rule. Owner-cancel-wins still holds: a tick never
resurrects a cancelled window.

### Rate-limit behavior: structured, loud, operator-driven

Vendor throttling is an expected downstream error, not an engine loss, so
it is never auto-retried:

- NinjaOne `429` on either call surfaces `NINJA_RATE_LIMITED`
  as a structured step result; the Saga fails loud (`Failed`) with no
  retry. The operator re-submits with a fresh key after the vendor window.
  (Acceptance review closed the token-call gap: a throttled token request
  carries the same code with a token-specific message.)
- The echo fixture has no rate limiting (local fixture, single caller).
- Automatic `Retry-After` honoring (sleep-until-resume inside the Saga) is
  explicitly deferred: waits driven by vendor headers are persisted retry
  policy, and per upstream finding 3 policy does not belong in Saga
  source. If a vendor's limits make an Integration unusable without
  backoff, that is the demonstrated requirement that earns the design —
  recorded here, not built here.
- Inbound webhook throttling (abuse protection on Trigger routes) is
  likewise deferred: no Cloudflare rate-limiting product is adopted until
  a webhook lane demonstrates the need (AGENTS.md constraint 7).

Test posture per `docs/testing.md` stays: every Integration mock covers
the rate-limit case (429 → structured code, exactly one outbound call —
the digest echo-503 test is the template).

## Consequences of this investigation

- No new primitive, migration, binding, or route in this slice.
- The next webhook lane implements one vendor webhook on the submit protocol
  with its own tests (auth, redelivery convergence, 424 posture) and no ADR
  unless it changes shared contracts.
- The next schedule lane writes the `Scheduled` design (identity first) and
  only then touches Cron.
- Saga source stays free of trigger-shaped metadata; the
  `OPERATIONAL_POLICY_KEYS` rejection list already covers schedule/cron
  keys and needs no change.

## TRG-01 implementation (2026-09-12, issue #137)

The schedule direction above ships as:

- Migration `0016_schedules.sql` (reserved per `docs/migration-ledger.md`):
  `schedules` rows (org-scoped name, Saga UUID, recurring/one-off kind,
  cron, timezone, enablement, input, run-as owner, due instants) plus
  `schedule_deliveries` window-to-Execution receipts.
- `src/schedules.ts`: cron/timezone/input/run-at parsers, deterministic
  `sch-` window keys, next-due math with named-timezone wall clocks,
  bounded tick promotion with overdue handling and owner-cancel-wins.
- Worker routes: `GET/POST /api/schedules`, `GET/DELETE
  /api/schedules/:name`, `POST .../enable|.../disable`, `GET
  .../deliveries?window=`; writes admin-gated, reads member-open.
- The minute Cron tick (`triggers.crons`, the only Cron trigger —
  `test/timeout-sweeper.test.ts` pins it) calls `promoteDueSchedules`.
  Earned per AGENTS.md constraint 7 by the durable due-time requirement;
  no Queue, no Durable Object, no sweeper, no reconciler.
- `Scheduled` stays a non-status by design: promotion writes Pending rows
  through the submit protocol, never a new Execution state.
- DST/missed-tick posture: matching is wall-clock in the schedule
  timezone; a missed tick promotes the window overdue on the next tick,
  never skips it silently and never fans out catch-up windows.
- SDK: `scheduled-triggers` capability, schedule types/guards/client, and
  contract routes; `SCHEDULE_CONFLICT`, `SCHEDULE_IDENTITY_FORBIDDEN`,
  `SCHEDULE_MISCONFIGURED` join the error registry.

## Open questions (options, not decisions)

- Webhook auth model past the fixture (per-Connection secrets vs.
  per-route tokens) — needs the Phase 3 secret-storage decision (ADR 005).
- Whether schedule cadence belongs to the portable bundle or the
  installation (Phase 5 will care; Phase 2 only records the question).
- ExecutionHistory querying for Trigger provenance (which Trigger started
  this Execution) — needs a source-of-trigger field once webhooks exist.
