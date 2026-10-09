import type { Page } from "playwright";
import type { Writable } from "node:stream";
import { installProfileCodec } from "./profile-page.js";
import { ProfileExportError, profileLimits, writeProfileChunk } from "./profile-format.js";
export { ProfileExportError } from "./profile-format.js";

export function cookieMatchesHost(domain: string, hostname: string): boolean {
  return domain.startsWith(".") ? hostname === domain.slice(1) || hostname.endsWith(domain) : hostname === domain;
}

export async function exportProfile(selected: Page, origins: string[], output: Writable, candidate: unknown = null): Promise<void> {
  const context = selected.context();
  const hosts = origins.map((origin) => new URL(origin).hostname);
  const readCookies = async () => (await context.cookies()).filter((cookie) => hosts.some((host) => cookieMatchesHost(cookie.domain, host)));
  const cookies = await readCookies();
  if (cookies.length > 10_000) throw new ProfileExportError(413, "Too many cookies", "PROFILE_COMPLEXITY_LIMIT");
  const cookieJson = JSON.stringify(cookies);
  let total = 0;
  const write = async (text: string) => {
    const bytes = Buffer.from(text); total += bytes.length;
    if (total > profileLimits.total) throw new ProfileExportError(413, "Profile exceeds 256 MiB", "PROFILE_TOO_LARGE");
    await writeProfileChunk(output, bytes);
  };
  await write(JSON.stringify({ type: "header", version: 2, origins, candidate }) + "\n");
  for (const value of cookies) await write(JSON.stringify({ type: "cookie", value }) + "\n");
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Saving connection</title>" }));
    await page.exposeBinding("__helmProfileWrite", async (source, value: unknown) => {
      if (source.page !== page || source.frame !== page.mainFrame() || typeof value !== "string" || Buffer.byteLength(value) > profileLimits.chunk) throw new ProfileExportError(422, "Invalid profile chunk", "PROFILE_INVALID");
      await write(value);
    });
    for (const origin of origins) {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.evaluate(installProfileCodec);
      const result = await page.evaluate(async ({ recordLimit, chunkLimit }) => {
        const encode = window.__helmProfileCodec.encode;
        const emit = async (value: object) => {
          const text = JSON.stringify(value) + "\n";
          if (new TextEncoder().encode(text).length > recordLimit) throw new Error("PROFILE_RECORD_TOO_LARGE");
          const width = chunkLimit / 4;
          for (let offset = 0; offset < text.length;) {
            let end = Math.min(text.length, offset + width);
            const last = text.charCodeAt(end - 1);
            if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
            await window.__helmProfileWrite(text.slice(offset, end)); offset = end;
          }
        };
        const request = <T>(operation: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
          operation.onsuccess = () => resolve(operation.result);
          operation.onerror = () => reject(new Error("PROFILE_SNAPSHOT_CHANGED"));
        });
        try {
          await emit({ type: "origin", origin: location.origin });
          for (let index = 0; index < localStorage.length; index++) {
            const name = localStorage.key(index);
            if (name !== null) await emit({ type: "local", name, value: localStorage.getItem(name) ?? "" });
          }
          const databases = await indexedDB.databases();
          if (databases.length > 100) throw new Error("PROFILE_COMPLEXITY_LIMIT");
          for (const metadata of databases) {
            if (!metadata.name || !metadata.version) throw new Error("PROFILE_SNAPSHOT_CHANGED");
            const database = await request(indexedDB.open(metadata.name));
            try {
              if (database.version !== metadata.version) throw new Error("PROFILE_SNAPSHOT_CHANGED");
              if (database.objectStoreNames.length > 100) throw new Error("PROFILE_COMPLEXITY_LIMIT");
              if (!database.objectStoreNames.length) {
                await emit({ type: "database", name: metadata.name, version: metadata.version, stores: [] });
              } else {
                const transaction = database.transaction(database.objectStoreNames, "readonly");
                // Pending requests preserve one readonly snapshot during transport backpressure.
                // Only the current record is retained; nothing is queued behind the transport.
                let holding = true;
                let scheduled: (() => void) | undefined;
                const schedule = (work: () => void) => {
                  if (scheduled || !holding) throw new Error("PROFILE_SNAPSHOT_CHANGED");
                  scheduled = work;
                };
                const keepAlive = () => {
                  if (!holding) return;
                  const tick = transaction.objectStore(database.objectStoreNames[0]!).count("__helm_snapshot_keepalive__");
                  tick.onsuccess = () => {
                    const work = scheduled; scheduled = undefined;
                    work?.(); keepAlive();
                  };
                };
                keepAlive();
                const completed = new Promise<void>((resolve, reject) => {
                  transaction.oncomplete = () => resolve();
                  transaction.onabort = transaction.onerror = () => reject(new Error("PROFILE_SNAPSHOT_CHANGED"));
                });
                void completed.catch(() => {});
                try {
                  const stores = [...database.objectStoreNames].map((name) => {
                    const store = transaction.objectStore(name);
                    const indexes = [...store.indexNames].map((indexName) => {
                      const index = store.index(indexName);
                      return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                    });
                    return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
                  });
                  await emit({ type: "database", name: metadata.name, version: metadata.version, stores });
                  for (const name of database.objectStoreNames) {
                    const store = transaction.objectStore(name);
                    await new Promise<void>((resolve, reject) => {
                      // Cursor requests must run in an active IDB callback, including after I/O.
                      schedule(() => {
                      const cursor = store.openCursor();
                      cursor.onerror = () => reject(new Error("PROFILE_SNAPSHOT_CHANGED"));
                      cursor.onsuccess = () => {
                        const row = cursor.result;
                        if (!row) { resolve(); return; }
                        try {
                          const value = { type: "record", store: name, valueEncoded: encode(row.value), ...(store.keyPath === null ? { keyEncoded: encode(row.key) } : {}) };
                          void emit(value).then(() => schedule(() => {
                            try { row.continue(); } catch (error) { reject(error); }
                          }), reject).catch(reject);
                        } catch (error) { reject(error); }
                      };
                      });
                    });
                  }
                  holding = false; await completed;
                } catch (error) { holding = false; try { transaction.abort(); } catch {} throw error; }
              }
              await emit({ type: "database-end" });
            } finally { database.close(); }
          }
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : "PROFILE_SAVE_FAILED";
          return { ok: false, code: /PROFILE_[A-Z_]+/.exec(message)?.[0] ?? "PROFILE_SAVE_FAILED" };
        }
      }, { recordLimit: profileLimits.record, chunkLimit: profileLimits.chunk });
      if (!result.ok) {
        const status = result.code?.endsWith("TOO_LARGE") || result.code === "PROFILE_COMPLEXITY_LIMIT" ? 413
          : result.code === "PROFILE_UNSUPPORTED_VALUE" || result.code === "PROFILE_INVALID" ? 422 : 409;
        throw new ProfileExportError(status, "Profile export failed", result.code);
      }
    }
    if (JSON.stringify(await readCookies()) !== cookieJson) throw new ProfileExportError(409, "Cookies changed during export", "PROFILE_SNAPSHOT_CHANGED");
    await write('{"type":"end"}\n');
  } catch (error) {
    if (error instanceof ProfileExportError && !output.destroyed) await writeProfileChunk(output, Buffer.from(JSON.stringify({ type: "error", code: error.code }) + "\n"));
    throw error;
  } finally {
    await cdp.detach(); await page.close();
    if (!selected.isClosed()) await selected.bringToFront();
  }
}
