CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE application_users (
  id uuid PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
  display_name varchar(200) NOT NULL, email varchar(320) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','BLOCKED','DELETING','PURGING','DELETED')),
  version bigint NOT NULL DEFAULT 1, access_epoch bigint NOT NULL DEFAULT 1,
  reauthentication_after timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), last_activity_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer,subject)
);
CREATE TABLE application_logins (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users,
  issuer text NOT NULL, sid text NOT NULL, auth_time timestamptz NOT NULL,
  admitted_access_epoch bigint NOT NULL, state varchar(16) NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, revoke_reason varchar(100), UNIQUE (issuer,sid,user_id)
);
CREATE TABLE user_policies (
  user_id uuid PRIMARY KEY REFERENCES application_users,
  version bigint NOT NULL DEFAULT 1, site_mode varchar(20) NOT NULL DEFAULT 'ALL',
  connection_mode varchar(20) NOT NULL DEFAULT 'AUTO',
  prohibited_actions jsonb NOT NULL DEFAULT '[]', confirmations jsonb NOT NULL DEFAULT '[]',
  require_confirmation boolean NOT NULL DEFAULT true, max_commands_per_run integer CHECK(max_commands_per_run>=1),
  max_active_seconds_per_run integer CHECK(max_active_seconds_per_run>=60),
  max_retained_media_bytes bigint CHECK(max_retained_media_bytes>=0),
  browser_limit integer CHECK(browser_limit >= 1), queued_limit integer CHECK(queued_limit >= 0),
  max_parallel_runs integer CHECK(max_parallel_runs >= 1),
  browser_time_limit_seconds integer NOT NULL DEFAULT 1800 CHECK(browser_time_limit_seconds BETWEEN 60 AND 86400),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_site_rules (
  user_id uuid NOT NULL REFERENCES application_users, origin text NOT NULL,
  decision varchar(10) NOT NULL CHECK(decision IN ('ALLOW','DENY')), PRIMARY KEY(user_id,origin)
);
CREATE TABLE admin_user_limits (
  user_id uuid PRIMARY KEY REFERENCES application_users, version bigint NOT NULL DEFAULT 1,
  browser_mode varchar(10) NOT NULL DEFAULT 'STANDARD' CHECK(browser_mode IN ('STANDARD','CUSTOM','POOL')),
  browser_custom integer, queued_mode varchar(10) NOT NULL DEFAULT 'UNLIMITED' CHECK(queued_mode IN ('UNLIMITED','CUSTOM')),
  queued_custom integer, updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((browser_mode='CUSTOM' AND browser_custom>=1) OR (browser_mode<>'CUSTOM' AND browser_custom IS NULL)),
  CHECK((queued_mode='CUSTOM' AND queued_custom>=0) OR (queued_mode<>'CUSTOM' AND queued_custom IS NULL))
);
CREATE TABLE platform_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version bigint NOT NULL DEFAULT 1,
  accepting_allocations boolean NOT NULL DEFAULT true, standard_browser_limit integer NOT NULL DEFAULT 2 CHECK(standard_browser_limit>=1),
  allocator_state varchar(20) NOT NULL DEFAULT 'READY', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings(singleton) VALUES(true);
CREATE TABLE sites (
  id uuid PRIMARY KEY, normalized_host text NOT NULL UNIQUE, display_name text NOT NULL,
  version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_sites (
  user_id uuid NOT NULL REFERENCES application_users, site_id uuid NOT NULL REFERENCES sites,
  scope varchar(20) NOT NULL, last_used_at timestamptz, last_selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,site_id,scope)
);
CREATE SEQUENCE task_display_number START 1001;
CREATE TABLE tasks (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users,
  display_number bigint NOT NULL DEFAULT nextval('task_display_number') UNIQUE,
  version bigint NOT NULL DEFAULT 1, instruction_revision bigint NOT NULL DEFAULT 1,
  goal varchar(16000) NOT NULL, title varchar(200) NOT NULL, start_url varchar(2048),
  start_site_id uuid REFERENCES sites, output_format varchar(10) NOT NULL CHECK(output_format IN ('TABLE','FILE','TEXT')),
  confirm_important_actions boolean NOT NULL DEFAULT true,
  browser_time_limit_seconds integer NOT NULL DEFAULT 1800 CHECK(browser_time_limit_seconds BETWEEN 60 AND 86400),
  origin varchar(10) NOT NULL CHECK(origin IN ('ANGULAR','MCP')),
  state varchar(20) NOT NULL CHECK(state IN ('DRAFT','WAITING_AGENT','QUEUED','STARTING','RUNNING','PAUSING','PAUSED','WAITING_USER','STOPPING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  outcome varchar(20), wait_reason varchar(80), failure_code varchar(80),
  mutation_barrier boolean NOT NULL DEFAULT false, stop_epoch bigint NOT NULL DEFAULT 0,
  continuation_preference varchar(20) NOT NULL DEFAULT 'MANUAL', continuation_consent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  prepared_at timestamptz, started_at timestamptz, ended_at timestamptz,
  UNIQUE(user_id,id),
  CHECK((state='COMPLETED' AND outcome IN ('SUCCESS','PARTIAL','NOT_ACHIEVED')) OR (state<>'COMPLETED' AND outcome IS NULL))
);
CREATE INDEX task_owner_order ON tasks(user_id,updated_at DESC,id DESC);
CREATE INDEX task_owner_state ON tasks(user_id,state,created_at,id);
CREATE INDEX task_search ON tasks USING gin(lower(goal) gin_trgm_ops);
CREATE TABLE task_clarifications (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, user_id uuid NOT NULL,
  revision bigint NOT NULL, text varchar(4096) NOT NULL, after_command_id uuid,
  disposition varchar(40) NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,revision), FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id)
);
CREATE TABLE connections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users,
  site_id uuid NOT NULL REFERENCES sites, display_name varchar(200) NOT NULL,
  start_url varchar(2048) NOT NULL, origin text NOT NULL, account_label varchar(200),
  status varchar(30) NOT NULL DEFAULT 'NOT_AUTHENTICATED', save_preference varchar(20) NOT NULL DEFAULT 'ASK',
  scope_version bigint NOT NULL DEFAULT 1, version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  last_successful_login_at timestamptz, last_checked_at timestamptz, last_used_at timestamptz,
  last_selected_at timestamptz, UNIQUE(user_id,id)
);
CREATE INDEX connection_owner_order ON connections(user_id,status,updated_at DESC,id);
CREATE TABLE site_origins (
  site_id uuid NOT NULL REFERENCES sites, origin text NOT NULL, role varchar(10) NOT NULL CHECK(role IN ('APP','AUTH_ONLY')),
  version bigint NOT NULL DEFAULT 1, status varchar(10) NOT NULL DEFAULT 'ACTIVE', evidence_source text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(site_id,origin)
);
CREATE UNIQUE INDEX site_app_origin ON site_origins(origin) WHERE role='APP' AND status='ACTIVE';
CREATE TABLE connection_origins (
  id uuid PRIMARY KEY, connection_id uuid NOT NULL, user_id uuid NOT NULL,
  origin text NOT NULL, role varchar(10) NOT NULL, status varchar(10) NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1, admitted_scope_version bigint NOT NULL,
  confirmation_source varchar(40) NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,origin), FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id)
);
CREATE TABLE task_connections (
  task_id uuid NOT NULL, connection_id uuid NOT NULL, user_id uuid NOT NULL, site_id uuid NOT NULL REFERENCES sites,
  preference_rank integer, selected boolean NOT NULL DEFAULT false, selection_reason varchar(40),
  version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), selected_at timestamptz,
  PRIMARY KEY(task_id,connection_id), UNIQUE(task_id,preference_rank),
  FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id),
  FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id)
);
CREATE UNIQUE INDEX task_selected_site ON task_connections(task_id,site_id) WHERE selected;
CREATE TABLE client_grants (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users, client_id varchar(200) NOT NULL,
  sid text NOT NULL, scopes jsonb NOT NULL, status varchar(20) NOT NULL DEFAULT 'ACTIVE', version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE(user_id,client_id,sid)
);
CREATE TABLE browser_workers (
  id uuid PRIMARY KEY, boot_id uuid NOT NULL, capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 16),
  version bigint NOT NULL DEFAULT 1, desired_mode varchar(20) NOT NULL DEFAULT 'ENABLED',
  observed_state varchar(20) NOT NULL DEFAULT 'REGISTERING', image_version varchar(200) NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(), registered_at timestamptz NOT NULL DEFAULT now(), inventory_digest varchar(64)
);
CREATE TABLE browser_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users, task_id uuid,
  connection_id uuid, worker_id uuid REFERENCES browser_workers, worker_boot_id uuid,
  purpose varchar(10) NOT NULL, state varchar(20) NOT NULL DEFAULT 'REQUESTED',
  privacy varchar(20) NOT NULL DEFAULT 'NORMAL', save_policy varchar(20) NOT NULL DEFAULT 'ASK',
  version bigint NOT NULL DEFAULT 1, page_epoch bigint NOT NULL DEFAULT 1,
  privacy_epoch bigint NOT NULL DEFAULT 1, allocation_epoch bigint NOT NULL DEFAULT 1,
  close_reason varchar(80), requested_at timestamptz NOT NULL DEFAULT now(), ready_at timestamptz,
  closed_at timestamptz, binding_released_at timestamptz, last_activity_at timestamptz NOT NULL DEFAULT now(),
  idle_deadline_at timestamptz NOT NULL, budget_deadline_at timestamptz NOT NULL,
  UNIQUE(user_id,id), CHECK((purpose='TASK')=(task_id IS NOT NULL)),
  FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id),
  FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id)
);
CREATE UNIQUE INDEX task_one_unreleased_browser_binding ON browser_sessions(task_id) WHERE purpose='TASK' AND binding_released_at IS NULL;
CREATE TABLE browser_allocations (
  id uuid PRIMARY KEY, session_id uuid NOT NULL UNIQUE REFERENCES browser_sessions,
  user_id uuid NOT NULL REFERENCES application_users, worker_id uuid NOT NULL REFERENCES browser_workers,
  connection_id uuid REFERENCES connections, slot_index integer NOT NULL,
  allocation_epoch bigint NOT NULL, state varchar(20) NOT NULL DEFAULT 'RESERVED',
  start_permit_id uuid, version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE UNIQUE INDEX browser_one_unresolved_slot ON browser_allocations(worker_id,slot_index) WHERE state IN ('RESERVED','ASSIGNED','RELEASING','QUARANTINED');
CREATE UNIQUE INDEX connection_one_unresolved_allocation ON browser_allocations(connection_id) WHERE connection_id IS NOT NULL AND state IN ('RESERVED','ASSIGNED','RELEASING','QUARANTINED');
CREATE TABLE browser_control_leases (
  session_id uuid PRIMARY KEY REFERENCES browser_sessions, epoch bigint NOT NULL DEFAULT 1,
  owner_kind varchar(10) NOT NULL DEFAULT 'AGENT', owner_id uuid NOT NULL,
  controller_instance_id uuid, state varchar(20) NOT NULL DEFAULT 'ACTIVE', desired_owner varchar(10),
  privacy_epoch bigint NOT NULL DEFAULT 1, operation_id uuid, version bigint NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE task_commands (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, user_id uuid NOT NULL, client_grant_id uuid REFERENCES client_grants,
  command_sequence bigint NOT NULL, kind varchar(40) NOT NULL, command_category varchar(20) NOT NULL DEFAULT 'BROWSER',
  payload jsonb NOT NULL, payload_hash varchar(64) NOT NULL, accepted_task_version bigint NOT NULL,
  instruction_revision bigint NOT NULL, expected_session_id uuid REFERENCES browser_sessions,
  control_epoch bigint, page_epoch bigint, privacy_epoch bigint, observation_id uuid,
  retry_safety varchar(20) NOT NULL DEFAULT 'UNSAFE', deadline timestamptz NOT NULL,
  state varchar(30) NOT NULL DEFAULT 'ACCEPTED', version bigint NOT NULL DEFAULT 1,
  accepted_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, started_at timestamptz,
  finished_at timestamptz, cancel_requested_at timestamptz, next_eligible_at timestamptz NOT NULL DEFAULT now(),
  failure_code varchar(80), UNIQUE(task_id,command_sequence),
  FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id)
);
CREATE UNIQUE INDEX task_one_outstanding_browser_command ON task_commands(task_id) WHERE command_category='BROWSER' AND state IN ('ACCEPTED','WAITING_RESOURCE','DISPATCHED','STARTED');
CREATE INDEX command_due ON task_commands(state,next_eligible_at,id);
CREATE TABLE command_attempts (
  id uuid PRIMARY KEY, command_id uuid NOT NULL REFERENCES task_commands,
  session_id uuid NOT NULL REFERENCES browser_sessions, worker_id uuid NOT NULL REFERENCES browser_workers,
  attempt_no integer NOT NULL, assignment_epoch bigint NOT NULL, control_epoch bigint NOT NULL,
  effect_state varchar(20) NOT NULL DEFAULT 'NOT_STARTED', state varchar(20) NOT NULL DEFAULT 'DISPATCHED',
  result_digest varchar(64), result jsonb, start_permit_id uuid UNIQUE, version bigint NOT NULL DEFAULT 1,
  payload_schema_version integer NOT NULL DEFAULT 1, started_at timestamptz, finished_at timestamptz,
  last_report_at timestamptz NOT NULL DEFAULT now(), UNIQUE(command_id,attempt_no)
);
CREATE TABLE operations (
  id uuid PRIMARY KEY, user_id uuid REFERENCES application_users,
  kind varchar(60) NOT NULL, target_type varchar(40) NOT NULL, target_id uuid NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'PENDING', version bigint NOT NULL DEFAULT 1,
  request_id uuid NOT NULL, input_hash varchar(64), progress integer NOT NULL DEFAULT 0,
  failure_code varchar(80), source_command_id uuid REFERENCES task_commands,
  source_human_operation_id uuid REFERENCES operations, reconciliation_outcome varchar(20), evidence jsonb,
  human_checkpoint varchar(10), input_accepted_sequence bigint, input_applied_sequence bigint,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX operation_due ON operations(state,next_attempt_at);
CREATE UNIQUE INDEX reconcile_command ON operations(source_command_id) WHERE kind='RECONCILE_EFFECT';
CREATE UNIQUE INDEX reconcile_human ON operations(source_human_operation_id) WHERE kind='RECONCILE_EFFECT';
CREATE TABLE operation_items (
  operation_id uuid NOT NULL REFERENCES operations, item_key varchar(200) NOT NULL,
  target_id uuid, phase varchar(40) NOT NULL, state varchar(20) NOT NULL DEFAULT 'PENDING',
  external_receipt jsonb, version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(operation_id,item_key)
);
CREATE TABLE idempotency_records (
  user_id uuid NOT NULL REFERENCES application_users, client_id varchar(200) NOT NULL,
  operation_kind varchar(100) NOT NULL, key varchar(200) NOT NULL,
  payload_hash varchar(64) NOT NULL, operation_id uuid NOT NULL REFERENCES operations,
  response jsonb NOT NULL, http_status integer NOT NULL, schema_version integer NOT NULL DEFAULT 1,
  accepted_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  PRIMARY KEY(user_id,client_id,operation_kind,key)
);
CREATE TABLE task_event_counters (
  task_id uuid PRIMARY KEY REFERENCES tasks, next_sequence bigint NOT NULL DEFAULT 1,
  event_count bigint NOT NULL DEFAULT 0, confirmed_step_count bigint NOT NULL DEFAULT 0
);
CREATE TABLE task_execution_events (
  task_id uuid NOT NULL REFERENCES tasks, sequence bigint NOT NULL, event_id uuid NOT NULL UNIQUE,
  type varchar(30) NOT NULL, code varchar(80) NOT NULL, summary varchar(500) NOT NULL,
  command_id uuid, session_id uuid, schema_version integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now(), recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,sequence)
);
CREATE TABLE user_action_requests (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks, command_id uuid REFERENCES task_commands,
  connection_id uuid REFERENCES connections, kind varchar(30) NOT NULL,
  intent_hash varchar(64) NOT NULL, prompt varchar(4096) NOT NULL, answer jsonb,
  version bigint NOT NULL DEFAULT 1, status varchar(20) NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, resolved_at timestamptz
);
CREATE TABLE task_results (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks, revision bigint NOT NULL,
  final boolean NOT NULL DEFAULT false, conclusion varchar(16000) NOT NULL,
  limitations jsonb NOT NULL DEFAULT '[]', missing jsonb NOT NULL DEFAULT '[]', columns jsonb NOT NULL DEFAULT '[]',
  coverage jsonb NOT NULL DEFAULT '{}', schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,revision)
);
CREATE UNIQUE INDEX one_final_result ON task_results(task_id) WHERE final;
CREATE TABLE task_result_rows (
  result_id uuid NOT NULL REFERENCES task_results, row_id uuid NOT NULL,
  row_order bigint NOT NULL, data jsonb NOT NULL, search_text text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(result_id,row_id), UNIQUE(result_id,row_order)
);
CREATE TABLE task_artifacts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users, task_id uuid,
  result_id uuid REFERENCES task_results, parent_artifact_id uuid REFERENCES task_artifacts,
  purpose varchar(30) NOT NULL, bucket text NOT NULL, object_key text NOT NULL,
  mime varchar(200) NOT NULL, size bigint NOT NULL CHECK(size>=0), checksum varchar(64), filename varchar(255) NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'UPLOADING', version bigint NOT NULL DEFAULT 1,
  upload_id text, provenance jsonb NOT NULL DEFAULT '{}', coverage jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), ready_at timestamptz, deleted_at timestamptz,
  UNIQUE(bucket,object_key), FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id)
);
CREATE TABLE upload_parts (
  artifact_id uuid NOT NULL REFERENCES task_artifacts, part_number integer NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  checksum varchar(64) NOT NULL, size bigint NOT NULL CHECK(size>0), state varchar(20) NOT NULL,
  etag text, PRIMARY KEY(artifact_id,part_number)
);
CREATE TABLE browser_profiles (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, connection_id uuid NOT NULL UNIQUE,
  current_version_id uuid, format_version integer NOT NULL DEFAULT 1,
  version bigint NOT NULL DEFAULT 1, state varchar(20) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,id), FOREIGN KEY(user_id,connection_id) REFERENCES connections(user_id,id)
);
CREATE TABLE browser_profile_versions (
  id uuid PRIMARY KEY, profile_id uuid NOT NULL REFERENCES browser_profiles,
  revision bigint NOT NULL, object_key text NOT NULL, checksum varchar(64) NOT NULL,
  wrapped_dek text NOT NULL, vault_key_ref text NOT NULL, runtime_version varchar(200) NOT NULL,
  origins_manifest jsonb NOT NULL, state varchar(20) NOT NULL DEFAULT 'STAGED',
  version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(profile_id,revision)
);
ALTER TABLE browser_profiles ADD CONSTRAINT profile_current_version FOREIGN KEY(current_version_id) REFERENCES browser_profile_versions;
CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY, sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_id uuid NOT NULL, actor_name varchar(200) NOT NULL, actor_email varchar(320) NOT NULL,
  target_id uuid NOT NULL, target_type varchar(40) NOT NULL, target_user_id uuid,
  action varchar(80) NOT NULL, reason varchar(1000) NOT NULL,
  previous_value jsonb NOT NULL, new_value jsonb NOT NULL,
  operation_id uuid NOT NULL, request_id uuid NOT NULL, schema_version integer NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_owner_order ON admin_audit_log(target_user_id,occurred_at DESC,id);
