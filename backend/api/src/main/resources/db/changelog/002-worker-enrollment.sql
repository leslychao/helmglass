CREATE TABLE worker_enrollments (
  installation_id varchar(80) NOT NULL,
  worker_id uuid NOT NULL,
  boot_id uuid NOT NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 16),
  csr_digest varchar(64) NOT NULL,
  issuance_id uuid NOT NULL,
  state varchar(12) NOT NULL CHECK (state IN ('PENDING', 'READY', 'REVOKED')),
  certificate_pem text,
  ca_pem text,
  serial_number varchar(128),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  issuance_attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, worker_id, boot_id)
);
CREATE INDEX worker_enrollment_admission
  ON worker_enrollments (installation_id, expires_at) WHERE state <> 'REVOKED';
