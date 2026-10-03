ALTER TABLE browser_profile_versions ALTER COLUMN checksum DROP NOT NULL;
ALTER TABLE browser_profile_versions ADD COLUMN size bigint;
ALTER TABLE browser_profile_versions ADD CONSTRAINT profile_ready_integrity
  CHECK (state <> 'READY' OR (checksum IS NOT NULL AND size IS NOT NULL
    AND checksum ~ '^[a-f0-9]{64}$' AND size BETWEEN 33 AND 33554464));
ALTER TABLE browser_profile_versions ADD CONSTRAINT profile_version_owner UNIQUE (profile_id,id);
ALTER TABLE browser_profiles DROP CONSTRAINT profile_current_version;
ALTER TABLE browser_profiles ADD CONSTRAINT profile_current_version
  FOREIGN KEY (id,current_version_id) REFERENCES browser_profile_versions(profile_id,id);
CREATE TABLE profile_transfers (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES browser_profile_versions,
  user_id uuid NOT NULL REFERENCES application_users,
  connection_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES browser_sessions,
  worker_id uuid NOT NULL,
  boot_id uuid NOT NULL,
  allocation_epoch bigint NOT NULL,
  privacy_epoch bigint NOT NULL,
  control_epoch bigint NOT NULL,
  policy_version bigint NOT NULL,
  scope_version bigint NOT NULL,
  expected_profile_version bigint NOT NULL,
  direction varchar(4) NOT NULL CHECK (direction IN ('SAVE','LOAD')),
  token_hash varchar(64) NOT NULL,
  state varchar(12) NOT NULL DEFAULT 'ISSUED'
    CHECK (state IN ('ISSUED','UPLOADING','READY','REVOKED')),
  checksum varchar(64),
  size bigint,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,connection_id) REFERENCES connections(user_id,id)
);
CREATE INDEX profile_transfer_expiry ON profile_transfers (expires_at)
  WHERE state IN ('ISSUED','UPLOADING');
