import { createHash } from 'node:crypto';
import { createReadStream, openSync, closeSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rm, statfs, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

const disks = ['/data'];
const reserveBytes = 134_217_728;
const maximumDiskBytes = 4 * 1024 ** 4;
const maximumEntries = 1_000_000;
const [operation, installationId, backupId, source, expectedManifestSha256] = process.argv.slice(2);

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function run(command, arguments_, outputFile) {
  const descriptor = outputFile === undefined ? undefined : openSync(outputFile, 'wx', 0o600);
  try {
    const result = spawnSync(command, arguments_, { encoding: 'utf8', timeout: 21_600_000,
      maxBuffer: 16_384, stdio: ['ignore', descriptor ?? 'pipe', 'pipe'] });
    requireCondition(result.status === 0, 'ARCHIVE_TOOL_FAILED');
    return result.stdout?.trim() ?? '';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function privateDirectory(directory, empty = false, storage = false) {
  requireCondition(typeof directory === 'string' && path.isAbsolute(directory), 'PRIVATE_DIRECTORY_REQUIRED');
  const metadata = await lstat(directory);
  const uid = process.getuid();
  const ownerAllowed = storage ? metadata.uid === 10001
    : metadata.uid === uid || (uid === 0 && metadata.uid === 999);
  requireCondition(metadata.isDirectory() && !metadata.isSymbolicLink()
    && ownerAllowed && (metadata.mode & 0o077) === 0, 'PRIVATE_DIRECTORY_REQUIRED');
  if (empty) requireCondition((await readdir(directory)).length === 0, 'RESTORE_TARGET_NOT_EMPTY');
}

async function jsonFile(file, maximum = 16_384, expectedHash) {
  const metadata = await lstat(file);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0
    && metadata.size <= maximum, 'INVALID_MANIFEST');
  const bytes = await readFile(file);
  if (expectedHash) requireCondition(createHash('sha256').update(bytes).digest('hex') === expectedHash, 'ARCHIVE_CHECKSUM_MISMATCH');
  return JSON.parse(bytes.toString('utf8'));
}

async function writeJson(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function requireSpace(directory, bytes) {
  const filesystem = await statfs(directory, { bigint: true });
  requireCondition(filesystem.bavail * filesystem.bsize >= BigInt(bytes + reserveBytes), 'INSUFFICIENT_ENCRYPTED_SCRATCH');
}

async function estimateTar(directory, depth = 0, counter = { entries: 0 }) {
  requireCondition(depth <= 128, 'SOURCE_TREE_TOO_DEEP');
  let bytes = 8192;
  for await (const entry of await opendir(directory)) {
    requireCondition(++counter.entries <= maximumEntries, 'SOURCE_TREE_TOO_LARGE');
    requireCondition(entry.name !== '.helm-restore-pending', 'SOURCE_RESTORE_INCOMPLETE');
    const file = path.join(directory, entry.name);
    const metadata = await lstat(file);
    requireCondition(!metadata.isSymbolicLink(), 'SOURCE_LINK_NOT_SUPPORTED');
    if (metadata.isDirectory()) bytes += await estimateTar(file, depth + 1, counter);
    else {
      requireCondition(metadata.isFile(), 'SOURCE_SPECIAL_FILE_NOT_SUPPORTED');
      bytes += Math.ceil(metadata.size / 512) * 512 + 8192;
    }
    requireCondition(bytes <= maximumDiskBytes, 'SOURCE_TREE_TOO_LARGE');
  }
  return bytes;
}

async function validateTar(file, work, diskIndex) {
  const listing = path.join(work, `listing-${diskIndex}`);
  const types = path.join(work, `types-${diskIndex}`);
  run('tar', ['--list', '--quoting-style=escape', '--file', file], listing);
  run('tar', ['--list', '--verbose', '--quoting-style=escape', '--file', file], types);
  let count = 0;
  for await (const name of createInterface({ input: createReadStream(listing), crlfDelay: Infinity })) {
    requireCondition(++count <= maximumEntries && name.length <= 4096 && !name.includes('\\')
      && !path.posix.isAbsolute(name) && !name.split('/').includes('..')
      && (name === 'metadata.json' || name === 'data' || name.startsWith('data/')), 'UNSAFE_TAR_ENTRY');
  }
  requireCondition(count > 1, 'INVALID_TAR_ARCHIVE');
  for await (const line of createInterface({ input: createReadStream(types), crlfDelay: Infinity })) {
    requireCondition(/^[-d]/.test(line), 'TAR_LINK_OR_SPECIAL_FILE');
  }
  const descriptor = JSON.parse(run('tar', ['--extract', '--to-stdout', '--file', file, 'metadata.json']));
  requireCondition(descriptor.schemaVersion === 1 && descriptor.format === 'helm-minio-single-v1'
    && descriptor.installationId === installationId && descriptor.backupId === backupId
    && descriptor.diskIndex === diskIndex, 'ARCHIVE_IDENTITY_MISMATCH');
  await unlink(listing);
  await unlink(types);
}

async function backup(work, root) {
  await privateDirectory(root);
  const resolved = await realpath(root);
  requireCondition(!disks.some(disk => resolved === disk || resolved.startsWith(disk + '/')), 'BACKUP_INSIDE_STORAGE');
  const destinationParent = path.join(root, 'minio', installationId);
  await mkdir(destinationParent, { recursive: true, mode: 0o700 });
  await privateDirectory(destinationParent);
  const destination = path.join(destinationParent, backupId);
  try { await lstat(destination); throw new Error('BACKUP_ID_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const estimates = [];
  for (const disk of disks) estimates.push(await estimateTar(disk));
  await requireSpace(root, estimates.reduce((total, bytes) => total + bytes, 0));
  const pending = await mkdtemp(path.join(destinationParent, '.pending-'));
  try {
    const manifest = { schemaVersion: 1, format: 'helm-minio-single-v1', installationId, backupId,
      capturedAt: new Date().toISOString(), disks: [] };
    for (const [index, disk] of disks.entries()) {
      await requireSpace(work, estimates[index]);
      const metadata = { schemaVersion: 1, format: manifest.format, installationId, backupId, diskIndex: index + 1 };
      await writeJson(path.join(work, 'metadata.json'), metadata);
      const tar = path.join(work, 'disk.tar');
      run('tar', ['--create', '--file', tar, '--directory', work, 'metadata.json',
        '--directory', disk, '.', '--transform', 's,^\\.$,data,;s,^\\./,data/,']);
      await validateTar(tar, work, index + 1);
      const directory = 'disk' + (index + 1);
      run('/opt/helm/bin/backup-file', ['encrypt', tar, path.join(pending, directory)]);
      manifest.disks.push({ diskIndex: index + 1, directory, plaintextByteLength: (await lstat(tar)).size,
        manifestSha256: await sha256(path.join(pending, directory, 'manifest.json')) });
      await unlink(tar);
      await unlink(path.join(work, 'metadata.json'));
    }
    await writeJson(path.join(pending, 'manifest.json'), manifest);
    run('sync', ['-f', pending]);
    run('mv', ['-T', '--no-clobber', '--', pending, destination]);
    try { await lstat(pending); throw new Error('BACKUP_PUBLICATION_RACE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    run('sync', ['-f', destinationParent]);
    process.stdout.write(JSON.stringify({ directory: destination, manifestSha256: await sha256(path.join(destination, 'manifest.json')) }) + '\n');
  } finally { await rm(pending, { recursive: true, force: true }); }
}

async function restore(work) {
  const manifest = await jsonFile(path.join(source, 'manifest.json'), 16_384, expectedManifestSha256);
  requireCondition(manifest.schemaVersion === 1 && manifest.format === 'helm-minio-single-v1'
    && manifest.installationId === installationId && manifest.backupId === backupId
    && Array.isArray(manifest.disks) && manifest.disks.length === 1, 'INVALID_ARCHIVE_MANIFEST');
  let requiredBytes = 0;
  for (const [index, disk] of manifest.disks.entries()) {
    requireCondition(disk.diskIndex === index + 1 && disk.directory === 'disk' + (index + 1)
      && Number.isSafeInteger(disk.plaintextByteLength) && disk.plaintextByteLength > 0
      && disk.plaintextByteLength <= maximumDiskBytes && /^[0-9a-f]{64}$/.test(disk.manifestSha256), 'INVALID_DISK_MANIFEST');
    const chunkManifest = path.join(source, disk.directory, 'manifest.json');
    const metadata = await lstat(chunkManifest);
    requireCondition(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 67_108_864
      && await sha256(chunkManifest) === disk.manifestSha256, 'ARCHIVE_CHECKSUM_MISMATCH');
    requireCondition(run('jq', ['-er', '.plaintextByteLength', chunkManifest]) === String(disk.plaintextByteLength), 'ARCHIVE_SIZE_MISMATCH');
    requiredBytes += disk.plaintextByteLength;
    await requireSpace(disks[index], disk.plaintextByteLength);
  }
  await requireSpace(work, requiredBytes);
  for (const disk of manifest.disks) {
    const tar = path.join(work, 'disk' + disk.diskIndex + '.tar');
    run('/opt/helm/bin/backup-file', ['decrypt', path.join(source, disk.directory), tar, disk.manifestSha256]);
    await validateTar(tar, work, disk.diskIndex);
  }
  // The data archive is authenticated before any target is touched. Failed extraction
  // leaves this marker on every target; the MinIO runtime refuses partial restores.
  for (const disk of disks) await writeJson(path.join(disk, '.helm-restore-pending'), { installationId, backupId });
  for (const [index, disk] of disks.entries()) {
    run('tar', ['--extract', '--file', path.join(work, `disk${index + 1}.tar`), '--directory', disk,
      '--strip-components=1', '--no-same-owner', '--no-same-permissions', '--keep-old-files', 'data']);
    if (process.getuid() === 0) run('chown', ['-R', '--no-dereference', '10001:10001', disk]);
    run('sync', ['-f', disk]);
  }
  for (const disk of disks) { await unlink(path.join(disk, '.helm-restore-pending')); run('sync', ['-f', disk]); }
  process.stdout.write(JSON.stringify({ installationId, backupId, restoredDisks: 1, state: 'RESTORED', manifestSha256: expectedManifestSha256 }) + '\n');
}

let work;
try {
  process.umask(0o077);
  requireCondition(['backup', 'restore'].includes(operation) && /^[A-Za-z0-9_-]{1,80}$/.test(installationId ?? '')
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(backupId ?? '')
    && (operation === 'backup' ? process.argv.length === 5 : process.argv.length === 7
      && typeof source === 'string' && /^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '')), 'INVALID_ARCHIVE_ARGUMENTS');
  const workRoot = process.env.BACKUP_WORK_DIR;
  await privateDirectory(workRoot);
  for (const disk of disks) {
    await privateDirectory(disk, operation === 'restore', true);
    requireCondition(workRoot !== disk && !workRoot.startsWith(disk + '/'), 'SCRATCH_INSIDE_STORAGE');
  }
  work = await mkdtemp(path.join(workRoot, 'minio-cold-'));
  if (operation === 'backup') await backup(work, process.env.BACKUP_DIR);
  else await restore(work);
} catch (error) {
  // Archive filenames and bootstrap paths can contain sensitive operator metadata.
  const reason = error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'UNAVAILABLE_OR_INVALID_INPUT';
  process.stderr.write(`MINIO_COLD_ARCHIVE_FAILED: ${reason}\n`);
  process.exitCode = 1;
} finally {
  if (work) await rm(work, { recursive: true, force: true });
}
