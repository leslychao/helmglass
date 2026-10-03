ALTER TABLE browser_sessions ALTER COLUMN purpose TYPE varchar(30);
ALTER TABLE browser_sessions ADD COLUMN current_url varchar(2048);
ALTER TABLE browser_sessions ADD COLUMN media_generation bigint NOT NULL DEFAULT 1;
ALTER TABLE browser_sessions ADD COLUMN profile_version_id uuid REFERENCES browser_profile_versions;
ALTER TABLE browser_sessions ADD COLUMN startup_state varchar(30) NOT NULL DEFAULT 'EMPTY';
ALTER TABLE browser_sessions ADD COLUMN viewport_width integer NOT NULL DEFAULT 1280;
ALTER TABLE browser_sessions ADD COLUMN viewport_height integer NOT NULL DEFAULT 720;
CREATE TABLE session_usage_checkpoints (
  session_id uuid PRIMARY KEY REFERENCES browser_sessions,
  worker_boot_id uuid NOT NULL, source_sequence bigint NOT NULL CHECK(source_sequence>=0),
  browser_ms bigint NOT NULL CHECK(browser_ms>=0), execution_ms bigint NOT NULL CHECK(execution_ms>=0),
  human_ms bigint NOT NULL CHECK(human_ms>=0), login_ms bigint NOT NULL CHECK(login_ms>=0),
  browser_complete boolean NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
  CHECK(execution_ms+human_ms+login_ms<=browser_ms+2)
);
CREATE TABLE connection_login_operations (
  id uuid PRIMARY KEY REFERENCES operations, connection_id uuid NOT NULL, user_id uuid NOT NULL,
  session_id uuid REFERENCES browser_sessions, task_id uuid, version bigint NOT NULL DEFAULT 1,
  kind varchar(10) NOT NULL CHECK(kind IN ('LOGIN','CHECK')),
  state varchar(30) NOT NULL DEFAULT 'WAITING_RESOURCE', controller_instance_id uuid,
  expected_origin text NOT NULL, post_login_path_prefix varchar(2048), account_evidence_text varchar(256),
  user_asserted boolean NOT NULL DEFAULT false, verification_result varchar(20), save_mode varchar(20), continuation_intent varchar(20),
  account_label varchar(200), complete_operation_id uuid REFERENCES operations, profile_version_id uuid REFERENCES browser_profile_versions,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id),
  FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id)
);
CREATE UNIQUE INDEX connection_one_active_login ON connection_login_operations(connection_id)
  WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELLED');
CREATE TABLE session_operation_commands (
  id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES connection_login_operations,
  session_id uuid NOT NULL REFERENCES browser_sessions, user_id uuid NOT NULL REFERENCES application_users,
  attempt_id uuid NOT NULL UNIQUE, action jsonb NOT NULL, action_digest varchar(64) NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'ACCEPTED', deadline timestamptz NOT NULL,
  permit_id uuid, result_digest varchar(64), effect_state varchar(20),
  started_at timestamptz, finished_at timestamptz,
  UNIQUE(operation_id,session_id)
);
