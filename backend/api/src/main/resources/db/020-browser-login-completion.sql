ALTER TABLE browser_sessions ADD COLUMN login_completed boolean NOT NULL DEFAULT false;
UPDATE browser_sessions SET login_completed = login_confirmed;
