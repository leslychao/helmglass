CREATE TABLE browser_profile_startups (
  session_id uuid PRIMARY KEY REFERENCES browser_sessions,
  command_id uuid NOT NULL REFERENCES task_commands,
  profile_version_id uuid NOT NULL REFERENCES browser_profile_versions,
  state varchar(30) NOT NULL DEFAULT 'PREPARING',
  transfer_id uuid REFERENCES profile_transfers,
  navigation_id uuid NOT NULL UNIQUE,
  attempt_id uuid NOT NULL UNIQUE,
  action jsonb NOT NULL,
  action_digest varchar(64) NOT NULL,
  deadline timestamptz NOT NULL,
  permit_id uuid,
  result_digest varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state IN ('PREPARING','LOADING','NAVIGATING','STARTED','READY','FAILED'))
);
