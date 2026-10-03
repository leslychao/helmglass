ARG OAUTH_BASE_IMAGE=quay.io/oauth2-proxy/oauth2-proxy:v7.15.5@sha256:8498b0d0ef0a7b29686414000a08aee467f02d0299c9ed1e006a8f33fc017916
ARG WRAPPER_BASE_IMAGE=node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
ARG VAULT_CLI_IMAGE=hashicorp/vault:2.1.1@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2
FROM ${OAUTH_BASE_IMAGE} AS oauth
FROM ${VAULT_CLI_IMAGE} AS vault-cli
FROM ${WRAPPER_BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends jq curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 helm && useradd --uid 10001 --gid 10001 --no-create-home helm
COPY --from=oauth /bin/oauth2-proxy /usr/local/bin/oauth2-proxy
COPY --from=vault-cli /bin/vault /usr/local/bin/vault
COPY Deploy/runtime/vault-bootstrap /opt/helm/bin/vault-bootstrap
COPY --chmod=755 Deploy/oauth2-proxy/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/oauth2-proxy/healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