CREATE TABLE account_deletion_requests (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users,
  previous_account_state varchar(20) NOT NULL, status varchar(20) NOT NULL DEFAULT 'REQUESTED',
  version bigint NOT NULL DEFAULT 1, delete_requested_at timestamptz NOT NULL DEFAULT now(),
  restore_until timestamptz NOT NULL, purge_operation_id uuid REFERENCES operations,
  CHECK(restore_until=delete_requested_at+interval '168 hours')
);
CREATE UNIQUE INDEX user_one_active_deletion ON account_deletion_requests(user_id) WHERE status IN ('REQUESTED','PURGING');
CREATE TABLE usage_measurements (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users, task_id uuid REFERENCES tasks,
  session_id uuid REFERENCES browser_sessions, attempt_id uuid REFERENCES command_attempts,
  metric varchar(40) NOT NULL, value bigint CHECK(value>=0), unit varchar(20) NOT NULL,
  interval_start timestamptz NOT NULL, interval_end timestamptz NOT NULL,
  origin text, completeness varchar(10) NOT NULL CHECK(completeness IN ('COMPLETE','PARTIAL','UNKNOWN')),
  source_id uuid NOT NULL, source_sequence bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,source_sequence,metric)
);
CREATE INDEX usage_owner_time ON usage_measurements(user_id,interval_start);
CREATE TABLE task_usage_totals (
  task_id uuid PRIMARY KEY REFERENCES tasks, version bigint NOT NULL DEFAULT 1,
  totals jsonb NOT NULL DEFAULT '{}', unknown_intervals jsonb NOT NULL DEFAULT '[]',
  coverage varchar(10) NOT NULL DEFAULT 'UNKNOWN', source_watermark bigint NOT NULL DEFAULT 0,
  calculated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users,
  task_id uuid REFERENCES tasks, source_event_id uuid NOT NULL, kind varchar(40) NOT NULL,
  version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
  UNIQUE(user_id,source_event_id)
);
CREATE TABLE list_revisions (
  scope_id uuid NOT NULL, resource varchar(60) NOT NULL, revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(scope_id,resource)
);
CREATE TABLE transactional_outbox (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users,
  aggregate_id uuid NOT NULL, aggregate_version bigint NOT NULL, event_type varchar(60) NOT NULL,
  ordinal integer NOT NULL DEFAULT 0, payload jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, retry_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(aggregate_id,aggregate_version,event_type,ordinal)
);
CREATE INDEX unpublished_outbox ON transactional_outbox(retry_at,id) WHERE published_at IS NULL;
CREATE TABLE chat_view_slots (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES application_users,
  task_id uuid NOT NULL REFERENCES tasks, client_id varchar(200) NOT NULL, verified_correlation text NOT NULL,
  presentation_revision bigint NOT NULL DEFAULT 1, active_viewer_instance_id uuid,
  view_generation bigint NOT NULL DEFAULT 1, transfer_state varchar(20) NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
  UNIQUE(user_id,client_id,verified_correlation)
);
CREATE TABLE task_continuations (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks, user_id uuid NOT NULL REFERENCES application_users,
  source_operation_id uuid REFERENCES operations, source_command_id uuid REFERENCES task_commands,
  instruction_revision bigint NOT NULL, session_id uuid REFERENCES browser_sessions,
  reason varchar(40) NOT NULL, mode varchar(20) NOT NULL, view_scope_id uuid REFERENCES chat_view_slots,
  binding_version bigint NOT NULL, claim_client_id varchar(200), claim_id uuid,
  state varchar(30) NOT NULL DEFAULT 'READY', version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, claimed_at timestamptz,
  consumed_at timestamptz, expires_at timestamptz NOT NULL,
  CHECK((source_operation_id IS NOT NULL)<>(source_command_id IS NOT NULL))
);
CREATE UNIQUE INDEX continuation_operation ON task_continuations(task_id,source_operation_id,instruction_revision) WHERE source_operation_id IS NOT NULL;
CREATE UNIQUE INDEX continuation_command ON task_continuations(task_id,source_command_id,instruction_revision) WHERE source_command_id IS NOT NULL;
CREATE UNIQUE INDEX one_current_continuation ON task_continuations(task_id) WHERE state IN ('READY','DISPATCHING','DELIVERED','DELIVERY_UNKNOWN','CLAIMED');
