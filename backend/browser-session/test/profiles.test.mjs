import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const worker = process.env.WORKER_URL, fixture = process.env.TEST_FIXTURE_URL, token = process.env.WORKER_TOKEN;
assert.ok(worker && fixture && token, 'WORKER_URL, TEST_FIXTURE_URL and WORKER_TOKEN are required');
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, value: await response.json() };
}
test('bounded saved profiles retain structured IDB and reject oversize without replacing prior identity', { timeout: 90_000 }, async () => {
  const owner = randomUUID(), id = randomUUID(), base = '/sessions/' + id, profileA = randomUUID(), profileB = randomUUID();
  async function command(type, args) {
    const response = await request(base + '/commands', { operationId: randomUUID(), type, arguments: args, instructionRevision: 0, controlEpoch: 1 });
    assert.equal(response.status, 200); assert.equal(response.value.status, 'SUCCEEDED'); return response.value.result;
  }
  async function waitForText(text) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await request(base + '/observe');
      if (response.value.text.includes(text)) return response.value.text;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Fixture storage operation did not complete');
  }
  const save = profile => request(base + '/profile/export', { connectionId: profile, ownerId: owner, origins: [new URL(fixture).origin] });
  async function apply(profile, expected) {
    await command('applyConnection', { connectionId: profile, ownerId: owner, origins: [new URL(fixture).origin], url: fixture });
    await command('click', { selector: '#profile-read' });
    const text = await waitForText('"complex":true');
    assert.ok(text.includes('"local":"' + expected + '"'));
    assert.ok(text.includes('"indexed":"' + expected + '"'));
    assert.ok(text.includes('helm_acceptance=' + expected));
  }
  try {
    assert.equal((await request('/sessions', { sessionId: id, ownerId: owner, startUrl: fixture })).value.status, 'LIVE');
    await request(base + '/control', { controlEpoch: 1, owner: 'CHATGPT', privateMode: false });
    for (const [value, profile] of [['a', profileA], ['b', profileB]]) {
      await command('click', { selector: '#profile-' + value }); await waitForText('"complex":true');
      assert.equal((await save(profile)).status, 200);
    }
    await apply(profileA, 'a'); await apply(profileB, 'b'); await apply(profileA, 'a');
    for (const type of ['oversize', 'unsupported']) {
      await command('click', { selector: '#profile-' + type }); await waitForText('Stored ' + type);
      assert.equal((await save(profileA)).status, type === 'oversize' ? 413 : 422,
        'Size limits and unsupported values must remain distinct without replacing the saved profile');
      await apply(profileA, 'a');
    }
    assert.equal((await request(base + '/profile/export', { connectionId: profileA, ownerId: randomUUID(), origins: [new URL(fixture).origin] })).status, 403);
  } finally {
    for (const profile of [profileA, profileB]) await request('/profiles/' + profile, undefined, 'DELETE');
    assert.equal((await request(base, undefined, 'DELETE')).value.status, 'CLOSED');
  }
});
