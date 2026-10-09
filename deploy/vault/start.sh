#!/bin/sh
set -eu
umask 077
mkdir -p /vault/data/raft /vault/tls /vault/ca
if [ ! -f /vault/tls/server.key ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=Helm Glass Vault CA' -keyout /vault/tls/ca.key -out /vault/tls/ca.crt >/dev/null 2>&1
  openssl req -newkey rsa:3072 -nodes -subj '/CN=vault' -keyout /vault/tls/server.key -out /vault/tls/server.csr >/dev/null 2>&1
  printf '%s\n' 'subjectAltName=DNS:vault' 'extendedKeyUsage=serverAuth' > /vault/tls/extensions
  openssl x509 -req -in /vault/tls/server.csr -CA /vault/tls/ca.crt -CAkey /vault/tls/ca.key -CAcreateserial -out /vault/tls/server.crt -days 3650 -extfile /vault/tls/extensions >/dev/null 2>&1
  rm /vault/tls/server.csr /vault/tls/extensions
fi
cp /vault/tls/ca.crt /vault/ca/ca.crt
chmod 755 /vault/ca
chmod 644 /vault/ca/ca.crt
chown -R vault:vault /vault/data /vault/tls
export VAULT_ADDR=https://vault:8200 VAULT_CACERT=/vault/ca/ca.crt
su-exec vault vault server -config=/vault/config/helmglass.hcl &
server=$!
trap 'kill -TERM "$server"; wait "$server"' TERM INT
if [ -n "${VAULT_UNSEAL_KEY:-}" ]; then
  attempt=0
  while :; do
    state=$(vault status -format=json 2>/dev/null) || true
    if [ -n "$state" ] && [ "$(printf '%s' "$state" | jq -r .initialized)" = true ]; then
      vault operator unseal "$VAULT_UNSEAL_KEY" >/dev/null
      break
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 60 ] || { kill -TERM "$server"; exit 1; }
    sleep 1
  done
fi
wait "$server"
