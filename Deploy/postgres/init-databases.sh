#!/bin/sh
set -eu
# The official entrypoint invokes this only when initializing a new PGDATA volume.
identity=/run/secrets/postgres_identity
HELM_MIGRATION_PASSWORD=$(jq -r '.migrationPassword' "$identity")
HELM_API_PASSWORD=$(jq -r '.apiPassword' "$identity")
HELM_KEYCLOAK_PASSWORD=$(jq -r '.keycloakPassword' "$identity")
export HELM_MIGRATION_PASSWORD HELM_API_PASSWORD HELM_KEYCLOAK_PASSWORD
# Role password statements must not be copied to errors or server diagnostics.
export PGOPTIONS='-c log_statement=none -c log_min_error_statement=panic'
psql --no-psqlrc --quiet --username postgres --dbname postgres \
  --set ON_ERROR_STOP=1 --file /opt/helm/init-databases.sql
unset HELM_MIGRATION_PASSWORD HELM_API_PASSWORD HELM_KEYCLOAK_PASSWORD PGOPTIONS
