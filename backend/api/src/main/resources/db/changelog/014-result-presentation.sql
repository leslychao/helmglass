ALTER TABLE task_results ADD COLUMN sections jsonb NOT NULL DEFAULT '[]';
ALTER TABLE task_results ADD COLUMN sources jsonb NOT NULL DEFAULT '[]';
CREATE INDEX task_owner_created ON tasks(user_id,created_at,id) WHERE state<>'DRAFT';
CREATE INDEX task_artifact_result ON task_artifacts(result_id,id) WHERE result_id IS NOT NULL;
