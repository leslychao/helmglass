import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { run } from '../process.mjs';
import { saveVaultSnapshot } from '../vault-snapshot.mjs';
import { withVaultBackupSession } from '../vault-backup-session.mjs';
import { VaultCli } from '../provision/src/vault-cli.mjs';

const [operation, installationId, backupId, source, expectedManifestSha256] = process.argv.slice(2);
const maximumSnapshotBytes = 1_073_741_824;
let work;
let stage = 'VALIDATING_INPUT';

function requireCondition(value, code) { if (!value) throw new Error(code); }

async function privateDirectory(directory) {
  requireCondition(typeof directory === 'string' && path.isAbsolute(directory), 'PRIVATE_DIRECTORY_REQUIRED');
  const metadata = await lstat(directory);
  requireCondition(metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0
    && (metadata.uid === process.getuid() || (process.getuid() === 0 && metadata.uid === 999)), 'PRIVATE_DIRECTORY_REQUIRED');
}

async function writeJson(file, value) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

async function readJson(file, expectedHash) {
  const metadata = await lstat(file);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0
    && metadata.size <= 16_384, 'INVALID_VAULT_ARCHIVE_MANIFEST');
  const bytes = await readFile(file);
  if (expectedHash) requireCondition(createHash('sha256').update(bytes).digest('hex') === expectedHash, 'VAULT_ARCHIVE_CHECKSUM_MISMATCH');
  return JSON.parse(bytes.toString('utf8'));
}

async function sha256(file) {
  const checksum = createHash('sha256');
  for await (const bytes of createReadStream(file)) checksum.update(bytes);
  return checksum.digest('hex');
}

async function execute(command, args, environment = process.env) {
  return (await run(command, args, { environment, timeout: 300_000, maximum: 16_384 })).stdout.trim();
}

async function snapshotStatus(environment) {
  const result = await run('vault', ['status', '-format=json'], { environment,
    timeout: 15_000, maximum: 16_384, allowedExitCodes: [0, 2] });
  const status = JSON.parse(result.stdout);
  requireCondition(status.initialized === true && status.sealed === false
    && typeof status.cluster_id === 'string' && /^[a-f0-9-]{36}$/.test(status.cluster_id), 'VAULT_OPERATOR_UNSEAL_REQUIRED');
  const sealConfig = { type: status.type, shares: status.n, threshold: status.t };
  requireCondition(validSealConfig(sealConfig), 'VAULT_SHAMIR_CONFIG_REQUIRED');
  return { clusterId: status.cluster_id, sealConfig };
}

function validSealConfig(config) {
  return config?.type === 'shamir' && Number.isInteger(config.shares) && config.shares >= 1
    && config.shares <= 255 && Number.isInteger(config.threshold) && config.threshold >= 1
    && config.threshold <= config.shares && Object.keys(config).length === 3;
}

function validMarker(marker) {
  return marker?.schemaVersion === 1 && marker.installationId === installationId
    && marker.backupId === backupId && typeof marker.nonce === 'string'
    && /^[a-f0-9]{64}$/.test(marker.nonce) && Object.keys(marker).length === 4;
}

function prepareRecoveryMarker(session) {
  const client = new VaultCli(session.environment, session.executable, session.prefix);
  const markerPath = `helm-kv/data/recovery-markers/${backupId}`;
  const existing = client.read(markerPath, true)?.data;
  if (existing !== undefined) {
    requireCondition(validMarker(existing), 'VAULT_RECOVERY_MARKER_CONFLICT');
    return existing;
  }
  const marker = { schemaVersion: 1, installationId, backupId, nonce: randomBytes(32).toString('hex') };
  try { client.write(markerPath, { options: { cas: 0 }, data: marker }); }
  catch (error) {
    // A lost write response is only recoverable when that exact immutable marker exists.
    if (!isDeepStrictEqual(client.read(markerPath, true)?.data, marker)) throw error;
  }
  requireCondition(isDeepStrictEqual(client.read(markerPath)?.data, marker), 'VAULT_RECOVERY_MARKER_UNCONFIRMED');
  return marker;
}

