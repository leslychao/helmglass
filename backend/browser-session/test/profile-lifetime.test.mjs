import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ConnectionStore } from '../dist/connection-store.js';
import { Vault } from '../dist/vault.js';

const worker = process.env.WORKER_URL, fixture = process.env.TEST_FIXTURE_URL, token = process.env.WORKER_TOKEN;
assert.ok(worker && fixture && token, 'WORKER_URL, TEST_FIXTURE_URL and WORKER_TOKEN are required');
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, value: await response.json() };
}

test('explicit save owns profile updates and failed export cannot block close', { timeout: 180_000 }, async () => {
  const owner = randomUUID(), profile = randomUUID(), sessions = [];
  let session;
  async function create(restore = false) {
    session = randomUUID(); sessions.push(session);
    const created = await request('/sessions', { sessionId: session, ownerId: owner,
      startUrl: fixture, ...(restore ? { connectionId: profile } : {}) });
    assert.equal(created.value.status, 'LIVE');
    assert.equal((await request('/sessions/' + session + '/control', {
      controlEpoch: 1, owner: 'CHATGPT', privateMode: false })).status, 200);
  }
  async function command(type, arguments_ = {}) {
    const result = await request('/sessions/' + session + '/commands', { operationId: randomUUID(),
      type, arguments: arguments_, instructionRevision: 0, controlEpoch: 1 });
    assert.equal(result.value.status, 'SUCCEEDED'); return result.value.result;
  }
  try {
    await create();
    await command('click', { selector: '#account-a' });
    const save = () => request('/sessions/' + session + '/profile/export', {
      connectionId: profile, ownerId: owner, origins: [new URL(fixture).origin] });
    const first = await save();
    assert.equal(first.status, 200); assert.equal(first.value.revision, 1);
    assert.equal((await save()).value.revision, first.value.revision,
      'Unchanged storage must not create another profile revision');
    await command('click', { selector: '#account-b' });
    await command('click', { selector: '#short-login' });
    assert.equal((await save()).status, 200);
    assert.equal((await request('/sessions/' + session, undefined, 'DELETE')).value.status, 'CLOSED');
    await create(true);
    await command('click', { selector: '#read-state' });
    assert.ok((await command('observe')).text.includes('"account":"b"'),
      'Explicit save must retain the changed account');
    await command('click', { selector: '#logout' });
    assert.equal((await save()).status, 200);
    assert.equal((await request('/sessions/' + session, undefined, 'DELETE')).value.status, 'CLOSED');
    await create(true);
    await command('click', { selector: '#read-state' });
    assert.ok((await command('observe')).text.includes('"session":"login-required"'),
      'Explicitly saving logout must replace the previously saved login');
    await command('click', { selector: '#ordinary-storage' });
    assert.equal((await save()).status, 200, 'A 2 MiB ASCII site cache is retained');
    await command('click', { selector: '#large-storage' });
    assert.equal((await save()).status, 200, 'A serialized 12 MiB cache is saved without approximate overhead');
    assert.equal((await request('/sessions/' + session, undefined, 'DELETE')).value.status, 'CLOSED');
    await create(true);
    await command('click', { selector: '#read-state' });
    assert.ok((await command('observe')).text.includes('"cacheLength":2097152'));
    await command('click', { selector: '#account-a' });
    await command('click', { selector: '#oversize-record' });
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await command('observe')).text.includes('Stored oversize')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const rejected = await save();
    assert.equal(rejected.status, 413, 'An individual record above 16 MiB is rejected without truncation');
    assert.equal(rejected.value.code, 'PROFILE_RECORD_TOO_LARGE');
    const closed = await request('/sessions/' + session, undefined, 'DELETE');
    assert.equal(closed.status, 200);
    assert.equal(closed.value.status, 'CLOSED', 'A failed save must not prevent closing');
    assert.equal(closed.value.profileSaveError, 'PROFILE_RECORD_TOO_LARGE');
    await create(true);
    await command('click', { selector: '#read-state' });
    assert.ok((await command('observe')).text.includes('"account":"b"'),
      'Closing must preserve the last successful save, not replace it with later unsaved state');
  } finally {
    for (const id of sessions) await request('/sessions/' + id, undefined, 'DELETE');
    await request('/profiles/' + profile, undefined, 'DELETE');
  }
});

