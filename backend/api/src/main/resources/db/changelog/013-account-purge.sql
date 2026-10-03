ALTER TABLE application_users ADD COLUMN identity_hash varchar(64);
UPDATE application_users SET identity_hash=encode(sha256(convert_to(issuer||E'\n'||subject,'UTF8')),'hex');
ALTER TABLE application_users ALTER COLUMN identity_hash SET NOT NULL;
ALTER TABLE application_users ADD CONSTRAINT user_identity_hash UNIQUE(identity_hash);
CREATE TABLE account_identity_jobs (
  user_id uuid PRIMARY KEY REFERENCES application_users,
  operation_id uuid NOT NULL REFERENCES operations,
  desired_version bigint NOT NULL,
  completed_version bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failure_code varchar(80)
);
ALTER TABLE account_deletion_requests ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE account_deletion_requests ADD COLUMN purge_started_at timestamptz;
ALTER TABLE account_deletion_requests ADD COLUMN ledger_checksum varchar(64);
ALTER TABLE account_deletion_requests ADD COLUMN finished_at timestamptz;
CREATE INDEX account_deletion_due ON account_deletion_requests(next_attempt_at,restore_until)
  WHERE status IN ('REQUESTED','PURGING');
