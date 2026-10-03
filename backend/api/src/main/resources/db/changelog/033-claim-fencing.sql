ALTER TABLE browser_control_leases
  ADD COLUMN claim_fence_id uuid,
  ADD COLUMN claim_fence_epoch bigint,
  ADD CONSTRAINT claim_fence_binding CHECK (
    (claim_fence_id IS NULL AND claim_fence_epoch IS NULL)
    OR (claim_fence_id IS NOT NULL AND claim_fence_epoch IS NOT NULL AND claim_fence_epoch > 0));

ALTER TABLE task_continuations ADD COLUMN claim_expires_at timestamptz;
UPDATE task_continuations SET claim_expires_at=expires_at WHERE claim_id IS NOT NULL;

ALTER TABLE operations ALTER COLUMN kind TYPE varchar(128);
