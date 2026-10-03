CREATE INDEX command_user_accepted ON task_commands(user_id,accepted_at);
CREATE INDEX browser_user_requested ON browser_sessions(user_id,requested_at);
CREATE INDEX usage_session_metric ON usage_measurements(session_id,metric);
