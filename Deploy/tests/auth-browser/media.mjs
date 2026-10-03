import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Observe the real application peer connection without replacing its transport. */
export async function observeMedia(page, evidence) {
  const channels = [];
  const snapshots = [];
  evidence.mediaChannels = channels;
  evidence.mediaSnapshots = snapshots;
  page.on("websocket", (socket) => {
    const path = new URL(socket.url()).pathname;
    if (!path.startsWith("/stream/")) return;
    const channel = { path, received: [], sent: [], closed: false };
    channels.push(channel);
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (channel.sent.length < 16) channel.sent.push(frame.type);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (channel.received.length >= 16) return;
      channel.received.push(
        frame.type === "streamState"
          ? {
              type: frame.type,
              sessionId: frame.sessionId,
              pageEpoch: frame.pageEpoch,
              privacyEpoch: frame.privacyEpoch,
              mediaGeneration: frame.mediaGeneration,
              viewGeneration: frame.viewGeneration,
              captureState: frame.captureState,
              iceServerCount: frame.iceServers?.length,
            }
          : { type: frame.type, code: frame.code },
      );
    });
    socket.on("close", () => {
      channel.closed = true;
    });
    socket.on("socketerror", () => {
      channel.error = true;
    });
  });
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (
      !/^\/api\/v1\/browser-sessions\/[^/]+(?:\/view-tickets)?$/.test(path) ||
      snapshots.length >= 20
    )
      return;
    const body = await response.json().catch(() => ({}));
    snapshots.push({
      path,
      status: response.status(),
      id: body.id,
      pageEpoch: body.pageEpoch,
      privacyEpoch: body.privacyEpoch,
      mediaGeneration: body.mediaGeneration,
      viewGeneration: body.viewGeneration,
      code: body.code,
    });
  });
  await page.addInitScript(() => {
    const connections = [];
    window.__acceptancePeerConnections = connections;
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args) {
        const connection = new target(...args);
        connections.push(connection);
        return connection;
      },
    });
  });
}

export async function verifyMediaAndControl(page, evidence) {
  const failures = [];
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (
      !path.startsWith("/api/v1/browser-sessions/") ||
      response.status() < 400
    )
      return;
    const body = await response.json().catch(() => ({}));
    failures.push({ path, status: response.status(), code: body.code });
  });
  evidence.mediaFailures = failures;
  await page
    .getByText("Живой просмотр", { exact: true })
    .waitFor({ timeout: 40_000 });
  const media = await page.evaluate(async () => {
    const video = document.querySelector("hg-remote-browser video");
    const reports = [];
    for (const connection of window.__acceptancePeerConnections ?? []) {
      const stats = await connection.getStats();
      for (const stat of stats.values()) {
        if (stat.type !== "inbound-rtp" || stat.kind !== "video") continue;
        const codec = stats.get(stat.codecId);
        const transport = stats.get(stat.transportId);
        const pair = transport && stats.get(transport.selectedCandidatePairId);
        const local = pair && stats.get(pair.localCandidateId);
        reports.push({
          codec: codec?.mimeType,
          decodedFrames: stat.framesDecoded,
          candidateType: local?.candidateType,
        });
      }
    }
    return {
      width: video?.videoWidth,
      height: video?.videoHeight,
      frames: video?.getVideoPlaybackQuality().totalVideoFrames,
      reports,
    };
  });
  assert.equal(media.width, 1280);
  assert.equal(media.height, 720);
  assert.ok(media.frames > 0, "The application decodes real video frames");
  assert.ok(
    media.reports.some(
      (report) =>
        report.codec === "video/H264" &&
        report.decodedFrames > 0 &&
        report.candidateType === "relay",
    ),
    "The application consumes H264 through TURN relay",
  );
  evidence.applicationMedia = { status: "PASS", ...media };
  await page.screenshot({
    path: "/evidence/native-live-view.png",
    fullPage: true,
  });

  const sent = new Set();
  const acknowledged = new Set();
  const connected = (socket) => {
    if (!new URL(socket.url()).pathname.startsWith("/stream/v1/input")) return;
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "input" && frame.action?.key === "ArrowDown")
        sent.add(frame.inputSequence);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "inputAck") acknowledged.add(frame.inputSequence);
    });
  };
  page.on("websocket", connected);
  try {
    await page
      .getByRole("button", { name: "Взять управление", exact: true })
      .click();
    const input = page.getByRole("textbox", {
      name: "Управление удалённым браузером.",
      exact: false,
    });
    await input.waitFor({ timeout: 30_000 });
    await input.press("ArrowDown");
    const deadline = Date.now() + 10_000;
    while (
      (!sent.size ||
        ![...sent].every((sequence) => acknowledged.has(sequence))) &&
      Date.now() < deadline
    ) {
      await delay(100);
    }
    assert.ok(
      sent.size > 0 &&
        [...sent].every((sequence) => acknowledged.has(sequence)),
      "The worker acknowledges the actual ArrowDown input through the API gateway",
    );
    await page
      .getByRole("button", { name: "Вернуть агенту", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Взять управление", exact: true })
      .waitFor({ timeout: 30_000 });
    evidence.applicationControl = {
      status: "PASS",
      inputSent: "ArrowDown",
      acknowledgedInputs: sent.size,
    };
  } finally {
    page.off("websocket", connected);
  }
}
