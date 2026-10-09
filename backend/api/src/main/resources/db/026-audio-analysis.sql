CREATE TABLE audio_analyses (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source_sha256 text NOT NULL,
  processing_version text NOT NULL,
  metadata jsonb NOT NULL,
  requested_mode text NOT NULL CHECK (requested_mode IN ('transcript','full')),
  run_mode text CHECK (run_mode IN ('transcript','full')),
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  transcript_complete boolean NOT NULL DEFAULT false,
  acoustics_complete boolean NOT NULL DEFAULT false,
  emotions_complete boolean NOT NULL DEFAULT false,
  checkpoint jsonb NOT NULL DEFAULT '{}',
  metrics jsonb NOT NULL DEFAULT '{}',
  duration_seconds numeric,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  attempt uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id,artifact_id,processing_version)
);
CREATE UNIQUE INDEX audio_one_executor ON audio_analyses ((true)) WHERE status='RUNNING';
CREATE INDEX audio_queue ON audio_analyses (next_attempt_at,created_at) WHERE status='QUEUED';
CREATE TABLE audio_analysis_items (
  id bigserial PRIMARY KEY,
  analysis_id uuid NOT NULL REFERENCES audio_analyses(id) ON DELETE CASCADE,
  section text NOT NULL CHECK (section IN ('transcript','intervals','acoustics','emotions')),
  start_seconds numeric NOT NULL CHECK (start_seconds>=0),
  end_seconds numeric NOT NULL CHECK (end_seconds>=start_seconds),
  payload jsonb NOT NULL CHECK (octet_length(payload::text)<=8192)
);
CREATE INDEX audio_items_page ON audio_analysis_items (analysis_id,section,id);
CREATE INDEX audio_items_time ON audio_analysis_items (analysis_id,section,start_seconds);
CREATE TABLE audio_executor (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO audio_executor VALUES (1);
