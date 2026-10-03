ALTER TABLE chat_view_slots
  ADD COLUMN grant_id uuid REFERENCES client_grants,
  ADD COLUMN grant_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN access_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN viewer_lease_expires_at timestamptz,
  ADD COLUMN viewer_authorization_expires_at timestamptz,
  ADD COLUMN events_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN browser_session_id uuid REFERENCES browser_sessions,
  ADD COLUMN worker_id uuid REFERENCES browser_workers,
  ADD COLUMN worker_boot_id uuid,
  ADD COLUMN allocation_epoch bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT chat_view_slot_positive_versions CHECK (
    presentation_revision > 0 AND view_generation > 0 AND grant_version >= 0
    AND access_epoch >= 0 AND allocation_epoch >= 0);

-- Historical scope/revision and mount references remain invalid after Redis loss or an API restart.
-- No legacy row has a verified host contract. Preserve its high-water mark, but retire authority.
UPDATE chat_view_slots SET retired_at=coalesce(retired_at,now()),
  active_viewer_instance_id=NULL,transfer_state='RETIRED';

CREATE TABLE chat_view_instances (
  view_scope_id uuid NOT NULL REFERENCES chat_view_slots,
  viewer_instance_id uuid NOT NULL,
  presentation_revision bigint NOT NULL CHECK (presentation_revision > 0),
  view_generation bigint NOT NULL CHECK (view_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (view_scope_id,viewer_instance_id)
);

CREATE INDEX chat_view_lease_expiry ON chat_view_slots(viewer_lease_expires_at,id)
  WHERE active_viewer_instance_id IS NOT NULL AND retired_at IS NULL;
CREATE INDEX chat_view_fence_outbox ON transactional_outbox(retry_at,id)
  WHERE event_type='viewer.fence' AND published_at IS NULL;
