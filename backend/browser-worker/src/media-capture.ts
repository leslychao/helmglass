import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import { ProxyAgent, request } from 'undici';
import { z } from 'zod';
import { uploadArtifact } from './artifact-transfer.js';
import type { AudioArtifactMetadata as ArtifactMetadata } from './artifact-transfer.js';
import { WorkerError } from './protocol.js';
import type { Action, Assignment, Command } from './protocol.js';
import { parseStreamManifest } from './stream-manifest.js';
import { OriginPolicy } from './origin-policy.js';
import type { StreamManifest } from './stream-manifest.js';

const run = promisify(execFile);
const mediaStateSchema = z.object({ index: z.number().int().nonnegative(), kind: z.enum(['AUDIO', 'VIDEO']),
  source: z.string().max(16_384), durationSeconds: z.number().nonnegative().nullable(),
  paused: z.boolean(), ended: z.boolean(), currentTime: z.number().min(0).max(86_400),
  playbackRate: z.number().min(0.0625).max(16), muted: z.boolean(), volume: z.number().min(0).max(1), protected: z.boolean(),
});
type MediaState = z.infer<typeof mediaStateSchema>;
type CaptureAction = Extract<Action, { type: 'READ_MEDIA' }>;
interface MediaBinding { state: MediaState; observationId: string; pageEpoch: number; privacyEpoch: number; controlEpoch: number; createdAt: number }
export interface MediaSummary { mediaRef: string; kind: 'AUDIO' | 'VIDEO'; durationSeconds: number | null;
  playbackState: 'ENDED' | 'PAUSED' | 'PLAYING'; capabilities: { capture: boolean; captions: boolean } }

export class MediaCapture {
  private readonly refs = new Map<string, MediaBinding>();
  private active: AbortController | undefined;

  invalidate(): void { this.refs.clear(); }
  cancel(): void { this.active?.abort(); this.invalidate(); }

  async inspect(page: Page, observationId: string, assignment: Assignment): Promise<MediaSummary[]> {
    this.invalidate();
    const states = await this.states(page);
    return states.map((state) => {
      const mediaRef = randomUUID();
      this.refs.set(mediaRef, { state, observationId, pageEpoch: assignment.pageEpoch, privacyEpoch: assignment.privacyEpoch,
        controlEpoch: assignment.controlEpoch, createdAt: performance.now() });
      return { mediaRef, kind: state.kind, durationSeconds: state.durationSeconds,
        playbackState: state.ended ? 'ENDED' : state.paused ? 'PAUSED' : 'PLAYING',
        capabilities: { capture: !state.protected, captions: false } };
    });
  }

