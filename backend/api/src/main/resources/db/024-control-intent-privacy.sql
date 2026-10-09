-- Transfer itself hides the browser; retain the pre-transfer login restriction separately.
UPDATE browser_sessions b
SET pending_control=jsonb_build_object(
  'input', b.pending_control,
  'keepPrivate', b.pending_control->>'type'='RETURN' AND NOT b.login_completed
    AND (b.task_id IS NULL OR EXISTS (
      SELECT 1 FROM tasks t WHERE t.id=b.task_id AND t.wait_reason='LOGIN')))
WHERE b.pending_control IS NOT NULL;
