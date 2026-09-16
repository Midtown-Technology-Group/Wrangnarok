-- SPDX-License-Identifier: AGPL-3.0
-- 0027: rename-replay repair (issues #367, #368, #369, #370, #371).
--
-- Five migrations were renumbered without content changes (old -> new):
-- 0010_ops -> 0018_ops (#367), 0007_files -> 0019_files (#368),
-- 0010_artifacts -> 0020_artifacts (#369), 0009_endpoints -> 0021_endpoints
-- (#370), 0005_solutions_activation -> 0010_solutions_activation (#371).
-- Wrangler records applied migrations by filename in d1_migrations, so a
-- database that applied an old name treats the new name as pending -- but the
-- new files reuse bare CREATE TABLE / CREATE INDEX (and, for 0010, a bare
-- ALTER TABLE connections ADD COLUMN config_json), which fail against the
-- already-existing objects. Because the failing new-name files sort BEFORE
-- this repair and the batch is atomic, such databases stay stuck: they can
-- never reach this file through `wrangler d1 migrations apply`. The recovery
-- is therefore a journal repair plus this file (see docs/migration-ledger.md
-- "stuck-database recovery"): delete the stuck new-name journal rows (and any
-- half-applied ledger entries), re-run `migrations apply` so the ORIGINAL
-- old-name files execute (they are the ones this database still needs), then
-- this repair converges every object with IF NOT EXISTS guards -- safe on
-- old-name databases, new-name databases, fresh databases, and reruns of
-- itself. The 0010 config_json column is intentionally NOT added here: ALTER
-- TABLE ADD COLUMN has no IF NOT EXISTS form in SQLite/D1, so an
-- unconditional ADD would fail on exactly the already-migrated databases this
-- repair serves. Databases that applied the old 0005 file already carry the
-- column; databases that applied only the new 0010 file also carry it (its
-- first three statements succeed before line 4 fails, and the journal row is
-- absent so a later apply reruns it to completion). Fresh databases receive
-- the column from 0010 itself, which sorts before this file.
CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), actor_user_id TEXT NOT NULL, action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 128), target_type TEXT, target_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')), detail_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_events_org ON audit_events(org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_action ON audit_events(org_id, action, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('personal','org')), category TEXT NOT NULL, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), body TEXT CHECK(body IS NULL OR length(body) <= 500), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','awaiting_action','completed','failed','cancelled')), progress_percent REAL CHECK(progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)), detail_json TEXT, dedup_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dismissed_at TEXT, UNIQUE(org_id, dedup_key));
CREATE INDEX IF NOT EXISTS notifications_inbox ON notifications(org_id, dismissed_at, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS file_locations(org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, max_bytes INTEGER NOT NULL CHECK(max_bytes BETWEEN 1 AND 26214400), content_types_json TEXT NOT NULL DEFAULT '[]' CHECK(length(content_types_json) <= 2048), shared_read INTEGER NOT NULL DEFAULT 0 CHECK(shared_read IN (0, 1)), created_at TEXT NOT NULL, PRIMARY KEY(org_id, name));
CREATE TABLE IF NOT EXISTS files(org_id TEXT NOT NULL REFERENCES organizations(id), location TEXT NOT NULL, path TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 0), size INTEGER NOT NULL CHECK(size >= 0), content_type TEXT NOT NULL CHECK(length(content_type) <= 128), sha256 TEXT NOT NULL CHECK(length(sha256) IN (0, 64)), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ready')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id, location, path));
CREATE INDEX IF NOT EXISTS files_location ON files(org_id, location, path);
CREATE TABLE IF NOT EXISTS file_policies(org_id TEXT NOT NULL REFERENCES organizations(id), location TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('read', 'write', 'delete')), created_at TEXT NOT NULL, PRIMARY KEY(org_id, location, action));
CREATE TABLE IF NOT EXISTS file_capabilities(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), source_org_id TEXT NOT NULL, location TEXT NOT NULL, path TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('upload', 'download')), staging_key TEXT, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS file_capabilities_org ON file_capabilities(org_id, location, action);
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), creator_user_id TEXT NOT NULL, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 256), mime TEXT NOT NULL CHECK(length(mime) BETWEEN 1 AND 128), size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX IF NOT EXISTS artifacts_org ON artifacts(org_id, status, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS artifact_versions(id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version >= 1), mime TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), created_at TEXT NOT NULL, UNIQUE(artifact_id, version));
CREATE INDEX IF NOT EXISTS artifact_versions_artifact ON artifact_versions(artifact_id, version DESC);
CREATE TABLE IF NOT EXISTS artifact_bindings(id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES organizations(id), scope TEXT NOT NULL CHECK(scope IN ('execution', 'workspace', 'conversation')), ref_id TEXT NOT NULL CHECK(length(ref_id) BETWEEN 1 AND 128), created_at TEXT NOT NULL, UNIQUE(artifact_id, scope, ref_id));
CREATE INDEX IF NOT EXISTS artifact_bindings_lookup ON artifact_bindings(scope, ref_id, org_id);
CREATE TABLE IF NOT EXISTS artifact_retention(org_id TEXT PRIMARY KEY REFERENCES organizations(id), max_age_days INTEGER NOT NULL DEFAULT 90 CHECK(max_age_days BETWEEN 1 AND 3650), updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS endpoints(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, saga_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('api-key','webhook')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), key_hash TEXT, key_expires_at TEXT, signature_secret_hash TEXT, challenge TEXT NOT NULL DEFAULT 'none' CHECK(challenge IN ('none','echo-param')), rate_limit_per_minute INTEGER CHECK(rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0), created_at TEXT NOT NULL, UNIQUE(org_id, name));
CREATE INDEX IF NOT EXISTS endpoints_org ON endpoints(org_id);
CREATE TABLE IF NOT EXISTS endpoint_events(endpoint_id TEXT NOT NULL REFERENCES endpoints(id), event_id TEXT NOT NULL, input_json TEXT NOT NULL CHECK(length(input_json) <= 4096), execution_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(endpoint_id, event_id));
CREATE TABLE IF NOT EXISTS endpoint_rate_windows(endpoint_id TEXT NOT NULL REFERENCES endpoints(id), window_start TEXT NOT NULL, hits INTEGER NOT NULL CHECK(hits >= 0), PRIMARY KEY(endpoint_id, window_start));
CREATE TABLE IF NOT EXISTS bundle_active(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), version TEXT NOT NULL, manifest_hash TEXT NOT NULL, install_id INTEGER NOT NULL REFERENCES bundle_installs(id), activated_at TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id));
CREATE TABLE IF NOT EXISTS bundle_config(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), config_key TEXT NOT NULL, config_value TEXT NOT NULL, managed_by TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id, config_key));
CREATE TABLE IF NOT EXISTS bundle_sagas(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), saga_id TEXT NOT NULL, revision TEXT NOT NULL, managed_by TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id, saga_id));
CREATE TRIGGER IF NOT EXISTS bundle_installs_no_update BEFORE UPDATE ON bundle_installs BEGIN SELECT RAISE(ABORT, 'bundle_installs is immutable install evidence'); END;
CREATE TRIGGER IF NOT EXISTS bundle_installs_no_delete BEFORE DELETE ON bundle_installs BEGIN SELECT RAISE(ABORT, 'bundle_installs is immutable install evidence'); END;
