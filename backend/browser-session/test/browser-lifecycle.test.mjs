import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

const worker = process.env.WORKER_URL, fixture = process.env.TEST_FIXTURE_URL, token = process.env.WORKER_TOKEN;
assert.ok(worker && fixture && token, 'WORKER_URL, TEST_FIXTURE_URL and WORKER_TOKEN are required');
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET', signal) {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  assert.equal(response.status, 200); return response.json();
}
test('safe external POST lost response never replays; private mode cancels an unfinished native download', { timeout: 120_000 }, async () => {
  const id = randomUUID(), base = '/sessions/' + id; let epoch = 1;
  const action = (type, args) => ({ operationId: randomUUID(), type, arguments: args, instructionRevision: 0, controlEpoch: epoch });
  async function command(type, args) {
    const receipt = await request(base + '/commands', action(type, args)); assert.equal(receipt.status, 'SUCCEEDED'); return receipt.result;
  }
  try {
    assert.equal((await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: fixture })).status, 'LIVE');
    await request(base + '/control', { controlEpoch: epoch, owner: 'CHATGPT', privateMode: false });
    const marker = 'helm-safe-post-' + randomUUID(); await command('fill', { selector: '#message', text: marker });
    const submitted = action('click', { selector: '#submit' });
    await assert.rejects(request(base + '/commands', submitted, 'POST', AbortSignal.timeout(250)));
    let receipt = await request(base + '/commands/' + submitted.operationId);
    const deadline = Date.now() + 30_000;
    while (receipt.status === 'RUNNING' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      receipt = await request(base + '/commands/' + submitted.operationId);
    }
    assert.equal(receipt.status, 'SUCCEEDED');
    assert.ok((await request(base + '/observe')).text.includes(marker), 'Real public POST endpoint must echo the unique test message');
    assert.deepEqual(await request(base + '/commands', submitted), receipt);
    await command('navigate', { url: fixture });
    assert.ok((await request(base + '/observe')).text.includes('Submissions: 1'));

    const source = 'https://httpbin.org/drip?duration=12&numbytes=256&code=200&delay=0';
    const baseline = action('navigate', { url: source + '&case=complete' });
    assert.equal((await request(base + '/commands', baseline)).status, 'UNKNOWN');
    let artifacts = await request(base + '/artifacts'); const downloadDeadline = Date.now() + 35_000;
    while (artifacts.artifacts.length === 0 && Date.now() < downloadDeadline) {
      await new Promise(resolve => setTimeout(resolve, 500)); artifacts = await request(base + '/artifacts');
    }
    assert.equal(artifacts.artifacts.length, 1); const original = artifacts.artifacts[0];
    assert.equal(original.complete, true); assert.equal(original.sizeBytes, 256);
    assert.equal(original.sha256, createHash('sha256').update(Buffer.alloc(256, '*')).digest('hex'));
    await request(base + '/commands/' + baseline.operationId + '/resolve', { outcome: 'SUCCEEDED', evidence: 'The completed public drip download has the expected original byte count and hash' });
    const cancelled = action('navigate', { url: source + '&case=private-cancel' });
    assert.equal((await request(base + '/commands', cancelled)).status, 'UNKNOWN');
    assert.equal((await request(base + '/artifacts')).artifacts.length, 1);
    epoch += 1; await request(base + '/control', { controlEpoch: epoch, owner: 'USER', controllerId: randomUUID(), privateMode: true });
    for (const route of ['/observe', '/artifacts', '/artifacts/' + original.id]) {
      const hidden = await fetch(worker + base + route, { headers });
      assert.equal(hidden.status, 423); await hidden.body.cancel();
    }
    const archived = await request(base + '/artifacts?archive=true');
    assert.equal(archived.artifacts.length, 1); assert.equal(archived.artifacts[0].id, original.id);
    const archivedStream = await fetch(worker + base + '/artifacts/' + original.id + '?archive=true', { headers });
    assert.equal(archivedStream.status, 200);
    const archivedHash = createHash('sha256'); let archivedBytes = 0;
    for await (const chunk of archivedStream.body) { archivedBytes += chunk.length; archivedHash.update(chunk); }
    assert.equal(archivedBytes, original.sizeBytes); assert.equal(archivedHash.digest('hex'), original.sha256);
    // Keep the same Chromium alive beyond the source's complete streaming duration.
    await new Promise(resolve => setTimeout(resolve, 16_000));
    epoch += 1; await request(base + '/control', { controlEpoch: epoch, owner: 'NONE', privateMode: false });
    assert.equal((await request(base)).status, 'LIVE');
    artifacts = await request(base + '/artifacts'); assert.equal(artifacts.artifacts.length, 1);
    assert.equal(artifacts.artifacts[0].id, original.id);
  } finally { assert.equal((await request(base, undefined, 'DELETE')).status, 'CLOSED'); }
});
