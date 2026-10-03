import { WebSocket } from 'ws';
import { z } from 'zod';
import { NativeMediaHelper } from './media-helper.js';
import { WorkerError } from './protocol.js';
import type { SignalingMessage, ViewOpen, ViewRenew } from './protocol.js';
import type { BrowserSession } from './session.js';

const sdpSchema = z.strictObject({ type: z.enum(['offer', 'answer']), sdp: z.string().max(245_760) });
const iceSchema = z.strictObject({ candidate: z.string().max(4096), sdpMLineIndex: z.number().int().nonnegative().max(32),
  sdpMid: z.string().max(128).nullable().optional(), usernameFragment: z.string().max(256).nullable().optional() });
const consumerSignalSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('setPeerStatus'), roles: z.tuple([z.literal('listener')]), meta: z.json().optional() }),
  z.strictObject({ type: z.literal('list') }),
  z.strictObject({ type: z.literal('listConsumers') }),
  z.strictObject({ type: z.literal('startSession'), peerId: z.string().max(128), offer: z.string().max(245_760).optional() }),
  z.strictObject({ type: z.literal('endSession'), sessionId: z.string().max(128) }),
  z.strictObject({ type: z.literal('peer'), sessionId: z.string().max(128), sdp: sdpSchema.optional(), ice: iceSchema.optional() }),
]);
interface Viewer {
  binding: ViewOpen;
  socket: WebSocket;
  peerId?: string;
  producerId?: string;
  sessionId?: string;
  ready: boolean;
  candidates: number;
  expiresAt: number;
}

/** No SDP is implemented here: the pinned upstream signaller and webrtcsink own negotiation. */
export class MediaSession {
  private readonly viewers = new Map<string, Viewer>();
  private readonly helper = new NativeMediaHelper(() => { this.failed = true; void this.closeAll('MEDIA_HELPER_LOST'); });
  private failed = false;
  private started = false;
  private generation = 0;
  private sampling = false;
  private barrier: Promise<void> | undefined;
  private fenceSequence = 0;
  private openings: Promise<void> = Promise.resolve();
  readonly capabilities: Promise<{ encoder: string | null; fallbackReason: string; gstreamerVersion: string }>;

  constructor(private readonly getSession: () => BrowserSession | undefined,
    private readonly emit: (viewerId: string, payload: Record<string, unknown>) => void,
    private readonly ended: (viewerId: string, code: string) => void) {
    this.capabilities = this.helper.request('capabilities').then((value) => z.object({
      encoder: z.enum(['nvh264enc', 'openh264enc']).nullable(), fallbackReason: z.string(), gstreamerVersion: z.string(),
    }).parse(value));
    setInterval(() => {
      for (const [id, viewer] of this.viewers) if (viewer.expiresAt <= Date.now()) void this.closeViewer(id, 'VIEW_LEASE_EXPIRED');
      if (this.started && !this.sampling) void this.sample();
    }, 250).unref();
  }

