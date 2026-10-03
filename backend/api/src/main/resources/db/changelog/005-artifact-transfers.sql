CREATE TABLE artifact_transfers (
  id uuid PRIMARY KEY, artifact_id uuid NOT NULL UNIQUE REFERENCES task_artifacts,
  attempt_id uuid NOT NULL UNIQUE REFERENCES command_attempts,
  command_id uuid NOT NULL REFERENCES task_commands,
  session_id uuid NOT NULL REFERENCES browser_sessions,
  user_id uuid NOT NULL REFERENCES application_users,
  worker_id uuid NOT NULL REFERENCES browser_workers, boot_id uuid NOT NULL,
  allocation_epoch bigint NOT NULL, page_epoch bigint NOT NULL, privacy_epoch bigint NOT NULL,
  control_epoch bigint NOT NULL, policy_version bigint NOT NULL,
  metadata_hash varchar(64) NOT NULL, token_hash varchar(64) NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'ISSUED'
    CHECK(state IN ('ISSUED','UPLOADING','VERIFYING','READY','REVOKED')),
  upload_lease_id uuid, upload_lease_until timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifact_transfer_expiry ON artifact_transfers(expires_at)
  WHERE state NOT IN ('READY','REVOKED');
ALTER TABLE task_artifacts ADD CONSTRAINT artifact_ready_integrity
  CHECK(state<>'READY' OR (checksum IS NOT NULL AND checksum ~ '^[a-f0-9]{64}$'
    AND size>0 AND ready_at IS NOT NULL));
