ALTER TABLE mcp_chats ADD COLUMN continuation_id uuid;

UPDATE mcp_chats c SET continuation_status='IDLE',continuation_revision=NULL,
  continuation_reason=NULL,continuation_requested_at=NULL,updated_at=now()
FROM tasks t WHERE t.id=c.task_id
  AND c.continuation_status IN ('PENDING','SENDING','MESSAGE_SENT','UNAVAILABLE')
  AND (t.status IN ('DRAFT','WAITING_USER','PAUSED','PAUSING','STOPPING','STOPPED',
                   'FAILED','SUCCEEDED','PARTIAL','NOT_ACHIEVED')
       OR t.paused_explicitly OR c.continuation_revision IS DISTINCT FROM t.instruction_revision);

UPDATE mcp_chats SET continuation_id=gen_random_uuid()
WHERE continuation_status IN ('PENDING','SENDING','MESSAGE_SENT','UNAVAILABLE');
