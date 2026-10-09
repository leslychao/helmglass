import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

// Exercise the deployed application lifecycle. Docker is read only here, to
// confirm that the application's CLOSED acknowledgement owns no live resources.
const worker = process.env.WORKER_URL, token = process.env.WORKER_TOKEN, docker = process.env.DOCKER_HOST;
assert.ok(worker && token && docker, 'WORKER_URL, WORKER_TOKEN and DOCKER_HOST are required');
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { code: response.status, value: await response.json() };
}
async function absentResources(id) {
  const name = 'helm-browser-' + id;
  for (const route of ['/containers/' + name + '/json', '/containers/' + name + '-egress/json',
    '/networks/' + name, '/volumes/' + name + '-data']) {
    const response = await fetch(docker + route);
    assert.equal(response.status, 404, 'A CLOSED browser must not retain or recreate ' + route);
    await response.body.cancel();
  }
}

test('STOP during STARTING and concurrent closes never resurrect browser resources after CLOSED', { timeout: 90_000 }, async () => {
  const id = randomUUID(), base = '/sessions/' + id;
  let creation;
  try {
    creation = request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: 'https://httpbin.org/delay/5' });
    const deadline = Date.now() + 10_000;
    let starting = false;
    while (Date.now() < deadline) {
      const listing = await request('/sessions');
      const current = listing.value.sessions.find(item => item.id === id);
      if (current) { assert.equal(current.status, 'STARTING'); starting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(starting, 'The close must race the actual STARTING phase');
    const closed = await Promise.all([request(base, undefined, 'DELETE'), request(base, undefined, 'DELETE')]);
    for (const result of closed) { assert.equal(result.code, 200); assert.equal(result.value.status, 'CLOSED'); }
    await creation;
    assert.equal((await request(base)).value.status, 'CLOSED');
    await absentResources(id);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal((await request(base)).value.status, 'CLOSED');
    await absentResources(id);
    assert.equal((await request(base, undefined, 'DELETE')).value.status, 'CLOSED');
  } finally {
    await creation?.catch(() => {});
    // Explicitly clean up only this synthetic identity even on a failed assertion.
    const result = await request(base, undefined, 'DELETE');
    assert.equal(result.code, 200); assert.equal(result.value.status, 'CLOSED');
  }
});

test('LIVE follows initial navigation and the first observation reads the requested page', { timeout: 90_000 }, async () => {
  const id = randomUUID(), base = '/sessions/' + id;
  const url = 'https://httpbin.org/delay/5';
  let creation;
  try {
    creation = request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: url });
    let current;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await request(base);
      if (response.code === 200 && response.value.status === 'LIVE') { current = response.value; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(current, 'Initial navigation must settle within its bounded request timeout');
    // A GET joining initialization returns the manager's lifecycle summary.
    // Verify the loaded page through the first observation below; URL metadata
    // is not included on every manager response path.
    const control = await request(base + '/control', { controlEpoch: 1, owner: 'CHATGPT', privateMode: false });
    assert.equal(control.code, 200);
    const observation = await request(base + '/commands', {
      operationId: randomUUID(), type: 'observe', arguments: {}, instructionRevision: 0, controlEpoch: 1,
    });
    assert.equal(observation.code, 200);
    assert.equal(observation.value.status, 'SUCCEEDED');
    assert.equal(observation.value.result.url, url);
    assert.match(observation.value.result.text, /httpbin\.org\/delay\/5/);
    assert.equal((await creation).value.status, 'LIVE');
  } finally {
    await creation?.catch(() => {});
    const closed = await request(base, undefined, 'DELETE');
    assert.equal(closed.code, 200); assert.equal(closed.value.status, 'CLOSED');
  }
});

test('Failed initial navigation keeps a usable browser with an explicit error instead of remaining STARTING', { timeout: 90_000 }, async () => {
  const id = randomUUID(), base = '/sessions/' + id;
  try {
    const created = await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: 'https://127.0.0.1/' });
    assert.equal(created.code, 200); assert.equal(created.value.status, 'LIVE');
    const current = await request(base);
    assert.equal(current.value.status, 'LIVE');
    assert.equal(current.value.navigationError, 'Initial navigation failed; the browser remains open');
    assert.equal((await request(base + '/control', { controlEpoch: 1, owner: 'CHATGPT', privateMode: false })).code, 200);
    const observation = await request(base + '/commands', {
      operationId: randomUUID(), type: 'observe', arguments: {}, instructionRevision: 0, controlEpoch: 1,
    });
    assert.equal(observation.code, 200); assert.equal(observation.value.status, 'SUCCEEDED');
  } finally {
    const closed = await request(base, undefined, 'DELETE');
    assert.equal(closed.code, 200); assert.equal(closed.value.status, 'CLOSED');
  }
});
