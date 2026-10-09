import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ConnectionStore } from '../dist/connection-store.js';
import { Vault } from '../dist/vault.js';

test('filled legacy SQLite migrates, verifies reads and resumes safely on repeated deployment', async () => {
  const directory = await mkdtemp(tmpdir() + '/helm-migration-');
  const database = new DatabaseSync(directory + '/node.sqlite');
  database.exec('CREATE TABLE profiles(id TEXT PRIMARY KEY,owner TEXT,encrypted BLOB); CREATE TABLE profile_state(id TEXT PRIMARY KEY,owner TEXT,revision INTEGER,saved_at TEXT); CREATE TABLE credentials(id TEXT PRIMARY KEY,owner TEXT,encrypted BLOB,revision INTEGER,operation_id TEXT); CREATE TABLE settings(id TEXT PRIMARY KEY,value TEXT)');
  const key = randomBytes(32), owner = randomUUID(), id = randomUUID(), credentialOnly = randomUUID();
  const vault = new Vault(process.env.VAULT_ADDR, process.env.VAULT_ROLE_ID, process.env.VAULT_SECRET_ID);
  const store = new ConnectionStore(database, vault, directory);
  const credential = { origin: 'https://example.com', username: 'synthetic', password: 'synthetic' };
  const seal = (value, aad) => {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), body]);
  };
  const run = async expected => {
    const child = spawn(process.execPath, ['dist/migrate-profiles.js'], { env: { ...process.env, DATA_DIR: directory, PROFILE_ENCRYPTION_KEY: key.toString('base64') }, stdio: 'ignore' });
    const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); assert.equal(result, expected);
  };
  try {
    database.prepare('INSERT INTO profiles VALUES(?,?,?)').run(id, owner, seal({ cookies: [], origins: [{ origin: 'https://example.com', localStorage: [{ name: 'identity', value: 'Привет 🦊' }], indexedDB: [{ name: 'legacy', version: 1, stores: [{ name: 'items', autoIncrement: false, indexes: [], records: [{ key: 'row', value: { nested: ['value'] } }] }] }] }] }, owner + ':' + id));
    database.prepare('INSERT INTO profile_state VALUES(?,?,?,?)').run(id, owner, 7, '2026-01-01T00:00:00Z');
    for (const value of [id, credentialOnly]) database.prepare('INSERT INTO credentials VALUES(?,?,?,?,?)').run(value, owner, seal(credential, 'credential:' + owner + ':' + value), 3, 'original');
    // A failed read cannot delete an old value; a corrected source then resumes the same migration.
    const original = database.prepare('SELECT encrypted FROM profiles WHERE id=?').get(id).encrypted;
    database.prepare('UPDATE profiles SET encrypted=? WHERE id=?').run(Buffer.from('invalid'), id);
    await run(1); assert.equal(database.prepare('SELECT count(*) n FROM profiles').get().n, 1);
    database.prepare('UPDATE profiles SET encrypted=? WHERE id=?').run(original, id);
    await run(0); await run(0);
    assert.equal(database.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('profiles','profile_state','credentials')").get().n, 0);
    assert.equal((await store.saved(id, owner, 'vault-migration-v2:' + id)).revision, 7);
    for (const value of [id, credentialOnly]) {
      assert.deepEqual(await store.read(value, owner), credential);
      assert.equal((await store.metadata(value, owner)).revision, 3);
    }
    const restored = await store.stream(id, owner), chunks = []; let size = 0;
    for await (const chunk of restored.input) { size += chunk.length; assert.ok(size < 65536); chunks.push(chunk); }
    await restored.completion;
    assert.ok(Buffer.concat(chunks).toString('utf8').includes('Привет 🦊'));
  } finally {
    for (const value of [id, credentialOnly]) await store.remove(value);
    key.fill(0); database.close(); await rm(directory, { recursive: true, force: true });
  }
});
