#!/bin/sh
set -eu
: "${DATABASE_PASSWORD:?DATABASE_PASSWORD is required}"
: "${KEYCLOAK_DATABASE_PASSWORD:?KEYCLOAK_DATABASE_PASSWORD is required}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$DATABASE_PASSWORD" \
  --set=identity_password="$KEYCLOAK_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE helmglass LOGIN PASSWORD :'app_password';
CREATE DATABASE helmglass OWNER helmglass;
REVOKE ALL ON DATABASE helmglass FROM PUBLIC;
CREATE ROLE keycloak LOGIN PASSWORD :'identity_password';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
