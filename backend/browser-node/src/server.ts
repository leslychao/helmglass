import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { CookieCheck, CredentialConflict, ConnectionStore } from "./connection-store.js";
import { StorageError, Vault } from "./vault.js";
import { bridgeViewer, type ViewerCloseReason } from "./viewer-bridge.js";

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
const vault = new Vault(required("VAULT_ADDR"), required("VAULT_ROLE_ID"), required("VAULT_SECRET_ID"));
const seccompProfile = JSON.stringify(JSON.parse(await readFile(new URL("../seccomp-profile.json", import.meta.url), "utf8")));
await mkdir(config.data, { recursive: true });
const db = new DatabaseSync(path.join(config.data, "node.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);");
const credentials = new ConnectionStore(db, vault, config.data);

const Policy = z.object({ controlEpoch: z.number().int().nonnegative(), owner: z.enum(["CHATGPT", "USER", "NONE"]), privateMode: z.boolean(), controllerId: z.string().max(200).optional() });
const Session = z.object({
  id: z.uuid(), ownerId: z.string().min(1).max(200), taskId: z.string().max(200).optional(),
  startUrl: z.string().max(8192), connectionId: z.string().max(200).optional(), token: z.string(),
  restoreProfile: z.boolean().optional(),
  initializing: z.boolean().default(false),
  startDeadlineAt: z.string().datetime().optional(), closeRequested: z.boolean().default(false),
  runtimeStoppedAt: z.string().datetime().optional(), cleanupComplete: z.boolean().default(false),
  deadlineCheckAt: z.number().nonnegative().default(0),
  pendingOperation: z.object({ id: z.string(), deadlineAt: z.string().datetime(),
    cancelAt: z.string().datetime().optional(), kind: z.enum(["COMMAND", "CONTROL", "PROFILE"]) }).optional(),
  status: z.enum(["STARTING", "LIVE", "CLOSING", "CLOSED", "UNKNOWN", "LOST"]),
  networkId: z.string().optional(), containerId: z.string().optional(), egressId: z.string().optional(),
  runtimeImage: z.string().optional(),
  address: z.string().optional(), policy: Policy,
  profileRevision: z.number().int().nonnegative().optional(), profileSavedAt: z.string().optional(),
  profileSaveError: z.string().optional(),
  failureCode: z.string().optional(),
  cookieCheck: CookieCheck.optional(),
});
type Session = z.infer<typeof Session>;
type Policy = z.infer<typeof Policy>;
const CreateSession = z.object({ deadlineAt: z.string().datetime().optional(), sessionId: z.uuid(), ownerId: z.string().min(1).max(200), taskId: z.string().max(200).optional(), startUrl: z.string().max(8192), connectionId: z.string().max(200).optional(), restoreProfile: z.boolean().default(true) }).strict();
const DockerIdentity = z.object({ Id: z.string() });
const DockerInspect = z.object({ Id: z.string(), Image: z.string(), State: z.object({ Running: z.boolean() }), NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ IPAddress: z.string() })) }) });
const RuntimeState = z.object({ status: z.enum(["STARTING", "LIVE", "LOST"]), currentUrl: z.string().optional(), navigationError: z.string().optional(), controlEpoch: z.number().int().nonnegative(), controlOwner: z.enum(["CHATGPT", "USER", "NONE"]), privateMode: z.boolean(), controllerId: z.string().optional() });
const AccessBinding = z.object({ channel: z.enum(["WEB", "MCP"]), grantId: z.string().min(1).max(200) }).strict();
const Ticket = z.object({ ticket: z.string().min(32).max(512), role: z.enum(["VIEWER", "CONTROLLER"]), viewerId: z.string().min(1).max(200), expiresAt: z.string().datetime(), access: AccessBinding });
type Ticket = z.infer<typeof Ticket>;
const tickets = new Map<string, Ticket & { sessionId: string }>();
const viewers = new Map<string, Set<{ close: (reason: ViewerCloseReason) => void; viewerId: string; role: string; access: z.infer<typeof AccessBinding> }>>();
const starting = new Map<string, Promise<Session>>();
const closing = new Map<string, Promise<Session>>();
const savingProfiles = new Set<string>();
const changingCredentials = new Set<string>();

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
  const previous = db.prepare("SELECT document FROM sessions WHERE id=?").get(session.id);
  if (typeof previous?.["document"] === "string") {
    const state = Session.parse(JSON.parse(previous["document"]));
    if (state.closeRequested && !session.closeRequested) throw new HttpError(409, "Session closing");
    if (state.runtimeStoppedAt && !session.runtimeStoppedAt) throw new HttpError(409, "Session stopped");
  }
  db.prepare("INSERT INTO sessions(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(session.id, JSON.stringify(session));
  return session;
}
function summaries(): Session[] {
  return db.prepare("SELECT document FROM sessions WHERE json_extract(document,'$.status') != 'CLOSED'").all().map((row) => Session.parse(JSON.parse(z.string().parse(row["document"]))));
}
function summary(session: Session): object {
  return { id: session.id, ownerId: session.ownerId, taskId: session.taskId, nodeId: config.nodeId, status: session.status, controlEpoch: session.policy.controlEpoch, controlOwner: session.policy.owner, privateMode: session.policy.privateMode,
    runtimeStoppedAt: session.runtimeStoppedAt ?? null,
    failureCode: session.failureCode ?? null,
    cleanupState: session.cleanupComplete ? "COMPLETE" : session.runtimeStoppedAt ? "PENDING" : "NONE",
    profileConnectionId: session.connectionId, profileRevision: session.profileRevision,
    profileSavedAt: session.profileSavedAt, profileSaveError: session.profileSaveError ?? null,
    cookieCheck: session.cookieCheck ?? null };
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
  const pending = saved(session.id).pendingOperation;
  const timeout = endpoint.startsWith("/artifacts/") ? 360_000
    : endpoint.endsWith("/cancel") ? 2000
    : method === "POST" && pending ? Math.max(1, Math.min(360_000, Date.parse(pending.deadlineAt) - Date.now()))
    : endpoint.startsWith("/profile") ? 300_000 : endpoint.startsWith("/commands") ? 90_000 : 30_000;
  const response = await fetch(`http://${session.address}:8080${endpoint}`, {
    method, headers: { "X-Worker-Token": session.token, "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(timeout),
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
async function prepareProfile(session: Session, connectionId: string, importId: string, origins?: string[]): Promise<void> {
  const endpoint = `/profile/import/${importId}`;
  const existing = await sessionRequest(session, endpoint);
  await existing.body?.cancel();
  if (existing.ok) return;
  if (existing.status !== 404) throw new HttpError(409, "Profile import unavailable");
  const current = saved(session.id);
  const deadline = current.pendingOperation?.deadlineAt ?? current.startDeadlineAt;
  const remaining = deadline ? Date.parse(deadline) - Date.now() : 300_000;
  if (remaining <= 0) throw new HttpError(408, "Profile import deadline exceeded");
  const source = await credentials.stream(connectionId, session.ownerId);
  const request = http.request({ hostname: session.address, port: 8080,
    path: endpoint + (origins ? "?origins=" + encodeURIComponent(JSON.stringify(origins)) : ""), method: "POST",
    signal: AbortSignal.timeout(Math.min(300_000, remaining)),
    headers: { "X-Worker-Token": session.token, "Content-Type": "application/x-ndjson" } });
  request.setTimeout(300_000, () => request.destroy(new Error("Profile import timed out")));
  const result = new Promise<void>((resolve, reject) => {
    request.on("error", reject);
    request.on("response", (response) => {
      response.resume();
      response.on("error", reject);
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new StorageError("PROFILE_INVALID", 422)));
    });
  });
  try { await Promise.all([pipeline(source.input, request), source.completion, result]); }
  catch (error) { source.input.destroy(); request.destroy(); throw error; }
}

async function exportSavedProfile(session: Session, connectionId: string, origins: string[], includeLoginOrigins = false, requestedOperationId?: string): Promise<object> {
  if (savingProfiles.has(session.id) || changingCredentials.has(session.id)) throw new HttpError(409, "Profile save in progress");
  savingProfiles.add(session.id);
  const operationId = requestedOperationId ?? (includeLoginOrigins ? session.id + ":" + session.policy.controlEpoch : randomUUID());
  try {
    let profile = await credentials.saved(connectionId, session.ownerId, operationId);
    if (!profile) {
      const exported = await sessionRequest(session, "/profile/export", "POST", { origins, includeLoginOrigins });
      if (!exported.ok) {
        const failure = z.object({ code: z.string().regex(/^PROFILE_[A-Z_]+$/).max(80) })
          .safeParse(await exported.json());
        throw new StorageError(failure.success ? failure.data.code : "PROFILE_SAVE_FAILED", exported.status);
      }
      if (!exported.body) throw new StorageError("PROFILE_SAVE_FAILED", 502);
      profile = await credentials.save(connectionId, session.ownerId, operationId, Readable.fromWeb(exported.body));
    }
    save({ ...saved(session.id), connectionId, profileRevision: profile.revision, profileSavedAt: profile.savedAt, profileSaveError: undefined, cookieCheck: profile.cookieCheck });
    return { profileRef: connectionId, saved: true, revision: profile.revision, savedAt: profile.savedAt, origins: profile.origins, cookieCheck: profile.cookieCheck ?? null };
  } finally { savingProfiles.delete(session.id); }
}

function reconcileAppliedConnection(sessionId: string, result: unknown): void {
  const applied = z.object({ status: z.literal("SUCCEEDED"), result: z.object({ switched: z.literal(true), connectionId: z.string() }) }).safeParse(result);
  if (applied.success) {
    const current = saved(sessionId);
    if (current.connectionId !== applied.data.result.connectionId) save({ ...current,
      connectionId: applied.data.result.connectionId, profileRevision: undefined,
      profileSavedAt: undefined, profileSaveError: undefined, cookieCheck: undefined });
  }
}
async function createSession(input: z.infer<typeof CreateSession>): Promise<Session> {
  let session: Session;
  try {
    session = saved(input.sessionId);
    if (session.ownerId !== input.ownerId || session.taskId !== input.taskId) throw new HttpError(409, "Session identity conflict");
    if (session.closeRequested || session.runtimeStoppedAt) return closeSession(session);
    if (session.status !== "STARTING" && !session.initializing) return session;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    if (db.prepare("SELECT value FROM settings WHERE id='draining'").get()?.["value"] === "true") throw new HttpError(409, "Node does not accept new browsers");
    if (summaries().length >= config.capacity) throw new HttpError(409, "Browser capacity reached");
    if (input.startUrl !== "about:blank" && !["http:", "https:"].includes(new URL(input.startUrl).protocol)) throw new HttpError(400, "Invalid start URL");
    session = save({ id: input.sessionId, ownerId: input.ownerId, taskId: input.taskId, startUrl: input.startUrl, connectionId: input.connectionId, restoreProfile: input.restoreProfile, initializing: true, startDeadlineAt: input.deadlineAt ?? new Date(Date.now() + 360_000).toISOString(), closeRequested: false, cleanupComplete: false, deadlineCheckAt: 0, token: randomBytes(32).toString("base64url"), status: "STARTING", policy: { controlEpoch: 0, owner: "NONE", privateMode: false } });
  }
  if (session.closeRequested || session.startDeadlineAt && Date.parse(session.startDeadlineAt) <= Date.now()) {
    return closeSession(session);
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
  session = save({ ...session, containerId: container.Id, runtimeImage: container.Image, egressId: egress.Id, address });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (saved(session.id).closeRequested) throw new HttpError(409, "Session closing");
    if (session.startDeadlineAt && Date.parse(session.startDeadlineAt) <= Date.now()) throw new HttpError(408, "Startup deadline exceeded");
    try {
      const restore = session.connectionId && session.restoreProfile !== false;
      let result = z.object({ status: z.enum(["LIVE", "LOST"]) }).parse(await sessionJson(session, "/initialize", "POST", { startUrl: restore ? "about:blank" : session.startUrl }));
      if (restore && session.connectionId && result.status === "LIVE") {
        await prepareProfile(session, session.connectionId, session.id);
        result = z.object({ status: z.enum(["LIVE", "LOST"]) }).parse(await sessionJson(session, "/profile/activate", "POST", { id: session.id, startUrl: session.startUrl }));
      }
      return save({ ...session, status: result.status, initializing: false, profileSaveError: undefined });
    } catch (error) {
      if (error instanceof StorageError) return save({ ...session, status: "LOST", initializing: false, profileSaveError: error.code });
      if (error instanceof HttpError && error.status < 500) throw error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, [1000, 3000, 10000][attempt]));
    }
  }
  return save({ ...session, status: "LOST", initializing: false, failureCode: "START_FAILED" });
}
async function startSession(input: z.infer<typeof CreateSession>): Promise<Session> {
  let pending = starting.get(input.sessionId);
  if (!pending) { pending = createSession(input); starting.set(input.sessionId, pending); }
  try { return await pending; } finally { if (starting.get(input.sessionId) === pending) starting.delete(input.sessionId); }
}
function disconnectViewers(id: string, reason: ViewerCloseReason): void {
  for (const viewer of viewers.get(id) ?? []) viewer.close(reason);
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
  let session = saved(id);
  if (session.runtimeStoppedAt) return session;
  save({ ...session, closeRequested: true, status: "CLOSING" });
  disconnectViewers(id, "session_closed");
  try {
    // Stop execution even if profile restoration has not returned. Removing these containers
    // also fences an already sent Docker start; the original named volume remains intact.
    const creating = starting.has(id);
    session = saved(id);
    const container = await inspect(session.containerId ?? `helm-browser-${id}`);
    if (container && !session.runtimeImage) {
      session = save({ ...saved(id), runtimeImage: container.Image });
    }
    if (container?.State.Running) await docker(`/containers/${container.Id}/stop?t=10`, "POST");
    if (creating && container) await removeDocker(`/containers/${container.Id}?force=true`);
    const stopped = await inspect(session.containerId ?? `helm-browser-${id}`);
    if (stopped?.State.Running) return saved(id);
    const egress = await inspect(session.egressId ?? `helm-browser-${id}-egress`);
    if (egress?.State.Running) await docker(`/containers/${egress.Id}/stop?t=1`, "POST");
    if (creating && egress) await removeDocker(`/containers/${egress.Id}?force=true`);
    const stoppedEgress = await inspect(session.egressId ?? `helm-browser-${id}-egress`);
    if (stoppedEgress?.State.Running) return saved(id);
    // Keep the original volume and receipts until the API acknowledges verified delivery.
    return save({ ...saved(id), status: "CLOSED", initializing: false,
      runtimeStoppedAt: new Date().toISOString(), pendingOperation: undefined });
  } catch { return save({ ...saved(id), status: "UNKNOWN" }); }
}

