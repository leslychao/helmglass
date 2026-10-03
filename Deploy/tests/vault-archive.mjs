import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreVault } from '../vault-restore.mjs';

/** Runs against the existing isolated Raft fixture, without a second Vault setup owner. */
export async function verifyEncryptedVaultArchive({ container, installation, cli, rootToken, ca, createNewCluster }) {
  const image = process.env.VAULT_ARCHIVE_IMAGE ?? 'helmglass-provision:cold-backup-test';
  const id = randomUUID();
  const volume = 'helm-vault-archive-' + id;
  function docker(args, { input, failure = false } = {}) {
    const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 1_048_576 });
    if (failure) assert.notEqual(result.status, 0);
    else assert.equal(result.status, 0, `Vault archive fixture ${args[0]} failed; ${
      /^VAULT_ARCHIVE_FAILED: [A-Z_ ]+;/m.exec(result.stderr)?.[0] ?? 'diagnostics withheld'}`);
    return result.stdout.trim();
  }
  const mount = ['--mount', `type=volume,source=${volume},target=/fixture`];
  const environment = ['--env', 'BACKUP_DIR=/fixture/backup', '--env', 'BACKUP_WORK_DIR=/fixture/work',
    '--env', 'BACKUP_RECIPIENT_CERT=/fixture/recipient.pem', '--env', 'BACKUP_PRIVATE_KEY_FILE=/fixture/key.pem',
    '--env', 'BACKUP_KEY_PASSWORD_FILE=/fixture/password'];
  function helper(action, bootstrap, { failure = false, targetContainer = container, expectedHash = archiveHash } = {}) {
    return docker(['run', '--rm', '--interactive', '--network', 'container:' + targetContainer,
      '--user', '0', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE',
      '--memory', '512m', '--memory-swap', '512m', ...mount, ...environment,
      '--entrypoint', 'node', image, '/opt/helm/vault/archive.mjs', action,
      installation.installationId, 'encrypted-fixture', ...(action === 'backup' ? [] : [archive, expectedHash])],
    { input: JSON.stringify(bootstrap), failure });
  }
  let archive;
  let archiveHash;
  docker(['volume', 'create', '--label', 'helmglass.archive-fixture=' + id, volume]);
  try {
    docker(['run', '--rm', '--network', 'none', '--user', '0', ...mount,
      '--entrypoint', '/bin/sh', image, '-c', `
      set -eu
      umask 077
      mkdir /fixture/backup /fixture/work
      chown 999:999 /fixture/backup /fixture/work
      openssl rand -base64 32 > /fixture/password
      openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -aes-256-cbc \
        -pass file:/fixture/password -out /fixture/key.pem 2>/dev/null
      openssl req -new -x509 -key /fixture/key.pem -passin file:/fixture/password \
        -out /fixture/recipient.pem -subj '/CN=Encrypted Raft fixture' -days 1
    `]);
    const key = 'profiles-' + randomUUID();
    const plaintext = randomBytes(32).toString('base64');
    cli.write(`helm-transit/keys/${key}`, { type: 'aes256-gcm96' });
    cli.write(`helm-transit/keys/${key}/config`, { deletion_allowed: true });
    const wrapped = cli.write(`helm-transit/encrypt/${key}`, { plaintext }).ciphertext;
    const original = cli.read('helm-kv/data/services/provision').data;
    const backupIdentity = { schemaVersion: 1, vault: { address: 'https://vault:8200', caPem: ca,
      ...installation.credentials.backup } };
    const receipt = JSON.parse(helper('backup', backupIdentity));
    archive = receipt.directory;
    archiveHash = receipt.manifestSha256;
    assert.equal(archive, '/fixture/backup/vault/' + installation.installationId + '/encrypted-fixture');
    assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/);
    helper('backup', backupIdentity, { failure: true });
    const markerPath = 'helm-kv/data/recovery-markers/encrypted-fixture';
    cli.execute(['delete', '-format=json', markerPath]);
    helper('verify', backupIdentity, { failure: true });
    cli.write('helm-kv/data/services/provision', { data: { fixture: 'after-encrypted-snapshot' } });
    cli.execute(['delete', '-format=json', `helm-transit/keys/${key}`]);
    assert.throws(() => cli.write(`helm-transit/decrypt/${key}`, { ciphertext: wrapped }));

    const cipher = archive + '/snapshot/00000000.cms';
    docker(['run', '--rm', '--network', 'none', '--user', '0', ...mount, '--entrypoint', '/bin/sh', image,
      '-c', 'cp -- "$1" "$1.original"; truncate -s 1 "$1"', '--', cipher]);
    const operatorIdentity = { schemaVersion: 1, vault: { address: 'https://vault:8200', caPem: ca, operatorToken: rootToken } };
    helper('restore', operatorIdentity, { failure: true, expectedHash: '0'.repeat(64) });
    helper('restore', operatorIdentity, { failure: true });
    assert.equal(cli.read('helm-kv/data/services/provision').data.fixture, 'after-encrypted-snapshot');
    docker(['run', '--rm', '--network', 'none', '--user', '0', ...mount, '--entrypoint', '/bin/sh', image,
      '-c', 'mv -- "$1.original" "$1"', '--', cipher]);
    assert.equal(JSON.parse(helper('restore', operatorIdentity)).state, 'RESTORE_ACCEPTED');
    let restored = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        assert.deepEqual(cli.read('helm-kv/data/services/provision').data, original);
        assert.equal(cli.write(`helm-transit/decrypt/${key}`, { ciphertext: wrapped }).plaintext, plaintext);
        restored = true;
        break;
      } catch { await delay(250); }
    }
    assert.ok(restored, 'Encrypted production archive restores both KV and the deleted Transit key');
    const verified = JSON.parse(helper('verify', backupIdentity));
    assert.equal(verified.state, 'VERIFIED');
    assert.equal(verified.manifestSha256, receipt.manifestSha256);
    const marker = cli.read(markerPath).data;
    cli.write(markerPath, { data: { ...marker, nonce: randomBytes(32).toString('hex') } });
    helper('verify', backupIdentity, { failure: true });
    const described = JSON.parse(helper('describe', { schemaVersion: 1, vault: { address: 'https://vault:8200', caPem: ca } }));
    assert.equal(described.manifestSha256, receipt.manifestSha256);
    const fresh = await createNewCluster();
    let progress;
    let temporaryCustody;
    let restoreTransmissions = 0;
    const recover = () => restoreVault({ containerId: fresh.container, recoveryId: id,
      manifest: described.descriptor, originalShares: fresh.originalShares, temporaryCustody, progress,
      saveTemporaryCustody: async value => { temporaryCustody = value; },
      saveProgress: async value => { progress = value; },
      runArchive: async ({ operation, operatorToken }) => {
        const identity = operation === 'verify' ? backupIdentity : { schemaVersion: 1,
          vault: { address: 'https://vault:8200', caPem: ca, operatorToken } };
        const result = JSON.parse(helper(operation, identity, { targetContainer: fresh.container }));
        if (operation === 'restore-new-cluster') {
          restoreTransmissions++;
          assert.equal(result.state, 'RESTORE_ACCEPTED');
          throw new Error('SIMULATED_LOST_RESTORE_RESPONSE');
        }
        return result;
      } });
    await assert.rejects(recover(), /SIMULATED_LOST_RESTORE_RESPONSE/);
    assert.equal(progress.stage, 'RESTORE_STARTED');
    const newClusterVerification = await recover();
    assert.equal(newClusterVerification.state, 'VERIFIED');
    assert.equal(newClusterVerification.clusterId, described.descriptor.clusterId);
    assert.notEqual(newClusterVerification.clusterId, progress.temporaryClusterId);
    assert.equal(restoreTransmissions, 1, 'A lost restore response is reconciled without another force restore');
    assert.equal(progress.stage, 'VERIFIED');
    const restoredClient = fresh.client(rootToken);
    assert.deepEqual(restoredClient.read('helm-kv/data/services/provision').data, original);
    assert.equal(restoredClient.write(`helm-transit/decrypt/${key}`, { ciphertext: wrapped }).plaintext, plaintext);
    process.stdout.write('PASS: fresh Raft cluster force restore seals under original Shamir shares, restores cluster identity and exact backup marker, KV and Transit key.\n');
    process.stdout.write('PASS: encrypted Raft archive restores actual KV and deleted Transit key; corrupt ciphertext never reaches restore. Operator authorization stays explicit.\n');
  } finally {
    assert.equal(docker(['volume', 'inspect', '--format', '{{index .Labels "helmglass.archive-fixture"}}', volume]), id);
    docker(['volume', 'rm', volume]);
  }
}
