import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prepareRecoveryRedis } from '../recovery-files.mjs';
import { recoveryDocker } from '../recovery-fencing.mjs';

test('restore allocates a fresh private Redis volume and never accepts existing tickets as empty',
  { timeout: 60_000 }, async () => {
    const docker = recoveryDocker(process.env);
    const recoveryId = randomUUID();
    const volume = `helm-glass-redis-recovery-${recoveryId}`;
    const daemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
    const image = JSON.parse((await docker(['image', 'inspect', 'helmglass-provision:0.1.0'])).stdout)[0].Id;
    const options = { docker, recoveryId, daemonId: daemon.ID, image };
    try {
      await assert.rejects(prepareRecoveryRedis({ ...options, daemonId: 'wrong-daemon' }), /different Docker daemon/);
      const first = await prepareRecoveryRedis(options);
      assert.equal(first.receipt.volume, volume);
      assert.equal(first.receipt.source, 'new-empty-volume');
      assert.equal((await prepareRecoveryRedis(options)).receipt.volume, volume);
      await docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '10001:10001',
        '--cap-drop', 'ALL', '--mount', `type=volume,source=${volume},target=/redis-data`,
        '--entrypoint', 'node', image, '-e',
        'require("node:fs").writeFileSync("/redis-data/existing-ticket", "fixture", {mode:0o600})']);
      await assert.rejects(prepareRecoveryRedis(options));
      const observed = await docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '10001:10001',
        '--cap-drop', 'ALL', '--mount', `type=volume,source=${volume},target=/redis-data,readonly`,
        '--entrypoint', 'node', image, '-e',
        'process.stdout.write(require("node:fs").readFileSync("/redis-data/existing-ticket"))']);
      assert.equal(observed.stdout, 'fixture', 'Rejected recovery must not delete existing contents');
    } finally {
      const owner = (await docker(['volume', 'inspect', '--format', '{{index .Labels "helmglass.recovery"}}', volume]))
        .stdout.trim();
      assert.equal(owner, recoveryId);
      await docker(['volume', 'rm', volume]);
    }
  });
