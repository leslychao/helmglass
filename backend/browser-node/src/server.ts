import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";
import { z } from "zod";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const config = {
  token: required("WORKER_TOKEN"), nodeId: z.uuid().parse(required("NODE_ID")),
  capacity: z.coerce.number().int().min(1).max(128).parse(required("BROWSER_CAPACITY")),
  docker: z.url().parse(required("DOCKER_HOST")),
  sessionImage: required("BROWSER_SESSION_IMAGE"), egressImage: required("BROWSER_EGRESS_IMAGE"),
  outboundNetwork: required("BROWSER_EGRESS_NETWORK"), self: required("HOSTNAME"),
  publicOrigin: new URL(z.url().parse(required("PUBLIC_URL"))).origin,
  data: process.env["DATA_DIR"] ?? "/data", assets: process.env["NOVNC_DIR"] ?? "/opt/novnc",
};
const encryptionKey = Buffer.from(required("PROFILE_ENCRYPTION_KEY"), "base64");
if (encryptionKey.length !== 32) throw new Error("PROFILE_ENCRYPTION_KEY must encode 32 bytes");
const seccompProfile = JSON.stringify(JSON.parse(await readFile(new URL("../seccomp-profile.json", import.meta.url), "utf8")));
await mkdir(config.data, { recursive: true });
const db = new DatabaseSync(path.join(config.data, "node.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, owner TEXT NOT NULL, encrypted BLOB NOT NULL); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);");

const Policy = z.object({ controlEpoch: z.number().int().nonnegative(), owner: z.enum(["CHATGPT", "USER", "NONE"]), privateMode: z.boolean(), controllerId: z.string().max(200).optional() });
const Session = z.object({
  id: z.uuid(), ownerId: z.string().min(1).max(200), taskId: z.string().max(200).optional(),
  startUrl: z.string().max(8192), connectionId: z.string().max(200).optional(), token: z.string(),
  status: z.enum(["STARTING", "LIVE", "CLOSING", "CLOSED", "UNKNOWN", "LOST"]),
  networkId: z.string().optional(), containerId: z.string().optional(), egressId: z.string().optional(),
  address: z.string().optional(), policy: Policy,
});
type Session = z.infer<typeof Session>;
type Policy = z.infer<typeof Policy>;
const CreateSession = z.object({ sessionId: z.uuid(), ownerId: z.string().min(1).max(200), taskId: z.string().max(200).optional(), startUrl: z.string().max(8192), connectionId: z.string().max(200).optional() }).strict();
const DockerIdentity = z.object({ Id: z.string() });
const DockerInspect = z.object({ Id: z.string(), State: z.object({ Running: z.boolean() }), NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }) });
const RuntimeState = z.object({ status: z.enum(["STARTING", "LIVE", "LOST"]), currentUrl: z.string().optional(), navigationError: z.string().optional(), controlEpoch: z.number().int().nonnegative(), controlOwner: z.enum(["CHATGPT", "USER", "NONE"]), privateMode: z.boolean(), controllerId: z.string().optional() });
const AccessBinding = z.object({ channel: z.enum(["WEB", "MCP"]), grantId: z.string().min(1).max(200) }).strict();
const Ticket = z.object({ ticket: z.string().min(32).max(512), role: z.enum(["VIEWER", "CONTROLLER"]), viewerId: z.string().min(1).max(200), expiresAt: z.string().datetime(), access: AccessBinding });
type Ticket = z.infer<typeof Ticket>;
const tickets = new Map<string, Ticket & { sessionId: string }>();
const viewers = new Map<string, Set<{ socket: WebSocket; upstream: WebSocket; viewerId: string; role: string; access: z.infer<typeof AccessBinding> }>>();
const starting = new Map<string, Promise<Session>>();
const closing = new Map<string, Promise<Session>>();

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, max = 2_097_152): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.length;
    if (length > max) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function authorized(request: IncomingMessage): boolean {
  const token = request.headers["x-worker-token"];
  return typeof token === "string" && Buffer.byteLength(token) === Buffer.byteLength(config.token) && timingSafeEqual(Buffer.from(token), Buffer.from(config.token));
}
function saved(id: string): Session {
  const row = db.prepare("SELECT document FROM sessions WHERE id=?").get(id);
  if (!row || typeof row["document"] !== "string") throw new HttpError(404, "Session not found");
  return Session.parse(JSON.parse(row["document"]));
}
function save(session: Session): Session {
  db.prepare("INSERT INTO sessions(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(session.id, JSON.stringify(session));
  return session;
}
function summaries(): Session[] {
  return db.prepare("SELECT document FROM sessions WHERE json_extract(document,'$.status') != 'CLOSED'").all().map((row) => Session.parse(JSON.parse(z.string().parse(row["document"]))));
}
function summary(session: Session): object {
  return { id: session.id, ownerId: session.ownerId, taskId: session.taskId, nodeId: config.nodeId, status: session.status, controlEpoch: session.policy.controlEpoch, controlOwner: session.policy.owner, privateMode: session.policy.privateMode };
}
async function docker(endpoint: string, method = "GET", value?: unknown): Promise<Response> {
  const response = await fetch(config.docker + endpoint, {
    method, headers: value === undefined ? {} : { "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 404 ? 404 : 502, "Docker operation failed"); }
  return response;
}
async function inspect(name: string): Promise<z.infer<typeof DockerInspect> | undefined> {
  try { return DockerInspect.parse(await (await docker(`/containers/${encodeURIComponent(name)}/json`)).json()); }
  catch (error) { if (error instanceof HttpError && error.status === 404) return undefined; throw error; }
}
async function removeDocker(endpoint: string): Promise<void> {
  try { await docker(endpoint, "DELETE"); } catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
}
async function sessionRequest(session: Session, endpoint: string, method = "GET", value?: unknown): Promise<Response> {
  if (!session.address) throw new HttpError(409, "Browser unavailable");
  const response = await fetch(`http://${session.address}:8080${endpoint}`, {
    method, headers: { "X-Worker-Token": session.token, "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(endpoint.startsWith("/artifacts/") ? 600_000 : endpoint.startsWith("/commands") ? 90_000 : 30_000),
  });
  return response;
}
async function sessionJson(session: Session, endpoint: string, method = "GET", value?: unknown): Promise<unknown> {
  const response = await sessionRequest(session, endpoint, method, value);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(await response.json());
    throw new HttpError(response.status, error.success ? error.data.error : "Browser operation rejected");
  }
  return response.json();
}
function decryptProfile(id: string, owner: string): unknown {
  const row = db.prepare("SELECT encrypted FROM profiles WHERE id=? AND owner=?").get(id, owner);
  if (!row || !(row["encrypted"] instanceof Uint8Array)) throw new HttpError(409, "Saved profile unavailable");
  const encoded = Buffer.from(row["encrypted"]);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, encoded.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${owner}:${id}`));
  decipher.setAuthTag(encoded.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString("utf8"));
}
async function createSession(input: z.infer<typeof CreateSession>): Promise<Session> {
  let session: Session;
  try {
    session = saved(input.sessionId);
    if (session.ownerId !== input.ownerId || session.taskId !== input.taskId) throw new HttpError(409, "Session identity conflict");
    if (session.status !== "STARTING") return session;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    if (db.prepare("SELECT value FROM settings WHERE id='draining'").get()?.["value"] === "true") throw new HttpError(409, "Node does not accept new browsers");
    if (summaries().length >= config.capacity) throw new HttpError(409, "Browser capacity reached");
    if (input.startUrl !== "about:blank" && !["http:", "https:"].includes(new URL(input.startUrl).protocol)) throw new HttpError(400, "Invalid start URL");
    session = save({ id: input.sessionId, ownerId: input.ownerId, taskId: input.taskId, startUrl: input.startUrl, connectionId: input.connectionId, token: randomBytes(32).toString("base64url"), status: "STARTING", policy: { controlEpoch: 0, owner: "NONE", privateMode: false } });
  }
  const prefix = `helm-browser-${session.id}`;
  if (!session.networkId) {
    let network: z.infer<typeof DockerIdentity>;
    try { network = DockerIdentity.parse(await (await docker(`/networks/${prefix}`)).json()); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      network = DockerIdentity.parse(await (await docker("/networks/create", "POST", { Name: prefix, Driver: "bridge", Internal: true, EnableIPv6: false, CheckDuplicate: true, Labels: { "helmglass.node": config.nodeId, "helmglass.session": session.id } })).json());
    }
    session = save({ ...session, networkId: network.Id });
  }
  // The manager joins the isolated network; the browser cannot initiate traffic to it.
  try { await docker(`/networks/${session.networkId}/connect`, "POST", { Container: config.self }); }
  catch (error) { if (!(error instanceof HttpError)) throw error; }
  const manager = await inspect(config.self);
  if (!manager?.NetworkSettings.Networks[prefix]?.IPAddress) throw new HttpError(502, "Manager isolation route unavailable");
  let egress = await inspect(`${prefix}-egress`);
  if (!egress) {
    const created = DockerIdentity.parse(await (await docker(`/containers/create?name=${prefix}-egress`, "POST", {
      Image: config.egressImage, Labels: { "helmglass.node": config.nodeId, "helmglass.session": session.id },
      HostConfig: { NetworkMode: config.outboundNetwork, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Memory: 268_435_456, PidsLimit: 64, LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "1", compress: "false" } } },
    })).json());
    session = save({ ...session, egressId: created.Id });
    await docker(`/networks/${session.networkId}/connect`, "POST", { Container: created.Id });
    await docker(`/containers/${created.Id}/start`, "POST");
    egress = await inspect(created.Id);
  }
  if (!egress) throw new HttpError(502, "Egress container unavailable");
  if (!egress.NetworkSettings.Networks[prefix]?.IPAddress) {
    await docker(`/networks/${session.networkId}/connect`, "POST", { Container: egress.Id });
    egress = await inspect(egress.Id);
    if (!egress) throw new HttpError(502, "Egress container unavailable");
  }
  if (!egress.State.Running) await docker(`/containers/${egress.Id}/start`, "POST");
  const proxyAddress = egress.NetworkSettings.Networks[prefix]?.IPAddress;
  if (!proxyAddress) throw new HttpError(502, "Egress isolation network unavailable");
  let container = await inspect(prefix);
  if (!container) {
    const created = DockerIdentity.parse(await (await docker(`/containers/create?name=${prefix}`, "POST", {
      Image: config.sessionImage, Hostname: "browser", Env: [`SESSION_ID=${session.id}`, `SESSION_TOKEN=${session.token}`, `PROXY_IP=${proxyAddress}`],
      Labels: { "helmglass.node": config.nodeId, "helmglass.session": session.id },
      HostConfig: {
        NetworkMode: prefix, Init: true, ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: ["NET_ADMIN", "CHOWN", "SETUID", "SETGID", "SETPCAP"], SecurityOpt: ["no-new-privileges:true", `seccomp=${seccompProfile}`],
        Memory: 2_147_483_648, ShmSize: 536_870_912, PidsLimit: 256,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m", "/home/node": "rw,nosuid,nodev,size=768m,uid=1000,gid=1000" },
        Mounts: [{ Type: "volume", Source: `${prefix}-data`, Target: "/data" }],
        LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "1", compress: "false" } },
      },
    })).json());
    session = save({ ...session, containerId: created.Id, egressId: egress.Id });
    await docker(`/containers/${created.Id}/start`, "POST");
    container = await inspect(created.Id);
  }
  if (!container || !container.State.Running) return save({ ...session, status: "LOST" });
  const address = container.NetworkSettings.Networks[prefix]?.IPAddress;
  if (!address) throw new HttpError(502, "Browser isolation network unavailable");
  session = save({ ...session, containerId: container.Id, egressId: egress.Id, address });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const profile = session.connectionId ? decryptProfile(session.connectionId, session.ownerId) : undefined;
      const result = z.object({ status: z.enum(["LIVE", "LOST"]) }).parse(await sessionJson(session, "/initialize", "POST", { startUrl: session.startUrl, profile }));
      return save({ ...session, status: result.status });
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return save({ ...session, status: "UNKNOWN" });
}
function disconnectViewers(id: string): void {
  for (const viewer of viewers.get(id) ?? []) { viewer.socket.terminate(); viewer.upstream.terminate(); }
  viewers.delete(id);
  for (const [key, ticket] of tickets) if (ticket.sessionId === id) tickets.delete(key);
}
async function closeSession(session: Session): Promise<Session> {
  const previous = closing.get(session.id);
  if (previous) return previous;
  const completion = finishClose(session.id);
  closing.set(session.id, completion);
  try { return await completion; } finally { closing.delete(session.id); }
}
async function finishClose(id: string): Promise<Session> {
  // A creator owns resources across Docker awaits. Its last write must finish
  // before cleanup can truthfully acknowledge CLOSED, including failed creates.
  try { await starting.get(id); } catch { /* Clean up the creator's partial resources. */ }
  let session = saved(id);
  if (session.status === "CLOSED") return session;
  session = save({ ...session, status: "CLOSING" });
  disconnectViewers(session.id);
  try {
    const container = await inspect(session.containerId ?? `helm-browser-${session.id}`);
    if (container?.State.Running) await docker(`/containers/${container.Id}/stop?t=15`, "POST");
    const stopped = container ? await inspect(container.Id) : undefined;
    if (stopped?.State.Running) return save({ ...session, status: "UNKNOWN" });
    if (container) await removeDocker(`/containers/${container.Id}?v=true`);
    const egress = await inspect(session.egressId ?? `helm-browser-${session.id}-egress`);
    if (egress) await removeDocker(`/containers/${egress.Id}?force=true`);
    // A lost create response can leave the network before its ID was persisted.
    const network = session.networkId ?? `helm-browser-${session.id}`;
    const manager = await inspect(config.self);
    if (manager?.NetworkSettings.Networks[`helm-browser-${session.id}`]) await docker(`/networks/${network}/disconnect`, "POST", { Container: config.self, Force: true });
    await removeDocker(`/networks/${network}`);
    // Named volume is removed only after explicit close and confirmed process termination.
    await removeDocker(`/volumes/helm-browser-${session.id}-data`);
    return save({ ...session, status: "CLOSED" });
  } catch { return save({ ...session, status: "UNKNOWN" }); }
}
function recordRuntimeState(id: string, state: z.infer<typeof RuntimeState>): Session {
  const current = saved(id);
  if (current.status === "CLOSED" || current.status === "CLOSING") return current;
  const policy = state.controlEpoch >= current.policy.controlEpoch
    ? { controlEpoch: state.controlEpoch, owner: state.controlOwner, privateMode: state.privateMode, controllerId: state.controllerId }
    : current.policy;
  return save({ ...current, status: state.status, policy });
}
async function recoverSessionRoutes(): Promise<void> {
  for (const session of summaries()) {
    if (session.status === "CLOSING") { await closeSession(session); continue; }
    if (!session.containerId || !session.networkId) { save({ ...session, status: "UNKNOWN" }); continue; }
    const container = await inspect(session.containerId);
    if (!container?.State.Running) { save({ ...session, status: "LOST" }); continue; }
    const networkName = `helm-browser-${session.id}`;
    const manager = await inspect(config.self);
    if (!manager?.NetworkSettings.Networks[networkName]?.IPAddress) await docker(`/networks/${session.networkId}/connect`, "POST", { Container: config.self });
    const address = container.NetworkSettings.Networks[networkName]?.IPAddress;
    if (!address) { save({ ...session, status: "UNKNOWN" }); continue; }
    const routed = save({ ...session, address });
    try { recordRuntimeState(session.id, RuntimeState.parse(await sessionJson(routed, "/health"))); }
    catch { save({ ...routed, status: "UNKNOWN" }); }
  }
}
await recoverSessionRoutes();
const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
async function assets(url: URL, response: ServerResponse): Promise<void> {
  const relative = decodeURIComponent(url.pathname.slice("/novnc/".length));
  const filename = path.resolve(config.assets, relative === "helm.html" ? "vnc.html" : relative);
  if (!filename.startsWith(path.resolve(config.assets) + path.sep)) throw new HttpError(400, "Invalid path");
  if (relative === "helm.html") {
    const requestedParent = url.searchParams.get("parentOrigin") ?? config.publicOrigin;
    const parent = new URL(requestedParent);
    const trustedParent = requestedParent === config.publicOrigin || (requestedParent === parent.origin && parent.protocol === "https:" && !parent.port && parent.hostname.endsWith(".oaiusercontent.com"));
    if (!trustedParent) throw new HttpError(403, "Viewer parent origin denied");
    const html = (await readFile(filename, "utf8")).replace("UI.start({", `const parentOrigin = ${JSON.stringify(parent.origin)};
        const report = state => window.parent.postMessage({type:'helm-viewer',state}, parentOrigin);
        let pendingTransport;
        const connectTransport = () => {
          if (!pendingTransport || UI.rfb) return;
          const next = pendingTransport; pendingTransport = undefined;
          UI.forceSetting('path', next.path);
          UI.forceSetting('view_only', next.viewOnly);
          UI.forceSetting('host', window.location.hostname);
          UI.forceSetting('port', window.location.port);
          UI.forceSetting('encrypt', window.location.protocol === 'https:');
          UI.connect();
        };
        window.addEventListener('message', event => {
          if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.type !== 'helm-viewer-reconnect' || typeof event.data.url !== 'string') return;
          try {
            const next = new URL(event.data.url, window.location.href);
            if (next.origin !== window.location.origin || next.pathname !== window.location.pathname) return;
            const rawPath = next.searchParams.get('path');
            if (!rawPath) return;
            const transport = new URL(rawPath, window.location.origin + '/');
            const prefix = window.location.pathname.slice(0, window.location.pathname.indexOf('/novnc/'));
            if (transport.origin !== window.location.origin || !transport.pathname.startsWith(prefix + '/sessions/') || !transport.pathname.endsWith('/view') || !transport.searchParams.has('ticket')) return;
            pendingTransport = {path: transport.pathname.slice(1) + transport.search, viewOnly: next.searchParams.get('view_only') === '1'};
            if (UI.rfb) UI.disconnect(); else connectTransport();
          } catch { report('error'); }
        });
        const connected = UI.connectFinished; UI.connectFinished = function(...args) { connected.apply(UI, args); report('connected'); };
        const disconnected = UI.disconnectFinished; UI.disconnectFinished = function(...args) { disconnected.apply(UI, args); if (pendingTransport) connectTransport(); else report('disconnected'); };
        mandatory.reconnect = false;
        UI.start({`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); return;
  }
  const info = await stat(filename);
  if (!info.isFile()) throw new HttpError(404, "Asset unavailable");
  response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filename)] ?? "application/octet-stream", "Content-Length": info.size, "Cache-Control": "private,max-age=3600" });
  await pipeline(createReadStream(filename), response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://worker");
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.pathname.startsWith("/novnc/") && request.method === "GET") { await assets(url, response); return; }
    if (!authorized(request)) throw new HttpError(401, "Unauthorized");
    if (url.pathname === "/health" || url.pathname === "/nodes") {
      const draining = db.prepare("SELECT value FROM settings WHERE id='draining'").get()?.["value"] === "true";
      const active = summaries();
      const filters = encodeURIComponent(JSON.stringify({ label: [`helmglass.node=${config.nodeId}`] }));
      const containers = z.array(z.object({ Labels: z.record(z.string(), z.string()) })).parse(await (await docker(`/containers/json?all=true&filters=${filters}`)).json());
      const occupied = new Set(active.map((session) => session.id));
      for (const container of containers) {
        const id = container.Labels["helmglass.session"]; if (id) occupied.add(id);
      }
      reply(response, 200, { nodeId: config.nodeId, capacity: config.capacity, occupied: occupied.size, known: true, draining, status: occupied.size !== active.length ? "UNKNOWN" : draining ? "DRAINING" : "ONLINE", sessions: active.map(summary) }); return;
    }
    if (url.pathname === "/drain" && request.method === "POST") {
      const input = z.object({ enabled: z.boolean() }).parse(await body(request));
      db.prepare("INSERT INTO settings(id,value) VALUES('draining',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(String(input.enabled));
      reply(response, 200, { draining: input.enabled }); return;
    }
    if (segments[0] === "profiles" && segments[1] && request.method === "DELETE") {
      db.prepare("DELETE FROM profiles WHERE id=?").run(segments[1]); reply(response, 200, { deleted: true }); return;
    }
    if (segments[0] === "owners" && segments[1] && segments[2] === "viewers" && segments[3] === "revoke" && request.method === "POST") {
      const ownerId = z.string().min(1).max(200).parse(segments[1]);
      const input = z.object({ channel: z.enum(["WEB", "MCP"]), grantId: z.string().min(1).max(200).optional() }).strict().parse(await body(request));
      const matches = (access: z.infer<typeof AccessBinding>) => access.channel === input.channel && (input.grantId === undefined || access.grantId === input.grantId);
      let disconnected = 0; let invalidated = 0;
      // Backend serializes ticket issuance and revocation with the account row lock,
      // rechecking the grant under that lock. Revocation never changes browser lifetime.
      for (const [id, group] of viewers) {
        if (saved(id).ownerId !== ownerId) continue;
        for (const viewer of group) if (matches(viewer.access)) {
          viewer.socket.terminate(); viewer.upstream.terminate(); group.delete(viewer); disconnected += 1;
        }
        if (group.size === 0) viewers.delete(id);
      }
      for (const [key, ticket] of tickets) if (saved(ticket.sessionId).ownerId === ownerId && matches(ticket.access)) { tickets.delete(key); invalidated += 1; }
      reply(response, 200, { disconnected, invalidated }); return;
    }
    if (url.pathname === "/sessions" && request.method === "GET") { reply(response, 200, { sessions: summaries().map(summary) }); return; }
    if (url.pathname === "/sessions" && request.method === "POST") {
      const input = CreateSession.parse(await body(request));
      let pending = starting.get(input.sessionId);
      if (!pending) { pending = createSession(input); starting.set(input.sessionId, pending); }
      try { reply(response, 200, summary(await pending)); } finally { starting.delete(input.sessionId); }
      return;
    }
    if (segments[0] !== "sessions" || !segments[1]) throw new HttpError(404, "Route not found");
    let session = saved(z.uuid().parse(segments[1]));
    if (segments.length === 2 && request.method === "DELETE") { reply(response, 200, summary(await closeSession(session))); return; }
    if (segments.length === 2 && request.method === "GET") {
      if (session.status === "CLOSED") { reply(response, 200, summary(session)); return; }
      try {
        const state = RuntimeState.parse(await sessionJson(session, "/health"));
        session = recordRuntimeState(session.id, state); reply(response, 200, { ...summary(session), ...(!session.policy.privateMode ? { currentUrl: state.currentUrl, navigationError: state.navigationError } : {}) });
      } catch {
        session = saved(session.id);
        reply(response, 200, summary(session.status === "CLOSED" || session.status === "CLOSING" ? session : save({ ...session, status: "UNKNOWN" })));
      }
      return;
    }
    if (session.status === "CLOSED" || session.status === "CLOSING") throw new HttpError(409, "Session closed");
    if (segments[2] === "control" && request.method === "POST") {
      const policy = Policy.parse(await body(request));
      if (policy.controlEpoch < session.policy.controlEpoch) throw new HttpError(409, "Stale control epoch");
      if (policy.owner === "USER" && !policy.controllerId) throw new HttpError(400, "Controller identity required");
      if (JSON.stringify(policy) === JSON.stringify(session.policy)) { reply(response, 200, await sessionJson(session, "/control", "POST", policy)); return; }
      disconnectViewers(session.id);
      const result = await sessionJson(session, "/control", "POST", policy);
      const current = saved(session.id);
      if (current.policy.controlEpoch <= policy.controlEpoch) save({ ...current, policy });
      reply(response, 200, result); return;
    }
    if (segments[2] === "ticket" && request.method === "POST") {
      const ticket = Ticket.parse(await body(request));
      if (Date.parse(ticket.expiresAt) <= Date.now() || Date.parse(ticket.expiresAt) > Date.now() + 120_000) throw new HttpError(400, "Invalid ticket lifetime");
      if (session.policy.privateMode && ticket.viewerId !== session.policy.controllerId) throw new HttpError(423, "Private input in progress");
      if (ticket.role === "CONTROLLER" && (session.policy.owner !== "USER" || ticket.viewerId !== session.policy.controllerId)) throw new HttpError(403, "Control not granted");
      for (const [key, item] of tickets) if (Date.parse(item.expiresAt) <= Date.now()) tickets.delete(key);
      if (tickets.size >= config.capacity * 8) throw new HttpError(429, "Too many outstanding viewer tickets");
      tickets.set(ticket.ticket, { ...ticket, sessionId: session.id }); reply(response, 200, { registered: true }); return;
    }
    if (segments[2] === "profile" && segments[3] === "export" && request.method === "POST") {
      const input = z.object({ connectionId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), origins: z.array(z.url()).min(1).max(50) }).parse(await body(request));
      if (input.ownerId !== session.ownerId) throw new HttpError(403, "Profile owner mismatch");
      const value = await sessionJson(session, "/profile/export", "POST", { origins: input.origins });
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 8_388_608) throw new HttpError(413, "Profile exceeds storage limit");
      const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(Buffer.from(`${input.ownerId}:${input.connectionId}`));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const changed = db.prepare("INSERT INTO profiles(id,owner,encrypted) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted WHERE profiles.owner=excluded.owner").run(input.connectionId, input.ownerId, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
      if (changed.changes !== 1) throw new HttpError(403, "Profile owner mismatch");
      reply(response, 200, { profileRef: input.connectionId, saved: true }); return;
    }
    if (segments[2] === "artifacts" && segments[3] && request.method === "GET") {
      const archive = url.searchParams.get("archive") === "true" ? "?archive=true" : "";
      const upstream = await sessionRequest(session, `/artifacts/${z.uuid().parse(segments[3])}${archive}`);
      response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "no-store", ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length") ?? "" } : {}) });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response); else response.end(); return;
    }
    if (segments[2] === "artifacts" && segments.length === 3 && request.method === "GET") {
      const after = z.coerce.number().int().nonnegative().safe().parse(url.searchParams.get("after") ?? "0");
      const archive = url.searchParams.get("archive") === "true" ? "&archive=true" : "";
      reply(response, 200, await sessionJson(session, `/artifacts?after=${after}${archive}`)); return;
    }
    if (segments[2] === "observe" && request.method === "GET") { reply(response, 200, await sessionJson(session, "/observe")); return; }
    if (segments[2] === "commands") {
      const endpoint = segments[3] ? `/commands/${z.uuid().parse(segments[3])}${segments[4] === "resolve" ? "/resolve" : ""}` : "/commands";
      let input = request.method === "POST" ? await body(request) : undefined;
      if (endpoint === "/commands" && request.method === "POST") {
        const command = z.object({ operationId: z.uuid(), type: z.string(), arguments: z.record(z.string(), z.unknown()) }).passthrough().parse(input);
        if (command.type === "applyConnection") {
          const existing = await sessionRequest(session, `/commands/${command.operationId}`);
          if (existing.ok) { reply(response, 200, await existing.json()); return; }
          await existing.body?.cancel();
          if (existing.status !== 404) throw new HttpError(502, "Account switch receipt unavailable");
          const args = z.object({ connectionId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), origins: z.array(z.url()).min(1).max(50), url: z.url() }).strict().parse(command.arguments);
          if (args.ownerId !== session.ownerId) throw new HttpError(403, "Profile owner mismatch");
          disconnectViewers(session.id);
          input = { ...command, arguments: { ...args, profile: decryptProfile(args.connectionId, args.ownerId) } };
        }
      }
      reply(response, 200, await sessionJson(session, endpoint, request.method ?? "GET", input)); return;
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    reply(response, error instanceof HttpError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 502, { error: error instanceof HttpError ? error.message : "Operation unavailable" });
  }
});
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  try {
    if (request.headers.origin !== config.publicOrigin) throw new HttpError(403, "Viewer origin denied");
    const url = new URL(request.url ?? "/", "http://worker");
    const match = /^\/sessions\/([^/]+)\/view$/.exec(url.pathname);
    if (!match?.[1]) throw new HttpError(404, "Unknown view");
    const session = saved(z.uuid().parse(match[1]));
    const token = url.searchParams.get("ticket") ?? "";
    const ticket = tickets.get(token); tickets.delete(token);
    if (!ticket || ticket.sessionId !== session.id || Date.parse(ticket.expiresAt) <= Date.now()) throw new HttpError(401, "Invalid viewer ticket");
    if (session.policy.privateMode && ticket.viewerId !== session.policy.controllerId) throw new HttpError(423, "Private input");
    if (ticket.role === "CONTROLLER" && (session.policy.owner !== "USER" || ticket.viewerId !== session.policy.controllerId)) throw new HttpError(403, "Control not granted");
    const group = viewers.get(session.id) ?? new Set();
    for (const viewer of group) if (viewer.viewerId === ticket.viewerId) { viewer.socket.close(); viewer.upstream.close(); group.delete(viewer); }
    if (group.size >= 2 || !session.address || session.status !== "LIVE") throw new HttpError(409, "View unavailable");
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(`ws://${session.address}:8080/view?role=${ticket.role}&epoch=${session.policy.controlEpoch}&viewerId=${encodeURIComponent(ticket.viewerId)}`, { headers: { "X-Worker-Token": session.token }, perMessageDeflate: false, maxPayload: 16_777_216 });
      const viewer = { socket: client, upstream, viewerId: ticket.viewerId, role: ticket.role, access: ticket.access }; group.add(viewer); viewers.set(session.id, group);
      const clientStream = createWebSocketStream(client); const upstreamStream = createWebSocketStream(upstream);
      clientStream.pipe(upstreamStream); upstreamStream.pipe(clientStream);
      const clean = () => { group.delete(viewer); clientStream.destroy(); upstreamStream.destroy(); };
      client.on("close", clean); upstream.on("close", clean); client.on("error", clean); upstream.on("error", clean);
    });
  } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
});
server.listen(8090, "0.0.0.0");
// Manager shutdown never terminates session containers; a replacement manager reconciles them.
