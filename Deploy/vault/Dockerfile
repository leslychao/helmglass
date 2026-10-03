ARG VAULT_BASE_IMAGE=hashicorp/vault:2.1.1@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2
FROM ${VAULT_BASE_IMAGE}
USER root
RUN apk add --no-cache jq curl \
    && mkdir -p /vault/data /opt/helm/bin \
    && chown 10001:10001 /vault/data
COPY Deploy/vault/server.hcl /etc/helm/vault.hcl
COPY --chmod=755 Deploy/vault/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/vault/healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
