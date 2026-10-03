ALTER TABLE task_results ADD COLUMN artifact_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE task_results r SET artifact_ids=links.ids FROM (
  SELECT result_id,array_agg(id ORDER BY id) AS ids
  FROM task_artifacts WHERE result_id IS NOT NULL GROUP BY result_id
) links WHERE r.id=links.result_id;
