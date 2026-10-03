#!/bin/sh
set -eu
umask 077
: "${TURN_REALM:?TURN_REALM is required}"
: "${TURN_RELAY_MIN:?TURN_RELAY_MIN is required}"
: "${TURN_RELAY_MAX:?TURN_RELAY_MAX is required}"
case "$TURN_REALM" in *[!A-Za-z0-9._-]*|'') exit 1 ;; esac
case "$TURN_RELAY_MIN" in *[!0-9]*|'') exit 1 ;; esac
case "$TURN_RELAY_MAX" in *[!0-9]*|'') exit 1 ;; esac
if [ "${#TURN_RELAY_MIN}" -gt 5 ] || [ "${#TURN_RELAY_MAX}" -gt 5 ]; then exit 1; fi
if [ "$TURN_RELAY_MIN" -lt 1024 ] || [ "$TURN_RELAY_MAX" -gt 65535 ] || [ "$TURN_RELAY_MIN" -gt "$TURN_RELAY_MAX" ]; then exit 1; fi
mkdir -p /run/helm
identity=/run/secrets/turn_identity
jq -e 'keys == ["schemaVersion", "turnSharedSecret"] and .schemaVersion == 2 and (.turnSharedSecret | type == "string" and length >= 32 and length <= 512 and test("^[A-Za-z0-9_+/=-]+$"))' "$identity" >/dev/null
# Both peers use this relay. Its single private address never needs a public NAT mapping.
relay_ip=$(hostname -i)
case "$relay_ip" in *[!0-9.]*|'') exit 1 ;; esac
printf '%s' "$relay_ip" | jq -Re 'split(".") | length == 4 and all(.[]; (tonumber >= 0 and tonumber <= 255))' >/dev/null
cat > /run/helm/turnserver.conf <<EOF
listening-port=3478
tcp-proxy-port=5555
no-tls
no-dtls
listening-ip=$relay_ip
relay-ip=$relay_ip
realm=$TURN_REALM
server-name=$TURN_REALM
use-auth-secret
fingerprint
no-tcp-relay
no-multicast-peers
no-dynamic-ip-list
no-software-attribute
stale-nonce=600
max-allocate-lifetime=300
user-quota=4
total-quota=128
max-bps=2097152
bps-capacity=33554432
relay-threads=2
min-port=$TURN_RELAY_MIN
max-port=$TURN_RELAY_MAX
pidfile=/run/helm/coturn.pid
log-file=stdout
simple-log
log-min-level=warning
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-255.255.255.255
denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
# The relay-only producer and viewer exchange packets between this server's allocations.
allowed-peer-ip=$relay_ip
EOF
printf 'static-auth-secret=%s\n' "$(jq -r '.turnSharedSecret' "$identity")" >> /run/helm/turnserver.conf
unset relay_ip
exec /usr/bin/turnserver -c /run/helm/turnserver.conf
