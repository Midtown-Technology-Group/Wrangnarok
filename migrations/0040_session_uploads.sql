CREATE TABLE form_session_uploads(session_hash TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), location TEXT NOT NULL, path TEXT NOT NULL, field TEXT NOT NULL, max_bytes INTEGER NOT NULL, content_types_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_hash, location, path));
CREATE INDEX form_session_uploads_session ON form_session_uploads(session_hash);
