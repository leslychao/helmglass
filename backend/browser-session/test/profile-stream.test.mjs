import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { exportProfile } from '../dist/profile-export.js';
import { importProfile } from '../dist/profile-import.js';

test('Chromium streams >8 MiB with Unicode, binary, IDB references and bounded Node memory', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(tmpdir() + '/helm-profile-');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
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
    assert.ok(peak - baseline < 96 * 1024 * 1024, 'Node must not retain the full 128 MiB profile');
    console.log('Node peak RSS increase MiB:', Math.ceil((peak - baseline) / 1024 / 1024));
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

    let changed = false;
    const discard = new Writable({ write(_bytes, _encoding, done) {
      if (changed) { done(); return; } changed = true;
      context.addCookies([{ name: 'login', value: 'changed', url: origin }]).then(() => done(), done);
    } });
    await assert.rejects(exportProfile(page, [origin], discard), { code: 'PROFILE_SNAPSHOT_CHANGED' });
    discard.destroy();
    await page.evaluate(async () => {
      const db = await new Promise(resolve => { const request = indexedDB.open('large'); request.onsuccess = () => resolve(request.result); });
      await new Promise(resolve => { const transaction = db.transaction('records', 'readwrite'); transaction.objectStore('records').put('x'.repeat(17 * 1024 * 1024), 'oversize'); transaction.oncomplete = resolve; }); db.close();
    });
    const sink = new Writable({ write(_bytes, _encoding, done) { done(); } });
    await assert.rejects(exportProfile(page, [origin], sink), { code: 'PROFILE_RECORD_TOO_LARGE' });
    sink.destroy();
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
