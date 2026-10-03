import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { z } from 'zod';
import { WorkerError, profileBindingSchema } from './protocol.js';
export { profileBindingSchema } from './protocol.js';
export type ProfileBinding = z.infer<typeof profileBindingSchema>;
const storageSchema = z.object({
  cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(),
    expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']),
    partitionKey: z.string().optional() }).passthrough()).max(10_000),
  origins: z.array(z.object({ origin: z.url(), localStorage: z.array(z.object({ name: z.string(), value: z.string() })).max(10_000),
    indexedDB: z.array(z.json()).optional() }).passthrough()).max(64),
});
const header = Buffer.from('HGP1');
const maxBytes = 32 * 1024 * 1024;
function aad(binding: ProfileBinding): Buffer {
  return Buffer.from(`hg-profile:v1:${binding.userId.toLowerCase()}:${binding.connectionId.toLowerCase()}:${binding.profileId.toLowerCase()}:${binding.revision}`, 'utf8');
}
export function encryptProfile(plaintext: Buffer, key: Buffer, binding: ProfileBinding): Buffer {
  if (key.length !== 32 || plaintext.length > maxBytes) throw new WorkerError('PROFILE_LIMIT_OR_KEY');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, nonce, cipher.getAuthTag(), ciphertext]);
}
export function decryptProfile(blob: Buffer, key: Buffer, binding: ProfileBinding): Buffer {
  if (key.length !== 32 || blob.length < 32 || blob.length > maxBytes + 32 || !blob.subarray(0, 4).equals(header)) throw new WorkerError('PROFILE_FORMAT');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(4, 16));
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(blob.subarray(16, 32));
  const pending = decipher.update(blob.subarray(32));
  try { return Buffer.concat([pending, decipher.final()]); }
  catch { pending.fill(0); throw new WorkerError('PROFILE_AUTHENTICATION_FAILED'); }
}
export async function saveProfile(context: BrowserContext, key: Buffer, binding: ProfileBinding): Promise<Buffer> {
  const [rawState, currentCookies] = await Promise.all([context.storageState({ indexedDB: true }), context.cookies()]);
  const state = storageSchema.parse(rawState);
  const allowedOrigins = new Set(binding.storageOrigins);
  const allowedDomains = new Set(binding.cookieDomains.map((domain) => domain.toLowerCase()));
  const filtered = {
    cookies: state.cookies.filter((cookie) => allowedDomains.has(cookie.domain.toLowerCase())),
    origins: state.origins.filter((origin) => allowedOrigins.has(origin.origin)),
  };
  for (const cookie of filtered.cookies) {
    if (cookie.partitionKey && !allowedOrigins.has(cookie.partitionKey)) throw new WorkerError('PROFILE_PARTITION_UNSUPPORTED');
  }
  for (const cookie of currentCookies) {
    if (cookie.partitionKey && allowedDomains.has(cookie.domain.toLowerCase()) && !filtered.cookies.some((saved) =>
      saved.name === cookie.name && saved.domain === cookie.domain && saved.path === cookie.path && saved.partitionKey === cookie.partitionKey)) throw new WorkerError('PROFILE_PARTITION_UNSUPPORTED');
  }
  const plaintext = Buffer.from(JSON.stringify(filtered));
  try { return encryptProfile(plaintext, key, binding); }
  finally { plaintext.fill(0); key.fill(0); }
}
export async function loadProfile(context: BrowserContext, blob: Buffer, key: Buffer, binding: ProfileBinding): Promise<void> {
  let plaintext: Buffer | undefined;
  try {
    plaintext = decryptProfile(blob, key, binding);
    const state = storageSchema.parse(JSON.parse(plaintext.toString('utf8')));
    if (state.origins.some((origin) => !binding.storageOrigins.includes(origin.origin))
        || state.cookies.some((cookie) => !binding.cookieDomains.includes(cookie.domain)
          || (cookie.partitionKey !== undefined && !binding.storageOrigins.includes(cookie.partitionKey)))) throw new WorkerError('PROFILE_SCOPE_MISMATCH');
    await context.setStorageState(state);
  } finally { plaintext?.fill(0); key.fill(0); }
}
