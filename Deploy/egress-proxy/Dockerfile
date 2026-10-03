ARG NODE_IMAGE=node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
FROM ${NODE_IMAGE} AS squid-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libltdl-dev libcap2-dev libxml2-dev libcrypt-dev pkg-config ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ADD --checksum=sha256:e3bd613b91b1c498ec2992276063342a85cd6edddd5521294e04f44bc055da9b \
    https://github.com/squid-cache/squid/releases/download/SQUID_7_7/squid-7.7.tar.xz /build/squid.tar.xz
RUN tar -xf squid.tar.xz && cd squid-7.7 && \
    ./configure --prefix=/usr/local --sysconfdir=/etc/squid --localstatedir=/run/squid \
      --with-logdir=/run/squid --with-default-user=helm --enable-auth-basic=NCSA \
      --disable-auth-digest --disable-auth-negotiate --disable-auth-ntlm \
      --disable-wccp --disable-wccpv2 --disable-snmp --disable-icmp --disable-cache-digests \
      --disable-icap-client --disable-ecap --without-openssl && \
    make -j2 && make install DESTDIR=/install

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq openssl ca-certificates libltdl7 libcap2 libxml2 libcrypt1 \
    && rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 helm && useradd --uid 10001 --gid 10001 --no-create-home helm
COPY --from=squid-build /install/usr/local /usr/local
COPY --from=squid-build /install/etc/squid/mime.conf /etc/squid/mime.conf
COPY Deploy/egress-proxy/squid.conf /etc/squid/squid.conf
COPY --chmod=755 Deploy/egress-proxy/entrypoint.sh /opt/helm/bin/entrypoint
COPY --chmod=755 Deploy/egress-proxy/healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
EXPOSE 3128
ENTRYPOINT ["/opt/helm/bin/entrypoint"]
