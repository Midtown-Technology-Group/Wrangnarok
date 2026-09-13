CREATE TABLE IF NOT EXISTS resource_roles(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS resource_roles_org_name ON resource_roles(org_id, name);
CREATE TABLE IF NOT EXISTS role_grants(id TEXT PRIMARY KEY, role_id TEXT NOT NULL REFERENCES resource_roles(id), resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS role_grants_unique ON role_grants(role_id, resource_kind, resource_id, action);
CREATE TABLE IF NOT EXISTS role_assignments(role_id TEXT NOT NULL REFERENCES resource_roles(id), org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL REFERENCES users(user_id), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(role_id, org_id, user_id));
CREATE INDEX IF NOT EXISTS role_assignments_user ON role_assignments(org_id, user_id, status);
CREATE INDEX IF NOT EXISTS role_assignments_role ON role_assignments(role_id, status);
CREATE TABLE IF NOT EXISTS policy_rules(id TEXT PRIMARY KEY, org_id TEXT REFERENCES organizations(id), resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL, subject_type TEXT NOT NULL, subject_ref TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS policy_rules_unique ON policy_rules(COALESCE(org_id, ''), resource_kind, resource_id, action, subject_type, subject_ref);
