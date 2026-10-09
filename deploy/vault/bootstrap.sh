#!/bin/sh
set -eu
umask 077
export VAULT_ADDR=https://vault:8200 VAULT_CACERT=/vault/ca/ca.crt
state=$(vault status -format=json 2>/dev/null) || true
[ -n "$state" ] || { printf '%s\n' 'Vault is not reachable' >&2; exit 1; }
if [ "$(printf '%s' "$state" | jq -r .initialized)" = false ]; then
  vault operator init -key-shares=1 -key-threshold=1 -format=json > /vault/data/bootstrap-root.json
fi
if [ ! -f /vault/data/bootstrap-root.json ]; then
  [ -f /vault/data/bootstrap.env ] && exit 0
  printf '%s\n' 'Vault is already initialized; existing configuration is required' >&2
  exit 1
fi
key=$(jq -r '.unseal_keys_b64[0]' /vault/data/bootstrap-root.json)
vault operator unseal "$key" >/dev/null
export VAULT_TOKEN=$(jq -r .root_token /vault/data/bootstrap-root.json)
if [ ! -f /vault/data/bootstrap-complete ]; then
  if ! vault secrets list -format=json | jq -e 'has("helmglass/")' >/dev/null; then vault secrets enable -path=helmglass -version=2 kv >/dev/null; fi
  vault write helmglass/config max_versions=1 cas_required=true >/dev/null
  if ! vault secrets list -format=json | jq -e 'has("transit/")' >/dev/null; then vault secrets enable transit >/dev/null; fi
  vault write transit/keys/helmglass-profiles type=aes256-gcm96 exportable=false allow_plaintext_backup=false >/dev/null
  if ! vault auth list -format=json | jq -e 'has("approle/")' >/dev/null; then vault auth enable approle >/dev/null; fi
  vault policy write helmglass-browser - >/dev/null <<'POLICY'
path "helmglass/data/connections/*" { capabilities = ["create", "read", "update"] }
path "helmglass/metadata/connections/*" { capabilities = ["delete"] }
path "transit/datakey/plaintext/helmglass-profiles" { capabilities = ["update"] }
path "transit/decrypt/helmglass-profiles" { capabilities = ["update"] }
POLICY
  vault write auth/approle/role/helmglass-browser token_policies=helmglass-browser token_ttl=1h token_max_ttl=1h secret_id_ttl=0 secret_id_num_uses=0 >/dev/null
  role=$(vault read -field=role_id auth/approle/role/helmglass-browser/role-id)
  secret=$(vault write -field=secret_id -f auth/approle/role/helmglass-browser/secret-id)
  printf 'VAULT_UNSEAL_KEY=%s\nVAULT_ROLE_ID=%s\nVAULT_SECRET_ID=%s\n' "$key" "$role" "$secret" > /vault/data/bootstrap.env
  touch /vault/data/bootstrap-complete
fi
if vault token lookup >/dev/null 2>&1; then vault token revoke -self >/dev/null; fi
rm -f /vault/data/bootstrap-root.json
