import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSession } from '../dist/src/session.js';
import { digest } from '../dist/src/protocol.js';

await mkdir('/runtime/fixtures', { recursive: true, mode: 0o700 });
await mkdir('/runtime/pulse', { recursive: true, mode: 0o700 });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/runtime/fixtures/key.pem',
  '-out', '/runtime/fixtures/cert.pem', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=3',
  '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '/runtime/fixtures/tone.wav']);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', '/runtime/fixtures/tone.wav', '-c:a', 'aac', '-hls_time', '1',
  '-hls_list_size', '0', '-hls_segment_filename', '/runtime/fixtures/part-%03d.ts', '/runtime/fixtures/list.m3u8']);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', '/runtime/fixtures/tone.wav', '-c:a', 'aac', '-f', 'dash',
  '-seg_duration', '1', '/runtime/fixtures/stream.mpd']);
const pulse = spawn('pulseaudio', ['--daemonize=no', '--exit-idle-time=-1', '--disallow-exit', '--file=/dev/null',
  '--load=module-native-protocol-unix socket=/runtime/pulse/native', '--load=module-null-sink sink_name=helm_capture rate=48000 channels=2'], { stdio: 'ignore' });
const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
await delay(300);
const windowManager = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
await delay(300);
const source = createServer(async (request, response) => {
  const name = (request.url ?? '').replace(/^\//, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) { response.writeHead(404).end(); return; }
  const bytes = await readFile('/runtime/fixtures/' + name).catch(() => null);
  if (!bytes) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', name.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream');
  response.setHeader('Content-Length', bytes.length); response.end(bytes);
});
await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
const sourcePort = source.address().port;
const proxy = createServer((request, response) => {
  const url = new URL(request.url);
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== sourcePort) { response.writeHead(403).end(); return; }
  const target = net.connect(sourcePort, '127.0.0.1', () => {
    target.write(`${request.method} ${url.pathname} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
  });
  let headers = Buffer.alloc(0); let started = false;
  target.on('data', data => {
    if (started) { response.write(data); return; }
    headers = Buffer.concat([headers, data]); const split = headers.indexOf('\r\n\r\n');
    if (split >= 0) { started = true; response.writeHead(200); response.write(headers.subarray(split + 4)); }
  });
  target.on('end', () => response.end()); target.on('error', () => response.destroy());
});
proxy.on('connect', (request, client, head) => {
  if (request.url !== `127.0.0.1:${sourcePort}`) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const remote = net.connect(sourcePort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); });
  client.on('error', () => remote.destroy()); remote.on('error', () => client.destroy());
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const ca = await readFile('/runtime/fixtures/cert.pem'); const key = await readFile('/runtime/fixtures/key.pem');
let allocation; let artifact; let uploaded = 0;
const artifactId = randomUUID(); const transferId = randomUUID();
const gateway = createTlsServer({ cert: ca, key, ca, requestCert: true, rejectUnauthorized: true }, async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = Buffer.concat(chunks);
  response.setHeader('content-type', 'application/json');
  if (request.url.endsWith('/allocate')) {
    allocation = JSON.parse(bytes.toString()); response.end(JSON.stringify({ artifactId, transferId, transferToken: 'fixture-transfer-token-01234567890123456789' })); return;
  }
  assert.equal(request.headers['x-content-sha256'], createHash('sha256').update(bytes).digest('hex'));
  assert.equal(allocation.sha256, request.headers['x-content-sha256']); assert.equal(allocation.byteLength, bytes.length);
  artifact = bytes; uploaded++; response.end(JSON.stringify({ artifactId, sha256: allocation.sha256, byteLength: bytes.length, state: 'READY' }));
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { WORKER_CONTROL_URL: `wss://localhost:${gateway.address().port}`, WORKER_ID: randomUUID(), WORKER_BOOT_ID: randomUUID(),
  MTLS_CERT_FILE: '/runtime/fixtures/cert.pem', MTLS_KEY_FILE: '/runtime/fixtures/key.pem', MTLS_CA_FILE: '/runtime/fixtures/cert.pem' });
let runtime;
try {
  for (let i = 0; i < 40; i++) {
    try { execFileSync('pactl', ['info'], { stdio: 'ignore' }); break; } catch { await delay(50); }
  }
  const assignment = { purpose: 'TASK', taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: process.env.WORKER_BOOT_ID,
    instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1, originPolicy: 'ALLOWLIST', allowedOrigins: [`http://127.0.0.1:${sourcePort}`],
    deadline: new Date(Date.now() + 90_000).toISOString(), viewport: { width: 1280, height: 720 } };
  runtime = await BrowserSession.create(assignment, { headless: false, display: ':99', proxyServer: `http://127.0.0.1:${proxy.address().port}`,
    stagingDirectory: '/runtime/sessions', mediaBarrier: async () => undefined });
  const page = runtime.context.pages()[0];
  async function command(action) {
    const input = { commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId, browserSessionId: assignment.browserSessionId, action };
    const result = await runtime.execute(input, async () => ({ ...assignment, commandId: input.commandId, attemptId: input.attemptId,
      permitId: randomUUID(), actionDigest: digest(action), deadline: new Date(Date.now() + 30_000).toISOString() }));
    return result;
  }
  async function capture() {
    const observed = await command({ type: 'OBSERVE' }); assert.equal(observed.status, 'SUCCEEDED');
    const media = observed.observation.media[0]; assert.ok(media);
    return command({ type: 'READ_MEDIA', mediaRef: media.mediaRef, observationId: observed.observation.observationId,
      maxBytes: 8_388_608, maxDurationSeconds: 8, coverage: 'FULL' });
  }
  for (const [file, kind] of [['tone.wav', 'FILE'], ['list.m3u8', 'STREAM_SEGMENTS'], ['stream.mpd', 'STREAM_SEGMENTS']]) {
    await page.setContent(`<audio controls src="http://127.0.0.1:${sourcePort}/${file}"></audio>`);
    await delay(200);
    const result = await capture(); assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result));
    assert.equal(result.artifact.sourceKind, kind); assert.equal(result.artifact.coverage, 'FULL');
    assert.ok(result.artifact.durationSeconds > 2.9 && result.artifact.durationSeconds < 3.2);
    console.log('Source bytes captured and mTLS checksum receipt verified:', file, result.artifact.codec, result.artifact.byteLength);
  }
  await page.setContent('<button>Authorize playback</button><audio controls></audio>');
  await page.getByRole('button').click();
  await page.locator('audio').evaluate((audio, base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); audio.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  }, (await readFile('/runtime/fixtures/tone.wav')).toString('base64'));
  await page.locator('audio').evaluate(audio => new Promise(resolve => { if (audio.readyState >= 2) resolve(); else audio.oncanplay = resolve; }));
  const playback = await capture(); assert.equal(playback.status, 'SUCCEEDED', JSON.stringify(playback));
  assert.equal(playback.artifact.sourceKind, 'PLAYBACK_CAPTURE');
  assert.ok(playback.artifact.captureTimeline.length >= 2); assert.ok(playback.artifact.coveredIntervals.at(-1).endSeconds >= 2.9);
  await writeFile('/runtime/fixtures/captured.wav', artifact, { mode: 0o600 });
  const samples = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', '/runtime/fixtures/captured.wav', '-f', 'f32le', '-ac', '1', 'pipe:1']);
  let peak = 0; for (let i = 0; i + 4 <= samples.length; i += 4) peak = Math.max(peak, Math.abs(samples.readFloatLE(i)));
  assert.ok(peak > 0.05 && peak < 0.2, 'Chromium audio is silent or corrupted: ' + peak);
  console.log('Real Chromium → PulseAudio monitor → FFmpeg capture verified:', { peak, uploaded, duration: playback.artifact.durationSeconds, coverage: playback.artifact.coverage });
  await page.locator('audio').evaluate(audio => { audio.pause(); audio.currentTime = 0; audio.loop = true; });
  const abortedCapture = capture();
  await page.waitForFunction(() => !document.querySelector('audio').paused, undefined, { timeout: 5000 });
  await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
    allocationEpoch: assignment.allocationEpoch, controlEpoch: assignment.controlEpoch + 1, pageEpoch: assignment.pageEpoch,
    privacyEpoch: assignment.privacyEpoch + 1, policyVersion: 1, mode: 'HUMAN_PRIVATE', controllerInstance: randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 20_000).toISOString() });
  const aborted = await abortedCapture; assert.notEqual(aborted.status, 'SUCCEEDED'); assert.equal(aborted.artifact, undefined);
  assert.equal(uploaded, 4, 'Private barrier must not publish a partial pending capture');
  const sessionDirectory = (await readdir('/runtime/sessions'))[0];
  assert.ok(!(await readdir('/runtime/sessions/' + sessionDirectory)).some(name => name.startsWith('capture-')));
  console.log('Private-mode barrier cancelled capture and removed every pending media buffer');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await runtime?.close(); pulse.kill(); xvfb.kill(); windowManager.kill(); source.close(); proxy.close(); gateway.close();
  process.exit(process.exitCode ?? 0);
}
