import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { run } from '../process.mjs';
import { protectDirectory } from '../protected-files.mjs';
import { fenceInstallation } from '../recovery-fencing.mjs';
import { prepareRecoveryEvidence } from '../recovery-evidence.mjs';
import { readRecoveryState } from '../recovery-files.mjs';

test('Real Docker evidence preserves original proof on retry and never accepts a different restore boundary', async () => {
  const recoveryId = randomUUID();
  const project = 'helm-glass-evidence-' + recoveryId;
  const image = process.env.PROVISION_TEST_IMAGE ?? 'helmglass-provision:cold-backup-test';
  const docker = (args, options = {}) => run('docker', args, options);
  const root = await mkdtemp(join(tmpdir(), 'helm-recovery-evidence-'));
  const ledgerVolume = 'helm-evidence-ledger-' + recoveryId;
  const redisVolume = 'helm-glass-redis-recovery-' + recoveryId;
  const proofVolume = 'helm-glass-proof-recovery-' + recoveryId;
  let runtime;
  try {
    const repository = resolve('.');
    const localSecrets = await protectDirectory(join(root, 'secrets'), repository);
    const localRecovery = await protectDirectory(join(root, 'custody'), repository);
    await docker(['volume', 'create', '--label', `helmglass.recovery=${recoveryId}`, ledgerVolume]);
    const ledgerPath = JSON.parse((await docker(['volume', 'inspect', ledgerVolume])).stdout)[0].Mountpoint;
    await docker(['run', '--rm', '--network', 'none', '--user', '0:0',
      '--mount', `type=volume,source=${ledgerVolume},target=/ledger`, '--entrypoint', 'node', image,
      '--input-type=module', '-e', "import{chmod,chown}from'node:fs/promises';await chown('/ledger',10001,10001);await chmod('/ledger',0o700);"]);
    await docker(['run', '--rm', '--interactive', '--network', 'none', '--user', '10001:10001',
      '--mount', `type=volume,source=${ledgerVolume},target=/ledger`, '--entrypoint', 'node', image,
      '/opt/helm/provision/src/ledger-files.mjs'], { input: JSON.stringify({ schemaVersion: 1,
        installationId: 'fixture', mode: 'prepare' }) });
    runtime = (await docker(['run', '--detach', '--init', '--network', 'none',
      '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=api',
      '--entrypoint', 'sleep', image, '300'])).stdout.trim();
    const daemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
    const fencing = await fenceInstallation({ docker, expectedDaemonId: daemon.ID, previousContainers: [], project });
    const state = { schemaVersion: 1, recoveryId, backupId: 'fixture-backup', daemonId: daemon.ID, stage: 'RESTORING' };
    const input = { docker, configuration: { LOCAL_SECRETS_DIR: localSecrets, LOCAL_RECOVERY_DIR: localRecovery,
      INSTALLATION_ID: 'fixture', DELETION_LEDGER_DIR: ledgerPath }, release: { PROVISION_IMAGE: image },
      state, fencing, restorePoint: 'named fixture point', walLossWindow: 'fixture boundary only', repository };
    const first = await prepareRecoveryEvidence(input);
    assert.equal(first.stage, 'RECONCILING');
    assert.equal(first.redisVolume, redisVolume);
    const file = join(localRecovery, 'recoveries', recoveryId, 'proof.json');
    const bytes = await readFile(file);
    assert.equal(first.proofSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await prepareRecoveryEvidence(input), first);
    assert.deepEqual(await readFile(file), bytes);
    await assert.rejects(prepareRecoveryEvidence({ ...input, restorePoint: 'another boundary' }));
    assert.deepEqual(await readRecoveryState(localSecrets), first);
    assert.deepEqual(await readFile(file), bytes);
  } finally {
    if (runtime) await docker(['rm', '--force', runtime]);
    for (const volume of [proofVolume, redisVolume, ledgerVolume]) {
      const present = (await docker(['volume', 'ls', '--quiet', '--filter', `name=^${volume}$`])).stdout.trim();
      if (present) {
        const info = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0];
        assert.equal(info.Labels?.['helmglass.recovery'], recoveryId);
        await docker(['volume', 'rm', volume]);
      }
    }
    const absolute = await realpath(root);
    const temporaryRoot = await realpath(tmpdir());
    assert.ok(absolute.startsWith(temporaryRoot + sep));
    assert.ok(absolute.includes('helm-recovery-evidence-'));
    await rm(absolute, { recursive: true, force: true });
  }
});
