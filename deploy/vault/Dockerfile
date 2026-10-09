FROM hashicorp/vault:1.21.4
USER root
RUN apk add --no-cache openssl jq
COPY vault.hcl /vault/config/helmglass.hcl
COPY start.sh bootstrap.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/start.sh /usr/local/bin/bootstrap.sh
ENTRYPOINT ["/usr/local/bin/start.sh"]
