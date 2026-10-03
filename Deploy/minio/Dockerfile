ARG NODE_IMAGE=node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
FROM ${NODE_IMAGE}
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64
ADD --chmod=755 --checksum=sha256:53e2a2cb16c5366ea6fbbc479c19ddb4c6a0948273e752f740fb1fbf27bb817c https://github.com/minio/minio/releases/download/RELEASE.2025-04-22T22-12-26Z/minio.linux-amd64.RELEASE.2025-04-22T22-12-26Z /usr/bin/minio
ADD --checksum=sha256:0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0 https://raw.githubusercontent.com/minio/minio/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e/LICENSE /usr/share/licenses/minio/LICENSE
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="0d7408fc9969caf07de6a8c3a84f9fbb10a6739e" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
RUN groupadd --gid 10001 helm && useradd --uid 10001 --gid 10001 --no-create-home helm \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data
COPY Deploy/minio/bootstrap.mjs /opt/helm/minio/bootstrap.mjs
COPY Deploy/minio/disks.mjs /opt/helm/minio/disks.mjs
COPY --chmod=755 Deploy/minio/healthcheck /opt/helm/bin/healthcheck
ENV HOME=/run/helm
USER 10001:10001
EXPOSE 9000
ENTRYPOINT ["node", "/opt/helm/minio/bootstrap.mjs"]
