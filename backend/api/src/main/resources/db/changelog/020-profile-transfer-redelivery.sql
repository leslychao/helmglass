ALTER TABLE profile_transfers ADD COLUMN wrapped_token text;
ALTER TABLE profile_transfers ADD CONSTRAINT profile_transfer_wrapped_token_size
  CHECK (wrapped_token IS NULL OR octet_length(wrapped_token) BETWEEN 16 AND 4096);
