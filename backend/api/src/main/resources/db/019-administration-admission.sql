ALTER TABLE scheduler_state
  ADD COLUMN admin_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN admin_version bigint NOT NULL DEFAULT 0;
