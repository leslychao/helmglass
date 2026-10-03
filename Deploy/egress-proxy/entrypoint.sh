#!/bin/sh
set -eu
umask 077
mkdir -p /run/helm
identity=/run/secrets/egress_identity
jq -e '.schemaVersion == 1 and .mediaProxyUsername == "helm-media" and (.mediaProxyPassword | type == "string" and length >= 32 and length <= 256 and test("^[A-Za-z0-9_+/=-]+$"))' "$identity" >/dev/null
password_hash=$(jq -r '.mediaProxyPassword' "$identity" | openssl passwd -6 -stdin)
printf 'helm-media:%s\n' "$password_hash" > /run/helm/media-proxy.htpasswd
unset password_hash
/usr/local/sbin/squid -k parse -f /etc/squid/squid.conf >/dev/null 2>&1
exec /usr/local/sbin/squid -N -f /etc/squid/squid.conf
