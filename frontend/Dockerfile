ARG NODE_BASE_IMAGE=node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
ARG NGINX_BASE_IMAGE=nginx:1.30.5-alpine3.24@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/tools/patch-gst.mjs ./tools/patch-gst.mjs
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit --no-fund
COPY frontend/tools ./tools
COPY frontend/angular.json frontend/tsconfig*.json ./
COPY frontend/src ./src
COPY frontend/public ./public
RUN --mount=type=cache,id=helmglass-angular,target=/app/.angular/cache,sharing=locked npm run build

FROM ${NGINX_BASE_IMAGE}
COPY --from=build /app/dist/helm-glass/browser /usr/share/nginx/html
COPY --from=build /app/dist/widget/index.html /opt/helm/widget/index.html
COPY Deploy/nginx/nginx.conf /etc/helm/nginx.conf.template
COPY --chmod=755 Deploy/nginx/entrypoint.sh /opt/helm/bin/start-nginx
COPY --chmod=755 Deploy/nginx/healthcheck /opt/helm/bin/healthcheck
USER 101:101
ENTRYPOINT ["/opt/helm/bin/start-nginx"]
