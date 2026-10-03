DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='helm_api') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_log FROM helm_api;
  END IF;
END
$$;
