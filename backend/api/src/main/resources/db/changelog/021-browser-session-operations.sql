CREATE TABLE browser_session_operations (
  id uuid PRIMARY KEY REFERENCES operations,
  user_id uuid NOT NULL REFERENCES application_users,
  session_id uuid NOT NULL REFERENCES browser_sessions,
  login_id uuid NOT NULL REFERENCES application_logins,
  controller_instance_id uuid NOT NULL,
  previous_operation_id uuid REFERENCES operations,
  intent varchar(20) NOT NULL CHECK (intent IN ('SAVE','CLOSE_SAVE','CLOSE_DISCARD')),
  state varchar(20) NOT NULL CHECK (state IN
    ('QUIESCING','SAVING','RESUMING','CLOSING','SUCCEEDED','FAILED','UNKNOWN')),
  control_epoch bigint NOT NULL,
  privacy_epoch bigint NOT NULL,
  allocation_epoch bigint NOT NULL,
  policy_version bigint NOT NULL,
  expected_profile_version uuid,
  transfer_id uuid REFERENCES profile_transfers,
  profile_version_id uuid REFERENCES browser_profile_versions,
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX browser_session_one_pending_operation ON browser_session_operations(session_id)
  WHERE state IN ('QUIESCING','SAVING','RESUMING','CLOSING');
CREATE INDEX browser_session_operations_pending ON browser_session_operations(updated_at)
  WHERE state IN ('QUIESCING','SAVING','RESUMING','CLOSING');

UPDATE browser_sessions s SET save_policy=CASE WHEN c.save_preference='SAVE'
  THEN 'SAVE_ON_CLOSE' ELSE 'DISCARD_CHANGES' END
  FROM connections c WHERE c.id=s.connection_id AND s.save_policy='ASK';
UPDATE browser_sessions SET save_policy='DISCARD_CHANGES' WHERE save_policy='ASK';
ALTER TABLE browser_sessions ALTER COLUMN save_policy SET DEFAULT 'DISCARD_CHANGES';
ALTER TABLE browser_sessions ADD CONSTRAINT browser_session_save_policy
  CHECK (save_policy IN ('SAVE_ON_CLOSE','DISCARD_CHANGES'));
