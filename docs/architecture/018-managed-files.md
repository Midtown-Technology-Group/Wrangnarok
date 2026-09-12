# ADR 018: Managed file locations over R2 with D1 metadata, policy-checked proxy access, and finalize-after-upload

- **Status:** Accepted (2026-09-11; gates FILE-01 per issue #157)
- **Date:** 2026-09-11
- **Extends:** ADR 003 (Integration vs Connection), ADR 010 (Phase 1b design), ADR 014 (Access auth)
- **Upstream compatibility:** shaped from upstream `gobifrost/bifrost` file machinery at baseline `3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f` (`api/src/routers/files.py`, `api/bifrost/files.py`; tests `api/tests/e2e/api/test_files_signed_url_roundtrip.py`, `test_file_uploads.py`, `test_file_transitions.py`, `test_files_403_vs_404.py`). Ideology preserved; divergences below are explicit and Cloudflare-driven.

## Context

Upstream Bifrost serves author/runtime file storage through server-minted presigned S3 URLs, never through the API process as a pipe: `PUT`/`GET` URLs are minted only after per-action policy checks (`signed_get`, `signed_put`, `delete`) scoped by location, org scope, and path, with declared-solution-location requirements on writes. URL expiry is bounded 1 second to 7 days (default 600); batch issuance caps at 100 with per-path allow/deny results. Reads tier across scopes with an existence-first match (the shared read-only fallback pattern). A browser `PUT` is not trusted until the client finalizes it with asserted metadata (path, content-type, size, sha256). Deletes are policy-checked and optimistic-versioned: missing file or stale version answers `409` (`file_missing`, `version_conflict`). Structural listing is admin-only; a policy access-test endpoint exists. Size caps are per-surface, not global. Large objects stream via multipart without full-memory retention.

Wrangnarok has no file APIs and no R2 binding. This is author/runtime file storage, not Worker static assets (ADR 008): the control-plane UI ships as Static Assets and proves nothing about per-tenant file hosting.

## Decision

### 1. R2 is earned by this requirement (AGENTS.md constraint 7)

Worker + Workflows + D1 cannot store author/runtime bytes: container and Worker-local files are temporary by platform contract, and D1 rows carry small CHECK-bounded JSON, not blobs. FILE-01 is the concrete requirement that earns the second storage primitive: one R2 bucket (`FILES` binding) for bytes plus D1 tables for metadata, locations, policies, and capability tokens. No other primitive is added: no Queue, no Durable Object, no KV.

Bucket provisioning per environment (`wrangnarok-local`, `-dev`, `-preview`) is operator action via `wrangler r2 bucket create`; local development and tests use the Miniflare/workerd R2 implementation with zero production dependency (AGENTS.md constraint 12).

### 2. D1 metadata, org/location/path ownership

Every object is owned by exactly one `(org_id, location, path)` triple:

- `file_locations(org_id, name, max_bytes, content_types_json, shared_read, created_at)` — declared write locations. Writes outside a declared location are rejected; there is no implicit bucket root.
- `files(org_id, location, path, version, size, content_type, sha256, status, created_at, updated_at)` — metadata. `status` is `pending` (slot issued, bytes not yet verified) or `ready` (finalized). Only `ready` rows are readable.
- The R2 object key is namespaced `<org_id>/<location>/<path>` so a key can never alias across Organizations even if a policy check is bypassed in a future refactor. Defense in depth, not the authorization boundary: the SQL `WHERE org_id=?` clause is the boundary.

Path and location names are validated fail-closed: locations match the existing slug rule (`/^[a-z0-9][a-z0-9-]{0,63}$/`); paths are 1 to 512 characters of segments separated by `/` with no empty segments, no `.`/`..`, no backslashes, and a bounded charset. Traversal input is rejected with `INVALID_PATH`, never normalized into something loadable.

### 3. Declared write locations plus per-action policies

Writes require a declared location in the caller's own Organization plus an explicit allow row; reads require the same on the read path. Policies are default-deny allow rows:

- `file_policies(org_id, location, action, created_at)` with `action` in (`read`, `write`, `delete`) and `UNIQUE(org_id, location, action)`. Absence of a row is denial.
- Creating a location mints `read`, `write`, and `delete` allow rows for the owning Organization, so declaration is usable immediately; revocation is deleting the row.
- The trusted author (the authenticated Organization caller; no separate author role in v1, same posture as ADR 017 apps) administers policies: list, add, remove. Foreign-Organization rows answer 404, never a leak.
- `POST /api/file-policies/test` evaluates a hypothetical `(location, path, action)` triple to allow/deny with a reason, issuing nothing. The evaluator is a pure function shared by the test endpoint and every issuance path, so the tested behavior is the enforced behavior.

Per-surface byte caps are explicit, never inherited: each location declares `max_bytes` (1 byte to 25 MiB; default 5 MiB, the upstream logo-surface cap) and an optional content-type allowlist (default `application/octet-stream` plus common text/image types are not assumed; the allowlist is explicit per location, empty means any type up to the byte cap). The Worker PUT path additionally buffers at most `max_bytes + 1` bytes and answers `413` past the cap: single-PUT objects only (section 7).

### 4. Proxy plus revocable capabilities instead of presigned R2 URLs (accepted adaptation)

R2 presigned URLs (`createPresignedUrl`) do not exist on the Workers R2 binding surface, and minting HMAC capabilities would need a new deployment secret. The issue text explicitly accepts a proxy/revocable-capability design as a separate adaptation, and this ADR adopts it:

- Every byte flows through an authorized Worker route. There are no bearer storage URLs to leak, log, or revoke out-of-band.
- Two authorized shapes exist. Bearer shape: the Organization caller presents the standard `Authorization` header and the route policy-checks `(location, path, action)` per request. Capability shape: issuance endpoints mint opaque single-secret tokens persisted in `file_capabilities(id, org_id, location, path, action, expires_at, used_at, created_at)`; the byte routes accept `?token=` instead of the Bearer header and re-validate the token row (expiry, single-use consumption for uploads, policy still present) on every use.
- Bounded batch issuance matches upstream shape: `POST /api/files/uploads` and `POST /api/files/downloads` accept up to 100 entries and return per-path allow/deny results. Per-entry expiry is bounded 1 second to 7 days, default 600 seconds, mirroring upstream.
- TTL/revocation guarantees, stated explicitly: policy revocation (deleting a `file_policies` row) stops all new issuance immediately AND deletes outstanding capability rows for that `(org_id, location, action)`, so already-issued tokens stop working at revocation time, not at expiry. Bearer-shape access checks policy per request, so revocation is immediate there by construction. There is no grace window: refused-new plus invalidated-outstanding, stronger than upstream's TTL-bound invalidation, at the cost of a D1 delete on revoke.

### 5. Finalize-after-upload with server verification, never trust

The client flow is request-slot, PUT bytes, finalize — and the server verifies:

1. `POST /api/files/uploads` creates a `pending` metadata row and an upload capability token (single-use).
2. `PUT /api/files/content?token=` stores the raw bytes at the namespaced R2 key. The token is consumed (`used_at` set, fenced on `used_at IS NULL` so a replayed PUT fails closed).
3. `POST /api/files/finalize` takes asserted `{location, path, contentType, size, sha256, expectedVersion?}`. The server reads the R2 object back, streams it through SHA-256, and compares actual size, content type, and digest against the assertions. Any mismatch answers `409 COMPLETION_MISMATCH`, deletes the R2 bytes and the pending row, and never promotes to `ready`. A matching finalize promotes the row to `ready` (version 1 on first finalize; `expectedVersion` fencing on overwrite, section 6).

What the server verifies versus trusts is therefore explicit: the completion metadata is treated as a claim to check, not a fact to store. Cryptographic byte verification is real (streamed SHA-256 over the stored bytes at finalize time), not a trusted client digest. Multipart/abort UX is not adopted: single-PUT only (section 7).

### 6. Version/conflict-aware mutation with intentional non-disclosure

- Overwrite is a new upload slot plus `finalize` with `expectedVersion`: a stale expectation answers `409 VERSION_CONFLICT` and leaves the ready row untouched.
- `DELETE /api/files` takes `{location, path, expectedVersion}` under the `delete` policy: missing file answers `409 FILE_MISSING`, stale version answers `409 VERSION_CONFLICT` (matching upstream's mutation codes, since the caller already holds a versioned handle).
- Reads (`GET /api/files/content`, list) answer `404 NOT_FOUND` for missing, unfinalized (`pending`), and foreign-Organization objects alike: existence is never disclosed to an unauthorized caller (same posture as forms/apps). The existence-first shared-read tier (section 8) still applies before the 404.
- Download tokens are multi-use until expiry; upload tokens are single-use; both are invalidated by policy revocation (section 4).

### 7. Explicit non-goals (FILE-02 or later)

- Multipart upload, streaming abort/resume, and range GETs are not implemented. The PUT path buffers bounded objects (`max_bytes`, at most 25 MiB per location) and finalize streams for hashing. Large-object multipart stays deferred until a concrete requirement earns it; no multipart fault tests ship because the surface does not exist.
- Retention/artifact lifecycle (upstream's opt-in scheduled cleanup, default 90 days) belongs to FILE-02. Unfinalized `pending` rows and their R2 bytes are visible to the owning Organization's list endpoint as `pending` and can be deleted through the versioned delete path; no background sweeper ships in this slice.
- Full-text search over file content: listing is prefix-scoped structural access only (`GET /api/files?location=&prefix=&limit=`), authorized per request.

### 8. Bounded shared read-only fallback and list/search structure access

Upstream's shared fallback pattern is adopted with explicit bounds: a location with `shared_read=1` may satisfy reads from other Organizations when the reader's own Organization has no `ready` row at that `(location, path)`. The tier is existence-first (own row wins), read-only (writes and deletes never cross Organizations), and policy-gated on both sides (the reader needs a `read` allow row for a same-named location of their own or the shared flag plus reader policy; the writer's location must carry `shared_read=1`). Cross-Organization reads of non-shared locations answer 404. Structural listing (`GET /api/files`) is Organization-scoped always: it lists only the caller's own rows, never shared rows, so enumeration cannot cross the boundary.

## Consequences

- New platform primitive: R2 (`FILES` binding) plus migration `0019_files.sql`. Free-tier viable: R2 free tier covers experiment-scale bytes/operations; D1 rows are small metadata.
- New API surface (all authenticated, deny-by-default query strings, bounded JSON bodies): locations CRUD-list, batch upload/download issuance, token PUT/GET content, finalize, versioned delete, scoped list, policy admin plus access-test.
- SDK contract gains the file routes and error codes; `docs/sdk-capability-map.md` moves `files` to Partial (artifacts/retention stay Tracked under FILE-02).
- `docs/upstream-parity.md` FILE-01 row moves to Implemented with the single-PUT/multipart note.
