import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { MediaSession } from '../src/media-session.js';
import type { Assignment, ViewOpen } from '../src/protocol.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(context: TestContext) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 8443 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'welcome', peerId: randomUUID() }));
  });
  context.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const assignment: Assignment = {
    purpose: 'TASK', taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(),
    workerBootId: randomUUID(), instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1,
    pageEpoch: 1, privacyEpoch: 1, policyVersion: 1, originPolicy: 'PUBLIC', allowedOrigins: [],
    deadline: new Date(Date.now() + 60_000).toISOString(), viewport: { width: 1280, height: 720 },
  };
  const closed: string[] = [];
  let stops = 0;
  let revocations = 0;
  let starts = 0;
  let failures = 0;
  const helper = {
    onStop: async (): Promise<void> => undefined,
    onStart: async (): Promise<void> => undefined,
    onRevoke: async (): Promise<unknown> => ({ type: 'revokeAck' }),
    async stop() { stops++; await this.onStop(); },
    async request(type: string): Promise<unknown> {
      switch (type) {
        case 'capabilities': return { encoder: 'openh264enc', fallbackReason: 'NONE', gstreamerVersion: 'test' };
        case 'discover': return { windows: [{ xid: 1, pid: 42, x: 0, y: 0, width: 1280, height: 720 }] };
        case 'captureStatus': return { sequence: 1, ageMs: 0 };
        case 'start': starts++; await this.onStart(); return {};
        case 'revoke': revocations++; return this.onRevoke();
        default: return {};
      }
    },
  };
  const media = new MediaSession(() => ({ assignment, captureBinding: async () => ({ pid: 42, width: 1280, height: 720 }) }),
    () => undefined, (id) => closed.push(id), { helper, onFailure: () => { failures++; } });
  const binding = (): ViewOpen => ({
    schemaVersion: 1, type: 'viewOpen', requestId: randomUUID(), viewerId: randomUUID(),
    browserSessionId: assignment.browserSessionId, allocationEpoch: 1, controlEpoch: 1,
    pageEpoch: 1, privacyEpoch: 1, mediaGeneration: 1, viewGeneration: 1, surface: 'WEB',
    leaseExpiresAt: new Date(Date.now() + 4500).toISOString(),
    iceServers: [{ urls: ['turn:coturn:3478?transport=tcp'], username: 'fixture', credential: 'fixture' }],
    producerIceServer: { urls: ['turn:coturn:3478?transport=tcp'], username: 'fixture', credential: 'fixture' },
    mediaProxy: { url: 'http://egress-proxy:3128', username: 'fixture', password: 'fixture-'.repeat(4) },
  });
  return { media, helper, closed, binding, stops: () => stops, revocations: () => revocations,
    starts: () => starts, failures: () => failures };
}

test('all-viewer privacy barrier emits no closure until the native stop is confirmed', async (context) => {
  const value = await fixture(context);
  const first = value.binding();
  const second = value.binding();
  await value.media.accept(first);
  await value.media.accept(second);
  const stopped = Promise.withResolvers<void>();
  value.helper.onStop = () => stopped.promise;
  const closing = value.media.closeAll();
  await tick();
  assert.deepEqual(value.closed, []);
  stopped.resolve();
  await closing;
  assert.deepEqual(value.closed.sort(), [first.viewerId, second.viewerId].sort());
  await tick();
  assert.equal(value.closed.length, 2);
});

test('a failed global teardown cannot acknowledge closure or admit another viewer', async (context) => {
  const value = await fixture(context);
  await value.media.accept(value.binding());
  value.helper.onStop = async () => { throw new Error('native stop failed'); };
  await assert.rejects(value.media.closeAll());
  assert.equal(value.failures(), 1);
  assert.deepEqual(value.closed, []);
  await assert.rejects(value.media.accept(value.binding()));
  await assert.rejects(value.media.closeAll());
});

test('concurrent close requests share native revocation and wait for its acknowledgment', async (context) => {
  const value = await fixture(context);
  const first = value.binding();
  const survivor = value.binding();
  await value.media.accept(first);
  await value.media.accept(survivor);
  const revoked = Promise.withResolvers<unknown>();
  value.helper.onRevoke = () => revoked.promise;
  const command = { schemaVersion: 1 as const, type: 'viewClose' as const, requestId: randomUUID(), viewerId: first.viewerId };
  const closing = value.media.accept(command);
  let duplicateFinished = false;
  const duplicate = value.media.accept(command).then(() => { duplicateFinished = true; });
  await tick();
  assert.deepEqual(value.closed, []);
  assert.equal(duplicateFinished, false);
  assert.equal(value.revocations(), 1);
  revoked.resolve({ type: 'revokeAck' });
  await Promise.all([closing, duplicate]);
  assert.deepEqual(value.closed, [first.viewerId]);
  assert.equal(value.stops(), 0, 'Closing one consumer must preserve the other consumer');
  await value.media.closeAll();
});

for (const outcome of ['rejected', 'wrong response'] as const) {
  test(`a ${outcome} native revoke never produces viewerClosed`, async (context) => {
    const value = await fixture(context);
    const first = value.binding();
    await value.media.accept(first);
    value.helper.onRevoke = async () => {
      if (outcome === 'rejected') throw new Error('native revoke failed');
      return { type: 'leaseAck' };
    };
    await assert.rejects(value.media.accept({ schemaVersion: 1, type: 'viewClose', requestId: randomUUID(), viewerId: first.viewerId }));
    assert.deepEqual(value.closed, []);
    await assert.rejects(value.media.closeAll());
    await assert.rejects(value.media.accept(value.binding()));
  });
}

test('privacy fence waits for an already dispatched native start before stopping it', async (context) => {
  const value = await fixture(context);
  const starting = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  value.helper.onStart = async () => { starting.resolve(); await started.promise; };
  const binding = value.binding();
  const opening = assert.rejects(value.media.accept(binding), /VIEW_REVOKED/);
  await starting.promise;
  const closing = value.media.closeAll();
  await tick();
  assert.equal(value.stops(), 0);
  assert.deepEqual(value.closed, []);
  started.resolve();
  await Promise.all([opening, closing]);
  assert.equal(value.stops(), 1);
  assert.deepEqual(value.closed, [binding.viewerId]);
  await value.media.accept(value.binding());
  await value.media.closeAll();
});

test('the last consumer stop finishes before a new consumer starts', async (context) => {
  const value = await fixture(context);
  const binding = value.binding();
  await value.media.accept(binding);
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  value.helper.onStop = async () => { stopping.resolve(); await stopped.promise; };
  const closing = value.media.accept({ schemaVersion: 1, type: 'viewClose', requestId: randomUUID(), viewerId: binding.viewerId });
  await stopping.promise;
  const opening = value.media.accept(value.binding());
  await tick();
  assert.equal(value.starts(), 1);
  assert.deepEqual(value.closed, []);
  stopped.resolve();
  await Promise.all([closing, opening]);
  assert.equal(value.starts(), 2);
  assert.deepEqual(value.closed, [binding.viewerId]);
  await value.media.closeAll();
});

test('a privacy fence cancels an opening queued before it without waiting on itself', { timeout: 1000 }, async (context) => {
  const value = await fixture(context);
  const opening = assert.rejects(value.media.accept(value.binding()), /VIEW_REVOKED/);
  await Promise.all([opening, value.media.closeAll()]);
  assert.equal(value.starts(), 0);
  assert.equal(value.stops(), 1);
  assert.deepEqual(value.closed, []);
});