let archiveBusy = false;
let archiveSession: string | undefined;
async function withArchive(session: Session, work: (reader: Session) => Promise<void>): Promise<boolean> {
  if (!session.runtimeStoppedAt || session.cleanupComplete) throw new HttpError(409, "Archive unavailable");
  if (archiveBusy) throw new HttpError(409, "Archive reader busy");
  archiveBusy = true;
  const name = `helm-archive-${config.nodeId}`;
  try {
    let reader = await inspect(name);
    if (reader && archiveSession !== session.id) { await removeDocker(`/containers/${reader.Id}?force=true`); reader = undefined; }
    if (!reader) {
      // Docker would otherwise silently create an empty volume and hide lost delivery data.
      try { await docker(`/volumes/helm-browser-${session.id}-data`); }
      catch (error) {
        if (!session.containerId && error instanceof HttpError && error.status === 404) return false;
        throw error;
      }
      const networkName = `helm-browser-${session.id}`;
      try { await docker(`/networks/${networkName}`); }
      catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        await docker("/networks/create", "POST", { Name: networkName, Driver: "bridge", Internal: true,
          Labels: { "helmglass.node": config.nodeId, "helmglass.session": session.id } });
      }
      const manager = await inspect(config.self);
      if (!manager?.NetworkSettings.Networks[networkName]) {
        await docker(`/networks/${networkName}/connect`, "POST", { Container: config.self });
      }
      const sourceImage = session.runtimeImage ?? (await inspect(session.containerId ?? `helm-browser-${session.id}`))?.Image;
      if (!sourceImage) throw new HttpError(502, "Original runtime image unavailable");
      const created = DockerIdentity.parse(await (await docker(`/containers/create?name=${name}`, "POST", {
        Image: sourceImage,
        Entrypoint: ["node", "/app/dist/archive-reader.js"], User: "1000:1000",
        Env: [`SESSION_TOKEN=${session.token}`], Labels: { "helmglass.node": config.nodeId, "helmglass.archive": "true" },
        HostConfig: { NetworkMode: networkName, ReadonlyRootfs: true, CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"], Memory: 268_435_456, PidsLimit: 32,
          Mounts: [{ Type: "volume", Source: `helm-browser-${session.id}-data`, Target: "/data", ReadOnly: true }],
          LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } } },
      })).json());
      await docker(`/containers/${created.Id}/start`, "POST");
      reader = await inspect(created.Id); archiveSession = session.id;
    }
    const address = reader?.NetworkSettings.Networks[`helm-browser-${session.id}`]?.IPAddress;
    if (!address) throw new HttpError(502, "Archive reader unavailable");
    const target = { ...session, address };
    for (let attempt = 0; ; attempt++) {
      try { await sessionJson(target, "/health"); break; }
      catch (error) { if (attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, [1000, 3000, 10000][attempt])); }
    }
    await work(target);
    return true;
  } finally { archiveBusy = false; }
}