async function backup(identity, environment) {
  stage = 'CHECKING_VAULT_STATUS';
  const { clusterId, sealConfig } = await snapshotStatus(environment);
  const root = process.env.BACKUP_DIR;
  await privateDirectory(root);
  const parent = path.join(root, 'vault', installationId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await privateDirectory(parent);
  const destination = path.join(parent, backupId);
  try { await lstat(destination); throw new Error('BACKUP_ID_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = await mkdtemp(path.join(parent, '.pending-'));
  try {
    const snapshot = path.join(work, 'snapshot.snap');
    stage = 'SAVING_SNAPSHOT';
    let recoveryMarker;
    const measured = await saveVaultSnapshot({ localCaFile: environment.VAULT_CACERT, identity,
      destination: snapshot, environment, maximumBytes: maximumSnapshotBytes,
      beforeSnapshot: async session => { recoveryMarker = prepareRecoveryMarker(session); } });
    const descriptor = { schemaVersion: 1, format: 'helm-vault-raft-v1', installationId, backupId,
      clusterId, capturedAt: new Date().toISOString(), sealConfig, recoveryMarker,
      snapshotSha256: measured.sha256, snapshotByteLength: measured.bytes };
    await writeJson(path.join(work, 'metadata.json'), descriptor);
    const archive = path.join(work, 'snapshot.tar');
    stage = 'ENCRYPTING_SNAPSHOT';
    await execute('tar', ['--create', '--file', archive, '--directory', work, 'metadata.json', 'snapshot.snap']);
    await execute('/opt/helm/bin/backup-file', ['encrypt', archive, path.join(pending, 'snapshot')]);
    const manifest = { ...descriptor, archiveManifestSha256: await sha256(path.join(pending, 'snapshot/manifest.json')) };
    await writeJson(path.join(pending, 'manifest.json'), manifest);
    await execute('sync', ['-f', pending]);
    await execute('mv', ['-T', '--no-clobber', '--', pending, destination]);
    try { await lstat(pending); throw new Error('BACKUP_PUBLICATION_RACE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await execute('sync', ['-f', parent]);
    process.stdout.write(JSON.stringify({ directory: destination, manifestSha256: await sha256(path.join(destination, 'manifest.json')) }) + '\n');
  } finally { await rm(pending, { recursive: true, force: true }); }
}

async function restore(identity, environment) {
  stage = 'VERIFYING_ARCHIVE';
  requireCondition(['verify', 'describe'].includes(operation) || (typeof identity.vault.operatorToken === 'string' && identity.vault.operatorToken.length >= 16
    && identity.vault.operatorToken.length <= 4096 && !/[\r\n\0]/.test(identity.vault.operatorToken)), 'OPERATOR_CREDENTIAL_REQUIRED');
  const manifest = await readJson(path.join(source, 'manifest.json'), expectedManifestSha256);
  requireCondition(manifest.schemaVersion === 1 && manifest.format === 'helm-vault-raft-v1'
    && manifest.installationId === installationId && manifest.backupId === backupId
    && Number.isSafeInteger(manifest.snapshotByteLength) && manifest.snapshotByteLength > 0
    && manifest.snapshotByteLength <= maximumSnapshotBytes
    && validMarker(manifest.recoveryMarker)
    && validSealConfig(manifest.sealConfig)
    && /^[a-f0-9-]{36}$/.test(manifest.clusterId)
    && /^[a-f0-9]{64}$/.test(manifest.archiveManifestSha256)
    && /^[a-f0-9]{64}$/.test(manifest.snapshotSha256), 'INVALID_VAULT_ARCHIVE_MANIFEST');
  const encryptedArchive = await readJson(path.join(source, 'snapshot/manifest.json'), manifest.archiveManifestSha256);
  requireCondition(Number.isSafeInteger(encryptedArchive.plaintextByteLength)
    && encryptedArchive.plaintextByteLength >= manifest.snapshotByteLength
    && encryptedArchive.plaintextByteLength <= manifest.snapshotByteLength + 32_768,
  'INVALID_VAULT_ARCHIVE_SIZE');
  const archive = path.join(work, 'snapshot.tar');
  await execute('/opt/helm/bin/backup-file', ['decrypt', path.join(source, 'snapshot'), archive, manifest.archiveManifestSha256]);
  const names = (await execute('tar', ['--list', '--quoting-style=escape', '--file', archive])).split('\n');
  requireCondition(names.length === 2 && names[0] === 'metadata.json' && names[1] === 'snapshot.snap', 'UNSAFE_VAULT_ARCHIVE_ENTRIES');
  const entries = (await execute('tar', ['--list', '--verbose', '--file', archive])).split('\n');
  requireCondition(entries.length === 2 && entries.every(entry => entry.startsWith('-')), 'UNSAFE_VAULT_ARCHIVE_TYPES');
  const descriptor = JSON.parse(await execute('tar', ['--extract', '--to-stdout', '--file', archive, 'metadata.json']));
  const { archiveManifestSha256, ...expected } = manifest;
  requireCondition(isDeepStrictEqual(descriptor, expected), 'VAULT_ARCHIVE_IDENTITY_MISMATCH');
  await execute('tar', ['--extract', '--file', archive, '--directory', work,
    '--no-same-owner', '--no-same-permissions', '--keep-old-files', 'snapshot.snap']);
  const snapshot = path.join(work, 'snapshot.snap');
  requireCondition((await lstat(snapshot)).size === manifest.snapshotByteLength
    && await sha256(snapshot) === manifest.snapshotSha256, 'VAULT_SNAPSHOT_CHECKSUM_MISMATCH');
  if (operation === 'describe') {
    process.stdout.write(JSON.stringify({ descriptor: manifest,
      manifestSha256: expectedManifestSha256 }) + '\n');
    return;
  }
  const { clusterId, sealConfig } = await snapshotStatus(environment);
  requireCondition(isDeepStrictEqual(sealConfig, manifest.sealConfig), 'VAULT_SHAMIR_CONFIG_MISMATCH');
  requireCondition(operation === 'restore-new-cluster' || clusterId === manifest.clusterId, 'VAULT_CLUSTER_REPLACEMENT_REQUIRES_EXPLICIT_ACTION');
  if (operation === 'verify') {
    stage = 'VERIFYING_RECOVERY_MARKER';
    await withVaultBackupSession({ localCaFile: environment.VAULT_CACERT, identity, environment }, async session => {
      const client = new VaultCli(session.environment, session.executable, session.prefix);
      const restored = client.read(`helm-kv/data/recovery-markers/${backupId}`, true)?.data;
      requireCondition(isDeepStrictEqual(restored, manifest.recoveryMarker), 'VAULT_RECOVERY_MARKER_MISMATCH');
    });
    process.stdout.write(JSON.stringify({ installationId, backupId, clusterId,
      state: 'VERIFIED', manifestSha256: expectedManifestSha256 }) + '\n');
    return;
  }
  const authenticated = { ...environment, VAULT_TOKEN: identity.vault.operatorToken };
  try {
    stage = 'TRANSMITTING_RESTORE';
    await execute('vault', ['operator', 'raft', 'snapshot', 'restore',
      ...(operation === 'restore-new-cluster' ? ['-force'] : []), snapshot], authenticated);
  } finally { delete authenticated.VAULT_TOKEN; }
  // A successful upload is not proof of unseal or application data/key recovery.
  process.stdout.write(JSON.stringify({ installationId, backupId, clusterId: manifest.clusterId,
    state: 'RESTORE_ACCEPTED', manifestSha256: expectedManifestSha256, operatorVerificationRequired: true }) + '\n');
}

try {
  process.umask(0o077);
  requireCondition(['backup', 'restore', 'restore-new-cluster', 'verify', 'describe'].includes(operation)
    && /^[A-Za-z0-9_-]{1,80}$/.test(installationId ?? '') && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(backupId ?? '')
    && (operation === 'backup' ? process.argv.length === 5 : process.argv.length === 7
      && typeof source === 'string' && /^[a-f0-9]{64}$/.test(expectedManifestSha256 ?? '')), 'INVALID_VAULT_ARCHIVE_ARGUMENTS');
  let input = '';
  for await (const bytes of process.stdin) {
    requireCondition(Buffer.byteLength(input) + bytes.length <= 131_072, 'BOOTSTRAP_INPUT_TOO_LARGE');
    input += bytes.toString('utf8');
  }
  const identity = JSON.parse(input);
  input = '';
  requireCondition(identity.schemaVersion === 1 && identity.vault?.address === 'https://vault:8200'
    && typeof identity.vault.caPem === 'string' && identity.vault.caPem.length > 0
    && identity.vault.caPem.length <= 65_536, 'INVALID_VAULT_BOOTSTRAP');
  await privateDirectory(process.env.BACKUP_WORK_DIR);
  const filesystem = await statfs(process.env.BACKUP_WORK_DIR, { bigint: true });
  requireCondition(filesystem.bavail * filesystem.bsize >= BigInt(maximumSnapshotBytes * 2 + 134_217_728), 'INSUFFICIENT_ENCRYPTED_SCRATCH');
  work = await mkdtemp(path.join(process.env.BACKUP_WORK_DIR, 'vault-archive-'));
  const authority = await open(path.join(work, 'ca.pem'), 'wx', 0o600);
  try { await authority.writeFile(identity.vault.caPem); } finally { await authority.close(); }
  const environment = { ...process.env, VAULT_ADDR: identity.vault.address, VAULT_CACERT: path.join(work, 'ca.pem'),
    VAULT_TOKEN: '', VAULT_MAX_RETRIES: '0', VAULT_CLIENT_TIMEOUT: '300s', VAULT_SKIP_VERIFY: 'false' };
  if (operation === 'backup') await backup(identity, environment);
  else await restore(identity, environment);
} catch (error) {
  const reason = error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'EXTERNAL_TOOL_OR_INPUT_FAILURE';
  process.stderr.write(`VAULT_ARCHIVE_FAILED: ${stage} ${reason}; restore outcome may be unknown after transmission\n`);
  process.exitCode = 1;
} finally {
  if (work) await rm(work, { recursive: true, force: true });
}
