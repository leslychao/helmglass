import { WebSocket, createWebSocketStream } from "ws";

export type ViewerCloseReason = "session_closed" | "control_changed" | "account_changed"
  | "grant_revoked" | "viewer_replaced";
type Side = "client" | "browser";
export type ViewerDisconnect = {
  reason: ViewerCloseReason | "socket_closed" | "socket_error" | "stream_error" | "heartbeat_timeout";
  side: Side | "server";
  closeCode?: number;
  durationMs: number;
};

// This bridge owns both transports and their liveness; closing it never closes Chromium.
export function bridgeViewer(
  client: WebSocket, browser: WebSocket, onClose: (event: ViewerDisconnect) => void,
): { close: (reason: ViewerCloseReason) => void } {
  const clientStream = createWebSocketStream(client);
  const browserStream = createWebSocketStream(browser);
  const started = Date.now();
  let closed = false;
  let sequence = 0;
  let probe: Buffer | undefined;
  let clientAlive = true;
  let browserAlive = true;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const finish = (reason: ViewerDisconnect["reason"], side: ViewerDisconnect["side"], closeCode?: number) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat); clearTimeout(deadline);
    client.off("pong", clientPong); browser.off("pong", browserPong);
    clientStream.destroy(); browserStream.destroy();
    client.terminate(); browser.terminate();
    onClose({ reason, side, ...(closeCode === undefined ? {} : { closeCode }), durationMs: Date.now() - started });
  };
  const pong = (side: Side, payload: Buffer) => {
    if (!probe?.equals(payload)) return;
    if (side === "client") clientAlive = true;
    else browserAlive = true;
    if (clientAlive && browserAlive) { clearTimeout(deadline); deadline = undefined; probe = undefined; }
  };
  const clientPong = (payload: Buffer) => pong("client", payload);
  const browserPong = (payload: Buffer) => pong("browser", payload);
  client.on("pong", clientPong); browser.on("pong", browserPong);

  // Native control frames cross the proxies without entering the RFB byte stream.
  const heartbeat = setInterval(() => {
    if (client.readyState !== WebSocket.OPEN || browser.readyState !== WebSocket.OPEN) return;
    probe = Buffer.from(String(++sequence));
    clientAlive = false; browserAlive = false;
    deadline = setTimeout(() => finish("heartbeat_timeout", clientAlive ? "browser" : "client"), 10_000);
    deadline.unref();
    client.ping(probe, undefined, error => { if (error) finish("socket_error", "client"); });
    browser.ping(probe, undefined, error => { if (error) finish("socket_error", "browser"); });
  }, 20_000);
  heartbeat.unref();

  client.on("close", code => finish("socket_closed", "client", code));
  browser.on("close", code => finish("socket_closed", "browser", code));
  client.on("error", () => finish("socket_error", "client"));
  browser.on("error", () => finish("socket_error", "browser"));
  clientStream.on("error", () => finish("stream_error", "client"));
  browserStream.on("error", () => finish("stream_error", "browser"));
  clientStream.pipe(browserStream); browserStream.pipe(clientStream);
  return { close: reason => finish(reason, "server") };
}
