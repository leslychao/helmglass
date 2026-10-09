import { createDecipheriv, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import { Credential, ConnectionStore } from "./connection-store.js";
import { Vault } from "./vault.js";

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
const directory = process.env["DATA_DIR"] ?? "/data";
const db = new DatabaseSync(path.join(directory, "node.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY,value TEXT NOT NULL)");
const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const profileTable = exists("profiles"), credentialTable = exists("credentials");
const vault = new Vault(required("VAULT_ADDR"), required("VAULT_ROLE_ID"), required("VAULT_SECRET_ID"));
const store = new ConnectionStore(db, vault, directory);
const key = Buffer.from(required("PROFILE_ENCRYPTION_KEY"), "base64");
if (key.length !== 32) throw new Error("Invalid migration key");
const decrypt = (value: unknown, aad: string): unknown => {
  if (!(value instanceof Uint8Array) || value.byteLength > 8_388_608 + 28) throw new Error("Invalid legacy secret");
  const data = Buffer.from(value);
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8"));
};
const legacyObject = z.record(z.string(), z.unknown());
function encode(value: unknown, identity = { next: 1 }): unknown {
  if (value === null) return { v: "null" };
  if (value === undefined) return { v: "undefined" };
  const id = identity.next++;
  if (Array.isArray(value)) return { a: value.map((item) => encode(item, identity)), id };
  if (typeof value === "object") return { o: Object.entries(value).map(([k, v]) => ({ k, v: encode(v, identity) })), id };
  return value;
}
function* convert(raw: unknown): Generator<Buffer> {
  const profile = z.object({ cookies: z.array(z.unknown()), origins: z.array(z.object({ origin: z.url(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })).default([]), indexedDB: z.array(legacyObject).default([]) })) }).parse(raw);
  const line = (value: object) => Buffer.from(JSON.stringify(value) + "\n");
  yield line({ type: "header", version: 2, origins: profile.origins.map((entry) => entry.origin) });
  for (const value of profile.cookies) yield line({ type: "cookie", value });
  for (const origin of profile.origins) {
    yield line({ type: "origin", origin: origin.origin });
    for (const entry of origin.localStorage) yield line({ type: "local", ...entry });
    for (const rawDatabase of origin.indexedDB) {
      const database = z.object({ name: z.string(), version: z.number(), stores: z.array(legacyObject) }).parse(rawDatabase);
      const stores = database.stores.map((value) => z.object({ name: z.string(), keyPath: z.string().optional(), keyPathArray: z.array(z.string()).optional(), autoIncrement: z.boolean(), indexes: z.array(legacyObject), records: z.array(legacyObject) }).parse(value));
      yield line({ type: "database", name: database.name, version: database.version, stores: stores.map((value) => ({ name: value.name, keyPath: value.keyPathArray ?? value.keyPath ?? null, autoIncrement: value.autoIncrement, indexes: value.indexes.map((index) => ({ name: index["name"], keyPath: index["keyPathArray"] ?? index["keyPath"], unique: index["unique"], multiEntry: index["multiEntry"] })) })) });
      for (const value of stores) for (const record of value.records) yield line({ type: "record", store: value.name, valueEncoded: record["valueEncoded"] ?? encode(record["value"]), ...(value.keyPath === undefined && value.keyPathArray === undefined ? { keyEncoded: record["keyEncoded"] ?? encode(record["key"]) } : {}) });
      yield line({ type: "database-end" });
    }
  }
  yield line({ type: "end" });
}

let count = 0;
try {
  for (;;) {
    const row = profileTable ? db.prepare("SELECT id,owner,encrypted FROM profiles ORDER BY id LIMIT 1").get() : undefined;
    if (!row) break;
    const id = z.string().parse(row["id"]), owner = z.string().parse(row["owner"]);
    const metadata = exists("profile_state") ? db.prepare("SELECT revision,saved_at FROM profile_state WHERE id=? AND owner=?").get(id, owner) : undefined;
    const oldCredential = credentialTable ? db.prepare("SELECT owner,encrypted,revision,operation_id FROM credentials WHERE id=?").get(id) : undefined;
    if (oldCredential && oldCredential["owner"] !== owner) throw new Error("Legacy credential owner mismatch");
    const credential = { revision: Number(oldCredential?.["revision"] ?? 0), operationId: z.string().parse(oldCredential?.["operation_id"] ?? ""), value: oldCredential?.["encrypted"] ? Credential.parse(decrypt(oldCredential["encrypted"], `credential:${owner}:${id}`)) : null };
    const operationId = "vault-migration-v2:" + id;
    const raw = decrypt(row["encrypted"], `${owner}:${id}`);
    const expected = createHash("sha256");
    for (const record of convert(raw)) expected.update(record);
    await store.save(id, owner, operationId, Readable.from(convert(raw)), { revision: Number(metadata?.["revision"] ?? 1), savedAt: z.string().parse(metadata?.["saved_at"] ?? new Date().toISOString()), credential });
    const migrated = await store.stream(id, owner); const actual = createHash("sha256");
    await Promise.all([pipeline(migrated.input, new Writable({ write(chunk: Buffer, _encoding, done) { actual.update(chunk); done(); } })), migrated.completion]);
    if (expected.digest("hex") !== actual.digest("hex") || JSON.stringify(await store.read(id, owner) ?? null) !== JSON.stringify(credential.value)) throw new Error("Migration verification failed");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM profiles WHERE id=? AND owner=?").run(id, owner);
      if (exists("profile_state")) db.prepare("DELETE FROM profile_state WHERE id=? AND owner=?").run(id, owner);
      if (credentialTable) db.prepare("DELETE FROM credentials WHERE id=? AND owner=?").run(id, owner);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    count++;
  }
  while (credentialTable) {
    const row = db.prepare("SELECT id,owner,encrypted,revision,operation_id FROM credentials ORDER BY id LIMIT 1").get();
    if (!row) break;
    const id = z.string().parse(row["id"]), owner = z.string().parse(row["owner"]);
    const value = row["encrypted"] ? Credential.parse(decrypt(row["encrypted"], `credential:${owner}:${id}`)) : null;
    const credential = { revision: Number(row["revision"]), operationId: z.string().parse(row["operation_id"]), value };
    const prior = await vault.read(id);
    if (!prior) await vault.write(id, 0, { owner, connectionId: id, credential });
    if (JSON.stringify(await store.read(id, owner) ?? null) !== JSON.stringify(value)) throw new Error("Credential migration verification failed");
    db.prepare("DELETE FROM credentials WHERE id=? AND owner=?").run(id, owner); count++;
  }
  for (const table of ["profiles", "profile_state", "credentials"]) if (exists(table)) db.exec(`DROP TABLE ${table}`);
  db.prepare("INSERT INTO settings(id,value) VALUES('vault-migration-v2','complete') ON CONFLICT(id) DO UPDATE SET value=excluded.value").run();
  console.log(`Vault migration verified: ${count} records`);
} finally { key.fill(0); db.close(); }
