# ADR 012: Phase 2 Trigger investigation — schedules and webhooks

**Status:** Schedule half Accepted per issue #137 (TRG-01, 2026-09-11);
webhook half remains investigation for issue #76. Implements the schedule
design below (migrations 0016/0010, `src/schedules.ts`, the `/api/schedules`
routes, the Cron tick). Defers to ADR 001 (Execution identity, idempotency)
and ADR 010 (OrgCtx, declared requirements) where silent.

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

### Schedule Triggers: Cron plus a durable Scheduled state (Accepted, #137)

A schedule Trigger pairs a Cloudflare Cron Trigger (the tick) with a durable
`Scheduled` Execution row (the intent): the tick promotes due rows through
the normal dispatch protocol. `Scheduled` is what ADR 001 says it is — a
durable pre-publish row distinct from `Pending`, promotable when due —
and this lane introduces it (migration 0016b).

1. **Keyless identity: decided.** The tick derives the submit key
   server-side as `sched:{scheduleId}:{once|recur}:{window}` (the window is
   the one-off runAt instant or the minute-aligned UTC cron instant), which
   satisfies the 16–128 `Idempotency-Key` alphabet. The deterministic
   Execution ID hashes `(orgId, userId, key)` exactly like the submit path,
   so promotion reuses the idempotency record: same-window ticks converge
   (PRIMARY KEY single winner plus retained-ID dedup), a settled window
   replays its receipt, and a cancelled window stays `409
   EXECUTION_CANCELLED` — ticks never resurrect. The rejected UUIDv7 plus
   `UNIQUE(idempotency_key)` path stays rejected: no demonstrated need.
2. **Due-time indexing and promotion: decided.** The `schedules` table
   (migration 0016) carries kind (`once`/`recurring`), status
   (`active`/`disabled`/`deleted`), `cron_expr`, `timezone`, `run_at`,
   `next_due_at`, `overlap` (`allow`/`skip`), and promotion receipts, under
   a `(status, next_due_at)` due index. The Cron tick scans at most 50 due
   schedules and admits at most 25 promotions per tick (bounded Free-tier
   cost). Promotion claims the durable intent row with a conditional
   `Scheduled -> Pending` write: the winner dispatches through `submit()`,
   losers converge on the winner's Execution — exactly once under racing
   ticks, proven by the gated-claim race test. `Scheduled`-cancel semantics:
   the schedule cancel route cancels `Scheduled` rows only; promoted rows
   (`Pending`+) belong to the owner cancel route; owner-cancel-wins holds
   (a tick never resurrects a cancelled window).
