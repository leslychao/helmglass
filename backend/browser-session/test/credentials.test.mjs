import { target, snapshotText } from './references.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const worker = process.env.WORKER_URL;
const token = process.env.WORKER_TOKEN;
const fixture = process.env.TEST_CREDENTIAL_FIXTURE_URL;
assert.ok(worker && token && fixture, 'WORKER_URL, WORKER_TOKEN and TEST_CREDENTIAL_FIXTURE_URL required');

test('private credentials fill only the saved HTTPS origin and never enter observations', { timeout: 90_000 }, async () => {
  const owner = randomUUID(), connection = randomUUID(), viewer = randomUUID(), sessions = [];
  let id = randomUUID(), base = '/sessions/' + id; sessions.push(id);
  async function request(path, value, method = 'POST') {
    const response = await fetch(worker + path, { method, headers: { 'X-Worker-Token': token, 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, value: await response.json() };
  }
  const control = (epoch, privateMode) => request(base + '/control', {
    controlEpoch: epoch, owner: privateMode ? 'USER' : 'CHATGPT', privateMode,
    ...(privateMode ? { controllerId: viewer } : {}),
  });
  const credentials = (action, extra = {}) => request(base + '/credentials', {
    action, ownerId: owner, connectionId: connection, viewerId: viewer, ...extra,
  });
  const command = (type, args, epoch) => request(base + '/commands', {
    operationId: randomUUID(), instructionRevision: 0, controlEpoch: epoch, type, arguments: args,
  });
  try {
    // This fixture starts with an existing encrypted login; native capture is verified
    // separately through a trusted private browser form submission.
    const { CredentialStore } = await import(pathToFileURL(path.join(process.cwd(), 'dist/credentials.js')));
    const db = new DatabaseSync(path.join(process.env.DATA_DIR ?? '/data', 'node.sqlite'));
    const write = { origin: new URL(fixture).origin, username: 'helm-credential-test', password: 'synthetic-not-a-secret' };
    try { new CredentialStore(db, Buffer.from(process.env.PROFILE_ENCRYPTION_KEY, 'base64'))
      .write(connection, owner, randomUUID(), 0, write); } finally { db.close(); }
    assert.equal((await request('/sessions', { sessionId: id, ownerId: owner, startUrl: fixture,
      connectionId: connection, restoreProfile: false })).value.status, 'LIVE');
    assert.equal((await control(1, true)).status, 200);
    const meta = await credentials('STATUS');
    assert.equal(meta.value.available, true);
    assert.equal(meta.value.captureEnabled, false);
    assert.equal((await credentials('WRITE', write)).status, 400);
    assert.equal((await request(base + '/observe', undefined, 'GET')).status, 423);
    assert.equal((await credentials('STATUS', { viewerId: randomUUID() })).status, 403);
    assert.equal((await control(2, false)).status, 200);
    assert.equal((await command('click', { ...await target(request, base, 'Check synthetic credentials') }, 2)).value.status, 'SUCCEEDED');
    const observed = await request(base + '/observe', undefined, 'GET');
    assert.ok(snapshotText(observed.value).includes('Expected synthetic credentials'));
    assert.equal(JSON.stringify(observed.value).includes(write.password), false);
    let epoch = 2;
    for (const [mode, expected] of [['readonly-other', 'No matching credentials'], ['password-only', 'No matching credentials'], ['readonly-same', 'Expected synthetic credentials']]) {
      const url = new URL(fixture); url.searchParams.set('mode', mode);
      url.searchParams.set('access_token', 'synthetic-url-secret'); url.hash = 'synthetic-fragment-secret';
      assert.equal((await command('navigate', { url: url.href }, epoch)).value.status, 'SUCCEEDED');
      assert.equal((await control(++epoch, true)).status, 200);
      assert.equal((await control(++epoch, false)).status, 200);
      assert.equal((await command('click', { ...await target(request, base, 'Check synthetic credentials') }, epoch)).value.status, 'SUCCEEDED');
      const result = await request(base + '/observe', undefined, 'GET');
      assert.ok(snapshotText(result.value).includes(expected));
      assert.equal(JSON.stringify(result.value).includes('synthetic-url-secret'), false);
      assert.equal(JSON.stringify(result.value).includes('synthetic-fragment-secret'), false);
      assert.equal(JSON.stringify(result.value).includes(write.password), false);
    }
    assert.equal((await request(base, undefined, 'DELETE')).value.status, 'CLOSED');
    id = randomUUID(); sessions.push(id); base = '/sessions/' + id;
    assert.equal((await request('/sessions', { sessionId: id, ownerId: owner, startUrl: fixture,
      connectionId: connection, restoreProfile: false })).value.status, 'LIVE');
    assert.equal((await control(1, true)).status, 200);
    assert.equal((await control(2, false)).status, 200);
    assert.equal((await command('click', { ...await target(request, base, 'Check synthetic credentials') }, 2)).value.status, 'SUCCEEDED');
    assert.ok(snapshotText((await request(base + '/observe', undefined, 'GET')).value).includes('Expected synthetic credentials'),
      'An expired connection must arm saved credentials without restoring its old profile');
    assert.equal((await control(3, true)).status, 200);
    assert.equal((await credentials('DELETE', { operationId: randomUUID(), expectedRevision: 1 })).value.available, false);
  } finally {
    for (const session of sessions) await request('/sessions/' + session, undefined, 'DELETE');
    await request('/profiles/' + connection, undefined, 'DELETE');
  }
});
