import { runRecoveryContainer } from './recovery-container.mjs';

export const bind = (source, target, readonly = false) => ['--mount',
  `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
const volumeMount = (name, target) => ['--mount', `type=volume,source=${name},target=${target},volume-nocopy`];
const restrictions = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64'];

export async function ensureRecoveryVolume({ docker, state, installationId, kind }) {
  const owner = { postgres: ['pg', 'pg-data'], vault: ['vault', 'vault-data'] }[kind];
  if (!owner) throw new Error('Invalid recovery volume owner');
  const name = `helm-glass-${owner[0]}-recovery-${state.recoveryId}`;
  const matches = (await docker(['volume', 'ls', '--quiet', '--filter', `name=^${name}$`])).stdout.trim();
  if (!matches) await docker(['volume', 'create', '--label', `helmglass.installation=${installationId}`,
    '--label', `helmglass.recovery=${state.recoveryId}`, '--label', 'com.docker.compose.project=helm-glass',
    '--label', `com.docker.compose.volume=${owner[1]}`, name]);
  const value = JSON.parse((await docker(['volume', 'inspect', name])).stdout)[0];
  if (value.Name !== name || value.Labels?.['helmglass.installation'] !== installationId
      || value.Labels?.['helmglass.recovery'] !== state.recoveryId
      || value.Labels?.['com.docker.compose.volume'] !== owner[1]) {
    throw new Error('Recovery storage volume has another owner');
  }
  return name;
}

export async function stageRecoveryMaterial({ docker, configuration, release, state, mode, input = {}, mounts = [] }) {
  return JSON.parse((await docker(['run', '--rm', '--interactive', '--network', 'none', '--read-only',
    '--user', '0:0', ...restrictions, '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
    '--memory', '128m', '--log-driver', 'none', ...bind(configuration.BACKUP_WORK_DIR, '/backup-work'), ...mounts,
    '--entrypoint', 'node', release.PROVISION_IMAGE, '/opt/helm/provision/src/recovery-material.mjs'], {
    input: JSON.stringify({ schemaVersion: 1, installationId: configuration.INSTALLATION_ID,
      recoveryId: state.recoveryId, mode, ...input }) })).stdout);
}

export function decryptionMounts(configuration, recoveryId) {
  return [...bind(configuration.BACKUP_DIR, '/backup', true), ...bind(configuration.BACKUP_WORK_DIR, '/backup-work'),
    '-e', 'BACKUP_DIR=/backup', '-e', 'BACKUP_WORK_DIR=/backup-work',
    '-e', `BACKUP_PRIVATE_KEY_FILE=/backup-work/recovery-${recoveryId}/private.pem`,
    '-e', `BACKUP_KEY_PASSWORD_FILE=/backup-work/recovery-${recoveryId}/password`];
}

export async function restorePostgres({ docker, configuration, release, state, manifest, saveState }) {
  const volume = await ensureRecoveryVolume({ docker, state, installationId: configuration.INSTALLATION_ID, kind: 'postgres' });
  if (volume !== state.storage.postgresVolume) throw new Error('PostgreSQL recovery target changed');
  if (!state.physical?.postgresPrepared) {
    const prepared = await stageRecoveryMaterial({ docker, configuration, release, state, mode: 'pg-parent',
      mounts: volumeMount(volume, '/storage') });
    if (prepared.state !== 'EMPTY_PG_PARENT') throw new Error('PostgreSQL target was not confirmed empty');
    state = { ...state, physical: { ...state.physical, postgresPrepared: true } };
    await saveState(state);
  }
  const common = { docker, recoveryId: state.recoveryId, installationId: configuration.INSTALLATION_ID,
    image: release.POSTGRES_IMAGE, options: ['--user', '999:999', ...restrictions, '--memory', '512m',
      '--tmpfs', '/tmp:size=32m,mode=0700,uid=999,gid=999',
      '--tmpfs', '/var/run/postgresql:size=16m,mode=0700,uid=999,gid=999',
      ...volumeMount(volume, '/var/lib/postgresql'), ...decryptionMounts(configuration, state.recoveryId),
      '-e', `BACKUP_SYSTEM_IDENTIFIER=${manifest.postgres.systemIdentifier}`] };
  const base = await runRecoveryContainer({ ...common, step: 'postgres-base', entrypoint: '/opt/helm/bin/restore-base',
    arguments: [`/backup/${manifest.postgres.directory}`, '/var/lib/postgresql/18/docker', 'name', manifest.postgres.restorePoint] });
  const restored = await runRecoveryContainer({ ...common, step: 'postgres-pitr', entrypoint: '/opt/helm/bin/recover-and-stop',
    arguments: ['/var/lib/postgresql/18/docker', manifest.postgres.systemIdentifier,
      manifest.postgres.restorePoint, manifest.postgres.restoreLsn], timeout: 600_000 });
  const receipt = JSON.parse(restored.output);
  if (receipt.schemaVersion !== 1 || receipt.state !== 'PROMOTED_AND_STOPPED'
      || receipt.systemIdentifier !== manifest.postgres.systemIdentifier
      || receipt.targetName !== manifest.postgres.restorePoint || receipt.targetLsn !== manifest.postgres.restoreLsn) {
    throw new Error('PostgreSQL did not confirm the exact backup point and clean shutdown');
  }
  const next = { ...state, physical: { ...state.physical, postgres: {
    ...receipt, baseContainer: base.containerId, recoveryContainer: restored.containerId } } };
  await saveState(next);
  return next;
}

export async function verifyMinioTargets({ docker, release, directories, requireEmpty }) {
  const code = "import{validateDisks}from'/opt/helm/minio/disks.mjs';import{readdir}from'node:fs/promises';"
    + 'const disks=await validateDisks();'
    + (requireEmpty ? 'for(const disk of disks)if((await readdir(disk)).length)throw Error("Target is not empty");' : '')
    + 'process.stdout.write(JSON.stringify({state:"VERIFIED",disks:disks.length})+"\\n");';
  const value = JSON.parse((await docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '10001:10001',
    ...restrictions, '--memory', '128m', ...directories.flatMap((path, index) => bind(path, `/data${index + 1}`)),
    '--entrypoint', 'node', release.MINIO_IMAGE, '--input-type=module', '-e', code])).stdout);
  if (value.state !== 'VERIFIED' || value.disks !== 4) throw new Error('Four independent storage disks were not verified');
}

export async function restoreMinio({ docker, configuration, release, state, manifest, saveState }) {
  const restored = await runRecoveryContainer({ docker, recoveryId: state.recoveryId,
    installationId: configuration.INSTALLATION_ID, step: 'minio-disks', image: release.PROVISION_IMAGE,
    entrypoint: 'node', arguments: ['/opt/helm/minio/cold-archive.mjs', 'restore', configuration.INSTALLATION_ID,
      state.backupId, `/backup/${manifest.minio.directory}`, manifest.minio.manifestSha256], options: ['--user', '0:0', ...restrictions,
      '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--memory', '512m',
      '--tmpfs', '/tmp:size=32m,mode=0700', ...decryptionMounts(configuration, state.recoveryId),
      ...state.storage.minioDirectories.flatMap((path, index) => bind(path, `/data${index + 1}`))] });
  const receipt = JSON.parse(restored.output);
  if (receipt.installationId !== configuration.INSTALLATION_ID || receipt.backupId !== state.backupId
      || receipt.state !== 'RESTORED' || receipt.restoredDisks !== 4
      || receipt.manifestSha256 !== manifest.minio.manifestSha256) throw new Error('MinIO disk restore was not confirmed');
  await verifyMinioTargets({ docker, release, directories: state.storage.minioDirectories, requireEmpty: false });
  const next = { ...state, physical: { ...state.physical,
    minio: { ...receipt, recoveryContainer: restored.containerId } } };
  await saveState(next);
  return next;
}