test('saved profile does not renew expired site login or restore forms; redirects retain selected account', { timeout: 90_000 }, async () => {
  const owner = randomUUID(), profileA = randomUUID(), profileB = randomUUID();
  const origin = new URL(fixture).origin;
  const redirect = new URL(fixture); redirect.protocol = 'http:';
  const sessions = [];
  let session;
  async function create(profile) {
    session = randomUUID(); sessions.push(session);
    const result = await request('/sessions', { sessionId: session, ownerId: owner, startUrl: fixture,
      ...(profile ? { connectionId: profile } : {}) });
    assert.equal(result.status, 200); assert.equal(result.value.status, 'LIVE');
    assert.equal((await request('/sessions/' + session + '/control', {
      controlEpoch: 1, owner: 'CHATGPT', privateMode: false })).status, 200);
  }
  async function command(type, arguments_ = {}) {
    const result = await request('/sessions/' + session + '/commands', { operationId: randomUUID(), type,
      arguments: arguments_, instructionRevision: 0, controlEpoch: 1 });
    assert.equal(result.status, 200); assert.equal(result.value.status, 'SUCCEEDED');
    return result.value.result;
  }
  async function state(expected) {
    await command('click', { selector: '#read-state' });
    const observed = await command('observe');
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(observed.text.includes(JSON.stringify(key) + ':' + JSON.stringify(value)),
        'The restored page must expose the expected ' + key);
    }
  }
  async function save(profile) {
    assert.equal((await request('/sessions/' + session + '/profile/export', {
      connectionId: profile, ownerId: owner, origins: [origin] })).status, 200);
  }
  try {
    await create();
    await command('click', { selector: '#account-a' });
    await command('click', { selector: '#short-login' });
    const expiresAfter = Date.now() + 9000;
    await command('fill', { selector: '#draft', text: 'unsaved private form value' });
    await state({ account: 'a', localAccount: 'a', session: 'authenticated', draft: 'unsaved private form value' });
    await save(profileA);
    assert.equal((await request('/sessions/' + session, undefined, 'DELETE')).value.status, 'CLOSED');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAfter - Date.now())));
    await create(profileA);
    await state({ account: 'a', localAccount: 'a', session: 'login-required', draft: '' });

    await command('click', { selector: '#account-b' });
    await save(profileB);
    for (const [profile, account] of [[profileA, 'a'], [profileB, 'b'], [profileA, 'a']]) {
      await command('applyConnection', { connectionId: profile, ownerId: owner, origins: [origin], url: fixture });
      const navigated = await command('navigate', { url: redirect.href });
      assert.equal(navigated.url, fixture, 'The actual HTTP redirect must return to the HTTPS fixture');
      await state({ account, localAccount: account, session: 'login-required', draft: '' });
    }
  } finally {
    for (const id of sessions) assert.equal((await request('/sessions/' + id, undefined, 'DELETE')).value.status, 'CLOSED');
    for (const profile of [profileA, profileB]) assert.equal((await request('/profiles/' + profile, undefined, 'DELETE')).status, 200);
  }
});

