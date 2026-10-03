import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';

export const DISK_PATHS = ['/data'];

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
    if (matches.length !== 1 || !matches[0].writable
        || ['tmpfs', 'ramfs', 'overlay'].includes(matches[0].filesystem)) {
      throw new Error('PERSISTENT_WRITABLE_MOUNT_REQUIRED');
    }
    if (mounts.some(mount => mount.target.startsWith(target + '/'))) throw new Error('NESTED_STORAGE_MOUNT');
    return matches[0].device;
  });
}

export async function validateDisks({ mountInfoPath = '/proc/self/mountinfo',
  paths = DISK_PATHS, expectedUid = 10001 } = {}) {
  mountedDevices(await readFile(mountInfoPath, 'utf8'), paths);
  for (const directory of paths) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid
        || (metadata.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
      throw new Error('PRIVATE_STORAGE_DIRECTORY_REQUIRED');
    }
    await access(directory, constants.W_OK | constants.R_OK | constants.X_OK);
    if ((await readdir(directory)).includes('.helm-restore-pending')) throw new Error('STORAGE_RESTORE_INCOMPLETE');

  }
  return paths;
}
