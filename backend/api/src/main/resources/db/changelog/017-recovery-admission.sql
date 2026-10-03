CREATE TABLE recovery_runs (
  id uuid PRIMARY KEY,
  backup_id varchar(200) NOT NULL,
  restore_point varchar(500) NOT NULL,
  wal_loss_window varchar(1000) NOT NULL,
  proof_hash varchar(64) NOT NULL,
  ledger_manifest_hash varchar(64) NOT NULL,
  state varchar(20) NOT NULL CHECK(state IN ('FENCING','LEDGER','PURGING','READY')),
  fencing_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE platform_settings ADD COLUMN recovery_state varchar(20) NOT NULL DEFAULT 'NORMAL'
  CHECK(recovery_state IN ('NORMAL','REQUIRED','RECOVERING','READY'));
ALTER TABLE platform_settings ADD COLUMN recovery_id uuid REFERENCES recovery_runs;
ALTER TABLE platform_settings ADD COLUMN recovery_previous_accepting boolean;
ALTER TABLE application_users ADD COLUMN recovery_fence_id uuid REFERENCES recovery_runs;
ALTER TABLE account_deletion_requests ADD COLUMN recovery_id uuid REFERENCES recovery_runs;
