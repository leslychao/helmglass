ALTER TABLE connections
  ADD COLUMN cookie_usable_count integer,
  ADD COLUMN cookie_checked_at timestamptz,
  ADD CONSTRAINT connections_cookie_check_valid CHECK (
    (cookie_usable_count IS NULL AND cookie_checked_at IS NULL)
    OR (cookie_usable_count IS NOT NULL AND cookie_checked_at IS NOT NULL
      AND cookie_usable_count BETWEEN 0 AND 10000)
  );
