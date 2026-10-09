#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
ENV_FILE=${1:-$SCRIPT_DIR/.env.dev}
case "$ENV_FILE" in /*|[A-Za-z]:*) ;; *) ENV_FILE=$PROJECT_DIR/$ENV_FILE ;; esac
[ -f "$ENV_FILE" ] || { printf 'Environment file not found: %s\n' "$ENV_FILE" >&2; exit 1; }
unset DEV_HOST AUDIO_TOKEN
set -a
. "$ENV_FILE"
set +a
: "${DEV_HOST:?DEV_HOST is required}"
: "${AUDIO_TOKEN:?AUDIO_TOKEN is required}"
export DOCKER_HOST="tcp://$DEV_HOST:2375"
unset DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_PROFILES COMPOSE_FILE
cd "$PROJECT_DIR"
compose() { docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.models.yml" "$@"; }
compose config --quiet
if [ "${2:-}" = '--config-only' ]; then exit 0; fi
docker info --format '{{.OSType}}' | grep -qx linux
compose build --pull
# The application owns this existing volume; creating an absent named volume is idempotent.
docker volume create helmglass_artifacts >/dev/null
compose up -d --wait --wait-timeout 180
printf '%s\n' 'Local audio models are ready on the private application network.'
