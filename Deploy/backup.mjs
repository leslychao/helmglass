import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigurationError, readEnvironmentFile, validateDeployment, validateRelease } from './configuration.mjs';
import { acquireMaintenance, deploymentContainer, deploymentContainers, requireStopped } from './maintenance.mjs';
import { protectDirectory, readProtectedFile, writeProtectedFile } from './protected-files.mjs';
import { fenceInstallation } from './recovery-fencing.mjs';
import { applyRecoveryTargets, readRecoveryState } from './recovery-files.mjs';
import { run } from './process.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
let phase = 'configuration';
let maintenance;
function progress(value) { phase = value; process.stdout.write(`Helm Glass backup: ${value}\n`); }

async function main() {
  const [environmentName, backupId] = process.argv.slice(2);
  if (process.argv.length !== 4 || environmentName !== 'dev'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(backupId ?? '')) {
    throw new ConfigurationError('BACKUP', 'invoke node Deploy/backup.mjs dev UNIQUE_BACKUP_ID; this cold backup stops application runtimes');
  }
  const configuration = validateDeployment(await readEnvironmentFile(new URL('./.env.dev', import.meta.url)));
  const release = validateRelease(await readEnvironmentFile(new URL('./release.env', import.meta.url)));
  const environment = { ...process.env, ...configuration, ...release };
  for (const name of ['DOCKER_CONTEXT', 'VAULT_TOKEN', 'COMPOSE_FILE', 'COMPOSE_PROFILES']) delete environment[name];
  const docker = (args, options = {}) => run('docker', args, { environment, cwd: repository, ...options });
  const recovery = await readRecoveryState(configuration.LOCAL_SECRETS_DIR);
  if (recovery && recovery.stage !== 'READY') throw new Error('Recovery must finish before taking another backup');
  applyRecoveryTargets(environment, recovery);
  const daemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  if (daemon.OSType !== 'linux' || !daemon.ID) throw new Error('Expected Linux Docker daemon is unavailable');
  for (const image of [release.PROVISION_IMAGE, release.POSTGRES_IMAGE]) await docker(['image', 'inspect', image]);
  const identity = await readProtectedFile(join(configuration.LOCAL_SECRETS_DIR, 'backup-bootstrap'));
  const recipient = await readProtectedFile(join(configuration.LOCAL_SECRETS_DIR, 'backup-recipient'));
  const receipts = await protectDirectory(join(configuration.LOCAL_RECOVERY_DIR, 'backups'), repository);
  const receiptPath = join(receipts, `${configuration.INSTALLATION_ID}-${backupId}.json`);
  try { await readProtectedFile(receiptPath); throw new Error('Backup ID already has a completed receipt'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  maintenance = await acquireMaintenance({ docker, image: release.PROVISION_IMAGE,
    installationId: configuration.INSTALLATION_ID, operation: 'backup' });
  if (!isDeepStrictEqual(recovery, await readRecoveryState(configuration.LOCAL_SECRETS_DIR))) {
    throw new Error('Recovery state changed before backup acquired maintenance; retry with the current state');
  }
  progress('verifying the running release and storage bindings');
  const services = { nginx: 'NGINX_IMAGE', api: 'API_IMAGE', 'mcp-adapter': 'MCP_ADAPTER_IMAGE',
    'browser-worker': 'WORKER_IMAGE', 'egress-proxy': 'EGRESS_IMAGE', coturn: 'TURN_IMAGE',
    postgres: 'POSTGRES_IMAGE', redis: 'REDIS_IMAGE', minio: 'MINIO_IMAGE', vault: 'VAULT_IMAGE',
    keycloak: 'KEYCLOAK_IMAGE', provision: 'PROVISION_IMAGE', migrate: 'API_IMAGE', 'oauth2-proxy': 'OAUTH_IMAGE' };
  for (const [service, parameter] of Object.entries(services)) {
    const ids = await deploymentContainers(docker, service);
    if (!ids.length || service !== 'browser-worker' && ids.length !== 1) throw new Error('Incomplete deployment release inventory');
    const expected = (await docker(['image', 'inspect', '--format', '{{.Id}}', release[parameter]])).stdout.trim();
    for (const id of ids) {
      if ((await docker(['inspect', '--format', '{{.Image}}', id])).stdout.trim() !== expected) {
        throw new Error('Configured release does not match the installed components');
      }
    }
  }
  const postgres = await deploymentContainer(docker, 'postgres');
  const minio = await deploymentContainer(docker, 'minio');
  const vault = await deploymentContainer(docker, 'vault');
  for (const [id, bindings] of [[minio, [['/data', environment.MINIO_DATA_DIR]]],
  [postgres, [['/backup', configuration.BACKUP_DIR], ['/backup-work', configuration.BACKUP_WORK_DIR]]]]) {
    const mounts = JSON.parse((await docker(['inspect', '--format', '{{json .Mounts}}', id])).stdout);
    for (const [target, source] of bindings) {
      if (!mounts.some(mount => mount.Type === 'bind' && mount.Destination === target && mount.Source === source)) {
        throw new Error('Backup directories do not match the installed storage mounts');
      }
    }
  }
  const startedAt = new Date().toISOString();
  progress('closing ingress and stopping all application writers and browsers');
  const fencing = await fenceInstallation({ docker, expectedDaemonId: daemon.ID, previousContainers: [] });
  for (const id of [postgres, vault]) {
    const state = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', id])).stdout);
    if (!state.Running || state.Health?.Status !== 'healthy') throw new Error('Backup storage is not healthy');
  }
  await docker(['stop', '--time', '60', minio]);
  await requireStopped(docker, minio);
  const bind = (source, target, readonly = false) => ['--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
  const helper = (script, args, { input, network = 'none', mounts = [] } = {}) => docker([
    'run', '--rm', '--interactive', '--network', network, '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '512m', '--log-driver', 'none',
    '--tmpfs', '/tmp:size=32m,mode=0700', '--tmpfs', '/run:size=32m,mode=0700',
    ...bind(configuration.BACKUP_DIR, '/backup'), ...bind(configuration.BACKUP_WORK_DIR, '/backup-work'),
    ...bind(`${configuration.SECRETS_DIR}/backup-recipient`, '/recipient.pem', true), ...mounts,
    '-e', 'BACKUP_DIR=/backup', '-e', 'BACKUP_WORK_DIR=/backup-work', '-e', 'BACKUP_RECIPIENT_CERT=/recipient.pem',
    '--entrypoint', 'node', release.PROVISION_IMAGE, script, ...args,
  ], { input, timeout: 21_600_000, maximum: 2_097_152 });
  const pg = args => docker(['exec', '--user', 'postgres', postgres, ...args], { timeout: 7_200_000 });
  const sql = async statement => (await pg(['psql', '--no-psqlrc', '--no-password', '--quiet',
    '--tuples-only', '--no-align', '--username', 'postgres', '--dbname', 'postgres',
    '--set', 'ON_ERROR_STOP=1', '--command', statement])).stdout.trim();
  const readPg = async path => {
    const bytes = Buffer.from((await pg(['cat', path])).stdout);
    return { value: JSON.parse(bytes), sha256: checksum(bytes) };
  };
  progress('saving and verifying the PostgreSQL base and its archived restore point');
  const baseDirectory = (await pg(['/opt/helm/bin/backup-base', backupId])).stdout.trim();
  const systemIdentifier = await sql('SELECT system_identifier FROM pg_control_system()');
  if (!/^[0-9]+$/.test(systemIdentifier) || baseDirectory !== `/backup/postgres/${systemIdentifier}/base/${backupId}`) {
    throw new Error('PostgreSQL base backup identity was not confirmed');
  }
  const restorePoint = 'helm_' + randomUUID().replaceAll('-', '');
  const restoreLsn = await sql(`SELECT pg_create_restore_point('${restorePoint}')`);
  if (!/^[A-F0-9]+\/[A-F0-9]+$/.test(restoreLsn)) throw new Error('PostgreSQL restore LSN was not confirmed');
  const walFile = await sql('SELECT pg_walfile_name(pg_current_wal_lsn())');
  if (!/^[A-F0-9]{24}$/.test(walFile)) throw new Error('PostgreSQL WAL boundary was not confirmed');
  await sql('SELECT pg_switch_wal()');
  const walDirectory = `/backup/postgres/${systemIdentifier}/wal/${walFile}`;
  let walManifest;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try { walManifest = await readPg(`${walDirectory}/manifest.json`); break; }
    catch { await delay(1000); }
  }
  if (!walManifest || walManifest.value.walFile !== walFile) throw new Error('Restore-point WAL has not reached backup storage');
  const baseManifest = await readPg(`${baseDirectory}/manifest.json`);
  progress('encrypting the stopped MinIO data directory');
  const minioBackup = JSON.parse((await helper('/opt/helm/minio/cold-archive.mjs',
    ['backup', configuration.INSTALLATION_ID, backupId], { mounts: bind(environment.MINIO_DATA_DIR, '/data', true) })).stdout);
  await requireStopped(docker, minio);
  progress('saving scoped Vault Raft keys and configuration');
  const vaultBackup = JSON.parse((await helper('/opt/helm/vault/archive.mjs',
    ['backup', configuration.INSTALLATION_ID, backupId], { input: identity,
      network: 'helm-glass_secrets' })).stdout);
  const observed = await fenceInstallation({ docker, expectedDaemonId: daemon.ID,
    previousContainers: fencing.receipt.containers });
  if (JSON.stringify(observed.receipt.expectedContainerIds) !== JSON.stringify(fencing.receipt.expectedContainerIds)) {
    throw new Error('Application inventory changed during backup');
  }
  const completedAt = new Date().toISOString();
  const relative = value => {
    if (typeof value !== 'string' || !value.startsWith('/backup/')) throw new Error('Unexpected backup component path');
    return value.slice('/backup/'.length);
  };
  const manifest = { schemaVersion: 1, format: 'helm-joint-cold-v1', installationId: configuration.INSTALLATION_ID,
    backupId, daemonId: daemon.ID, startedAt, completedAt,
    expiresAt: new Date(Date.parse(completedAt) + 30 * 86_400_000).toISOString(),
    recipientSha256: checksum(recipient), release, runtimeFencing: observed.receipt,
    postgres: { systemIdentifier, directory: relative(baseDirectory), manifestSha256: baseManifest.sha256,
      restorePoint, restoreLsn, walFile, walDirectory: relative(walDirectory), walManifestSha256: walManifest.sha256 },
    minio: { directory: relative(minioBackup.directory), manifestSha256: minioBackup.manifestSha256 },
    vault: { directory: relative(vaultBackup.directory), manifestSha256: vaultBackup.manifestSha256 } };
  progress('verifying and publishing the encrypted joint manifest');
  const published = JSON.parse((await helper('/opt/helm/provision/src/joint-backup.mjs',
    ['publish', configuration.INSTALLATION_ID, backupId], { input: JSON.stringify(manifest) })).stdout);
  await writeProtectedFile(receiptPath, { schemaVersion: 1, installationId: configuration.INSTALLATION_ID,
    backupId, daemonId: daemon.ID, ...published });
  process.stdout.write(`Joint backup ${backupId} is complete. Application runtimes remain stopped; resume with Deploy/up.ps1 dev or Deploy/up.sh dev.\n`);
}

main().finally(async () => { await maintenance?.release(); }).catch(error => {
  const detail = error instanceof ConfigurationError ? error.message
    : 'No complete joint backup is claimed. Inspect protected inputs and component diagnostics; application runtimes may remain stopped.';
  process.stderr.write(`Helm Glass backup stopped during ${phase}. ${detail}\n`);
  process.exitCode = 1;
});
