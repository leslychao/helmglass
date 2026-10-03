import { isAbsolute } from 'node:path';
import { IMAGE_NAMES } from './configuration.mjs';

const fields = ['schemaVersion', 'installationId', 'recoveryId', 'backupId', 'jointManifestSha256',
  'privateKeyFile', 'keyPasswordFile', 'minioDirectories', 'walLossWindow'];
const overlaps = (left, right) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');

/** Operator-selected sources and new targets. This never generates replacement credentials or reuses live disks. */
export function validateRestorePlan(value, configuration, previous) {
  if (!value || Object.keys(value).some(name => !fields.includes(name)) || value.schemaVersion !== 1
      || value.installationId !== configuration.INSTALLATION_ID
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.recoveryId ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value.backupId ?? '')
      || !/^[a-f0-9]{64}$/.test(value.jointManifestSha256 ?? '')
      || typeof value.walLossWindow !== 'string' || !value.walLossWindow.trim()
      || value.walLossWindow.length > 1000 || /[\0\r\n]/.test(value.walLossWindow)
      || !Array.isArray(value.minioDirectories) || value.minioDirectories.length !== 1) {
    throw new Error('Restore plan must identify the installation, immutable backup and loss boundary');
  }
  for (const name of ['privateKeyFile', 'keyPasswordFile']) {
    if (typeof value[name] !== 'string' || !isAbsolute(value[name]) || /[\0\r\n]/.test(value[name])) {
      throw new Error('Restore decryption material must use absolute protected local file paths');
    }
  }
  if (value.privateKeyFile === value.keyPasswordFile) throw new Error('Restore key and password files must be distinct');
  const protectedPaths = ['BACKUP_DIR', 'BACKUP_WORK_DIR', 'DELETION_LEDGER_DIR', 'SECRETS_DIR',
    'MINIO_DATA_DIR'].map(name => configuration[name]);
  // A completed previous restore is the current installation, not scratch space for the next one.
  if (previous?.stage === 'READY') protectedPaths.push(...previous.storage?.minioDirectories ?? []);
  for (const [index, path] of value.minioDirectories.entries()) {
    if (typeof path !== 'string' || !/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes('//')
        || path.endsWith('/') || path.split('/').filter(Boolean).length < 3
        || [...protectedPaths, ...value.minioDirectories.slice(0, index)].some(other => other && overlaps(path, other))) {
      throw new Error('Restore requires one new data path outside all current storage and protected inputs');
    }
  }
  return value;
}

export function requireBackupRelease(manifest, release) {
  if (!manifest.release || Object.keys(manifest.release).length !== IMAGE_NAMES.length
      || IMAGE_NAMES.some(name => manifest.release[name] !== release[name])) {
    throw new Error('Restore must use the exact release recorded in the joint backup');
  }
}
