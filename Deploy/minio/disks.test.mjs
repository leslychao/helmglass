import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mountedDevices, validateDisks } from './disks.mjs';

test('single data directory requires an explicit writable persistent mount', () => {
  const mount = '1 0 8:1 /minio /data rw - ext4 /dev/disk1 rw';
  assert.deepEqual(mountedDevices(mount), ['8:1']);
  assert.throws(() => mountedDevices(mount.replace('/data rw', '/data ro')), /PERSISTENT_WRITABLE/);
  assert.throws(() => mountedDevices(mount.replace('ext4', 'tmpfs')), /PERSISTENT_WRITABLE/);
  assert.throws(() => mountedDevices(mount.replace('/data', '/other')), /PERSISTENT_WRITABLE/);
  assert.throws(() => mountedDevices(mount + '\n2 1 8:2 / /data/nested rw - xfs /dev/disk2 rw'), /NESTED/);
});

test('data directory rejects public permissions, symlinks and incomplete restoration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'helm-minio-data-'));
  try {
    const directory = path.join(root, 'data');
    await mkdir(directory, { mode: 0o700 });
    const mountInfoPath = path.join(root, 'mountinfo');
    await writeFile(mountInfoPath, '1 0 8:1 /minio ' + directory + ' rw - ext4 /dev/disk1 rw');
    const options = { mountInfoPath, paths: [directory], expectedUid: process.getuid() };
    assert.deepEqual(await validateDisks(options), [directory]);
    await chmod(directory, 0o755);
    await assert.rejects(validateDisks(options), /PRIVATE_STORAGE/);
    await chmod(directory, 0o700);
    await writeFile(path.join(directory, '.helm-restore-pending'), '{}');
    await assert.rejects(validateDisks(options), /RESTORE_INCOMPLETE/);
    await rm(directory, { recursive: true });
    await mkdir(path.join(root, 'other'), { mode: 0o700 });
    await symlink(path.join(root, 'other'), directory);
    await assert.rejects(validateDisks(options), /PRIVATE_STORAGE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
