import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DISK_PATHS = ['/data1', '/data2', '/data3', '/data4'];

function mountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function mountedDevices(mountInfo, paths = DISK_PATHS) {
  const mounts = mountInfo.trim().split('\n').map(line => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || !/^\d+:\d+$/.test(fields[2] ?? '')) throw new Error('INVALID_MOUNT_TABLE');
    return { device: fields[2], target: mountPath(fields[4]), writable: fields[5].split(',').includes('rw'),
      filesystem: fields[separator + 1] };
  });
  return paths.map(target => {
    const matches = mounts.filter(mount => mount.target === target);
    if (matches.length !== 1 || !matches[0].writable || matches[0].device.startsWith('0:')
        || !['xfs', 'ext4'].includes(matches[0].filesystem)) {
      throw new Error('DEDICATED_WRITABLE_BLOCK_MOUNT_REQUIRED');
    }
    if (mounts.some(mount => mount.target.startsWith(target + '/'))) throw new Error('NESTED_STORAGE_MOUNT');
    return matches[0].device;
  });
}

/** Resolve partitions and encryption mappings to their underlying kernel block disk. */
async function backingDisk(device, sysfsRoot, seen = new Set()) {
  if (seen.has(device) || seen.size >= 16) throw new Error('UNSUPPORTED_BLOCK_TOPOLOGY');
  seen.add(device);
  const directory = await realpath(path.join(sysfsRoot, 'dev/block', device));
  if (!directory.startsWith(path.join(sysfsRoot, 'devices') + path.sep)) throw new Error('INVALID_BLOCK_DEVICE');
  const entries = await readdir(directory);
  if (entries.includes('partition')) {
    const parent = (await readFile(path.join(path.dirname(directory), 'dev'), 'utf8')).trim();
    if (!/^\d+:\d+$/.test(parent)) throw new Error('INVALID_BLOCK_DEVICE');
    return backingDisk(parent, sysfsRoot, seen);
  }
  const slaves = entries.includes('slaves') ? await readdir(path.join(directory, 'slaves')) : [];
  if (slaves.length > 1) throw new Error('ONE_BACKING_DISK_PER_MOUNT_REQUIRED');
  if (slaves.length === 1) {
    const underlying = (await readFile(path.join(directory, 'slaves', slaves[0], 'dev'), 'utf8')).trim();
    if (!/^\d+:\d+$/.test(underlying)) throw new Error('INVALID_BLOCK_DEVICE');
    return backingDisk(underlying, sysfsRoot, seen);
  }
  if (directory.startsWith(path.join(sysfsRoot, 'devices/virtual') + path.sep)) {
    throw new Error('VIRTUAL_OR_FILE_BACKED_DISK_NOT_SUPPORTED');
  }
  // A controller may expose multiple NVMe namespaces backed by the same device.
  const hardware = await realpath(path.join(directory, 'device'));
  if (!hardware.startsWith(path.join(sysfsRoot, 'devices') + path.sep)) throw new Error('INVALID_BLOCK_DEVICE');
  const identities = ['device:' + hardware];
  if (entries.includes('wwid')) {
    const worldwide = (await readFile(path.join(directory, 'wwid'), 'utf8')).trim();
    if (!worldwide || worldwide.length > 1024) throw new Error('INVALID_BLOCK_DEVICE');
    identities.push('wwid:' + worldwide);
  }
  return identities;
}

export async function validateDisks({ mountInfoPath = '/proc/self/mountinfo', sysfsRoot = '/sys',
  paths = DISK_PATHS, expectedUid = 10001 } = {}) {
  const devices = mountedDevices(await readFile(mountInfoPath, 'utf8'), paths);
  const used = new Set();
  for (const [index, directory] of paths.entries()) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid
        || (metadata.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
      throw new Error('PRIVATE_STORAGE_DIRECTORY_REQUIRED');
    }
    await access(directory, constants.W_OK | constants.R_OK | constants.X_OK);
    if ((await readdir(directory)).includes('.helm-restore-pending')) throw new Error('STORAGE_RESTORE_INCOMPLETE');
    const identities = await backingDisk(devices[index], sysfsRoot);
    if (identities.some(identity => used.has(identity))) throw new Error('STORAGE_MOUNTS_SHARE_BACKING_DISK');
    for (const identity of identities) used.add(identity);
  }
  return paths;
}
