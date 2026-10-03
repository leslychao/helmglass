#!/bin/sh
set -eu

: "${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
if ! printf '%s\n' "$PUBLIC_ORIGIN" | grep -Eq '^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$'; then
    printf '%s\n' 'PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.' >&2
    exit 1
fi

PUBLIC_AUTHORITY=${PUBLIC_ORIGIN#https://}
PUBLIC_WS_ORIGIN=wss://$PUBLIC_AUTHORITY
PUBLIC_PORT=443
case "$PUBLIC_AUTHORITY" in
    \[*\]*)
        PUBLIC_HOST=${PUBLIC_AUTHORITY%%]*}]
        suffix=${PUBLIC_AUTHORITY#*]}
        if [ -n "$suffix" ]; then PUBLIC_PORT=${suffix#:}; fi
        ;;
    *:*) PUBLIC_HOST=${PUBLIC_AUTHORITY%:*}; PUBLIC_PORT=${PUBLIC_AUTHORITY##*:} ;;
    *) PUBLIC_HOST=$PUBLIC_AUTHORITY ;;
esac
if [ "$PUBLIC_PORT" -lt 1 ] || [ "$PUBLIC_PORT" -gt 65535 ]; then
    printf '%s\n' 'PUBLIC_ORIGIN port is outside the valid range.' >&2
    exit 1
fi

TRUSTED_EDGE_DIRECTIVE=
TRUSTED_EDGE_GEO=
TRUSTED_EDGE_STREAM=
DEFAULT_TLS_LISTEN=
HTTP_TLS_LISTEN=
HTTP_TLS_DIRECTIVES=
STREAM_TLS_DIRECTIVES=
TURN_TLS_LISTEN=proxy_protocol
DIRECT_TURN_TCP=
if [ -n "${TRUSTED_EDGE_PROXY:-}" ]; then
    if ! printf '%s\n' "$TRUSTED_EDGE_PROXY" | grep -Eq '^[0-9a-fA-F.:]+(/[0-9]{1,3})?$'; then
        printf '%s\n' 'TRUSTED_EDGE_PROXY must be one IP address or CIDR.' >&2
        exit 1
    fi
    TRUSTED_EDGE_DIRECTIVE="set_real_ip_from $TRUSTED_EDGE_PROXY;"
    TRUSTED_EDGE_GEO="$TRUSTED_EDGE_PROXY 1;"
    TRUSTED_EDGE_STREAM="allow $TRUSTED_EDGE_PROXY; deny all;"
else
    # Direct local access owns TLS here; deployments behind the global edge mount no key.
    test -s /run/secrets/edge_tls_identity
    DEFAULT_TLS_LISTEN='listen 8443 ssl default_server; ssl_reject_handshake on;'
    HTTP_TLS_LISTEN='listen 8443 ssl;'
    HTTP_TLS_DIRECTIVES='ssl_certificate /run/secrets/edge_tls_identity;
        ssl_certificate_key /run/secrets/edge_tls_identity;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:TLS:10m;
        ssl_session_tickets off;'
    STREAM_TLS_DIRECTIVES='ssl_certificate /run/secrets/edge_tls_identity;
        ssl_certificate_key /run/secrets/edge_tls_identity;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:TURN_TLS:1m;
        ssl_session_tickets off;'
    TURN_TLS_LISTEN=ssl
    DIRECT_TURN_TCP='server { listen 3478; proxy_pass turn_udp; }'
fi

export PUBLIC_AUTHORITY PUBLIC_WS_ORIGIN PUBLIC_HOST PUBLIC_PORT TRUSTED_EDGE_DIRECTIVE TRUSTED_EDGE_GEO
export TRUSTED_EDGE_STREAM DEFAULT_TLS_LISTEN HTTP_TLS_LISTEN HTTP_TLS_DIRECTIVES
export STREAM_TLS_DIRECTIVES TURN_TLS_LISTEN DIRECT_TURN_TCP
umask 077
envsubst '${PUBLIC_AUTHORITY} ${PUBLIC_WS_ORIGIN} ${PUBLIC_HOST} ${PUBLIC_PORT} ${TRUSTED_EDGE_DIRECTIVE} ${TRUSTED_EDGE_GEO} ${TRUSTED_EDGE_STREAM} ${DEFAULT_TLS_LISTEN} ${HTTP_TLS_LISTEN} ${HTTP_TLS_DIRECTIVES} ${STREAM_TLS_DIRECTIVES} ${TURN_TLS_LISTEN} ${DIRECT_TURN_TCP}' \
    < /etc/helm/nginx.conf.template > /run/nginx.conf
nginx -t -c /run/nginx.conf
exec nginx -c /run/nginx.conf -g 'daemon off;'
