import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chown, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env, BACKUP_DIR: '/fixture/backup', BACKUP_WORK_DIR: '/fixture/work',
  BACKUP_RECIPIENT_CERT: '/fixture/public.pem', BACKUP_PRIVATE_KEY_FILE: '/fixture/key.pem',
  BACKUP_KEY_PASSWORD_FILE: '/fixture/password' };
function run(command, args, input, success = true) {
  const result = spawnSync(command, args, { env, input, encoding: 'utf8', timeout: 120_000 });
  if (success) assert.equal(result.status, 0, result.stderr);
  else { assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); }
  return result.stdout;
}
async function json(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(path, bytes, { mode: 0o600 });
  return hash(bytes);
}
await mkdir('/fixture/backup', { mode: 0o700 });
await mkdir('/fixture/work', { mode: 0o700 });
// The production maintenance user must read private PostgreSQL-owned roots without changing them.
for (const directory of ['/fixture/backup', '/fixture/work']) await chown(directory, 999, 999);
await writeFile('/fixture/password', 'fixture-password-with-more-than-16-bytes', { mode: 0o600 });
run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-keyout', '/fixture/key.pem',
  '-out', '/fixture/public.pem', '-passout', 'file:/fixture/password', '-subj', '/CN=joint-fixture', '-days', '1']);
const installationId = 'fixture';
const backupId = 'complete-set';
await writeFile('/fixture/plain', 'fixture component bytes', { mode: 0o600 });
async function bundle(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  run('/opt/helm/bin/backup-file', ['encrypt', '/fixture/plain', path]);
  return hash(await readFile(path + '/manifest.json'));
}
const pg = { systemIdentifier: '123456789', directory: `postgres/123456789/base/${backupId}`,
  restorePoint: 'helm_' + 'a'.repeat(32), restoreLsn: '0/10000', walFile: '000000010000000000000001',
  walDirectory: 'postgres/123456789/wal/000000010000000000000001' };
pg.manifestSha256 = await json(`${env.BACKUP_DIR}/${pg.directory}/manifest.json`, {
  schemaVersion: 1, systemIdentifier: pg.systemIdentifier, backupId,
  format: 'postgresql-18-plain-tar-cms-chunks-v1', cipherSha256: await bundle(`${env.BACKUP_DIR}/${pg.directory}/base`) });
pg.walManifestSha256 = await json(`${env.BACKUP_DIR}/${pg.walDirectory}/manifest.json`, {
  schemaVersion: 1, systemIdentifier: pg.systemIdentifier, walFile: pg.walFile });
const minio = { directory: `minio/${installationId}/${backupId}` };
const disks = [];
for (let index = 1; index <= 4; index++) disks.push({ diskIndex: index, directory: `disk${index}`,
  manifestSha256: await bundle(`${env.BACKUP_DIR}/${minio.directory}/disk${index}`) });
minio.manifestSha256 = await json(`${env.BACKUP_DIR}/${minio.directory}/manifest.json`, {
  schemaVersion: 1, format: 'helm-minio-cold-v1', installationId, backupId, disks });
const vault = { directory: `vault/${installationId}/${backupId}` };
vault.manifestSha256 = await json(`${env.BACKUP_DIR}/${vault.directory}/manifest.json`, {
  schemaVersion: 1, format: 'helm-vault-raft-v1', installationId, backupId,
  archiveManifestSha256: await bundle(`${env.BACKUP_DIR}/${vault.directory}/snapshot`) });
const completedAt = '2026-10-03T00:00:00.000Z';
const manifest = { schemaVersion: 1, format: 'helm-joint-cold-v1', installationId, backupId,
  daemonId: 'fixture-daemon', startedAt: completedAt, completedAt,
  expiresAt: new Date(Date.parse(completedAt) + 30 * 86_400_000).toISOString(), recipientSha256: hash(await readFile(env.BACKUP_RECIPIENT_CERT)),
  runtimeFencing: { daemonId: 'fixture-daemon', containers: [{ containerId: 'b'.repeat(64), state: 'exited' }] },
  postgres: pg, minio, vault };
const helper = '/fixture-code/joint-backup.mjs';
const published = JSON.parse(run('node', [helper, 'publish', installationId, backupId], JSON.stringify(manifest)));
assert.match(published.manifestSha256, /^[a-f0-9]{64}$/);
const readArguments = [helper, 'read', installationId, backupId, published.manifestSha256];
assert.deepEqual(JSON.parse(run('node', readArguments)), manifest);
run('node', [helper, 'read', installationId, backupId, '0'.repeat(64)], undefined, false);
run('node', [helper, 'publish', installationId, backupId], JSON.stringify(manifest), false);
const minioPath = `${env.BACKUP_DIR}/${minio.directory}/manifest.json`;
const original = await readFile(minioPath);
await json(minioPath, { installationId: 'foreign' });
run('node', readArguments, undefined, false);
await writeFile(minioPath, original);
run('node', [helper, 'read', 'foreign', backupId, published.manifestSha256], undefined, false);
const encrypted = published.directory + '/00000000.cms';
const corrupt = await readFile(encrypted);
corrupt[corrupt.length - 1] ^= 1;
await writeFile(encrypted, corrupt);
run('node', readArguments, undefined, false);
// Private directory ownership and permissions were not widened to make maintenance work.
const root = await lstat('/fixture/backup');
assert.equal(root.uid, 999);
assert.equal(root.mode & 0o777, 0o700);
process.stdout.write('Joint encrypted manifest binding and corruption gate passed; component payloads are fixtures.\n');
