import type { BrowserContext } from "playwright";
import { z } from "zod";
import { cookieMatchesHost } from "./profile-export.js";
import { profileRecords, ProfileExportError } from "./profile-format.js";
import { installProfileCodec } from "./profile-page.js";

const keyPath = z.union([z.string(), z.array(z.string()).max(100)]);
const databaseSchema = z.object({ type: z.literal("database"), name: z.string().max(4096), version: z.number().int().positive(), stores: z.array(z.object({ name: z.string().max(4096), keyPath: keyPath.nullable(), autoIncrement: z.boolean(), indexes: z.array(z.object({ name: z.string().max(4096), keyPath, unique: z.boolean(), multiEntry: z.boolean() })).max(100) })).max(100) });
const cookieSchema = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]), partitionKey: z.string().optional() });

export async function importProfile(context: BrowserContext, input: AsyncIterable<Uint8Array>, selectedOrigins?: string[]): Promise<void> {
  const page = await context.newPage();
  let origins: string[] | undefined;
  let origin = "";
  let database: string | undefined;
  let stores = new Set<string>();
  let ended = false;
  let cookieCount = 0;
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Restoring connection</title>" }));
    for await (const raw of profileRecords(input)) {
      if (ended) throw new ProfileExportError(422, "Data after profile end", "PROFILE_INVALID");
      const type = z.object({ type: z.string() }).parse(raw).type;
      if (!origins) {
        const header = z.object({ type: z.literal("header"), version: z.literal(2), origins: z.array(z.url()).min(1).max(50) }).parse(raw);
        origins = header.origins.map((value) => {
          const url = new URL(value);
          if (!["https:", "http:"].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new ProfileExportError(422, "Invalid profile origin", "PROFILE_INVALID");
          return value;
        });
        continue;
      }
      const enabled = !selectedOrigins || selectedOrigins.includes(origin);
      if (type === "cookie") {
        if (++cookieCount > 10_000 || origin) throw new ProfileExportError(422, "Invalid cookie section", "PROFILE_INVALID");
        const cookie = z.object({ value: cookieSchema }).parse(raw).value;
        if (origins.some((value) => (!selectedOrigins || selectedOrigins.includes(value)) && cookieMatchesHost(cookie.domain, new URL(value).hostname))) await context.addCookies([cookie]);
      } else if (type === "origin") {
        if (database) throw new ProfileExportError(422, "Unfinished database", "PROFILE_INVALID");
        origin = z.object({ origin: z.string() }).parse(raw).origin;
        if (!origins.includes(origin)) throw new ProfileExportError(422, "Unexpected profile origin", "PROFILE_INVALID");
        if (!selectedOrigins || selectedOrigins.includes(origin)) {
          await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.evaluate(installProfileCodec);
        }
      } else if (type === "local") {
        const value = z.object({ name: z.string(), value: z.string() }).parse(raw);
        if (!origin || database) throw new ProfileExportError(422, "Invalid local storage section", "PROFILE_INVALID");
        if (enabled) await page.evaluate(({ name, value }) => localStorage.setItem(name, value), value);
      } else if (type === "database") {
        if (!origin || database) throw new ProfileExportError(422, "Invalid database section", "PROFILE_INVALID");
        const value = databaseSchema.parse(raw);
        database = value.name; stores = new Set(value.stores.map((store) => store.name));
        if (enabled) await page.evaluate(async (value) => {
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open(value.name, value.version);
            request.onerror = () => reject(new Error("PROFILE_INVALID"));
            request.onupgradeneeded = () => {
              for (const item of value.stores) {
                const store = request.result.createObjectStore(item.name, { keyPath: item.keyPath, autoIncrement: item.autoIncrement });
                for (const index of item.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
              }
            };
            request.onsuccess = () => { window.__helmProfileDatabase = request.result; resolve(); };
          });
        }, value);
      } else if (type === "record") {
        const value = z.object({ store: z.string(), valueEncoded: z.unknown(), keyEncoded: z.unknown().optional() }).parse(raw);
        if (!database || !stores.has(value.store)) throw new ProfileExportError(422, "Invalid record store", "PROFILE_INVALID");
        if (enabled) await page.evaluate(async (value) => {
          await new Promise<void>((resolve, reject) => {
            const db = window.__helmProfileDatabase;
            if (!db) { reject(new Error("PROFILE_INVALID")); return; }
            const transaction = db.transaction(value.store, "readwrite");
            transaction.oncomplete = () => resolve();
            transaction.onerror = transaction.onabort = () => reject(new Error("PROFILE_INVALID"));
            try {
              const decode = window.__helmProfileCodec.decode;
              const store = transaction.objectStore(value.store);
              const key = decode(value.keyEncoded);
              if (key !== undefined && typeof key !== "string" && typeof key !== "number" && !(key instanceof Date) && !(key instanceof ArrayBuffer) && !ArrayBuffer.isView(key) && !Array.isArray(key)) throw new Error("PROFILE_INVALID");
              store.add(decode(value.valueEncoded), key as IDBValidKey | undefined);
            } catch { transaction.abort(); }
          });
        }, value);
      } else if (type === "database-end") {
        if (!database) throw new ProfileExportError(422, "Unexpected database end", "PROFILE_INVALID");
        if (enabled) await page.evaluate(() => { window.__helmProfileDatabase?.close(); delete window.__helmProfileDatabase; });
        database = undefined; stores.clear();
      } else if (type === "end") {
        if (database) throw new ProfileExportError(422, "Unfinished database", "PROFILE_INVALID");
        ended = true;
      } else throw new ProfileExportError(422, "Invalid profile record", "PROFILE_INVALID");
    }
    if (!origins || !ended) throw new ProfileExportError(422, "Incomplete profile", "PROFILE_INVALID");
  } finally { await page.close(); }
}
