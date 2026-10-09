import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { checkCookies, exportProfile, trackLoginOrigins } from '../dist/profile-export.js';
import { importProfile } from '../dist/profile-import.js';

test('cookie suitability checks snapshot expiry, domain and secure transport, not cookie contents', () => {
  const checkedAt = new Date('2026-10-09T12:00:00Z');
  const now = checkedAt.getTime() / 1000;
  const cookie = { name: 'guest', value: '', domain: 'site.example', path: '/api',
    expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' };
  const origins = [new URL('https://site.example'), new URL('http://plain.example')];
  const cookies = [cookie, { ...cookie, expires: now + 60 },
    { ...cookie, domain: '.site.example', secure: true },
    { ...cookie, expires: now }, { ...cookie, expires: now - 1 },
    { ...cookie, domain: 'other.example' }, { ...cookie, domain: 'example' },
    { ...cookie, domain: 'plain.example', secure: true }];
  assert.deepEqual(checkCookies(cookies, origins, checkedAt), {
    usableCount: 3, checkedAt: checkedAt.toISOString() });
  assert.equal(checkCookies([cookie], [new URL('https://sub.site.example')], checkedAt).usableCount, 0);
  assert.equal(checkCookies([{ ...cookie, domain: '.site.example' }],
    [new URL('https://sub.site.example')], checkedAt).usableCount, 1);
  assert.equal(checkCookies([{ ...cookie, domain: '.site.example' }],
    [new URL('https://notsite.example')], checkedAt).usableCount, 0);
});

test('export reports cookies from its saved snapshot and preserves cookie-free site storage', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: false, chromiumSandbox: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    const page = await context.newPage();
    await page.goto('https://site.example');
    await page.evaluate(async () => {
      localStorage.setItem('state', 'kept');
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('session', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('values').put('kept', 'state');
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = reject;
      });
    });
    const protocol = await browser.newBrowserCDPSession();
    const visibleTabs = async () => (await protocol.send('Target.getTargets', {
      filter: [{ type: 'tab' }],
    })).targetInfos.filter(target => target.embedderData?.tabStripIndex !== undefined)
      .map(target => ({ id: target.targetId, ...target.embedderData }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const snapshot = async () => {
      const originalTabs = await visibleTabs();
      assert.ok(originalTabs.length > 0, 'The fixture must have a visible browser tab');
      const originalFocus = await page.evaluate(() => document.hasFocus());
      const chunks = [];
      let checkedHiddenExport = false;
      const output = new Writable({ write(chunk, _encoding, done) {
        chunks.push(chunk);
        if (chunk.toString().startsWith('{"type":"origin"')) {
          checkedHiddenExport = true;
          visibleTabs().then(async tabs => {
            assert.deepEqual(tabs, originalTabs, 'Saving must not add or switch a browser tab');
            assert.equal(await page.evaluate(() => document.hasFocus()), originalFocus,
              'Saving must not change page focus');
            done();
          }).catch(done);
        } else done();
      } });
      await exportProfile(page, ['https://site.example'], output);
      output.end(); await finished(output);
      assert.ok(checkedHiddenExport, 'Inspect the tab strip while exporting storage');
      assert.deepEqual(context.pages(), [page], 'No temporary page may survive export');
      const bytes = Buffer.concat(chunks);
      assert.ok(bytes.length < 65536);
      return { bytes, records: bytes.toString().trim().split('\n').map(line => JSON.parse(line)) };
    };
    const empty = await snapshot();
    assert.equal(empty.records[0].cookieCheck.usableCount, 0);
    assert.ok(Number.isFinite(Date.parse(empty.records[0].cookieCheck.checkedAt)));
    const restored = await browser.newContext();
    await importProfile(restored, [empty.bytes]);
    const restoredPage = await restored.newPage();
    await restoredPage.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await restoredPage.goto('https://site.example');
    assert.equal(await restoredPage.evaluate(() => localStorage.getItem('state')), 'kept');
    assert.equal(await restoredPage.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('session');
      request.onsuccess = () => {
        const read = request.result.transaction('values').objectStore('values').get('state');
        read.onsuccess = () => { request.result.close(); resolve(read.result); };
        read.onerror = reject;
      };
      request.onerror = reject;
    })), 'kept');
    await context.addCookies([
      { name: 'session', value: '', domain: 'site.example', path: '/', httpOnly: true, secure: true },
      { name: 'unrelated', value: 'excluded', domain: 'other.example', path: '/' },
    ]);
    const populated = await snapshot();
    assert.equal(populated.records[0].cookieCheck.usableCount, 1);
    assert.deepEqual(populated.records.filter(record => record.type === 'cookie').map(record => record.value.name), ['session']);
  } finally { await browser.close(); }
});

