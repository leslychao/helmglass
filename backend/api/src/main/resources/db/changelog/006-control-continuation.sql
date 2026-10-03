ALTER TABLE task_continuations ADD COLUMN claim_grant_id uuid REFERENCES client_grants;
ALTER TABLE task_continuations ADD COLUMN claim_control_epoch bigint;
ALTER TABLE browser_control_leases ADD COLUMN continuation_claim_id uuid;
ALTER TABLE browser_control_leases ADD COLUMN input_channel_id uuid;
ALTER TABLE browser_control_leases ADD COLUMN login_id uuid REFERENCES application_logins;
ALTER TABLE browser_control_leases ADD COLUMN return_intent varchar(30);
ALTER TABLE browser_control_leases ADD COLUMN prior_task_state varchar(30);
