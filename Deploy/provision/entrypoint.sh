#!/bin/sh
set -eu
umask 077
if [ "${1:-realm}" = vault-services ]; then
  exec node /opt/helm/provision/src/vault-services-main.mjs
fi
. /opt/helm/bin/vault-bootstrap
helm_vault_read /run/secrets/provision_identity provision
exec node /opt/helm/provision/src/main.mjs "$@"
