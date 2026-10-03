import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { run } from '../process.mjs';
import { runRecoveryContainer } from '../recovery-container.mjs';

test('Physical restore process executes once, reuses its receipt after lost response and preserves failures', async () => {
  const recoveryId = randomUUID();
  const docker = (args, options = {}) => run('docker', args, options);
  const input = { docker, recoveryId, installationId: 'fixture', step: 'once',
    image: process.env.PROVISION_TEST_IMAGE ?? 'helmglass-provision:cold-backup-test', entrypoint: 'node',
    arguments: ['-e', 'process.stdout.write(JSON.stringify({nonce:Math.random()})+"\\n")'],
    options: ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '64m'] };
  try {
    const first = await runRecoveryContainer(input);
    assert.ok(JSON.parse(first.output).nonce >= 0);
    assert.deepEqual(await runRecoveryContainer(input), first);
    await assert.rejects(runRecoveryContainer({ ...input, options: [...input.options, '--pids-limit', '32'] }), /different ownership/);
    const failure = { ...input, step: 'failure', arguments: ['-e', 'process.exit(7)'] };
    await assert.rejects(runRecoveryContainer(failure), /Physical recovery failed/);
    const name = `helm-glass-recovery-${recoveryId}-failure`;
    const before = (await docker(['inspect', '--format', '{{.State.StartedAt}}', name])).stdout;
    await assert.rejects(runRecoveryContainer(failure), /Physical recovery failed/);
    assert.equal((await docker(['inspect', '--format', '{{.State.StartedAt}}', name])).stdout, before);
  } finally {
    const ids = (await docker(['ps', '--all', '--quiet', '--filter', `label=helmglass.recovery=${recoveryId}`])).stdout.trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      assert.equal((await docker(['inspect', '--format', '{{index .Config.Labels "helmglass.installation"}}', id])).stdout.trim(), 'fixture');
      await docker(['rm', '--force', id]);
    }
  }
});
