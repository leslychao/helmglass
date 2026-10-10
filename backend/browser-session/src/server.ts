import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Download } from "playwright";
import { fetch, ProxyAgent } from "undici";
import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import { cookieMatchesHost, exportProfile, ProfileExportError, trackLoginOrigins } from "./profile-export.js";
import { profileExportUrl } from "./profile-target.js";
import { importProfile } from "./profile-import.js";
import { fillSavedCredential, type SavedCredential } from "./credential-autofill.js";
import { CredentialCapture, CaptureConflict } from "./credential-capture.js";
import { BrowserMcp, BrowserRejection, McpExecutionUnconfirmed } from "./browser-mcp.js";
import { snapshotUrl } from "./browser-privacy.js";
import { artifactResponse, operationReceipt } from "./session-records.js";

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
const sessionId = z.uuid().parse(required("SESSION_ID"));
const token = required("SESSION_TOKEN");
const proxyIp = z.ipv4().parse(required("PROXY_IP"));
const screenWidth = z.coerce.number().int().positive().parse(required("BROWSER_SCREEN_WIDTH"));
const screenHeight = z.coerce.number().int().positive().parse(required("BROWSER_SCREEN_HEIGHT"));
const proxy = `http://${proxyIp}:3128`;
const dispatcher = new ProxyAgent(proxy);
const dataDirectory = process.env["DATA_DIR"] ?? "/data";
await mkdir(path.join(dataDirectory, "artifacts"), { recursive: true });
const db = new DatabaseSync(path.join(dataDirectory, "session.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, document TEXT NOT NULL);");
db.exec("UPDATE operations SET status='UNKNOWN' WHERE status='RUNNING';");
const Policy = z.object({ controlEpoch: z.number().int().nonnegative(), owner: z.enum(["CHATGPT", "USER", "NONE"]), privateMode: z.boolean(), controllerId: z.string().max(200).optional() });
type Policy = z.infer<typeof Policy>;
const savedPolicy = db.prepare("SELECT value FROM state WHERE id='policy'").get();
let policy: Policy = savedPolicy ? Policy.parse(JSON.parse(z.string().parse(savedPolicy["value"]))) : { controlEpoch: 0, owner: "NONE", privateMode: false };
let savedCredential: SavedCredential | undefined;
const credentialCapture = new CredentialCapture();
let activeAutofills = 0;
const loginOrigins = new Set<string>();
let loginScopeRevision = 0;
let flushLoginOrigins: (() => Promise<void>) | undefined;
let exportingProfile = false;
const previouslyStarted = Boolean(db.prepare("SELECT value FROM state WHERE id='started'").get());
let status: "STARTING" | "LIVE" | "LOST" = previouslyStarted ? "LOST" : "STARTING";
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let currentPage: Page | undefined;
let initialization: Promise<void> | undefined;
const profileImports = new Map<string, BrowserContext>();
let activeOperation: string | undefined;
let activeAbort: AbortController | undefined;
let activeWork: Promise<object> | undefined;
let browserMcp: BrowserMcp | undefined;
let changingControl: { policy: Policy; completion: Promise<object> } | undefined;
let navigationError: string | undefined;
const viewers = new Set<WebSocket>();
const pages = new Map<string, Page>();
const pageIds = new WeakMap<Page, string>();
type MediaSource = { id: string; pageId: string; frame: Frame; sourceUrl: string; mimeType: string; headers: Record<string, string>; complete: boolean; observedAt: string };
const media = new Map<string, MediaSource>();
let mediaTruncated = false;
const snapshotLimits = { nodes: 20_000, label: 2000, url: 8192, mimeType: 200, media: 100 };
const pendingDownloads = new Map<string, { completion: Promise<unknown>; abort: AbortController; download: Download }>();
let blobCapture: { nonce: string; frame: Frame; stream: PassThrough } | undefined;

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
class BeforeEffectRejection extends HttpError {}
function reply(response: ServerResponse, code: number, value: unknown): void { response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }
async function body(request: IncomingMessage, max = 8_388_608): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); length += chunk.length;
    if (length > max) throw new HttpError(413, "Request too large"); chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function authorized(request: IncomingMessage): boolean {
  const value = request.headers["x-worker-token"];
  return typeof value === "string" && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
function selectedPage(): Page { if (status !== "LIVE" || !currentPage || currentPage.isClosed()) throw new HttpError(409, "Browser unavailable"); return currentPage; }
function publicUrl(value: string): string { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new HttpError(400, "Only HTTP(S) URLs are allowed"); return url.href; }
function observationAllowed(): void {
  if (policy.privateMode) throw new HttpError(423, "Private input in progress");
  if (changingControl) throw new HttpError(409, "Control transfer in progress");
  if (exportingProfile) throw new HttpError(409, "Profile save in progress");
}
async function privateAutofill(page: Page, credential: SavedCredential): Promise<boolean> {
  activeAutofills++;
  try { return await fillSavedCredential(page, credential); }
  finally { activeAutofills--; }
}
function summary(): object { return { id: sessionId, status, controlEpoch: policy.controlEpoch, controlOwner: policy.owner, controllerId: policy.controllerId, privateMode: policy.privateMode, ...(!policy.privateMode && currentPage ? { currentUrl: snapshotUrl(currentPage.url()), navigationError } : {}) }; }

async function saveArtifact(stream: Readable, metadata: { name: string; mimeType: string; sourceUrl: string; sourceRef?: string; complete: boolean; pageId?: string; operationId?: string }, signal?: AbortSignal): Promise<object> {
  const id = randomUUID(); const temporary = path.join(dataDirectory, "artifacts", `${id}.partial`); const final = path.join(dataDirectory, "artifacts", id);
  const hash = createHash("sha256"); let sizeBytes = 0;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    sizeBytes += chunk.length;
    if (sizeBytes > 2_147_483_648) { callback(new Error("File exceeds 2 GiB storage limit")); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  try {
    await pipeline(stream, counter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
    if (sizeBytes === 0) throw new Error("Empty file");
    await rename(temporary, final);
    if (metadata.mimeType === "application/octet-stream" || metadata.mimeType === "audio/unknown") {
      const file = await open(final, "r");
      try {
        const header = Buffer.alloc(8192); const read = await file.read(header, 0, header.length, 0);
        const detected = await fileTypeFromBuffer(header.subarray(0, read.bytesRead)).catch(() => undefined);
        if (detected?.mime.startsWith("audio/")) metadata.mimeType = detected.mime;
      } finally { await file.close(); }
    }
    signal?.throwIfAborted();
    observationAllowed();
    const artifact = { id, ...metadata, name: metadata.name.slice(0, 240), sizeBytes, sha256: hash.digest("hex"), createdAt: new Date().toISOString() };
    db.prepare("INSERT INTO artifacts(id,document) VALUES(?,?)").run(id, JSON.stringify(artifact));
    return artifact;
  } catch (error) { await rm(temporary, { force: true }); await rm(final, { force: true }); throw error; }
}
async function saveDownload(download: Download, pageId: string, signal: AbortSignal, operationId?: string): Promise<object> {
  try {
    const stream = await download.createReadStream();
    return await saveArtifact(stream, { name: download.suggestedFilename(), mimeType: "application/octet-stream", sourceUrl: download.url(), complete: true, pageId, operationId }, signal);
  } finally { await download.delete(); }
}
function registerPage(page: Page): void {
  if (page.url() === profileExportUrl) return;
  const id = randomUUID(); pages.set(id, page); pageIds.set(page, id); currentPage = page;
  page.on("close", () => { pages.delete(id); if (currentPage === page) currentPage = [...pages.values()].at(-1); });
  page.on("download", (download) => {
    if (policy.privateMode) {
      void download.cancel().finally(() => download.delete())
        .catch(() => console.error("Private download cleanup failed"));
      return;
    }
    const downloadId = randomUUID(); const abort = new AbortController();
    const completion = saveDownload(download, id, abort.signal, activeOperation).finally(() => pendingDownloads.delete(downloadId));
    pendingDownloads.set(downloadId, { completion, abort, download }); completion.catch(() => {});
  });
  page.on("response", (response) => {
    if (policy.privateMode) return;
    const mime = response.headers()["content-type"]?.split(";")[0]?.trim() ?? "";
    if (!mime.startsWith("audio/") && !/\.(mp3|wav|ogg|opus|m4a|aac|flac)(?:\?|$)/i.test(response.url())) return;
    if (response.url().length > snapshotLimits.url || mime.length > snapshotLimits.mimeType) { mediaTruncated = true; return; }
    const epoch = policy.controlEpoch;
    void response.request().allHeaders().then((headers) => {
      if (policy.privateMode || epoch !== policy.controlEpoch) return;
      const existing = [...media.values()].find((item) => item.sourceUrl === response.url() && item.pageId === id);
      if (!existing) while (media.size >= snapshotLimits.media) { const first = media.keys().next().value; if (first) media.delete(first); mediaTruncated = true; }
      const mediaId = existing?.id ?? randomUUID();
      media.set(mediaId, { id: mediaId, pageId: id, frame: response.frame(), sourceUrl: response.url(), mimeType: mime || "application/octet-stream", headers, complete: response.status() === 200, observedAt: new Date().toISOString() });
    }).catch(() => {});
  });
}
async function createContext(): Promise<BrowserContext> {
  if (!browser) throw new HttpError(409, "Browser unavailable");
  const created = await browser.newContext({ viewport: null, acceptDownloads: true, locale: "ru-RU", serviceWorkers: "allow" });
    await credentialCapture.install(created, (page) => !exportingProfile && policy.privateMode && policy.owner === "USER" && page === currentPage);
    const lastAutofill = new WeakMap<Page, number>();
    await created.exposeBinding("__helmPrivateAutofill", async (source) => {
      if (!policy.privateMode || policy.owner !== "USER" || !savedCredential
          || source.frame !== source.page.mainFrame() || source.page.isClosed()) return;
      const now = Date.now();
      if (now - (lastAutofill.get(source.page) ?? 0) < 250) return;
      lastAutofill.set(source.page, now);
      await privateAutofill(source.page, savedCredential);
    });
    await created.addInitScript(() => {
      let pending = false;
      const notify = () => {
        if (pending) return;
        pending = true;
        setTimeout(() => {
          pending = false;
          const callback: unknown = Reflect.get(window, "__helmPrivateAutofill");
          if (typeof callback === "function") Promise.resolve(callback()).catch(() => {});
        }, 300);
      };
      document.addEventListener("DOMContentLoaded", () => {
        notify(); new MutationObserver(notify).observe(document, { subtree: true, childList: true });
      }, { once: true });
    });
    await created.exposeBinding("__helmVisiblePage", async (source) => {
      if (!pageIds.has(source.page) || source.page.isClosed()) return;
      const visible = await source.page.evaluate(() => document.visibilityState === "visible" && document.hasFocus());
      if (visible) currentPage = source.page;
    });
    await created.addInitScript(() => {
      const update = () => {
        const notify: unknown = Reflect.get(window, "__helmVisiblePage");
        if (typeof notify === "function" && document.visibilityState === "visible" && document.hasFocus()) Promise.resolve(notify()).catch(() => {});
      };
      window.addEventListener("focus", update);
      document.addEventListener("visibilitychange", update);
    });
    await created.exposeBinding("__helmOriginalAudioChunk", async (source, payload: unknown) => {
      const input = z.object({ nonce: z.uuid(), data: z.string().max(87_384) }).parse(payload);
      const transfer = blobCapture;
      if (!transfer || source.frame !== transfer.frame || input.nonce !== transfer.nonce || transfer.stream.destroyed || policy.privateMode) throw new Error("Audio transfer unavailable");
      if (!transfer.stream.write(Buffer.from(input.data, "base64"))) await once(transfer.stream, "drain");
    });
    created.setDefaultTimeout(20_000); created.setDefaultNavigationTimeout(40_000);
    created.on("page", registerPage);
    flushLoginOrigins = trackLoginOrigins(created, loginOrigins,
      () => policy.privateMode && !exportingProfile, () => loginScopeRevision);
    return created;
}
async function initialize(input: { startUrl: string }): Promise<void> {
  if (previouslyStarted || status === "LOST") return;
  db.prepare("INSERT OR REPLACE INTO state(id,value) VALUES('started','true')").run();
  try {
    browser = await chromium.launch({
      headless: false, chromiumSandbox: true,
      proxy: { server: proxy, bypass: "<-loopback>" },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-features=WebRtcAllowInputVolumeAdjustment", "--no-first-run", `--window-size=${screenWidth},${screenHeight}`, "--window-position=0,0"],
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/home/node", DISPLAY: ":99", LANG: "ru_RU.UTF-8" },
    });
    browser.on("disconnected", () => { status = "LOST"; for (const viewer of viewers) viewer.close(1011, "Browser lost"); });
    context = await createContext();
    const page = await context.newPage();
    if (input.startUrl !== "about:blank") {
      // Initial navigation is not repeated if the caller loses its response.
      try { await page.goto(publicUrl(input.startUrl), { waitUntil: "domcontentloaded" }); }
      catch { navigationError = "Initial navigation failed; the browser remains open"; }
    }
    // Health polling must not dispatch the first action into the initial navigation.
    status = browser.isConnected() && !page.isClosed() ? "LIVE" : "LOST";
  } catch { status = "LOST"; await browser?.close(); throw new HttpError(502, "Browser launch failed"); }
}

const Command = z.object({ deadlineAt: z.string().datetime(), operationId: z.uuid(), type: z.enum(["navigate", "click", "fill", "press", "selectOption", "check", "scroll", "goBack", "newTab", "selectTab", "closeTab", "observe", "screenshot", "listMedia", "captureAudio", "waitFor", "applyConnection"]), arguments: z.record(z.string(), z.unknown()).default({}), instructionRevision: z.number().int().nonnegative(), controlEpoch: z.number().int().nonnegative(), observeAfter: z.boolean().default(true), sequence: z.object({ operationIds: z.array(z.uuid()).min(1).max(8) }).strict().optional() }).strict();
type Command = z.infer<typeof Command>;
const readCommands = new Set(["observe", "screenshot", "listMedia", "captureAudio", "waitFor",
  "navigate", "goBack", "scroll", "newTab", "selectTab", "closeTab"]);
async function mcp(): Promise<BrowserMcp> {
  if (!context) throw new HttpError(409, "Browser unavailable");
  if (browserMcp?.isClosing) await closeMcp();
  browserMcp ??= new BrowserMcp(context, selectedPage, () => policy.controlEpoch, observationAllowed);
  return browserMcp;
}
async function closeMcp(): Promise<void> {
  try { await browserMcp?.close(); }
  catch (error) {
    if (!(error instanceof McpExecutionUnconfirmed)) throw error;
    if (activeOperation) db.prepare("UPDATE operations SET status='UNKNOWN' WHERE id=? AND status='RUNNING'").run(activeOperation);
    // A dialog or lost RPC acknowledgement can leave a native callback running.
    // The launcher stops Chromium/X11, and the node confirms the container has stopped.
    process.exit(1);
  }
  browserMcp = undefined;
}
async function observe(args: Record<string, unknown> = {}, signal?: AbortSignal, command?: Command): Promise<object> {
  observationAllowed();
  const page = selectedPage();
  const snapshot = await (await mcp()).observe(args, signal, command?.operationId, command?.sequence);
  return observationEnvelope(snapshot, page);
}
function observationEnvelope(snapshot: object, page = selectedPage()): object {
  const tabs: { id: string; url?: string; active: boolean }[] = [];
  let tabBytes = 0;
  for (const [id, item] of pages) {
    if (item.context() !== context || tabs.length === 20) continue;
    const url = snapshotUrl(item.url());
    const available = url && Buffer.byteLength(url) <= 1000 && tabBytes + Buffer.byteLength(url) < 2000;
    if (available) tabBytes += Buffer.byteLength(url);
    tabs.push({ id, ...(available ? { url } : {}), active: item === page });
  }
  observationAllowed();
  const url = snapshotUrl(page.url());
  return { ...(url && Buffer.byteLength(url) <= 1000 ? { url } : {}), ...snapshot, tabs };
}
async function listMedia(): Promise<object> {
  observationAllowed();
  const page = selectedPage(); const pageId = pageIds.get(page);
  if (!pageId) throw new HttpError(409, "Page unavailable");
  const sources: { url: string; mimeType: string; label: string }[] = [];
  let inspected = 0; let frames = 0; let truncated = false;
  for (const frame of page.frames()) {
    if (frames >= snapshotLimits.media || inspected >= snapshotLimits.nodes || sources.length >= snapshotLimits.media) { truncated = true; break; }
    frames++;
    if (frame.isDetached()) continue;
    const snapshot = await frame.evaluate((limits) => {
      const found: { url: string; mimeType: string; label: string }[] = [];
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
      let inspected = 0; let truncated = false;
      const add = (url: string, mimeType: string, label: string) => {
        // URLs are identifiers: never register a shortened URL as a real capture target.
        if (url.length > limits.url || mimeType.length > limits.mimeType) { truncated = true; return; }
        if (label.length > limits.label) truncated = true;
        found.push({ url, mimeType, label: label.slice(0, limits.label) });
      };
      while (walker.nextNode()) {
        if (inspected >= limits.nodes || found.length >= limits.media) { truncated = true; break; }
        inspected += 1; const element = walker.currentNode;
        if (element instanceof HTMLMediaElement) {
          const url = element.currentSrc || element.src;
          if (url) add(url, "audio/unknown", element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "");
        }
        if (element instanceof HTMLSourceElement && element.src) add(element.src, element.type || "audio/unknown", element.parentElement?.getAttribute("aria-label") ?? "");
      }
      return { sources: found, inspected, truncated };
    }, { ...snapshotLimits, nodes: snapshotLimits.nodes - inspected, media: snapshotLimits.media - sources.length });
    observationAllowed();
    inspected += snapshot.inspected;
    truncated ||= snapshot.truncated;
    sources.push(...snapshot.sources);
    for (const source of snapshot.sources) {
      if (!["http:", "https:", "blob:"].includes(new URL(source.url).protocol)) continue;
      const existing = [...media.values()].find((item) => item.sourceUrl === source.url && item.pageId === pageId);
      if (existing) { existing.frame = frame; continue; }
      while (media.size >= snapshotLimits.media) { const first = media.keys().next().value; if (first) media.delete(first); mediaTruncated = true; }
      const id = randomUUID();
      media.set(id, { id, pageId, frame, sourceUrl: source.url, mimeType: source.mimeType, headers: {}, complete: false, observedAt: new Date().toISOString() });
    }
  }
  observationAllowed();
  return { media: [...media.values()].map(({ headers: _headers, frame: _frame, ...item }) => item), sources, truncated: truncated || mediaTruncated };
}
async function captureBlob(source: MediaSource, sourceRef: string, name: string, signal: AbortSignal): Promise<object> {
  signal.throwIfAborted();
  const page = pages.get(source.pageId);
  if (!page || page.isClosed()) throw new HttpError(409, "Source page is no longer available");
  const frame = source.frame;
  if (frame.isDetached()) throw new HttpError(409, "Source frame is no longer available");
  const stream = new PassThrough({ highWaterMark: 65_536 }); const nonce = randomUUID();
  blobCapture = { nonce, frame, stream };
  const metadata = { name, mimeType: "application/octet-stream", sourceUrl: source.sourceUrl, sourceRef, complete: true, pageId: source.pageId, operationId: activeOperation };
  const saved = saveArtifact(stream, metadata, signal);
  saved.catch(() => {});
  const abort = () => stream.destroy(new Error("Audio transfer cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    const transfer = frame.evaluate(async ({ url, transferId }) => {
      const bridge: unknown = Reflect.get(window, "__helmOriginalAudioChunk");
      if (typeof bridge !== "function") throw new Error("Audio transfer unavailable");
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error("Blob audio unavailable");
      const mimeType = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
      if (!mimeType.startsWith("audio/") && mimeType !== "application/octet-stream") { await response.body.cancel(); throw new Error("Source is not an audio file"); }
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          for (let offset = 0; offset < chunk.value.length; offset += 65_536) {
            const part = chunk.value.subarray(offset, offset + 65_536); let text = "";
            for (const byte of part) text += String.fromCharCode(byte);
            await bridge({ nonce: transferId, data: btoa(text) });
          }
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      return { mimeType };
    }, { url: source.sourceUrl, transferId: nonce });
    // Storage rejection releases the operation even if the page's producer stalls.
    // The bounded binding rejects its next chunk after cancellation.
    const detected = z.object({ mimeType: z.string() }).parse(await Promise.race([transfer, saved]));
    signal.throwIfAborted();
    metadata.mimeType = detected.mimeType;
    stream.end();
    return await saved;
  } catch (error) { stream.destroy(new Error("Audio source interrupted")); await saved.catch(() => {}); throw error; }
  finally { signal.removeEventListener("abort", abort); blobCapture = undefined; }
}
async function captureAudio(args: Record<string, unknown>, signal: AbortSignal): Promise<object> {
  observationAllowed();
  const input = z.object({ sourceId: z.uuid(), sourceRef: z.string().min(1).max(2000), name: z.string().max(240).optional() }).parse(args);
  const source = media.get(input.sourceId);
  if (!source) throw new HttpError(404, "Requested audio source has not been observed in this browser");
  const existing = db.prepare("SELECT document FROM artifacts WHERE json_extract(document,'$.sourceRef')=? AND json_extract(document,'$.sourceUrl')=? LIMIT 1").get(input.sourceRef, source.sourceUrl);
  if (existing) return { artifact: JSON.parse(z.string().parse(existing["document"])) };
  if (source.sourceUrl.startsWith("blob:")) return { artifact: await captureBlob(source, input.sourceRef, input.name ?? "original-audio", signal) };
  const url = publicUrl(source.sourceUrl);
  const headers: Record<string, string> = {};
  for (const key of ["authorization", "cookie", "referer", "origin", "user-agent", "accept"]) if (source.headers[key]) headers[key] = source.headers[key];
  const sourceContext = pages.get(source.pageId)?.context();
  if (!headers["cookie"] && sourceContext) headers["cookie"] = (await sourceContext.cookies(url)).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  // Range is intentionally omitted: preserve the whole original, not the player's preview range.
  const response = await fetch(url, { dispatcher, headers, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new HttpError(409, `Audio source unavailable (${response.status})`); }
  const mimeType = response.headers.get("content-type")?.split(";")[0] ?? source.mimeType;
  if (!mimeType.startsWith("audio/") && mimeType !== "application/octet-stream") { await response.body.cancel(); throw new HttpError(409, "Source is not an original audio file"); }
  const artifact = await saveArtifact(Readable.fromWeb(response.body), { name: input.name ?? (path.posix.basename(new URL(url).pathname) || "audio"), mimeType, sourceUrl: url, sourceRef: input.sourceRef, complete: response.status === 200, pageId: source.pageId, operationId: activeOperation }, signal);
  return { artifact };
}
async function applyConnection(args: Record<string, unknown>, signal: AbortSignal): Promise<object> {
  const input = z.object({ connectionId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), origins: z.array(z.url()).min(1).max(50), url: z.url(), profileId: z.uuid() }).parse(args);
  const target = new URL(publicUrl(input.url));
  const origins = input.origins.map((value) => new URL(publicUrl(value)).origin);
  if (!origins.includes(target.origin)) throw new BeforeEffectRejection(403, "Account switch destination was not confirmed");
  if (!browser) throw new HttpError(409, "Browser unavailable");
  const hosts = origins.map((origin) => new URL(origin).hostname);
  const matchesCookie = (domain: string) => hosts.some((host) => cookieMatchesHost(domain, host));
  const replacement = profileImports.get(input.profileId);
  if (!replacement) throw new BeforeEffectRejection(409, "Imported profile unavailable");
  const previousContexts = browser.contexts().filter((item) => item !== replacement);
  // A fresh context isolates the selected account while retaining the same Chromium process.
  // setStorageState on a live context would erase unrelated origins and their OPFS.
  profileImports.delete(input.profileId);
  credentialCapture.clear();
  signal.throwIfAborted();
  const replacementPage = await replacement.newPage();
  for (const previous of previousContexts) {
    signal.throwIfAborted();
    const affected = previous.pages().filter((page) => origins.includes(new URL(page.url()).origin));
    for (const page of affected) await page.close();
    const retained = previous.pages()[0];
    if (!retained) { await previous.close(); continue; }
    const cdp = await previous.newCDPSession(retained);
    try {
      for (const origin of origins) { signal.throwIfAborted(); await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }); }
      for (const cookie of await previous.cookies()) {
        if (matchesCookie(cookie.domain)) await previous.clearCookies({ domain: cookie.domain, name: cookie.name, path: cookie.path });
      }
    } finally { await cdp.detach(); }
  }
  await closeMcp();
  context = replacement; currentPage = replacementPage; media.clear(); mediaTruncated = false;
  await replacementPage.goto(target.href, { waitUntil: "domcontentloaded", signal });
  await replacementPage.bringToFront();
  return { connectionId: input.connectionId, url: replacementPage.url(), switched: true };
}
async function perform(command: Command, signal: AbortSignal): Promise<object> {
  signal.throwIfAborted();
  const page = selectedPage(); const args = command.arguments;
  switch (command.type) {
    case "applyConnection": return applyConnection(args, signal);
    case "observe": return observe(args, signal, command);
    case "listMedia": return listMedia();
    case "captureAudio": return captureAudio(args, signal);
    case "screenshot": {
      z.object({}).strict().parse(args);
      const filename = await (await mcp()).screenshot(command.operationId, signal);
      try {
        observationAllowed();
        const artifact = await saveArtifact(createReadStream(filename), { name: "screenshot.png", mimeType: "image/png", sourceUrl: page.url(), complete: true, operationId: activeOperation }, signal);
        return { artifact };
      } finally { await rm(filename, { force: true }); }
    }
    default: {
      const input = { ...args };
      if (command.type === "navigate" || command.type === "newTab") {
        if (input["url"] !== undefined) input["url"] = publicUrl(z.string().max(8192).parse(input["url"]));
      }
      if (command.type === "newTab" && pages.size >= 20) throw new BrowserRejection("Browser tab limit reached");
      if (command.type === "closeTab" && pages.size <= 1) throw new BrowserRejection("Cannot close the only task page");
      if (command.type === "selectTab") {
        const tab = pages.get(z.uuid().parse(input["tabId"]));
        if (!tab || tab.context() !== context) throw new BrowserRejection("Tab not found");
        delete input["tabId"];
        input["index"] = context.pages().indexOf(tab);
        await (await mcp()).act(command.type, input, command.operationId, command.sequence, signal);
        currentPage = tab;
      } else {
        await (await mcp()).act(command.type, input, command.operationId, command.sequence, signal);
      }
    }
  }
  await Promise.all([...pendingDownloads.values()].map((download) => download.completion));
  const rows = db.prepare("SELECT document FROM artifacts WHERE json_extract(document,'$.operationId')=? ORDER BY rowid LIMIT 100").all(command.operationId);
  const artifacts = rows.map((row) => JSON.parse(z.string().parse(row["document"])));
  return { url: snapshotUrl(selectedPage().url()), ...(artifacts.length ? { artifacts } : {}) };
}
function receipt(id: string): object | undefined {
  return operationReceipt(db, id);
}
async function execute(command: Command): Promise<object> {
  const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const previous = db.prepare("SELECT fingerprint FROM operations WHERE id=?").get(command.operationId);
  if (previous) {
    // Cancellation can arrive before dispatch. Its durable receipt fences any late command.
    if (previous["fingerprint"] === "") return receipt(command.operationId) ?? { operationId: command.operationId, status: "FAILED" };
    if (previous["fingerprint"] !== fingerprint) throw new HttpError(409, "Operation identity conflict");
    return receipt(command.operationId) ?? { operationId: command.operationId, status: "UNKNOWN" };
  }
  if (Date.parse(command.deadlineAt) <= Date.now()) throw new BeforeEffectRejection(408, "Operation deadline exceeded");
  observationAllowed();
  if ((command.type !== "applyConnection" && policy.owner !== "CHATGPT") || command.controlEpoch !== policy.controlEpoch) throw new HttpError(409, "Control not granted for this epoch");
  if (activeOperation || exportingProfile) throw new HttpError(409, "Another command is running");
  const unresolved = db.prepare("SELECT id FROM operations WHERE status='UNKNOWN' LIMIT 1").get();
  if (unresolved && !readCommands.has(command.type)) throw new HttpError(409, "Unknown result requires reconciliation");
  selectedPage(); activeOperation = command.operationId; const abort = new AbortController(); activeAbort = abort;
  // Durable before external dispatch: restart or a lost response never replays a mutation.
  db.prepare("INSERT INTO operations(id,fingerprint,status) VALUES(?,?,'RUNNING')").run(command.operationId, fingerprint);
  const deadlineTimer = setTimeout(() => abort.abort(new Error("Operation deadline exceeded")),
    Math.max(0, Date.parse(command.deadlineAt) - Date.now()));
  const terminationTimer = setTimeout(() => {
    if (activeOperation === command.operationId) {
      db.prepare("UPDATE operations SET status=? WHERE id=? AND status='RUNNING'")
        .run(readCommands.has(command.type) ? "FAILED" : "UNKNOWN", command.operationId);
      // The node also confirms and stops the entire container, including X11.
      process.exit(1);
    }
  }, Math.max(0, Date.parse(command.deadlineAt) + 10_000 - Date.now()));
  try {
    let result = await perform(command, abort.signal);
    if (command.observeAfter && command.type !== "observe" && !("observation" in result)) {
      try { result = { ...result, observation: await observe() }; }
      catch (error) { result = { ...result, observationError: error instanceof BrowserRejection && error.code ? error.code : "OBSERVATION_UNAVAILABLE" }; }
    }
    abort.signal.throwIfAborted();
    if (command.controlEpoch !== policy.controlEpoch) throw new HttpError(409, "Control changed while the action was in progress; verify its result");
    db.prepare("UPDATE operations SET status='SUCCEEDED',result=? WHERE id=?").run(JSON.stringify({ result }), command.operationId);
  } catch (error) {
    const outcome = readCommands.has(command.type) || error instanceof z.ZodError || error instanceof BeforeEffectRejection || error instanceof BrowserRejection ? "FAILED" : "UNKNOWN";
    db.prepare("UPDATE operations SET status=?,result=? WHERE id=?").run(outcome, JSON.stringify({ error: error instanceof HttpError || error instanceof BrowserRejection ? error.message : outcome === "UNKNOWN" ? "The action may have reached the site; verify its result before continuing" : "Browser read failed", ...(error instanceof BrowserRejection && error.code ? { code: error.code } : {}) }), command.operationId);
    if (outcome === "UNKNOWN") await closeMcp();
  } finally {
    if (browserMcp?.requiresStop) await closeMcp();
    clearTimeout(deadlineTimer); clearTimeout(terminationTimer); activeOperation = undefined; activeAbort = undefined;
  }
  return receipt(command.operationId) ?? { operationId: command.operationId, status: "UNKNOWN" };
}

