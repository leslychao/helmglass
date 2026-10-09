ALTER TABLE browser_sessions
  DROP COLUMN profile_checkpoint_at,
  ADD COLUMN close_profile_attempted boolean NOT NULL DEFAULT false;
