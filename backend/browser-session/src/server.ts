import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type BrowserContext, type Page, type Download } from "playwright";
import { fetch, ProxyAgent } from "undici";
import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import { cookieMatchesHost, exportProfile, ProfileExportError } from "./profile-export.js";

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
const sessionId = z.uuid().parse(required("SESSION_ID"));
const token = required("SESSION_TOKEN");
const proxyIp = z.ipv4().parse(required("PROXY_IP"));
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
const previouslyStarted = Boolean(db.prepare("SELECT value FROM state WHERE id='started'").get());
let status: "STARTING" | "LIVE" | "LOST" = previouslyStarted ? "LOST" : "STARTING";
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let currentPage: Page | undefined;
let initialization: Promise<void> | undefined;
let activeOperation: string | undefined;
let activeAbort: AbortController | undefined;
let navigationError: string | undefined;
const viewers = new Set<WebSocket>();
const pages = new Map<string, Page>();
const pageIds = new WeakMap<Page, string>();
const media = new Map<string, { id: string; pageId: string; sourceUrl: string; mimeType: string; headers: Record<string, string>; complete: boolean; observedAt: string }>();
let mediaTruncated = false;
const snapshotLimits = { text: 60_000, nodes: 20_000, elements: 200, tabs: 20, title: 1000, label: 2000, identifier: 256, attribute: 100, url: 8192, mimeType: 200, media: 100 };
const pendingDownloads = new Map<string, { completion: Promise<unknown>; abort: AbortController; download: Download }>();
let blobCapture: { nonce: string; page: Page; stream: PassThrough } | undefined;

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
function observationAllowed(): void { if (policy.privateMode) throw new HttpError(423, "Private input in progress"); }
function snapshotUrl(value: string): string | undefined { return value.length <= snapshotLimits.url ? value : undefined; }
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
  const stream = await download.createReadStream();
  return saveArtifact(stream, { name: download.suggestedFilename(), mimeType: "application/octet-stream", sourceUrl: download.url(), complete: true, pageId, operationId }, signal);
}
function registerPage(page: Page): void {
  const id = randomUUID(); pages.set(id, page); pageIds.set(page, id); currentPage = page;
  page.on("close", () => { pages.delete(id); if (currentPage === page) currentPage = [...pages.values()].at(-1); });
  page.on("download", (download) => {
    if (policy.privateMode) { void download.cancel(); return; }
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
      while (media.size >= snapshotLimits.media) { const first = media.keys().next().value; if (first) media.delete(first); mediaTruncated = true; }
      const existing = [...media.values()].find((item) => item.sourceUrl === response.url() && item.pageId === id);
      const mediaId = existing?.id ?? randomUUID();
      media.set(mediaId, { id: mediaId, pageId: id, sourceUrl: response.url(), mimeType: mime || "application/octet-stream", headers, complete: response.status() === 200, observedAt: new Date().toISOString() });
    }).catch(() => {});
  });
}
async function createContext(profile?: unknown): Promise<BrowserContext> {
  if (!browser) throw new HttpError(409, "Browser unavailable");
  let storageState: string | undefined;
  try {
    if (profile !== undefined) {
      const saved = z.object({ cookies: z.array(z.object({ domain: z.string() }).passthrough()).max(10_000), origins: z.array(z.object({ origin: z.url() }).passthrough()).max(1000) }).parse(profile);
      const hosts = saved.origins.map((origin) => new URL(origin.origin).hostname);
      const scoped = { ...saved, cookies: saved.cookies.filter((cookie) =>
        hosts.some((host) => cookieMatchesHost(cookie.domain, host))) };
      storageState = `/home/node/imported-storage-${randomUUID()}.json`;
      await writeFile(storageState, JSON.stringify(scoped), { mode: 0o600 });
    }
    const created = await browser.newContext({ viewport: null, acceptDownloads: true, storageState, locale: "ru-RU", serviceWorkers: "allow" });
    await created.exposeBinding("__helmVisiblePage", async (source) => {
      if (source.page.isClosed()) return;
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
      if (!transfer || source.page !== transfer.page || input.nonce !== transfer.nonce || transfer.stream.destroyed || policy.privateMode) throw new Error("Audio transfer unavailable");
      if (!transfer.stream.write(Buffer.from(input.data, "base64"))) await once(transfer.stream, "drain");
    });
    created.setDefaultTimeout(20_000); created.setDefaultNavigationTimeout(40_000);
    created.on("page", registerPage);
    return created;
  } finally { if (storageState) await rm(storageState, { force: true }); }
}
async function initialize(input: { startUrl: string; profile?: unknown }): Promise<void> {
  if (previouslyStarted || status === "LOST") return;
  db.prepare("INSERT OR REPLACE INTO state(id,value) VALUES('started','true')").run();
  try {
    browser = await chromium.launch({
      headless: false, chromiumSandbox: true,
      proxy: { server: proxy, bypass: "<-loopback>" },
      args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-features=WebRtcAllowInputVolumeAdjustment", "--no-first-run", "--start-maximized"],
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/home/node", DISPLAY: ":99", LANG: "ru_RU.UTF-8" },
    });
    browser.on("disconnected", () => { status = "LOST"; for (const viewer of viewers) viewer.close(1011, "Browser lost"); });
    context = await createContext(input.profile);
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

const Command = z.object({ operationId: z.uuid(), type: z.enum(["navigate", "click", "fill", "press", "selectOption", "check", "scroll", "goBack", "reload", "newTab", "selectTab", "closeTab", "observe", "screenshot", "listMedia", "captureAudio", "waitFor", "applyConnection"]), arguments: z.record(z.string(), z.unknown()).default({}), instructionRevision: z.number().int().nonnegative(), controlEpoch: z.number().int().nonnegative() }).strict();
type Command = z.infer<typeof Command>;
const readCommands = new Set(["observe", "screenshot", "listMedia", "captureAudio", "waitFor"]);
async function observe(): Promise<object> {
  observationAllowed(); const page = selectedPage();
  const snapshot = await page.evaluate((limits) => {
    let text = ""; let inspected = 0; let truncated = false;
    const clipped = (value: string | null, maximum: number) => {
      if (value === null) return null;
      if (value.length > maximum) { truncated = true; return value.slice(0, maximum); }
      return value;
    };
    const exact = (value: string | null, maximum: number) => {
      if (value === null) return null;
      if (value.length > maximum) { truncated = true; return undefined; }
      return value;
    };
    const elements: object[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      inspected += 1;
      if (inspected > limits.nodes || text.length >= limits.text) { truncated = true; break; }
      const node = walker.currentNode;
      if (node.nodeType === Node.TEXT_NODE && !node.parentElement?.closest("script,style,noscript,textarea,input,[hidden],[aria-hidden=true]")) {
        text += clipped(node.textContent ?? "", limits.text - text.length) ?? "";
        if (text.length < limits.text) text += " ";
      }
      if (node instanceof Element && node.matches("a,button,input,textarea,select,[role=button]")) {
        if (elements.length >= limits.elements) { truncated = true; continue; }
        elements.push({ index: elements.length, tag: node.tagName.toLowerCase(), role: exact(node.getAttribute("role"), limits.attribute), id: exact(node.id, limits.identifier) || undefined,
          text: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? "" : clipped(node.textContent ?? "", 300),
          label: clipped(node.getAttribute("aria-label") ?? node.getAttribute("placeholder"), limits.label), type: exact(node.getAttribute("type"), limits.attribute), name: exact(node.getAttribute("name"), limits.identifier),
          ...(node instanceof HTMLAnchorElement ? { href: exact(node.href, limits.url) } : {}) });
      }
    }
    const title = clipped(document.title, limits.title);
    return { title, text, truncated, elements };
  }, snapshotLimits);
  const url = snapshotUrl(page.url());
  const tabs: { id: string; url?: string; active: boolean }[] = [];
  let truncated = snapshot.truncated || url === undefined;
  for (const [id, item] of pages) {
    if (tabs.length >= snapshotLimits.tabs) { truncated = true; break; }
    const tabUrl = snapshotUrl(item.url()); if (tabUrl === undefined) truncated = true;
    tabs.push({ id, url: tabUrl, active: item === page });
  }
  observationAllowed();
  return { url, ...snapshot, truncated, tabs };
}
async function listMedia(): Promise<object> {
  observationAllowed();
  const page = selectedPage(); const pageId = pageIds.get(page);
  if (!pageId) throw new HttpError(409, "Page unavailable");
  const snapshot = await page.evaluate((limits) => {
    const found: { url: string; mimeType: string; label: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
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
      if (element instanceof HTMLMediaElement && element.currentSrc) add(element.currentSrc, "audio/unknown", element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "");
      if (element instanceof HTMLSourceElement && element.src) add(element.src, element.type || "audio/unknown", element.parentElement?.getAttribute("aria-label") ?? "");
    }
    return { sources: found, truncated };
  }, snapshotLimits);
  observationAllowed();
  for (const source of snapshot.sources) {
    if (!["http:", "https:", "blob:"].includes(new URL(source.url).protocol)) continue;
    if ([...media.values()].some((item) => item.sourceUrl === source.url && item.pageId === pageId)) continue;
    while (media.size >= snapshotLimits.media) { const first = media.keys().next().value; if (first) media.delete(first); mediaTruncated = true; }
    const id = randomUUID();
    media.set(id, { id, pageId, sourceUrl: source.url, mimeType: source.mimeType, headers: {}, complete: false, observedAt: new Date().toISOString() });
  }
  return { media: [...media.values()].map(({ headers: _headers, ...item }) => item), sources: snapshot.sources, truncated: snapshot.truncated || mediaTruncated };
}
async function captureBlob(source: { sourceUrl: string; pageId: string; mimeType: string }, sourceRef: string, name: string, signal: AbortSignal): Promise<object> {
  signal.throwIfAborted();
  const page = pages.get(source.pageId);
  if (!page || page.isClosed()) throw new HttpError(409, "Source page is no longer available");
  const stream = new PassThrough({ highWaterMark: 65_536 }); const nonce = randomUUID();
  blobCapture = { nonce, page, stream };
  const metadata = { name, mimeType: "application/octet-stream", sourceUrl: source.sourceUrl, sourceRef, complete: true, pageId: source.pageId, operationId: activeOperation };
  const saved = saveArtifact(stream, metadata, signal);
  saved.catch(() => {});
  const abort = () => stream.destroy(new Error("Audio transfer cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    const transfer = page.evaluate(async ({ url, transferId }) => {
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
  const input = z.object({ connectionId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), origins: z.array(z.url()).min(1).max(50), url: z.url(), profile: z.object({ cookies: z.array(z.object({ domain: z.string() }).passthrough()).max(10_000), origins: z.array(z.object({ origin: z.string() }).passthrough()).max(1000) }) }).parse(args);
  const target = new URL(publicUrl(input.url));
  const origins = input.origins.map((value) => new URL(publicUrl(value)).origin);
  if (!origins.includes(target.origin)) throw new BeforeEffectRejection(403, "Account switch destination was not confirmed");
  if (!browser) throw new HttpError(409, "Browser unavailable");
  const hosts = origins.map((origin) => new URL(origin).hostname);
  const matchesCookie = (domain: string) => hosts.some((host) => cookieMatchesHost(domain, host));
  const profile = { cookies: input.profile.cookies.filter((cookie) => matchesCookie(cookie.domain)), origins: input.profile.origins.filter((origin) => origins.includes(origin.origin)) };
  const previousContexts = browser.contexts();
  // A fresh context isolates the selected account while retaining the same Chromium process.
  // setStorageState on a live context would erase unrelated origins and their OPFS.
  const replacement = await createContext(profile);
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
  context = replacement; currentPage = replacementPage; media.clear(); mediaTruncated = false;
  await replacementPage.goto(target.href, { waitUntil: "domcontentloaded", signal });
  await replacementPage.bringToFront();
  return { connectionId: input.connectionId, url: replacementPage.url(), switched: true };
}
async function perform(command: Command, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const page = selectedPage(); const args = command.arguments;
  switch (command.type) {
    case "applyConnection": return applyConnection(args, signal);
    case "observe": return observe();
    case "listMedia": return listMedia();
    case "captureAudio": return captureAudio(args, signal);
    case "screenshot": {
      observationAllowed(); const bytes = await page.screenshot({ type: "png", fullPage: false }); observationAllowed();
      const artifact = await saveArtifact(Readable.from(bytes), { name: "screenshot.png", mimeType: "image/png", sourceUrl: page.url(), complete: true, operationId: activeOperation }, signal); return { artifact };
    }
    case "navigate": await page.goto(publicUrl(z.string().max(8192).parse(args["url"])), { waitUntil: "domcontentloaded", signal }); break;
    case "click": await page.locator(z.string().max(2000).parse(args["selector"])).click({ signal }); break;
    case "fill": {
      const input = z.object({ selector: z.string().max(2000), text: z.string().max(50_000) }).parse(args);
      const locator = page.locator(input.selector);
      const sensitive = await locator.evaluate((element) => element instanceof HTMLInputElement && (element.type === "password" || /password|one-time-code/i.test(element.autocomplete)), undefined, { signal });
      if (sensitive) throw new HttpError(403, "Private input requires the user");
      await locator.fill(input.text, { signal }); break;
    }
    case "press": {
      const input = z.object({ selector: z.string().max(2000).optional(), key: z.string().max(100) }).parse(args);
      const sensitive = input.selector
        ? await page.locator(input.selector).evaluate((element) => element instanceof HTMLInputElement && (element.type === "password" || /password|one-time-code/i.test(element.autocomplete)), undefined, { signal })
        : await page.evaluate(() => document.activeElement instanceof HTMLInputElement && (document.activeElement.type === "password" || /password|one-time-code/i.test(document.activeElement.autocomplete)));
      if (sensitive) throw new HttpError(403, "Private input requires the user");
      if (input.selector) await page.locator(input.selector).press(input.key, { signal }); else { signal.throwIfAborted(); await page.keyboard.press(input.key); } break;
    }
    case "selectOption": { const input = z.object({ selector: z.string().max(2000), values: z.array(z.string().max(1000)).max(100) }).parse(args); await page.locator(input.selector).selectOption(input.values, { signal }); break; }
    case "check": { const input = z.object({ selector: z.string().max(2000), checked: z.boolean() }).parse(args); await page.locator(input.selector).setChecked(input.checked, { signal }); break; }
    case "scroll": { const input = z.object({ x: z.number().min(-10_000).max(10_000).default(0), y: z.number().min(-10_000).max(10_000) }).parse(args); await page.mouse.wheel(input.x, input.y); break; }
    case "goBack": await page.goBack({ waitUntil: "domcontentloaded", signal }); break;
    case "reload": await page.reload({ waitUntil: "domcontentloaded", signal }); break;
    case "newTab": { if (pages.size >= 20) throw new HttpError(409, "Browser tab limit reached"); const tab = await page.context().newPage(); if (args["url"]) await tab.goto(publicUrl(z.string().parse(args["url"])), { waitUntil: "domcontentloaded", signal }); break; }
    case "selectTab": { const tab = pages.get(z.uuid().parse(args["tabId"])); if (!tab) throw new HttpError(404, "Tab not found"); currentPage = tab; await tab.bringToFront(); break; }
    case "closeTab": if (pages.size <= 1) throw new HttpError(409, "Cannot close the only task page"); await page.close(); break;
    case "waitFor": { const input = z.object({ selector: z.string().max(2000), state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible") }).parse(args); await page.locator(input.selector).waitFor({ state: input.state, timeout: 20_000, signal }); break; }
  }
  await Promise.all([...pendingDownloads.values()].map((download) => download.completion));
  const rows = db.prepare("SELECT document FROM artifacts WHERE json_extract(document,'$.operationId')=? ORDER BY rowid LIMIT 100").all(command.operationId);
  const artifacts = rows.map((row) => JSON.parse(z.string().parse(row["document"])));
  return { url: selectedPage().url(), ...(artifacts.length ? { artifacts } : {}) };
}
function receipt(id: string): object | undefined {
  const row = db.prepare("SELECT status,result FROM operations WHERE id=?").get(id);
  if (!row) return undefined;
  return { operationId: id, status: row["status"], ...(typeof row["result"] === "string" ? JSON.parse(row["result"]) : {}) };
}
async function execute(command: Command): Promise<object> {
  const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const previous = db.prepare("SELECT fingerprint FROM operations WHERE id=?").get(command.operationId);
  if (previous) {
    if (previous["fingerprint"] !== fingerprint) throw new HttpError(409, "Operation identity conflict");
    return receipt(command.operationId) ?? { operationId: command.operationId, status: "UNKNOWN" };
  }
  observationAllowed();
  if ((command.type !== "applyConnection" && policy.owner !== "CHATGPT") || command.controlEpoch !== policy.controlEpoch) throw new HttpError(409, "Control not granted for this epoch");
  if (activeOperation) throw new HttpError(409, "Another command is running");
  const unresolved = db.prepare("SELECT id FROM operations WHERE status='UNKNOWN' LIMIT 1").get();
  if (unresolved && !readCommands.has(command.type)) throw new HttpError(409, "Unknown result requires reconciliation");
  selectedPage(); activeOperation = command.operationId; const abort = new AbortController(); activeAbort = abort;
  // Durable before external dispatch: restart or a lost response never replays a mutation.
  db.prepare("INSERT INTO operations(id,fingerprint,status) VALUES(?,?,'RUNNING')").run(command.operationId, fingerprint);
  try {
    const result = await perform(command, abort.signal);
    if (command.controlEpoch !== policy.controlEpoch) throw new HttpError(409, "Control changed while the action was in progress; verify its result");
    db.prepare("UPDATE operations SET status='SUCCEEDED',result=? WHERE id=?").run(JSON.stringify({ result }), command.operationId);
  } catch (error) {
    const outcome = readCommands.has(command.type) || error instanceof z.ZodError || error instanceof BeforeEffectRejection ? "FAILED" : "UNKNOWN";
    db.prepare("UPDATE operations SET status=?,result=? WHERE id=?").run(outcome, JSON.stringify({ error: error instanceof HttpError ? error.message : outcome === "UNKNOWN" ? "The action may have reached the site; verify its result before continuing" : "Browser read failed" }), command.operationId);
  } finally { activeOperation = undefined; activeAbort = undefined; }
  return receipt(command.operationId) ?? { operationId: command.operationId, status: "UNKNOWN" };
}

const server = http.createServer(async (request, response) => {
  try {
    if (!authorized(request)) throw new HttpError(401, "Unauthorized");
    const url = new URL(request.url ?? "/", "http://session");
    if (url.pathname === "/health") { reply(response, 200, summary()); return; }
    if (url.pathname === "/initialize" && request.method === "POST") {
      const input = z.object({ startUrl: z.string().max(8192), profile: z.unknown().optional() }).parse(await body(request));
      if (!initialization && status === "STARTING") initialization = initialize(input);
      await initialization; reply(response, 200, summary()); return;
    }
    if (url.pathname === "/control" && request.method === "POST") {
      const input = Policy.parse(await body(request));
      if (input.controlEpoch < policy.controlEpoch || (input.controlEpoch === policy.controlEpoch && JSON.stringify(input) !== JSON.stringify(policy))) throw new HttpError(409, "Stale control epoch");
      if (JSON.stringify(input) === JSON.stringify(policy)) { reply(response, 200, summary()); return; }
      if (input.owner === "USER" && !input.controllerId) throw new HttpError(400, "Controller identity required");
      if (activeOperation && input.owner !== "NONE") throw new HttpError(409, "Wait for the dispatched action to finish");
      activeAbort?.abort();
      if (input.privateMode) {
        for (const transfer of pendingDownloads.values()) {
          transfer.abort.abort();
          void transfer.download.cancel().catch(() => {});
        }
      }
      for (const viewer of viewers) viewer.terminate(); viewers.clear();
      policy = input; media.clear(); mediaTruncated = false;
      db.prepare("INSERT INTO state(id,value) VALUES('policy',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));
      reply(response, 200, summary()); return;
    }
    if (url.pathname === "/observe" && request.method === "GET") { reply(response, 200, await observe()); return; }
    if (url.pathname === "/profile/export" && request.method === "POST") {
      if (!context || status !== "LIVE") throw new HttpError(409, "Browser unavailable");
      if (activeOperation) throw new HttpError(409, "Action in progress");
      const input = z.object({ origins: z.array(z.url()).min(1).max(50) }).parse(await body(request));
      const allowed = [...new Set(input.origins.map((origin) => new URL(publicUrl(origin)).origin))];
      const profile = await exportProfile(selectedPage(), allowed);
      reply(response, 200, profile); return;
    }
    if (url.pathname === "/commands" && request.method === "POST") { reply(response, 200, await execute(Command.parse(await body(request, 8_650_752)))); return; }
    const command = /^\/commands\/([^/]+)$/.exec(url.pathname);
    if (command?.[1] && request.method === "GET") { const result = receipt(z.uuid().parse(command[1])); if (!result) throw new HttpError(404, "Operation not found"); reply(response, 200, result); return; }
    const resolve = /^\/commands\/([^/]+)\/resolve$/.exec(url.pathname);
    if (resolve?.[1] && request.method === "POST") {
      const input = z.object({ outcome: z.enum(["SUCCEEDED", "FAILED"]), evidence: z.string().min(1).max(4000) }).parse(await body(request));
      const previous = z.object({ status: z.string(), result: z.object({ reconciled: z.boolean().optional(), evidence: z.string().optional() }).optional() }).safeParse(receipt(z.uuid().parse(resolve[1])));
      if (previous.success && previous.data.status === input.outcome && previous.data.result?.reconciled && previous.data.result.evidence === input.evidence) { reply(response, 200, receipt(resolve[1])); return; }
      const changed = db.prepare("UPDATE operations SET status=?,result=? WHERE id=? AND status='UNKNOWN'").run(input.outcome, JSON.stringify({ result: { reconciled: true, evidence: input.evidence } }), z.uuid().parse(resolve[1]));
      if (changed.changes !== 1) throw new HttpError(409, "Operation is not awaiting verification");
      reply(response, 200, receipt(resolve[1])); return;
    }
    const artifact = /^\/artifacts\/([^/]+)$/.exec(url.pathname);
    if (url.pathname === "/artifacts" && request.method === "GET") {
      // Only the authenticated backend storage receiver may archive immutable records
      // during private input. saveArtifact never commits a private-mode record.
      if (url.searchParams.get("archive") !== "true") observationAllowed();
      const after = z.coerce.number().int().nonnegative().safe().parse(url.searchParams.get("after") ?? "0");
      const rows = db.prepare("SELECT rowid,document FROM artifacts WHERE rowid>? ORDER BY rowid LIMIT 101").all(after);
      const page = rows.slice(0, 100);
      reply(response, 200, { artifacts: page.map((row) => JSON.parse(z.string().parse(row["document"]))), nextCursor: page.at(-1)?.["rowid"] ?? after, hasMore: rows.length > 100 }); return;
    }
    if (artifact?.[1] && request.method === "GET") {
      if (url.searchParams.get("archive") !== "true") observationAllowed();
      const id = z.uuid().parse(artifact[1]); const row = db.prepare("SELECT document FROM artifacts WHERE id=?").get(id);
      if (!row) throw new HttpError(404, "Artifact not found");
      const metadata = z.object({ mimeType: z.string(), sizeBytes: z.number() }).parse(JSON.parse(z.string().parse(row["document"])));
      response.writeHead(200, { "Content-Type": metadata.mimeType, "Content-Length": metadata.sizeBytes, "Cache-Control": "no-store" });
      await pipeline(createReadStream(path.join(dataDirectory, "artifacts", id)), response); return;
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    reply(response, error instanceof HttpError ? error.status : error instanceof ProfileExportError ? 413 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof HttpError || error instanceof ProfileExportError ? error.message : "Browser operation unavailable" });
  }
});
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  try {
    if (!authorized(request) || status !== "LIVE") throw new HttpError(403, "View unavailable");
    const url = new URL(request.url ?? "/", "http://session");
    if (url.pathname !== "/view" || Number(url.searchParams.get("epoch")) !== policy.controlEpoch) throw new HttpError(409, "Stale viewer");
    const viewerId = url.searchParams.get("viewerId"); const controller = url.searchParams.get("role") === "CONTROLLER";
    if (viewers.size >= 2 || (policy.privateMode && viewerId !== policy.controllerId)) throw new HttpError(403, "View unavailable");
    if (controller && (policy.owner !== "USER" || viewerId !== policy.controllerId)) throw new HttpError(403, "Control unavailable");
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      viewers.add(client);
      // x11vnc's viewonly endpoint rejects input on the server, independently of the UI.
      const upstream = net.connect(controller ? 5901 : 5900, "127.0.0.1");
      const stream = createWebSocketStream(client);
      stream.pipe(upstream); upstream.pipe(stream);
      const clean = () => { viewers.delete(client); upstream.destroy(); stream.destroy(); };
      client.on("close", clean); client.on("error", clean); upstream.on("error", clean); upstream.on("close", clean);
    });
  } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
});
server.listen(8080, "0.0.0.0");
