import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const workerBootId = randomUUID();
const runtime = fork(new URL('../dist/src/runtime-main.js', import.meta.url), [], {
  env: { ...process.env, WORKER_BOOT_ID: workerBootId, STAGING_DIRECTORY: '/runtime/sessions',
    EGRESS_PROXY_URL: 'http://egress-proxy:3128' },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const requestId = randomUUID();
const viewerId = randomUUID();
const messages = [];
const response = Promise.withResolvers();
const deadline = setTimeout(() => response.reject(new Error('Media rejection was not received')), 25_000);
runtime.on('message', (message) => {
  messages.push(message);
  if (message.requestId === requestId) response.resolve(message);
  if (message.type === 'fatal') response.reject(new Error(`Unexpected runtime failure: ${message.code}`));
});
try {
  runtime.send({ schemaVersion: 1, type: 'viewOpen', requestId, viewerId, workerBootId, browserSessionId: randomUUID(),
    allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, mediaGeneration: 1,
    viewGeneration: 1, surface: 'WEB', leaseExpiresAt: new Date(Date.now() + 4500).toISOString(),
    iceServers: [{ urls: ['turn:coturn:3478?transport=tcp'], username: 'fixture', credential: 'fixture' }],
    producerIceServer: { urls: ['turn:coturn:3478?transport=tcp'], username: 'fixture', credential: 'fixture' },
    mediaProxy: { url: 'http://egress-proxy:3128', username: 'fixture', password: 'fixture-'.repeat(4) } });
  const rejected = await response.promise;
  assert.equal(rejected.type, 'viewerMessage');
  assert.equal(rejected.viewerId, viewerId);
  assert.deepEqual(rejected.payload, { type: 'error', details: 'SESSION_NOT_FOUND' });
  await delay(50);
  assert.ok(messages.every(message => message.type !== 'viewerClosed'));
  console.log('Real runtime media rejection does not claim physical viewer closure');
} finally {
  clearTimeout(deadline);
  const exited = once(runtime, 'exit');
  runtime.kill('SIGTERM');
  await exited;
}
