CREATE TABLE task_steps (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  operation_key varchar(128) NOT NULL,
  object_key varchar(500) NOT NULL,
  sequence bigint NOT NULL,
  title varchar(300) NOT NULL,
  completion_criterion varchar(2000) NOT NULL,
  status varchar(24) NOT NULL CHECK (status IN
    ('PLANNED','RUNNING','WAITING','SUCCEEDED','PARTIAL','FAILED','UNKNOWN','SKIPPED')),
  version bigint NOT NULL DEFAULT 1,
  result varchar(4000),
  evidence jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(task_id, id),
  UNIQUE(task_id, sequence),
  UNIQUE(task_id, operation_key, object_key)
);
CREATE UNIQUE INDEX one_active_business_step ON task_steps(task_id)
  WHERE status IN ('RUNNING','WAITING','UNKNOWN');
ALTER TABLE operations ADD COLUMN step_id uuid;
ALTER TABLE operations ADD CONSTRAINT operation_step_task_fk
  FOREIGN KEY(task_id,step_id) REFERENCES task_steps(task_id,id);
CREATE INDEX operations_step ON operations(step_id) WHERE step_id IS NOT NULL;
ALTER TABLE task_history ADD COLUMN step_id uuid REFERENCES task_steps(id);
ALTER TABLE task_history ADD COLUMN step_change jsonb;