test('background cookie changes do not invalidate the captured login snapshot', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: false, chromiumSandbox: true });
  const origin = 'https://profile.example';
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    const page = await context.newPage();
    await page.goto(origin);
    await context.addCookies([{ name: 'login', value: 'captured', url: origin }]);
    const chunks = [];
    let changing;
    const output = new Writable({ write(chunk, _encoding, done) {
      chunks.push(chunk);
      changing ??= context.addCookies([
        { name: 'login', value: 'refreshed', url: origin },
        { name: 'background', value: 'new', url: origin },
      ]);
      changing.then(() => done(), done);
    } });
    await exportProfile(page, [origin], output);
    output.end(); await finished(output);
    const snapshot = Buffer.concat(chunks);
    const records = snapshot.toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records[0].cookieCheck.usableCount, 1);
    assert.equal(records.at(-1).type, 'end');
    const restored = await browser.newContext();
    await importProfile(restored, [snapshot]);
    assert.deepEqual((await restored.cookies()).map(({ name, value }) => ({ name, value })),
      [{ name: 'login', value: 'captured' }]);
    assert.equal((await context.cookies()).find(cookie => cookie.name === 'login').value, 'refreshed');
  } finally { await browser.close(); }
});

test('missing response headers release the login snapshot wait and allow retry', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = new EventEmitter();
  const origins = new Set(['https://site.example']);
  const flush = trackLoginOrigins(context, origins, () => true);
  let complete;
  context.emit('response', {
    url: () => 'https://identity.example/token',
    headerValue: () => new Promise(resolve => { complete = resolve; }),
  });
  const failure = assert.rejects(flush(), { code: 'PROFILE_SNAPSHOT_CHANGED' });
  t.mock.timers.tick(20_000);
  await failure;
  complete('identity=synthetic');
  await flush();
  assert.deepEqual([...origins], ['https://site.example', 'https://identity.example']);
});

