import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chown, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
function invoke(value, success = true) {
  const result = spawnSync('node', ['/fixture-code/recovery-material.mjs'], {
    input: JSON.stringify(value), encoding: 'utf8', timeout: 30_000, maxBuffer: 65_536 });
  if (success) assert.equal(result.status, 0, result.stderr);
  else { assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); }
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}
await chown('/backup-work', 999, 999);
const owner = { schemaVersion: 1, installationId: 'fixture', recoveryId: randomUUID() };
const keys = { ...owner, mode: 'keys', privateKeyPem: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nfixture transport only\n',
  password: 'fixture-password-with-sufficient-length' };
const first = invoke(keys);
assert.deepEqual(invoke(keys), first);
const privateKey = first.directory + '/private.pem';
const before = await readFile(privateKey);
invoke({ ...keys, privateKeyPem: keys.privateKeyPem + 'changed' }, false);
assert.deepEqual(await readFile(privateKey), before);
invoke({ ...owner, installationId: 'foreign', mode: 'clear-keys' }, false);
assert.deepEqual(await readFile(privateKey), before);
const metadata = await lstat(privateKey);
assert.equal(metadata.uid, 999);
assert.equal(metadata.mode & 0o777, 0o400);
assert.equal(invoke({ ...owner, mode: 'clear-keys' }).state, 'REMOVED');
assert.equal(invoke({ ...owner, mode: 'clear-keys' }).state, 'REMOVED');
assert.deepEqual(await readdir('/backup-work'), []);
const pg = { ...owner, mode: 'pg-parent' };
assert.equal(invoke(pg).state, 'EMPTY_PG_PARENT');
assert.equal(invoke(pg).state, 'EMPTY_PG_PARENT');
assert.equal((await lstat('/storage/18')).uid, 999);
invoke({ ...pg, installationId: 'foreign' }, false);
await mkdir('/storage/18/docker');
invoke(pg, false);
assert.ok((await lstat('/storage/18/docker')).isDirectory());
const files = Object.fromEntries(['proof.json', 'deletion-ledger.json', 'fencing.json', 'redis.json']
  .map(name => [name, Buffer.from(JSON.stringify({ name, timestamp: '2026-10-03T00:00:00.000Z' })).toString('base64')]));
const proof = { ...owner, mode: 'proof', files };
const result = invoke(proof);
assert.deepEqual(invoke(proof), result);
for (const [name, data] of Object.entries(files)) {
  const bytes = await readFile('/recovery/' + name);
  assert.equal(bytes.toString('base64'), data);
  assert.equal(result.hashes[name], checksum(bytes));
  assert.equal((await lstat('/recovery/' + name)).uid, 10001);
}
invoke({ ...proof, files: { ...files, 'proof.json': Buffer.from('different').toString('base64') } }, false);
assert.equal((await readFile('/recovery/proof.json')).toString('base64'), files['proof.json']);
process.stdout.write('Recovery material transport preserved immutable proof bytes, private ownership and foreign cleanup rejection.\n');
