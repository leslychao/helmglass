CREATE TABLE mcp_task_chats (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  chat_id varchar(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_chats (
  owner_id uuid NOT NULL REFERENCES accounts(id),
  chat_id varchar(256) NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id),
  generation uuid NOT NULL UNIQUE,
  stream_token varchar(64) NOT NULL UNIQUE,
  presented_at timestamptz NOT NULL DEFAULT now(),
  continuation_status varchar(24) NOT NULL DEFAULT 'IDLE'
    CHECK (continuation_status IN ('IDLE','PENDING','SENDING','MESSAGE_SENT','ACCEPTED','UNAVAILABLE')),
  continuation_revision bigint,
  continuation_reason varchar(500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,chat_id)
);
