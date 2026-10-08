FROM node:24.17.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.17.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location https://github.com/novnc/noVNC/archive/refs/tags/v1.7.0.tar.gz -o /tmp/novnc.tar.gz \
    && mkdir /opt/novnc && tar -xzf /tmp/novnc.tar.gz --strip-components=1 -C /opt/novnc \
    && rm /tmp/novnc.tar.gz && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY seccomp-profile.json ./seccomp-profile.json
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8090
CMD ["node", "dist/server.js"]
