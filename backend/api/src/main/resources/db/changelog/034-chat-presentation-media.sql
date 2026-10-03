ALTER TABLE chat_view_slots
  ADD COLUMN media_connected boolean NOT NULL DEFAULT false,
  ADD COLUMN media_ticket_expires_at timestamptz,
  ADD COLUMN control_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN page_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN privacy_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN media_generation bigint NOT NULL DEFAULT 0;
