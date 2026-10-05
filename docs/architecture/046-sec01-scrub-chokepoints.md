# ADR 046: SEC-01 scrub choke points and reference-vs-value discipline

- **Status:** Accepted (lane decision, issue #576; SEC-01 owner lane)
- **Date:** 2026-09-21
- **Decides:** SEC-01 registration boundary, reference-vs-value discipline, scrub choke point(s) on every output surface
- **Related:** ADR 005 (secret storage plus the execution-scoped-registry gating deliverable), ADR 045 (bounded-poll table realtime), `src/secrets.ts` (registry mechanism, issue #145), OBS-02 log streaming, CON-01/CON-02, FILE-01/02, AI/TOOL lanes
- **Upstream:** `api/src/core/secret_string.py`, `api/bifrost/_execution_context.py`, `api/src/services/execution/engine.py` (transferable lesson: dynamic registry plus deep substring scrub; Fernet itself is not adopted)

## Context

ADR 005 demands the gating deliverable — an execution-scoped secret registry with universal substring scrubbing — before secret-bearing lanes can claim parity. The registry mechanism exists (`src/secrets.ts`, proven by `test/secret-scrub.test.ts` plus live Workflow/D1 evidence in `test/secret-scrub-live.test.ts`, issue #145). What was missing is the lane-level boundary decision: exactly where secrets may materialize, where references stand in for values, and which choke point owns every output surface — including the newest one, the TABLE-02 bounded-poll changes feed (ADR 045), whose row payloads must never carry secrets. This ADR is that decision, written before the remaining implementation per the architecture-changes rule.

## Decision

### 1. Registration boundary

Secret plaintext may materialize only at these points, and every materialization registers with the execution-scoped registry for that Execution:

- Integration Action boundary: deployment credential resolution (`ninjaone`, `ad`, `cloudflare`, `halo` integrations) and fetched OAuth/MCP tokens (`oauth-tokens.ts`, `mcp-tokens.ts`).
- Transient secret-reference resolution: `ctx.config` secret refs and decrypted envelope values (`config.ts`, `envelope.ts` consumers) at the call boundary only.
- Saga shared helpers that forward materialized values inside `step.do()` (`sagas/shared.ts`).

The registry is keyed by Execution ID and cleared when the Execution settles, so one Execution's secrets never leak into another in a reused isolate. No other module holds plaintext; decrypted material is never assigned to a wider scope.

### 2. Reference-vs-value discipline

Portable Saga/Integration source, D1 rows, discovery views, and exports carry secret **names and references only, never values**:

- `IntegrationDefinition.secretFields` / `secretsRequired` declare names; management views carry names plus the `[SECRET]` mask (`connections.ts`, `config.ts`).
- Secret references (`{ ref }`-style, declared deployment-secret names) resolve transiently at the call boundary and register per section 1.
- The only persisted secret bytes are envelope ciphertext under the ADR 005 firing amendment (`connection_secrets`: ciphertext/nonce/wrapped_dek, never plaintext).

### 3. Scrub choke points (every output surface)

Two scrub sources, one per isolate — no surface answers to both, no surface answers to neither:

| Surface | Choke point | Secrets source |
| --- | --- | --- |
| D1 Execution input/history/result/error, Operation payloads, Workflow terminal results | Write time in the Workflow isolate (`saga-helpers.ts`, `sync.ts`, saga adapters) | Execution registry |
| Author logs before persistence | `appendAuthorLog` (`logs.ts`) | Execution registry |
| Usage console lines + `usage_blocks` rows | `logUsage` / `persistUsage` call sites | Execution secrets passed explicitly |
| HTTP fault envelope, Execution detail/history, log tail/search, audit detail, code-mode results, AI verify/discovery | Route egress in the Worker isolate (`src/index.ts`) | `deploymentSecretsFromEnv(env)` |
| Connection/config management views | By construction (names only) plus route egress scrub | `deploymentSecretsFromEnv(env)` |
| Table row payloads: `GET rows`, single-row read/write echoes, batch write echoes, `GET changes` feed | Route egress in the Worker isolate | `deploymentSecretsFromEnv(env)`; D1 row bytes unchanged |

Table rows are author data, so unlike Execution outputs they are scrubbed at **read-time egress only**: D1 keeps the author bytes (source of truth, ADR 045 unchanged) while no HTTP response renders a deployment-secret substring. `pollRowChanges` itself is untouched — same scan, same tokens, same cursor semantics.

### 4. Explicitly outside substring scrubbing

- Opaque author file/artifact bytes (FILE-01/02): substring replacement would corrupt downloads. Protection there is authorization plus signed location references; file metadata carries no credential material by construction. Evaluated in this lane, no change.
- Short secrets (below `MIN_SCRUB_SECRET_LENGTH`): protected by shaping (never persisted, fixed error envelopes), not replacement — replacing 2-character strings would redact the database.
- Encodings: raw UTF-8 substrings only; base64/URL-encoded copies are out of scope and documented as such in `src/secrets.ts`.

## Rejected alternatives

- **Write-time scrub of table rows:** destroys author data on a false-positive-prone match; read-time egress preserves D1 truth while keeping every render clean. Rejected.
- **One global `json()` wrapper:** indiscriminate and hard to audit; per-route egress wraps stay greppable and match the existing choke-point pattern. Rejected.
- **A second registry or secret path:** the steward stop condition. This lane adds no store, no binding, no transport — the single path (deployment secrets plus execution registry plus universal scrub) stands. No consolidation issue needed.

## Free-tier and primitives

No new Cloudflare primitive, no migration, no stored bytes per request. Scrub cost is linear substring replacement over response payloads already being serialized — Free-tier neutral, no LIMITS-01 exception needed.

## Steward checkpoint (one-diagram test)

Still one authoritative secrets path: deployment secrets plus the execution-scoped registry plus universal substring scrubbing, tripwire amendment in force for envelope ciphertext. No second path appears; fan-out continues.

## Tests

`test/table-changes-secrets.test.ts` (this lane): plant the deployment-secret sentinel as a row substring, then prove it never renders — `GET rows`, single-row read, batch-write echo, and both `since` and `sync_token` polls on `GET changes` redact to `[REDACTED]` — while D1 still holds the author bytes and non-carrying rows pass through byte-identical (realtime behavior unchanged).