const server = http.createServer(async (request, response) => {
  try {
    if (!authorized(request)) throw new HttpError(401, "Unauthorized");
    const url = new URL(request.url ?? "/", "http://session");
    if (url.pathname === "/health") { reply(response, 200, summary()); return; }
    if (url.pathname === "/initialize" && request.method === "POST") {
      const input = z.object({ startUrl: z.string().max(8192) }).strict().parse(await body(request));
      if (!initialization && status === "STARTING") initialization = initialize(input);
      await initialization; reply(response, 200, summary()); return;
    }
    if (url.pathname.startsWith("/profile/import/")) {
      const id = z.uuid().parse(url.pathname.slice("/profile/import/".length));
      const activated = db.prepare("SELECT value FROM state WHERE id='profile-import'").get()?.["value"] === id;
      if (request.method === "GET") {
        if (!activated && !profileImports.has(id)) throw new HttpError(404, "Profile import not found");
        reply(response, 200, { ready: true, activated }); return;
      }
      if (request.method === "POST") {
        if (activeOperation || exportingProfile || status !== "LIVE") throw new HttpError(409, "Browser work in progress");
        if (activated || profileImports.has(id)) { request.resume(); reply(response, 200, { ready: true, activated }); return; }
        const scope = url.searchParams.get("origins");
        const origins = scope ? z.array(z.url()).min(1).max(50).parse(JSON.parse(scope)) : undefined;
        exportingProfile = true;
        let replacement: BrowserContext | undefined;
        try {
          for (const staged of profileImports.values()) await staged.close();
          profileImports.clear();
          replacement = await createContext();
          await importProfile(replacement, request, origins); profileImports.set(id, replacement);
        }
        catch (error) { await replacement?.close(); throw error; }
        finally { exportingProfile = false; if (currentPage && !currentPage.isClosed()) await currentPage.bringToFront(); }
        reply(response, 200, { ready: true, activated: false }); return;
      }
    }
    if (url.pathname === "/profile/activate" && request.method === "POST") {
      const input = z.object({ id: z.uuid(), startUrl: z.string().max(8192) }).strict().parse(await body(request));
      if (db.prepare("SELECT value FROM state WHERE id='profile-import'").get()?.["value"] === input.id) { reply(response, 200, summary()); return; }
      if (activeOperation || exportingProfile) throw new HttpError(409, "Browser work in progress");
      const replacement = profileImports.get(input.id);
      if (!replacement || !browser) throw new HttpError(409, "Imported profile unavailable");
      const previous = browser.contexts().filter((item) => item !== replacement);
      const page = await replacement.newPage();
      await closeMcp();
      context = replacement; currentPage = page; profileImports.delete(input.id); credentialCapture.clear();
      db.prepare("INSERT INTO state(id,value) VALUES('profile-import',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(input.id);
      for (const old of previous) await old.close();
      if (input.startUrl !== "about:blank") {
        try { await page.goto(publicUrl(input.startUrl), { waitUntil: "domcontentloaded" }); }
        catch { navigationError = "Initial navigation failed; the browser remains open"; }
      }
      await page.bringToFront(); reply(response, 200, summary()); return;
    }
    if (url.pathname === "/control" && request.method === "POST") {
      const input = Policy.parse(await body(request));
      if (changingControl) {
        if (JSON.stringify(input) !== JSON.stringify(changingControl.policy)) throw new HttpError(409, "Control transfer in progress");
        reply(response, 200, await changingControl.completion); return;
      }
      if (input.controlEpoch < policy.controlEpoch || (input.controlEpoch === policy.controlEpoch && JSON.stringify(input) !== JSON.stringify(policy))) throw new HttpError(409, "Stale control epoch");
      if (JSON.stringify(input) === JSON.stringify(policy)) { reply(response, 200, summary()); return; }
      // Never expose a renderer while a private password injection is still pending.
      if (activeAutofills || exportingProfile) throw new HttpError(409, "Private browser work is finishing");
      if (input.owner === "USER" && !input.controllerId) throw new HttpError(400, "Controller identity required");
      if (activeOperation && input.owner !== "NONE") throw new HttpError(409, "Wait for the dispatched action to finish");
      const transfer = { policy: input, completion: Promise.resolve().then(async () => {
        activeAbort?.abort();
        await activeWork;
        await closeMcp();
        if (input.privateMode) {
          for (const download of pendingDownloads.values()) {
            download.abort.abort();
            void download.download.cancel().catch(() => {});
          }
        }
        for (const viewer of viewers) viewer.terminate(); viewers.clear();
        if (!input.privateMode || input.owner !== "USER") savedCredential = undefined;
        if (!input.privateMode || (input.owner === "USER" && input.controllerId !== policy.controllerId)) credentialCapture.clear();
        if (input.privateMode && !policy.privateMode) {
          loginOrigins.clear(); loginScopeRevision++;
          if (currentPage) {
            const current = new URL(currentPage.url());
            if (["http:", "https:"].includes(current.protocol)) loginOrigins.add(current.origin);
          }
        }
        policy = input; media.clear(); mediaTruncated = false;
        db.prepare("INSERT INTO state(id,value) VALUES('policy',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));
        if (currentPage && !currentPage.isClosed()) await credentialCapture.updatePage(currentPage);
        return summary();
      }) };
      changingControl = transfer;
      try { reply(response, 200, await transfer.completion); }
      finally { if (changingControl === transfer) changingControl = undefined; }
      return;
    }
    if (url.pathname === "/observe" && request.method === "GET") {
      if (activeWork) throw new HttpError(409, "Browser work in progress");
      activeWork = observe(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {});
      try { reply(response, 200, await activeWork); } finally { activeWork = undefined; }
      return;
    }
    if (url.pathname === "/profile/export" && request.method === "POST") {
      if (!context || status !== "LIVE") throw new HttpError(409, "Browser unavailable");
      if (activeOperation || exportingProfile) throw new HttpError(409, "Action in progress");
      const input = z.object({ origins: z.array(z.url()).min(1).max(50), includeLoginOrigins: z.boolean().default(false) }).parse(await body(request));
      const allowed = [...new Set(input.origins.map((origin) => new URL(publicUrl(origin)).origin))];
      if (input.includeLoginOrigins && !policy.privateMode) throw new HttpError(403, "Login scope requires private input");
      const selected = selectedPage();
      exportingProfile = true;
      try {
        if (input.includeLoginOrigins) {
          await flushLoginOrigins?.();
          for (const origin of loginOrigins) if (!allowed.includes(origin)) allowed.push(origin);
          if (allowed.length > 50) throw new ProfileExportError(413, "Too many login origins", "PROFILE_ORIGIN_LIMIT");
          for (const viewer of viewers) viewer.terminate();
          viewers.clear();
        }
        const candidate = input.includeLoginOrigins ? credentialCapture.export() : null;
        response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
        try { await exportProfile(selected, allowed, response, candidate); }
        catch (error) { if (!(error instanceof ProfileExportError)) throw error; }
        response.end();
      }
      finally { exportingProfile = false; }
      return;
    }
    if (url.pathname === "/login-context" && request.method === "POST") {
      if (!policy.privateMode || policy.owner !== "NONE" || activeOperation || exportingProfile || activeAutofills) throw new HttpError(409, "Protected idle browser required");
      const input = z.object({ startUrl: z.url() }).strict().parse(await body(request));
      const previous = browser?.contexts() ?? [];
      await closeMcp();
      context = await createContext();
      const page = await context.newPage(); currentPage = page;
      for (const prior of previous) await prior.close();
      loginOrigins.clear(); loginScopeRevision++; savedCredential = undefined;
      await page.goto(publicUrl(input.startUrl), { waitUntil: "domcontentloaded" });
      reply(response, 200, { ready: true }); return;
    }
    if (url.pathname === "/credentials/context" && request.method === "POST") {
      const input = z.object({ viewerId: z.string() }).strict().parse(await body(request));
      if (!policy.privateMode || policy.owner !== "USER" || input.viewerId !== policy.controllerId) throw new HttpError(403, "Private controller required");
      const current = new URL(selectedPage().url());
      reply(response, 200, { origin: current.protocol === "https:" ? current.origin : null, ...credentialCapture.metadata() }); return;
    }
    if (url.pathname === "/credentials/consent" && request.method === "POST") {
      const input = z.object({ viewerId: z.string(), enabled: z.boolean(), expectedCaptureRevision: z.number().int().nonnegative(),
        operationId: z.string().min(8).max(128), storedRevision: z.number().int().nonnegative() }).strict().parse(await body(request, 2048));
      if (!policy.privateMode || policy.owner !== "USER" || input.viewerId !== policy.controllerId) throw new HttpError(403, "Private controller required");
      reply(response, 200, await credentialCapture.consent(selectedPage(), input.enabled, input.expectedCaptureRevision, input.operationId, input.storedRevision)); return;
    }
    if (url.pathname === "/credentials/fill" && request.method === "POST") {
      const input = z.object({ viewerId: z.string(), origin: z.url(), username: z.string().min(1).max(500), password: z.string().min(1).max(8192) }).strict().parse(await body(request, 32_768));
      if (!policy.privateMode || policy.owner !== "USER" || input.viewerId !== policy.controllerId) throw new HttpError(403, "Private controller required");
      if (new URL(input.origin).protocol !== "https:") throw new HttpError(403, "HTTPS credential origin required");
      savedCredential = { origin: input.origin, username: input.username, password: input.password };
      reply(response, 200, { filled: await privateAutofill(selectedPage(), savedCredential) }); return;
    }
    if (url.pathname === "/credentials/clear" && request.method === "POST") {
      savedCredential = undefined; credentialCapture.clear();
      if (currentPage) await credentialCapture.updatePage(currentPage);
      reply(response, 200, { cleared: true }); return;
    }
    if (url.pathname === "/commands" && request.method === "POST") {
      const command = Command.parse(await body(request, 8_650_752));
      if (activeWork) {
        const previous = receipt(command.operationId);
        if (previous) { reply(response, 200, await execute(command)); return; }
        throw new HttpError(409, "Browser work in progress");
      }
      activeWork = execute(command);
      try { reply(response, 200, await activeWork); } finally { activeWork = undefined; }
      return;
    }
    const command = /^\/commands\/([^/]+)$/.exec(url.pathname);
    if (command?.[1] && request.method === "GET") { const result = receipt(z.uuid().parse(command[1])); if (!result) throw new HttpError(404, "Operation not found"); reply(response, 200, result); return; }
    const cancel = /^\/commands\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancel?.[1] && request.method === "POST") {
      const id = z.uuid().parse(cancel[1]);
      db.prepare("INSERT OR IGNORE INTO operations(id,fingerprint,status,result) VALUES(?,'','FAILED',?)")
        .run(id, JSON.stringify({ code: "CANCELLED_BEFORE_DISPATCH" }));
      if (activeOperation === id) activeAbort?.abort(new Error("Operation cancelled"));
      reply(response, 200, receipt(id));
      return;
    }
    const resolve = /^\/commands\/([^/]+)\/resolve$/.exec(url.pathname);
    if (resolve?.[1] && request.method === "POST") {
      const input = z.object({ outcome: z.enum(["SUCCEEDED", "FAILED", "UNCONFIRMED"]), evidence: z.string().min(1).max(4000) }).parse(await body(request));
      const previous = z.object({ status: z.string(), result: z.object({ reconciled: z.boolean().optional(), evidence: z.string().optional() }).optional() }).safeParse(receipt(z.uuid().parse(resolve[1])));
      if (previous.success && previous.data.status === input.outcome && previous.data.result?.reconciled && previous.data.result.evidence === input.evidence) { reply(response, 200, receipt(resolve[1])); return; }
      const changed = db.prepare("UPDATE operations SET status=?,result=? WHERE id=? AND status='UNKNOWN'").run(input.outcome, JSON.stringify({ result: { reconciled: true, evidence: input.evidence } }), z.uuid().parse(resolve[1]));
      if (changed.changes !== 1) throw new HttpError(409, "Operation is not awaiting verification");
      reply(response, 200, receipt(resolve[1])); return;
    }
    if (url.pathname.startsWith("/artifacts") && request.method === "GET") {
      if (url.searchParams.get("archive") !== "true") observationAllowed();
      if (await artifactResponse(db, dataDirectory, url, response)) return;
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    if (browserMcp?.requiresStop) await closeMcp();
    if (response.headersSent) { response.destroy(); return; }
    reply(response, error instanceof HttpError || error instanceof ProfileExportError ? error.status : error instanceof CaptureConflict ? 409 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof HttpError || error instanceof ProfileExportError ? error.message : "Browser operation unavailable", ...(error instanceof ProfileExportError ? { code: error.code } : {}) });
  }
});
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  try {
    if (!authorized(request) || status !== "LIVE" || exportingProfile) throw new HttpError(403, "View unavailable");
    const url = new URL(request.url ?? "/", "http://session");
    if (url.pathname !== "/view" || Number(url.searchParams.get("epoch")) !== policy.controlEpoch) throw new HttpError(409, "Stale viewer");
    const viewerId = url.searchParams.get("viewerId"); const controller = url.searchParams.get("role") === "CONTROLLER";
    if (viewers.size >= 2 || (policy.privateMode && viewerId !== policy.controllerId)) throw new HttpError(403, "View unavailable");
    if (controller && (policy.owner !== "USER" || viewerId !== policy.controllerId)) throw new HttpError(403, "Control unavailable");
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      viewers.add(client);
      // The viewer endpoint rejects input and clipboard exchange independently of the UI.
      const upstream = net.connect(controller ? 5901 : 5900, "127.0.0.1");
      const stream = createWebSocketStream(client);
      const clean = () => { viewers.delete(client); upstream.destroy(); stream.destroy(); };
      client.on("close", clean); client.on("error", clean); upstream.on("error", clean); upstream.on("close", clean);
      stream.on("error", clean);
      stream.pipe(upstream); upstream.pipe(stream);
    });
  } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
});
server.listen(8080, "0.0.0.0");
