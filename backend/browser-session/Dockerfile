FROM node:24.17.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.17.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc x11-utils iptables util-linux fonts-noto-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY entrypoint.sh start-browser.sh ./
RUN chmod 755 entrypoint.sh start-browser.sh
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
