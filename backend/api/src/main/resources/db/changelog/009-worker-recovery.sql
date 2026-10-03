ALTER TABLE browser_allocations ADD COLUMN assignment jsonb;
ALTER TABLE browser_allocations ADD COLUMN assignment_digest varchar(64);
ALTER TABLE browser_allocations ADD COLUMN start_permit_expires_at timestamptz;
ALTER TABLE browser_allocations ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE browser_allocations ADD COLUMN next_dispatch_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE browser_sessions ADD COLUMN runtime_generation uuid;
ALTER TABLE browser_sessions ADD COLUMN recovery_started_at timestamptz;
ALTER TABLE browser_sessions ADD COLUMN recovery_control_pending boolean NOT NULL DEFAULT false;
ALTER TABLE browser_sessions ADD COLUMN recovery_mode varchar(20);
ALTER TABLE browser_sessions ADD COLUMN close_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE browser_sessions ADD COLUMN next_close_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE browser_workers ADD COLUMN inventory_reconciled_at timestamptz;
ALTER TABLE task_commands ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE task_commands ADD COLUMN next_delivery_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX worker_assignment_delivery_due ON browser_allocations(next_dispatch_at)
  WHERE assignment IS NOT NULL AND state IN ('RESERVED','ASSIGNED');
CREATE INDEX worker_recovery_due ON browser_sessions(recovery_started_at)
  WHERE binding_released_at IS NULL;
