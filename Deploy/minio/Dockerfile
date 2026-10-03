ARG NODE_IMAGE=node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
FROM quay.io/minio/aistor/minio:RELEASE.2026-09-19T17-05-25Z@sha256:107cf2014a9583c74c11e3cdbd6903d89c2244355886b89ce532f4ecae9c23f3 AS aistor
FROM ${NODE_IMAGE}
COPY --from=aistor /usr/bin/minio /usr/bin/minio
COPY --from=aistor /licenses /usr/share/licenses/minio
RUN groupadd --gid 10001 helm && useradd --uid 10001 --gid 10001 --no-create-home helm \
    && mkdir -p /data1 /data2 /data3 /data4 && chown 10001:10001 /data1 /data2 /data3 /data4
COPY Deploy/minio/bootstrap.mjs /opt/helm/minio/bootstrap.mjs
COPY Deploy/minio/disks.mjs /opt/helm/minio/disks.mjs
COPY --chmod=755 Deploy/minio/healthcheck /opt/helm/bin/healthcheck
ENV HOME=/run/helm
USER 10001:10001
EXPOSE 9000
ENTRYPOINT ["node", "/opt/helm/minio/bootstrap.mjs"]
