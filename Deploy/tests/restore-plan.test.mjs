import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { validateRestorePlan, requireBackupRelease } from '../restore-plan.mjs';
import { IMAGE_NAMES } from '../configuration.mjs';

const configuration = { INSTALLATION_ID: 'fixture', BACKUP_DIR: '/srv/backup/data',
  BACKUP_WORK_DIR: '/srv/scratch/data', DELETION_LEDGER_DIR: '/srv/ledger/data', SECRETS_DIR: '/srv/secrets/data',
  ...Object.fromEntries([1, 2, 3, 4].map(index => [`MINIO_DISK_${index}_DIR`, `/srv/disk${index}/current`])) };
const plan = { schemaVersion: 1, installationId: 'fixture', recoveryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  backupId: 'backup-one', jointManifestSha256: 'a'.repeat(64),
  privateKeyFile: resolve('fixture/private.pem'), keyPasswordFile: resolve('fixture/password'),
  minioDirectories: [1, 2, 3, 4].map(index => `/srv/new${index}/data`), walLossWindow: 'Since the named backup point' };

test('Restore plan rejects current, nested, shared and previously restored storage', () => {
  assert.equal(validateRestorePlan(plan, configuration), plan);
  for (const path of ['/srv/disk1/current', '/srv/disk1/current/child', '/srv/disk1',
    '/srv/backup/data/child', '/srv/new2/data', '/srv/new2/data/child', '/srv/new1/../data']) {
    assert.throws(() => validateRestorePlan({ ...plan, minioDirectories: [path, ...plan.minioDirectories.slice(1)] }, configuration));
  }
  assert.throws(() => validateRestorePlan(plan, configuration,
    { stage: 'READY', storage: { minioDirectories: [plan.minioDirectories[0]] } }));
  assert.throws(() => validateRestorePlan({ ...plan, installationId: 'other' }, configuration));
  assert.throws(() => validateRestorePlan({ ...plan, privateKeyFile: 'relative.key' }, configuration));
  assert.throws(() => validateRestorePlan({ ...plan, jointManifestSha256: '' }, configuration));
  assert.throws(() => validateRestorePlan({ ...plan, walLossWindow: '' }, configuration));
});

test('Recovery requires the entire immutable backup release, without partial component upgrades', () => {
  const release = Object.fromEntries(IMAGE_NAMES.map(name => [name, 'sha256:' + '1'.repeat(64)]));
  requireBackupRelease({ release }, release);
  assert.throws(() => requireBackupRelease({ release: { ...release, API_IMAGE: 'sha256:' + '2'.repeat(64) } }, release));
  const missing = { ...release };
  delete missing.API_IMAGE;
  assert.throws(() => requireBackupRelease({ release: missing }, release));
});