  async accept(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'viewOpen': {
        const opening = this.openings.then(() => this.open(message));
        this.openings = opening.catch(() => undefined);
        await opening; break;
      }
      case 'viewRenew': await this.renew(message); break;
      case 'viewClose': await this.closeViewer(message.viewerId, 'VIEW_CLOSED'); break;
      case 'signal': this.signal(message.viewerId, message.payload); break;
    }
  }

  closeAll(code = 'VIEW_REVOKED'): Promise<void> {
    this.fenceSequence++;
    if (this.barrier) return this.barrier;
    this.barrier = (async () => {
      for (const [id, viewer] of this.viewers) { viewer.socket.close(1000); this.ended(id, code); }
      this.viewers.clear(); this.started = false;
      if (!this.failed) await this.helper.stop();
    })().finally(() => { this.barrier = undefined; });
    return this.barrier;
  }

  private async open(binding: ViewOpen): Promise<void> {
    if (this.barrier) await this.barrier;
    if (this.failed || !(await this.capabilities).encoder) throw new WorkerError('STREAM_UNAVAILABLE');
    if (this.viewers.has(binding.viewerId) || this.viewers.size >= 2) throw new WorkerError('VIEWER_LIMIT');
    const fence = this.fenceSequence;
    const duration = this.duration(binding.leaseExpiresAt);
    const runtime = this.getSession();
    if (!runtime) throw new WorkerError('SESSION_NOT_FOUND');
    const surface = await runtime.captureBinding(binding);
    const discovered = z.object({ windows: z.array(z.object({ xid: z.number().int().positive(), pid: z.number().int(),
      x: z.number(), y: z.number(), width: z.number(), height: z.number() })) }).parse(await this.helper.request('discover'));
    const matching = discovered.windows.filter((window) => window.pid === surface.pid && window.x === 0 && window.y === 0
      && window.width === surface.width && window.height === surface.height);
    if (matching.length !== 1 || !matching[0]) throw new WorkerError('SURFACE_BINDING_AMBIGUOUS');
    if (this.started && this.generation !== binding.mediaGeneration) throw new WorkerError('MEDIA_GENERATION_FENCED');
    const socket = new WebSocket('ws://127.0.0.1:8443', { maxPayload: 262_144, perMessageDeflate: false, handshakeTimeout: 3000 });
    const viewer: Viewer = { binding, socket, ready: false, candidates: 0, expiresAt: Date.now() + duration };
    this.viewers.set(binding.viewerId, viewer);
    const welcome = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new WorkerError('SIGNALING_TIMEOUT')), 3000);
      socket.once('error', () => { clearTimeout(deadline); reject(new WorkerError('SIGNALING_UNAVAILABLE')); });
      socket.on('message', (raw) => {
        let message: unknown;
        try { message = JSON.parse(raw.toString()); } catch { void this.closeViewer(binding.viewerId, 'INVALID_SIGNALING'); return; }
        const envelope = z.object({ type: z.string(), peerId: z.string().optional() }).safeParse(message);
        if (!envelope.success) { void this.closeViewer(binding.viewerId, 'INVALID_SIGNALING'); return; }
        if (envelope.data.type === 'welcome' && !viewer.peerId && envelope.data.peerId) {
          viewer.peerId = envelope.data.peerId; clearTimeout(deadline); resolve(); return;
        }
        try { this.receive(viewer, message); }
        catch { void this.closeViewer(binding.viewerId, 'INVALID_SIGNALING'); }
      });
      socket.once('close', () => { clearTimeout(deadline); reject(new WorkerError('SIGNALING_CLOSED')); void this.closeViewer(binding.viewerId, 'SIGNALING_CLOSED'); });
    });
    try {
      await welcome;
      if (this.fenceSequence !== fence || this.viewers.get(binding.viewerId) !== viewer) throw new WorkerError('VIEW_REVOKED');
      if (!this.started) {
        this.generation = binding.mediaGeneration;
        const turnServers = [binding.producerIceServer].flatMap((server) => server.urls.map((url) => {
          if (url !== 'turn:coturn:3478?transport=tcp') throw new WorkerError('PRODUCER_TURN_FORBIDDEN');
          const parsed = new URL(url.replace(/^turn(s?):/, 'turn$1://'));
          parsed.username = server.username; parsed.password = server.credential;
          return parsed.toString();
        }));
        const httpProxy = new URL(binding.mediaProxy.url);
        httpProxy.username = binding.mediaProxy.username; httpProxy.password = binding.mediaProxy.password;
        await this.helper.request('start', { ...matching[0], generation: this.generation, peerId: viewer.peerId,
          durationMs: this.duration(new Date(viewer.expiresAt).toISOString()), turnServers, httpProxy: httpProxy.toString() });
        if (this.fenceSequence !== fence) { await this.helper.stop(); throw new WorkerError('VIEW_REVOKED'); }
        this.started = true;
      } else await this.helper.request('lease', { peerId: viewer.peerId, generation: this.generation, durationMs: this.duration(binding.leaseExpiresAt) });
      socket.send(JSON.stringify({ type: 'setPeerStatus', roles: ['listener'] }));
      socket.send(JSON.stringify({ type: 'list' }));
      const deadline = Date.now() + 10_000;
      const poll = setInterval(() => {
        if (!this.viewers.has(binding.viewerId) || viewer.ready) { clearInterval(poll); return; }
        if (Date.now() >= deadline) { clearInterval(poll); void this.closeViewer(binding.viewerId, 'PRODUCER_UNAVAILABLE'); return; }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'list' }));
      }, 100);
      poll.unref();
    } catch (error) { await this.closeViewer(binding.viewerId, 'VIEW_OPEN_FAILED'); throw error; }
  }

  private async renew(message: ViewRenew): Promise<void> {
    const viewer = this.requireViewer(message.viewerId);
    for (const field of ['browserSessionId', 'allocationEpoch', 'controlEpoch', 'pageEpoch', 'privacyEpoch', 'mediaGeneration', 'viewGeneration'] as const) {
      if (viewer.binding[field] !== message[field]) throw new WorkerError('VIEW_LEASE_FENCED');
    }
    const runtime = this.getSession();
    if (!runtime || runtime.assignment.pageEpoch !== message.pageEpoch || runtime.assignment.privacyEpoch !== message.privacyEpoch
      || runtime.assignment.controlEpoch !== message.controlEpoch) throw new WorkerError('VIEW_LEASE_FENCED');
    const duration = this.duration(message.leaseExpiresAt);
    if (Date.parse(message.leaseExpiresAt) <= viewer.expiresAt) throw new WorkerError('VIEW_LEASE_NOT_ADVANCED');
    viewer.expiresAt = Date.parse(message.leaseExpiresAt);
    if (viewer.peerId && this.started) await this.helper.request('lease', { peerId: viewer.peerId, generation: this.generation, durationMs: duration });
  }

  private signal(id: string, raw: Record<string, unknown>): void {
    const viewer = this.requireViewer(id);
    if (!viewer.ready) throw new WorkerError('VIEW_NOT_READY');
    const message = consumerSignalSchema.parse(raw);
    if (message.type === 'listConsumers') { this.emit(id, { type: 'listConsumers', consumers: [] }); return; }
    if (message.type === 'setPeerStatus' && JSON.stringify(message.meta ?? {}).length > 2048) throw new WorkerError('SIGNALING_LIMIT');
    if (message.type === 'startSession' && (message.peerId !== viewer.producerId || viewer.sessionId)) throw new WorkerError('PRODUCER_FORBIDDEN');
    if ('sessionId' in message && message.sessionId !== viewer.sessionId) throw new WorkerError('PEER_SESSION_FORBIDDEN');
    if (message.type === 'peer' && message.ice && ++viewer.candidates > 128) throw new WorkerError('ICE_LIMIT');
    viewer.socket.send(JSON.stringify(message));
  }

  private receive(viewer: Viewer, raw: unknown): void {
    const message = z.record(z.string(), z.unknown()).parse(raw);
    if (message['type'] === 'list') {
      const list = z.object({ producers: z.array(z.object({ id: z.string().max(128), meta: z.json().optional() })) }).parse(raw);
      if (list.producers.length !== 1 || !list.producers[0]) return;
      const producer = list.producers[0];
      if (viewer.producerId && viewer.producerId !== producer.id) { void this.closeAll('PRODUCER_CHANGED'); return; }
      viewer.producerId = producer.id;
      if (!viewer.ready) {
        this.emitState(viewer, 'PREPARING'); viewer.ready = true;
        this.emit(viewer.binding.viewerId, { type: 'welcome', peerId: viewer.peerId });
      }
      this.emit(viewer.binding.viewerId, { type: 'list', producers: [producer] }); return;
    }
    if (!viewer.ready) return;
    if (message['type'] === 'peerStatusChanged') {
      if (message['peerId'] === viewer.peerId || message['peerId'] === viewer.producerId) this.emit(viewer.binding.viewerId, message);
      return;
    }
    if (message['type'] === 'sessionStarted') {
      if (typeof message['sessionId'] !== 'string' || message['peerId'] !== viewer.producerId) { void this.closeViewer(viewer.binding.viewerId, 'PEER_SESSION_FORBIDDEN'); return; }
      viewer.sessionId = message['sessionId'];
    }
    if (message['type'] === 'peer' || message['type'] === 'endSession') {
      if (message['sessionId'] !== viewer.sessionId) { void this.closeViewer(viewer.binding.viewerId, 'PEER_SESSION_FORBIDDEN'); return; }
    } else if (message['type'] !== 'sessionStarted' && message['type'] !== 'error') return;
    this.emit(viewer.binding.viewerId, message);
  }

  private async closeViewer(id: string, code: string): Promise<void> {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    this.viewers.delete(id); viewer.socket.close(1000);
    try {
      if (!this.failed && viewer.peerId) await this.helper.request('revoke', { peerId: viewer.peerId });
      if (!this.viewers.size && this.started) { this.started = false; if (!this.failed) await this.helper.stop(); }
    } catch { this.failed = true; }
    this.ended(id, code);
  }

  private async sample(): Promise<void> {
    this.sampling = true;
    try {
      const status = z.object({ ageMs: z.number(), sequence: z.number() }).parse(await this.helper.request('captureStatus'));
      for (const viewer of this.viewers.values()) if (viewer.ready) this.emitState(viewer, status.ageMs >= 0 && status.ageMs <= 500 ? 'ACTIVE' : 'STALE', status.sequence, status.ageMs);
    } catch { await this.closeAll('CAPTURE_UNAVAILABLE'); }
    finally { this.sampling = false; }
  }

  private emitState(viewer: Viewer, captureState: string, captureSequence = 0, captureAgeMs = -1): void {
    this.emit(viewer.binding.viewerId, { type: 'streamState', sessionId: viewer.binding.browserSessionId,
      pageEpoch: viewer.binding.pageEpoch, privacyEpoch: viewer.binding.privacyEpoch, controlEpoch: viewer.binding.controlEpoch,
      mediaGeneration: viewer.binding.mediaGeneration, viewGeneration: viewer.binding.viewGeneration,
      producerId: viewer.producerId, viewport: this.getSession()?.assignment.viewport, captureState,
      captureSequence, captureAgeMs, mediaLeaseExpiresAt: new Date(viewer.expiresAt).toISOString(), iceServers: viewer.binding.iceServers });
  }
  private requireViewer(id: string): Viewer {
    const viewer = this.viewers.get(id);
    if (!viewer || viewer.expiresAt <= Date.now()) throw new WorkerError('VIEW_LEASE_EXPIRED');
    return viewer;
  }
  private duration(expiry: string): number {
    const duration = Date.parse(expiry) - Date.now();
    if (duration <= 0 || duration > 5000) throw new WorkerError('VIEW_LEASE_INVALID');
    return Math.min(duration, 4900);
  }
}
