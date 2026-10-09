import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { pipeline } from "node:stream";
import ipaddr from "ipaddr.js";

const allowedPorts = new Set([80, 443]);
const maxConnections = 128;
let activeConnections = 0;

async function publicTarget(host: string, port: number): Promise<string> {
  if (!allowedPorts.has(port) || host.length > 253 || !host || host.includes("%")) {
    throw new Error("Destination rejected");
  }
  const addresses = await lookup(host.replace(/^\[|\]$/g, ""), { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => {
    const parsed = ipaddr.process(address);
    return parsed.range() !== "unicast";
  })) {
    throw new Error("Only public internet addresses are allowed");
  }
  // The connection uses this resolved address, never a second hostname lookup.
  const first = addresses[0];
  if (!first) throw new Error("Destination unavailable");
  return first.address;
}

const server = http.createServer(async (request, response) => {
  try {
    const target = new URL(request.url ?? "");
    if (target.protocol !== "http:" || target.username || target.password) {
      throw new Error("Invalid proxy request");
    }
    const port = Number(target.port || 80);
    const address = await publicTarget(target.hostname, port);
    if (response.destroyed || request.aborted) return;
    const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request({
      host: address, port, method: request.method,
      path: target.pathname + target.search, headers,
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      pipeline(incoming, response, () => upstream.destroy());
    });
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Upstream unavailable");
    });
    request.on("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    pipeline(request, upstream, () => {});
  } catch {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("Destination denied");
  }
});

server.on("connect", async (request, client, head) => {
  try {
    const target = new URL(`http://${request.url ?? ""}`);
    if (target.username || target.password || target.pathname !== "/") throw new Error("Invalid CONNECT");
    const port = Number(target.port || 443);
    const address = await publicTarget(target.hostname, port);
    if (client.destroyed) return;
    const upstream = net.connect({ host: address, port });
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  } catch {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  }
});
server.on("upgrade", async (request, client, head) => {
  try {
    const target = new URL(request.url ?? "");
    if (!["http:", "ws:"].includes(target.protocol) || target.username || target.password || request.headers.upgrade?.toLowerCase() !== "websocket") throw new Error("Invalid WebSocket destination");
    const port = Number(target.port || 80);
    const address = await publicTarget(target.hostname, port);
    if (client.destroyed) return;
    const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
    delete headers["proxy-authorization"]; delete headers["proxy-connection"];
    const upstreamRequest = http.request({ host: address, port, method: "GET", path: target.pathname + target.search, headers });
    upstreamRequest.on("upgrade", (response, upstream, upstreamHead) => {
      let handshake = "HTTP/1.1 101 Switching Protocols\r\n";
      for (let index = 0; index < response.rawHeaders.length; index += 2) handshake += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
      client.write(handshake + "\r\n");
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
      client.on("error", () => upstream.destroy()); client.on("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy()); upstream.on("close", () => client.destroy());
    });
    upstreamRequest.on("response", (response) => { response.resume(); client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
    upstreamRequest.on("error", () => client.destroy());
    client.on("error", () => upstreamRequest.destroy()); client.on("close", () => upstreamRequest.destroy());
    upstreamRequest.end();
  } catch { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
});
server.on("connection", (socket) => {
  if (activeConnections >= maxConnections) { socket.destroy(); return; }
  activeConnections += 1;
  socket.once("close", () => { activeConnections -= 1; });
});
server.maxHeadersCount = 100;
server.headersTimeout = 15_000;
server.requestTimeout = 0;
server.listen(3128, "0.0.0.0");
