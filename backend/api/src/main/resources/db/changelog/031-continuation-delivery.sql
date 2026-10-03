ALTER TABLE tasks
  ADD COLUMN continuation_view_scope_id uuid REFERENCES chat_view_slots,
  ADD COLUMN continuation_binding_version bigint NOT NULL DEFAULT 1;

ALTER TABLE task_continuations
  ADD COLUMN destination_client_id varchar(200),
  ADD COLUMN destination_grant_id uuid REFERENCES client_grants,
  ADD COLUMN destination_grant_version bigint,
  ADD COLUMN destination_access_epoch bigint,
  ADD COLUMN control_epoch bigint,
  ADD COLUMN page_epoch bigint,
  ADD COLUMN ready_at timestamptz,
  ADD COLUMN dispatch_not_before timestamptz,
  ADD COLUMN block_reason varchar(80),
  ADD COLUMN dispatch_id uuid UNIQUE,
  ADD COLUMN dispatch_viewer_instance_id uuid,
  ADD COLUMN dispatch_presentation_revision bigint,
  ADD COLUMN dispatch_text varchar(2048),
  ADD COLUMN dispatch_expires_at timestamptz,
  ADD COLUMN delivery_outcome varchar(20),
  ADD COLUMN delivered_at timestamptz,
  ADD CONSTRAINT continuation_delivery_outcome CHECK (
    delivery_outcome IS NULL OR delivery_outcome IN ('DELIVERED','UNKNOWN','REJECTED'));

-- Existing MANUAL intents retain their identity, receipts and deadline.
UPDATE task_continuations SET ready_at=created_at,dispatch_not_before=created_at
  WHERE state IN ('READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED','CONSUMED');
DROP INDEX one_current_continuation;
CREATE UNIQUE INDEX one_current_continuation ON task_continuations(task_id)
  WHERE state IN ('WAITING_RESULT','READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED','BLOCKED');
CREATE INDEX continuation_expiry ON task_continuations(expires_at,id)
  WHERE state IN ('WAITING_RESULT','READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED','BLOCKED');
