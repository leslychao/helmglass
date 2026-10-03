import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { protectDirectory, readProtectedFile, writeProtectedFile } from './protected-files.mjs';
import { prepareRecoveryRedis, saveRecoveryState } from './recovery-files.mjs';

const names = ['proof.json', 'deletion-ledger.json', 'fencing.json', 'redis.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function verifyEvidence(files, state, fencing, restorePoint) {
  const old = JSON.parse(files['fencing.json']);
  const redis = JSON.parse(files['redis.json']);
  const ledger = JSON.parse(files['deletion-ledger.json']);
  const stopped = new Map(fencing.receipt.containers.map(value => [value.containerId, value]));
  if (old.daemonId !== state.daemonId || !Array.isArray(old.containers) || !old.containers.length
      || old.containers.some(value => !stopped.has(value.containerId)
        || stopped.get(value.containerId).service !== value.service)
      || redis.schemaVersion !== 1 || redis.recoveryId !== state.recoveryId || redis.daemonId !== state.daemonId
      || redis.volume !== `helm-glass-redis-recovery-${state.recoveryId}` || redis.source !== 'new-empty-volume'
      || ledger.schemaVersion !== 1 || ledger.recoveryId !== state.recoveryId || ledger.backupId !== state.backupId
      || ledger.restorePoint !== restorePoint || ledger.source !== 'independent-current') {
    throw new Error('Recovery retry does not match its immutable evidence');
  }
  return redis;
}

