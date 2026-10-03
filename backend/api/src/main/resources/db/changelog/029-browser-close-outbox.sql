ALTER TABLE transactional_outbox
  ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0 CHECK(delivery_attempts>=0),
  ADD COLUMN last_failure_code varchar(80);

INSERT INTO transactional_outbox(id,user_id,aggregate_id,aggregate_version,event_type,payload,
  delivery_attempts,retry_at,last_failure_code)
SELECT gen_random_uuid(),user_id,id,allocation_epoch,'worker.close',
  jsonb_build_object('workerId',worker_id,'workerBootId',worker_boot_id,
    'browserSessionId',id,'allocationEpoch',allocation_epoch),
  close_attempts,next_close_at,CASE WHEN close_attempts>0 THEN 'CLOSE_ACK_PENDING' END
FROM browser_sessions WHERE binding_released_at IS NULL AND state IN ('STOPPING','LOST')
ON CONFLICT(aggregate_id,aggregate_version,event_type,ordinal) DO NOTHING;

CREATE INDEX worker_close_outbox_due ON transactional_outbox(retry_at,id)
  WHERE event_type='worker.close' AND published_at IS NULL AND delivery_attempts<8;
ALTER TABLE browser_sessions DROP COLUMN close_attempts, DROP COLUMN next_close_at;
