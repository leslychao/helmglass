ALTER TABLE task_requests
  ADD COLUMN instruction_revision bigint CHECK (instruction_revision > 0),
  ADD COLUMN answer_command text
    CHECK (answer_command IN ('ANSWER','CONFIRM','REJECT','CHOOSE_CONNECTION')),
  ADD COLUMN answer_connection_id uuid;

-- Pending requests still belong to the current instruction. Historical answers have
-- no recorded revision or decision and must not be reinterpreted as fresh consent.
UPDATE task_requests r SET instruction_revision=t.instruction_revision
  FROM tasks t WHERE t.id=r.task_id AND r.status='PENDING';

CREATE INDEX task_requests_latest_response
  ON task_requests(task_id,instruction_revision,answered_at DESC,id DESC)
  WHERE status='ANSWERED' AND answer_command IS NOT NULL;