/** Called after physical restore, while the deployment maintenance owner still holds ingress closed. */
export async function prepareRecoveryEvidence({ docker, configuration, release, state, fencing,
  restorePoint, walLossWindow, repository }) {
  if (state.stage !== 'RESTORING' || typeof restorePoint !== 'string' || !restorePoint
      || typeof walLossWindow !== 'string' || !walLossWindow || walLossWindow.length > 1000
      || fencing.receipt.daemonId !== state.daemonId) throw new Error('Invalid recovery evidence boundary');
  const directory = await protectDirectory(join(configuration.LOCAL_RECOVERY_DIR, 'recoveries', state.recoveryId), repository);
  const existing = {};
  for (const name of names) {
    try { existing[name] = await readProtectedFile(join(directory, name), name === 'deletion-ledger.json' ? 33_554_432 : 2_097_152); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let files;
  let redis;
  if (existing['proof.json']) {
    if (names.some(name => !existing[name])) throw new Error('A published proof has missing evidence; admission remains closed');
    const proof = JSON.parse(existing['proof.json']);
    redis = verifyEvidence(existing, state, fencing, restorePoint);
    if (proof.recoveryId !== state.recoveryId || proof.backupId !== state.backupId
        || proof.restorePoint !== restorePoint || proof.walLossWindow !== walLossWindow
        || proof.ledgerManifestSha256 !== hash(existing['deletion-ledger.json'])
        || proof.fencingEvidenceSha256 !== hash(existing['fencing.json'])
        || proof.redisEvidenceSha256 !== hash(existing['redis.json'])) {
      throw new Error('Recovery retry does not match its immutable evidence');
    }
    files = existing;
  } else {
    // Evidence is persisted before the proof. An interrupted staging run reuses each exact byte string.
    const redisEvidence = existing['redis.json'] ? { bytes: existing['redis.json'],
      receipt: JSON.parse(existing['redis.json']) } : await prepareRecoveryRedis({ docker,
      recoveryId: state.recoveryId, daemonId: state.daemonId, image: release.PROVISION_IMAGE });
    redis = redisEvidence.receipt;
    const fencingBytes = existing['fencing.json'] ?? fencing.bytes;
    const ledgerBytes = existing['deletion-ledger.json'] ?? Buffer.from((await docker([
      'run', '--rm', '--interactive', '--network', 'none', '--read-only', '--user', '10001:10001',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '128m',
      '--log-driver', 'none', '--mount', `type=bind,source=${configuration.DELETION_LEDGER_DIR},target=/ledger,readonly`,
      '--entrypoint', 'node', release.PROVISION_IMAGE, '/opt/helm/provision/src/ledger-files.mjs',
    ], { input: JSON.stringify({ schemaVersion: 1, installationId: configuration.INSTALLATION_ID,
      mode: 'manifest', recoveryId: state.recoveryId, backupId: state.backupId, restorePoint }), maximum: 33_554_432 })).stdout);
    files = { 'fencing.json': fencingBytes, 'redis.json': redisEvidence.bytes, 'deletion-ledger.json': ledgerBytes };
    verifyEvidence(files, state, fencing, restorePoint);
    for (const [name, bytes] of Object.entries(files)) {
      if (!existing[name]) await writeProtectedFile(join(directory, name), bytes);
    }
    files['proof.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, recoveryId: state.recoveryId,
      backupId: state.backupId, restorePoint, walLossWindow, runtimeFenced: true,
      runtimeFencing: JSON.parse(fencingBytes), fencingEvidenceSha256: hash(fencingBytes),
      transientRedisDiscarded: true, redisEvidenceSha256: hash(redisEvidence.bytes),
      ledgerManifestSha256: hash(ledgerBytes) }));
    await writeProtectedFile(join(directory, 'proof.json'), files['proof.json']);
  }
  const volume = `helm-glass-proof-recovery-${state.recoveryId}`;
  const present = (await docker(['volume', 'ls', '--quiet', '--filter', `name=^${volume}$`])).stdout.trim();
  if (!present) await docker(['volume', 'create', '--label', `helmglass.recovery=${state.recoveryId}`,
    '--label', `helmglass.installation=${configuration.INSTALLATION_ID}`, volume]);
  const descriptor = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0];
  if (descriptor.Name !== volume || descriptor.Labels?.['helmglass.recovery'] !== state.recoveryId
      || descriptor.Labels?.['helmglass.installation'] !== configuration.INSTALLATION_ID) {
    throw new Error('Recovery proof volume has another owner');
  }
  const staged = JSON.parse((await docker(['run', '--rm', '--interactive', '--network', 'none', '--read-only',
    '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '256m', '--log-driver', 'none',
    '--mount', `type=volume,source=${volume},target=/recovery`, '--entrypoint', 'node', release.PROVISION_IMAGE,
    '/opt/helm/provision/src/recovery-material.mjs'], { input: JSON.stringify({ schemaVersion: 1,
      installationId: configuration.INSTALLATION_ID, recoveryId: state.recoveryId, mode: 'proof',
      files: Object.fromEntries(names.map(name => [name, files[name].toString('base64')])) }) })).stdout);
  if (staged.state !== 'STAGED' || names.some(name => staged.hashes[name] !== hash(files[name]))) {
    throw new Error('Daemon-side recovery proof differs from the protected original');
  }
  const next = { ...state, stage: 'RECONCILING', redisVolume: redis.volume, proofVolume: volume,
    proofSha256: hash(files['proof.json']) };
  await saveRecoveryState(configuration.LOCAL_SECRETS_DIR, next);
  return next;
}

/** Only the minimal Java recovery process emits this marker after reading its durable transaction. */
export function parseRecoveryStatus(output, state) {
  let receipt;
  for (const line of output.split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.log?.logger === 'com.helmglass.bootstrap.RecoveryApplication'
        && typeof entry.message === 'string' && entry.message.startsWith('HELM_RECOVERY_STATUS ')) {
      if (receipt) throw new Error('Duplicate recovery status receipt');
      receipt = JSON.parse(entry.message.slice('HELM_RECOVERY_STATUS '.length));
    }
  }
  if (!receipt || receipt.recoveryId !== state.recoveryId || receipt.proofHash !== state.proofSha256
      || !['FENCING', 'LEDGER', 'PURGING', 'READY'].includes(receipt.state)
      || !['RECOVERING', 'READY'].includes(receipt.admissionState)) {
    throw new Error('Recovery status was not confirmed by its durable owner');
  }
  return receipt;
}
