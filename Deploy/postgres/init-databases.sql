-- A failed first initialization can leave PG_VERSION without application roles.
-- Re-running this owner is permitted only before any application state exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_database
             WHERE datname NOT IN ('postgres', 'template0', 'template1'))
      OR EXISTS (SELECT 1 FROM pg_roles
                 WHERE rolname <> 'postgres' AND rolname NOT LIKE 'pg\_%' ESCAPE '\')
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
                   AND n.nspname <> 'information_schema')
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
                   AND n.nspname <> 'information_schema') THEN
    RAISE EXCEPTION 'Helm database bootstrap requires an empty application cluster';
  END IF;
END $$;

\getenv migration_password HELM_MIGRATION_PASSWORD
\getenv api_password HELM_API_PASSWORD
\getenv keycloak_password HELM_KEYCLOAK_PASSWORD

CREATE ROLE helm_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'migration_password';
CREATE ROLE helm_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'api_password';
CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'keycloak_password';
CREATE DATABASE helm OWNER helm_migration;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE helm FROM PUBLIC;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
GRANT CONNECT ON DATABASE helm TO helm_api;
REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;

\connect helm
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO helm_api;
ALTER DEFAULT PRIVILEGES FOR ROLE helm_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helm_api;
ALTER DEFAULT PRIVILEGES FOR ROLE helm_migration IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO helm_api;

\connect keycloak
REVOKE ALL ON SCHEMA public FROM PUBLIC;
