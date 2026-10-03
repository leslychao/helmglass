import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BOOTSTRAP_FILES, ConfigurationError, readEnvironmentFile, validateDeployment, validateRelease } from './configuration.mjs';
import { decryptRecovery, encryptRecovery, secretInput } from './custody.mjs';
import { acquireMaintenance, deploymentContainer, requireStopped } from './maintenance.mjs';
import { protectDirectory, readProtectedFile, replaceProtectedFile, writeProtectedFile } from './protected-files.mjs';
import { prepareRecoveryEvidence } from './recovery-evidence.mjs';
import { fenceInstallation } from './recovery-fencing.mjs';
import { applyRecoveryTargets, readRecoveryState, saveRecoveryState } from './recovery-files.mjs';
import { reconcileApplication } from './recovery-runtime.mjs';
import { bind, decryptionMounts, ensureRecoveryVolume, restoreMinio, restorePostgres,
  stageRecoveryMaterial, verifyMinioTargets } from './recovery-storage.mjs';
import { requireBackupRelease, validateRestorePlan } from './restore-plan.mjs';
import { restoreVault } from './vault-restore.mjs';
import { run } from './process.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
let phase = 'configuration';
let maintenance;
let cleanup;
function progress(value) { phase = value; process.stdout.write(`Helm Glass restore: ${value}\n`); }
async function optionalFile(path) {
  try { return await readProtectedFile(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function main() {
  const [environmentName, planPath] = process.argv.slice(2);
  if (process.argv.length !== 4 || environmentName !== 'dev' || !planPath || !isAbsolute(planPath)) {
    throw new ConfigurationError('RESTORE', 'invoke node Deploy/restore.mjs dev /absolute/protected/restore-plan.json');
  }
  const configuration = validateDeployment(await readEnvironmentFile(new URL('./.env.dev', import.meta.url)));
  const release = validateRelease(await readEnvironmentFile(new URL('./release.env', import.meta.url)));
  const planBytes = await readProtectedFile(planPath, 65_536);
  const planHash = hash(planBytes);
  const input = JSON.parse(planBytes);
  const environment = { ...process.env, ...configuration, ...release, COMPOSE_PROJECT_NAME: 'helm-glass' };
  for (const name of ['DOCKER_CONTEXT', 'VAULT_TOKEN', 'COMPOSE_FILE', 'COMPOSE_PROFILES']) delete environment[name];
  // Operator custody remains in this process and never becomes a Docker environment variable.
  delete environment.VAULT_CUSTODY_PASSWORD;
  const docker = (args, options = {}) => run('docker', args, { environment, cwd: repository, ...options });
  const compose = (args, options) => docker(['compose', '--env-file', 'Deploy/release.env',
    '--env-file', 'Deploy/.env.dev', '-f', 'Deploy/compose.yaml', ...args], options);
  const daemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  if (daemon.OSType !== 'linux' || !daemon.ID) {
    throw new Error('The selected recovery daemon was not confirmed');
  }
  for (const image of Object.values(release)) await docker(['image', 'inspect', image]);
  maintenance = await acquireMaintenance({ docker, image: release.PROVISION_IMAGE,
    installationId: configuration.INSTALLATION_ID, operation: 'restore' });
  // State must be read while holding the same exclusion as every launcher mutation.
  const previous = await readRecoveryState(configuration.LOCAL_SECRETS_DIR);
  const resuming = previous?.recoveryId === input.recoveryId;
  const plan = validateRestorePlan(input, configuration, resuming ? undefined : previous);
  if (previous && previous.stage !== 'READY' && !resuming) throw new Error('Another recovery must be reconciled before a new one');
  if (resuming && (previous.planSha256 !== planHash || previous.backupId !== plan.backupId || previous.daemonId !== daemon.ID)) {
    throw new Error('Recovery retry must use the original immutable plan and Docker daemon');
  }
  if (resuming && previous.stage === 'READY') {
    progress('this immutable recovery is already complete; no restore is repeated');
    return;
  }
  let state = resuming ? previous : { schemaVersion: 1, recoveryId: plan.recoveryId,
    backupId: plan.backupId, daemonId: daemon.ID, planSha256: planHash, stage: 'FENCING',
    startedAt: new Date().toISOString(), storage: { postgresVolume: `helm-glass-pg-recovery-${plan.recoveryId}`,
      vaultVolume: `helm-glass-vault-recovery-${plan.recoveryId}`, minioDirectories: plan.minioDirectories } };
  const operationDirectory = await protectDirectory(join(configuration.LOCAL_RECOVERY_DIR, 'recoveries', state.recoveryId), repository);
  const originalPlan = await optionalFile(join(operationDirectory, 'plan.json'));
  if (originalPlan && hash(originalPlan) !== planHash) throw new Error('Protected recovery plan has different contents');
  if (!originalPlan) await writeProtectedFile(join(operationDirectory, 'plan.json'), planBytes);
  const saveState = async next => { await saveRecoveryState(configuration.LOCAL_SECRETS_DIR, next); state = next; };
  const material = (mode, input = {}, mounts = []) => stageRecoveryMaterial({ docker,
    configuration, release, state, mode, input, mounts });
  cleanup = async () => {
    const active = (await docker(['ps', '--quiet', '--filter', `label=helmglass.recovery=${state.recoveryId}`])).stdout.trim();
    if (active) {
      throw new Error('Recovery helper remains active; protected decryption material is retained until this operation is reconciled');
    }
    const removed = await material('clear-keys');
    if (removed.state !== 'REMOVED') throw new Error('Temporary recovery decryption material was not removed');
  };
  progress('authenticating the joint backup before stopping the installation');
  const privateKeyPem = (await readProtectedFile(plan.privateKeyFile, 32_768)).toString();
  const password = (await readProtectedFile(plan.keyPasswordFile, 4096)).toString().replace(/\r?\n$/, '');
  const keys = await material('keys', { privateKeyPem, password });
  if (keys.state !== 'STAGED' || keys.directory !== `/backup-work/recovery-${state.recoveryId}`) {
    throw new Error('Recovery keys were not delivered to the protected scratch directory');
  }
  const helper = (script, args, { input, network = 'none', timeout = 21_600_000 } = {}) => docker([
    'run', '--rm', '--interactive', '--network', network, '--read-only', '--user', '0:0',
    '--label', `helmglass.recovery=${state.recoveryId}`, '--label', `helmglass.installation=${configuration.INSTALLATION_ID}`,
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '512m', '--log-driver', 'none',
    '--tmpfs', '/tmp:size=32m,mode=0700', '--tmpfs', '/run:size=32m,mode=0700',
    ...decryptionMounts(configuration, state.recoveryId), '--entrypoint', 'node', release.PROVISION_IMAGE, script, ...args,
  ], { input, timeout });
  const manifest = JSON.parse((await helper('/opt/helm/provision/src/joint-backup.mjs',
    ['read', configuration.INSTALLATION_ID, state.backupId, plan.jointManifestSha256])).stdout);
  requireBackupRelease(manifest, release);
  if (manifest.daemonId !== daemon.ID) {
    throw new Error('Original host fencing is not proven; a different daemon cannot restore and reopen this installation');
  }
  const backupIdentity = JSON.parse((await readProtectedFile(join(configuration.LOCAL_SECRETS_DIR, 'backup-bootstrap'))).toString());
  const runArchive = async ({ operation, operatorToken }) => {
    const input = { schemaVersion: 1, vault: { ...backupIdentity.vault, ...(operatorToken ? { operatorToken } : {}) } };
    const result = JSON.parse((await helper('/opt/helm/vault/archive.mjs', [operation, configuration.INSTALLATION_ID,
      state.backupId, `/backup/${manifest.vault.directory}`, manifest.vault.manifestSha256], { input: JSON.stringify(input),
      network: operation === 'describe' ? 'none' : 'helm-glass_secrets' })).stdout);
    if (result.manifestSha256 && result.manifestSha256 !== manifest.vault.manifestSha256) {
      throw new Error('Vault archive differs from the authenticated joint backup');
    }
    return result;
  };
  const vaultArchive = await runArchive({ operation: 'describe' });
  if (vaultArchive.manifestSha256 !== manifest.vault.manifestSha256) throw new Error('Vault archive binding is unconfirmed');
  const custodyPassword = await secretInput('VAULT_CUSTODY_PASSWORD', 'Offline Vault recovery password (hidden)');
  const originalCustody = await decryptRecovery(configuration.INSTALLATION_ID,
    JSON.parse((await readProtectedFile(join(configuration.LOCAL_RECOVERY_DIR,
      `${configuration.INSTALLATION_ID}-vault.json`))).toString()), custodyPassword);
  if (originalCustody.clusterId !== vaultArchive.descriptor.clusterId
      || originalCustody.threshold !== vaultArchive.descriptor.sealConfig.threshold
      || originalCustody.shares?.length !== vaultArchive.descriptor.sealConfig.shares) {
    throw new Error('Original Vault quorum does not match the authenticated backup');
  }
  if (!resuming) {
    await verifyMinioTargets({ docker, release, directories: plan.minioDirectories, requireEmpty: true });
    if (previous) await writeProtectedFile(join(operationDirectory, 'previous-state.json'), previous);
    await saveState(state);
  }
  progress('closing ingress and physically fencing every old runtime');
  let fencing = await fenceInstallation({ docker, expectedDaemonId: daemon.ID,
    previousContainers: state.fencing?.containers ?? manifest.runtimeFencing.containers });
  if (state.stage === 'FENCING') {
    const storage = {};
    for (const service of ['postgres', 'minio', 'vault']) {
      const id = await deploymentContainer(docker, service);
      const observed = JSON.parse((await docker(['inspect', '--format',
        '{"state":{{json .State}},"mounts":{{json .Mounts}}}', id])).stdout);
      if (observed.mounts.some(mount => mount.Type === 'bind' && plan.minioDirectories.some(path =>
        path === mount.Source || path.startsWith(mount.Source + '/') || mount.Source.startsWith(path + '/')))) {
        throw new Error('A recovery target overlaps an existing storage mount');
      }
      if (observed.state.Running || observed.state.Restarting) await docker(['stop', '--time', '60', id]);
      await requireStopped(docker, id);
      storage[service] = { containerId: id, mounts: observed.mounts.map(({ Type, Name, Source, Destination }) =>
        ({ type: Type, name: Name, source: Source, destination: Destination })) };
    }
    await saveState({ ...state, stage: 'RESTORING', fencing: fencing.receipt, previousStorage: storage });
  }
  applyRecoveryTargets(environment, state);
  if (state.stage === 'RESTORING') {
    progress('restoring PostgreSQL to its exact named WAL point in a new volume');
    if (!state.physical?.postgres) state = await restorePostgres({ docker, configuration, release, state, manifest, saveState });
    progress('restoring and checking all four MinIO disks');
    if (!state.physical?.minio) state = await restoreMinio({ docker, configuration, release, state, manifest, saveState });
  }
  // Original bootstrap credentials are verified, never regenerated or silently replaced for an old backup.
  const delivery = [];
  for (const name of BOOTSTRAP_FILES) {
    const bytes = await readProtectedFile(join(configuration.LOCAL_SECRETS_DIR, name));
    delivery.push({ name, content: bytes.toString('base64'), sha256: hash(bytes) });
  }
  await docker(['run', '--rm', '--interactive', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--log-driver', 'none', ...bind(configuration.SECRETS_DIR, '/bootstrap', true),
    '--entrypoint', 'node', release.PROVISION_IMAGE, '/opt/helm/provision/src/host-files.mjs'], {
    input: JSON.stringify({ schemaVersion: 1, installationId: configuration.INSTALLATION_ID, mode: 'verify', files: delivery }) });
  await ensureRecoveryVolume({ docker, state, installationId: configuration.INSTALLATION_ID, kind: 'vault' });
  await compose(['config', '--quiet']);
  await compose(['up', '-d', '--no-deps', 'vault']);
  const vaultContainer = await deploymentContainer(docker, 'vault');
  const temporaryPath = join(operationDirectory, 'vault-temporary.json');
  const temporaryBytes = await optionalFile(temporaryPath);
  const temporaryCustody = temporaryBytes ? await decryptRecovery(configuration.INSTALLATION_ID,
    JSON.parse(temporaryBytes), custodyPassword) : undefined;
  progress('restoring Vault into its new volume and verifying the original cluster and keys');
  await restoreVault({ containerId: vaultContainer, recoveryId: state.recoveryId, manifest: vaultArchive.descriptor,
    originalShares: originalCustody.shares, temporaryCustody, environment,
    progress: state.physical?.vault, runArchive,
    saveTemporaryCustody: async value => {
      const sealed = await encryptRecovery(configuration.INSTALLATION_ID, value, custodyPassword);
      const bytes = await optionalFile(temporaryPath);
      if (bytes) await replaceProtectedFile(temporaryPath, sealed, hash(bytes));
      else await writeProtectedFile(temporaryPath, sealed);
    },
    saveProgress: async value => saveState({ ...state, physical: { ...state.physical, vault: value } }) });
  await compose(['up', '-d', '--no-deps', 'postgres', 'minio']);
  const healthy = async service => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const id = await deploymentContainer(docker, service);
      const observed = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', id])).stdout);
      if (observed.Running && observed.Health?.Status === 'healthy') return;
      if (!observed.Running) throw new Error('A restored dependency did not remain running');
      await delay(1000);
    }
    throw new Error('Restored dependency did not become healthy');
  };
  await Promise.all(['postgres', 'minio', 'vault'].map(healthy));
  if (state.stage === 'RESTORING') {
    fencing = await fenceInstallation({ docker, expectedDaemonId: daemon.ID, previousContainers: fencing.receipt.containers });
    state = await prepareRecoveryEvidence({ docker, configuration, release, state, fencing,
      restorePoint: `${manifest.postgres.restorePoint}@${manifest.postgres.restoreLsn}`,
      walLossWindow: plan.walLossWindow, repository });
  }
  applyRecoveryTargets(environment, state);
  await cleanup();
  cleanup = undefined;
  progress('starting only the cleanup dependencies behind closed ingress');
  await compose(['up', '-d', '--no-deps', 'redis', 'keycloak']);
  await Promise.all(['redis', 'keycloak'].map(healthy));
  state = await reconcileApplication({ docker, compose, environment, configuration, release, state,
    previousContainers: fencing.receipt.containers, progress });
  process.stdout.write(`Recovery ${state.recoveryId} is complete. The exact restore point and declared loss boundary are in the protected receipt. Ingress remains stopped; use Deploy/up.ps1 dev or Deploy/up.sh dev to reopen.\n`);
}

main().finally(async () => {
  try { await cleanup?.(); } finally { await maintenance?.release(); }
}).catch(error => {
  const detail = error instanceof ConfigurationError ? error.message
    : 'Recovery is not claimed complete. Existing source storage and recovery targets are preserved; retry the same protected plan to reconcile confirmed progress.';
  process.stderr.write(`Helm Glass restore stopped during ${phase}. ${detail}\n`);
  process.exitCode = 1;
});