test('saved host-only cookies and local storage stay isolated from a similar hostname', { timeout: 90_000 }, async () => {
  const response = await fetch(fixture);
  assert.equal(response.status, 200);
  const markup = await response.text();
  assert.ok(markup.length < 8192 && markup.includes('helm_fixture_account'));
  const content = Buffer.from(markup).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  const first = 'https://httpbin.org/base64/' + content;
  const similar = 'https://www.httpbin.org/base64/' + content;
  const origin = new URL(first).origin, otherOrigin = new URL(similar).origin;
  const owner = randomUUID(), profileA = randomUUID(), profileB = randomUUID(), sessions = [];
  let session;
  async function create(url, profile) {
    session = randomUUID(); sessions.push(session);
    const result = await request('/sessions', { sessionId: session, ownerId: owner, startUrl: url,
      ...(profile ? { connectionId: profile } : {}) });
    assert.equal(result.status, 200); assert.equal(result.value.status, 'LIVE');
    assert.equal((await request('/sessions/' + session + '/control', {
      controlEpoch: 1, owner: 'CHATGPT', privateMode: false })).status, 200);
  }
  async function command(type, arguments_ = {}, expected = 'SUCCEEDED') {
    const result = await request('/sessions/' + session + '/commands', { operationId: randomUUID(), type,
      arguments: arguments_, instructionRevision: 0, controlEpoch: 1 });
    assert.equal(result.status, 200); assert.equal(result.value.status, expected);
    return expected === 'SUCCEEDED' ? result.value.result : result.value;
  }
  async function state(account) {
    await command('click', { selector: '#read-state' });
    const observed = await command('observe');
    for (const key of ['account', 'localAccount', 'pathAccount']) {
      assert.ok(observed.text.includes(JSON.stringify(key) + ':' + JSON.stringify(account)),
        'Similar hostnames must retain separate ' + key + '; synthetic state: ' + observed.text.slice(-800));
    }
  }
  async function save(profile, allowedOrigin) {
    assert.equal((await request('/sessions/' + session + '/profile/export', {
      connectionId: profile, ownerId: owner, origins: [allowedOrigin] })).status, 200);
  }
  try {
    await create(first);
    assert.equal((await command('observe')).title, 'Profile lifetime acceptance');
    await command('click', { selector: '#account-a' });
    await state('a'); await save(profileA, origin);
    assert.equal((await request('/sessions/' + session, undefined, 'DELETE')).value.status, 'CLOSED');
    await create(similar, profileA);
    await state(null);
    await command('click', { selector: '#account-b' });
    await state('b'); await save(profileB, otherOrigin);
    const accountBTab = (await command('observe')).tabs.find(tab => tab.active).id;
    await command('applyConnection', { connectionId: profileA, ownerId: owner, origins: [origin], url: first });
    await state('a');
    await command('navigate', { url: similar }); await state(null);
    await command('selectTab', { tabId: accountBTab }); await state('b');
    await command('applyConnection', { connectionId: profileB, ownerId: owner,
      origins: [otherOrigin], url: similar });
    await state('b');
    await command('navigate', { url: first }); await state(null);
    await command('applyConnection', { connectionId: profileA, ownerId: owner, origins: [origin], url: first });
    await state('a');
    const denied = await command('applyConnection', { connectionId: profileA, ownerId: owner,
      origins: [origin], url: similar }, 'FAILED');
    assert.equal(denied.error, 'Account switch destination was not confirmed');
    const retained = await command('observe');
    assert.equal(retained.url, first);
    assert.ok(retained.text.includes('"account":"a"'));
    assert.ok(retained.text.includes('"localAccount":"a"'));
    assert.ok(retained.text.includes('"pathAccount":"a"'));
    assert.equal((await request('/sessions/' + session, undefined, 'DELETE')).value.status, 'CLOSED');

    // Reproduce a formerly exported parent cookie, only in our random owner's profile.
    const database = new DatabaseSync((process.env.DATA_DIR ?? '/data') + '/node.sqlite');
    try {
      const vault = new Vault(process.env.VAULT_ADDR, process.env.VAULT_ROLE_ID, process.env.VAULT_SECRET_ID);
      const store = new ConnectionStore(database, vault, process.env.DATA_DIR ?? '/data');
      const readProfile = async id => {
        const result = await store.stream(id, owner), chunks = []; let size = 0;
        for await (const bytes of result.input) { size += bytes.length; assert.ok(size < 65536); chunks.push(bytes); }
        await result.completion;
        return Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
      };
      const parent = (await readProfile(profileA)).find(record => record.type === 'cookie' && record.value.name === 'helm_fixture_account').value;
      assert.equal(parent.domain, 'httpbin.org');
      const oldProfile = await readProfile(profileB);
      assert.deepEqual(oldProfile[0].origins, [otherOrigin]);
      oldProfile.splice(1, 0, { type: 'cookie', value: parent });
      await store.save(profileB, owner, randomUUID(), Readable.from(oldProfile.map(record => Buffer.from(JSON.stringify(record) + '\n'))));
      assert.ok((await readProfile(profileB)).some(record => record.type === 'cookie' && record.value.domain === 'httpbin.org'));
    } finally { database.close(); }
    await create(similar, profileB); await state('b');
    await command('navigate', { url: first }); await state(null);
  } finally {
    for (const id of sessions) assert.equal((await request('/sessions/' + id, undefined, 'DELETE')).value.status, 'CLOSED');
    for (const profile of [profileA, profileB]) assert.equal((await request('/profiles/' + profile, undefined, 'DELETE')).status, 200);
  }
});
