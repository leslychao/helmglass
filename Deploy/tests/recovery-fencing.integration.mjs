import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { fenceInstallation, recoveryDocker } from '../recovery-fencing.mjs';

test('recovery stops only its verified installation and confirms physical process closure',
  { timeout: 120_000 }, async () => {
    const docker = recoveryDocker(process.env);
    const fixture = randomUUID();
    const project = `helm-glass-recovery-${fixture}`;
    const daemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
    const created = [];
    const start = async (service, projectName = project) => {
      const id = (await docker(['run', '--detach', '--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--memory', '32m', '--pids-limit', '8',
        '--label', `helmglass.acceptance=${fixture}`, '--label', `com.docker.compose.project=${projectName}`,
        '--label', `com.docker.compose.service=${service}`,
        '--entrypoint', 'sleep',
        'node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532',
        '300'])).stdout.trim();
      created.push(id);
      return id;
    };
    const running = async id => JSON.parse((await docker(['inspect', '--format', '{{json .State.Running}}', id])).stdout);
    const remove = async id => {
      const owner = (await docker(['inspect', '--format', '{{index .Config.Labels "helmglass.acceptance"}}', id])).stdout.trim();
      assert.equal(owner, fixture);
      await docker(['rm', '--force', id]);
      created.splice(created.indexOf(id), 1);
    };
    try {
      const api = await start('api');
      const nginx = await start('nginx');
      const database = await start('postgres');
      const foreign = await start('api', `${project}-foreign`);
      const unexpected = await start('unexpected');
      const options = { docker, project, expectedDaemonId: daemon.ID,
        previousContainers: [{ containerId: api, service: 'api' }, { containerId: nginx, service: 'nginx' }] };
      await assert.rejects(fenceInstallation(options), /unexpected container/);
      assert.equal(await running(api), true, 'An unrecognized topology prevents the first stop');
      await remove(unexpected);
      await assert.rejects(fenceInstallation({ ...options, expectedDaemonId: 'different-daemon' }), /original Docker daemon/);
      await assert.rejects(fenceInstallation({ ...options,
        previousContainers: [{ containerId: foreign, service: 'api' }] }), /ownership/);
      assert.equal(await running(api), true, 'A foreign old runtime must not authorize local fencing');
      const result = await fenceInstallation(options);
      assert.equal(await running(api), false);
      assert.equal(await running(nginx), false);
      assert.equal(await running(database), true, 'Data services remain available for restore orchestration');
      assert.equal(await running(foreign), true, 'An unrelated installation is untouched');
      assert.deepEqual(result.receipt.expectedContainerIds, [api, nginx].sort());
      assert.ok(result.receipt.containers.every(value => value.state === 'exited'));
      assert.equal(result.sha256, createHash('sha256').update(result.bytes).digest('hex'));
      await remove(api);
      const repeated = await fenceInstallation(options);
      assert.equal(repeated.receipt.containers.find(value => value.containerId === api).state, 'absent');
    } finally {
      for (const id of [...created]) await remove(id);
    }
  });
