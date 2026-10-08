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
    const observation = await request(base + '/observe');
    const media = await request(base + '/commands', { operationId: randomUUID(), type: 'listMedia', arguments: {}, instructionRevision: 0, controlEpoch: 1 });
    assert.equal(media.status, 'SUCCEEDED');
    const field = observation.elements.find(item => item.tag === 'input');
    const link = observation.elements.find(item => item.tag === 'a');
    assert.ok(field && link);
    assert.equal(observation.truncated, true);
    assert.ok(observation.title.length <= 1000);
    assert.ok(field.label.length <= 2000);
    for (const attribute of ['id', 'name', 'type']) assert.equal(field[attribute], undefined);
    assert.equal(link.href, undefined);
    assert.equal(observation.url, undefined);
    assert.equal(observation.tabs[0].url, undefined);
    assert.ok(JSON.stringify(observation).length < 10_000);
    assert.equal(media.result.truncated, true);
    assert.ok(media.result.sources.length > 0);
    assert.ok(media.result.sources.every(source => source.label.length <= 2000 && source.url.length <= 8192));
    assert.deepEqual(media.result.media.map(source => source.sourceUrl), ['https://example.com/known-original.mp3']);
    assert.equal(media.result.sources.find(source => source.url.startsWith('https://example.com/source')), undefined);
  } finally { assert.equal((await request(base, undefined, 'DELETE')).status, 'CLOSED'); }
});
