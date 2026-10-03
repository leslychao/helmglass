#!/bin/sh
set -eu
umask 077
: "${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
: "${NGINX_INTERNAL_ADDRESS:?NGINX_INTERNAL_ADDRESS is required}"
if ! printf '%s\n' "$PUBLIC_ORIGIN" | grep -Eq '^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'; then
  printf '%s\n' 'PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.' >&2
  exit 1
fi
if ! printf '%s\n' "$NGINX_INTERNAL_ADDRESS" | jq -Re 'split(".") | length == 4 and all(.[]; test("^[0-9]{1,3}$") and (tonumber >= 0 and tonumber <= 255))' >/dev/null; then
  printf '%s\n' 'NGINX_INTERNAL_ADDRESS must identify the internal Nginx IPv4 address.' >&2
  exit 1
fi
. /opt/helm/bin/vault-bootstrap
helm_vault_read /run/secrets/keycloak_identity keycloak
identity=/run/helm/service-secrets.json
if ! jq -e '
  def secret: type == "string" and length >= 16 and length <= 4096 and (explode | all(.[]; . != 0));
  (.databaseUrl | type == "string" and test("^jdbc:postgresql://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9_]+$"))
  and (.databaseUsername | type == "string" and test("^[A-Za-z_][A-Za-z0-9_]{0,62}$"))
  and (.databasePassword | secret)
  and (.bootstrapClientId | type == "string" and test("^[A-Za-z0-9_-]{1,100}$"))
  and (.bootstrapClientSecret | secret)' "$identity" >/dev/null; then
  printf '%s\n' 'Keycloak service secrets are incomplete or invalid.' >&2
  exit 1
fi
KC_DB_URL=$(jq -r '.databaseUrl' "$identity")
KC_DB_USERNAME=$(jq -r '.databaseUsername' "$identity")
KC_DB_PASSWORD=$(jq -r '.databasePassword' "$identity")
KC_BOOTSTRAP_ADMIN_CLIENT_ID=$(jq -r '.bootstrapClientId' "$identity")
KC_BOOTSTRAP_ADMIN_CLIENT_SECRET=$(jq -r '.bootstrapClientSecret' "$identity")
KC_HOSTNAME=$PUBLIC_ORIGIN/auth
KC_PROXY_TRUSTED_ADDRESSES=$NGINX_INTERNAL_ADDRESS
export KC_DB_URL KC_DB_USERNAME KC_DB_PASSWORD KC_BOOTSTRAP_ADMIN_CLIENT_ID
export KC_BOOTSTRAP_ADMIN_CLIENT_SECRET KC_HOSTNAME KC_PROXY_TRUSTED_ADDRESSES
rm -f "$identity"
mkdir -p /run/helm/keycloak-data
exec /opt/keycloak/bin/kc.sh start --optimized --http-enabled=true --http-relative-path=/auth \
  --http-port=8080 --http-management-port=9000 --http-management-relative-path=/ \
  --hostname-strict=true --proxy-headers=xforwarded --cache=local --log-level=warn \
  --http-access-log-enabled=false
