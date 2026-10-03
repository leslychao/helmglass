import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mountedDevices, validateDisks } from './disks.mjs';

test('mount table requires four dedicated writable block mounts', () => {
  const lines = [1, 2, 3, 4].map(index => `${index} 0 8:${index} / /data${index} rw - xfs /dev/disk${index} rw`);
  assert.deepEqual(mountedDevices(lines.join('\n')), ['8:1', '8:2', '8:3', '8:4']);
  assert.throws(() => mountedDevices(lines.slice(1).join('\n')), /DEDICATED_WRITABLE/);
  assert.throws(() => mountedDevices(lines.join('\n').replace('8:1', '0:44')), /DEDICATED_WRITABLE/);
  assert.throws(() => mountedDevices(lines.join('\n').replace('/data1 rw', '/data1 ro')), /DEDICATED_WRITABLE/);
  assert.throws(() => mountedDevices(lines.join('\n') + '\n5 1 8:5 / /data1/nested rw - xfs /dev/disk5 rw'), /NESTED/);
});

test('partitions and encrypted mappings cannot count one underlying disk twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'helm-disk-topology-'));
  try {
    const sysfsRoot = path.join(root, 'sys');
    const paths = [1, 2, 3, 4].map(index => path.join(root, 'data' + index));
    await mkdir(path.join(sysfsRoot, 'dev/block'), { recursive: true });
    for (const directory of paths) await mkdir(directory, { mode: 0o700 });
    async function device(name, identity, { partition = false } = {}) {
      const directory = path.join(sysfsRoot, 'devices', name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'dev'), identity);
      if (partition) await writeFile(path.join(directory, 'partition'), '1');
      else await mkdir(path.join(directory, 'slaves'));
      if (!partition && name.startsWith('pci/')) {
        const hardware = path.join(sysfsRoot, 'devices', 'hardware-' + identity);
        await mkdir(hardware);
        await symlink(hardware, path.join(directory, 'device'));
      }
      await symlink(directory, path.join(sysfsRoot, 'dev/block', identity));
      return directory;
    }
    const devices = [];
    for (let index = 0; index < 4; index++) {
      const parent = await device('pci/block/disk' + index, `8:${index * 16}`);
      await device(`pci/block/disk${index}/disk${index}p1`, `8:${index * 16 + 1}`, { partition: true });
      devices.push(parent);
    }
    const mountInfoPath = path.join(root, 'mountinfo');
    async function mount(identities) {
      await writeFile(mountInfoPath, identities.map((identity, index) =>
        `${index + 1} 0 ${identity} / ${paths[index]} rw - xfs /dev/disk${index} rw`).join('\n'));
    }
    const options = { mountInfoPath, sysfsRoot, paths, expectedUid: process.getuid() };
    await mount(['8:1', '8:17', '8:33', '8:49']);
    assert.deepEqual(await validateDisks(options), paths);

    await device('pci/block/disk0/disk0p2', '8:2', { partition: true });
    await mount(['8:1', '8:2', '8:33', '8:49']);
    await assert.rejects(validateDisks(options), /SHARE_BACKING_DISK/);

    const encrypted = await device('virtual/block/dm-0', '253:0');
    await symlink(devices[0], path.join(encrypted, 'slaves/disk0'));
    await mount(['253:0', '8:17', '8:33', '8:49']);
    assert.deepEqual(await validateDisks(options), paths);
    await mount(['253:0', '8:1', '8:33', '8:49']);
    await assert.rejects(validateDisks(options), /SHARE_BACKING_DISK/);

    await device('virtual/block/loop0', '7:0');
    await mount(['7:0', '8:17', '8:33', '8:49']);
    await assert.rejects(validateDisks(options), /FILE_BACKED_DISK/);

    await rm(path.join(devices[1], 'device'));
    await symlink(path.join(sysfsRoot, 'devices/hardware-8:0'), path.join(devices[1], 'device'));
    await mount(['8:1', '8:17', '8:33', '8:49']);
    await assert.rejects(validateDisks(options), /SHARE_BACKING_DISK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
