#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
ENV_FILE=${1:-$SCRIPT_DIR/.env.dev}
case "$ENV_FILE" in /*|[A-Za-z]:*) ;; *) ENV_FILE=$PROJECT_DIR/$ENV_FILE ;; esac
[ -f "$ENV_FILE" ] || { printf 'Environment file not found: %s\n' "$ENV_FILE" >&2; exit 1; }
# The selected file is the sole source of deployment values, including missing ones.
unset DEV_HOST GLOBAL_NGINX_HOST PUBLIC_URL PUBLIC_HOST COOKIE_SECURE NODE_ID
unset EDGE_BIND_ADDRESS EDGE_HTTP_PORT EDGE_NETWORK EDGE_NETWORK_ADDRESS
unset POSTGRES_PASSWORD DATABASE_PASSWORD KEYCLOAK_DATABASE_PASSWORD KEYCLOAK_BOOTSTRAP_PASSWORD
unset KEYCLOAK_TEST_PASSWORD KEYCLOAK_APP_ADMIN_PASSWORD KEYCLOAK_LIFECYCLE_SECRET
unset OAUTH2_CLIENT_SECRET OAUTH2_COOKIE_SECRET REDIS_PASSWORD WORKER_TOKEN PROFILE_ENCRYPTION_KEY
unset VAULT_UNSEAL_KEY VAULT_ROLE_ID VAULT_SECRET_ID AUDIO_TOKEN
set -a
. "$ENV_FILE"
set +a
: "${DEV_HOST:?DEV_HOST is required}"
: "${GLOBAL_NGINX_HOST:?GLOBAL_NGINX_HOST is required}"
export DOCKER_HOST="tcp://$DEV_HOST:2375"
# Container paths must not be rewritten by Git Bash on Windows.
export MSYS2_ARG_CONV_EXCL='/usr/local/;/vault/'
unset DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_PROFILES COMPOSE_FILE
cd "$PROJECT_DIR"
compose() { docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.yml" "$@"; }
compose_version=$(docker compose version --short)
if ! printf '%s\n' "$compose_version" | awk -F. \
    '{ sub(/^v/, "", $1); exit !(($1 + 0) > 2 || (($1 + 0) == 2 && ($2 + 0) >= 30)) }'; then
  printf '%s\n' 'Docker Compose 2.30.0 or newer is required; older versions can crash during up.' >&2
  exit 1
fi
if [ "${2:-}" = '--vault-init' ]; then
  if [ -n "${VAULT_UNSEAL_KEY:-}" ] && [ -n "${VAULT_ROLE_ID:-}" ] && [ -n "${VAULT_SECRET_ID:-}" ]; then
    printf '%s\n' 'Vault credentials already exist; initialization was not repeated.'
    exit 0
  fi
  compose config --quiet
  compose build vault
  compose up -d --no-deps vault
  attempt=0
  until compose exec -T vault sh -c 'VAULT_ADDR=https://vault:8200 VAULT_CACERT=/vault/ca/ca.crt vault status -format=json 2>/dev/null | jq -e .initialized!=null >/dev/null'; do
    attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || exit 1; sleep 1
  done
  compose exec -T vault /usr/local/bin/bootstrap.sh
  umask 077
  awk '!/^VAULT_(UNSEAL_KEY|ROLE_ID|SECRET_ID)=/' "$ENV_FILE" > "$ENV_FILE.vault-init"
  printf '\n' >> "$ENV_FILE.vault-init"
  compose exec -T vault cat /vault/data/bootstrap.env >> "$ENV_FILE.vault-init"
  mv "$ENV_FILE.vault-init" "$ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
  compose up -d --no-deps vault
  compose exec -T vault rm -f /vault/data/bootstrap.env /vault/data/bootstrap-complete
  printf '%s\n' 'Vault initialized; its application and unseal credentials are stored in the selected env file.'
  exit 0
fi
: "${VAULT_UNSEAL_KEY:?Initialize Vault with --vault-init first}"
: "${VAULT_ROLE_ID:?VAULT_ROLE_ID is required}"
: "${VAULT_SECRET_ID:?VAULT_SECRET_ID is required}"
compose config --quiet
if [ "${2:-}" = '--config-only' ]; then exit 0; fi
docker info --format '{{.OSType}}' | grep -qx linux
server_api=$(docker version --format '{{.Server.APIVersion}}')
if ! printf '%s\n' "$server_api" | awk -F. '{ exit !(($1 + 0) > 1 || (($1 + 0) == 1 && ($2 + 0) >= 45)) }'; then
  printf '%s\n' 'Docker Engine 26.0 or newer is required for isolated volume subpaths.' >&2
  exit 1
fi
manager=$(compose ps -q browser-node)
if [ -n "$manager" ]; then
  docker exec "$manager" node --input-type=module -e '
    const response = await fetch("http://api:8080/internal/worker/drain", {
      signal: AbortSignal.timeout(10000), method: "POST", headers: {"Content-Type":"application/json", "X-Worker-Token":process.env.WORKER_TOKEN},
      body: JSON.stringify({drain:true})});
    if (!response.ok) throw new Error("Could not stop browser admission");'
  docker exec "$manager" node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:8090/drain", {
      signal: AbortSignal.timeout(10000), method: "POST", headers: {"Content-Type":"application/json", "X-Worker-Token":process.env.WORKER_TOKEN},
      body: JSON.stringify({enabled:true})});
    if (!response.ok) throw new Error("Could not stop new browser assignments");'
  printf '%s\n' 'Waiting for occupied browsers to finish. Cancellation preserves their sessions.'
  attempts=0
  while :; do
    state=$(docker exec "$manager" node --input-type=module -e '
      const response = await fetch("http://127.0.0.1:8090/health", {signal:AbortSignal.timeout(10000),headers:{"X-Worker-Token":process.env.WORKER_TOKEN}});
      if (!response.ok) throw new Error("Browser occupancy is unknown");
      const state = await response.json();
      if (!Number.isInteger(state.occupied) || state.occupied < 0) throw new Error("Browser occupancy is unknown");
      const backendResponse = await fetch("http://api:8080/internal/worker/drain", {signal:AbortSignal.timeout(10000),headers:{"X-Worker-Token":process.env.WORKER_TOKEN}});
      if (!backendResponse.ok) throw new Error("Admission occupancy is unknown");
      const admission = await backendResponse.json();
      if (!Number.isInteger(admission.occupied) || !Number.isInteger(admission.unreachableNodes)
          || admission.unreachableNodes > 0) throw new Error("Unconfirmed browser nodes prevent deployment");
      process.stdout.write(String(state.occupied + admission.occupied));')
    [ "$state" = 0 ] && break
    attempts=$((attempts + 1))
    [ "$attempts" -lt 120 ] || { printf '%s\n' 'Browser drain timed out; occupied browsers were preserved.' >&2; exit 1; }
    sleep 5
  done
fi
compose --profile build build --pull
compose up -d --no-deps vault
attempt=0
until compose exec -T vault sh -c 'VAULT_ADDR=https://vault:8200 VAULT_CACERT=/vault/ca/ca.crt vault status >/dev/null'; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || exit 1; sleep 2
done
compose stop api browser-node
# The one-time transfer runs with execution and registration stopped; a failure preserves sources.
compose run --rm --no-deps browser-node node dist/migrate-session-storage.js
if [ -n "${PROFILE_ENCRYPTION_KEY:-}" ]; then
  compose run --rm --no-deps -e PROFILE_ENCRYPTION_KEY browser-node node dist/migrate-profiles.js
  umask 077
  awk '!/^PROFILE_ENCRYPTION_KEY=/' "$ENV_FILE" > "$ENV_FILE.vault-migration"
  mv "$ENV_FILE.vault-migration" "$ENV_FILE"
  unset PROFILE_ENCRYPTION_KEY
fi
compose up -d
compose run --rm --no-deps provisioning
manager=$(compose ps -q browser-node)
docker exec "$manager" node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:8090/drain", {
    signal: AbortSignal.timeout(10000), method:"POST", headers:{"Content-Type":"application/json", "X-Worker-Token":process.env.WORKER_TOKEN},
    body:JSON.stringify({enabled:false})});
  if (!response.ok) throw new Error("Could not enable browser assignments");'
attempt=0
until compose exec -T edge wget -q -O /dev/null http://api:8080/actuator/health; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { printf '%s\n' 'Application readiness was not confirmed.' >&2; exit 1; }
  sleep 2
done
docker exec "$manager" node --input-type=module -e '
  const response = await fetch("http://api:8080/internal/worker/drain", {
    signal: AbortSignal.timeout(10000), method:"POST", headers:{"Content-Type":"application/json", "X-Worker-Token":process.env.WORKER_TOKEN},
    body:JSON.stringify({drain:false})});
  if (!response.ok) throw new Error("Could not enable browser admission");'
printf 'Application is ready behind the gateway: %s\n' "$PUBLIC_URL"
