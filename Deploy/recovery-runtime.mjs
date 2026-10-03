import { setTimeout as delay } from 'node:timers/promises';
import { parseRecoveryStatus } from './recovery-evidence.mjs';
import { fenceInstallation } from './recovery-fencing.mjs';
import { applyRecoveryTargets, saveRecoveryState } from './recovery-files.mjs';

/** Final application barrier. Physical storage owners must finish before this one-shot process. */
export async function reconcileApplication({ docker, compose, environment, configuration, release,
  state, previousContainers, progress = () => {} }) {
  if (state.stage !== 'RECONCILING' || state.proofVolume !== `helm-glass-proof-recovery-${state.recoveryId}`
      || !/^[a-f0-9]{64}$/.test(state.proofSha256 ?? '') || !state.storage) {
    throw new Error('Physical restore and immutable recovery evidence are required before reconciliation');
  }
  applyRecoveryTargets(environment, state);
  const name = `helm-glass-reconcile-${state.recoveryId}`;
  const options = ['--no-deps', '--volume', `${state.proofVolume}:/run/recovery:ro`,
    '--label', `helmglass.recovery=${state.recoveryId}`, '--label', `helmglass.installation=${configuration.INSTALLATION_ID}`];
  const find = async () => (await docker(['ps', '--all', '--quiet', '--no-trunc',
    '--filter', `name=^/${name}$`])).stdout.trim().split(/\s+/).filter(Boolean);
  const ids = await find();
  if (ids.length > 1) throw new Error('More than one recovery process owns this operation');
  let containerId = ids[0];
  const expectedImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', release.API_IMAGE])).stdout.trim();
  const inspect = async () => {
    const value = JSON.parse((await docker(['inspect', '--format',
      '{"id":{{json .Id}},"image":{{json .Image}},"command":{{json .Config.Cmd}},"labels":{{json .Config.Labels}},"state":{{json .State}}}', containerId])).stdout);
    if (value.id !== containerId || value.image !== expectedImage || value.command?.length !== 1
        || value.command[0] !== 'recover' || value.labels?.['helmglass.recovery'] !== state.recoveryId
        || value.labels?.['helmglass.installation'] !== configuration.INSTALLATION_ID
        || value.labels?.['com.docker.compose.service'] !== 'api') {
      throw new Error('Recovery process ownership does not match the protected operation');
    }
    return value.state;
  };
  const status = async () => parseRecoveryStatus((await compose(['run', '--rm', ...options,
    'api', 'recover-status'], { timeout: 120_000, maximum: 8_388_608 })).stdout, state);
  let receipt;
  if (containerId) {
    const observed = await inspect();
    if (!observed.Running && observed.Status !== 'created') {
      // A committed READY response may have been lost; never replay recover merely to get it again.
      receipt = await status();
      if (receipt.state !== 'READY') {
        progress(`resuming the same fenced recovery owner from ${receipt.state}`);
        await docker(['start', containerId]);
      }
    } else if (observed.Status === 'created') await docker(['start', containerId]);
  } else {
    progress('revoking restored runtime claims and replaying the current deletion ledger');
    await compose(['run', '--detach', ...options, '--name', name, 'api', 'recover'], { timeout: 120_000 });
    const created = await find();
    if (created.length !== 1) throw new Error('Recovery process launch outcome is unknown; use the same operation on retry');
    containerId = created[0];
  }
  if (receipt?.state !== 'READY') {
    const deadline = Date.now() + 31 * 60_000;
    let completed = false;
    while (Date.now() < deadline) {
      const observed = await inspect();
      if (!observed.Running && !observed.Restarting && observed.Pid === 0) { completed = true; break; }
      await delay(1000);
    }
    if (!completed) throw new Error('Recovery process is still active; admission remains closed');
    receipt = await status();
  }
  if (receipt.state !== 'READY' || receipt.admissionState !== 'READY'
      || !Number.isFinite(Date.parse(receipt.finishedAt))) {
    throw new Error('Deletion and runtime recovery barriers have not completed; admission remains closed');
  }
  // Dependencies created for cleanup are stopped again. No service opens user ingress here.
  await fenceInstallation({ docker, expectedDaemonId: state.daemonId, previousContainers });
  const verified = await status();
  if (verified.state !== 'READY' || verified.admissionState !== 'READY'
      || verified.finishedAt !== receipt.finishedAt) throw new Error('Recovery readiness changed before publication');
  const next = { ...state, stage: 'READY', completedAt: new Date().toISOString(),
    applicationReceipt: verified, reconcileContainer: containerId };
  await saveRecoveryState(configuration.LOCAL_SECRETS_DIR, next);
  return next;
}
