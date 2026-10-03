import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const parameters = { N: 131072, r: 8, p: 1, maxmem: 268_435_456 };

/** Offline operator custody only; neither this file nor its password is delivered to Docker. */
export async function encryptRecovery(installationId, value, password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 4096) {
    throw new Error('Recovery custody password must contain between 16 and 4096 characters');
  }
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = await derive(password, salt, 32, parameters);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`helm-glass-recovery:1:${installationId}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { schemaVersion: 1, installationId, kdf: 'scrypt-131072-8-1',
      salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: encrypted.toString('base64') };
  } finally { key.fill(0); }
}

export async function decryptRecovery(installationId, envelope, password) {
  if (envelope?.schemaVersion !== 1 || envelope.installationId !== installationId
      || envelope.kdf !== 'scrypt-131072-8-1' || typeof password !== 'string'
      || password.length < 16 || password.length > 4096
      || [envelope.salt, envelope.iv, envelope.tag, envelope.ciphertext].some(value => typeof value !== 'string' || value.length > 65_536)) {
    throw new Error('Recovery custody input is invalid');
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error('Recovery custody input is invalid');
  const key = await derive(password, salt, 32, parameters);
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`helm-glass-recovery:1:${installationId}`));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new Error('Recovery custody authentication failed'); }
  finally { key.fill(0); }
}

export async function secretInput(name, prompt, environment = process.env) {
  const supplied = environment[name];
  if (typeof supplied === 'string' && supplied.length && !/[\0\r\n]/.test(supplied)) return supplied;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Required protected input ${name} is missing`);
  process.stdout.write(`${prompt}: `);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((accept, reject) => {
    let value = '';
    const cleanup = () => {
      input.off('data', receive);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
    };
    const receive = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { cleanup(); reject(new Error('Protected input cancelled')); return; }
        if (character === '\r' || character === '\n') { cleanup(); accept(value); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && value.length < 4096) value += character;
      }
    };
    input.on('data', receive);
  });
}
