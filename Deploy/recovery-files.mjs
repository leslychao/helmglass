import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readProtectedFile, replaceProtectedFile, writeProtectedFile } from './protected-files.mjs';

export async function readRecoveryState(directory) {
  let value;
  try { value = JSON.parse((await readProtectedFile(join(directory, 'recovery-state.json'))).toString()); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (value.schemaVersion !== 1 || !['FENCING', 'RESTORING', 'RECONCILING', 'READY'].includes(value.stage)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.recoveryId ?? '')
      || typeof value.backupId !== 'string'
      || !value.backupId || typeof value.daemonId !== 'string' || !value.daemonId
      || (value.stage === 'READY' && !value.redisVolume)
      || (value.redisVolume !== undefined && !/^helm-glass-redis-recovery-[a-f0-9-]{36}$/.test(value.redisVolume))) {
    throw new Error('Invalid deployment recovery state; admission remains closed');
  }
  return value;
}

export function applyRecoveryTargets(environment, state) {
  environment.REDIS_DATA_VOLUME = state?.redisVolume ?? 'helm-glass_redis-data';
  environment.PG_DATA_VOLUME = 'helm-glass_pg-data';
  environment.VAULT_DATA_VOLUME = 'helm-glass_vault-data';
  if (!state?.storage) return;
  const suffix = state.recoveryId;
  if (state.storage.postgresVolume !== `helm-glass-pg-recovery-${suffix}`
      || state.storage.vaultVolume !== `helm-glass-vault-recovery-${suffix}`
      || !Array.isArray(state.storage.minioDirectories) || state.storage.minioDirectories.length !== 4
      || new Set(state.storage.minioDirectories).size !== 4
      || state.storage.minioDirectories.some(value => !/^\/[A-Za-z0-9/_-]+$/.test(value)
        || value.includes('//') || value.endsWith('/'))) {
    throw new Error('Recovery storage selection is invalid; admission remains closed');
  }
  environment.PG_DATA_VOLUME = state.storage.postgresVolume;
  environment.VAULT_DATA_VOLUME = state.storage.vaultVolume;
  state.storage.minioDirectories.forEach((path, index) => { environment[`MINIO_DISK_${index + 1}_DIR`] = path; });
}

export async function saveRecoveryState(directory, value) {
  const path = join(directory, 'recovery-state.json');
  let bytes;
  try { bytes = await readProtectedFile(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) await replaceProtectedFile(path, value, createHash('sha256').update(bytes).digest('hex'));
  else await writeProtectedFile(path, value);
}

/** Allocation is idempotent by recovery id; existing data is never erased or accepted as fresh. */
export async function prepareRecoveryRedis({ docker, recoveryId, daemonId, image }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(recoveryId)
      || typeof daemonId !== 'string' || !daemonId || typeof image !== 'string' || !image) {
    throw new Error('Invalid Redis recovery input');
  }
  const initialDaemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  if (initialDaemon.ID !== daemonId) throw new Error('Redis recovery selected a different Docker daemon');
  const volume = `helm-glass-redis-recovery-${recoveryId}`;
  const names = (await docker(['volume', 'ls', '--quiet', '--filter', `name=^${volume}$`]))
    .stdout.trim().split(/\s+/).filter(Boolean);
  if (!names.length) {
    await docker(['volume', 'create', '--label', 'com.docker.compose.project=helm-glass',
      '--label', 'com.docker.compose.volume=redis-data', '--label', `helmglass.recovery=${recoveryId}`, volume]);
  }
  const state = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0];
  if (state.Name !== volume || state.Labels?.['helmglass.recovery'] !== recoveryId
      || state.Labels?.['com.docker.compose.project'] !== 'helm-glass') {
    throw new Error('Redis recovery volume belongs to another operation');
  }
  const consumers = (await docker(['ps', '--all', '--quiet', '--filter', `volume=${volume}`])).stdout.trim();
  if (consumers) throw new Error('Redis recovery volume is already attached; reconcile before continuing');
  const result = JSON.parse((await docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '64m',
    '--mount', `type=volume,source=${volume},target=/redis-data`, '--entrypoint', 'node', image,
    '/opt/helm/provision/src/empty-redis-volume.mjs'])).stdout);
  if (result.status !== 'EMPTY') throw new Error('Redis recovery volume was not confirmed empty');
  const observedDaemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  if (observedDaemon.ID !== daemonId) throw new Error('Redis recovery used a different Docker daemon');
  const receipt = { schemaVersion: 1, recoveryId, daemonId, volume, source: 'new-empty-volume',
    observedAt: new Date().toISOString() };
  const bytes = Buffer.from(JSON.stringify(receipt));
  return { receipt, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
