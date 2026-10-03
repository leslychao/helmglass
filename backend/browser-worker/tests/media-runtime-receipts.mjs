import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const display = spawn('Xvfb', [':98', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' });
await delay(500);
const workerBootId = randomUUID();
const runtime = fork(new URL('../dist/src/runtime-main.js', import.meta.url), [], {
  env: { ...process.env, DISPLAY: ':98', WORKER_BOOT_ID: workerBootId, STAGING_DIRECTORY: '/runtime/sessions',
    EGRESS_PROXY_URL: 'http://egress-proxy:3128' },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const messages = [];
const pending = new Set();
runtime.on('message', message => {
  messages.push(message);
  for (const listener of pending) listener(message);
});
function receive(predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(listener); reject(new Error('Runtime receipt timed out')); }, 20_000);
    const listener = message => {
      if (message.type === 'fatal' || predicate(message)) {
        pending.delete(listener); clearTimeout(timer);
        if (message.type === 'fatal') reject(new Error(`Runtime failure: ${message.code}`));
        else resolve(message);
      }
    };
    pending.add(listener);
  });
}
async function exchange(message, predicate) {
  const response = receive(predicate);
  runtime.send(message);
  return response;
}
try {
  const assignment = { purpose: 'TASK', taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId,
    instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1,
    originPolicy: 'PUBLIC', allowedOrigins: [], deadline: new Date(Date.now() + 90_000).toISOString(),
    viewport: { width: 1280, height: 720 } };
  const requestId = randomUUID();
  const launch = await exchange({ schemaVersion: 1, type: 'assign', requestId, assignment }, message => message.type === 'launchPermitRequest');
  await exchange({ schemaVersion: 1, type: 'launchPermit', requestId, permit: {
    permitId: randomUUID(), browserSessionId: assignment.browserSessionId, workerBootId, allocationEpoch: 1,
    assignmentDigest: launch.assignmentDigest, deadline: new Date(Date.now() + 20_000).toISOString(),
  } }, message => message.type === 'assigned');

  const close = { schemaVersion: 1, type: 'viewClose', requestId: randomUUID(), workerBootId,
    browserSessionId: assignment.browserSessionId, allocationEpoch: 1, viewerId: randomUUID(), viewGeneration: 1 };
  const first = await exchange(close, message => message.type === 'viewerClosed');
  assert.deepEqual(first, { ...close, type: 'viewerClosed', code: 'VIEW_CLOSED' });
  runtime.send({ type: 'signalingDisconnected' });
  const replay = await exchange({ type: 'signalingConnected' }, message => message.type === 'viewerClosed');
  assert.deepEqual(replay, first);
  runtime.send({ ...close, type: 'viewerClosedAck' });
  await delay(50);
  const count = messages.filter(message => message.type === 'viewerClosed').length;
  runtime.send({ type: 'signalingConnected' });
  await delay(100);
  assert.equal(messages.filter(message => message.type === 'viewerClosed').length, count);
  const late = await exchange(close, message => message.type === 'viewerClosed');
  assert.deepEqual(late, first);
  assert.ok(messages.every(message => message.type !== 'viewCloseAck' && message.type !== 'viewerClosedAckAck'));
  await exchange({ schemaVersion: 1, type: 'close', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
    allocationEpoch: 1 }, message => message.type === 'closed');
  console.log('Real runtime preserves exact viewer close receipts across signaling reconnect and PG acknowledgment');
} finally {
  const runtimeExit = once(runtime, 'exit');
  runtime.kill('SIGTERM');
  await runtimeExit;
  const displayExit = once(display, 'exit');
  display.kill('SIGTERM');
  await displayExit;
}
