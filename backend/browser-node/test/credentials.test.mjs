import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, open, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ConnectionStore } from '../dist/connection-store.js';
import { StorageError, Vault } from '../dist/vault.js';

class InterruptedVault extends Vault {
  offline = false;
  interrupt = '';
  async read(id) { if (this.offline) throw new StorageError('PROFILE_STORAGE_UNAVAILABLE'); return super.read(id); }
  async write(id, version, data) {
    const interrupt = this.interrupt; this.interrupt = '';
    if (interrupt !== 'before') await super.write(id, version, data);
    if (interrupt) { this.offline = true; throw new StorageError('PROFILE_STORAGE_UNAVAILABLE'); }
  }
}
const vault = () => new InterruptedVault(process.env.VAULT_ADDR, process.env.VAULT_ROLE_ID, process.env.VAULT_SECRET_ID);
async function fixture(action) {
  const directory = await mkdtemp(tmpdir() + '/helm-vault-');
  const database = new DatabaseSync(directory + '/node.sqlite');
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE settings(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const remote = vault(), id = randomUUID(), owner = randomUUID();
  const store = new ConnectionStore(database, remote, directory);
  try { await action({ directory, database, remote, id, owner, store }); }
  finally { remote.offline = false; await store.remove(id); database.close(); await rm(directory, { recursive: true, force: true }); }
}
const header = { type: 'header', version: 2, origins: ['https://example.com'] };

test('cookie diagnostics survive commit and retry without changing profile revision or legacy bytes', async () => fixture(async ({ store, id, owner }) => {
  const snapshot = cookieCheck => Readable.from([
    Buffer.from(JSON.stringify({ ...header, cookieCheck }) + '\n{"type":"end"}\n')]);
  const legacy = await store.save(id, owner, 'legacy-profile', snapshot(undefined));
  assert.equal(legacy.cookieCheck, undefined);
  const firstCheck = { usableCount: 0, checkedAt: '2026-10-09T12:00:00.000Z' };
  const first = await store.save(id, owner, 'first-check', snapshot(firstCheck));
  assert.equal(first.revision, legacy.revision);
  assert.deepEqual(first.cookieCheck, firstCheck);
  const nextCheck = { usableCount: 1, checkedAt: '2026-10-09T12:01:00.000Z' };
  assert.deepEqual((await store.save(id, owner, 'first-check', snapshot(nextCheck))).cookieCheck, firstCheck);
  const next = await store.save(id, owner, 'next-check', snapshot(nextCheck));
  assert.equal(next.revision, legacy.revision);
  assert.deepEqual((await store.saved(id, owner, 'next-check')).cookieCheck, nextCheck);
  await assert.rejects(store.save(id, owner, 'broken', Readable.from([
    Buffer.from(JSON.stringify({ ...header, cookieCheck: firstCheck }) + '\n')
  ])), { code: 'PROFILE_INVALID' });
  assert.deepEqual((await store.saved(id, owner, 'next-check')).cookieCheck, nextCheck);
  const restored = await store.stream(id, owner);
  let text = '';
  for await (const bytes of restored.input) text += bytes.toString();
  await restored.completion;
  assert.equal(text, JSON.stringify(header) + '\n{"type":"end"}\n');
}));
function profile(megabytes = 1, singleRecord = false) {
  return Readable.from((async function* () {
    yield Buffer.from(JSON.stringify(header) + '\n');
    yield Buffer.from('{"type":"origin","origin":"https://example.com"}\n');
    yield Buffer.from('{"type":"local","name":"unicode","value":"Привет 🦊 日本語"}\n');
    for (let record = 0; record < (singleRecord ? 1 : megabytes); record++) {
      yield Buffer.from('{"type":"local","name":"chunk-' + record + '","value":"');
      for (let part = 0; part < (singleRecord ? megabytes : 1) * 16; part++) yield Buffer.alloc(65536, 120);
      yield Buffer.from('"}\n');
    }
    yield Buffer.from('{"type":"end"}\n');
  })());
}
async function restoredSize(store, id, owner) {
  const result = await store.stream(id, owner); let length = 0;
  for await (const bytes of result.input) length += bytes.length;
  await result.completion; return length;
}
function exactProfile(size, recordLimit = 16 * 1024 * 1024) {
  return Readable.from((async function* () {
    const headerBytes = Buffer.from(JSON.stringify(header) + '\n');
    const end = Buffer.from('{"type":"end"}\n');
    yield headerBytes;
    let remaining = size - headerBytes.length - end.length;
    const prefix = Buffer.from('{"type":"local","name":"value","value":"');
    const suffix = Buffer.from('"}\n');
    while (remaining) {
      const record = Math.min(remaining, recordLimit); remaining -= record;
      yield prefix;
      let payload = record - prefix.length - suffix.length;
      while (payload) { const length = Math.min(payload, 65536); yield Buffer.alloc(length, 120); payload -= length; }
      yield suffix;
    }
    yield end;
  })());
}

test('Vault credentials enforce owner, revision, repeat, deletion and profile-independent access', async () => fixture(async ({ store, id, owner, database }) => {
  const value = { origin: 'https://example.com', username: 'synthetic-user', password: 'synthetic-password' };
  await store.write(id, owner, 'save-once', 0, value);
  await store.write(id, owner, 'save-once', 0, value);
  assert.deepEqual(await store.metadata(id, owner), { available: true, revision: 1, origin: value.origin });
  assert.deepEqual(await store.read(id, owner), value);
  await assert.rejects(store.read(id, 'foreign'), { code: 'PROFILE_OWNER_MISMATCH' });
  await assert.rejects(store.write(id, 'foreign', 'foreign-save', 0, value));
  await assert.rejects(store.write(id, owner, 'save-once', 0, { ...value, password: 'different' }));
  await assert.rejects(store.write(id, owner, 'stale-save', 0, value));
  assert.equal(JSON.stringify(database.prepare('SELECT * FROM settings').all()).includes(value.password), false);
  assert.equal(JSON.stringify(await store.metadata(id, owner)).includes(value.password), false);
  await store.write(id, owner, 'delete-once', 1, null);
  await store.write(id, owner, 'delete-once', 1, null);
  assert.deepEqual(await store.metadata(id, owner), { available: false, revision: 2, origin: null });
  assert.equal(await store.read(id, owner), undefined);
  await assert.rejects(store.write(id, owner, 'late-save', 1, value));
}));

test('streamed profiles exceed 8 MiB, preserve exact bytes, reject bounds and authenticate before restore', { timeout: 180000 }, async () => fixture(async ({ store, id, owner, directory, remote }) => {
  const initial = await store.save(id, owner, 'large', profile(12));
  assert.ok(await restoredSize(store, id, owner) > 12 * 1024 * 1024);
  assert.equal((await store.save(id, owner, 'unchanged', profile(12))).revision, initial.revision);
  await assert.rejects(store.save(id, owner, 'oversize-record', profile(17, true)), { code: 'PROFILE_RECORD_TOO_LARGE' });
  await assert.rejects(store.save(id, owner, 'oversize-profile', profile(257)), { code: 'PROFILE_TOO_LARGE' });
  assert.ok(await restoredSize(store, id, owner) > 12 * 1024 * 1024);
  await assert.rejects(store.stream(id, 'foreign'), { code: 'PROFILE_OWNER_MISMATCH' });
  const saved = (await remote.read(id)).data.profile;
  const file = await open(directory + '/profiles/' + saved.file + '.profile', 'r+');
  const byte = Buffer.alloc(1); await file.read(byte, 0, 1, 0); const original = byte[0]; byte[0] ^= 1; await file.write(byte, 0, 1, 0);
  await assert.rejects(store.stream(id, owner), { code: 'PROFILE_INVALID' });
  byte[0] = original; await file.write(byte, 0, 1, 0); await file.close();
  assert.ok(await restoredSize(store, id, owner) > 12 * 1024 * 1024);
  assert.equal((await readdir(directory + '/profiles')).length, 1);
}));

for (const interruption of ['before', 'after']) {
  test('durable save recovers process restart ' + interruption + ' KV commit without duplicate revision', async () => fixture(async ({ store, id, owner, remote, database, directory }) => {
    const old = await store.save(id, owner, 'old', profile(1));
    remote.interrupt = interruption;
    await assert.rejects(store.save(id, owner, 'interrupted', profile(2)), { code: 'PROFILE_STORAGE_UNAVAILABLE' });
    assert.equal(database.prepare('SELECT count(*) n FROM settings').get().n, 1);
    remote.offline = false;
    const recovery = spawn(process.execPath, ['--input-type=module', '-e', `
      import {DatabaseSync} from 'node:sqlite';
      import {ConnectionStore} from './dist/connection-store.js';
      import {Vault} from './dist/vault.js';
      const db = new DatabaseSync(process.env.RECOVERY_DIRECTORY + '/node.sqlite');
      const store = new ConnectionStore(db, new Vault(process.env.VAULT_ADDR, process.env.VAULT_ROLE_ID, process.env.VAULT_SECRET_ID), process.env.RECOVERY_DIRECTORY);
      if (!(await store.saved(process.env.RECOVERY_ID, process.env.RECOVERY_OWNER, 'interrupted'))) throw new Error('Recovery did not confirm the operation');
      db.close();
    `], { env: { ...process.env, RECOVERY_DIRECTORY: directory, RECOVERY_ID: id, RECOVERY_OWNER: owner }, stdio: 'ignore' });
    assert.equal(await new Promise((resolve, reject) => { recovery.on('error', reject); recovery.on('exit', resolve); }), 0);
    const restarted = new ConnectionStore(database, remote, directory);
    const saved = await restarted.saved(id, owner, 'interrupted');
    assert.equal(saved.revision, old.revision + 1);
    assert.equal((await restarted.save(id, owner, 'interrupted', profile(2))).revision, saved.revision);
    assert.equal(database.prepare('SELECT count(*) n FROM settings').get().n, 0);
    assert.equal((await readdir(directory + '/profiles')).length, 1);
    assert.ok(await restoredSize(restarted, id, owner) > 2 * 1024 * 1024);
  }));
}

test('Vault CAS prevents two credential writers from overwriting each other', async () => fixture(async ({ store, id, owner, remote, database, directory }) => {
  const other = new ConnectionStore(database, remote, directory);
  const value = { origin: 'https://example.com', username: 'synthetic', password: 'synthetic' };
  const results = await Promise.allSettled([store.write(id, owner, 'first', 0, value), other.write(id, owner, 'second', 0, value)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.metadata(id, owner)).revision, 1);
}));

test('exact 256 MiB profile and 16 MiB records fit; one extra byte fails at its own boundary', { timeout: 180000 }, async () => fixture(async ({ store, id, owner }) => {
  const maximum = 256 * 1024 * 1024;
  await store.save(id, owner, 'exact', exactProfile(maximum));
  assert.equal(await restoredSize(store, id, owner), maximum);
  await assert.rejects(store.save(id, owner, 'total-plus-one', exactProfile(maximum + 1)), { code: 'PROFILE_TOO_LARGE' });
  await assert.rejects(store.save(id, owner, 'record-plus-one', exactProfile(17 * 1024 * 1024, 16 * 1024 * 1024 + 1)), { code: 'PROFILE_RECORD_TOO_LARGE' });
  assert.equal((await store.saved(id, owner, 'exact')).revision, 1);
}));
