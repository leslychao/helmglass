import { WebSocket } from 'ws';
import { z } from 'zod';
import { NativeMediaHelper } from './media-helper.js';
import { WorkerError } from './protocol.js';
import type { SignalingMessage, ViewClose, ViewOpen, ViewRenew, ViewerClosed, ViewerClosedAck, ViewerFence } from './protocol.js';
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
interface ViewerGeneration {
  binding: ViewerFence;
  state: 'OPENING' | 'LIVE' | 'CLOSED';
}
interface ClosureReceipt {
  fingerprint: string;
  pending?: Promise<void>;
  receipt?: ViewerClosed;
  acknowledged: boolean;
}
const MAX_FENCE_RECORDS = 256;
const fenceFields = ['workerBootId', 'browserSessionId', 'allocationEpoch', 'viewerId', 'viewGeneration'] as const;

function viewerFence(binding: ViewerFence): ViewerFence {
  return { workerBootId: binding.workerBootId, browserSessionId: binding.browserSessionId,
    allocationEpoch: binding.allocationEpoch, viewerId: binding.viewerId, viewGeneration: binding.viewGeneration };
}
function sameFence(left: ViewerFence, right: ViewerFence): boolean {
  return fenceFields.every(field => left[field] === right[field]);
}

/** No SDP is implemented here: the pinned upstream signaller and webrtcsink own negotiation. */
export class MediaSession {
  private readonly viewers = new Map<string, Viewer>();
  private readonly helper: Pick<NativeMediaHelper, 'request' | 'stop'>;
  private readonly closing = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, ViewerGeneration>();
  private readonly receipts = new Map<string, ClosureReceipt>();
  private readonly onFailure: () => void;
  private failed = false;
  private started = false;
  private generation = 0;
  private sampling = false;
  private barrier: Promise<void> | undefined;
  private fenceSequence = 0;
  private openings: Promise<void> = Promise.resolve();
  readonly capabilities: Promise<{ encoder: string | null; fallbackReason: string; gstreamerVersion: string }>;

  constructor(private readonly getSession: () => Pick<BrowserSession, 'assignment' | 'captureBinding'> | undefined,
    private readonly emit: (binding: ViewerFence, payload: Record<string, unknown>) => void,
    private readonly ended: (binding: ViewerFence, code: string) => void,
    private readonly closed: (receipt: ViewerClosed) => void,
    options: { helper?: Pick<NativeMediaHelper, 'request' | 'stop'>; onFailure?: () => void } = {}) {
    this.onFailure = options.onFailure ?? (() => undefined);
    this.helper = options.helper ?? new NativeMediaHelper(() => this.fail());
    this.capabilities = this.helper.request('capabilities').then((value) => z.object({
      encoder: z.enum(['nvh264enc', 'openh264enc']).nullable(), fallbackReason: z.string(), gstreamerVersion: z.string(),
    }).parse(value));
    setInterval(() => {
      for (const [id, viewer] of this.viewers) if (viewer.expiresAt <= Date.now()) this.requestClose(id, 'VIEW_LEASE_EXPIRED', viewer);
      if (this.started && !this.sampling) void this.sample().catch(() => this.fail());
    }, 250).unref();
  }

