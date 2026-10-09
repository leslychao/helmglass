ALTER TABLE task_requests
  ADD COLUMN elicitation_attempt_id uuid,
  ADD COLUMN elicitation_operation_key text,
  ADD COLUMN elicitation_deadline timestamptz,
  ADD COLUMN answer_source text CHECK (answer_source = 'MCP_ELICITATION');
