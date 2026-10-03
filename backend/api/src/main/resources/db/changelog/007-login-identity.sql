ALTER TABLE connection_login_operations ADD COLUMN login_id uuid REFERENCES application_logins;
