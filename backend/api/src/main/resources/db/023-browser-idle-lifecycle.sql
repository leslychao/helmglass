ALTER TABLE browser_sessions ADD COLUMN idle_close_at timestamptz;
ALTER TABLE browser_sessions ADD COLUMN close_reason text
  CHECK (close_reason IN ('USER', 'IDLE_TIMEOUT'));
ALTER TABLE tasks ADD COLUMN browser_resume_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE mcp_chats ADD COLUMN continuation_claimed_at timestamptz;
UPDATE mcp_chats SET continuation_claimed_at=updated_at WHERE continuation_status='SENDING';

UPDATE browser_sessions SET idle_close_at=clock_timestamp()+interval '15 minutes'
WHERE task_id IS NOT NULL AND status='LIVE' AND NOT close_requested;

CREATE INDEX browser_idle_deadline ON browser_sessions(idle_close_at)
  WHERE task_id IS NOT NULL AND status='LIVE' AND NOT close_requested;
