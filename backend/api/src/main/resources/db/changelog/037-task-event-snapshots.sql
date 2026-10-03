-- A task-local signing key keeps bounded history snapshots valid across API restarts.
-- It is never returned in a page or event; deleting the history counter revokes its snapshots.
ALTER TABLE task_event_counters ADD COLUMN snapshot_key uuid NOT NULL DEFAULT gen_random_uuid();

INSERT INTO task_event_counters(task_id,next_sequence,event_count)
SELECT t.id,coalesce(max(e.sequence),0)+1,count(e.sequence)
FROM tasks t LEFT JOIN task_execution_events e ON e.task_id=t.id
WHERE NOT EXISTS
  (SELECT 1 FROM task_event_counters c WHERE c.task_id=t.id)
GROUP BY t.id
ON CONFLICT(task_id) DO NOTHING;
