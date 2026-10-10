ALTER TABLE browser_sessions
  ADD COLUMN idle_timeout_seconds integer NOT NULL DEFAULT 300 CHECK (idle_timeout_seconds IN (300,900)),
  ADD COLUMN idle_warning_at timestamptz,
  ADD COLUMN control_deadline_at timestamptz,
  ADD COLUMN control_next_check_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN start_deadline_at timestamptz,
  ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN cleanup_state varchar(24) NOT NULL DEFAULT 'NONE'
    CHECK (cleanup_state IN ('NONE','PENDING','RUNNING','FAILED','COMPLETE')),
  ADD COLUMN cleanup_error varchar(120),
  ADD COLUMN cleanup_attempts integer NOT NULL DEFAULT 0;

UPDATE browser_sessions SET
  idle_timeout_seconds=CASE WHEN control_owner='USER' THEN 900 ELSE 300 END,
  idle_close_at=now()+CASE WHEN control_owner='USER' THEN interval '15 minutes' ELSE interval '5 minutes' END,
  idle_warning_at=now()+CASE WHEN control_owner='USER' THEN interval '10 minutes' ELSE interval '4 minutes' END
WHERE status='LIVE' AND NOT close_requested;
UPDATE browser_sessions SET control_deadline_at=now()+interval '6 minutes'
WHERE pending_control IS NOT NULL;
UPDATE browser_sessions SET start_deadline_at=now()+interval '6 minutes'
WHERE status IN ('STARTING','UNREACHABLE');

ALTER TABLE operations ADD COLUMN deadline_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now();
UPDATE operations SET deadline_at=coalesce(dispatched_at,now())+
  CASE WHEN type IN ('captureAudio','applyConnection')
    THEN interval '6 minutes' ELSE interval '90 seconds' END
WHERE status='DISPATCHED';
CREATE INDEX operations_reconciliation ON operations(next_check_at)
  WHERE status IN ('DISPATCHED','UNKNOWN');
CREATE INDEX browser_sessions_reconciliation ON browser_sessions(next_check_at)
  WHERE status<>'CLOSED' OR cleanup_state IN ('PENDING','RUNNING');
ALTER TABLE browser_page_visits ADD COLUMN activity_sequence bigint NOT NULL DEFAULT 0;
