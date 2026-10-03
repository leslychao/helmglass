#!/bin/sh
set -eu
umask 077
export HOME=/runtime
mkdir -p "$HOME/.pki/nssdb"
certutil -N --empty-password -d "sql:$HOME/.pki/nssdb"
certutil -A -d "sql:$HOME/.pki/nssdb" -n helm-auth-fixture -t 'C,,' -i /fixture/ca.crt
exec node /opt/helm/browser.mjs
