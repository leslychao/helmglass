CREATE TABLE account_avatars (
  owner_id uuid PRIMARY KEY REFERENCES accounts(id),
  content_type varchar(16) NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 char(64) NOT NULL,
  content bytea NOT NULL,
  CHECK (octet_length(content)=size_bytes)
);
