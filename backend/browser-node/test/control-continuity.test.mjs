import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';

// TEST_SESSION_ID must identify a dedicated test-owned session showing the
// browser-lifecycle fixture. Its creator remains responsible for final cleanup.
const worker = process.env.WORKER_URL, token = process.env.WORKER_TOKEN;
const id = process.env.TEST_SESSION_ID, origin = process.env.PUBLIC_URL;
assert.ok(worker && token && id && origin);
const base = '/sessions/' + id;
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { code: response.status, value: await response.json() };
}

test('concurrent public/private takeovers are exclusive; ticket expiry and reconnect retain the browser page', { timeout: 30_000 }, async () => {
  const viewers = [], first = randomUUID(), a = randomUUID(), b = randomUUID();
  let epoch = 1;
  const policy = (viewer, privateMode = false) => ({ controlEpoch: epoch, owner: 'USER', controllerId: viewer, privateMode });
  async function ticket(viewer, role = 'CONTROLLER', seconds = 60) {
    const value = { ticket: randomBytes(32).toString('base64url'), viewerId: viewer, role,
      expiresAt: new Date(Date.now() + seconds * 1000).toISOString(), access: { channel: 'WEB', grantId: 'test-' + viewer } };
    const result = await request(base + '/ticket', value);
    return { ...result, value };
  }
  async function connect(viewer, role = 'CONTROLLER', seconds = 60) {
    const grant = await ticket(viewer, role, seconds); assert.equal(grant.code, 200);
    const socket = new WebSocket(worker.replace(/^http/, 'ws') + base + '/view?ticket=' + grant.value.ticket,
      { headers: { Origin: origin } });
    viewers.push(socket);
    const [greeting] = await once(socket, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(greeting.toString(), 'RFB 003.008\n');
    return socket;
  }
  async function race(privateMode) {
    const results = await Promise.all([request(base + '/control', policy(a, privateMode)), request(base + '/control', policy(b, privateMode))]);
    assert.deepEqual(results.map(value => value.code).sort(), [200, 409]);
    const winner = results[0].code === 200 ? a : b, loser = winner === a ? b : a;
    const denied = await ticket(loser); assert.equal(denied.code, privateMode ? 423 : 403);
    return winner;
  }
  try {
    assert.equal((await request(base + '/control', { controlEpoch: epoch, owner: 'CHATGPT', privateMode: false })).code, 200);
    const marker = 'continuity-' + randomUUID();
    const filled = await request(base + '/commands', { operationId: randomUUID(), type: 'fill',
      arguments: { selector: '#marker', text: marker }, instructionRevision: 0, controlEpoch: epoch });
    assert.equal(filled.value.status, 'SUCCEEDED');
    epoch += 1; assert.equal((await request(base + '/control', policy(first))).code, 200);
    const old = await connect(first);
    const oldClosed = once(old, 'close', { signal: AbortSignal.timeout(5000) });
    epoch += 1; const winner = await race(false); await oldClosed;
    const controller = await connect(winner);
    const controllerClosed = once(controller, 'close', { signal: AbortSignal.timeout(5000) });
    epoch += 1; assert.equal((await request(base + '/control', policy(winner, true))).code, 200); await controllerClosed;
    const privateController = await connect(winner);
    const privateClosed = once(privateController, 'close', { signal: AbortSignal.timeout(5000) });
    epoch += 1; const privateWinner = await race(true); await privateClosed;
    assert.equal((await request(base)).value.privateMode, true);
    assert.equal((await ticket(privateWinner)).code, 200);
    epoch += 1; assert.equal((await request(base + '/control', { controlEpoch: epoch, owner: 'CHATGPT', privateMode: false })).code, 200);
    const viewer = await connect(first, 'VIEWER', 2);
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(viewer.readyState, WebSocket.OPEN, 'An established view outlives its one-use ticket');
    const closed = once(viewer, 'close'); viewer.close(); await closed;
    const reconnected = await connect(first, 'VIEWER'); assert.equal(reconnected.readyState, WebSocket.OPEN);
    const after = await request(base + '/observe'); assert.equal(after.code, 200);
    assert.ok(after.value.text.includes(marker), 'Viewer reconnect must preserve unsaved page state');
    assert.equal((await request(base)).value.status, 'LIVE');
  } finally { for (const viewer of viewers) viewer.terminate(); }
});
