import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acquireMaintenance, deploymentContainers } from '../maintenance.mjs';
import { run } from '../process.mjs';

test('Docker maintenance ownership excludes parallel startup and preserves another owner', async () => {
  const project = 'helm-glass-lock-' + randomUUID();
  const docker = args => run('docker', args);
  const inputs = { docker, image: process.env.PROVISION_TEST_IMAGE ?? 'helmglass-provision:0.1.0',
    installationId: 'fixture', project };
  const owner = await acquireMaintenance(inputs);
  try {
    await assert.rejects(acquireMaintenance({ ...inputs }));
    const state = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', owner.id])).stdout);
    assert.equal(state.Status, 'created');
    assert.equal(state.Running, false);
    await owner.release();
    await owner.release();
    const next = await acquireMaintenance({ ...inputs });
    try {
      assert.notEqual(next.id, owner.id);
      await owner.release();
      assert.equal((await docker(['inspect', '--format', '{{.Id}}', next.id])).stdout.trim(), next.id);
    } finally { await next.release(); }
  } finally { await owner.release(); }
});

test('Compose one-shot jobs do not replace the deployed service inventory', async () => {
  const project = 'helm-glass-inventory-' + randomUUID();
  const docker = args => run('docker', args);
  const image = process.env.PROVISION_TEST_IMAGE ?? 'helmglass-provision:0.1.0';
  const ids = [];
  try {
    for (const oneoff of ['False', 'True']) {
      ids.push((await docker(['create', '--network', 'none',
        '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=api',
        '--label', `com.docker.compose.oneoff=${oneoff}`, '--entrypoint', 'node', image, '--version'])).stdout.trim());
    }
    assert.deepEqual(await deploymentContainers(docker, 'api', project), [ids[0]]);
    await docker(['rm', ids[0]]);
    ids.shift();
    assert.deepEqual(await deploymentContainers(docker, 'api', project), []);
  } finally { if (ids.length) await docker(['rm', ...ids]); }
});
