CREATE TABLE IF NOT EXISTS event_sources(id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('schedule','webhook','topic')), ref_id TEXT, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_at TEXT NOT NULL, UNIQUE(org_id, name));
CREATE INDEX IF NOT EXISTS event_sources_org ON event_sources(org_id);
CREATE INDEX IF NOT EXISTS event_sources_ref ON event_sources(org_id, kind, ref_id);
CREATE TABLE IF NOT EXISTS events(source_id TEXT NOT NULL REFERENCES event_sources(id), event_id TEXT NOT NULL, org_id TEXT NOT NULL, topic TEXT NOT NULL CHECK(length(topic) BETWEEN 1 AND 128), payload_json TEXT NOT NULL CHECK(length(payload_json) <= 4096), execution_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(source_id, event_id));
CREATE INDEX IF NOT EXISTS events_source ON events(source_id, created_at DESC, event_id DESC);
