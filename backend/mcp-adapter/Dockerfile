ARG NODE_IMAGE=node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
ARG FRONTEND_IMAGE=helmglass-nginx:0.1.0
FROM ${FRONTEND_IMAGE} AS frontend
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=frontend /opt/helm/widget/index.html /opt/helm/widget/index.html
COPY --chmod=755 healthcheck /opt/helm/bin/healthcheck
RUN groupadd --gid 10001 helm && useradd --uid 10001 --gid 10001 --no-create-home helm
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/src/bootstrap.js"]
