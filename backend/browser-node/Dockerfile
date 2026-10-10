FROM node:24.17.0-bookworm-slim AS build
COPY session-records /session-records
WORKDIR /app
COPY browser-node/package.json browser-node/package-lock.json browser-node/.npmrc ./
RUN npm ci
COPY browser-node/tsconfig.json ./
COPY browser-node/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.17.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl patch util-linux \
    && curl --fail --location https://github.com/novnc/noVNC/archive/refs/tags/v1.7.0.tar.gz -o /tmp/novnc.tar.gz \
    && mkdir /opt/novnc && tar -xzf /tmp/novnc.tar.gz --strip-components=1 -C /opt/novnc \
    && rm /tmp/novnc.tar.gz && rm -rf /var/lib/apt/lists/*
COPY browser-node/patches/novnc-clipboard.patch /tmp/novnc-clipboard.patch
RUN patch --fuzz=0 -d /opt/novnc -p1 < /tmp/novnc-clipboard.patch && rm /tmp/novnc-clipboard.patch
COPY browser-node/src/viewer-client.js /opt/novnc/helm-viewer.js
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY browser-node/seccomp-profile.json ./seccomp-profile.json
RUN mkdir /data && chown node:node /data
COPY browser-node/entrypoint.sh ./entrypoint.sh
RUN chmod 755 entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
EXPOSE 8090
CMD ["node", "dist/server.js"]