  async accept(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'viewOpen': {
        const generation = this.admit(message);
        const fence = this.fenceSequence;
        const opening = this.openings.then(() => this.open(message, fence)).catch((error: unknown) => {
          if (generation.state === 'OPENING') generation.state = 'CLOSED';
          throw error;
        });
        this.openings = opening.catch(() => undefined);
        await opening; break;
      }
      case 'viewRenew': await this.renew(message); break;
      case 'viewClose': await this.closeRequested(message); break;
      case 'viewerClosedAck': this.acknowledge(message); break;
      case 'signal': this.signal(message, message.payload); break;
    }
  }

  replayClosures(): void {
    for (const entry of this.receipts.values()) if (entry.receipt) this.closed(entry.receipt);
  }

  private admit(binding: ViewOpen): ViewerGeneration {
    if (this.failed) throw new WorkerError('FENCING_FAILED');
    this.requireCurrentAllocation(binding);
    const previous = this.generations.get(binding.viewerId);
    if (previous && (previous.state !== 'CLOSED' || binding.viewGeneration <= previous.binding.viewGeneration
      || binding.workerBootId !== previous.binding.workerBootId)) throw new WorkerError('VIEW_BINDING_FENCED');
    // The mount outlives a browser session. The previous consumer must be physically
    // closed, but a higher generation may belong to the supervisor's new allocation.
    if (!previous) this.requireCapacity(this.generations.size);
    const generation: ViewerGeneration = { binding: viewerFence(binding), state: 'OPENING' };
    this.generations.set(binding.viewerId, generation);
    return generation;
  }

  private requireCurrentAllocation(binding: ViewerFence): void {
    const session = this.getSession();
    if (!session) throw new WorkerError('SESSION_NOT_FOUND');
    const assignment = session.assignment;
    if (assignment.workerBootId !== binding.workerBootId || assignment.browserSessionId !== binding.browserSessionId
      || assignment.allocationEpoch !== binding.allocationEpoch) throw new WorkerError('VIEW_BINDING_FENCED');
  }

  private requireCapacity(size: number): void {
    if (size < MAX_FENCE_RECORDS) return;
    this.fail();
    throw new WorkerError('FENCING_FAILED');
  }

  private requireOpening(binding: ViewOpen): ViewerGeneration {
    const generation = this.generations.get(binding.viewerId);
    if (!generation || !sameFence(generation.binding, binding) || generation.state !== 'OPENING') throw new WorkerError('VIEW_REVOKED');
    return generation;
  }

  private async closeRequested(message: ViewClose): Promise<void> {
    const fingerprint = JSON.stringify(viewerFence(message));
    let entry = this.receipts.get(message.requestId);
    if (entry) {
      if (entry.fingerprint !== fingerprint) throw new WorkerError('VIEW_CLOSE_CONFLICT');
    } else {
      if (this.failed) throw new WorkerError('FENCING_FAILED');
      this.requireCapacity(this.receipts.size);
      entry = { fingerprint, acknowledged: false };
      this.receipts.set(message.requestId, entry);
      const receipt: ViewerClosed = { schemaVersion: 1, type: 'viewerClosed', requestId: message.requestId,
        ...viewerFence(message), code: 'VIEW_CLOSED' };
      const retained = entry;
      retained.pending = this.fenceViewer(message).then(() => { retained.receipt = receipt; });
    }
    await entry.pending;
    // After PG acknowledges, only the immutable fingerprint remains. An exact retry can
    // reconstruct the same bounded receipt without touching a later native consumer.
    this.closed(entry.receipt ?? { schemaVersion: 1, type: 'viewerClosed', requestId: message.requestId,
      ...viewerFence(message), code: 'VIEW_CLOSED' });
  }

  private async fenceViewer(binding: ViewerFence): Promise<void> {
    const generation = this.generations.get(binding.viewerId);
    if (!generation) {
      this.requireCurrentAllocation(binding);
      this.requireCapacity(this.generations.size);
      this.generations.set(binding.viewerId, { binding: viewerFence(binding), state: 'CLOSED' });
      return;
    }
    if (!sameFence(generation.binding, binding)) {
      const previous = generation.binding;
      if (generation.state !== 'CLOSED' || binding.viewGeneration <= previous.viewGeneration
        || binding.workerBootId !== previous.workerBootId) throw new WorkerError('VIEW_BINDING_FENCED');
      this.requireCurrentAllocation(binding);
      // CLOSED proves the older consumer was physically removed or never existed. No newer
      // open was admitted: admission would have replaced this generation. Fence the unused
      // ticket too, so its delayed open cannot create a consumer after this receipt.
      this.generations.set(binding.viewerId, { binding: viewerFence(binding), state: 'CLOSED' });
      return;
    }
    if (generation.state === 'CLOSED') return;
    if (this.viewers.has(binding.viewerId) || this.closing.has(binding.viewerId)) {
      await this.closeViewer(binding.viewerId, 'VIEW_CLOSED');
    } else if (generation.state === 'OPENING') {
      // Admission precedes asynchronous discovery/start. This tombstone cancels a
      // queued opening before any native consumer can exist.
      generation.state = 'CLOSED';
    } else if (this.barrier) {
      await this.barrier;
    }
    if (generation.state !== 'CLOSED') throw new WorkerError('FENCING_FAILED');
  }

  private acknowledge(message: ViewerClosedAck): void {
    const entry = this.receipts.get(message.requestId);
    if (!entry || entry.fingerprint !== JSON.stringify(viewerFence(message))
      || (!entry.receipt && !entry.acknowledged)) throw new WorkerError('VIEW_CLOSE_ACK_FENCED');
    entry.acknowledged = true;
    delete entry.receipt;
    delete entry.pending;
  }

  private confirmClosed(binding: ViewerFence, code: string): void {
    const generation = this.generations.get(binding.viewerId);
    if (!generation || !sameFence(generation.binding, binding)) throw new WorkerError('VIEW_BINDING_FENCED');
    generation.state = 'CLOSED';
    if (code !== 'VIEW_CLOSED') this.ended(viewerFence(binding), code);
  }

  closeAll(code = 'VIEW_REVOKED'): Promise<void> {
    this.fenceSequence++;
    if (this.barrier) return this.barrier;
    const opening = this.openings;
    const closing = [...this.closing.values()];
    const viewers = [...this.viewers];
    this.viewers.clear(); this.started = false;
    for (const [, viewer] of viewers) viewer.socket.close(1000);
    this.barrier = (async () => {
      try {
        // An in-flight start must finish before the stop can prove a privacy barrier.
        await opening;
        await Promise.all(closing);
        if (this.failed) throw new WorkerError('FENCING_FAILED');
        await this.helper.stop();
        for (const [, viewer] of viewers) this.confirmClosed(viewer.binding, code);
      } catch (error) { this.fail(); throw error; }
    })().finally(() => { if (!this.failed) this.barrier = undefined; });
    return this.barrier;
  }

  private async open(binding: ViewOpen, fence: number): Promise<void> {
    this.requireOpening(binding);
    if (this.fenceSequence !== fence) throw new WorkerError('VIEW_REVOKED');
    if (this.barrier) await this.barrier;
    await Promise.all(this.closing.values());
    if (!(await this.capabilities).encoder || this.failed) throw new WorkerError('STREAM_UNAVAILABLE');
    if (this.fenceSequence !== fence) throw new WorkerError('VIEW_REVOKED');
    if (this.viewers.has(binding.viewerId) || this.closing.has(binding.viewerId) || this.viewers.size + this.closing.size >= 2) throw new WorkerError('VIEWER_LIMIT');
    const duration = this.duration(binding.leaseExpiresAt);
    const runtime = this.getSession();
    if (!runtime) throw new WorkerError('SESSION_NOT_FOUND');
    const surface = await runtime.captureBinding(binding);
    const discovered = z.object({ windows: z.array(z.object({ xid: z.number().int().positive(), pid: z.number().int(),
      x: z.number(), y: z.number(), width: z.number(), height: z.number() })) }).parse(await this.helper.request('discover'));
    if (this.failed || this.fenceSequence !== fence) throw new WorkerError('VIEW_REVOKED');
    this.requireOpening(binding);
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
        try { message = JSON.parse(raw.toString()); } catch { this.requestClose(binding.viewerId, 'INVALID_SIGNALING', viewer); return; }
        const envelope = z.object({ type: z.string(), peerId: z.string().optional() }).safeParse(message);
        if (!envelope.success) { this.requestClose(binding.viewerId, 'INVALID_SIGNALING', viewer); return; }
        if (envelope.data.type === 'welcome' && !viewer.peerId && envelope.data.peerId) {
          viewer.peerId = envelope.data.peerId; clearTimeout(deadline); resolve(); return;
        }
        try { this.receive(viewer, message); }
        catch { this.requestClose(binding.viewerId, 'INVALID_SIGNALING', viewer); }
      });
      socket.once('close', () => { clearTimeout(deadline); reject(new WorkerError('SIGNALING_CLOSED')); this.requestClose(binding.viewerId, 'SIGNALING_CLOSED', viewer); });
    });
    try {
      await welcome;
      if (this.fenceSequence !== fence || this.viewers.get(binding.viewerId) !== viewer) throw new WorkerError('VIEW_REVOKED');
      this.requireOpening(binding).state = 'LIVE';
      const turnServers = binding.producerIceServer.urls.map((url) => {
        if (url !== 'turn:coturn:3478?transport=tcp') throw new WorkerError('PRODUCER_TURN_FORBIDDEN');
        const parsed = new URL(url.replace(/^turn(s?):/, 'turn$1://'));
        parsed.username = binding.producerIceServer.username; parsed.password = binding.producerIceServer.credential;
        return parsed.toString();
      });
      if (!this.started) {
        this.generation = binding.mediaGeneration;
        const httpProxy = new URL(binding.mediaProxy.url);
        httpProxy.username = binding.mediaProxy.username; httpProxy.password = binding.mediaProxy.password;
        await this.helper.request('start', { ...matching[0], generation: this.generation, peerId: viewer.peerId,
          durationMs: this.duration(new Date(viewer.expiresAt).toISOString()), turnServers, httpProxy: httpProxy.toString() });
        if (this.failed || this.fenceSequence !== fence || this.viewers.get(binding.viewerId) !== viewer) throw new WorkerError('VIEW_REVOKED');
        this.started = true;
      } else await this.helper.request('lease', { peerId: viewer.peerId, generation: this.generation,
        durationMs: this.duration(binding.leaseExpiresAt), turnServers });
      socket.send(JSON.stringify({ type: 'setPeerStatus', roles: ['listener'] }));
      socket.send(JSON.stringify({ type: 'list' }));
      const deadline = Date.now() + 10_000;
      const poll = setInterval(() => {
        if (!this.viewers.has(binding.viewerId) || viewer.ready) { clearInterval(poll); return; }
        if (Date.now() >= deadline) { clearInterval(poll); this.requestClose(binding.viewerId, 'PRODUCER_UNAVAILABLE', viewer); return; }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'list' }));
      }, 100);
      poll.unref();
    } catch (error) { await this.closeViewer(binding.viewerId, 'VIEW_OPEN_FAILED'); throw error; }
  }

  private async renew(message: ViewRenew): Promise<void> {
    const viewer = this.requireViewer(message.viewerId);
    for (const field of ['workerBootId', 'browserSessionId', 'allocationEpoch', 'controlEpoch', 'pageEpoch', 'privacyEpoch', 'mediaGeneration', 'viewGeneration'] as const) {
      if (viewer.binding[field] !== message[field]) throw new WorkerError('VIEW_LEASE_FENCED');
    }
    this.requireCurrentAllocation(message);
    const runtime = this.getSession();
    if (!runtime || runtime.assignment.pageEpoch !== message.pageEpoch || runtime.assignment.privacyEpoch !== message.privacyEpoch
      || runtime.assignment.controlEpoch !== message.controlEpoch) throw new WorkerError('VIEW_LEASE_FENCED');
    const duration = this.duration(message.leaseExpiresAt);
    if (Date.parse(message.leaseExpiresAt) <= viewer.expiresAt) throw new WorkerError('VIEW_LEASE_NOT_ADVANCED');
    viewer.expiresAt = Date.parse(message.leaseExpiresAt);
    if (viewer.peerId && this.started) await this.helper.request('lease', { peerId: viewer.peerId, generation: this.generation, durationMs: duration });
  }

  private signal(binding: ViewerFence, raw: Record<string, unknown>): void {
    const viewer = this.requireViewer(binding.viewerId);
    if (!sameFence(binding, viewer.binding)) throw new WorkerError('VIEW_BINDING_FENCED');
    if (!viewer.ready) throw new WorkerError('VIEW_NOT_READY');
    const message = consumerSignalSchema.parse(raw);
    if (message.type === 'listConsumers') { this.emit(viewerFence(viewer.binding), { type: 'listConsumers', consumers: [] }); return; }
    if (message.type === 'setPeerStatus' && JSON.stringify(message.meta ?? {}).length > 2048) throw new WorkerError('SIGNALING_LIMIT');
    if (message.type === 'startSession' && (message.peerId !== viewer.producerId || viewer.sessionId)) throw new WorkerError('PRODUCER_FORBIDDEN');
    if ('sessionId' in message && message.sessionId !== viewer.sessionId) throw new WorkerError('PEER_SESSION_FORBIDDEN');
    if (message.type === 'peer' && message.ice && ++viewer.candidates > 128) throw new WorkerError('ICE_LIMIT');
    viewer.socket.send(JSON.stringify(message));
  }

  private receive(viewer: Viewer, raw: unknown): void {
    if (this.failed || this.viewers.get(viewer.binding.viewerId) !== viewer) return;
    const message = z.record(z.string(), z.unknown()).parse(raw);
    if (message['type'] === 'list') {
      const list = z.object({ producers: z.array(z.object({ id: z.string().max(128), meta: z.json().optional() })) }).parse(raw);
      if (list.producers.length !== 1 || !list.producers[0]) return;
      const producer = list.producers[0];
      if (viewer.producerId && viewer.producerId !== producer.id) { void this.closeAll('PRODUCER_CHANGED').catch(() => this.fail()); return; }
      viewer.producerId = producer.id;
      if (!viewer.ready) {
        this.emitState(viewer, 'PREPARING'); viewer.ready = true;
        this.emit(viewerFence(viewer.binding), { type: 'welcome', peerId: viewer.peerId });
      }
      this.emit(viewerFence(viewer.binding), { type: 'list', producers: [producer] }); return;
    }
    if (!viewer.ready) return;
    if (message['type'] === 'peerStatusChanged') {
      if (message['peerId'] === viewer.peerId || message['peerId'] === viewer.producerId) this.emit(viewerFence(viewer.binding), message);
      return;
    }
    if (message['type'] === 'sessionStarted') {
      if (typeof message['sessionId'] !== 'string' || message['peerId'] !== viewer.producerId) { this.requestClose(viewer.binding.viewerId, 'PEER_SESSION_FORBIDDEN', viewer); return; }
      viewer.sessionId = message['sessionId'];
    }
    if (message['type'] === 'peer' || message['type'] === 'endSession') {
      if (message['sessionId'] !== viewer.sessionId) { this.requestClose(viewer.binding.viewerId, 'PEER_SESSION_FORBIDDEN', viewer); return; }
    } else if (message['type'] !== 'sessionStarted' && message['type'] !== 'error') return;
    this.emit(viewerFence(viewer.binding), message);
  }

  private requestClose(id: string, code: string, expected: Viewer): void {
    if (this.viewers.get(id) !== expected) return;
    void this.closeViewer(id, code).catch(() => this.fail());
  }

  private closeViewer(id: string, code: string): Promise<void> {
    const closing = this.closing.get(id);
    if (closing) return closing;
    if (this.failed) return Promise.reject(new WorkerError('FENCING_FAILED'));
    const viewer = this.viewers.get(id);
    if (!viewer) return Promise.resolve();
    this.viewers.delete(id); viewer.socket.close(1000);
    const stopSource = !this.viewers.size;
    if (stopSource) { this.fenceSequence++; this.started = false; }
    const stopped = (async () => {
      try {
        if (viewer.peerId) z.object({ type: z.literal('revokeAck') }).parse(await this.helper.request('revoke', { peerId: viewer.peerId }));
        if (stopSource) await this.helper.stop();
        if (this.failed) throw new WorkerError('FENCING_FAILED');
        this.confirmClosed(viewer.binding, code);
      } catch (error) { this.fail(); throw error; }
    })().finally(() => { this.closing.delete(id); });
    this.closing.set(id, stopped);
    return stopped;
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true; this.started = false; this.fenceSequence++;
    for (const viewer of this.viewers.values()) viewer.socket.close(1000);
    this.viewers.clear();
    this.onFailure();
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
    this.emit(viewerFence(viewer.binding), { type: 'streamState', sessionId: viewer.binding.browserSessionId,
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
