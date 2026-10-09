import { z } from "zod";

export class StorageError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
export class Vault {
  private token = "";
  private expires = 0;
  private loginPending: Promise<void> | undefined;
  constructor(private readonly address: string, private readonly role: string, private readonly secret: string) {
    if (new URL(address).protocol !== "https:") throw new Error("Vault requires HTTPS");
  }
  private async request(path: string, method: string, data?: object, authenticated = true): Promise<{ status: number; value: unknown }> {
    if (authenticated && (!this.token || Date.now() >= this.expires)) {
      this.loginPending ??= this.login().finally(() => { this.loginPending = undefined; });
      await this.loginPending;
    }
    try {
      const response = await fetch(this.address + "/v1/" + path, {
        method, headers: { "Content-Type": "application/json", ...(authenticated ? { "X-Vault-Token": this.token } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(15_000), redirect: "error",
      });
      if (response.status === 403) { this.token = ""; this.expires = 0; }
      if (!response.body) return { status: response.status, value: null };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > 131_072) { await reader.cancel(); throw new StorageError("PROFILE_STORAGE_UNAVAILABLE"); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return { status: response.status, value: size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null };
    } catch { throw new StorageError("PROFILE_STORAGE_UNAVAILABLE"); }
  }
  private async login(): Promise<void> {
    const result = await this.request("auth/approle/login", "POST", { role_id: this.role, secret_id: this.secret }, false);
    if (result.status !== 200) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
    const auth = z.object({ auth: z.object({ client_token: z.string().min(1), lease_duration: z.number().positive() }) }).parse(result.value).auth;
    this.token = auth.client_token; this.expires = Date.now() + Math.max(1, auth.lease_duration - 30) * 1000;
  }
  private key(id: string) { return "helmglass/data/connections/" + Buffer.from(id).toString("base64url"); }
  async read(id: string): Promise<{ version: number; data: unknown } | undefined> {
    const result = await this.request(this.key(id), "GET");
    if (result.status === 404) return undefined;
    if (result.status !== 200) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
    const value = z.object({ data: z.object({ data: z.unknown(), metadata: z.object({ version: z.number().int().positive() }) }) }).parse(result.value).data;
    return { version: value.metadata.version, data: value.data };
  }
  async write(id: string, version: number, data: object): Promise<void> {
    const result = await this.request(this.key(id), "POST", { options: { cas: version }, data });
    if (result.status === 400) throw new StorageError("PROFILE_REVISION_CHANGED", 409);
    if (result.status !== 200) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
  }
  async remove(id: string): Promise<void> {
    const result = await this.request("helmglass/metadata/connections/" + Buffer.from(id).toString("base64url"), "DELETE");
    if (![204, 404].includes(result.status)) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
  }
  async dataKey(): Promise<{ plain: Buffer; wrapped: string }> {
    const result = await this.request("transit/datakey/plaintext/helmglass-profiles", "POST", { bits: 256 });
    if (result.status !== 200) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
    const data = z.object({ data: z.object({ plaintext: z.string(), ciphertext: z.string() }) }).parse(result.value).data;
    const plain = Buffer.from(data.plaintext, "base64");
    if (plain.length !== 32) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
    return { plain, wrapped: data.ciphertext };
  }
  async unwrap(wrapped: string): Promise<Buffer> {
    const result = await this.request("transit/decrypt/helmglass-profiles", "POST", { ciphertext: wrapped });
    if (result.status !== 200) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
    const data = z.object({ data: z.object({ plaintext: z.string() }) }).parse(result.value).data;
    const plain = Buffer.from(data.plaintext, "base64");
    if (plain.length !== 32) throw new StorageError("PROFILE_STORAGE_UNAVAILABLE");
    return plain;
  }
}