test('snapshot page cleanup releases protocol sessions without waiting for detach', { timeout: 5000 }, async t => {
  const browser = await chromium.launch({ headless: false, chromiumSandbox: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  const selected = await context.newPage();
  await selected.goto('https://first.example');
  await selected.evaluate(() => localStorage.setItem('state', 'kept'));
  const sessions = [];
  const trackProtocol = target => {
    const create = target.newCDPSession.bind(target);
    t.mock.method(target, 'newCDPSession', async page => {
      const cdp = await create(page);
      sessions.push(new Promise(resolve => cdp.once('close', resolve)));
      // A renderer may stop acknowledging detach after a cross-site navigation.
      if (page !== selected) t.mock.method(cdp, 'detach', () => new Promise(() => {}));
      return cdp;
    });
  };
  trackProtocol(context);
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  await exportProfile(selected, ['https://first.example', 'https://second.test'], output);
  output.end(); await finished(output);
  assert.deepEqual(context.pages(), [selected]);
  assert.equal(await selected.evaluate(() => localStorage.getItem('state')), 'kept');
  const restored = await browser.newContext();
  trackProtocol(restored);
  await importProfile(restored, [Buffer.concat(chunks)]);
  assert.equal(restored.pages().length, 0);
  assert.equal(sessions.length, 2);
  await Promise.all(sessions);
});

async function loginSite() {
  const server = createServer((request, response) => {
    const host = request.headers.host.split(':')[0];
    response.writeHead(200, { 'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': request.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
      ...(['login.account.example', 'unrelated.example'].includes(host)
        ? { 'Set-Cookie': 'identity=synthetic; Path=/; HttpOnly; SameSite=Lax' } : {}) });
    response.end('<!doctype html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: host => `http://${host}:${server.address().port}` };
}

test('private login retains host-only cookies from background identity requests', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(tmpdir() + '/helm-login-origins-');
  const site = await loginSite();
  const browser = await chromium.launch({ headless: false, chromiumSandbox: true,
    args: ['--host-resolver-rules=MAP *.example 127.0.0.1'] });
  const origin = site.origin('account.example');
  const identity = site.origin('login.account.example');
  const unrelated = site.origin('unrelated.example');
  try {
    const context = await browser.newContext();
    let privateLogin = false;
    const origins = new Set([origin]);
    const flushOrigins = trackLoginOrigins(context, origins, () => privateLogin);
    const page = await context.newPage();
    await page.goto(unrelated);
    await page.goto(origin);
    privateLogin = true;
    await page.evaluate(async identity => {
      const response = await fetch(identity + '/token', { credentials: 'include' });
      if (!response.ok) throw new Error('Identity request failed');
      await response.text();
    }, identity);
    assert.equal(page.url(), origin + '/', 'The identity origin never became the top-level page');
    privateLogin = false;
    await flushOrigins();
    assert.deepEqual([...origins], [origin, identity]);

    const file = directory + '/profile.ndjson';
    const output = createWriteStream(file);
    await exportProfile(page, [...origins], output);
    output.end(); await finished(output);
    const restored = await browser.newContext();
    await importProfile(restored, createReadStream(file));
    const cookies = await restored.cookies();
    assert.ok(cookies.some(cookie => cookie.domain === 'login.account.example'
      && cookie.name === 'identity' && cookie.value === 'synthetic' && cookie.httpOnly));
    assert.ok(!cookies.some(cookie => cookie.domain === 'unrelated.example'),
      'Requests outside protected login must not widen the saved profile');
    assert.deepEqual([...origins], [origin, identity], 'Snapshot pages must not extend login scope');
  } finally { await browser.close(); site.server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('resource hosts without cookies do not exhaust login scope or hide a later identity origin', { timeout: 30000 }, async () => {
  const site = await loginSite();
  const browser = await chromium.launch({ headless: false, chromiumSandbox: true,
    args: ['--host-resolver-rules=MAP *.example 127.0.0.1'] });
  try {
    const context = await browser.newContext();
    let active = true;
    const origins = new Set();
    const flushOrigins = trackLoginOrigins(context, origins, () => active);
    const page = await context.newPage();
    const origin = site.origin('account.example'), identity = site.origin('login.account.example');
    await page.goto(origin);
    await page.evaluate(async ({ port, identity }) => {
      for (let index = 0; index < 60; index++) {
        await (await fetch(`http://resource-${index}.example:${port}/asset`)).text();
      }
      await (await fetch(identity + '/token', { credentials: 'include' })).text();
    }, { port: site.server.address().port, identity });
    active = false;
    await flushOrigins();
    assert.deepEqual([...origins], [origin, identity]);
    let ended = false;
    await exportProfile(page, [...origins], new Writable({ write(chunk, _encoding, done) {
      if (chunk.toString().includes('{"type":"end"}')) ended = true;
      done();
    } }));
    assert.ok(ended, 'A complete login profile must be exportable after loading many resource hosts');
  } finally { await browser.close(); site.server.close(); }
});

test('wide IndexedDB records within the byte limit retain all objects and shared references', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(tmpdir() + '/helm-wide-profile-');
  const browser = await chromium.launch({ headless: false, chromiumSandbox: true });
  const origin = 'https://profile.example';
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    const page = await context.newPage(); await page.goto(origin);
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('cache', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const value = { entries: Array.from({ length: 60000 }, (_, id) => ({ id, value: 'cached' })) };
      value.self = value; value.alias = value.entries.at(-1);
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('records', 'readwrite');
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
        transaction.objectStore('records').put(value, 'wide');
      }); db.close();
    });
    const file = directory + '/profile.ndjson'; const output = createWriteStream(file);
    try { await exportProfile(page, [origin], output); output.end(); await finished(output); }
    finally { output.destroy(); }
    assert.ok((await stat(file)).size < 16 * 1024 * 1024, 'The record fits the existing byte budget');
    const replacement = await browser.newContext();
    await importProfile(replacement, createReadStream(file, { highWaterMark: 65536 }));
    await replacement.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    const restored = await replacement.newPage(); await restored.goto(origin);
    const actual = await restored.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('cache');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction('records').objectStore('records').get('wide');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      }); db.close();
      return { count: value.entries.length, sum: value.entries.reduce((total, item) => total + item.id, 0),
        allValues: value.entries.every(item => item.value === 'cached'), self: value.self === value,
        alias: value.alias === value.entries.at(-1) };
    });
    assert.deepEqual(actual, { count: 60000, sum: 1799970000, allValues: true, self: true, alias: true });
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Chromium streams >8 MiB with Unicode, binary, IDB references and bounded Node memory', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(tmpdir() + '/helm-profile-');
  const browser = await chromium.launch({ headless: false, chromiumSandbox: true });
  const origin = 'https://profile.example';
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Profile fixture</title>' }));
    const page = await context.newPage(); await page.goto(origin);
    await context.addCookies([{ name: 'login', value: 'synthetic', url: origin }]);
    await page.evaluate(async () => {
      localStorage.setItem('unicode', 'Привет 🦊 日本語');
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('large', 2);
        request.onupgradeneeded = () => { request.result.createObjectStore('records'); request.result.createObjectStore('indexed', { keyPath: ['group', 'id'] }).createIndex('label', 'label', { unique: false }); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['records', 'indexed'], 'readwrite');
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
        const store = transaction.objectStore('records');
        const payload = 'x'.repeat(1024 * 1024);
        for (let index = 0; index < 128; index++) store.put(payload, index);
        const value = { unicode: 'Привет 🦊 日本語', bytes: new Uint8Array([0, 1, 127, 255]), date: new Date('2026-01-01'), map: new Map([['key', 123n]]), set: new Set(['a', 'b']) }; value.self = value;
        store.put(value, 'complex');
        transaction.objectStore('indexed').put({ group: 'g', id: 1, label: 'label' });
      }); db.close();
    });
    const baseline = process.memoryUsage().rss; let peak = baseline;
    const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    const file = directory + '/profile.ndjson'; const output = createWriteStream(file);
    try { await exportProfile(page, [origin], output); output.end(); await finished(output); }
    finally { clearInterval(sample); output.destroy(); }
    assert.ok((await stat(file)).size > 128 * 1024 * 1024);
    console.log('Node peak RSS increase MiB:', Math.ceil((peak - baseline) / 1024 / 1024));
    assert.ok(peak - baseline < 96 * 1024 * 1024, 'Node must not retain the full 128 MiB profile');
    const replacement = await browser.newContext();
    await importProfile(replacement, createReadStream(file, { highWaterMark: 65536 }));
    await replacement.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    const restored = await replacement.newPage(); await restored.goto(origin);
    const actual = await restored.evaluate(async () => {
      const db = await new Promise(resolve => { const request = indexedDB.open('large'); request.onsuccess = () => resolve(request.result); });
      const transaction = db.transaction(['records', 'indexed']);
      const result = await new Promise(resolve => {
        const count = transaction.objectStore('records').count();
        const complex = transaction.objectStore('records').get('complex');
        const index = transaction.objectStore('indexed').index('label').get('label');
        transaction.oncomplete = () => resolve({ count: count.result, unicode: localStorage.getItem('unicode'), bytes: [...complex.result.bytes], cyclic: complex.result.self === complex.result, map: complex.result.map.get('key') === 123n, set: complex.result.set.has('b'), date: complex.result.date.toISOString(), indexed: index.result.group });
      }); db.close(); return result;
    });
    assert.deepEqual(actual, { count: 129, unicode: 'Привет 🦊 日本語', bytes: [0, 1, 127, 255], cyclic: true, map: true, set: true, date: '2026-01-01T00:00:00.000Z', indexed: 'g' });
    assert.equal((await replacement.cookies())[0].value, 'synthetic');
    const damaged = await browser.newContext();
    await assert.rejects(importProfile(damaged, createReadStream(file, { end: 500 })), /Incomplete|JSON/);
    assert.equal(await page.evaluate(() => localStorage.getItem('unicode')), 'Привет 🦊 日本語');
    await damaged.close();

    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const request = indexedDB.open('large'); request.onsuccess = () => resolve(request.result); });
      await new Promise(resolve => { const transaction = db.transaction('records', 'readwrite'); transaction.objectStore('records').put('x'.repeat(17 * 1024 * 1024), 'oversize'); transaction.oncomplete = resolve; }); db.close();
    });
    const sink = new Writable({ write(_bytes, _encoding, done) { done(); } });
    await assert.rejects(exportProfile(page, [origin], sink), { code: 'PROFILE_RECORD_TOO_LARGE' });
    sink.destroy();
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
