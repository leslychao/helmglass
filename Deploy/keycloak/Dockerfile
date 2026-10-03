ARG KEYCLOAK_BASE_IMAGE=quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc
ARG UBI_BUILD_IMAGE=registry.access.redhat.com/ubi9:9.8@sha256:094ea2ecfd3225af8f93807b99daa9ff33710fc705ebdf6e8466f46ed605585c
ARG VAULT_CLI_IMAGE=hashicorp/vault:2.1.1@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2
FROM ${VAULT_CLI_IMAGE} AS vault-cli
FROM ${UBI_BUILD_IMAGE} AS tools
RUN mkdir -p /mnt/rootfs && \
    dnf install --installroot /mnt/rootfs jq curl-minimal --releasever 9 \
      --setopt install_weak_deps=false --nodocs -y && \
    dnf --installroot /mnt/rootfs clean all && \
    rpm --root /mnt/rootfs -e --nodeps setup
FROM ${KEYCLOAK_BASE_IMAGE} AS builder
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true --metrics-enabled=true \
    --http-relative-path=/auth --http-management-relative-path=/
FROM ${KEYCLOAK_BASE_IMAGE}
USER root
COPY --from=tools /mnt/rootfs /
COPY --from=builder /opt/keycloak/ /opt/keycloak/
COPY --from=vault-cli /bin/vault /usr/local/bin/vault
RUN rmdir /opt/keycloak/data && ln -s /run/helm/keycloak-data /opt/keycloak/data
COPY Deploy/runtime/vault-bootstrap /opt/helm/bin/vault-bootstrap
COPY --chmod=755 Deploy/keycloak/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/keycloak/healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
