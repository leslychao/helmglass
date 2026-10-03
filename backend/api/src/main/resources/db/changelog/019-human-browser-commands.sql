CREATE TABLE human_browser_commands (
  id uuid PRIMARY KEY REFERENCES operations,
  user_id uuid NOT NULL REFERENCES application_users,
  session_id uuid NOT NULL,
  login_id uuid NOT NULL REFERENCES application_logins,
  controller_instance_id uuid NOT NULL,
  attempt_id uuid NOT NULL UNIQUE,
  action jsonb NOT NULL,
  action_digest varchar(64) NOT NULL,
  scope jsonb NOT NULL,
  execution_mode varchar(20) NOT NULL CHECK(execution_mode IN ('HUMAN','HUMAN_PRIVATE')),
  state varchar(20) NOT NULL DEFAULT 'ACCEPTED'
    CHECK(state IN ('ACCEPTED','STARTED','SUCCEEDED','FAILED','UNKNOWN')),
  permit_id uuid UNIQUE,
  deadline timestamptz NOT NULL,
  result_digest varchar(64),
  effect_state varchar(20) CHECK(effect_state IN ('NOT_STARTED','CONFIRMED','UNKNOWN')),
  failure_code varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY(user_id,session_id) REFERENCES browser_sessions(user_id,id),
  CHECK(state<>'STARTED' OR permit_id IS NOT NULL)
);
CREATE UNIQUE INDEX browser_one_pending_navigation ON human_browser_commands(session_id)
  WHERE state IN ('ACCEPTED','STARTED');
CREATE INDEX browser_navigation_due ON human_browser_commands(state,deadline);
