ALTER TABLE session_usage_checkpoints ADD COLUMN source_started_at timestamptz;
ALTER TABLE usage_measurements ADD CONSTRAINT usage_interval_order CHECK (interval_end >= interval_start);
CREATE INDEX usage_task_interval ON usage_measurements(task_id,interval_start,id);
