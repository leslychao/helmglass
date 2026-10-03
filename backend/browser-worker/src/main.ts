import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { apiMessageSchema, signalingMessageSchema } from './protocol.js';

const config = z.object({
  WORKER_CONTROL_URL: z.url(), WORKER_ID: z.uuid(), WORKER_BOOT_ID: z.uuid(),
  MTLS_CERT_FILE: z.string().min(1), MTLS_KEY_FILE: z.string().min(1), MTLS_CA_FILE: z.string().min(1),
  EGRESS_PROXY_URL: z.url(), STAGING_DIRECTORY: z.string().default('/run/helm-worker'),
  WORKER_IMAGE_DIGEST: z.string().min(1), HEALTH_PORT: z.coerce.number().int().default(8081),
}).parse(process.env);
if (new URL(config.WORKER_CONTROL_URL).protocol !== 'wss:') throw new Error('Worker control requires mTLS WSS.');
const bootId = config.WORKER_BOOT_ID;
const workerId = config.WORKER_ID;
const runtime = fork(fileURLToPath(new URL('./runtime-main.js', import.meta.url)), [], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, WORKER_BOOT_ID: bootId, STAGING_DIRECTORY: config.STAGING_DIRECTORY },
});
let lastRuntimeHeartbeat = performance.now();
let inventory: unknown = null;
let capabilities: unknown = { encoder: null, captureState: 'STREAM_UNAVAILABLE' };
let draining = false;
let registered = false;
let stopped = false;
let socket: WebSocket | undefined;
let signalingSocket: WebSocket | undefined;
let signalingReconnect: NodeJS.Timeout | undefined;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
const unacknowledged = new Map<string, unknown>();
const unacknowledgedClosures = new Map<string, unknown>();
let snapshotRequest: { requestId: string; connection: WebSocket; timer: NodeJS.Timeout } | undefined;
const reportSchema = z.object({ type: z.string(), result: z.object({ attemptId: z.uuid(), digest: z.string() }).optional(),
  receiptId: z.uuid().optional(), browserSessionId: z.uuid().optional(), allocationEpoch: z.number().int().nonnegative().optional() });
function safeLog(event: string, code?: string): void {
  process.stdout.write(JSON.stringify({ level: code ? 'error' : 'info', event, workerId, bootId, ...(code ? { code } : {}) }) + '\n');
}
function send(value: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    if (socket.bufferedAmount > 1_048_576) { socket.close(4503, 'BACKPRESSURE'); return; }
    socket.send(JSON.stringify(value));
  }
}
runtime.on('message', (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) return;
  if (raw.type === 'runtimeHeartbeat') {
    lastRuntimeHeartbeat = performance.now();
    inventory = 'inventory' in raw ? raw.inventory : null;
    draining = 'draining' in raw && raw.draining === true;
    capabilities = 'capabilities' in raw ? raw.capabilities : capabilities;
    return;
  }
  if (raw.type === 'runtimeSnapshot' && 'requestId' in raw && snapshotRequest && snapshotRequest.requestId === raw.requestId) {
    const pending = snapshotRequest; snapshotRequest = undefined; clearTimeout(pending.timer);
    if (pending.connection !== socket || pending.connection.readyState !== WebSocket.OPEN) return;
    inventory = 'inventory' in raw ? raw.inventory : null;
    draining = 'draining' in raw && raw.draining === true;
    capabilities = 'capabilities' in raw ? raw.capabilities : capabilities;
    send({ schemaVersion: 1, type: 'register', requestId: randomUUID(), workerId, bootId, protocolVersion: 1,
      version: '0.1.0', imageDigest: config.WORKER_IMAGE_DIGEST, capacity: 1,
      inventory: inventory ? [inventory] : [], state: draining ? 'DRAINING' : 'READY', capabilities });
    return;
  }
  if (raw.type === 'fatal') { safeLog('runtime_fenced', 'RUNTIME_FATAL'); process.exit(1); }
  if (raw.type === 'viewerMessage' || raw.type === 'viewerClosed' || raw.type === 'viewerEnded'
    || (typeof raw.type === 'string' && /^(viewOpen|viewRenew|signal)Ack$/.test(raw.type))) {
    if (signalingSocket?.readyState === WebSocket.OPEN && signalingSocket.bufferedAmount <= 1_048_576) signalingSocket.send(JSON.stringify(raw));
    else runtime.send({ type: 'signalingDisconnected' });
    return;
  }
  const report = reportSchema.safeParse(raw);
  if (!report.success) { safeLog('runtime_message_rejected', 'PROTOCOL_MISMATCH'); return; }
  if (report.data.type === 'commandResult' && report.data.result) {
    if (unacknowledged.size >= 256) { safeLog('result_buffer_exhausted', 'ACK_BACKPRESSURE'); process.exit(1); }
    unacknowledged.set(report.data.result.attemptId, raw);
  }
  if (report.data.type === 'closed' && report.data.receiptId) {
    if (unacknowledgedClosures.size >= 256) { safeLog('closure_buffer_exhausted', 'ACK_BACKPRESSURE'); process.exit(1); }
    unacknowledgedClosures.set(report.data.receiptId, raw);
  }
  send(raw);
});
runtime.once('exit', (code) => { safeLog('runtime_exited', code === 0 ? undefined : 'RUNTIME_CRASH'); process.exit(1); });

