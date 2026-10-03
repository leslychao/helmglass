import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeMediaHelper } from '../dist/src/media-helper.js';
import { BrowserSession } from '../dist/src/session.js';

const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'inherit' });
const signaller = spawn('gst-webrtc-signalling-server', ['--host', '127.0.0.1', '--port', '8443'], { stdio: 'ignore' });
await delay(500);
const windowManager = spawn('openbox', ['--sm-disable'], { stdio: 'ignore' });
await delay(500);
const helper = new NativeMediaHelper(() => undefined);
let session;
try {
  const capabilities = await helper.request('capabilities');
  assert.equal(capabilities.encoder, 'openh264enc');
  console.log('H264 encode/decode smoke:', capabilities);
  const assignment = { purpose: 'TASK', taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(),
    workerBootId: randomUUID(), instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1,
    privacyEpoch: 1, policyVersion: 1, originPolicy: 'PUBLIC', allowedOrigins: [],
    deadline: new Date(Date.now() + 60000).toISOString(), viewport: { width: 1280, height: 720 } };
  session = await BrowserSession.create(assignment, { headless: false, display: ':99', stagingDirectory: '/runtime/sessions', mediaBarrier: () => helper.stop() });
  const surface = await session.captureBinding({ ...assignment, surface: 'WEB' });
  const discovered = await helper.request('discover');
  const matching = discovered.windows.filter((window) => window.pid === surface.pid && window.width === surface.width && window.height === surface.height);
  assert.equal(matching.length, 1, JSON.stringify(discovered));
  await helper.request('start', { ...matching[0], generation: 1, peerId: 'lease-test', durationMs: 1500, turnServers: [] });
  await delay(300);
  const active = await helper.request('captureStatus');
  assert.ok(active.sequence > 0 && active.ageMs >= 0 && active.ageMs < 500, JSON.stringify(active));
  await delay(1500);
  const expired = await helper.request('captureStatus');
  assert.equal(expired.ageMs, -1);
  console.log('Real Chromium surface capture and native lease-expiry teardown passed');
  await helper.stop();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await session?.close();
  signaller.kill(); windowManager.kill(); xvfb.kill();
  await helper.shutdown();
}
