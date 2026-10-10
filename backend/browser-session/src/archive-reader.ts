import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { artifactResponse, operationReceipt } from "./session-records.js";

// The node mounts the original volume read-only, on an internal network without an egress.
// This entry point never imports the browser runtime, starts Chromium, or accepts writes.
const token = z.string().min(32).parse(process.env["SESSION_TOKEN"]);
const directory = process.env["DATA_DIR"] ?? "/data";
const filename = path.join(directory, "session.sqlite");
const db = existsSync(filename) ? new DatabaseSync(filename, { readOnly: true }) : undefined;
const server = http.createServer(async (request, response) => {
  try {
    const supplied = request.headers["x-worker-token"];
    if (typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(token)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      response.writeHead(401); response.end(); return;
    }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    const url = new URL(request.url ?? "/", "http://archive");
    if (url.pathname === "/health") {
      response.writeHead(200); response.end('{"stopped":true}'); return;
    }
    if (await artifactResponse(db, directory, url, response)) return;
    const match = /^\/commands\/([^/]+)$/.exec(url.pathname);
    if (match?.[1] && db) {
      const receipt = operationReceipt(db, z.uuid().parse(match[1]), true);
      response.writeHead(receipt ? 200 : 404, { "Content-Type": "application/json" });
      response.end(JSON.stringify(receipt ?? { error: "Operation not found" })); return;
    }
    response.writeHead(404); response.end();
  } catch {
    if (response.headersSent) response.destroy();
    else { response.writeHead(500); response.end('{"error":"Stored data unavailable"}'); }
  }
});
server.requestTimeout = 360_000;
server.listen(8080, "0.0.0.0");
