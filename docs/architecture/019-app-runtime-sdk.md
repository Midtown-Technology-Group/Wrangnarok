# ADR 019: Browser App SDK runtime — scoped workflows, Tables, files, live updates

- **Status:** Accepted (2026-09-11; gates APP-02 per issue #160)
- **Date:** 2026-09-11
- **Extends:** ADR 002 (stable identity), ADR 011 (Solutions install contract), ADR 017 (authored apps)
- **Upstream compatibility:** shaped from upstream `gobifrost/bifrost` app-SDK machinery at baseline `3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f` (`client/src/lib/app-sdk/index.v2.ts`, `wire-surface.ts`, `provider.tsx`, `use-table.ts`, `use-files.ts`; test `sdk-contract.test.ts`). Inspected, not executed; no upstream production instance was used. Ideology preserved; divergences below are explicit and Cloudflare-driven.

## Context

Upstream Bifrost ships a browser App SDK (V2) for authored apps: a scoped
provider (bearer token, org scope, app install context), workflow
invocation/status/results, Tables (query plus realtime subscriptions), files
(signed upload/download URLs), and a wire-surface snapshot hash that trips on
drift. Wrangnarök has the private control-plane API client, which is not a
public SDK/runtime for authored apps: no scoped install context, no grant
model, no Table/file runtime, no live updates.

Four upstream invariants bound this design:

- **Scoped install context.** `useWorkflow` sends the app id so a ref resolves
  to this install's own workflow; Tables resolve to this install's own
  deployed table. Sibling installs sharing a name never leak across.
- **Deny-by-absence authorization.** Subscriptions that the server rejects
  surface as errors, never as silently dead snapshots.
- **Live updates share the snapshot shape.** `flattenDocument` normalizes the
  snapshot to the flat shape websocket events already emit.
- **Wire drift trips.** `wire-surface.ts` plus `sdk-contract.test.ts` force a
  conscious version decision on every wire change.

## Decision

### 1. Grants: additive capability rows, deny-by-absence, revoke-then-re-grant

An installed app acts only through **grant rows** (`app_grants`): one
`(app, kind, ref, permission)` tuple per capability, where kind is
`saga` (invoke), `table` (read/write), or `file` (read/write), and ref is the
stable Saga UUID, the Table slug, or the file path.

- The author (the authenticated Organization caller, same policy as ADR 017)
  creates, lists, and revokes grants through `/api/apps/:id/grants`.
- Every runtime call re-checks the live grant row (`requireAppGrant`). There
  is no cached capability: revocation takes effect on the next call, and
  discovered-but-ungranted refs fail with `APP_*_FORBIDDEN` (403).
- File capability tokens are bearer conveniences, not capabilities: redeem
  re-checks the grant, so a token outlives revocation by at most one
  already-in-flight call, and fails closed on the next.
- There is no grant update path: revoke then re-grant. Re-granting an
  identical tuple after revoke answers `APP_GRANT_CONFLICT` (409), the same
  as a duplicate create, because the unique row (now revoked) still exists.

### 2. Tables: visible-only runtime, bounded equality reads, revision polling

App Tables (`app_tables` + `app_rows`) hold JSON document rows with a
per-Table change revision that bumps once per write (insert, patch, delete).

- The author declares Tables (visible or hidden) through
  `/api/apps/:id/tables`. The runtime lists **visible Tables only**; hidden
  Tables answer `APP_TABLE_NOT_FOUND` (404) on the runtime paths, never a leak.
- Reads are filtered, bounded page reads: exact-match equality on top-level
  fields (at most 8 clauses), `limit` 1–100, opaque row-UUID cursors, and
  `sinceRevision` for bounded polling. Nested operators (ranges, contains,
  sorts, counts) fail with `APP_TABLE_QUERY_UNSUPPORTED` (422), never silently
  widen into a scan. Query keys are deny-by-default (`UNSUPPORTED_QUERY`).
- A poller holding the authoritative revision gets the
  `sinceRevision >= revision` shortcut: empty page, current revision, no row scan.
- The browser `useAppTable` hook returns **flat rows** (`{...data, id,
  tableRevision, ...}`), matching upstream's `flattenDocument` contract where
  the snapshot and live updates share one shape. The imperative client returns
  the nested wire shape; the hook flattens, never the other way around.

### 3. Files: declare, single-use tokens, finalize-after-upload

App files (`app_files`) hold small byte payloads (32 KiB cap) with optimistic
versioning; declaration alone stores no bytes (`pending` until verified).

- The runtime declares a location (write grant), mints a **single-use scoped
  token** (random, hashed at rest, one file, one scope, 15-minute expiry),
  and redeems it with content plus verification metadata. Declared
  `contentType`/`size`/`sha256` must match the bytes
  (`APP_FILE_METADATA_MISMATCH`, 422); mismatch stores nothing.
- Upload and download tokens are consumed on first redemption; expired or
  out-of-scope tokens fail closed (401). Only `ready` files download.
- Deletes are version-aware: a stale `expectedVersion` conflicts (409) rather
  than silently overwriting. The runtime file list shows **read-granted files
  only**; write-only upload targets stay unlisted.
- Tokens ride one header (`X-File-Token`) on one call: never a query string
  (no log/token-cache surface), never retried.

### 4. Invoke: grant-before-parse, canonical idempotency, scoped activity tail

`POST /api/apps/:id/runtime/invoke` authorizes the Saga ref **before**
validating input (ungranted Sagas fail 403 without leaking which known Saga
IDs would parse), then submits down the standard Execution path
(`Idempotency-Key` required; canonical 202/200+replayed replay). Each accepted
submit records a scoped linkage (`app_executions`) powering the app activity
tail; results stay on `GET /api/executions/:id` (the runtime never re-serves
foreign Execution rows). The browser `useAppInvoke` hook invokes once (caller
key) then polls to a terminal status; failed invokes surface and the caller
re-invokes explicitly.

### 5. Handshake tripwire and retry rules

- `GET /api/apps/:id/sdk` serves `{ sdk: "wrangnarok.app-runtime", version,
  app }` plus an `X-App-SDK-Version` header. The browser client asserts name
  and version before its first scoped call; drift fails loud with
  `APP_SDK_MISMATCH` instead of misreading a changed shape. This is the
  Cloudflare-native analogue of upstream's `wire-surface.ts` snapshot hash:
  versioned-tripwire parity, not file-hash parity (our wire is versioned JSON,
  theirs is a bundled npm package).
- **GET retries** (bounded, network/503 only, `Retry-After` honored once).
  **POST/PATCH/PUT/DELETE never retry blindly**: invoke retries only with the
  same caller `Idempotency-Key`; PATCH is last-writer-wins and surfaces for
  the caller to re-list and reconcile.
- **Token rotation is bounded one-401 refresh**: one rotation, one retry, then
  the 401 surfaces and auth-failure handling runs. No refresh loop.
- Subscriptions are **bounded polling** against the authoritative revision
  (acceptable for the first slice per OBS-02): on transport failure the poller
  backs off, re-lists from the last known revision on reconnect, and resumes.
  Unsubscribe halts all further fetches (repeat mount/unmount safe). No
  WebSocket, Durable Object, or Queue is added here — that is an explicit
  parity exception (see section 7).

### 6. What is NOT mapped (retained in owning issues)

- **Forms/config hooks.** Upstream V2 exports no forms/config hook surface in
  the cited files either; to the extent platform config/forms SDKs exist, they
  belong to FORM-02 and CON-02. Nothing here invents them.
- **Batch mutations, rich query DSL, counts/sorts.** TABLE-02 owns the
  policy-safe querying and batch story; this slice answers 422 with the exact
  limitation code.
- **Generated artifacts and retention.** FILE-02 owns artifact lifecycles.
- **Author log/progress streaming.** Live Execution logs belong to OBS-02; the
  runtime polls Execution detail status/result only.

### 7. Explicit parity exceptions

1. **Polling instead of WebSocket.** Upstream realtime rides `/ws/connect`
   with subscribe frames; the first slice polls D1 revisions on backoff. Cost
   and complexity stay inside Worker + D1 (Free-tier viable); a socket fanout
   (Durable Object/Queue) needs its own requirement and ADR.
2. **No bundled npm package.** Upstream ships the SDK as an installable
   package with a file-hash tripwire; Wrangnarök ships typed `client/src/lib`
   sources with a version tripwire (`APP_SDK_VERSION` + handshake). Same
   drift-fails-loud guarantee, no registry dependency.
3. **File bytes in D1, not R2.** Files cap at 32 KiB in D1 `content_base64`
   (CHECK-bounded). Anything larger, or real binary-asset hosting, earns R2
   through FILE-02 with its own requirement.
4. **Runtime file list is grant-filtered, not total.** Upstream `files.list`
   takes a directory; this slice lists read-granted files only. Directory
   scoping arrives with FILE-01/FILE-02 if a concrete app needs it.

## Consequences

- Worker + D1 only: five tables (`app_grants`, `app_tables`, `app_rows`,
  `app_files`, `app_file_tokens`, `app_executions`), no new primitives.
- Organization boundaries stay explicit: foreign-Organization app ids answer
  `APP_NOT_FOUND` (404) on every runtime route; grants never cross apps.
- Coverage and bundle pressure: the runtime domain plus ~20 routes are pinned
  by `test/app-runtime.test.ts` against real local workerd/D1/Workflows
  (vendor HTTP mocked only at the Integration boundary); the bundle budget
  moves deliberately with the measured delta.
- APP-02 moves to Partial: invoke/result, filtered read/write/live poll, and
  signed file upload/download are proven against the real local Worker. The
  retained subcases are WebSocket realtime (needs OBS-02 scale evidence),
  batch/rich query (TABLE-02), and artifact lifecycles (FILE-02).
