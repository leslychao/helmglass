ALTER TABLE tasks
  ADD COLUMN origin_correlation varchar(128),
  ADD COLUMN origin_client_id varchar(200),
  ADD COLUMN origin_grant_id uuid REFERENCES client_grants,
  ADD CONSTRAINT continuation_origin_complete CHECK (
    (origin_correlation IS NULL AND origin_client_id IS NULL AND origin_grant_id IS NULL)
    OR (origin_correlation IS NOT NULL AND origin_client_id IS NOT NULL AND origin_grant_id IS NOT NULL));

-- An earlier presentation cannot prove which conversation created an existing task.
-- Keep existing task/continuation identities and receipts; require explicit model continuation.
UPDATE tasks SET continuation_preference='MANUAL' WHERE continuation_preference='WIDGET_RETURN';
UPDATE task_continuations SET mode='MANUAL',version=version+1
  WHERE mode='WIDGET_RETURN' AND state IN ('WAITING_RESULT','READY');
