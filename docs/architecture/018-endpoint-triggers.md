# ADR 018: Endpoint and webhook Triggers

**Status:** Accepted for issue #138 (TRG-02). Implements the webhook half of
the ADR 012 investigation; schedule Triggers stay deferred to TRG-01.

## Context

Upstream `gobifrost/bifrost@3543c7e` exposes two HTTP Trigger surfaces:

- `api/src/routers/endpoints.py`: `POST /api/endpoints/{workflow_id}` with a
  per-workflow `X-Bifrost-Key` API key (hashed, expirable, revocable via
  `workflow_keys.py`). The workflow's persisted sync/async mode decides
  between an inline result (sync) and an immediate queued receipt (async).
- `api/src/routers/hooks.py` plus
  `api/src/services/webhooks/adapters/generic.py`: a public
  `/api/hooks/{source_id}` receiver keyed by an unguessable UUID path, with
  optional HMAC-SHA256 body signatures, per-source rate limiting before any
  DB write, vendor challenge handshakes answered via ValidationResponse, and
  accepted payloads delivered as queued events (never inline).

Wrangnarok has no equivalent: only the internal `POST /api/executions`
submit API exists, which requires the operator session. Upstream finding 3
(runtime policy is environment state, never Saga source metadata) and the
lexicon (Trigger as an event capable of starting a Saga) both point the same
way: Endpoints are persisted per-Organization rows binding a name to a
stable Saga UUID, plus a credential and policy.

## Decision

One `endpoints` table (migration 0021) holds both kinds:

- `api-key` endpoints deliver at `POST /api/endpoints/:name` with the
  per-endpoint key in `X-Endpoint-Key` (or Bearer). Raw keys are shown once
  at create/rotate; D1 keeps the SHA-256 digest, compared in constant time.
  Keys carry optional expiry; disable revokes.
- `webhook` endpoints deliver at `POST /hooks/:name` with an HMAC-SHA256
  body signature in `X-Webhook-Signature` (`sha256=` prefix accepted). The
  raw secret lives in the deployment secret store (`ENDPOINT_WEBHOOK_SECRETS`
  binding, a JSON object of endpoint ID to secret, per ADR 005 v0); D1 keeps
  only the SHA-256 confirmation digest. Webhook endpoints may enable the
  `echo-param` vendor challenge (`?challenge=<token>` answers 200 plaintext,
  never an Execution, with no D1 write and no signature requirement).

Both kinds share the delivery protocol:

1. Name resolution is global by name (names are not secret); the credential
   disambiguates across Organizations. Unknown names answer 404.
2. Bodies are bounded (shared 4096-byte gate) and read exactly once; the
   webhook path signs the raw bytes.
3. Every delivery needs a vendor event ID (header or payload field).
   Redelivery of the same event derives the same `wep-` submit key, so the
   standard submit protocol converges: same input replays
   (`200 replayed:true`), different input answers `409
   IDEMPOTENCY_CONFLICT`. Caller `Idempotency-Key` headers are not accepted
   on these routes, and caller keys starting with `wep-` are rejected at
   parseKey so no caller can squat the endpoint namespace.
4. The vendor payload maps to the Saga input through the Saga parse gate;
   caller-supplied org/user identity fields are rejected loudly
   (`ENDPOINT_IDENTITY_FORBIDDEN`). Organization and run-as always come from
   the endpoint row.
5. The synchronous HTTP response stays distinct from the asynchronous
   Execution receipt: 202 plus `statusUrl` (never inline results), matching
   upstream async mode. Bounded sync mode belongs to RUN-03, not this ADR.
6. Per-endpoint minute-bucket rate limiting in D1 runs before any Execution
   write; over-limit answers 429. The counter is advisory under concurrency;
   Execution idempotency owns correctness.
7. `endpoint_events` records first-seen (endpoint, event) deliveries for
   replay visibility; mismatched redelivery is detected against it.

Operator management rides the authenticated session: create (credential
shown once), list/get summaries (never digests or secrets), PATCH policy
(enabled, rate limit, expiry), rotate, and delivery history.

## Consequences

- No new Cloudflare primitive: Worker fetch plus the existing submit path
  (ADR 012 stays right: webhooks never needed a Queue or Durable Object).
- Upstream sync-mode inline results are an explicit non-goal; Wrangnarok
  stays async-first until RUN-03.
- Per-tenant webhook secrets stay deployment-scoped (ADR 005 v0). Moving
  them into per-Organization ciphertext needs the SEC-02 tripwire first.
- Schedule Triggers (Cron plus durable Scheduled state) are untouched and
  stay with TRG-01.
