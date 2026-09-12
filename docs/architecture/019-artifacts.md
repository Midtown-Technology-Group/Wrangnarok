# ADR 019: Generated Artifacts — D1 identity plus R2 bytes, attachment bindings, retention

- **Status:** Accepted (2026-09-11; gates FILE-02 per issue #158)
- **Date:** 2026-09-11
- **Extends:** ADR 002 (stable identity), ADR 003 (Integration vs Connection split), ADR 011 (portable bundles exclude tenant state)
- **Upstream compatibility:** shaped from upstream `gobifrost/bifrost` artifact machinery at baseline `3543c7ebee0e1bd9a2cab6dfba080a30621b1c5f` (`api/src/routers/chat.py`, `api/src/routers/maintenance.py`, `api/src/models/contracts/artifacts.py`, `api/bifrost/artifacts.py`, `docs/guides/chat-artifacts.md`; test `api/tests/e2e/api/test_artifact_retention.py`). Ideology preserved; divergences below are explicit and Cloudflare-driven. The files/artifacts surface was additionally pinned by the upstream sweep in `docs/upstream-spec.md` §16 (presigned URLs, finalize-after-PUT, versioned deletes, opt-in scheduled cleanup default 90 days range 1–3650, per-surface size caps).

## Context

Upstream Bifrost manages two adjacent but distinct surfaces: managed file locations (signed GET/PUT, finalize-after-upload, policy-checked mutation — FILE-01) and generated/uploaded Artifacts with opaque IDs, workspace/conversation/execution ownership, attachment bindings, and retention cleanup (FILE-02). Wrangnarök has neither: managed file locations do not by themselves cover opaque artifact IDs, generated chat files, attachment ownership, or cleanup policy.

## Decision

### 1. Artifact identity, versions, metadata — separate from portable files

An **Artifact** is an Organization-scoped record: stable UUID identity (ADR 002 rules), a human name, a MIME claim, byte size, an integer version, and an active/deleted status marker. R2 carries one object per Artifact version (`artifacts/<id>/v<n>`); D1 carries identity, ownership, version rows, attachment bindings, and the retention policy. Portable exports are metadata-only by construction (OPS-03 owns the explicitly encrypted full-backup exception).

Same-filename re-upload appends a new integer version to the SAME Artifact row (same stable UUID, same bindings). This is explicitly NOT an optimistic version-conflict API: there is no If-Match, no stale-version 409 on re-upload; the current version pointer always advances. A fenced compare-and-swap on the version pointer exists only for the racing-upload race (409 VERSION_RACE with the loser byte object reclaimed), never as caller-visible conflict semantics.

Artifact rename (upstream `chat.py:388-432` evidence) is a metadata write on the canonical record: it changes the name, never moves bytes, never appends a version.

### 2. Why R2 (first Cloudflare primitive beyond Worker + Workflows + D1)

Project constraint 7 requires documenting why each new primitive is needed. Artifact bytes are opaque, arbitrarily large (up to 5 MiB per surface), and must survive independently of D1 row lifetimes while remaining deletable per retention. D1 value caps make it the wrong venue for bytes; the Worker has no filesystem; KV is eventually consistent and capped per value. R2 is the Cloudflare-native object store for exactly this shape, with a local Miniflare implementation so tests run credential-free.

### 3. Canonical versus attachment-binding access (composed with AUTH-01)

Two separate gates, tested independently, both behind the AUTH-01 membership gate (every request resolves the CallerCtx first; strangers get the membership 404 before artifact policy runs):

- **Canonical access** (metadata, bytes, rename, delete): the row must sit in the caller's resolved Organization (else 404 via the AUTH-01 membership gate), and the caller must be the creator or an admin (else 403). Admin composes with AUTH-01 (ADR 015): instance admins (the deployment `ADMIN_USER_IDS` list, install state never in Git) and Organization admins (the membership row) bypass the creator check. There is no self-asserted admin and no separate artifact role table (finer roles belong to AUTH-02). Deleted rows answer 404 to non-admins and 410 to admins (gone versus never-existed).
- **Attachment-binding access** (chat/conversation readers): a binding names the (scope, refId) an Artifact backs. Listing bindings answers the triple only — never bytes, never canonical metadata — so a chat reader resolves which Artifact backs an attachment without gaining byte access. Byte reads always re-pass the canonical gate.

### 4. Retention and cleanup

Expiry is pinned by `Artifact.created_at` (upstream invariant), never last access. Cleanup is explicit, never scheduled implicitly:

- Preview lists what WOULD be deleted (no writes, bounded to 100 with a truncation flag).
- Run deletes one bounded batch with per-row outcomes (deleted ids, failed id+code pairs, remaining count). R2 deletes precede the D1 deleted-marker so an interruption leaves an active row the next run picks up (R2 deletes are idempotent), never a deleted marker over surviving bytes.
- Upload completion is verified: bytes land in R2 before the version row commits; a failed R2 write deletes the Artifact row so no orphan metadata survives.
- Safe default: 90 days (upstream default), range 1–3650. Policy changes and cleanup runs are admin-only (instance or Organization admin per the resolved CallerCtx).

Still-referenced artifacts are NOT preserved: cleanup deletes expired rows even when bindings exist (bindings cascade). Preserving referenced artifacts would be an explicit adaptation, recorded here as rejected — the upstream invariant is expiry-by-created_at with cascading chat bindings.

### 5. Limits and deferred deltas

- Per-surface byte cap: 5 MiB. MIME is an allowlisted type/subtype claim; no sniffing. Names are printable text, never paths.
- Generated-output format/provider capabilities (PDF/DOCX/XLSX/CSV/HTML/Markdown/JSON/text, configured image/video generation, async attachment completion) are tracked as unchecked `deferred` subcapabilities served by `GET /api/artifacts/formats`. Python rendering libraries are never required on Workers.
- Multipart/abort UX, presigned-URL issuance, and policy CRUD are FILE-01's surface (signed-URL roundtrips); FILE-02 serves bytes directly through the Worker with no-store. If a future requirement needs direct-to-R2 browser PUTs, it arrives as a FILE-01 extension with its own ADR delta.

## Consequences

- `migrations/0020_artifacts.sql` owns the schema; `src/artifacts.ts` owns the domain; `src/index.ts` routes mirror the apps style (one explicit matcher per route).
- The SDK contract gains the artifact routes, error codes, and a `generated-artifacts: supported` capability; `docs/sdk-capability-map.md` flips `files, artifacts` to Partial.
- The parity map marks FILE-02 Partial: the lifecycle ships; AUTH-02 roles (finer than creator/admin), FILE-01 signed-URL parity, and AI-03 chat attachment surfacing remain with their owners.
