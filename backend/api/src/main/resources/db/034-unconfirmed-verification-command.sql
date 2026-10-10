ALTER TABLE task_requests DROP CONSTRAINT task_requests_answer_command_check;
ALTER TABLE task_requests ADD CONSTRAINT task_requests_answer_command_check CHECK (
  answer_command IN ('ANSWER', 'CONFIRM', 'REJECT', 'CHOOSE_CONNECTION') OR
  (answer_command = 'PROCEED' AND type = 'UNKNOWN_RESULT' AND verification IS NOT NULL)
);
