import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// Run inside the existing dev manager against the original-audio application
// fixture. Only the two identities created below are read and closed.
const worker = process.env.WORKER_URL, token = process.env.WORKER_TOKEN;
const fixture = process.env.TEST_FIXTURE_URL, publicUrl = process.env.PUBLIC_URL;
assert.ok(worker && token && fixture && publicUrl);
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { code: response.status, value: await response.json() };
}

test('same-origin renderer storage and artifacts stay isolated; internal archives require their exact token', { timeout: 60000 }, async () => {
  const a = randomUUID(), b = randomUUID(), created = [];
  async function command(id, type, args = {}) {
    const response = await request(`/sessions/${id}/commands`, { operationId: randomUUID(), type,
      arguments: args, instructionRevision: 0, controlEpoch: 1 });
    assert.equal(response.code, 200); assert.equal(response.value.status, 'SUCCEEDED');
    return response.value.result;
  }
  async function identity(id, expected) {
    await command(id, 'click', { selector: '#profile-read' });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const observation = await request(`/sessions/${id}/observe`);
      assert.equal(observation.code, 200);
      if (observation.value.text.includes('"local":' + JSON.stringify(expected))) {
        if (expected === null) {
          assert.ok(observation.value.text.includes('"cookie":""'));
          assert.ok(!observation.value.text.includes('"indexed":'));
        } else {
          assert.ok(observation.value.text.includes('"indexed":"' + expected + '"'));
          assert.ok(observation.value.text.includes('helm_acceptance=' + expected));
          assert.ok(observation.value.text.includes('"complex":true'));
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Renderer storage did not match its own identity');
  }
  async function status(url, credential) {
    const response = await fetch(url, { headers: credential === undefined ? {} : { 'X-Worker-Token': credential } });
    await response.body?.cancel(); return response.status;
  }
  try {
    for (const id of [a, b]) {
      created.push(id);
      const session = await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: fixture });
      assert.equal(session.code, 200); assert.equal(session.value.status, 'LIVE');
      assert.equal((await request(`/sessions/${id}/control`, { controlEpoch: 1, owner: 'CHATGPT', privateMode: false })).code, 200);
    }
    await command(a, 'click', { selector: '#profile-a' }); await identity(a, 'a');
    await identity(b, null);
    await command(b, 'click', { selector: '#profile-b' }); await identity(b, 'b');
    await command(a, 'reload'); await identity(a, 'a');
    const artifact = (await command(a, 'screenshot')).artifact;
    assert.ok(artifact.id); assert.equal(artifact.complete, true);
    assert.equal((await request(`/sessions/${b}/artifacts/${artifact.id}`)).code, 404);

    const store = new DatabaseSync(path.join(process.env.DATA_DIR ?? '/data', 'node.sqlite'), { readOnly: true });
    let ownA, ownB;
    try {
      ownA = JSON.parse(store.prepare('SELECT document FROM sessions WHERE id=?').get(a).document);
      ownB = JSON.parse(store.prepare('SELECT document FROM sessions WHERE id=?').get(b).document);
    } finally { store.close(); }
    assert.equal((await request(`/sessions/${a}/control`, { controlEpoch: 2, owner: 'NONE', privateMode: true })).code, 200);
    const direct = `http://${ownA.address}:8080`;
    for (const endpoint of ['/health', '/observe', '/artifacts?archive=true', `/artifacts/${artifact.id}?archive=true`]) {
      for (const credential of [undefined, token, ownB.token]) {
        assert.equal(await status(direct + endpoint, credential), 401, 'A session rejects absent, manager, and neighbor credentials');
      }
    }
    assert.equal(await status(direct + '/health', ownA.token), 200);
    assert.equal(await status(direct + '/observe', ownA.token), 423);
    assert.equal(await status(direct + '/artifacts?archive=true', ownA.token), 200);
    assert.equal(await status(direct + `/artifacts/${artifact.id}?archive=true`, ownA.token), 200);
    for (const endpoint of ['/health', `/sessions/${a}/observe`, `/sessions/${a}/artifacts?archive=true`]) {
      for (const credential of [undefined, ownA.token]) assert.equal(await status(worker + endpoint, credential), 401);
    }
    assert.equal(await status(`${publicUrl}/browser/sessions/${a}/artifacts?archive=true`), 404);
  } finally {
    for (const id of created) assert.equal((await request('/sessions/' + id, undefined, 'DELETE')).value.status, 'CLOSED');
  }
});
