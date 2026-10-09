import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import { createGzip, createGunzip } from "node:zlib";
import { z } from "zod";
import { StorageError, Vault } from "./vault.js";

export const Credential = z.object({ origin: z.url(), username: z.string().min(1).max(500), password: z.string().min(1).max(8192) }).strict();
export type Credential = z.infer<typeof Credential>;
export class CredentialConflict extends Error {}
const Profile = z.object({ file: z.uuid(), revision: z.number().int().positive(), savedAt: z.string(), origins: z.array(z.url()).max(50), nonce: z.string(), tag: z.string(), wrappedKey: z.string(), digest: z.string(), operationId: z.string() });
const Secret = z.object({ owner: z.string(), connectionId: z.string(), profile: Profile.optional(), credential: z.object({ revision: z.number().int().nonnegative(), operationId: z.string(), value: Credential.nullable() }) });
type Secret = z.infer<typeof Secret>;
const Pending = z.object({ id: z.string(), owner: z.string(), operationId: z.string(), expectedVersion: z.number().int().nonnegative(), wrappedKey: z.string(), nonce: z.string(), tag: z.string(), encrypted: z.string(), file: z.uuid(), previousFile: z.uuid().optional() });
const Header = z.object({ type: z.literal("header"), version: z.literal(2), origins: z.array(z.url()).min(1).max(50), candidate: z.object({ operationId: z.string(), expectedRevision: z.number().int().nonnegative(), credential: Credential }).nullable().optional() });

