ALTER TABLE executions ADD COLUMN parent_execution_id TEXT;
ALTER TABLE executions ADD COLUMN parent_step TEXT;
CREATE INDEX IF NOT EXISTS executions_parent ON executions(parent_execution_id);
