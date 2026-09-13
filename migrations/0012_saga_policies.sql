CREATE TABLE IF NOT EXISTS saga_policies(org_id TEXT NOT NULL REFERENCES organizations(id), saga_id TEXT NOT NULL, policy_json TEXT NOT NULL CHECK(length(policy_json) <= 2048), version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1), updated_at TEXT NOT NULL, PRIMARY KEY(org_id, saga_id));
ALTER TABLE executions ADD COLUMN policy_json TEXT;
