CREATE TABLE viewer_revocations (
  owner_id uuid NOT NULL REFERENCES accounts(id),
  channel text NOT NULL CHECK (channel IN ('WEB','MCP')),
  grant_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  PRIMARY KEY (owner_id,channel,grant_id)
);
CREATE INDEX viewer_revocations_delivery ON viewer_revocations(next_attempt_at) WHERE attempts<20;
