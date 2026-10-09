import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { bridgeViewer } from '../dist/viewer-bridge.js';

async function fixture(t, clientAutoPong = true, browserAutoPong = true) {
  const backend = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: browserAutoPong });
  const frontend = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([once(backend, 'listening'), once(frontend, 'listening')]);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const browserConnected = once(backend, 'connection');
  const clientConnected = once(frontend, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${frontend.address().port}`, { autoPong: clientAutoPong });
  const [front] = await clientConnected;
  const upstream = new WebSocket(`ws://127.0.0.1:${backend.address().port}`);
  const reports = [];
  const bridge = bridgeViewer(front, upstream, event => reports.push(event));
  const [browser] = await browserConnected;
  if (upstream.readyState !== WebSocket.OPEN) await once(upstream, 'open');
  if (client.readyState !== WebSocket.OPEN) await once(client, 'open');
  t.after(async () => {
    bridge.close('session_closed'); client.terminate(); browser.terminate();
    await Promise.all([new Promise(resolve => backend.close(resolve)), new Promise(resolve => frontend.close(resolve))]);
  });
  return { client, front, upstream, browser, bridge, reports };
}

test('native heartbeat keeps idle links alive without changing RFB bytes; cleanup runs once', async t => {
  const f = await fixture(t);
  const messages = [];
  f.client.on('message', data => messages.push(data));
  f.browser.on('message', data => messages.push(data));
  for (let index = 0; index < 15; index++) {
    const pongs = Promise.all([once(f.front, 'pong'), once(f.upstream, 'pong')]);
    t.mock.timers.tick(20_000);
    await pongs;
    assert.equal(f.client.readyState, WebSocket.OPEN);
    assert.equal(f.browser.readyState, WebSocket.OPEN);
    assert.deepEqual(f.reports, []);
  }
  assert.deepEqual(messages, [], 'Control frames must not enter the VNC data stream');
  const input = Buffer.from([0, 3, 255, 4]);
  const received = once(f.browser, 'message'); f.client.send(input);
  assert.deepEqual((await received)[0], input);
  const output = Buffer.from('RFB 003.008\n');
  const rendered = once(f.client, 'message'); f.browser.send(output);
  assert.deepEqual((await rendered)[0], output);
  f.bridge.close('control_changed');
  f.bridge.close('viewer_replaced');
  t.mock.timers.tick(60_000);
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].reason, 'control_changed');
  assert.equal(f.reports[0].side, 'server');
});

test('missing client pong closes only the bridge and ignores a stale pong', async t => {
  const f = await fixture(t, false);
  const probes = Promise.all([once(f.client, 'ping'), once(f.upstream, 'pong')]);
  t.mock.timers.tick(20_000); await probes;
  const stale = once(f.front, 'pong'); f.client.pong('not-the-probe'); await stale;
  t.mock.timers.tick(9_999); assert.equal(f.reports.length, 0);
  const closed = Promise.all([once(f.client, 'close'), once(f.browser, 'close')]);
  t.mock.timers.tick(1); await closed;
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].reason, 'heartbeat_timeout');
  assert.equal(f.reports[0].side, 'client');
});

test('missing browser pong is diagnosed separately from the viewer connection', async t => {
  const f = await fixture(t, true, false);
  const probes = Promise.all([once(f.front, 'pong'), once(f.browser, 'ping')]);
  t.mock.timers.tick(20_000); await probes;
  const closed = once(f.client, 'close');
  t.mock.timers.tick(10_000); await closed;
  assert.equal(f.reports[0].reason, 'heartbeat_timeout');
  assert.equal(f.reports[0].side, 'browser');
});

test('ordinary socket closure records the endpoint and code without its untrusted reason', async t => {
  const f = await fixture(t);
  const closed = once(f.client, 'close');
  f.client.close(1000, 'private-text-must-not-be-logged'); await closed;
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].reason, 'socket_closed');
  assert.equal(f.reports[0].side, 'client');
  assert.equal(f.reports[0].closeCode, 1000);
  assert.equal(JSON.stringify(f.reports).includes('private-text'), false);
});
