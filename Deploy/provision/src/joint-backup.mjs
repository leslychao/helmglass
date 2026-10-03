import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireValue(value) { if (!value) throw new Error('Invalid joint backup or component evidence'); }
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 65_536 });
  requireValue(result.status === 0);
}
async function privateDirectory(path) {
  requireValue(typeof path === 'string' && path.startsWith('/'));
  const state = await lstat(path);
  requireValue(state.isDirectory() && !state.isSymbolicLink() && (state.mode & 0o077) === 0
    && (state.uid === process.getuid() || process.getuid() === 0));
}
async function bounded(file, maximum = 2_097_152) {
  const state = await lstat(file);
  requireValue(state.isFile() && !state.isSymbolicLink() && state.size > 0 && state.size <= maximum);
  return readFile(file);
}
async function component(root, path, hash) {
  requireValue(sha(hash) && typeof path === 'string' && /^[A-Za-z0-9/_-]+$/.test(path)
    && !path.startsWith('/') && !path.includes('//'));
  const full = join(root, path, 'manifest.json');
  requireValue((await realpath(full)).startsWith((await realpath(root)) + '/'));
  const bytes = await bounded(full);
  requireValue(checksum(bytes) === hash);
  return JSON.parse(bytes);
}
async function verify(root, value, installationId, backupId) {
  requireValue(value.schemaVersion === 1 && value.format === 'helm-joint-cold-v1'
    && value.installationId === installationId && value.backupId === backupId
    && safeId(installationId) && safeId(backupId)
    && typeof value.daemonId === 'string' && value.daemonId
    && sha(value.recipientSha256) && value.runtimeFencing?.daemonId === value.daemonId
    && Array.isArray(value.runtimeFencing.containers) && value.runtimeFencing.containers.length > 0
    && value.runtimeFencing.containers.every(item => sha(item.containerId)
      && ['created', 'exited', 'dead', 'absent'].includes(item.state))
    && Number.isFinite(Date.parse(value.startedAt)) && Number.isFinite(Date.parse(value.completedAt))
    && Date.parse(value.completedAt) >= Date.parse(value.startedAt)
    && Date.parse(value.expiresAt) === Date.parse(value.completedAt) + 30 * 86_400_000);
  const pg = value.postgres;
  requireValue(pg && /^[0-9]+$/.test(pg.systemIdentifier) && /^helm_[a-f0-9]{32}$/.test(pg.restorePoint)
    && /^[A-F0-9]+\/[A-F0-9]+$/.test(pg.restoreLsn)
    && /^[A-F0-9]{24}$/.test(pg.walFile)
    && pg.directory === `postgres/${pg.systemIdentifier}/base/${backupId}`
    && pg.walDirectory === `postgres/${pg.systemIdentifier}/wal/${pg.walFile}`);
  const base = await component(root, pg.directory, pg.manifestSha256);
  requireValue(base.schemaVersion === 1 && base.backupId === backupId
    && base.systemIdentifier === pg.systemIdentifier
    && base.format === 'postgresql-18-plain-tar-cms-chunks-v1');
  await component(root, `${pg.directory}/base`, base.cipherSha256);
  const wal = await component(root, pg.walDirectory, pg.walManifestSha256);
  requireValue(wal.schemaVersion === 1 && wal.systemIdentifier === pg.systemIdentifier && wal.walFile === pg.walFile);
  const minio = value.minio;
  requireValue(minio?.directory === `minio/${installationId}/${backupId}`);
  const objects = await component(root, minio.directory, minio.manifestSha256);
  requireValue(objects.schemaVersion === 1 && objects.format === 'helm-minio-single-v1'
    && objects.installationId === installationId && objects.backupId === backupId
    && Array.isArray(objects.disks) && objects.disks.length === 1);
  for (const [index, disk] of objects.disks.entries()) {
    requireValue(disk.diskIndex === index + 1 && disk.directory === `disk${index + 1}`);
    await component(root, `${minio.directory}/${disk.directory}`, disk.manifestSha256);
  }
  const vault = value.vault;
  requireValue(vault?.directory === `vault/${installationId}/${backupId}`);
  const keys = await component(root, vault.directory, vault.manifestSha256);
  requireValue(keys.schemaVersion === 1 && keys.format === 'helm-vault-raft-v1'
    && keys.installationId === installationId && keys.backupId === backupId);
  await component(root, `${vault.directory}/snapshot`, keys.archiveManifestSha256);
  return value;
}

let work;
try {
  process.umask(0o077);
  const [operation, installationId, backupId, expectedManifestSha256] = process.argv.slice(2);
  requireValue(['publish', 'read'].includes(operation) && safeId(installationId) && safeId(backupId)
    && process.argv.length === (operation === 'read' ? 6 : 5)
    && (operation === 'read' ? sha(expectedManifestSha256) : expectedManifestSha256 === undefined));
  const root = process.env.BACKUP_DIR;
  await privateDirectory(root);
  await privateDirectory(process.env.BACKUP_WORK_DIR);
  work = await mkdtemp(join(process.env.BACKUP_WORK_DIR, 'joint-backup-'));
  const directory = join(root, 'joint', installationId, backupId);
  if (operation === 'publish') {
    let input = '';
    for await (const part of process.stdin) { input += part; requireValue(Buffer.byteLength(input) <= 2_097_152); }
    const value = await verify(root, JSON.parse(input), installationId, backupId);
    requireValue(checksum(await bounded(process.env.BACKUP_RECIPIENT_CERT, 65_536)) === value.recipientSha256);
    await mkdir(join(root, 'joint', installationId), { recursive: true, mode: 0o700 });
    await privateDirectory(join(root, 'joint', installationId));
    const file = join(work, 'joint.json');
    await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    run('/opt/helm/bin/backup-file', ['encrypt', file, directory]);
    const manifestSha256 = checksum(await bounded(join(directory, 'manifest.json')));
    process.stdout.write(JSON.stringify({ directory, manifestSha256, completedAt: value.completedAt,
      expiresAt: value.expiresAt }) + '\n');
  } else {
    requireValue(checksum(await bounded(join(directory, 'manifest.json'))) === expectedManifestSha256);
    const file = join(work, 'joint.json');
    run('/opt/helm/bin/backup-file', ['decrypt', directory, file]);
    const value = await verify(root, JSON.parse(await bounded(file)), installationId, backupId);
    process.stdout.write(JSON.stringify(value) + '\n');
  }
} catch {
  process.stderr.write('Joint backup was not verified or published; protected diagnostics must be inspected.\n');
  process.exitCode = 1;
} finally {
  if (work) await rm(work, { recursive: true, force: true });
}
