ALTER TABLE browser_sessions
  ADD COLUMN activity_input_epoch bigint NOT NULL DEFAULT 0 CHECK (activity_input_epoch >= 0),
  ADD COLUMN activity_input_sequence bigint NOT NULL DEFAULT 0 CHECK (activity_input_sequence >= 0);
