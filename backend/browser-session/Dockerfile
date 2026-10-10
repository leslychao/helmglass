FROM node:24.17.0-bookworm-slim AS vnc
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl patch cmake g++ make pkg-config libpam0g-dev libjpeg62-turbo-dev \
    zlib1g-dev libpixman-1-dev libx11-dev libxext-dev libxtst-dev libxdamage-dev libxfixes-dev libxrandr-dev \
    && rm -rf /var/lib/apt/lists/*
COPY browser-session/patches/tigervnc-clipboard.patch /tmp/tigervnc-clipboard.patch
COPY browser-session/patches/tigervnc-keyboard.patch /tmp/tigervnc-keyboard.patch
RUN curl --fail --location https://github.com/TigerVNC/tigervnc/archive/refs/tags/v1.15.0.tar.gz -o /tmp/vnc.tar.gz \
    && mkdir /tmp/vnc && tar -xzf /tmp/vnc.tar.gz --strip-components=1 -C /tmp/vnc \
    && patch --fuzz=0 -d /tmp/vnc -p1 < /tmp/tigervnc-clipboard.patch \
    && patch --fuzz=0 -d /tmp/vnc -p1 < /tmp/tigervnc-keyboard.patch \
    && cmake -S /tmp/vnc -B /tmp/vnc/build -DCMAKE_BUILD_TYPE=Release -DBUILD_VIEWER=OFF -DENABLE_NLS=OFF \
    && cmake --build /tmp/vnc/build --target x0vncserver -j2

FROM node:24.17.0-bookworm-slim AS build
COPY session-records /session-records
WORKDIR /app
COPY browser-session/package.json browser-session/package-lock.json browser-session/.npmrc ./
RUN npm ci
COPY browser-session/tsconfig.json ./
COPY browser-session/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.17.0-bookworm-slim
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb x11-utils x11-xkb-utils iptables util-linux fonts-noto-core fonts-noto-cjk libpam0g libjpeg62-turbo libxtst6 libxdamage1 libxfixes3 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=vnc /tmp/vnc/build/unix/x0vncserver/x0vncserver /usr/local/bin/x0vncserver
COPY browser-session/entrypoint.sh browser-session/start-browser.sh ./
RUN chmod 755 entrypoint.sh start-browser.sh
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
