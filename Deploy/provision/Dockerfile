ARG NODE_IMAGE=node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
ARG VAULT_CLI_IMAGE=hashicorp/vault:2.1.1@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2
FROM ${VAULT_CLI_IMAGE} AS vault-cli
FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS minio-admin
WORKDIR /build
COPY Deploy/provision/minio-admin/go.mod Deploy/provision/minio-admin/go.sum ./
RUN go mod download
COPY Deploy/provision/minio-admin/*.go ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o /minio-admin .
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends jq ca-certificates openssl coreutils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 helm && useradd --uid 10001 --gid helm --no-create-home helm
WORKDIR /opt/helm/provision
COPY Deploy/provision/package.json Deploy/provision/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY Deploy/provision/src ./src
COPY Deploy/redis/users.acl.template /opt/helm/redis/users.acl.template
COPY --from=vault-cli /bin/vault /usr/local/bin/vault
COPY --from=minio-admin /minio-admin /opt/helm/bin/minio-admin
COPY Deploy/runtime/vault-bootstrap /opt/helm/bin/vault-bootstrap
COPY --chmod=755 Deploy/provision/entrypoint.sh /opt/helm/bin/entrypoint
USER 10001:10001
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
CMD ["realm"]