3. **Policy placement: decided.** Cadence, enabled/disabled, timezone,
   input, overlap, and run-as (the schedule's stored org/user) live as
   persisted per-installation rows, never as Saga source properties —
   `buildCatalog` keeps rejecting schedule-shaped keys. The tick re-checks
   membership per window: revoked/suspended members, disabled users/orgs,
   and unknown orgs skip loudly (no promotion, `last_skipped_window`
   stamped). Timezone is an IANA label (default UTC) carried for honest
   preview text; the tick and window math run in UTC (see DST/missed-tick
   notes below).
4. **Cron validation: decided.** Only 5-field Cloudflare shapes are
   admitted (numeric fields, `*`, `*/n`, lists, numeric ranges, JAN–DEC /
   SUN–SAT names). Seconds, years, `L`/`W`/`#`, free text, and out-of-range
   fields are refused with `INVALID_CRON` — a "valid elsewhere" expression
   the platform cannot tick would be a silent schedule.

The remaining schedule-adjacent blockers from the investigation are
discharged: `Scheduled` is introduced with its cancel semantics, the due
index plus promotion claim exist, and policy placement is enforced by the
route and catalog gates.

### Topic events: deferred

Upstream topic emission/subscription stays deferred per the capability map.
If a concrete multi-Saga fan-out need arrives, it must demonstrate why a
direct Saga-to-Saga submit (ordinary TypeScript calling the submit protocol)
is insufficient before any Queue or Durable Object is earned — per
AGENTS.md constraint 7, the primitive needs the requirement, not the
other way around.

### Same-window deduplication is not cross-window overlap policy (decided, #137)

**Audit correction (2026-09-11, [#132](https://github.com/MTG-Thomas/Wrangnarok/issues/132)):** the rules below suppress duplicate delivery of the same window only. Current upstream `api/src/jobs/schedulers/cron_scheduler.py:166-203` skips a new window while an earlier delivery for the same source remains active. A deterministic key for W does not prevent W+1 from overlapping W. The schedule implementation tests both cases and decides cross-window policy explicitly per schedule — this investigation's open question is now closed:

- **Same window (dedup):** the tick derives the submit key deterministically
  from (schedule ID, window), so the existing idempotency protocol does the
  overlap work with no new mechanism (tick details in the Accepted section
  above).
- **Cross window (overlap policy):** the operator chooses per schedule at
  creation. `overlap: "allow"` dispatches every due window — concurrent
  windows run side by side (proven: W+1 dispatches while W is still live).
  `overlap: "skip"` holds a new window while an earlier window's Execution
  is non-terminal (`Scheduled`, `Pending`, `Running`, `Cancelling`): the
  tick records the skip on the schedule row (`last_skipped_window`) and
  keeps the next window (proven: skip-then-promote after the earlier window
  settles). Default is `allow`: skipping is the exception the operator asks
  for, not the silent rule. Upstream enum alternatives do not establish
  working queue/parallel overlap modes — hence the explicit two-mode choice
  instead of an upstream-shaped enum.

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

- The schedule half adds one primitive (the Cron Trigger `* * * * *`),
  two migrations (0009 schedules, 0010 `Scheduled` plus provenance), one
  module (`src/schedules.ts`), seven routes (`POST/GET /api/schedules`,
  `GET /api/schedules/:id`, `GET /api/schedules/:id/preview`,
  `POST /api/schedules/:id/disable|enable`, `DELETE /api/schedules/:id`,
  `POST /api/schedules/executions/:id/cancel`), and the `scheduled()`
  tick handler. No other broker: Queues, Durable Objects, and new bindings
  stay unjustified until a concrete requirement demonstrates them.
- The next webhook lane implements one vendor webhook on the submit protocol
  with its own tests (auth, redelivery convergence, 424 posture) and no ADR
  unless it changes shared contracts.
- Saga source stays free of trigger-shaped metadata; the
  `OPERATIONAL_POLICY_KEYS` rejection list already covers schedule/cron
  keys and needs no change.

### DST and missed-tick behavior (operator notes, #137)

- **Ticks fire in UTC; windows are UTC instants.** The `timezone` column is
  a label for honest preview text, never a shift of the tick. A schedule
  created with `America/New_York` and cron `0 9 * * *` fires at 09:00 UTC
  daily — not 09:00 Eastern. Operators who want wall-clock cadence convert
  the cron to UTC before creating the schedule; the preview route shows the
  resulting UTC windows so the conversion is verifiable before enabling.
- **DST transitions change nothing locally:** because neither the tick nor
  the window math consults the label, a spring-forward/fall-back moves no
  window and duplicates no window. The cost is the one above (UTC, not
  wall-clock); the benefit is no 23/25-hour-day edge to test or explain.
- **Missed ticks promote late (catch-up), never invent success.** If the
  platform skips a tick (deploy, outage, backlog), the next tick's bounded
  scan still finds the overdue row (`next_due_at <= now`) and promotes it
  through the normal submit protocol — the Execution runs late with its
  original window label, and the recurring due index advances from the tick
  time. A tick that finds more than 25 due rows promotes the 25 earliest
  and leaves the rest for the next minute: backlog drains one tick at a
  time instead of stampeding dispatch. Queue backup is never mistaken for
  failure: an undispatched `Pending` row stays `Pending` with
  `dispatchConfirmed: false` on detail, exactly like the submit path.

## Open questions (options, not decisions)

- Webhook auth model past the fixture (per-Connection secrets vs.
  per-route tokens) — needs the Phase 3 secret-storage decision (ADR 005).
- Whether schedule cadence belongs to the portable bundle or the
  installation (Phase 5 will care; Phase 2 only records the question).
- ExecutionHistory querying for Trigger provenance (which Trigger started
  this Execution) — needs a source-of-trigger field once webhooks exist.
