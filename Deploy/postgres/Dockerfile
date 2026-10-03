ARG POSTGRES_BASE_IMAGE=postgres:18.3-bookworm@sha256:80630f83606d8db77d30b3851b16a9f78be2d0d4dda6f7b82a1fdca5ebe3acba
FROM ${POSTGRES_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends jq openssl && \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=755 Deploy/postgres/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/postgres/healthcheck /opt/helm/bin/healthcheck
COPY --chmod=755 Deploy/postgres/init-databases.sh /docker-entrypoint-initdb.d/10-helm-databases.sh
COPY Deploy/postgres/init-databases.sql /opt/helm/init-databases.sql
COPY --chmod=755 Deploy/backup-crypto/backup-crypto /opt/helm/bin/backup-crypto
COPY --chmod=755 Deploy/backup-crypto/backup-file /opt/helm/bin/backup-file
COPY --chmod=755 Deploy/postgres/archive-wal /opt/helm/bin/archive-wal
COPY --chmod=755 Deploy/postgres/backup-base /opt/helm/bin/backup-base
COPY --chmod=755 Deploy/postgres/restore-wal /opt/helm/bin/restore-wal
COPY --chmod=755 Deploy/postgres/restore-base /opt/helm/bin/restore-base
COPY --chmod=755 Deploy/postgres/recover-and-stop /opt/helm/bin/recover-and-stop
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
CMD ["postgres"]
