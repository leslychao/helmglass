-- Preserve former summaries and their relationships as historical data.
ALTER TABLE task_steps RENAME TO task_steps_archive;
ALTER TABLE operations RENAME COLUMN step_id TO archived_step_id;
ALTER TABLE task_history RENAME COLUMN step_id TO archived_step_id;
ALTER INDEX operations_step RENAME TO operations_archived_step;

CREATE TABLE task_steps (
  id uuid CONSTRAINT agent_steps_pk PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  sequence bigint NOT NULL,
  tool_name varchar(100) NOT NULL,
  title varchar(300) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(24) NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  version bigint NOT NULL DEFAULT 1,
  result varchar(4000),
  duration_ms bigint CHECK (duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT agent_steps_task_id UNIQUE(task_id,id),
  CONSTRAINT agent_steps_sequence UNIQUE(task_id,sequence)
);
CREATE INDEX agent_steps_owner_task ON task_steps(owner_id,task_id,sequence DESC);
ALTER TABLE operations ADD COLUMN step_id uuid;
ALTER TABLE operations ADD CONSTRAINT operation_agent_step_task_fk
  FOREIGN KEY(task_id,step_id) REFERENCES task_steps(task_id,id);
CREATE INDEX operations_step ON operations(step_id) WHERE step_id IS NOT NULL;
ALTER TABLE task_history ADD COLUMN step_id uuid REFERENCES task_steps(id);
