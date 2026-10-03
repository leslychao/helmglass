import { execFile, spawn } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { enrollmentRequestSchema, enrollmentResponseSchema } from './enrollment.js';

const run = promisify(execFile);
const bootstrapSchema = z.strictObject({ schemaVersion: z.literal(1),
  installationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), enrollmentToken: z.string().min(32).max(512),
  caPem: z.string().min(100).max(65_536),
});
async function readBootstrap(): Promise<z.infer<typeof bootstrapSchema>> {
  try {
    const handle = await open(process.env.BOOTSTRAP_FILE ?? '/run/secrets/worker_identity', 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 131_072) throw new Error('INVALID_BOOTSTRAP_SIZE');
      const encoded = await handle.readFile();
      try { return bootstrapSchema.parse(JSON.parse(encoded.toString('utf8'))); }
      finally { encoded.fill(0); }
    } finally { await handle.close(); }
  } catch { throw new Error('INVALID_WORKER_BOOTSTRAP'); }
}
const bootstrap = await readBootstrap();
const control = new URL(z.url().parse(process.env.WORKER_CONTROL_URL));
if (control.protocol !== 'wss:') throw new Error('WORKER_CONTROL_URL must use wss');
const endpoint = new URL('https://' + control.host + '/internal/worker/enroll');
const workerId = randomUUID();
const bootId = randomUUID();
const directory = '/runtime/mtls';
await mkdir(directory, { recursive: true, mode: 0o700 });
const keyFile = directory + '/key.pem';
const csrFile = directory + '/identity.csr';
const certFile = directory + '/cert.pem';
const caFile = directory + '/ca.pem';
await run('openssl', ['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-keyout', keyFile,
  '-out', csrFile, '-subj', '/CN=browser-worker-' + workerId], { maxBuffer: 4096 });
const key = await readFile(keyFile);
const csrPem = await readFile(csrFile, 'utf8');
const body = Buffer.from(JSON.stringify(enrollmentRequestSchema.parse({ schemaVersion: 1,
  installationId: bootstrap.installationId, workerId, bootId, capacity: 1,
  enrollmentToken: bootstrap.enrollmentToken, csrPem })));
let certificate: Buffer | undefined;
let expiresAt = 0;

async function enroll(): Promise<void> {
  const result = await new Promise<unknown>((resolve, reject) => {
    const req = request(endpoint, { method: 'POST', ca: bootstrap.caPem,
      ...(certificate ? { cert: certificate, key } : {}), rejectUnauthorized: true,
      headers: { 'content-type': 'application/json', 'content-length': body.length,
        'x-worker-id': workerId, 'x-worker-boot-id': bootId }, timeout: 10_000 }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 131_072) response.destroy(new Error('ENROLLMENT_RESPONSE_LIMIT'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('ENROLLMENT_REJECTED')); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('ENROLLMENT_INVALID_RESPONSE')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('ENROLLMENT_TIMEOUT')));
    req.on('error', reject); req.end(body);
  });
  const identity = enrollmentResponseSchema.parse(result);
  if (identity.workerId !== workerId || identity.bootId !== bootId) throw new Error('ENROLLMENT_IDENTITY_MISMATCH');
  const parsed = new X509Certificate(identity.certificatePem);
  const publicKey = await run('openssl', ['pkey', '-in', keyFile, '-pubout'], { maxBuffer: 8192 });
  if (parsed.publicKey.export({ type: 'spki', format: 'pem' }).toString() !== publicKey.stdout) throw new Error('ENROLLMENT_KEY_MISMATCH');
  expiresAt = Math.min(Date.parse(identity.expiresAt), Date.parse(parsed.validTo));
  if (expiresAt <= Date.now() + 120_000) throw new Error('ENROLLMENT_CERTIFICATE_EXPIRED');
  // Renewal keeps trusting the bootstrap CA, so send the issued intermediates explicitly.
  const chain = Buffer.from(identity.certificatePem + '\n' + identity.caPem);
  await writeFile(certFile + '.new', chain, { mode: 0o600 });
  await rename(certFile + '.new', certFile);
  await writeFile(caFile, identity.caPem, { mode: 0o600 });
  certificate = chain;
}

// Response loss may retry the identical CSR; the API owns enrollment idempotency.
for (let attempt = 0; ; attempt++) {
  try { await enroll(); break; }
  catch { if (attempt >= 4) throw new Error('ENROLLMENT_UNAVAILABLE'); await delay(Math.min(8000, 500 * 2 ** attempt)); }
}
Object.assign(process.env, { WORKER_ID: workerId, WORKER_BOOT_ID: bootId,
  MTLS_CERT_FILE: certFile, MTLS_KEY_FILE: keyFile, MTLS_CA_FILE: caFile });

function auxiliary(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: 'ignore' });
  child.once('error', () => process.exit(1));
  child.once('exit', () => process.exit(1));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
}
async function waitSocket(path: string | number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = typeof path === 'number' ? connect(path, '127.0.0.1') : connect(path);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error('RUNTIME_AUXILIARY_UNAVAILABLE');
}
auxiliary('Xvfb', [':99', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-noreset']);
auxiliary('pulseaudio', ['--daemonize=no', '--exit-idle-time=-1', '--disallow-exit', '--file=/dev/null',
  '--load=module-native-protocol-unix socket=/runtime/pulse/native',
  '--load=module-null-sink sink_name=helm_capture sink_properties=device.description=HelmCapture']);
auxiliary('gst-webrtc-signalling-server', ['--host', '127.0.0.1', '--port', '8443']);
await Promise.all([waitSocket('/tmp/.X11-unix/X99'), waitSocket('/runtime/pulse/native'), waitSocket(8443)]);
auxiliary('openbox', ['--sm-disable']);
let windowManagerReady = false;
for (let attempt = 0; attempt < 50; attempt++) {
  const status = await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { maxBuffer: 1024 });
  if (/window id # 0x[1-9a-f][0-9a-f]*/i.test(status.stdout)) { windowManagerReady = true; break; }
  await delay(100);
}
if (!windowManagerReady) throw new Error('WINDOW_MANAGER_UNAVAILABLE');
await import('./main.js');
async function renew(): Promise<void> {
  let retryDelay = 30_000;
  try { await enroll(); process.emit('SIGHUP'); retryDelay = expiresAt - Date.now() - 90_000; }
  catch { if (Date.now() >= expiresAt - 15_000) process.exit(1); }
  setTimeout(() => void renew(), Math.max(1000, retryDelay)).unref();
}
setTimeout(() => void renew(), Math.max(1000, expiresAt - Date.now() - 90_000)).unref();
