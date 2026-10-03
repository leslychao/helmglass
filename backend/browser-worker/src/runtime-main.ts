import { randomUUID } from 'node:crypto';
import { apiMessageSchema, signalingMessageSchema, digest, safeCode, WorkerError } from './protocol.js';
import type { ExecutionPermit, LaunchPermit } from './protocol.js';
import { BrowserSession } from './session.js';
import { MediaSession } from './media-session.js';
import { SessionSupervisor } from './session-supervisor.js';

const bootId = process.env.WORKER_BOOT_ID;
const stagingDirectory = process.env.STAGING_DIRECTORY;
const proxyServer = process.env.EGRESS_PROXY_URL;
if (!bootId || !stagingDirectory || !proxyServer) throw new Error('Missing worker runtime configuration');
let draining = false;
const permits = new Map<string, { resolve: (permit: ExecutionPermit) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
const launchPermits = new Map<string, { resolve: (permit: LaunchPermit) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
const closures = new Map<string, Promise<Record<string, unknown>>>();
function send(value: unknown): void { process.send?.(value); }
const supervisor: SessionSupervisor<BrowserSession> = new SessionSupervisor(bootId, (assignment) => BrowserSession.create(assignment, {
  stagingDirectory, proxyServer, headless: false,
  ...(process.env.DISPLAY ? { display: process.env.DISPLAY } : {}), mediaBarrier: () => media.closeAll(),
  onHardDeadline: () => { void reportClosed(assignment.browserSessionId, assignment.allocationEpoch, randomUUID())
    .catch(() => send({ type: 'fatal', code: 'RUNTIME_CLOSURE_UNCONFIRMED' })); },
}));
const media: MediaSession = new MediaSession(() => supervisor.session,
  (viewerId, payload) => send({ schemaVersion: 1, type: 'viewerMessage', requestId: randomUUID(), viewerId, payload }),
  (binding, code) => send({ schemaVersion: 1, type: 'viewerEnded', requestId: randomUUID(), ...binding, code }),
  send,
  { onFailure: () => send({ type: 'fatal', code: 'FENCING_FAILED' }) });
let capabilities: Record<string, unknown> = { encoder: null, captureState: 'STREAM_UNAVAILABLE' };
void media.capabilities.then((value) => { capabilities = { ...value, captureState: value.encoder ? 'IDLE' : 'STREAM_UNAVAILABLE' }; })
  .catch(() => { capabilities = { encoder: null, captureState: 'STREAM_UNAVAILABLE' }; });
function inventory(): void {
  const snapshot = supervisor.inventory();
  const usage = supervisor.session && snapshot && !('state' in snapshot) ? supervisor.session.usageCheckpoint() : undefined;
  send({ type: 'runtimeHeartbeat', inventory: snapshot ? { ...snapshot, ...(usage ? { usage } : {}) } : null, draining, capabilities });
}
async function reportClosed(browserSessionId: string, allocationEpoch: number, requestId: string): Promise<void> {
  const key = browserSessionId + ':' + allocationEpoch;
  let receipt = closures.get(key);
  if (!receipt) {
    if (closures.size >= 256) throw new WorkerError('CLOSURE_ACK_BACKPRESSURE');
    receipt = supervisor.close(browserSessionId, allocationEpoch).then(closed => ({
      schemaVersion: 1, type: 'closed', browserSessionId, allocationEpoch,
      closedAt: new Date().toISOString(), receiptId: randomUUID(), ...(closed ? { usage: closed.usageCheckpoint() } : {}),
    }));
    closures.set(key, receipt);
  }
  send({ ...await receipt, requestId });
}
setInterval(inventory, 1000).unref();
process.on('message', (raw: unknown) => {
  if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'signalingConnected') {
    media.replayClosures(); return;
  }
  if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'snapshotRequest' && 'requestId' in raw) {
    void supervisor.snapshot().then((snapshot) => send({ type: 'runtimeSnapshot', requestId: raw.requestId, inventory: snapshot, draining, capabilities }))
      .catch(() => send({ type: 'fatal', code: 'FENCING_FAILED' })); return;
  }
  if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'signalingDisconnected') {
    void media.closeAll('SIGNALING_CHANNEL_LOST').catch(() => send({ type: 'fatal', code: 'FENCING_FAILED' })); return;
  }
  if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'tunnelDisconnected') {
    for (const pending of permits.values()) { clearTimeout(pending.timer); pending.reject(new WorkerError('CONTROL_CHANNEL_LOST')); }
    permits.clear();
    for (const pending of launchPermits.values()) { clearTimeout(pending.timer); pending.reject(new WorkerError('CONTROL_CHANNEL_LOST')); }
    launchPermits.clear();
    void supervisor.fenceDisconnected().catch(() => send({ type: 'fatal', code: 'FENCING_FAILED' }));
    return;
  }
  const signaling = signalingMessageSchema.safeParse(raw);
  if (signaling.success) {
    const message = signaling.data;
    void media.accept(message).then(() => {
      if (message.type !== 'viewClose' && message.type !== 'viewerClosedAck') {
        send({ schemaVersion: 1, type: message.type + 'Ack', requestId: message.requestId, viewerId: message.viewerId });
      }
    })
      .catch((error: unknown) => send({ schemaVersion: 1, type: 'viewerMessage', requestId: message.requestId,
        viewerId: message.viewerId, payload: { type: 'error', details: safeCode(error) } }));
    return;
  }
  const decoded = apiMessageSchema.safeParse(raw);
  if (!decoded.success) { send({ type: 'fatal', code: 'INVALID_INTERNAL_MESSAGE' }); return; }
  const message = decoded.data;
  if (message.type === 'launchPermit' || message.type === 'launchPermitDenied') {
    const pending = launchPermits.get(message.requestId);
    if (!pending) return;
    launchPermits.delete(message.requestId); clearTimeout(pending.timer);
    if (message.type === 'launchPermit') pending.resolve(message.permit);
    else pending.reject(new WorkerError(message.code));
    return;
  }
  if (message.type === 'startPermit' || message.type === 'permitDenied') {
    const pending = permits.get(message.requestId);
    if (!pending) return;
    permits.delete(message.requestId); clearTimeout(pending.timer);
    if (message.type === 'startPermit') pending.resolve(message.permit);
    else pending.reject(new WorkerError(message.code));
    return;
  }
  void (async () => {
    switch (message.type) {
      case 'assign': {
        if (draining) throw new WorkerError('WORKER_CAPACITY');
        await supervisor.assign(message.assignment, (assignmentDigest) => {
          const promise = new Promise<LaunchPermit>((resolve, reject) => {
            const timer = setTimeout(() => { launchPermits.delete(message.requestId); reject(new WorkerError('LAUNCH_PERMIT_TIMEOUT')); }, 10_000);
            launchPermits.set(message.requestId, { resolve, reject, timer });
          });
          send({ schemaVersion: 1, type: 'launchPermitRequest', requestId: message.requestId,
            browserSessionId: message.assignment.browserSessionId, allocationEpoch: message.assignment.allocationEpoch, assignmentDigest });
          return promise;
        });
        send({ schemaVersion: 1, type: 'assigned', requestId: message.requestId, ...supervisor.inventory() });
        break;
      }
      case 'command': {
        const runtime = supervisor.session;
        if (!runtime) throw new WorkerError('SESSION_NOT_FOUND');
        const result = await runtime.execute(message.command, async (actionDigest) => {
          const permitPromise = new Promise<ExecutionPermit>((resolve, reject) => {
            const timer = setTimeout(() => { permits.delete(message.requestId); reject(new WorkerError('START_PERMIT_TIMEOUT')); }, 10_000);
            permits.set(message.requestId, { resolve, reject, timer });
          });
          const assignment = runtime.assignment;
          send({ schemaVersion: 1, type: 'startPermitRequest', requestId: message.requestId,
            commandId: message.command.commandId, attemptId: message.command.attemptId,
            taskId: assignment.taskId, browserSessionId: assignment.browserSessionId,
            allocationEpoch: assignment.allocationEpoch, controlEpoch: assignment.controlEpoch,
            pageEpoch: assignment.pageEpoch, privacyEpoch: assignment.privacyEpoch,
            policyVersion: assignment.policyVersion, instructionRevision: assignment.instructionRevision, actionDigest });
          return permitPromise;
        });
        send({ schemaVersion: 1, type: 'commandResult', requestId: message.requestId, result });
        break;
      }
      case 'runtimeReady': {
        const session = supervisor.session;
        if (!session) throw new WorkerError('SESSION_NOT_FOUND');
        const usage = await session.markReady(message.browserSessionId, message.allocationEpoch);
        send({ schemaVersion: 1, type: 'runtimeReadyAck', requestId: message.requestId,
          browserSessionId: message.browserSessionId, allocationEpoch: message.allocationEpoch, usage });
        break;
      }
      case 'control': {
        const session = supervisor.session;
        if (!session) throw new WorkerError('SESSION_NOT_FOUND');
        send({ schemaVersion: 1, type: 'controlAck', requestId: message.requestId, ...await session.control(message) });
        break;
      }
      case 'input': {
        const session = supervisor.session;
        if (!session) throw new WorkerError('SESSION_NOT_FOUND');
        send({ schemaVersion: 1, type: 'inputAck', requestId: message.requestId, browserSessionId: message.browserSessionId, ...await session.input(message) });
        break;
      }
      case 'controlRenew': {
        const session = supervisor.session;
        if (!session) throw new WorkerError('SESSION_NOT_FOUND');
        send({ schemaVersion: 1, type: 'controlRenewAck', requestId: message.requestId, ...session.renewControl(message) });
        break;
      }
      case 'profileSave': case 'profileLoad': {
        const session = supervisor.session;
        if (!session) throw new WorkerError('SESSION_NOT_FOUND');
        send({ schemaVersion: 1, type: message.type === 'profileSave' ? 'profileSaved' : 'profileLoaded',
          requestId: message.requestId, browserSessionId: message.browserSessionId, ...await session.transferProfile(message) });
        break;
      }
      case 'profileCheck': {
        const session = supervisor.session;
        if (!session) throw new WorkerError('SESSION_NOT_FOUND');
        send({ schemaVersion: 1, type: 'profileChecked', requestId: message.requestId, ...await session.checkProfile(message) });
        break;
      }
      case 'profileTransferAck': {
        const session = supervisor.session;
        if (!session) throw new WorkerError('SESSION_NOT_FOUND');
        await session.acknowledgeProfile(message);
        break;
      }
      case 'close': {
        await reportClosed(message.browserSessionId, message.allocationEpoch, message.requestId);
        break;
      }
      case 'closedAck': {
        const key = message.browserSessionId + ':' + message.allocationEpoch;
        const receipt = closures.get(key);
        if (receipt && (await receipt)['receiptId'] === message.receiptId) closures.delete(key);
        break;
      }
      case 'drain': draining = true; break;
      case 'registered': case 'resultAck': break;
    }
    inventory();
  })().catch((error: unknown) => send({ schemaVersion: 1, type: 'rejected', requestId: message.requestId, code: safeCode(error), digest: digest({ requestId: message.requestId, code: safeCode(error) }) }));
});
process.once('disconnect', () => {
  const assignment = supervisor.session?.assignment;
  void (assignment ? supervisor.close(assignment.browserSessionId, assignment.allocationEpoch) : supervisor.fenceDisconnected())
    .finally(() => process.exit(1));
});
inventory();