  async capture(page: Page, assignment: Assignment, command: Command, action: CaptureAction, directory: string, proxy: string | undefined): Promise<Record<string, unknown>> {
    const binding = this.refs.get(action.mediaRef);
    if (!binding || binding.observationId !== action.observationId || performance.now() - binding.createdAt > 60_000
        || binding.pageEpoch !== assignment.pageEpoch || binding.privacyEpoch !== assignment.privacyEpoch
        || binding.controlEpoch !== assignment.controlEpoch) throw new WorkerError('MEDIA_REFERENCE_EXPIRED');
    this.invalidate();
    const current = (await this.states(page))[binding.state.index];
    if (!current || current.source !== binding.state.source || current.protected) throw new WorkerError('UNSUPPORTED_MEDIA');
    if (action.coverage === 'RANGE' && (action.startSeconds === undefined || action.endSeconds === undefined
        || action.endSeconds <= action.startSeconds || action.endSeconds - action.startSeconds > action.maxDurationSeconds)) throw new WorkerError('MEDIA_RANGE_INVALID');
    if (this.active) throw new WorkerError('MEDIA_CAPTURE_ACTIVE');
    const controller = new AbortController(); this.active = controller;
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), Math.min(action.maxDurationSeconds * 1000 + 30_000, Date.parse(assignment.deadline) - Date.now()));
    const staging = await mkdtemp(join(directory, 'capture-'));
    const path = join(staging, 'source');
    const playbackPath = join(staging, 'playback.wav');
    try {
      let sourceKind: ArtifactMetadata['sourceKind'] = 'FILE';
      let coverage: ArtifactMetadata['coverage'] = 'FULL';
      let quality: ArtifactMetadata['quality'] = [];
      let artifactPath = path;
      let sourceStart = 0;
      let coveredIntervals: ArtifactMetadata['coveredIntervals'] | undefined;
      let captureTimeline: ArtifactMetadata['captureTimeline'];
      let sourceUrl = current.source;
      if (/^https?:/.test(current.source) && proxy) {
        try { sourceUrl = await this.fetchSource(current.source, page, assignment, proxy, path, action.maxBytes, signal); }
        catch (error) {
          if (signal.aborted || (error instanceof WorkerError && error.code !== 'MEDIA_SOURCE_UNAVAILABLE')) throw error;
          sourceKind = 'PLAYBACK_CAPTURE';
        }
      } else sourceKind = 'PLAYBACK_CAPTURE';
      if (sourceKind === 'FILE') {
        const prefix = await this.prefix(path);
        if (prefix.trimStart().startsWith('#EXTM3U') || /<(?:[\w.-]+:)?MPD\b/.test(prefix)) {
          if (!proxy) throw new WorkerError('MEDIA_SOURCE_UNAVAILABLE');
          const stream = await this.streamSource(path, sourceUrl, page, assignment, proxy, staging, action, signal);
          sourceKind = 'STREAM_SEGMENTS'; artifactPath = stream.path; sourceStart = stream.start;
          coverage = stream.complete && action.coverage === 'FULL' ? 'FULL' : 'PARTIAL';
        } else {
          try { await this.probe(path); } catch { sourceKind = 'PLAYBACK_CAPTURE'; }
        }
      }
      // A requested range has explicit playback boundaries when no exact source segment exists.
      if (sourceKind === 'FILE' && action.coverage === 'RANGE') sourceKind = 'PLAYBACK_CAPTURE';
      if (sourceKind === 'PLAYBACK_CAPTURE') {
        artifactPath = playbackPath;
        const captured = await this.playback(page, current, action, playbackPath, signal);
        quality = captured.quality; coverage = captured.coverage;
        coveredIntervals = captured.coveredIntervals; captureTimeline = captured.captureTimeline;
      }
      signal.throwIfAborted();
      const info = await this.probe(artifactPath);
      if (info.durationSeconds > action.maxDurationSeconds + 0.1) throw new WorkerError('MEDIA_DURATION_LIMIT');
      const file = await stat(artifactPath);
      if (!file.size || file.size > action.maxBytes) throw new WorkerError('MEDIA_SIZE_LIMIT');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
      signal.throwIfAborted();
      const metadata: ArtifactMetadata = { schemaVersion: 1, commandId: command.commandId, attemptId: command.attemptId,
        browserSessionId: assignment.browserSessionId, allocationEpoch: assignment.allocationEpoch,
        pageEpoch: assignment.pageEpoch, privacyEpoch: assignment.privacyEpoch, kind: 'AUDIO', byteLength: file.size,
        sha256: hash.digest('hex'), sourceKind, coverage, quality,
        coveredIntervals: coveredIntervals ?? [{ startSeconds: sourceStart, endSeconds: sourceStart + info.durationSeconds }],
        ...(captureTimeline ? { captureTimeline: captureTimeline.map((entry) => ({ ...entry, recordingSeconds: Math.min(entry.recordingSeconds, info.durationSeconds) })) } : {}), ...info };
      const receipt = await uploadArtifact(artifactPath, metadata, signal);
      return { ...receipt, ...metadata, mediaRef: action.mediaRef };
    } finally {
      clearTimeout(timeout); this.active = undefined;
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async states(page: Page): Promise<MediaState[]> {
    // Fixed media-source inspection only; URLs remain private to this owner.
    const values = await page.locator('audio,video').evaluateAll((elements) => elements.slice(0, 32).map((element, index) => {
      if (!(element instanceof HTMLMediaElement)) throw new Error('MEDIA_ELEMENT_CHANGED');
      return { index, kind: element.tagName === 'VIDEO' ? 'VIDEO' : 'AUDIO', source: element.currentSrc,
        durationSeconds: Number.isFinite(element.duration) ? element.duration : null,
        currentTime: element.currentTime, paused: element.paused, ended: element.ended,
        playbackRate: element.playbackRate, muted: element.muted, volume: element.volume, protected: Boolean(element.mediaKeys) };
    }));
    return z.array(mediaStateSchema).max(32).parse(values);
  }

  private async fetchSource(rawUrl: string, page: Page, assignment: Assignment, proxy: string, path: string, maxBytes: number, signal: AbortSignal,
    range?: { offset: number; length: number }): Promise<string> {
    const dispatcher = new ProxyAgent(proxy);
    const policy = new OriginPolicy(assignment);
    try {
      let url = new URL(rawUrl);
      for (let redirect = 0; redirect <= 5; redirect++) {
        if (!policy.permits(url)) throw new WorkerError('MEDIA_ORIGIN_FORBIDDEN');
        const cookies = await page.context().cookies(url.toString());
        const response = await request(url, { dispatcher, signal, headersTimeout: 15_000, bodyTimeout: 15_000,
          headers: { cookie: cookies.map((cookie) => cookie.name + '=' + cookie.value).join('; '), 'accept-encoding': 'identity',
            ...(range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}) } });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location; response.body.destroy();
          if (typeof location !== 'string' || redirect === 5) throw new WorkerError('MEDIA_SOURCE_UNAVAILABLE');
          url = new URL(location, url); continue;
        }
        if (response.statusCode !== (range ? 206 : 200)
            || (range && !String(response.headers['content-range']).startsWith(`bytes ${range.offset}-${range.offset + range.length - 1}/`))) {
          response.body.destroy(); throw new WorkerError('MEDIA_SOURCE_UNAVAILABLE');
        }
        const expected = Number(response.headers['content-length']);
        if (Number.isFinite(expected) && expected > maxBytes) { response.body.destroy(); throw new WorkerError('MEDIA_SIZE_LIMIT'); }
        let bytes = 0;
        const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > maxBytes ? new WorkerError('MEDIA_SIZE_LIMIT') : null, chunk);
        } });
        await pipeline(response.body, bounded, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
        if (range && bytes !== range.length) throw new WorkerError('MEDIA_SOURCE_UNAVAILABLE');
        return url.toString();
      }
      throw new WorkerError('MEDIA_SOURCE_UNAVAILABLE');
    } finally { await dispatcher.close(); }
  }

  private async probe(path: string): Promise<{ durationSeconds: number; codec: string; channels: number; sampleRate: number; mimeType: string }> {
    const result = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
      'format=duration,format_name:stream=codec_type,codec_name,channels,sample_rate', '-of', 'json', path], { timeout: 10_000, maxBuffer: 32_768 });
    const parsed = z.object({ format: z.object({ duration: z.coerce.number().positive(), format_name: z.string() }),
      streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(), channels: z.number().optional(), sample_rate: z.coerce.number().optional() })).max(32) }).parse(JSON.parse(result.stdout));
    const audio = parsed.streams.filter((stream) => stream.codec_type === 'audio');
    if (audio.length !== 1 || !audio[0]?.channels || !audio[0].sample_rate) throw new WorkerError('UNSUPPORTED_MEDIA');
    const container = parsed.format.format_name.split(',');
    const mimeType = container.includes('wav') ? 'audio/wav' : container.includes('mp3') ? 'audio/mpeg'
      : container.includes('ogg') ? 'audio/ogg' : container.includes('mp4') ? 'video/mp4'
        : container.includes('matroska') ? 'audio/x-matroska' : container.includes('flac') ? 'audio/flac' : 'application/octet-stream';
    return { durationSeconds: parsed.format.duration, codec: audio[0].codec_name, channels: audio[0].channels, sampleRate: audio[0].sample_rate, mimeType };
  }

  private async prefix(path: string): Promise<string> {
    const file = await open(path, 'r');
    try { const bytes = Buffer.alloc(4096); const read = await file.read(bytes); return bytes.subarray(0, read.bytesRead).toString('utf8'); }
    finally { await file.close(); }
  }

  private async streamSource(manifestPath: string, url: string, page: Page, assignment: Assignment, proxy: string, directory: string,
    action: CaptureAction, signal: AbortSignal): Promise<{ path: string; start: number; complete: boolean }> {
    let parsed: StreamManifest | undefined;
    for (let depth = 0; depth < 4; depth++) {
      if ((await stat(manifestPath)).size > 1_048_576) throw new WorkerError('MEDIA_MANIFEST_LIMIT');
      parsed = await parseStreamManifest(await readFile(manifestPath, 'utf8'), url, signal);
      if (!parsed.playlistUrl) break;
      manifestPath = join(directory, `manifest-${depth}`);
      url = await this.fetchSource(parsed.playlistUrl, page, assignment, proxy, manifestPath, 1_048_576, signal);
    }
    if (!parsed?.segments.length || parsed.playlistUrl) throw new WorkerError('UNSUPPORTED_MEDIA');
    let position = 0; let bytes = 0; let start = -1; let duration = 0;
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1800'];
    const maps = new Map<string, string>();
    let lastMap: string | undefined;
    for (const [index, segment] of parsed.segments.entries()) {
      const segmentStart = position; position += segment.duration;
      if (action.coverage === 'RANGE' && (position <= (action.startSeconds ?? 0) || segmentStart >= (action.endSeconds ?? 0))) continue;
      if (duration + segment.duration > action.maxDurationSeconds) throw new WorkerError('MEDIA_DURATION_LIMIT');
      const fetch = async (resource: { uri: string; byterange?: { offset: number; length: number } | undefined }, name: string) => {
        const path = join(directory, name);
        await this.fetchSource(resource.uri, page, assignment, proxy, path, action.maxBytes - bytes, signal, resource.byterange);
        bytes += (await stat(path)).size; if (bytes > action.maxBytes) throw new WorkerError('MEDIA_SIZE_LIMIT');
        return name;
      };
      if (segment.map) {
        const key = JSON.stringify(segment.map);
        let local = maps.get(key);
        if (!local) { local = await fetch(segment.map, `map-${index}.mp4`); maps.set(key, local); }
        if (local !== lastMap) { playlist.push(`#EXT-X-MAP:URI="${local}"`); lastMap = local; }
      }
      if (segment.discontinuity) playlist.push('#EXT-X-DISCONTINUITY');
      const extension = /\.(ts|aac|mp3|m4s|m4a|mp4|webm|ogg)$/i.exec(new URL(segment.uri).pathname)?.[1]?.toLowerCase()
        ?? (segment.map ? 'm4s' : 'ts');
      playlist.push(`#EXTINF:${segment.duration},`, await fetch(segment, `segment-${index}.${extension}`));
      if (start < 0) start = segmentStart;
      duration += segment.duration;
    }
    if (!duration) throw new WorkerError('MEDIA_RANGE_INVALID');
    playlist.push('#EXT-X-ENDLIST');
    const localManifest = join(directory, 'local.m3u8'); const path = join(directory, 'stream.mka');
    await writeFile(localManifest, playlist.join('\n') + '\n', { mode: 0o600 });
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', localManifest, '-map', '0:a:0', '-vn', '-c:a', 'copy', '-f', 'matroska', path], { timeout: 30_000, maxBuffer: 8192, signal });
    return { path, start, complete: parsed.complete };
  }

  private async playback(page: Page, initial: MediaState, action: CaptureAction, path: string, signal: AbortSignal): Promise<{
    quality: ArtifactMetadata['quality']; coveredIntervals: ArtifactMetadata['coveredIntervals'];
    captureTimeline: NonNullable<ArtifactMetadata['captureTimeline']>; coverage: ArtifactMetadata['coverage'] }> {
    const quality: ArtifactMetadata['quality'] = [];
    for (const candidate of page.context().pages()) {
      const states = await this.states(candidate);
      if (states.some((item) => (candidate !== page || item.index !== initial.index) && !item.paused && !item.ended)) {
        quality.push('MIXED_AUDIO'); break;
      }
    }
    if (!initial.paused || initial.currentTime > 0) quality.push('LATE_CAPTURE');
    const sourceStart = action.startSeconds ?? initial.currentTime;
    const coveredIntervals: ArtifactMetadata['coveredIntervals'] = [];
    const captureTimeline: NonNullable<ArtifactMetadata['captureTimeline']> = [];
    let recordingSeconds = 0;
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', 'helm_capture.monitor',
      '-t', String(action.maxDurationSeconds), '-fs', String(action.maxBytes), '-c:a', 'pcm_f32le', '-progress', 'pipe:1', '-stats_period', '0.1', '-f', 'wav', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    let progress = '';
    child.stdout.on('data', (chunk: Buffer) => {
      progress += chunk.toString();
      const lines = progress.split('\n'); progress = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('out_time_us=')) {
        const seconds = Number(line.slice(12)) / 1_000_000;
        if (Number.isFinite(seconds) && seconds >= recordingSeconds) recordingSeconds = Math.min(seconds, 1800);
      }
    });
    let exited = false;
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', () => { exited = true; reject(new WorkerError('PLAYBACK_CAPTURE_UNAVAILABLE')); });
      child.once('exit', (code) => { exited = true; if (code === 0 || code === 255) resolve(); else reject(new WorkerError('PLAYBACK_CAPTURE_FAILED')); });
    });
    void completion.catch(() => undefined);
    const abort = () => child.kill('SIGINT');
    signal.addEventListener('abort', abort, { once: true });
    let completedSource = false;
    try {
      // The recorder is prepared before the explicitly authorized playback operation.
      const readyDeadline = performance.now() + 5000;
      while (!exited && recordingSeconds <= 0 && performance.now() < readyDeadline) await delay(25, undefined, { signal });
      if (exited) { await completion; throw new WorkerError('PLAYBACK_CAPTURE_UNAVAILABLE'); }
      if (recordingSeconds <= 0) throw new WorkerError('PLAYBACK_CAPTURE_UNAVAILABLE');
      await page.locator('audio,video').nth(initial.index).evaluate(async (element, rangeStart) => {
        if (!(element instanceof HTMLMediaElement) || element.mediaKeys) throw new Error('UNSUPPORTED_MEDIA');
        if (rangeStart !== null) element.currentTime = rangeStart;
        await element.play();
      }, action.coverage === 'RANGE' ? action.startSeconds ?? null : null);
      let previous = (await this.states(page))[initial.index];
      if (!previous) throw new WorkerError('MEDIA_SOURCE_CHANGED');
      let previousTime = performance.now();
      const mark = (state: MediaState) => captureTimeline.push({ recordingSeconds, sourceSeconds: state.currentTime,
        state: state.ended ? 'ENDED' : state.paused ? 'PAUSED' : 'PLAYING', playbackRate: state.playbackRate, muted: state.muted, volume: state.volume });
      mark(previous);
      const deadline = performance.now() + action.maxDurationSeconds * 1000;
      while (!exited && performance.now() < deadline) {
        await delay(200, undefined, { signal });
        const current = (await this.states(page))[initial.index];
        if (!current || current.source !== initial.source || current.protected) throw new WorkerError('MEDIA_SOURCE_CHANGED');
        const now = performance.now();
        const advancement = current.currentTime - previous.currentTime;
        const expected = previous.paused ? 0 : (now - previousTime) / 1000 * previous.playbackRate;
        const seek = Math.abs(advancement - expected) > 0.5;
        const changed = seek || current.paused !== previous.paused || current.ended !== previous.ended
          || current.playbackRate !== previous.playbackRate || current.muted !== previous.muted || current.volume !== previous.volume;
        if (seek || current.playbackRate !== 1 || current.muted || current.volume !== initial.volume || (current.paused && !current.ended)) {
          if (!quality.includes('PLAYBACK_CHANGED')) quality.push('PLAYBACK_CHANGED');
        }
        if (!seek && !previous.paused && !previous.muted && previous.volume > 0 && advancement > 0) {
          const last = coveredIntervals.at(-1);
          if (last && Math.abs(last.endSeconds - previous.currentTime) < 0.01) last.endSeconds = current.currentTime;
          else coveredIntervals.push({ startSeconds: previous.currentTime, endSeconds: current.currentTime });
        }
        if (changed) mark(current);
        previous = current; previousTime = now;
        if (captureTimeline.length >= 999 || coveredIntervals.length >= 999) break;
        if (current.ended || (action.endSeconds !== undefined && current.currentTime >= action.endSeconds)) { completedSource = true; break; }
      }
      if (!completedSource) quality.push('LIMIT_REACHED');
      child.kill('SIGINT'); await completion; signal.throwIfAborted();
      if (captureTimeline.at(-1)?.sourceSeconds !== previous.currentTime) mark(previous);
      const merged: ArtifactMetadata['coveredIntervals'] = [];
      for (const interval of coveredIntervals.sort((a, b) => a.startSeconds - b.startSeconds)) {
        const last = merged.at(-1);
        if (last && interval.startSeconds <= last.endSeconds) last.endSeconds = Math.max(last.endSeconds, interval.endSeconds);
        else merged.push(interval);
      }
      return { quality, coveredIntervals: merged, captureTimeline,
        coverage: quality.includes('MIXED_AUDIO') || quality.includes('PLAYBACK_CHANGED') ? 'UNKNOWN'
          : completedSource && sourceStart === 0 && !quality.length ? 'FULL' : 'PARTIAL' };
    } finally {
      signal.removeEventListener('abort', abort);
      if (!exited) { child.kill('SIGKILL'); await completion.catch(() => undefined); }
    }
  }
}