async function cleanupSession(session: Session): Promise<Session> {
  if (!session.runtimeStoppedAt) throw new HttpError(409, "Execution stop is not confirmed");
  if (session.cleanupComplete) return session;
  if (starting.has(session.id)) throw new HttpError(409, "Startup is still releasing disk resources");
  if (archiveBusy) throw new HttpError(409, "Archive reader busy");
  archiveBusy = true;
  try {
    // Remove a reader left by this or a previous node process before removing its source volume.
    await removeDocker(`/containers/helm-archive-${config.nodeId}?force=true`);
    archiveSession = undefined;
    await removeDocker(`/containers/${session.containerId ?? `helm-browser-${session.id}`}?v=true`);
    await removeDocker(`/containers/${session.egressId ?? `helm-browser-${session.id}-egress`}?force=true`);
    const network = session.networkId ?? `helm-browser-${session.id}`;
    const manager = await inspect(config.self);
    if (manager?.NetworkSettings.Networks[`helm-browser-${session.id}`]) {
      await docker(`/networks/${network}/disconnect`, "POST", { Container: config.self, Force: true });
    }
    await removeDocker(`/networks/${network}`);
    await removeDocker(`/volumes/helm-browser-${session.id}-data`);
    return save({ ...saved(session.id), cleanupComplete: true });
  } finally { archiveBusy = false; }
}

