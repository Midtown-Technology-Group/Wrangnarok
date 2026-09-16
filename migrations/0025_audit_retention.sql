CREATE TABLE audit_events_new(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_user_id TEXT NOT NULL, action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 128), target_type TEXT, target_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')), detail_json TEXT, created_at TEXT NOT NULL);
INSERT INTO audit_events_new (id, org_id, actor_user_id, action, target_type, target_id, outcome, detail_json, created_at) SELECT id, org_id, actor_user_id, action, target_type, target_id, outcome, detail_json, created_at FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_new RENAME TO audit_events;
CREATE INDEX audit_events_org ON audit_events(org_id, created_at DESC, id DESC);
CREATE INDEX audit_events_action ON audit_events(org_id, action, created_at DESC, id DESC);
