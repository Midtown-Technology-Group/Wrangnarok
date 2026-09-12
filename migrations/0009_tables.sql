CREATE TABLE tables(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, owner_user_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(org_id, name));
CREATE INDEX tables_org ON tables(org_id);
CREATE TABLE table_rows(table_id TEXT NOT NULL REFERENCES tables(id), org_id TEXT NOT NULL, doc_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, data_json TEXT NOT NULL CHECK(length(data_json) <= 4096), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(table_id, doc_id));
CREATE INDEX table_rows_scan ON table_rows(table_id, doc_id);
CREATE INDEX table_rows_owner ON table_rows(table_id, owner_user_id);
CREATE TABLE table_grants(id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id), action TEXT NOT NULL CHECK(action IN ('read','insert','update','delete')), grantee_user_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(table_id, action, grantee_user_id));
CREATE INDEX table_grants_lookup ON table_grants(table_id, action, grantee_user_id);