const deadlineChecks = new Set<string>();
async function checkDeadline(session: Session): Promise<void> {
  if (session.closeRequested || session.initializing) {
    if (session.initializing && !session.closeRequested) {
      save({ ...saved(session.id), failureCode: "START_DEADLINE_EXCEEDED" });
    }
    await closeSession(session);
    return;
  }
  const operation = session.pendingOperation;
  if (!operation) return;
  if (!operation.cancelAt) {
    save({ ...saved(session.id), pendingOperation: { ...operation, cancelAt: new Date().toISOString() } });
    if (operation.kind === "COMMAND") {
      try { await sessionJson(session, `/commands/${operation.id}/cancel`, "POST", {}); }
      catch { /* The next check confirms physical shutdown independently. */ }
    }
  } else if (Date.parse(operation.cancelAt) + 10_000 <= Date.now()) {
    save({ ...saved(session.id), failureCode: operation.kind + "_DEADLINE_EXCEEDED" });
    await closeSession(session);
  }
}
setInterval(() => {
  const now = Date.now();
  const due = summaries().filter(session => session.deadlineCheckAt <= now
    && !deadlineChecks.has(session.id) && (session.closeRequested
      || session.initializing && session.startDeadlineAt && Date.parse(session.startDeadlineAt) <= now
      || session.pendingOperation && Date.parse(session.pendingOperation.deadlineAt) <= now))
    .sort((left, right) => left.deadlineCheckAt - right.deadlineCheckAt);
  for (const session of due.slice(0, Math.max(0, 8 - deadlineChecks.size))) {
    deadlineChecks.add(session.id);
    save({ ...session, deadlineCheckAt: now + 45_000 });
    void checkDeadline(saved(session.id)).catch(() => {
      console.warn(JSON.stringify({ event: "deadline_check_failed", sessionId: session.id }));
    }).finally(() => {
      try { save({ ...saved(session.id), deadlineCheckAt: Date.now() + 1000 }); }
      finally { deadlineChecks.delete(session.id); }
    }).catch(() => {
      console.warn(JSON.stringify({ event: "deadline_check_persist_failed", sessionId: session.id }));
    });
  }
}, 1000).unref();

