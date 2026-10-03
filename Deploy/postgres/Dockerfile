ARG POSTGRES_BASE_IMAGE=postgres:18.3-bookworm@sha256:80630f83606d8db77d30b3851b16a9f78be2d0d4dda6f7b82a1fdca5ebe3acba
FROM ${POSTGRES_BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends jq openssl && \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=755 Deploy/postgres/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/postgres/healthcheck /opt/helm/bin/healthcheck
COPY --chmod=755 Deploy/postgres/init-databases.sh /docker-entrypoint-initdb.d/10-helm-databases.sh
COPY Deploy/postgres/init-databases.sql /opt/helm/init-databases.sql
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
CMD ["postgres"]
