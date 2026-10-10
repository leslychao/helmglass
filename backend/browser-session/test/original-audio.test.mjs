import { snapshotText } from './references.mjs';
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
  assert.ok(response.ok, `Worker HTTP ${response.status} on ${method} ${route} (${body?.type ?? ''} ${body?.arguments?.sourceRef ?? ''})`);
  return response.json();
}

async function startBrowser(id, url, epoch) {
  const base = '/sessions/' + id;
  await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: url });
  const deadline = Date.now() + 40_000;
  while ((await request(base)).status !== 'LIVE') {
    assert.ok(Date.now() < deadline, 'Fixture browser must become LIVE');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await request(base + '/control', { controlEpoch: epoch, owner: 'CHATGPT', privateMode: false });
}

test('iframe original audio is discovered and captured in its source frame', { timeout: 90_000 }, async () => {
  const id = randomUUID(); const base = '/sessions/' + id;
  const command = (type, args) => ({ operationId: randomUUID(), type, arguments: args,
    instructionRevision: 0, controlEpoch: 1, observeAfter: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  try {
    await startBrowser(id, new URL('frame-audio.html', fixture).href, 1);
    let originals = [];
    const metadataDeadline = Date.now() + 20_000;
    do {
      const text = snapshotText(await request(base + '/observe'));
      originals = [...text.matchAll(/\{"sizeBytes":.*?\}/g)].map(match => JSON.parse(match[0]));
      if (originals.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < metadataDeadline);
    assert.equal(originals.length, 2, 'Both isolated frames must expose their original metadata');
    const listed = await request(base + '/commands', command('listMedia', {}));
    assert.equal(listed.status, 'SUCCEEDED');
    for (const original of originals) {
      assert.ok(listed.result.sources.some(item => item.url === original.fast),
        'DOM discovery must include the original from each isolated iframe');
      const fast = listed.result.media.find(item => item.sourceUrl === original.fast);
      assert.ok(fast, 'listMedia must discover audio inside each isolated iframe');
      const receipt = await request(base + '/commands', command('captureAudio', {
        sourceId: fast.id, sourceRef: 'isolated-frame-' + fast.id, name: 'iframe.wav' }));
      assert.equal(receipt.status, 'SUCCEEDED', JSON.stringify(receipt));
      const artifact = receipt.result.artifact;
      assert.equal(artifact.complete, true);
      assert.equal(artifact.mimeType, 'audio/wav');
      assert.equal(artifact.sizeBytes, original.sizeBytes);
      assert.equal(artifact.sha256, original.sha256);
      const response = await fetch(worker + base + '/artifacts/' + artifact.id, { headers });
      assert.equal(response.status, 200);
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; hash.update(chunk); }
      assert.equal(bytes, original.sizeBytes);
      assert.equal(hash.digest('hex'), original.sha256);
      const repeated = await request(base + '/commands', command('listMedia', {}));
      assert.equal(repeated.result.media.find(item => item.sourceUrl === original.fast).id, fast.id);
    }
  } finally {
    assert.equal((await request(base, undefined, 'DELETE')).status, 'CLOSED');
    await request(base + '/cleanup', undefined, 'DELETE');
  }
});

test('original Blob bytes, lost-response receipt, deduplication and cancelled transfer cleanup', { timeout: 90_000 }, async () => {
  const id = randomUUID(); const base = '/sessions/' + id; let epoch = 1;
  const command = (type, args) => ({ operationId: randomUUID(), type, arguments: args,
    instructionRevision: 0, controlEpoch: epoch, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  try {
    await startBrowser(id, fixture, epoch);
    let observation;
    const metadataDeadline = Date.now() + 20000;
    do {
      observation = await request(base + '/observe');
      if (snapshotText(observation).includes('"sizeBytes"')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < metadataDeadline);
    const original = JSON.parse(snapshotText(observation).match(/\{"sizeBytes":.*?\}/)[0]);
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
    const cancelled = command('captureAudio', { sourceId: slow.id, sourceRef: cancelledRef });
    const pending = request(base + '/commands', cancelled);
    await new Promise(resolve => setTimeout(resolve, 700)); const started = Date.now();
    await request(base + '/commands/' + cancelled.operationId + '/cancel', {});
    assert.equal((await pending).status, 'FAILED');
    assert.ok(Date.now() - started < 2_000, 'Cancelling the operation must promptly stop the Blob stream');
    epoch += 1; await request(base + '/control', { controlEpoch: epoch, owner: 'NONE', privateMode: false });
    const artifacts = await request(base + '/artifacts');
    assert.equal(artifacts.artifacts.filter(item => item.sourceRef === cancelledRef).length, 0);
    assert.equal(artifacts.artifacts.length, 2, 'Only the two completed original transfers are published');
  } finally {
    assert.equal((await request(base, undefined, 'DELETE')).status, 'CLOSED');
    await request(base + '/cleanup', undefined, 'DELETE');
  }
});