export class ConnectionStore {
  private readonly directory: string;
  private readonly active = new Map<string, Promise<unknown>>();
  constructor(private readonly db: DatabaseSync, private readonly vault: Vault, directory: string) { this.directory = path.join(directory, "profiles"); }
  private file(id: string) { return path.join(this.directory, z.uuid().parse(id) + ".profile"); }
  private aad(owner: string, id: string, purpose = "profile-v2") { return Buffer.from(JSON.stringify([purpose, owner, id])); }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.active.get(id);
    const pending = (previous ?? Promise.resolve()).catch(() => {}).then(action);
    this.active.set(id, pending);
    try { return await pending; } finally { if (this.active.get(id) === pending) this.active.delete(id); }
  }
  private async current(id: string, owner?: string): Promise<{ version: number; data: Secret } | undefined> {
    const item = await this.vault.read(id);
    if (!item) return undefined;
    const data = Secret.parse(item.data);
    if (data.connectionId !== id || (owner !== undefined && data.owner !== owner)) throw new StorageError("PROFILE_OWNER_MISMATCH", 403);
    return { version: item.version, data };
  }
  private async recover(id: string): Promise<void> {
    const stored = this.db.prepare("SELECT value FROM settings WHERE id=?").get("profile-pending:" + id);
    if (!stored) return;
    const raw: unknown = JSON.parse(z.string().parse(stored["value"]));
    const writing = z.object({ stage: z.literal("WRITING"), id: z.string(), file: z.uuid() }).safeParse(raw);
    if (writing.success) {
      if (writing.data.id !== id) throw new StorageError("PROFILE_INVALID", 422);
      await rm(this.file(writing.data.file) + ".partial", { force: true });
      await rm(this.file(writing.data.file), { force: true });
      this.db.prepare("DELETE FROM settings WHERE id=?").run("profile-pending:" + id);
      return;
    }
    const pending = Pending.parse(raw);
    const key = await this.vault.unwrap(pending.wrappedKey);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(pending.nonce, "base64"));
      decipher.setAAD(this.aad(pending.owner, id, "profile-commit-v2")); decipher.setAuthTag(Buffer.from(pending.tag, "base64"));
      const next = Secret.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(pending.encrypted, "base64")), decipher.final()]).toString("utf8")));
      let current = await this.current(id, pending.owner);
      if (current?.data.profile?.operationId !== pending.operationId && (current?.version ?? 0) === pending.expectedVersion) {
        try { await this.vault.write(id, pending.expectedVersion, next); }
        catch (error) {
          current = await this.current(id, pending.owner);
          if (current?.data.profile?.operationId !== pending.operationId) throw error;
        }
        current = await this.current(id, pending.owner);
      }
      if (current?.data.profile?.operationId !== pending.operationId) {
        await rm(this.file(pending.file), { force: true });
        this.db.prepare("DELETE FROM settings WHERE id=?").run("profile-pending:" + id);
        throw new StorageError("PROFILE_REVISION_CHANGED", 409);
      }
      if (pending.previousFile) await rm(this.file(pending.previousFile), { force: true });
      this.db.prepare("DELETE FROM settings WHERE id=?").run("profile-pending:" + id);
    } finally { key.fill(0); }
  }
  async metadata(id: string, owner: string) {
    const value = (await this.current(id, owner))?.data.credential;
    return { available: !!value?.value, revision: value?.revision ?? 0, origin: value?.value?.origin ?? null };
  }
  async read(id: string, owner: string): Promise<Credential | undefined> { return (await this.current(id, owner))?.data.credential.value ?? undefined; }
  async write(id: string, owner: string, operationId: string, expectedRevision: number, value: Credential | null): Promise<void> {
    await this.locked(id, async () => {
      await this.recover(id);
      const current = await this.current(id, owner);
      const previous = current?.data.credential;
      if (previous?.operationId === operationId) {
        if (JSON.stringify(previous.value) !== JSON.stringify(value)) throw new CredentialConflict("Credential operation changed");
        return;
      }
      if ((previous?.revision ?? 0) !== expectedRevision) throw new CredentialConflict("Credential revision changed");
      const data: Secret = { ...(current?.data ?? { owner, connectionId: id }), credential: { value, revision: expectedRevision + 1, operationId } };
      try { await this.vault.write(id, current?.version ?? 0, data); }
      catch (error) { if ((await this.current(id, owner))?.data.credential.operationId !== operationId) throw error; }
    });
  }
  async remove(id: string): Promise<void> {
    await this.locked(id, async () => {
      await this.recover(id);
      const previous = await this.current(id);
      await this.vault.remove(id);
      if (previous?.data.profile) await rm(this.file(previous.data.profile.file), { force: true });
    });
  }
  async saved(id: string, owner: string, operationId: string) {
    await this.locked(id, () => this.recover(id));
    const profile = (await this.current(id, owner))?.data.profile;
    return profile?.operationId === operationId ? profile : undefined;
  }
  async save(id: string, owner: string, operationId: string, input: Readable, legacy?: { revision: number; savedAt: string; credential: Secret["credential"] }): Promise<z.infer<typeof Profile>> {
    return this.locked(id, async () => {
      await this.recover(id);
      const previous = await this.current(id, owner);
      if (previous?.data.profile?.operationId === operationId) { input.destroy(); return previous.data.profile; }
      const iterator = input[Symbol.asyncIterator]();
      let prefix = Buffer.alloc(0);
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new StorageError("PROFILE_INVALID", 422);
        const bytes = Buffer.from(next.value);
        const newline = bytes.indexOf(10);
        if (prefix.length + (newline < 0 ? bytes.length : newline) > 65536) throw new StorageError("PROFILE_INVALID", 422);
        if (newline < 0) { prefix = Buffer.concat([prefix, bytes]); continue; }
        const header = Header.parse(JSON.parse(Buffer.concat([prefix, bytes.subarray(0, newline)]).toString("utf8")));
        const candidate = header.candidate;
        if (candidate && !header.origins.includes(candidate.credential.origin)) throw new StorageError("PROFILE_OWNER_MISMATCH", 403);
        let credential = previous?.data.credential ?? { revision: 0, operationId: "", value: null };
        if (legacy) credential = legacy.credential;
        if (candidate) {
          if (candidate.operationId !== credential.operationId) {
            if (candidate.expectedRevision !== credential.revision) throw new CredentialConflict("Credential revision changed");
            credential = { revision: credential.revision + 1, operationId: candidate.operationId, value: candidate.credential };
          } else if (JSON.stringify(candidate.credential) !== JSON.stringify(credential.value)) throw new CredentialConflict("Credential operation changed");
        }
        const cleanHeader = Buffer.from(JSON.stringify({ type: "header", version: 2, origins: header.origins }) + "\n");
        const key = await this.vault.dataKey();
        const nonce = randomBytes(12); const file = randomUUID();
        const destination = this.file(file); const temporary = destination + ".partial";
        const cipher = createCipheriv("aes-256-gcm", key.plain, nonce); cipher.setAAD(this.aad(owner, id));
        const digest = createHash("sha256"); let total = 0; let record = 0; let tail = Buffer.alloc(0);
        const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
          total += chunk.length;
          if (total > 256 * 1024 * 1024) { done(new StorageError("PROFILE_TOO_LARGE", 413)); return; }
          for (const byte of chunk) {
            if (++record > 16 * 1024 * 1024) { done(new StorageError("PROFILE_RECORD_TOO_LARGE", 413)); return; }
            if (byte === 10) record = 0;
          }
          digest.update(chunk); tail = Buffer.concat([tail, chunk]).subarray(-1024); done(null, chunk);
        } });
        let journaled = false;
        try {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          this.db.prepare("INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run("profile-pending:" + id, JSON.stringify({ stage: "WRITING", id, file }));
          async function* content() {
            yield cleanHeader;
            const rest = bytes.subarray(newline + 1);
            for (let offset = 0; offset < rest.length; offset += 65536) yield rest.subarray(offset, offset + 65536);
            for (;;) {
              const next = await iterator.next(); if (next.done) break;
              const chunk = Buffer.from(next.value);
              for (let offset = 0; offset < chunk.length; offset += 65536) yield chunk.subarray(offset, offset + 65536);
            }
          }
          await pipeline(Readable.from(content()), counter, createGzip(), cipher, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
          if (!tail.toString("utf8").endsWith('{"type":"end"}\n')) {
            const code = /"type":"error","code":"(PROFILE_[A-Z_]+)"/.exec(tail.toString("utf8"))?.[1] ?? "PROFILE_INVALID";
            const status = code.endsWith("TOO_LARGE") || code === "PROFILE_COMPLEXITY_LIMIT" ? 413
              : code === "PROFILE_UNSUPPORTED_VALUE" || code === "PROFILE_INVALID" ? 422 : 409;
            throw new StorageError(code, status);
          }
          const handle = await open(temporary, "r"); try { await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, destination);
          const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
          const contentDigest = digest.digest("hex");
          const unchanged = previous?.data.profile?.digest === contentDigest ? previous.data.profile : undefined;
          const profile = { file, revision: legacy?.revision ?? unchanged?.revision ?? (previous?.data.profile?.revision ?? 0) + 1, savedAt: legacy?.savedAt ?? unchanged?.savedAt ?? new Date().toISOString(), origins: header.origins, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), wrappedKey: key.wrapped, digest: contentDigest, operationId };
          const data: Secret = { owner, connectionId: id, profile, credential };
          const commitNonce = randomBytes(12); const commit = createCipheriv("aes-256-gcm", key.plain, commitNonce);
          commit.setAAD(this.aad(owner, id, "profile-commit-v2"));
          const encrypted = Buffer.concat([commit.update(JSON.stringify(data)), commit.final()]);
          const pending = { id, owner, operationId, expectedVersion: previous?.version ?? 0, wrappedKey: key.wrapped, nonce: commitNonce.toString("base64"), tag: commit.getAuthTag().toString("base64"), encrypted: encrypted.toString("base64"), file, previousFile: previous?.data.profile?.file };
          this.db.prepare("INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run("profile-pending:" + id, JSON.stringify(pending)); journaled = true;
          await this.recover(id);
          return profile;
        } finally {
          key.plain.fill(0); input.destroy();
          await rm(temporary, { force: true });
          if (!journaled) {
            await rm(destination, { force: true });
            this.db.prepare("DELETE FROM settings WHERE id=?").run("profile-pending:" + id);
          }
        }
      }
    }).finally(() => input.destroy());
  }
  async stream(id: string, owner: string): Promise<{ input: Readable; completion: Promise<void> }> {
    const { profile, handle, key } = await this.locked(id, async () => {
      await this.recover(id);
      const profile = (await this.current(id, owner))?.data.profile;
      if (!profile) throw new StorageError("PROFILE_UNAVAILABLE", 409);
      const key = await this.vault.unwrap(profile.wrappedKey);
      try { return { profile, key, handle: await open(this.file(profile.file), "r") }; }
      catch { key.fill(0); throw new StorageError("PROFILE_INVALID", 422); }
    });
    const decrypt = () => {
      const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(profile.nonce, "base64"));
      cipher.setAAD(this.aad(owner, id)); cipher.setAuthTag(Buffer.from(profile.tag, "base64")); return cipher;
    };
    try {
      // Authenticate the entire immutable file before passing plaintext to a browser.
      await pipeline(handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 65536 }), decrypt(), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
      const input = new PassThrough({ highWaterMark: 65536 });
      let total = 0;
      const bound = new Transform({ transform(chunk: Buffer, _encoding, done) {
        total += chunk.length;
        done(total > 256 * 1024 * 1024 ? new StorageError("PROFILE_TOO_LARGE", 413) : null, chunk);
      } });
      const completion = pipeline(handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 65536 }), decrypt(), createGunzip(), bound, input)
        .finally(async () => { key.fill(0); await handle.close(); });
      void completion.catch(() => {});
      return { input, completion };
    } catch { key.fill(0); await handle.close(); throw new StorageError("PROFILE_INVALID", 422); }
  }
}
