import type { Page } from "playwright";

const profileLimit = 8_388_608;

export class ProfileExportError extends Error {}

export function cookieMatchesHost(domain: string, hostname: string): boolean {
  return domain.startsWith(".")
    ? hostname === domain.slice(1) || hostname.endsWith(domain)
    : hostname === domain;
}

/** Playwright's public storageState API has no size or origin bound. Keep the
 * compatible import format, but reject oversized values inside the renderer,
 * before they can cross the Playwright transport into Node. */
export async function exportProfile(selected: Page, origins: string[]): Promise<object> {
  const context = selected.context();
  const hosts = origins.map((origin) => new URL(origin).hostname);
  // Playwright's URL filter treats host-only cookies as domain cookies and also
  // excludes non-root paths. A saved origin needs its exact host scope at every path.
  const readCookies = async () => (await context.cookies()).filter((cookie) =>
    hosts.some((host) => cookieMatchesHost(cookie.domain, host)));
  const cookies = await readCookies();
  const cookieJson = JSON.stringify(cookies);
  let remaining = profileLimit - Buffer.byteLength(cookieJson) - 1024;
  if (remaining <= 0) throw new ProfileExportError("Saved profile exceeds 8 MiB");
  const snapshots: object[] = [];
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Saving connection</title>" }));
    for (const origin of origins) {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const result = await page.evaluate(async ({ limit }) => {
        let budget = limit;
        const charge = (bytes: number) => { budget -= bytes; if (budget < 0) throw new Error("Saved profile exceeds 8 MiB"); };
        const string = (value: string) => { charge(value.length * 6 + 32); return value; };
        const request = <T>(value: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
          value.onsuccess = () => resolve(value.result); value.onerror = () => reject(new Error("IndexedDB read failed"));
        });
        // This is Playwright's storageState valueEncoded wire format. Its serializer
        // is bundled privately, without a supported export or an incremental API.
        function encode(value: unknown, references = new Map<object, number>(), depth = 0): unknown {
          charge(128);
          if (depth > 32 || references.size > 50_000) throw new Error("Saved profile value is too complex");
          if (value === undefined) return { v: "undefined" };
          if (value === null) return { v: "null" };
          if (typeof value === "string") return string(value);
          if (typeof value === "boolean") return value;
          if (typeof value === "number") {
            if (Number.isNaN(value)) return { v: "NaN" };
            if (value === Infinity) return { v: "Infinity" };
            if (value === -Infinity) return { v: "-Infinity" };
            if (Object.is(value, -0)) return { v: "-0" };
            return value;
          }
          if (typeof value === "bigint") return { bi: string(value.toString()) };
          if (typeof value !== "object") throw new Error("Unsupported saved profile value");
          if (value instanceof Date) return { d: value.toJSON() };
          if (value instanceof RegExp) return { r: { p: string(value.source), f: value.flags } };
          const binary = (bytes: Uint8Array) => {
            charge(bytes.byteLength * 2 + 64);
            let text = ""; for (const byte of bytes) text += String.fromCharCode(byte);
            return btoa(text);
          };
          if (value instanceof ArrayBuffer) return { ab: { b: binary(new Uint8Array(value)) } };
          if (ArrayBuffer.isView(value)) {
            const types: Record<string, string> = { Int8Array: "i8", Uint8Array: "ui8", Uint8ClampedArray: "ui8c", Int16Array: "i16", Uint16Array: "ui16", Int32Array: "i32", Uint32Array: "ui32", Float32Array: "f32", Float64Array: "f64", BigInt64Array: "bi64", BigUint64Array: "bui64" };
            const kind = types[value.constructor.name];
            if (!kind) throw new Error("Unsupported saved profile binary value");
            return { ta: { k: kind, b: binary(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) } };
          }
          const previous = references.get(value); if (previous !== undefined) return { ref: previous };
          const id = references.size + 1; references.set(value, id);
          const child = (item: unknown) => encode(item, references, depth + 1);
          if (Array.isArray(value)) { const a: unknown[] = []; for (const item of value) a.push(child(item)); return { a, id }; }
          if (value instanceof Map) { const m: object[] = []; for (const [key, item] of value) m.push({ k: child(key), v: child(item) }); return { m, id }; }
          if (value instanceof Set) { const s: unknown[] = []; for (const item of value) s.push(child(item)); return { s, id }; }
          if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Unsupported saved profile value; the previous connection was retained");
          const o: object[] = [];
          for (const key in value) {
            if (Object.hasOwn(value, key)) o.push({ k: string(key), v: child(Reflect.get(value, key)) });
          }
          return { o, id };
        }
        try {
          const local: object[] = [];
          for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index); if (key === null) continue;
            local.push({ name: string(key), value: string(localStorage.getItem(key) ?? "") });
          }
          const databases = await indexedDB.databases();
          if (databases.length > 100) throw new Error("Too many IndexedDB databases to save");
          const saved: object[] = [];
          for (const metadata of databases) {
            if (!metadata.name || !metadata.version) throw new Error("IndexedDB changed during export");
            string(metadata.name);
            const database = await request(indexedDB.open(metadata.name));
            try {
              if (database.version !== metadata.version) throw new Error("IndexedDB changed during export");
              if (database.objectStoreNames.length > 100) throw new Error("Too many IndexedDB stores to save");
              const stores: object[] = [];
              if (database.objectStoreNames.length) {
                // One readonly transaction provides a stable snapshot across this DB's stores.
                const transaction = database.transaction(database.objectStoreNames, "readonly");
                const completed = new Promise<void>((resolve, reject) => {
                  transaction.oncomplete = () => resolve();
                  transaction.onabort = () => reject(new Error("IndexedDB export interrupted"));
                  transaction.onerror = () => reject(new Error("IndexedDB export failed"));
                });
                completed.catch(() => {});
                try {
                  for (const name of database.objectStoreNames) {
                    const store = transaction.objectStore(name); string(name);
                    const indexes: object[] = [];
                    for (const indexName of store.indexNames) {
                      const index = store.index(indexName); charge(256); string(indexName);
                      const keyPath = index.keyPath;
                      if (Array.isArray(keyPath)) keyPath.forEach(string); else string(keyPath);
                      indexes.push({ name: indexName, ...(Array.isArray(keyPath) ? { keyPathArray: keyPath } : { keyPath }), multiEntry: index.multiEntry, unique: index.unique });
                    }
                    const records: object[] = [];
                    await new Promise<void>((resolve, reject) => {
                      const cursor = store.openCursor();
                      cursor.onerror = () => reject(new Error("IndexedDB cursor failed"));
                      cursor.onsuccess = () => {
                        if (!cursor.result) { resolve(); return; }
                        try {
                          const row: Record<string, unknown> = { valueEncoded: encode(cursor.result.value) };
                          if (store.keyPath === null) row["keyEncoded"] = encode(cursor.result.key);
                          records.push(row); cursor.result.continue();
                        } catch (error) { reject(error); }
                      };
                    });
                    const keyPath = store.keyPath;
                    if (Array.isArray(keyPath)) keyPath.forEach(string); else if (keyPath !== null) string(keyPath);
                    stores.push({ name, records, indexes, autoIncrement: store.autoIncrement, ...(Array.isArray(keyPath) ? { keyPathArray: keyPath } : keyPath === null ? {} : { keyPath }) });
                  }
                  await completed;
                } catch (error) { try { transaction.abort(); } catch {} throw error; }
              }
              saved.push({ name: metadata.name, version: metadata.version, stores });
            } finally { database.close(); }
          }
          const data = JSON.stringify({ origin: location.origin, localStorage: local, indexedDB: saved });
          if (new TextEncoder().encode(data).byteLength > limit) throw new Error("Saved profile exceeds 8 MiB");
          return { data };
        } catch (error) {
          return { error: error instanceof Error ? error.message : "Saved profile export failed" };
        }
      }, { limit: remaining });
      if (result.error || result.data === undefined) throw new ProfileExportError(result.error ?? "Saved profile export failed");
      remaining -= Buffer.byteLength(result.data);
      snapshots.push(JSON.parse(result.data));
    }
    if (JSON.stringify(await readCookies()) !== cookieJson) throw new ProfileExportError("Cookies changed during export; retry saving the connection");
    return { cookies, origins: snapshots };
  } finally {
    await cdp.detach(); await page.close();
    if (!selected.isClosed()) await selected.bringToFront();
  }
}
