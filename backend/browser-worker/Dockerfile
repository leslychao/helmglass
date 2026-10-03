ARG NODE_IMAGE=node:24.17.0-trixie-slim@sha256:9022946fb57e6fb6a2503931470deba4b49db02bfc8f587f93007fd33ef54415
FROM rust:1.94.0-trixie@sha256:f17e723020f87c1b4ac4ff6d73c9dfbb7d5cb978754c76641e47337d65f61e12 AS media-build
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev \
    libjson-glib-dev libx11-dev ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ADD --checksum=sha256:3d2da3ece81e7964ec37ad4f2efc99dae3d51d65ccafa9ac7c709e247ca30c39 \
    https://codeload.github.com/GStreamer/gst-plugins-rs/tar.gz/refs/tags/0.15.3 /build/upstream.tar.gz
RUN tar -xzf upstream.tar.gz && \
    cd gst-plugins-rs-0.15.3 && \
    cargo build --locked --release --no-default-features -p gst-plugin-webrtc -p gst-plugin-webrtc-signalling
RUN cd gst-plugins-rs-0.15.3 && cargo build --locked --release --no-default-features -p gst-plugin-rtp
COPY native/media-helper.c /build/media-helper.c
RUN cc -std=c17 -O2 -Wall -Wextra -Werror /build/media-helper.c -o /build/helm-media-helper \
    $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-video-1.0 json-glib-1.0 x11)

FROM ${NODE_IMAGE} AS node-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
COPY patches ./patches
RUN npm run patch:upstream
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    DISPLAY=:99 XDG_RUNTIME_DIR=/runtime XDG_CACHE_HOME=/runtime/cache \
    HOME=/runtime PULSE_SERVER=unix:/runtime/pulse/native \
    STAGING_DIRECTORY=/runtime/sessions GST_PLUGIN_PATH=/usr/local/lib/gstreamer-1.0
COPY --from=media-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt update && \
    apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt install -y --no-install-recommends \
    tini xvfb openbox x11-utils pulseaudio ffmpeg openssl ca-certificates \
    gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-libav gstreamer1.0-nice \
    libjson-glib-1.0-0 libx11-6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=node-build /app/package.json /app/package-lock.json ./
COPY --from=node-build /app/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps chromium && \
    groupadd --gid 10001 helm && useradd --uid 10001 --gid 10001 --no-create-home helm && \
    mkdir -p /runtime /usr/local/lib/gstreamer-1.0 && chown 10001:10001 /runtime && \
    dpkg-query -W > /app/runtime-packages.txt
COPY --from=media-build /build/gst-plugins-rs-0.15.3/target/release/libgstrswebrtc.so /usr/local/lib/gstreamer-1.0/
COPY --from=media-build /build/gst-plugins-rs-0.15.3/target/release/libgstrsrtp.so /usr/local/lib/gstreamer-1.0/
COPY --from=media-build /build/gst-plugins-rs-0.15.3/target/release/gst-webrtc-signalling-server /usr/local/bin/
COPY --from=media-build /build/helm-media-helper /usr/local/bin/
COPY --from=node-build /app/dist ./dist
COPY --chmod=755 healthcheck /opt/helm/bin/healthcheck
USER 10001:10001
EXPOSE 8081
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/src/bootstrap.js"]
