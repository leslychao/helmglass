#!/bin/sh
set -eu
umask 077
acl=/run/secrets/redis_acl
health=/run/secrets/redis_health_identity
if [ ! -f "$acl" ] || [ -L "$acl" ] || [ "$(wc -c < "$acl")" -gt 65536 ]; then
  printf '%s\n' 'Redis ACL bootstrap is missing or invalid.' >&2
  exit 1
fi
if ! jq -e '.schemaVersion == 1 and .username == "helm_health" and
  (.password | type == "string" and length >= 24 and length <= 4096 and (explode | all(.[]; . != 0)))' \
  "$health" >/dev/null; then
  printf '%s\n' 'Redis health identity is missing or invalid.' >&2
  exit 1
fi
mkdir -p /run/helm
chmod 700 /run/helm
cp "$acl" /run/helm/users.acl
chmod 600 /run/helm/users.acl
exec redis-server /etc/helm/redis.conf
