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
set -a
. "$ENV_FILE"
set +a
: "${DEV_HOST:?DEV_HOST is required}"
: "${GLOBAL_NGINX_HOST:?GLOBAL_NGINX_HOST is required}"
export DOCKER_HOST="tcp://$DEV_HOST:2375"
unset DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_PROFILES COMPOSE_FILE
cd "$PROJECT_DIR"
compose() { docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.yml" "$@"; }
compose config --quiet
if [ "${2:-}" = '--config-only' ]; then exit 0; fi
docker info --format '{{.OSType}}' | grep -qx linux
compose --profile build build --pull

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
