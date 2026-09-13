# ADR 020: Administrative audit trail and operational notifications (OPS-01 slice)

- **Status:** Accepted (2026-09-11; gates issue #172, OPS-01)
- **Date:** 2026-09-11
- **Extends:** ADR 001 (execution model), ADR 005 (secret storage), ADR 014 (Access auth)
- **Upstream compatibility:** shaped from upstream `gobifrost/bifrost` audit/notification machinery. All pins below verified in the local `vendor/upstream` checkout at `0598020e` (the issue baseline `3543c7e` lists the same router/service paths: `api/src/routers/audit.py`, `api/src/routers/notifications.py`, `api/src/services/audit.py`, `api/src/services/notification_service.py`; tests `api/tests/e2e/api/test_audit_log.py`, `api/tests/e2e/api/test_notifications.py`). Ideology preserved; divergences are explicit and Cloudflare-driven. Upstream sources were inspected, not executed.

## Context

Upstream Bifrost keeps two operational surfaces that Wrangnarök lacks:

1. **Audit log.** An `audit_logs` table plus an `emit_audit()` helper called from handlers that perform auditable actions (user/org/role lifecycle, login success/failure, `policy.deny` for file/table operations). A read-only `GET /api/audit` lists entries newest-first with keyset pagination, filtered by action prefix, resource type, outcome, user, date range, and free-text search. **Only platform superusers may read it** (`CurrentSuperuser`). Audit failures are logged and swallowed: they must never break the primary operation (the emit helper wraps its insert so a failed audit row never poisons the caller's transaction).
2. **Notifications.** An ephemeral per-user/admin notification store (Redis with TTLs: 1h active, 5min after done) plus WebSocket delivery (`notification:{user_id}` channels). Notifications carry category, title, description, status (`pending`/`running`/`awaiting_action`/`completed`/`failed`/`cancelled`), optional progress percent, error/result payloads, and metadata. REST endpoints list, fetch, and dismiss; only the owner may dismiss (admins may dismiss admin-scoped rows they can see). Creation is server-side (long-running ops: GitHub sync, uploads, package installs, embedding reindex); duplicate admin notifications are found by title before re-creating. Dismissing a still-running reindex sets a cancellation flag instead of deleting.

Wrangnarök has neither: ExecutionHistory records runs, not user/role/config mutations or policy denies, and there is no inbox/dismiss/progress UI.

## Decision

Worker + D1 only. No Queue, Durable Object, KV, or WebSocket is earned by this slice: the first delivery is durable D1 state plus client polling (polling is the accepted first slice for live updates, same posture as OBS-02). What ships:

### 1. Audit events (`audit_events` D1 table, migration `0018_ops.sql`)

One row per consequential event: `actor_user_id`, `org_id`, dotted `action`, `target_type`, `target_id`, `outcome` (`success`/`failure`), scrubbed `detail_json`, `created_at`.

**Emission points (v1):** the only management mutations this product currently owns, plus their policy denies and owner cancellation:

- `app.create`, `app.source.edit`, `app.build.start`, `app.build.complete`, `app.swap`, `app.delete` (outcome success/failure as observed);
- `app.managed_deny` (outcome failure) when a Solution-owned row rejects live mutation;
- `execution.cancel` (outcome success) and `execution.cancel_unconfirmed` (outcome failure) for the owner cancel route.

Ordinary Execution submits, form submissions, reads, and unauthenticated 401s are not auditable actions in v1 (no attributed actor, or ordinary user-level work, not administration). New management surfaces must add their own emission at the route layer; the helper makes that one call.

**Failure policy (explicit, adopted from upstream):** audit writes are best-effort. A failed audit insert logs `WRANGNAROK_AUDIT_SKIPPED <action>` via `console.warn` and never fails the primary mutation. The response never claims an audit row exists: readers see only rows actually stored. Tested by running a mutation against a database without the audit table (primary still succeeds).

**Reads:** `GET /api/audit` lists the caller's own Organization rows newest-first with keyset pagination (`created_at DESC, id DESC`, opaque cursor). Server-side filters: `action` prefix, `outcome`, `search` (bounded `LIKE` over action/target/detail), `startDate`/`endDate`, `limit` (1-50, default 20). Unknown keys are `UNSUPPORTED_QUERY` (deny-by-default, same as history). There is no per-row detail route (upstream has none either).

**Access (explicit adaptation):** upstream restricts reads to platform superusers. Wrangnarök has no role model yet (AUTH-02 owns it), so v1 scopes reads to the authenticated Organization: any caller in the org lists that org's events; cross-org rows are never visible (the scope comes from auth context, never the query). Role-gated audit reads arrive with AUTH-02; until then the org boundary plus documented limitation stands.

**Redaction:** details are scrubbed with deployment secrets at write time (same substring discipline as SEC-01) and scrubbed again on read. Never persist raw caller bodies or secret-bearing values.

**Retention (explicit):** no automatic deletion in v1. Audit rows accumulate under the D1 per-database size bound; scheduled cleanup/export belongs to OPS-03. This is stated here so growth is a tracked cost, not a surprise.

### 2. Notifications (`notifications` D1 table, migration `0018_ops.sql`)

Durable rows (not ephemeral TTLs — D1 has no key expiry, and durability is the point): `id` (UUID), `org_id`, owning `user_id`, `scope` (`personal`|`org`), `category`, `title`, `body`, `status` (upstream vocabulary: `pending`/`running`/`awaiting_action`/`completed`/`failed`/`cancelled`), nullable `progress_percent` (0-100, `NULL` = indeterminate), scrubbed `detail_json` (carries `{appId, jobId, revision}` for job-linked rows), timestamps, `dismissed_at`.

**Scopes (explicit adaptation):** upstream delivers to individual users or platform admins. With no role model, v1 scopes are `personal` (owner only) and `org` (every caller in the Organization — the stand-in for admin broadcast until AUTH-02 roles land). Visibility: list returns own personal rows plus same-org `org` rows; `personal` rows of other users never leak (404 on direct fetch, absent from lists). Dismiss: personal rows dismiss by owner only; `org` rows dismiss by any same-org caller (mirrors upstream admins dismissing admin rows they can see).

**Emission points (v1):** app deploy jobs only (the one long-running operation this product has). The build route creates a terminal (`completed`/`failed`) personal notification carrying the job outcome after `startBuild` returns. `running`/`pending` statuses exist in the model for future genuinely-async builds; v1 never leaves a live `running` row behind from the HTTP path.

**Reconnect and interrupted jobs:** D1 is the source of truth, so a reconnecting client re-reads authoritative state (poll, never a stream). Job-linked notifications reconcile on read: a `pending`/`running` notification whose `app_jobs` row is terminal advances to the matching terminal status instead of reporting stale progress. A notification whose job row is gone answers `NOTIFICATION_NOT_FOUND` (missing, never fabricated).

**Duplicates:** job-linked rows carry `dedup_key = app-build:{jobId}` under `UNIQUE(org_id, dedup_key)`; a second create for the same job returns the existing row. A second dismiss answers 404 (gone, not an error to retry blindly).

**No client-created notifications in v1** (upstream likewise has no create endpoint; creation is server-side). No upload-lock endpoints (no upload surface exists to lock).

### 3. Client surfaces

- Typed SDK client methods (`listAuditEvents`, `listNotifications`, `getNotification`, `dismissNotification`) plus wire guards, error codes, and contract-descriptor routes. Additive: `SDK_VERSION` stays `1`.
- CLI: `audit` (filters + `--all` cursor traversal), `notifications` (list), `dismiss-notification --id UUID`, each with offline selftest cases.
- UI: `/audit` (filterable event list) and `/notifications` (inbox with dismiss + polling refresh that stops on unmount). Nav enables both with the honest phase label.

## Consequences

- OPS-01 moves Missing to Partial: trails and inbox ship with real tests, but role-gated audit reads, admin scoping, live progress streaming, and retention automation stay explicitly open (AUTH-02, OBS-02 follow-ups, OPS-03).
- Every new management route must emit audit events or document why it does not; reviewers enforce this.
- Cost: two small D1 tables and a bounded write per management mutation — inside the Free-tier envelope, measured by the existing smoke/bundle gates.

## Alternatives considered

- **Redis/KV ephemerality with TTLs (upstream-faithful):** rejected — adds a primitive for data whose whole value is durability; D1 rows plus dismissal are simpler and survive reconnects by construction.
- **WebSocket/DO live delivery:** rejected for v1 — polling over durable state is the accepted first slice; a push design needs its own ADR when reconnect/progress demands it.
- **Superuser-only audit reads now:** rejected — no superuser concept exists; inventing one here would pre-empt AUTH-02. Org-scoped reads with the documented limitation are the honest v1.

## Extension: Cloudflare-native diagnostics and repairs (OPS-02, issue #173)

Upstream Bifrost keeps operator diagnostics as queue/worker/process
surfaces (`health.py`, `version.py`, `metrics.py`, `jobs.py`,
`platform_jobs.py`, `scheduler_diagnostics.py`, `platform/workers.py`,
`maintenance.py`). Wrangnarök maps each to the primitives it actually runs
on — Worker, Workflow, D1 — and never invents container or RabbitMQ names.

**Reads (all Organization-scoped, all credential-free local):**

- `GET /api/ops/version`: SDK contract version, static Catalog fingerprint,
  applied `d1_migrations` journal (best-effort, empty when unreadable).
- `GET /api/ops/health`: Worker/D1 liveness (`SELECT 1`), 200 ok or 503
  degraded. No vendor, no metering, no secrets.
- `GET /api/ops/metrics` (`?recent=1-50`): per-status Execution counts,
  undispatched-Pending admission backlog, newest terminal failures with safe
  error codes (inputs/results never ride along).
- `GET /api/ops/scheduled-tasks`: durable endpoint inventory (the trigger
  surface that exists); cadence stays honestly null until TRG-01 schedules.
- `GET /api/ops/jobs`: Execution backlog counters plus app deploy-job
  aggregates with interrupted flags (building with no live job row).
- `GET /api/ops/preflight`: static per-Integration mapping presence and
  missing deployment-secret names (never values, never vendor HTTP).
- `GET /api/ops/connections`: per-Integration Connection health with the
  registry test hints (live probes stay on the per-Connection test route).

**Repairs (`POST /api/ops/repairs`, inspect-then-act double-commit):**
dryRun omitted or true only inspects (no writes, no dispatch, no deletes);
explicit dryRun:false executes behind the admin gate (`isAdminCaller`) and
emits a best-effort `ops.repair.<kind>` audit event. Kinds: retry-execution
(fresh key, original-input replay), cancel-execution (owner-cancel state
machine), cleanup-pending-uploads (pending file rows only), cleanup-expired-
tokens (expired capability rows only), repair-stuck-build (conditional
status restore, fenced on still-building). Ordinary members may inspect;
only admins may commit. Production stays manual per ADR 004; nothing here
runs on a schedule. No new D1 tables, no new primitives: the slice reads
and repairs rows the product already owns.

**Explicit non-goals:** recurring-schedule rows (TRG-01), live vendor probes
in preflight, documentation/index repair (no index exists), distributed
upload locks (single-writer D1 needs none), provider metering (unavailable,
never fabricated), and role-gated audit reads (AUTH-02 owns them).
