ALTER TABLE browser_page_visits DROP CONSTRAINT browser_page_visits_session_id_fkey;
ALTER TABLE browser_page_visits ADD CONSTRAINT browser_page_visits_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES browser_sessions(id) ON DELETE CASCADE;
