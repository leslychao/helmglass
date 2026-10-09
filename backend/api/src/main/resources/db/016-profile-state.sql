-- Saved browser state is not evidence that the external site still accepts its session.
ALTER TABLE connections
  ADD COLUMN profile_revision bigint NOT NULL DEFAULT 0 CHECK (profile_revision >= 0),
  ADD COLUMN profile_saved_at timestamptz,
  ADD COLUMN profile_save_error varchar(80),
  ADD COLUMN authorized_origins jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(authorized_origins) = 'array');
