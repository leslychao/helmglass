#!/bin/sh
set -eu
umask 077
identity=/run/secrets/vault_tls_identity
if [ ! -f "$identity" ] || [ -L "$identity" ] || [ "$(wc -c < "$identity")" -gt 65536 ]; then
  printf '%s\n' 'Vault TLS identity is missing or invalid' >&2
  exit 1
fi
if ! jq -e '.schemaVersion == 1 and
  (.tls.certificatePem | type == "string" and startswith("-----BEGIN CERTIFICATE-----")) and
  (.tls.privateKeyPem | type == "string" and startswith("-----BEGIN PRIVATE KEY-----")) and
  (.tls.caPem | type == "string" and startswith("-----BEGIN CERTIFICATE-----"))' "$identity" >/dev/null 2>&1; then
  printf '%s\n' 'Vault TLS identity is incomplete' >&2
  exit 1
fi
mkdir -p /run/helm
chmod 700 /run/helm
jq -r '.tls.certificatePem' "$identity" > /run/helm/vault.crt
jq -r '.tls.privateKeyPem' "$identity" > /run/helm/vault.key
jq -r '.tls.caPem' "$identity" > /run/helm/ca.crt
chmod 600 /run/helm/vault.crt /run/helm/vault.key /run/helm/ca.crt
exec vault server -config=/etc/helm/vault.hcl
