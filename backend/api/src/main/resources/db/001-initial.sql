CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  name varchar(300) NOT NULL,
  email varchar(320) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','DELETION_PENDING','PURGING','DELETED')),
  previous_status varchar(24),
  browser_limit_mode varchar(16) NOT NULL DEFAULT 'PLATFORM' CHECK (browser_limit_mode IN ('PLATFORM','CUSTOM','UNLIMITED')),
  browser_limit integer CHECK (browser_limit >= 1),
  waiting_limit integer CHECK (waiting_limit >= 0),
  access_epoch bigint NOT NULL DEFAULT 0,
  access_after timestamptz,
  mcp_revoked_at timestamptz,
  deletion_due_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  event_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE revoked_sessions (sid varchar(256) PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE connections (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), name varchar(200) NOT NULL,
  site varchar(253) NOT NULL, start_url varchar(4096) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'LOGIN_REQUIRED', account_subject varchar(500), account_label varchar(300),
  version bigint NOT NULL DEFAULT 1, deleted_at timestamptz, last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), title varchar(200) NOT NULL,
  goal text NOT NULL, start_url varchar(4096), site varchar(253), output_format varchar(16) NOT NULL,
  require_confirmation boolean NOT NULL DEFAULT true, preferred_connection_ids jsonb NOT NULL DEFAULT '[]',
  source varchar(8) NOT NULL CHECK (source IN ('WEB','MCP')),
  status varchar(32) NOT NULL DEFAULT 'DRAFT', outcome varchar(24), wait_reason varchar(64),
  version bigint NOT NULL DEFAULT 1, instruction_revision bigint NOT NULL DEFAULT 1,
  browser_session_id uuid, selected_connection_id uuid REFERENCES connections(id),
  accepted_at timestamptz, accepted_sequence bigint, paused_explicitly boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, result jsonb
);
CREATE INDEX tasks_owner_list ON tasks(owner_id,updated_at DESC,id);
CREATE INDEX tasks_owner_status ON tasks(owner_id,status);
CREATE TABLE browser_nodes (
  id uuid PRIMARY KEY, name varchar(200) NOT NULL, capacity integer NOT NULL CHECK (capacity >= 1),
  accepts_new boolean NOT NULL DEFAULT true, reachable boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz, version bigint NOT NULL DEFAULT 1
);
CREATE TABLE browser_sessions (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), task_id uuid REFERENCES tasks(id),
  connection_id uuid REFERENCES connections(id), node_id uuid REFERENCES browser_nodes(id),
  status varchar(24) NOT NULL DEFAULT 'QUEUED', control_owner varchar(16) NOT NULL DEFAULT 'NONE',
  control_epoch bigint NOT NULL DEFAULT 0, controller_id varchar(128), private_mode boolean NOT NULL DEFAULT false,
  current_url varchar(4096), version bigint NOT NULL DEFAULT 1, allocation_sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, closed_at timestamptz,
  last_seen_at timestamptz, close_requested boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_live_browser_per_task ON browser_sessions(task_id) WHERE status NOT IN ('CLOSED','LOST');
CREATE UNIQUE INDEX one_connection_assignment ON browser_sessions(connection_id) WHERE status NOT IN ('CLOSED','LOST') AND connection_id IS NOT NULL;
CREATE INDEX browser_owner ON browser_sessions(owner_id,status);
ALTER TABLE tasks ADD CONSTRAINT task_browser_fk FOREIGN KEY (browser_session_id) REFERENCES browser_sessions(id);
CREATE TABLE operations (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), task_id uuid NOT NULL REFERENCES tasks(id),
  session_id uuid REFERENCES browser_sessions(id), type varchar(60) NOT NULL, arguments jsonb NOT NULL,
  status varchar(24) NOT NULL, mutating boolean NOT NULL, instruction_revision bigint NOT NULL,
  control_epoch bigint, result jsonb, error_code varchar(80), error_message varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, completed_at timestamptz
);
CREATE UNIQUE INDEX one_dispatch_per_task ON operations(task_id) WHERE status = 'DISPATCHED';
CREATE INDEX operations_pending ON operations(status,created_at);
CREATE TABLE task_requests (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), owner_id uuid NOT NULL REFERENCES accounts(id),
  type varchar(40) NOT NULL, prompt text NOT NULL, options jsonb NOT NULL DEFAULT '[]',
  operation_id uuid REFERENCES operations(id), status varchar(16) NOT NULL DEFAULT 'PENDING',
  version bigint NOT NULL DEFAULT 1, answer text, created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
);
CREATE UNIQUE INDEX one_pending_request ON task_requests(task_id) WHERE status = 'PENDING';
CREATE TABLE idempotency_records (
  owner_id uuid NOT NULL REFERENCES accounts(id), key varchar(128) NOT NULL, scope varchar(200) NOT NULL,
  request_hash varchar(64) NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,key)
);
CREATE TABLE user_events (
  owner_id uuid NOT NULL REFERENCES accounts(id), sequence bigint NOT NULL, resource varchar(40) NOT NULL,
  entity_id uuid, version bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id,sequence)
);
CREATE TABLE task_history (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), owner_id uuid NOT NULL REFERENCES accounts(id),
  sequence bigint NOT NULL, type varchar(40) NOT NULL, title varchar(300) NOT NULL, detail text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,sequence)
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), sequence bigint NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id), title varchar(200) NOT NULL, status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, UNIQUE(owner_id,sequence)
);
CREATE INDEX notifications_unread ON notifications(owner_id,sequence DESC) WHERE read_at IS NULL;
CREATE TABLE usage_intervals (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), task_id uuid REFERENCES tasks(id),
  session_id uuid REFERENCES browser_sessions(id), kind varchar(16) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, incomplete boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_open_usage_interval ON usage_intervals(session_id,kind) WHERE ended_at IS NULL;
CREATE TABLE artifacts (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), task_id uuid NOT NULL REFERENCES tasks(id),
  operation_id uuid REFERENCES operations(id), name varchar(300) NOT NULL, mime_type varchar(150) NOT NULL,
  status varchar(16) NOT NULL, size_bytes bigint, sha256 varchar(64), complete boolean NOT NULL,
  source_url varchar(4096), source_ref varchar(1000), duration_seconds numeric(20,3),
  relative_path varchar(100) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE result_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id),
  owner_id uuid NOT NULL REFERENCES accounts(id), cells jsonb NOT NULL
);
CREATE INDEX result_rows_task ON result_rows(task_id,id);
CREATE TABLE administrative_audit (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL, target_id uuid NOT NULL, action varchar(50) NOT NULL,
  reason varchar(1000), before_value jsonb NOT NULL DEFAULT '{}', after_value jsonb NOT NULL DEFAULT '{}',
  status varchar(24) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_target ON administrative_audit(target_id,created_at DESC);
CREATE TABLE administrative_jobs (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES accounts(id), type varchar(32) NOT NULL,
  cutoff_sequence bigint, status varchar(24) NOT NULL DEFAULT 'PENDING',
  error_code varchar(80), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scheduler_state (id integer PRIMARY KEY CHECK (id = 1), last_owner_id uuid, drain boolean NOT NULL DEFAULT false);
INSERT INTO scheduler_state(id) VALUES (1);