function recordRuntimeState(id: string, state: z.infer<typeof RuntimeState>): Session {
  const current = saved(id);
  if (current.closeRequested || current.runtimeStoppedAt) return current;
  const policy = state.controlEpoch >= current.policy.controlEpoch
    ? { controlEpoch: state.controlEpoch, owner: state.controlOwner, privateMode: state.privateMode, controllerId: state.controllerId }
    : current.policy;
  return save({ ...current, status: state.status, policy });
}
async function recoverSessionRoutes(): Promise<void> {
  const pending = summaries().values();
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (const original of pending) {
      let session = saved(original.id);
      try {
    if (session.initializing && !session.startDeadlineAt) {
      session = save({ ...session, startDeadlineAt: new Date(Date.now() + 360_000).toISOString() });
    }
    if (session.status === "CLOSING") { await closeSession(session); continue; }
    if (!session.containerId || !session.networkId) { save({ ...session, status: "UNKNOWN" }); continue; }
    const container = await inspect(session.containerId);
    if (!container?.State.Running) { await closeSession(saved(session.id)); continue; }
    const networkName = `helm-browser-${session.id}`;
    const manager = await inspect(config.self);
    if (!manager?.NetworkSettings.Networks[networkName]?.IPAddress) await docker(`/networks/${session.networkId}/connect`, "POST", { Container: config.self });
    const address = container.NetworkSettings.Networks[networkName]?.IPAddress;
    if (!address) { save({ ...session, status: "UNKNOWN" }); continue; }
    const routed = save({ ...session, address });
    try { recordRuntimeState(session.id, RuntimeState.parse(await sessionJson(routed, "/health"))); }
    catch { save({ ...saved(session.id), status: "UNKNOWN" }); }
      } catch {
        console.warn(JSON.stringify({ event: "session_route_unavailable", sessionId: session.id }));
      }
    }
  }));
}
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
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Helm Glass browser</title><style>html,body,#screen{width:100%;height:100%;margin:0;background:#111827;overflow:hidden}canvas{outline:none}</style></head><body><div id="screen"></div><script type="module">
      import RFB from './core/rfb.js';
      const parentOrigin = ${JSON.stringify(parent.origin)};
      let rfb, pending, activeEpoch, navigating = false, frozen = false, generation = 0;
      const report = (state, epoch) => {
        const canvas = document.querySelector('#screen canvas');
        window.parent.postMessage({type:'helm-viewer',state,viewerEpoch:epoch,width:canvas?.width,height:canvas?.height}, parentOrigin);
      };
      function connect(next) {
        const rawPath = next.searchParams.get('path');
        if (!rawPath) throw new Error('Missing transport');
        const transport = new URL(rawPath, window.location.origin + '/');
        const prefix = window.location.pathname.slice(0, window.location.pathname.indexOf('/novnc/'));
        if (transport.origin !== window.location.origin || !transport.pathname.startsWith(prefix + '/sessions/') || !transport.pathname.endsWith('/view') || !transport.searchParams.has('ticket')) throw new Error('Invalid transport');
        transport.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ownGeneration = ++generation, epoch = next.searchParams.get('viewerEpoch') ?? '';
        activeEpoch = epoch;
        const connection = new RFB(document.getElementById('screen'), transport.href);
        rfb = connection;
        connection.viewOnly = next.searchParams.get('view_only') === '1';
        connection.scaleViewport = true; connection.resizeSession = false;
        const dimensions = new MutationObserver(() => { if (ownGeneration === generation) report('resized', epoch); });
        dimensions.observe(document.getElementById('screen'), {subtree:true,childList:true,attributes:true,attributeFilter:['width','height']});
        connection.addEventListener('connect', () => { if (ownGeneration === generation) report('connected', epoch); });
        connection.addEventListener('securityfailure', () => { if (ownGeneration === generation) report('error', epoch); });
        connection.addEventListener('disconnect', () => {
          dimensions.disconnect();
          if (ownGeneration !== generation) return;
          rfb = undefined;
          if (pending) { const target = pending; pending = undefined; connect(target); }
          else report('disconnected', epoch);
        });
      }
      window.addEventListener('message', async event => {
        if (event.source !== window.parent || event.origin !== parentOrigin || frozen) return;
        if (event.data?.type === 'helm-viewer-freeze') {
          if (event.data.viewerEpoch !== activeEpoch || rfb && !rfb.viewOnly) return;
          frozen = true;
          generation++;
          pending = undefined;
          try {
            const canvas = document.querySelector('#screen canvas');
            if (canvas) {
              const snapshot = document.createElement('canvas'), bounds = canvas.getBoundingClientRect();
              snapshot.width = canvas.width; snapshot.height = canvas.height;
              const context = snapshot.getContext('2d');
              if (context) {
                context.drawImage(canvas, 0, 0);
                snapshot.style.cssText = 'position:fixed;left:' + bounds.left + 'px;top:' + bounds.top
                  + 'px;width:' + bounds.width + 'px;height:' + bounds.height + 'px';
                document.body.append(snapshot);
              }
            }
          } finally {
            rfb?.disconnect();
            rfb = undefined;
          }
          return;
        }
        if (typeof event.data?.url !== 'string') return;
        if (event.data.type === 'helm-viewer-navigate') {
          if (!rfb || rfb.viewOnly || navigating || event.data.viewerEpoch !== activeEpoch) return;
          const connection = rfb, epoch = activeEpoch;
          try {
            const target = new URL(event.data.url);
            if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.href.length > 4096) return;
            navigating = true;
            // Clipboard transfer and remote focus are asynchronous in X11.
            // Keep the whole address together and never finish in a newer viewer.
            connection.clipboardPasteFrom(target.href);
            connection.sendKey(0xffe3, 'ControlLeft', true);
            connection.sendKey(0x6c, 'KeyL');
            connection.sendKey(0xffe3, 'ControlLeft', false);
            await new Promise(resolve => setTimeout(resolve, 150));
            if (rfb !== connection || activeEpoch !== epoch || connection.viewOnly) return;
            connection.sendKey(0xffe3, 'ControlLeft', true);
            connection.sendKey(0x76, 'KeyV');
            connection.sendKey(0xffe3, 'ControlLeft', false);
            await new Promise(resolve => setTimeout(resolve, 150));
            if (rfb === connection && activeEpoch === epoch && !connection.viewOnly) connection.sendKey(0xff0d, 'Enter');
          } catch { report('error', epoch); }
          finally { navigating = false; }
          return;
        }
        if (event.data.type !== 'helm-viewer-reconnect') return;
        try {
          const next = new URL(event.data.url, location.href);
          if (next.origin !== location.origin || next.pathname !== location.pathname) return;
          if (rfb) { pending = next; rfb.disconnect(); } else connect(next);
        } catch { report('error', ''); }
      });
      for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
        document.addEventListener(type, event => {
          if (event.isTrusted && rfb && !rfb.viewOnly && !frozen) report('activity', activeEpoch);
        }, {capture:true,passive:true});
      }
      window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && activeEpoch !== undefined) report('escape', activeEpoch);
      }, true);
      try { connect(new URL(location.href)); } catch { report('error', new URL(location.href).searchParams.get('viewerEpoch') ?? ''); }
    </script></body></html>`;
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
      const containers = z.array(z.object({ Labels: z.record(z.string(), z.string()), State: z.string() })).parse(await (await docker(`/containers/json?all=true&filters=${filters}`)).json());
      const occupied = new Set(active.map((session) => session.id));
      for (const container of containers) {
        const id = container.Labels["helmglass.session"]; if (id && container.State === "running") occupied.add(id);
      }
      reply(response, 200, { nodeId: config.nodeId, capacity: config.capacity, occupied: occupied.size, known: true, draining, status: occupied.size !== active.length ? "UNKNOWN" : draining ? "DRAINING" : "ONLINE", sessions: active.map(summary) }); return;
    }
    if (url.pathname === "/drain" && request.method === "POST") {
      const input = z.object({ enabled: z.boolean() }).parse(await body(request));
      db.prepare("INSERT INTO settings(id,value) VALUES('draining',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(String(input.enabled));
      reply(response, 200, { draining: input.enabled }); return;
    }
    if (segments[0] === "profiles" && segments[1] && request.method === "DELETE") {
      await credentials.remove(segments[1]); reply(response, 200, { deleted: true }); return;
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
          viewer.close("grant_revoked"); disconnected += 1;
        }
        if (group.size === 0) viewers.delete(id);
      }
      for (const [key, ticket] of tickets) if (saved(ticket.sessionId).ownerId === ownerId && matches(ticket.access)) { tickets.delete(key); invalidated += 1; }
      reply(response, 200, { disconnected, invalidated }); return;
    }
    if (url.pathname === "/sessions" && request.method === "GET") { reply(response, 200, { sessions: summaries().map(summary) }); return; }
    if (url.pathname === "/sessions" && request.method === "POST") {
      const input = CreateSession.parse(await body(request));
      reply(response, 200, summary(await startSession(input)));
      return;
    }
    if (segments[0] !== "sessions" || !segments[1]) throw new HttpError(404, "Route not found");
    const sessionId = z.uuid().parse(segments[1]);
    let session: Session;
    try { session = saved(sessionId); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404 || request.method !== "GET" || segments.length !== 2) throw error;
      const runtime = await inspect(`helm-browser-${sessionId}`);
      const egress = await inspect(`helm-browser-${sessionId}-egress`);
      reply(response, 200, { id: sessionId, status: !runtime && !egress ? "LOST" : "UNKNOWN",
        runtimeStoppedAt: !runtime && !egress ? new Date().toISOString() : null }); return;
    }
    if (segments[2] === "cleanup" && request.method === "DELETE") {
      reply(response, 200, summary(await cleanupSession(session))); return;
    }
    if (session.runtimeStoppedAt && request.method === "GET" && ["artifacts", "commands"].includes(segments[2] ?? "")) {
      const endpoint = '/' + segments.slice(2).join('/') + url.search;
      const available = await withArchive(session, async reader => {
        const upstream = await sessionRequest(reader, endpoint);
        response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json",
          ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length")! } : {}) });
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response); else response.end();
      });
      if (!available) {
        if (segments[2] === "artifacts" && segments.length === 3) {
          reply(response, 200, { artifacts: [], nextCursor: 0, hasMore: false });
        } else {
          reply(response, 404, { error: "Browser never started; no stored result" });
        }
      }
      return;
    }
    if (segments.length === 2 && request.method === "DELETE") { reply(response, 200, summary(await closeSession(session))); return; }
    if (segments.length === 2 && request.method === "GET") {
      if (session.status === "CLOSED") { reply(response, 200, summary(session)); return; }
      if (session.closeRequested || session.status === "LOST") { reply(response, 200, summary(await closeSession(session))); return; }
      if (session.initializing) {
        const result = await startSession({ sessionId: session.id, ownerId: session.ownerId, taskId: session.taskId,
          startUrl: session.startUrl, connectionId: session.connectionId, restoreProfile: session.restoreProfile ?? true, deadlineAt: session.startDeadlineAt });
        reply(response, 200, summary(result)); return;
      }
      try {
        const state = RuntimeState.parse(await sessionJson(session, "/health"));
        session = recordRuntimeState(session.id, state); reply(response, 200, { ...summary(session), ...(!session.policy.privateMode ? { currentUrl: state.currentUrl, navigationError: state.navigationError } : {}) });
      } catch {
        session = saved(session.id);
        const container = await inspect(session.containerId ?? `helm-browser-${session.id}`);
        if (!container?.State.Running) {
          reply(response, 200, summary(await closeSession(session)));
          return;
        }
        reply(response, 200, summary(session.status === "CLOSED" || session.status === "CLOSING" ? session : save({ ...session, status: "UNKNOWN" })));
      }
      return;
    }
    if (session.closeRequested || session.runtimeStoppedAt || session.status === "CLOSED" || session.status === "CLOSING") {
      throw new HttpError(409, "Session closed");
    }
    if (segments[2] === "bind" && request.method === "POST") {
      const input = z.object({ ownerId: z.string(), taskId: z.uuid() }).strict().parse(await body(request));
      if (input.ownerId !== session.ownerId || (session.taskId && session.taskId !== input.taskId)
          || session.policy.privateMode || !["NONE", "CHATGPT"].includes(session.policy.owner)) throw new HttpError(409, "Browser cannot be assigned");
      session = save({ ...session, taskId: input.taskId }); reply(response, 200, summary(session)); return;
    }
    if (segments[2] === "login-context" && request.method === "POST") {
      const input = z.object({ ownerId: z.string(), connectionId: z.string(), startUrl: z.url() }).strict().parse(await body(request));
      if (input.ownerId !== session.ownerId || !session.policy.privateMode || session.policy.owner !== "NONE") throw new HttpError(403, "Protected login required");
      await sessionJson(session, "/login-context", "POST", { startUrl: input.startUrl });
      session = save({ ...session, connectionId: input.connectionId, startUrl: input.startUrl,
        profileRevision: undefined, profileSavedAt: undefined, profileSaveError: undefined, cookieCheck: undefined });
      reply(response, 200, summary(session)); return;
    }
    if (segments[2] === "credentials" && request.method === "POST") {
      const input = z.object({ action: z.enum(["STATUS", "CONSENT", "DELETE"]), ownerId: z.string(), viewerId: z.string(),
        connectionId: z.string().optional(), operationId: z.string().min(8).max(128).optional(), expectedRevision: z.number().int().nonnegative().optional(),
        enabled: z.boolean().optional(), expectedCaptureRevision: z.number().int().nonnegative().optional() }).strict().parse(await body(request, 4096));
      if (input.ownerId !== session.ownerId || !session.policy.privateMode || session.policy.owner !== "USER"
          || input.viewerId !== session.policy.controllerId
          || (session.connectionId && input.connectionId !== session.connectionId)) throw new HttpError(403, "Private controller required");
      if (input.action !== "STATUS" && savingProfiles.has(session.id)) throw new HttpError(409, "Profile save in progress");
      const mutating = input.action !== "STATUS";
      if (mutating && changingCredentials.has(session.id)) throw new HttpError(409, "Credential change in progress");
      if (mutating) changingCredentials.add(session.id);
      try {
      if (input.action === "CONSENT") {
        if (input.enabled === undefined || input.expectedCaptureRevision === undefined || !input.operationId) throw new HttpError(400, "Consent operation incomplete");
        const storedRevision = input.connectionId ? (await credentials.metadata(input.connectionId, input.ownerId)).revision : 0;
        await sessionJson(session, "/credentials/consent", "POST", { viewerId: input.viewerId, enabled: input.enabled,
          operationId: input.operationId, expectedCaptureRevision: input.expectedCaptureRevision, storedRevision });
      }
      if (input.action === "DELETE") {
        if (!input.connectionId || !input.operationId || input.expectedRevision === undefined) throw new HttpError(400, "Credential operation incomplete");
        await credentials.write(input.connectionId, input.ownerId, input.operationId, input.expectedRevision, null);
        await sessionJson(session, "/credentials/clear", "POST", {});
      }
      const page = z.object({ origin: z.string().nullable(), captureEnabled: z.boolean(), captureRevision: z.number().int().nonnegative(), captureOrigin: z.string().nullable(),
        captureStatus: z.enum(["DISABLED", "ARMED", "CAPTURED", "UNSUPPORTED"]) }).parse(await sessionJson(session, "/credentials/context", "POST", { viewerId: input.viewerId }));
      reply(response, 200, { ...(input.connectionId ? await credentials.metadata(input.connectionId, input.ownerId) : { available: false, revision: 0, origin: null }),
        currentOrigin: page.origin, captureEnabled: page.captureEnabled, captureRevision: page.captureRevision, captureOrigin: page.captureOrigin, captureStatus: page.captureStatus }); return;
      } finally { if (mutating) changingCredentials.delete(session.id); }
    }
    if (segments[2] === "control" && request.method === "POST") {
      const input = Policy.extend({ deadlineAt: z.string().datetime().optional() }).parse(await body(request));
      const policy = Policy.parse(input);
      const deadlineAt = input.deadlineAt ?? new Date(Date.now() + 30_000).toISOString();
      if (Date.parse(deadlineAt) <= Date.now()) throw new HttpError(408, "Control deadline exceeded");
      if (policy.controlEpoch < session.policy.controlEpoch) throw new HttpError(409, "Stale control epoch");
      if (policy.owner === "USER" && !policy.controllerId) throw new HttpError(400, "Controller identity required");
      save({ ...saved(session.id), pendingOperation: { id: `control:${policy.controlEpoch}`, kind: "CONTROL", deadlineAt } });

      disconnectViewers(session.id, "control_changed");
      const result = await sessionJson(session, "/control", "POST", policy);
      const current = saved(session.id);
      if (current.closeRequested) throw new HttpError(409, "Browser closing");
      if (current.policy.controlEpoch <= policy.controlEpoch) save({ ...current, policy });
      if (policy.owner === "USER" && policy.privateMode && current.connectionId) {
        try {
          const value = await credentials.read(current.connectionId, current.ownerId);
          if (value) await sessionJson(saved(session.id), "/credentials/fill", "POST", { viewerId: policy.controllerId, ...value });
        } catch (error) {
          if (!(error instanceof StorageError) || error.code !== "PROFILE_STORAGE_UNAVAILABLE") throw error;
          // The control transition succeeded. Storage failure only prevents optional autofill.
          save({ ...saved(session.id), profileSaveError: error.code });
        }
      }
      const completed = saved(session.id);
      if (!completed.closeRequested && completed.pendingOperation?.id === `control:${policy.controlEpoch}`) {
        save({ ...completed, pendingOperation: undefined });
      }
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
      const input = z.object({ connectionId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), origins: z.array(z.url()).min(1).max(50), includeLoginOrigins: z.boolean().default(false), operationId: z.string().min(1).max(200).optional(), deadlineAt: z.string().datetime().optional() }).parse(await body(request));
      if (input.ownerId !== session.ownerId) throw new HttpError(403, "Profile owner mismatch");
      const operationId = input.operationId ?? `profile:${session.policy.controlEpoch}`;
      const previous = saved(session.id).pendingOperation;
      if (previous && previous.id !== operationId) throw new HttpError(409, "Operation in progress");
      const deadlineAt = previous?.deadlineAt ?? input.deadlineAt ?? new Date(Date.now() + 360_000).toISOString();
      if (Date.parse(deadlineAt) <= Date.now()) throw new HttpError(408, "Profile deadline exceeded");
      save({ ...saved(session.id), pendingOperation: { id: operationId, deadlineAt, kind: "PROFILE" } });
      try {
        const result = await exportSavedProfile(session, input.connectionId, input.origins, input.includeLoginOrigins, operationId);
        if (!saved(session.id).closeRequested) save({ ...saved(session.id), pendingOperation: undefined });
        reply(response, 200, result);
      }
      catch (error) {
        const code = error instanceof StorageError ? error.code : "PROFILE_SAVE_FAILED";
        save({ ...saved(session.id), profileSaveError: code }); throw error;
      }
      return;
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
    if (segments[2] === "observe" && request.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const endpoint = cursor ? "/observe?cursor=" + encodeURIComponent(z.uuid().parse(cursor)) : "/observe";
      reply(response, 200, await sessionJson(session, endpoint)); return;
    }
    if (segments[2] === "commands") {
      const endpoint = segments[3] ? `/commands/${z.uuid().parse(segments[3])}${segments[4] === "resolve" ? "/resolve" : segments[4] === "cancel" ? "/cancel" : ""}` : "/commands";
      let input = request.method === "POST" ? await body(request) : undefined;
      if (endpoint === "/commands" && request.method === "POST") {
        const command = z.object({ deadlineAt: z.string().datetime(), operationId: z.uuid(), type: z.string(), arguments: z.record(z.string(), z.unknown()) }).passthrough().parse(input);
        if (Date.parse(command.deadlineAt) <= Date.now()) throw new HttpError(408, "Operation deadline exceeded");
        const pending = saved(session.id).pendingOperation;
        if (pending && pending.id !== command.operationId) throw new HttpError(409, "Operation in progress");
        if (!pending) save({ ...saved(session.id), pendingOperation: { id: command.operationId, kind: "COMMAND", deadlineAt: command.deadlineAt } });
        if (command.type === "applyConnection") {
          const existing = await sessionRequest(session, `/commands/${command.operationId}`);
          if (existing.ok) {
            const result: unknown = await existing.json();
            reconcileAppliedConnection(session.id, result);
            reply(response, 200, result); return;
          }
          await existing.body?.cancel();
          if (existing.status !== 404) throw new HttpError(502, "Account switch receipt unavailable");
          const args = z.object({ connectionId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), origins: z.array(z.url()).min(1).max(50), url: z.url() }).strict().parse(command.arguments);
          if (args.ownerId !== session.ownerId) throw new HttpError(403, "Profile owner mismatch");
          disconnectViewers(session.id, "account_changed");
          await prepareProfile(session, args.connectionId, command.operationId, args.origins);
          input = { ...command, arguments: { ...args, profileId: command.operationId } };
        }
      }
      const result = await sessionJson(session, endpoint, request.method ?? "GET", input);
      reconcileAppliedConnection(session.id, result);
      const receipt = z.object({ operationId: z.string(), status: z.string() }).safeParse(result);
      if (receipt.success && receipt.data.status !== "RUNNING" && saved(session.id).pendingOperation?.id === receipt.data.operationId) {
        save({ ...saved(session.id), pendingOperation: undefined });
      }
      reply(response, 200, result); return;
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    reply(response, error instanceof HttpError || error instanceof StorageError ? error.status : error instanceof CredentialConflict ? 409 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 502, { error: error instanceof HttpError || error instanceof StorageError ? error.message : "Operation unavailable", ...(error instanceof StorageError ? { code: error.code } : {}) });
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
    for (const viewer of group) if (viewer.viewerId === ticket.viewerId) viewer.close("viewer_replaced");
    if (group.size >= 2 || !session.address || session.status !== "LIVE") throw new HttpError(409, "View unavailable");
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(`ws://${session.address}:8080/view?role=${ticket.role}&epoch=${session.policy.controlEpoch}&viewerId=${encodeURIComponent(ticket.viewerId)}`, { headers: { "X-Worker-Token": session.token }, handshakeTimeout: 10_000, perMessageDeflate: false, maxPayload: 16_777_216 });
      const connectionId = randomUUID();
      const bridge = bridgeViewer(client, upstream, event => {
        group.delete(viewer);
        if (group.size === 0 && viewers.get(session.id) === group) viewers.delete(session.id);
        console.info(JSON.stringify({ event: "viewer_disconnected", connectionId, sessionId: session.id, ...event }));
      });
      const viewer = { close: bridge.close, viewerId: ticket.viewerId, role: ticket.role, access: ticket.access };
      group.add(viewer); viewers.set(session.id, group);
    });
  } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
});
server.listen(8090, "0.0.0.0");
void recoverSessionRoutes();
// Manager shutdown never terminates session containers; a replacement manager reconciles them.
