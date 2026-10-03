FROM coturn/coturn:4.18.0-r0@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3
USER root
RUN apt-get update && apt-get install -y --no-install-recommends jq libcap2-bin \
    && rm -rf /var/lib/apt/lists/* && \
    getcap /usr/bin/turnserver && setcap -r /usr/bin/turnserver && \
    groupadd --gid 10001 helm && useradd --uid 10001 --gid 10001 --no-create-home helm
COPY --chmod=755 Deploy/coturn/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/coturn/healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
