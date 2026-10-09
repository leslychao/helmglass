CREATE TABLE browser_page_visits (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES browser_sessions(id),
  viewer_id uuid NOT NULL,
  control_epoch bigint,
  expires_at timestamptz NOT NULL,
  leaving boolean NOT NULL DEFAULT false
);
CREATE INDEX browser_page_visits_session ON browser_page_visits(session_id);
CREATE INDEX browser_page_visits_expiry ON browser_page_visits(expires_at);
