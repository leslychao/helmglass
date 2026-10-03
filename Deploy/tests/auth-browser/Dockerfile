ARG BROWSER_IMAGE=helmglass-browser-worker:0.1.0
FROM ${BROWSER_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=755 Deploy/tests/auth-browser/entrypoint.sh /opt/helm/test-browser
COPY Deploy/tests/auth-browser/browser.mjs Deploy/tests/auth-browser/mcp.mjs Deploy/tests/auth-browser/media.mjs Deploy/tests/auth-browser/cabinet.mjs Deploy/tests/auth-browser/widget-resource.mjs Deploy/tests/auth-browser/private-login.mjs /opt/helm/
USER 10001:10001
ENTRYPOINT ["/opt/helm/test-browser"]
