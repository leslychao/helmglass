#!/bin/sh
set -eu
umask 077
identity=/run/secrets/postgres_identity
if [ ! -f "$identity" ] || [ -L "$identity" ] || [ "$(wc -c < "$identity")" -gt 65536 ]; then
  printf '%s\n' 'PostgreSQL bootstrap identity is missing or invalid.' >&2
  exit 1
fi
if ! jq -e '
  def password: type == "string" and length >= 24 and length <= 4096 and (explode | all(.[]; . != 0));
  .schemaVersion == 1 and (.rootPassword | password) and (.migrationPassword | password)
  and (.apiPassword | password) and (.keycloakPassword | password)' "$identity" >/dev/null; then
  printf '%s\n' 'PostgreSQL bootstrap identity has invalid credentials.' >&2
  exit 1
fi
mkdir -p /run/helm
chmod 700 /run/helm
jq -jr '.rootPassword' "$identity" > /run/helm/postgres-root-password
chmod 600 /run/helm/postgres-root-password
if [ "$(id -u)" = 0 ]; then
  chown postgres:postgres /run/helm /run/helm/postgres-root-password
fi
export POSTGRES_USER=postgres POSTGRES_DB=postgres
export POSTGRES_PASSWORD_FILE=/run/helm/postgres-root-password
export POSTGRES_INITDB_ARGS='--auth-host=scram-sha-256 --auth-local=trust'
export POSTGRES_HOST_AUTH_METHOD=scram-sha-256
unset POSTGRES_PASSWORD
if [ -n "${BACKUP_DIR:-}" ] && [ "$1" = postgres ]; then
  : "${BACKUP_RECIPIENT_CERT:?Backup recipient certificate file is required}"
  [ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ] && [ -f "$BACKUP_RECIPIENT_CERT" ] \
    || { printf '%s\n' 'PostgreSQL WAL backup inputs are unavailable.' >&2; exit 1; }
  set -- "$@" -c wal_level=replica -c archive_mode=on -c archive_timeout=60s \
    -c 'archive_command=/opt/helm/bin/archive-wal "%p" "%f"'
fi
# The official entrypoint creates a version parent directory before dropping root;
# its default mask keeps that parent traversable by postgres. Secrets are already 0600.
umask 022
exec /usr/local/bin/docker-entrypoint.sh "$@"
