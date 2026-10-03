ALTER TABLE browser_sessions ADD COLUMN open_operation_id uuid REFERENCES operations;
ALTER TABLE browser_sessions ADD COLUMN open_request_deadline timestamptz;
ALTER TABLE browser_sessions ADD COLUMN open_instruction_revision bigint;
ALTER TABLE browser_sessions ADD COLUMN open_failure_code varchar(80);
ALTER TABLE browser_sessions ADD COLUMN open_next_attempt_at timestamptz;
ALTER TABLE browser_sessions ADD CONSTRAINT browser_open_request_binding CHECK (
  (open_operation_id IS NULL AND open_request_deadline IS NULL AND open_instruction_revision IS NULL)
  OR (purpose='TASK' AND open_operation_id IS NOT NULL AND open_request_deadline IS NOT NULL
    AND open_instruction_revision IS NOT NULL));
CREATE INDEX browser_open_due ON browser_sessions(open_next_attempt_at,id)
  WHERE open_operation_id IS NOT NULL AND state IN ('REQUESTED','STARTING','ACTIVE','STOPPING','LOST','FAILED','CLOSED');
ALTER TABLE browser_profile_startups ALTER COLUMN command_id DROP NOT NULL;
