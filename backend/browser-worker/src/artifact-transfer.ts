import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { WorkerError } from './protocol.js';

const audioMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1), commandId: z.uuid(), attemptId: z.uuid(), browserSessionId: z.uuid(),
  allocationEpoch: z.number().int().nonnegative(), pageEpoch: z.number().int().nonnegative(), privacyEpoch: z.number().int().nonnegative(),
  kind: z.literal('AUDIO'), mimeType: z.string().min(1).max(128), byteLength: z.number().int().positive().max(268_435_456),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceKind: z.enum(['FILE', 'STREAM_SEGMENTS', 'PLAYBACK_CAPTURE']),
  coverage: z.enum(['FULL', 'PARTIAL', 'UNKNOWN']),
  coveredIntervals: z.array(z.strictObject({ startSeconds: z.number().nonnegative(), endSeconds: z.number().positive() })).max(1000),
  durationSeconds: z.number().positive().max(1800), codec: z.string().min(1).max(80),
  channels: z.number().int().min(1).max(32), sampleRate: z.number().int().min(8000).max(384_000),
  quality: z.array(z.enum(['MIXED_AUDIO', 'LATE_CAPTURE', 'LIMIT_REACHED', 'PLAYBACK_CHANGED'])).max(4),
  captureTimeline: z.array(z.strictObject({ recordingSeconds: z.number().min(0).max(1800), sourceSeconds: z.number().min(0).max(86_400),
    state: z.enum(['PLAYING', 'PAUSED', 'ENDED']), playbackRate: z.number().min(0.0625).max(16), muted: z.boolean(), volume: z.number().min(0).max(1) })).max(1000).optional(),
});
const screenshotMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1), commandId: z.uuid(), attemptId: z.uuid(), browserSessionId: z.uuid(),
  allocationEpoch: z.number().int().positive(), pageEpoch: z.number().int().positive(), privacyEpoch: z.number().int().positive(),
  kind: z.literal('SCREENSHOT'), sourceKind: z.literal('BROWSER_SCREENSHOT'), mimeType: z.literal('image/png'),
  byteLength: z.number().int().min(1).max(16_777_216), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  viewport: z.strictObject({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }),
});
export const artifactMetadataSchema = z.discriminatedUnion('kind', [audioMetadataSchema, screenshotMetadataSchema]);
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;
export type AudioArtifactMetadata = Extract<ArtifactMetadata, { kind: 'AUDIO' }>;
const allocationSchema = z.strictObject({ artifactId: z.uuid(), transferId: z.uuid(), transferToken: z.string().min(32).max(512) });
export const artifactReadySchema = z.strictObject({ artifactId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive(), state: z.literal('READY') });

export async function uploadArtifact(path: string, metadata: ArtifactMetadata, signal: AbortSignal): Promise<z.infer<typeof artifactReadySchema>> {
  artifactMetadataSchema.parse(metadata);
  const config = z.object({ WORKER_CONTROL_URL: z.url(), WORKER_ID: z.uuid(), WORKER_BOOT_ID: z.uuid(),
    MTLS_CERT_FILE: z.string(), MTLS_KEY_FILE: z.string(), MTLS_CA_FILE: z.string() }).parse(process.env);
  const [cert, key, ca] = await Promise.all([readFile(config.MTLS_CERT_FILE), readFile(config.MTLS_KEY_FILE), readFile(config.MTLS_CA_FILE)]);
  const endpoint = new URL(config.WORKER_CONTROL_URL); endpoint.protocol = 'https:'; endpoint.search = ''; endpoint.hash = '';
  async function send(pathname: string, method: 'POST' | 'PUT', token?: string): Promise<unknown> {
    endpoint.pathname = pathname;
    const body = method === 'POST' ? Buffer.from(JSON.stringify(metadata)) : undefined;
    return new Promise<unknown>((resolve, reject) => {
      const req = request(endpoint, { cert, key, ca, rejectUnauthorized: true, method, signal, timeout: 120_000,
        headers: { 'x-worker-id': config.WORKER_ID, 'x-worker-boot-id': config.WORKER_BOOT_ID,
          'content-type': body ? 'application/json' : 'application/octet-stream', 'content-length': body?.length ?? metadata.byteLength,
          ...(token ? { 'x-transfer-token': token, 'x-content-sha256': metadata.sha256 } : {}) } }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8192) res.destroy(new WorkerError('ARTIFACT_RECEIPT_LIMIT')); else chunks.push(chunk); });
        res.on('error', () => reject(new WorkerError('ARTIFACT_TRANSFER_UNKNOWN')));
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new WorkerError('ARTIFACT_TRANSFER_REJECTED')); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new WorkerError('ARTIFACT_RECEIPT_INVALID')); }
        });
      });
      req.once('timeout', () => req.destroy(new WorkerError('ARTIFACT_TRANSFER_TIMEOUT')));
      req.once('error', () => reject(new WorkerError('ARTIFACT_TRANSFER_UNKNOWN')));
      if (body) req.end(body);
      else {
        const stream = createReadStream(path);
        stream.once('error', () => req.destroy(new WorkerError('ARTIFACT_STAGING_LOST')));
        req.once('close', () => stream.destroy()); stream.pipe(req);
      }
    });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const allocation = allocationSchema.parse(await send('/internal/worker/artifact-transfers/allocate', 'POST'));
      const receipt = artifactReadySchema.parse(await send('/internal/worker/artifact-transfers/' + allocation.transferId, 'PUT', allocation.transferToken));
      if (receipt.artifactId !== allocation.artifactId || receipt.sha256 !== metadata.sha256 || receipt.byteLength !== metadata.byteLength) throw new WorkerError('ARTIFACT_RECEIPT_MISMATCH');
      return receipt;
    } catch (error) {
      // The API guarantees allocation/PUT idempotency for identical attempt, bytes and digest.
      if (signal.aborted || attempt === 2 || !(error instanceof WorkerError) || error.code !== 'ARTIFACT_TRANSFER_UNKNOWN') throw error;
      await delay(500 * 2 ** attempt, undefined, { signal });
    }
  }
  throw new WorkerError('ARTIFACT_TRANSFER_UNKNOWN');
}
