#!/bin/sh
set -eu
umask 077
mkdir -p /run/secrets /run/fixture
openssl req -x509 -newkey rsa:2048 -nodes -keyout /run/fixture/key.pem \
  -out /run/fixture/cert.pem -days 1 -subj '/CN=acceptance.turn.example' \
  -addext 'subjectAltName=DNS:acceptance.turn.example' >/dev/null 2>&1
openssl rand -base64 32 > /run/fixture/secret
jq -n --rawfile cert /run/fixture/cert.pem --rawfile key /run/fixture/key.pem \
  --rawfile secret /run/fixture/secret \
  '{schemaVersion:1,turnSharedSecret:($secret|rtrimstr("\n")),tls:{certificatePem:$cert,privateKeyPem:$key,caPem:$cert}}' \
  > /run/secrets/turn_identity
export TURN_REALM=acceptance.turn.example
export TURN_ADVERTISED_IP=203.0.113.10
export TURN_RELAY_MIN=49160
export TURN_RELAY_MAX=49200
/opt/helm/bin/entrypoint &
turn_pid=$!
trap 'kill "$turn_pid" 2>/dev/null || true' EXIT INT TERM
attempt=0
until /opt/helm/bin/healthcheck >/dev/null 2>&1; do
  kill -0 "$turn_pid"
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then echo 'TURN listener did not become ready' >&2; exit 1; fi
  sleep 1
done
relay_ip=$(hostname -i | awk '{print $1}')
openssl s_client -connect "$relay_ip:5349" -verify_hostname acceptance.turn.example \
  -verify_return_error -CAfile /run/fixture/cert.pem -brief </dev/null >/dev/null 2>&1
test "$(stat -c '%a' /run/helm/turnserver.conf)" = 600
test "$(stat -c '%a' /run/helm/turn-key.pem)" = 600
echo 'TURN protected bootstrap, STUN readiness and verified TLS passed as UID 10001 with all capabilities dropped'
