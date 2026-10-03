import { setTimeout as delay } from 'node:timers/promises';
import { run } from './process.mjs';

const stages = ['INITIALIZING', 'TEMPORARY_READY', 'RESTORE_STARTED', 'RESTORE_ACCEPTED', 'VERIFIED'];
function requireValue(value, code) { if (!value) throw new Error(code); }
function validShares(shares, threshold) {
  return Array.isArray(shares) && shares.length >= threshold && shares.length <= 255
    && new Set(shares).size === shares.length
    && shares.every(value => typeof value === 'string' && /^[A-Za-z0-9+/=]{16,1024}$/.test(value));
}

/** Restores an explicitly isolated replacement Vault; the caller owns physical fencing and custody. */
export async function restoreVault({ containerId, recoveryId, manifest, originalShares,
  temporaryCustody, progress, saveTemporaryCustody, saveProgress, runArchive, environment = process.env }) {
  requireValue(/^[a-f0-9]{64}$/.test(containerId) && /^[a-f0-9-]{36}$/.test(recoveryId), 'INVALID_VAULT_RECOVERY_IDENTITY');
  const seal = manifest?.sealConfig;
  requireValue(manifest?.schemaVersion === 1 && manifest.format === 'helm-vault-raft-v1'
    && /^[a-f0-9-]{36}$/.test(manifest.clusterId) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(manifest.backupId)
    && seal?.type === 'shamir' && Number.isInteger(seal.shares) && seal.shares >= 1 && seal.shares <= 255
    && Number.isInteger(seal.threshold) && seal.threshold >= 1 && seal.threshold <= seal.shares
    && validShares(originalShares, seal.threshold), 'INVALID_VAULT_RECOVERY_MANIFEST');
  if (progress) requireValue(progress.schemaVersion === 1 && progress.containerId === containerId
    && progress.recoveryId === recoveryId && progress.backupId === manifest.backupId
    && progress.clusterId === manifest.clusterId && stages.includes(progress.stage), 'VAULT_RECOVERY_PROGRESS_CONFLICT');
  if (temporaryCustody) requireValue(temporaryCustody.schemaVersion === 1
    && temporaryCustody.containerId === containerId && temporaryCustody.recoveryId === recoveryId
    && temporaryCustody.threshold === seal.threshold && temporaryCustody.shares?.length === seal.shares
    && validShares(temporaryCustody.shares, seal.threshold)
    && typeof temporaryCustody.operatorToken === 'string' && temporaryCustody.operatorToken.length >= 16
    && temporaryCustody.operatorToken.length <= 4096 && !/[\r\n\0]/.test(temporaryCustody.operatorToken), 'VAULT_TEMPORARY_CUSTODY_CONFLICT');

  async function publish(stage, fields = {}) {
    const next = { ...progress, schemaVersion: 1, recoveryId, containerId,
      backupId: manifest.backupId, clusterId: manifest.clusterId, ...fields, stage };
    await saveProgress(next);
    progress = next;
  }
  async function cli(arguments_, body, token = '', allowedExitCodes = [0]) {
    const result = await run('docker', ['exec', '-i', '-e', 'VAULT_TOKEN',
      '-e', 'VAULT_ADDR=https://vault:8200', '-e', 'VAULT_CACERT=/run/helm/ca.crt',
      '-e', 'VAULT_MAX_RETRIES=0', '-e', 'VAULT_SKIP_VERIFY=false', '-e', 'VAULT_CLIENT_TIMEOUT=15s',
      containerId, 'vault', ...arguments_], { environment: { ...environment, VAULT_TOKEN: token },
      input: body === undefined ? undefined : JSON.stringify(body), timeout: 20_000,
      maximum: 1_048_576, allowedExitCodes });
    return result;
  }
  async function status() {
    const result = JSON.parse((await cli(['status', '-format=json'], undefined, '', [0, 2])).stdout);
    requireValue(typeof result.initialized === 'boolean' && typeof result.sealed === 'boolean', 'INVALID_VAULT_STATUS');
    return result;
  }
  async function waitForInitialStatus() {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { return await status(); }
      catch {
        const state = JSON.parse((await run('docker', ['inspect', '--format', '{{json .State}}', containerId],
          { environment, timeout: 5000, maximum: 16_384 })).stdout);
        requireValue(state.Running === true, 'VAULT_REPLACEMENT_NOT_RUNNING');
        await delay(250);
      }
    }
    throw new Error('VAULT_REPLACEMENT_STATUS_UNAVAILABLE');
  }
  async function unseal(shares) {
    for (const key of shares.slice(0, seal.threshold)) {
      const current = await status();
      if (!current.sealed) return current;
      requireValue(current.initialized && current.type === seal.type && current.n === seal.shares
        && current.t === seal.threshold, 'VAULT_SEAL_CONFIG_MISMATCH');
      await cli(['write', '-format=json', 'sys/unseal', '-'], { key });
    }
    const current = await status();
    requireValue(!current.sealed, 'VAULT_UNSEAL_NOT_CONFIRMED');
    return current;
  }

  const alreadySent = progress && ['RESTORE_STARTED', 'RESTORE_ACCEPTED', 'VERIFIED'].includes(progress.stage);
  const initialStatus = await waitForInitialStatus();
  if (!alreadySent) {
    let current = initialStatus;
    if (!current.initialized) {
      requireValue(!temporaryCustody && !progress, 'VAULT_INIT_OUTCOME_UNKNOWN');
      await publish('INITIALIZING');
      const result = JSON.parse((await cli(['operator', 'init', '-format=json',
        `-key-shares=${seal.shares}`, `-key-threshold=${seal.threshold}`])).stdout);
      requireValue(validShares(result.unseal_keys_b64, seal.shares) && typeof result.root_token === 'string',
        'VAULT_TEMPORARY_INIT_UNCONFIRMED');
      temporaryCustody = { schemaVersion: 1, containerId, recoveryId, threshold: seal.threshold,
        shares: result.unseal_keys_b64, operatorToken: result.root_token };
      // If initialization or this protected save loses its response, preserve the target.
      // An initialized target without matching custody is never initialized again.
      await saveTemporaryCustody(temporaryCustody);
    }
    requireValue(temporaryCustody, 'VAULT_TEMPORARY_CUSTODY_REQUIRED');
    current = await unseal(temporaryCustody.shares);
    requireValue(typeof current.cluster_id === 'string' && current.cluster_id !== manifest.clusterId
      && (!progress?.temporaryClusterId || progress.temporaryClusterId === current.cluster_id), 'VAULT_REPLACEMENT_CLUSTER_CONFLICT');
    const absent = await cli(['read', '-format=json', `helm-kv/data/recovery-markers/${manifest.backupId}`],
      undefined, temporaryCustody.operatorToken, [0, 2]);
    requireValue(absent.code === 2 && /^No value found at /m.test(absent.stderr), 'VAULT_RECOVERY_MARKER_ALREADY_PRESENT');
    await publish('TEMPORARY_READY', { temporaryClusterId: current.cluster_id });
    await publish('RESTORE_STARTED');
    const accepted = await runArchive({ operation: 'restore-new-cluster', operatorToken: temporaryCustody.operatorToken });
    requireValue(accepted?.state === 'RESTORE_ACCEPTED' && accepted.clusterId === manifest.clusterId,
      'VAULT_RESTORE_RESPONSE_UNCONFIRMED');
    await publish('RESTORE_ACCEPTED');
  }

  // A resumed RESTORE_STARTED never resends the snapshot: reconcile the same target.
  const deadline = Date.now() + 30_000;
  let current;
  while (Date.now() < deadline) {
    current = await status();
    if (current.sealed || current.cluster_id === manifest.clusterId) break;
    await delay(250);
  }
  requireValue(current?.sealed || current?.cluster_id === manifest.clusterId, 'VAULT_RESTORE_OUTCOME_UNKNOWN');
  if (current.sealed) current = await unseal(originalShares);
  requireValue(current.initialized && !current.sealed && current.cluster_id === manifest.clusterId,
    'VAULT_RESTORED_CLUSTER_MISMATCH');
  const verified = await runArchive({ operation: 'verify' });
  requireValue(verified?.state === 'VERIFIED' && verified.clusterId === manifest.clusterId
    && verified.installationId === manifest.installationId && verified.backupId === manifest.backupId
    && /^[a-f0-9]{64}$/.test(verified.manifestSha256), 'VAULT_RECOVERY_MARKER_NOT_VERIFIED');
  await publish('VERIFIED', { manifestSha256: verified.manifestSha256 });
  return verified;
}
