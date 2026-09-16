-- SPDX-License-Identifier: AGPL-3.0
-- 0026: cancelling-repair (issue #381).
--
-- Migration 0002 rebuilds executions via CREATE executions_new / INSERT /
-- DROP executions / RENAME, but the pre-existing operations child table holds
-- a FOREIGN KEY to executions(id). With foreign keys enabled the DROP fails
-- whenever at least one operation row exists, which ordinary workflow
-- execution produces -- so the failure is reachable through normal pre-upgrade
-- use, and it strands executions_new (with post-0002 data) next to the old
-- executions table. This repair runs the same rebuild while briefly removing
-- and restoring the operations child (rows preserved through a backup table),
-- so it completes on populated databases. Safe on every reachable state:
-- healthy post-0002 databases, pre-0002 backups restored from before 0002
-- (old-shape executions plus rows), fresh databases, and reruns of itself
-- (all temp and backup tables are dropped first, all creates guarded).
DROP TABLE IF EXISTS executions_new;
DROP TABLE IF EXISTS _operations_backup;
DROP TABLE IF EXISTS _executions_repair_new;
CREATE TABLE IF NOT EXISTS _executions_repair_new (id TEXT PRIMARY KEY, saga_id TEXT NOT NULL, saga_name TEXT NOT NULL, saga_revision TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id), user_id TEXT NOT NULL, input_json TEXT NOT NULL CHECK(length(input_json) <= 4096), dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0, 1)), status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending', 'Running', 'Succeeded', 'Failed', 'TimedOut', 'Cancelling', 'Cancelled')), created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, result_json TEXT CHECK(result_json IS NULL OR length(result_json) <= 4096), error_json TEXT);
INSERT OR IGNORE INTO _executions_repair_new (id, saga_id, saga_name, saga_revision, org_id, user_id, input_json, dispatched, status, created_at, started_at, completed_at, result_json, error_json) SELECT id, saga_id, saga_name, saga_revision, org_id, user_id, input_json, dispatched, status, created_at, started_at, completed_at, result_json, error_json FROM executions;
CREATE TABLE IF NOT EXISTS _operations_backup (execution_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, result_json TEXT, error_json TEXT, PRIMARY KEY(execution_id, name));
INSERT OR IGNORE INTO _operations_backup (execution_id, name, position, status, started_at, completed_at, result_json, error_json) SELECT execution_id, name, position, status, started_at, completed_at, result_json, error_json FROM operations;
DROP TABLE IF EXISTS operations;
DROP TABLE IF EXISTS executions;
ALTER TABLE _executions_repair_new RENAME TO executions;
CREATE TABLE IF NOT EXISTS operations (execution_id TEXT NOT NULL REFERENCES executions(id), name TEXT NOT NULL, position INTEGER NOT NULL CHECK(position >= 0), status TEXT NOT NULL CHECK(status IN ('Running', 'Succeeded', 'Failed')), started_at TEXT NOT NULL, completed_at TEXT, result_json TEXT CHECK(result_json IS NULL OR length(result_json) <= 4096), error_json TEXT, PRIMARY KEY(execution_id, name));
INSERT OR IGNORE INTO operations (execution_id, name, position, status, started_at, completed_at, result_json, error_json) SELECT execution_id, name, position, status, started_at, completed_at, result_json, error_json FROM _operations_backup;
DROP TABLE IF EXISTS _operations_backup;
CREATE INDEX IF NOT EXISTS executions_history ON executions(org_id, user_id, created_at DESC, id DESC);
