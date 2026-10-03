-- Retire only unfinished backup-ledger work. Completed operation receipts and old
-- recovery metadata remain historical records; application data is not removed.
WITH retired AS (
  DELETE FROM operation_items i
  USING operations o
  WHERE i.operation_id=o.id AND o.kind='ACCOUNT_PURGE'
    AND i.phase='01_LEDGER' AND i.state<>'SUCCEEDED'
  RETURNING i.operation_id
), resumed AS (
  UPDATE operations o SET state='RUNNING',attempts=0,failure_code=NULL,
    updated_at=now(),version=version+1
  WHERE o.id IN (SELECT operation_id FROM retired)
    AND o.state IN ('PENDING','RUNNING','NEEDS_ATTENTION')
  RETURNING o.id
)
UPDATE account_deletion_requests SET next_attempt_at=now()
WHERE status='PURGING' AND purge_operation_id IN (SELECT id FROM resumed);
