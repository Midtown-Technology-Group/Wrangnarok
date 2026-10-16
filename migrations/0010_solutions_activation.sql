CREATE TABLE IF NOT EXISTS bundle_active(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), version TEXT NOT NULL, manifest_hash TEXT NOT NULL, install_id INTEGER NOT NULL REFERENCES bundle_installs(id), activated_at TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id));
CREATE TABLE IF NOT EXISTS bundle_config(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), config_key TEXT NOT NULL, config_value TEXT NOT NULL, managed_by TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id, config_key));
CREATE TABLE IF NOT EXISTS bundle_sagas(bundle_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), saga_id TEXT NOT NULL, revision TEXT NOT NULL, managed_by TEXT NOT NULL, PRIMARY KEY(bundle_id, org_id, saga_id));
ALTER TABLE connections ADD COLUMN config_json TEXT;
CREATE TRIGGER IF NOT EXISTS bundle_installs_no_update BEFORE UPDATE ON bundle_installs BEGIN SELECT RAISE(ABORT, 'bundle_installs is immutable install evidence'); END;
CREATE TRIGGER IF NOT EXISTS bundle_installs_no_delete BEFORE DELETE ON bundle_installs BEGIN SELECT RAISE(ABORT, 'bundle_installs is immutable install evidence'); END;
