ARG REDIS_BASE_IMAGE=redis:8.4.6-alpine@sha256:0b0ae6770e7d416846dca4227382538fe4cc7e002e4feb04e4ade5fa851d920c
FROM ${REDIS_BASE_IMAGE}
RUN apk add --no-cache jq && chown 10001:10001 /data
COPY Deploy/redis/redis.conf /etc/helm/redis.conf
COPY --chmod=755 Deploy/redis/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/redis/healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
