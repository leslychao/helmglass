ALTER TABLE browser_sessions
  ADD COLUMN profile_checkpoint_at timestamptz NOT NULL DEFAULT now();
