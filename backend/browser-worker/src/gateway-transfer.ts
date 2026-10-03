import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { z } from 'zod';
import { WorkerError } from './protocol.js';

/** A single scoped ciphertext transfer; never retry a write after unknown delivery. */
export async function transferProfile(transferId: string, transferToken: string, signal: AbortSignal, upload?: Buffer): Promise<Buffer> {
  signal.throwIfAborted();
  z.uuid().parse(transferId);
  const config = z.object({ WORKER_CONTROL_URL: z.url(), WORKER_ID: z.uuid(), WORKER_BOOT_ID: z.uuid(),
    MTLS_CERT_FILE: z.string(), MTLS_KEY_FILE: z.string(), MTLS_CA_FILE: z.string() }).parse(process.env);
  const [cert, key, ca] = await Promise.all([readFile(config.MTLS_CERT_FILE), readFile(config.MTLS_KEY_FILE), readFile(config.MTLS_CA_FILE)]);
  const endpoint = new URL(config.WORKER_CONTROL_URL);
  endpoint.protocol = 'https:'; endpoint.pathname = '/internal/worker/profile-transfers/' + transferId;
  endpoint.search = ''; endpoint.hash = '';
  const maxBytes = 33_554_464;
  const sha256 = upload ? createHash('sha256').update(upload).digest('hex') : undefined;
  if (upload && upload.length > maxBytes) throw new WorkerError('PROFILE_SIZE_LIMIT');
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(endpoint, { method: upload ? 'PUT' : 'GET', cert, key, ca,
      rejectUnauthorized: true, timeout: 30_000, signal,
      headers: { 'x-worker-id': config.WORKER_ID, 'x-worker-boot-id': config.WORKER_BOOT_ID,
        'x-transfer-token': transferToken, ...(upload && sha256 ? { 'content-type': 'application/octet-stream', 'content-length': upload.length, 'x-content-sha256': sha256 } : {}) },
    }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (upload ? 4096 : maxBytes)) response.destroy(new WorkerError('PROFILE_SIZE_LIMIT'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new WorkerError('PROFILE_TRANSFER_UNKNOWN')));
      response.on('end', () => {
        if (response.statusCode !== 200 && response.statusCode !== 204) { reject(new WorkerError('PROFILE_TRANSFER_REJECTED')); return; }
        const body = Buffer.concat(chunks);
        if (upload) {
          try {
            const receipt = z.strictObject({ sha256: z.string(), byteLength: z.number().int() }).parse(JSON.parse(body.toString('utf8')));
            if (receipt.sha256 !== sha256 || receipt.byteLength !== upload.length) throw new Error('digest');
          } catch { reject(new WorkerError('PROFILE_TRANSFER_RECEIPT_INVALID')); return; }
        }
        resolve(body);
      });
    });
    req.once('timeout', () => req.destroy(new WorkerError('PROFILE_TRANSFER_TIMEOUT')));
    req.once('error', () => reject(new WorkerError('PROFILE_TRANSFER_UNKNOWN')));
    req.end(upload);
  });
}
