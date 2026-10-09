import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

// Run against the deployed worker and the explicitly provisioned synthetic fixture.
// This exercises application APIs; it does not provision containers or infrastructure.
const worker = process.env.WORKER_URL;
const fixture = process.env.TEST_FIXTURE_URL;
const token = process.env.WORKER_TOKEN;
assert.ok(worker && fixture && token, 'WORKER_URL, TEST_FIXTURE_URL and WORKER_TOKEN are required');
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET', signal) {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  assert.ok(response.ok, `Worker HTTP ${response.status}`);
  return response.json();
}

test('original Blob bytes, lost-response receipt, deduplication and cancelled transfer cleanup', { timeout: 90_000 }, async () => {
  const id = randomUUID(); const base = '/sessions/' + id; let epoch = 1;
  const command = (type, args) => ({ operationId: randomUUID(), type, arguments: args, instructionRevision: 0, controlEpoch: epoch });
  try {
    assert.equal((await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: fixture })).status, 'LIVE');
    await request(base + '/control', { controlEpoch: epoch, owner: 'CHATGPT', privateMode: false });
    assert.equal((await request(base + '/commands', command('waitFor', {
      selector: 'body[data-ready="true"]',
    }))).status, 'SUCCEEDED', 'Synthetic audio generation must finish before observing its metadata');
    const observation = await request(base + '/observe');
    const original = JSON.parse(observation.text.match(/\{"sizeBytes":.*?\}/)[0]);
    const listed = await request(base + '/commands', command('listMedia', {}));
    const fast = listed.result.media.find(item => item.sourceUrl === original.fast);
    const slow = listed.result.media.find(item => item.sourceUrl === original.slow);
    assert.ok(fast && slow);
    const capture = command('captureAudio', { sourceId: fast.id, sourceRef: 'original-fixture', name: 'original.wav' });
    const receipt = await request(base + '/commands', capture); assert.equal(receipt.status, 'SUCCEEDED');
    const artifact = receipt.result.artifact;
    assert.equal(artifact.sizeBytes, original.sizeBytes); assert.equal(artifact.sha256, original.sha256);
    const response = await fetch(worker + base + '/artifacts/' + artifact.id, { headers });
    assert.equal(response.status, 200); const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; hash.update(chunk); }
    assert.equal(bytes, original.sizeBytes); assert.equal(hash.digest('hex'), original.sha256);
    assert.equal((await request(base + '/commands', command('captureAudio', capture.arguments))).result.artifact.id, artifact.id);

    const uncertain = command('captureAudio', { sourceId: slow.id, sourceRef: 'lost-client-response' });
    await assert.rejects(request(base + '/commands', uncertain, 'POST', AbortSignal.timeout(700)));
    let durable = await request(base + '/commands/' + uncertain.operationId);
    assert.equal(durable.status, 'RUNNING');
    const deadline = Date.now() + 30_000;
    while (durable.status === 'RUNNING' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      durable = await request(base + '/commands/' + uncertain.operationId);
    }
    assert.equal(durable.status, 'SUCCEEDED');
    assert.deepEqual(await request(base + '/commands', uncertain), durable);
    assert.equal(durable.result.artifact.sha256, original.sha256);

    const cancelledRef = 'cancelled-transfer-' + randomUUID();
    const pending = request(base + '/commands', command('captureAudio', { sourceId: slow.id, sourceRef: cancelledRef }));
    await new Promise(resolve => setTimeout(resolve, 700)); const started = Date.now();
    epoch += 1; await request(base + '/control', { controlEpoch: epoch, owner: 'NONE', privateMode: false });
    assert.equal((await pending).status, 'FAILED');
    assert.ok(Date.now() - started < 2_000, 'Revoking control must promptly cancel the Blob stream');
    const artifacts = await request(base + '/artifacts');
    assert.equal(artifacts.artifacts.filter(item => item.sourceRef === cancelledRef).length, 0);
    assert.equal(artifacts.artifacts.length, 2, 'Only the two completed original transfers are published');
  } finally {
    assert.equal((await request(base, undefined, 'DELETE')).status, 'CLOSED');
  }
});
