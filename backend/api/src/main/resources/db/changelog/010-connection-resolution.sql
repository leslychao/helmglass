ALTER TABLE user_action_requests ADD COLUMN context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE user_action_requests ADD CONSTRAINT action_context_object CHECK(jsonb_typeof(context)='object');
ALTER TABLE connections ADD COLUMN account_evidence varchar(20) NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE connections ADD COLUMN last_user_confirmed_at timestamptz;
