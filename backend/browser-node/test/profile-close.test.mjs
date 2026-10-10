import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const worker = process.env.WORKER_URL, token = process.env.WORKER_TOKEN;
assert.ok(worker && token, 'WORKER_URL and WORKER_TOKEN are required');
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, value: await response.json() };
}

test('revoking control settles a running command before saving the final profile', { timeout: 60000 }, async () => {
  const owner = randomUUID(), profile = randomUUID(), id = randomUUID();
  const base = '/sessions/' + id;
  const operationId = randomUUID();
  let command;
  try {
    const created = await request('/sessions', { sessionId: id, ownerId: owner,
      startUrl: 'https://example.com' });
    assert.equal(created.value.status, 'LIVE');
    assert.equal((await request(base + '/control', {
      controlEpoch: 1, owner: 'CHATGPT', privateMode: false,
    })).status, 200);
    command = request(base + '/commands', { operationId, type: 'waitFor',
      arguments: { time: 2 }, instructionRevision: 0, controlEpoch: 1,
      deadlineAt: new Date(Date.now() + 30000).toISOString(), observeAfter: false });
    const deadline = Date.now() + 5000;
    let receipt;
    do {
      receipt = await request(base + '/commands/' + operationId);
      if (receipt.value.status === 'RUNNING') break;
      assert.ok(Date.now() < deadline, 'The command must start before revoking control');
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);

    assert.equal((await request(base + '/control', { controlEpoch: 2, owner: 'USER',
      controllerId: randomUUID(), privateMode: false })).status, 409,
      'A running command must still prevent a new controller');
    const revoked = await request(base + '/control', {
      controlEpoch: 2, owner: 'NONE', privateMode: false,
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.value));
    assert.equal(revoked.value.controlOwner, 'NONE');
    assert.equal((await command).value.status, 'FAILED', 'Revocation must cancel the read');
    assert.equal((await request(base + '/commands/' + operationId)).value.status, 'FAILED');

    const saved = await request(base + '/profile/export', { connectionId: profile,
      ownerId: owner, origins: ['https://example.com'], operationId: id + ':close' });
    assert.equal(saved.status, 200, JSON.stringify(saved.value));
    assert.equal(saved.value.saved, true);
    assert.equal(saved.value.revision, 1);
    const closed = await request(base, undefined, 'DELETE');
    assert.equal(closed.value.status, 'CLOSED');
    assert.equal(closed.value.profileSaveError ?? null, null);
  } finally {
    assert.equal((await request(base, undefined, 'DELETE')).value.status, 'CLOSED');
    await command;
    assert.equal((await request(base + '/cleanup', undefined, 'DELETE')).status, 200);
    assert.equal((await request('/profiles/' + profile, undefined, 'DELETE')).status, 200);
  }
});
