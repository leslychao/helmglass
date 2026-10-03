import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { Parser } from 'm3u8-parser';
import { parse as parseDash } from 'mpd-parser';
import { z } from 'zod';
import { WorkerError } from './protocol.js';

const requestSchema = z.object({ text: z.string().max(1_048_576), url: z.url() });
const rangeSchema = z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive().max(268_435_456) });
const resourceSchema = z.object({ uri: z.string().min(1).max(16_384), resolvedUri: z.string().max(16_384).optional(), byterange: rangeSchema.optional() });
const segmentSchema = resourceSchema.extend({ duration: z.number().positive().max(1800),
  key: z.object({ method: z.literal('NONE') }).optional(), map: resourceSchema.optional(),
  discontinuity: z.boolean().optional(), contentProtection: z.never().optional() });
const playlistSchema = z.object({ uri: z.string().max(16_384).optional(), resolvedUri: z.string().max(16_384).optional(),
  segments: z.array(segmentSchema).max(4096).optional(), endList: z.boolean().optional(), contentProtection: z.never().optional() });
const renditionSchema = z.object({ uri: z.string().max(16_384).optional(), playlists: z.array(playlistSchema).max(32).optional() });
const manifestSchema = playlistSchema.extend({ playlists: z.array(playlistSchema).max(32).optional(),
  mediaGroups: z.object({ AUDIO: z.record(z.string(), z.record(z.string(), renditionSchema)).optional() }).optional() });
export const streamManifestSchema = z.object({ playlistUrl: z.url().optional(),
  segments: z.array(segmentSchema).max(4096), complete: z.boolean() });
export type StreamManifest = z.infer<typeof streamManifestSchema>;

function decode(text: string, url: string): StreamManifest {
  // No key fetch, entity expansion, XLink fetching, or encrypted tracks are admitted.
  if (/<!DOCTYPE|<!ENTITY|<(?:[\w.-]+:)?ContentProtection\b/i.test(text)) throw new WorkerError('UNSUPPORTED_MEDIA');
  let raw: unknown;
  if (text.trimStart().startsWith('#EXTM3U')) {
    const parser = new Parser({ url }); parser.push(text); parser.end(); raw = parser.manifest;
  } else if (/<(?:[\w.-]+:)?MPD\b/.test(text)) raw = parseDash(text, { manifestUri: url });
  else throw new WorkerError('MEDIA_SOURCE_UNAVAILABLE');
  const manifest = manifestSchema.parse(raw);
  const audio = Object.values(manifest.mediaGroups?.AUDIO ?? {}).flatMap((group) => Object.values(group));
  if (audio.length > 1) throw new WorkerError('MEDIA_TRACK_AMBIGUOUS');
  const track = audio[0];
  let playlist = manifest;
  if (track?.uri) return { playlistUrl: new URL(track.uri, url).toString(), segments: [], complete: false };
  if (track?.playlists?.[0]) playlist = track.playlists[0];
  else if (!manifest.segments?.length && manifest.playlists?.[0]) playlist = manifest.playlists[0];
  if (!playlist.segments?.length) {
    const child = playlist.resolvedUri ?? playlist.uri;
    if (!child) throw new WorkerError('UNSUPPORTED_MEDIA');
    return { playlistUrl: new URL(child, url).toString(), segments: [], complete: false };
  }
  const resolveResource = (resource: z.infer<typeof resourceSchema>) => ({ ...resource, uri: new URL(resource.resolvedUri ?? resource.uri, url).toString() });
  return { complete: playlist.endList ?? manifest.endList ?? false, segments: playlist.segments.map((segment) => ({
    ...segment, ...resolveResource(segment), ...(segment.map ? { map: resolveResource(segment.map) } : {}),
  })) };
}

if (!isMainThread) {
  try { const input = requestSchema.parse(workerData); parentPort?.postMessage({ value: decode(input.text, input.url) }); }
  catch { parentPort?.postMessage({ error: 'UNSUPPORTED_MEDIA' }); }
}

/** Parser execution has independent memory and time bounds for hostile manifests. */
export async function parseStreamManifest(text: string, url: string, signal: AbortSignal): Promise<StreamManifest> {
  requestSchema.parse({ text, url }); signal.throwIfAborted();
  const worker = new Worker(new URL(import.meta.url), { workerData: { text, url },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
  return new Promise<StreamManifest>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); void worker.terminate(); };
    const fail = () => { cleanup(); reject(new WorkerError('UNSUPPORTED_MEDIA')); };
    const abort = () => { cleanup(); reject(new WorkerError('MEDIA_CAPTURE_CANCELLED')); };
    const timer = setTimeout(fail, 5000);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: unknown) => {
      const result = z.object({ value: streamManifestSchema }).safeParse(message);
      cleanup(); if (result.success) resolve(result.data.value); else reject(new WorkerError('UNSUPPORTED_MEDIA'));
    });
    worker.once('error', fail);
    worker.once('exit', (code) => { if (code !== 0) fail(); });
  });
}
