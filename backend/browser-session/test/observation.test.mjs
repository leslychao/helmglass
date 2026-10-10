import { target, snapshotText } from './references.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const worker = process.env.WORKER_URL, fixture = process.env.TEST_FIXTURE_URL, token = process.env.WORKER_TOKEN;
assert.ok(worker && fixture && token, 'WORKER_URL, TEST_FIXTURE_URL and WORKER_TOKEN are required');
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  assert.equal(response.status, 200); return response.json();
}
test('site-controlled observation fields are bounded and oversized URLs are never capture targets', { timeout: 40_000 }, async () => {
  const id = randomUUID(), base = '/sessions/' + id;
  try {
    assert.equal((await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: fixture })).status, 'LIVE');
    await request(base + '/control', { controlEpoch: 1, owner: 'CHATGPT', privateMode: false });
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const observation = await request(base + '/commands', { operationId: randomUUID(), type: 'observe', arguments: {}, instructionRevision: 0, controlEpoch: 1, deadlineAt });
    const media = await request(base + '/commands', { operationId: randomUUID(), type: 'listMedia', arguments: {}, instructionRevision: 0, controlEpoch: 1, deadlineAt });
    assert.equal(media.status, 'SUCCEEDED');
    if (observation.status === 'SUCCEEDED') {
      assert.ok(Buffer.byteLength(JSON.stringify(observation.result)) <= 32768);
      assert.ok(observation.result.snapshot.length <= 200);
    } else {
      assert.equal(observation.status, 'FAILED', 'An oversized native capture fails closed');
      assert.equal(observation.result, undefined);
    }
    assert.equal(media.result.truncated, true);
    assert.ok(media.result.sources.length > 0);
    assert.ok(media.result.sources.every(source => source.label.length <= 2000 && source.url.length <= 8192));
    assert.deepEqual(media.result.media.map(source => source.sourceUrl), ['https://example.com/known-original.mp3']);
    assert.equal(media.result.sources.find(source => source.url.startsWith('https://example.com/source')), undefined);
  } finally { assert.equal((await request(base, undefined, 'DELETE')).status, 'CLOSED'); }
});

// Serve fixtures/private-input.html through the existing dev public frontend and
// select this test by name. The synthetic values are not real account credentials.
test('sensitive input rejected before effect is FAILED and does not block later input', { timeout: 40_000 }, async () => {
  const id = randomUUID(), base = '/sessions/' + id;
  const action = (type, args) => ({ operationId: randomUUID(), type, arguments: args, instructionRevision: 0, controlEpoch: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  const command = input => request(base + '/commands', input);
  try {
    assert.equal((await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: fixture })).status, 'LIVE');
    await request(base + '/control', { controlEpoch: 1, owner: 'CHATGPT', privateMode: false });
    for (const name of ['Current password', 'New password', 'One-time code']) {
      const reference = await target(request, base, name);
      for (const input of [action('fill', { ...reference, text: 'synthetic-rejected-value' })]) {
        const receipt = await command(input);
        assert.equal(receipt.status, 'FAILED');
        assert.equal(receipt.error, 'Private input requires the user');
        assert.deepEqual(await command(input), receipt);
      }
    }
    assert.equal((await command(action('click', await target(request, base, 'Focus private code')))).status, 'SUCCEEDED');
    const key = action('press', { key: 'a' });
    const refused = await command(key);
    assert.equal(refused.status, 'FAILED');
    assert.equal(refused.error, 'Private input requires the user');
    assert.deepEqual(await command(key), refused);
    assert.equal((await command(action('fill', { ...await target(request, base, 'Ordinary text'), text: 'allowed-after-refusal' }))).status, 'SUCCEEDED');
    assert.equal((await command(action('click', { ...await target(request, base, 'Read synthetic state') }))).status, 'SUCCEEDED');
    const observation = await request(base + '/observe');
    assert.ok(snapshotText(observation).includes('"sensitiveValues":["","","",""]'));
    assert.ok(snapshotText(observation).includes('"sensitiveEvents":0'));
    assert.ok(snapshotText(observation).includes('"plain":"allowed-after-refusal"'));
  } finally { assert.equal((await request(base, undefined, 'DELETE')).status, 'CLOSED'); }
});