async function connect(): Promise<void> {
  if (stopped) return;
  const [cert, key, ca] = await Promise.all([readFile(config.MTLS_CERT_FILE), readFile(config.MTLS_KEY_FILE), readFile(config.MTLS_CA_FILE)]);
  const connection = new WebSocket(config.WORKER_CONTROL_URL, { cert, key, ca, rejectUnauthorized: true,
    handshakeTimeout: 10_000, maxPayload: 1_048_576, perMessageDeflate: false,
    headers: { 'x-worker-id': workerId, 'x-worker-boot-id': bootId } });
  socket = connection;
  connection.once('open', () => {
    reconnectAttempt = 0;
    const requestId = randomUUID();
    snapshotRequest = { requestId, connection, timer: setTimeout(() => connection.close(4503, 'RUNTIME_SNAPSHOT_TIMEOUT'), 35_000) };
    runtime.send({ type: 'snapshotRequest', requestId });
  });
  connection.on('message', (data) => {
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString()); } catch { connection.close(4400, 'INVALID_JSON'); return; }
    const decoded = apiMessageSchema.safeParse(parsed);
    if (!decoded.success) { connection.close(4400, 'PROTOCOL_MISMATCH'); return; }
    const message = decoded.data;
    if (message.type === 'registered') {
      if (message.bootId !== bootId || message.workerId !== workerId) { connection.close(4403, 'IDENTITY_MISMATCH'); return; }
      registered = true;
      void connectSignaling().catch(() => process.exit(1));
      for (const result of unacknowledged.values()) send(result);
      for (const receipt of unacknowledgedClosures.values()) send(receipt);
    }
    if (message.type === 'resultAck') {
      const stored = unacknowledged.get(message.attemptId);
      const report = reportSchema.safeParse(stored);
      if (!report.success || report.data.result?.digest !== message.digest) { connection.close(4409, 'RESULT_DIGEST_MISMATCH'); return; }
      unacknowledged.delete(message.attemptId);
    }
    if (message.type === 'closedAck') {
      const stored = reportSchema.safeParse(unacknowledgedClosures.get(message.receiptId));
      if (stored.success && (stored.data.browserSessionId !== message.browserSessionId || stored.data.allocationEpoch !== message.allocationEpoch)) {
        connection.close(4409, 'CLOSURE_BINDING_MISMATCH'); return;
      }
      unacknowledgedClosures.delete(message.receiptId);
    }
    if (message.type !== 'registered' && !registered) { connection.close(4403, 'REGISTRATION_REQUIRED'); return; }
    runtime.send(message);
  });
  connection.on('error', () => safeLog('control_transport_failure', 'CONTROL_UNAVAILABLE'));
  connection.once('close', () => {
    if (snapshotRequest?.connection === connection) { clearTimeout(snapshotRequest.timer); snapshotRequest = undefined; }
    registered = false; runtime.send({ type: 'tunnelDisconnected' });
    signalingSocket?.close(1000, 'CONTROL_CHANNEL_LOST'); clearTimeout(signalingReconnect);
    if (!stopped) reconnectTimer = setTimeout(() => void connect().catch(() => process.exit(1)), Math.min(30_000, 500 * 2 ** Math.min(++reconnectAttempt, 6)) * (0.8 + Math.random() * 0.4));
  });
}
async function connectSignaling(): Promise<void> {
  if (stopped || !registered || signalingSocket?.readyState === WebSocket.OPEN || signalingSocket?.readyState === WebSocket.CONNECTING) return;
  const [cert, key, ca] = await Promise.all([readFile(config.MTLS_CERT_FILE), readFile(config.MTLS_KEY_FILE), readFile(config.MTLS_CA_FILE)]);
  const endpoint = new URL(config.WORKER_CONTROL_URL); endpoint.pathname = '/internal/worker/signaling'; endpoint.search = '';
  const connection = new WebSocket(endpoint, { cert, key, ca, rejectUnauthorized: true, maxPayload: 1_048_576,
    perMessageDeflate: false, handshakeTimeout: 10_000, headers: { 'x-worker-id': workerId, 'x-worker-boot-id': bootId } });
  signalingSocket = connection;
  connection.on('open', () => runtime.send({ type: 'signalingConnected' }));
  connection.on('message', (data) => {
    try {
      const message = signalingMessageSchema.parse(JSON.parse(data.toString()));
      runtime.send(message);
    } catch { connection.close(4400, 'SIGNALING_PROTOCOL_MISMATCH'); }
  });
  connection.on('error', () => safeLog('signaling_transport_failure', 'SIGNALING_UNAVAILABLE'));
  connection.once('close', () => {
    runtime.send({ type: 'signalingDisconnected' });
    if (!stopped && registered) signalingReconnect = setTimeout(() => void connectSignaling().catch(() => process.exit(1)), 1000);
  });
}
setInterval(() => {
  if (performance.now() - lastRuntimeHeartbeat > 15_000) {
    // Exit the container rather than ACK a cleanup we cannot prove for a hung process.
    safeLog('watchdog_expired', 'RUNTIME_UNRESPONSIVE'); process.exit(1);
  }
  if (registered) send({ schemaVersion: 1, type: 'heartbeat', requestId: randomUUID(), workerId, bootId,
    state: draining ? 'DRAINING' : 'READY', usedSlots: inventory ? 1 : 0, activeSessions: inventory ? [inventory] : [], capabilities });
}, 5000).unref();
createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404).end(); return; }
  response.writeHead(registered ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: registered ? 'UP' : 'REGISTERING', workerId, bootId, draining }));
}).listen(config.HEALTH_PORT, '0.0.0.0');
process.once('SIGTERM', () => {
  stopped = true; clearTimeout(reconnectTimer); clearTimeout(signalingReconnect); signalingSocket?.close(1000, 'SHUTDOWN'); socket?.close(1000, 'SHUTDOWN'); runtime.disconnect();
  setTimeout(() => process.exit(1), 10_000).unref();
});
process.on('SIGHUP', () => socket?.close(1000, 'IDENTITY_RENEWED'));
await connect();
