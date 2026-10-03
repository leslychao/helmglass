#!/bin/sh
set -eu
umask 077
: "${TURN_REALM:?TURN_REALM is required}"
: "${TURN_ADVERTISED_IP:?TURN_ADVERTISED_IP is required}"
: "${TURN_RELAY_MIN:?TURN_RELAY_MIN is required}"
: "${TURN_RELAY_MAX:?TURN_RELAY_MAX is required}"
case "$TURN_REALM" in *[!A-Za-z0-9._-]*|'') exit 1 ;; esac
case "$TURN_ADVERTISED_IP" in *[!0-9.]*|'') exit 1 ;; esac
case "$TURN_RELAY_MIN:$TURN_RELAY_MAX" in *[!0-9:]*|'') exit 1 ;; esac
if [ "$TURN_RELAY_MIN" -lt 1024 ] || [ "$TURN_RELAY_MAX" -gt 65535 ] || [ "$TURN_RELAY_MIN" -gt "$TURN_RELAY_MAX" ]; then exit 1; fi
printf '%s' "$TURN_ADVERTISED_IP" | jq -Re 'split(".") | length == 4 and all(.[]; (tonumber >= 0 and tonumber <= 255))' >/dev/null
mkdir -p /run/helm
identity=/run/secrets/turn_identity
jq -e '.schemaVersion == 1 and (.turnSharedSecret | type == "string" and length >= 32 and length <= 512 and test("^[A-Za-z0-9_+/=-]+$")) and ([.tls.certificatePem,.tls.privateKeyPem,.tls.caPem] | all(.[]; type == "string" and length > 0 and length < 65536))' "$identity" >/dev/null
jq -er '.tls.certificatePem' "$identity" > /run/helm/turn-cert.pem
jq -er '.tls.privateKeyPem' "$identity" > /run/helm/turn-key.pem
jq -er '.tls.caPem' "$identity" > /run/helm/turn-ca.pem
openssl x509 -in /run/helm/turn-cert.pem -checkend 300 -noout >/dev/null
openssl verify -CAfile /run/helm/turn-ca.pem /run/helm/turn-cert.pem >/dev/null
openssl x509 -in /run/helm/turn-cert.pem -pubkey -noout > /run/helm/cert-public.pem
openssl pkey -in /run/helm/turn-key.pem -pubout > /run/helm/key-public.pem
cmp -s /run/helm/cert-public.pem /run/helm/key-public.pem
rm /run/helm/cert-public.pem /run/helm/key-public.pem
relay_ip=$(hostname -i | awk '{print $1}')
case "$relay_ip" in *[!0-9.]*|'') exit 1 ;; esac
cat > /run/helm/turnserver.conf <<EOF
listening-port=3478
tls-listening-port=5349
listening-ip=$relay_ip
relay-ip=$relay_ip
external-ip=$TURN_ADVERTISED_IP/$relay_ip
realm=$TURN_REALM
server-name=$TURN_REALM
use-auth-secret
fingerprint
cert=/run/helm/turn-cert.pem
pkey=/run/helm/turn-key.pem
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
# Host firewall additionally limits this exception to the configured UDP relay range.
allowed-peer-ip=$TURN_ADVERTISED_IP
EOF
printf 'static-auth-secret=%s\n' "$(jq -r '.turnSharedSecret' "$identity")" >> /run/helm/turnserver.conf
unset relay_ip
exec /usr/bin/turnserver -c /run/helm/turnserver.conf
