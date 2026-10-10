ALTER TABLE task_requests ADD COLUMN verification jsonb
  CHECK (verification IS NULL OR type = 'UNKNOWN_RESULT');
ALTER TABLE task_requests DROP CONSTRAINT task_requests_answer_source_check;
ALTER TABLE task_requests ADD CONSTRAINT task_requests_answer_source_check CHECK (
  answer_source = 'MCP_ELICITATION' OR
  (answer_source = 'MCP_VERIFICATION' AND type = 'UNKNOWN_RESULT'
    AND answer_command IS NOT NULL AND answer_command IN ('CONFIRM', 'REJECT')
    AND answer IS NOT NULL AND verification IS NOT NULL
    AND length(btrim(answer)) BETWEEN 1 AND 4000)
);
