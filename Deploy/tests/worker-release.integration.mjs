import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from '../process.mjs';
import { WorkerRelease } from '../worker-release.mjs';

test('worker release replaces stopped obsolete containers while preserving admitted workers',
  { timeout: 120_000 }, async () => {
    const fixture = randomUUID();
    const project = `helm-worker-release-${fixture}`;
    const context = process.env.HELM_TEST_DOCKER_CONTEXT ?? 'desktop-linux';
    const base = process.env.PROVISION_IMAGE ?? 'helmglass-provision:dev-107';
    const oldImage = `${project}:old`;
    const newImage = `${project}:new`;
    const seed = `${project}-image-seed`;
    const directory = await mkdtemp(join(tmpdir(), 'helm-worker-release-'));
    const path = join(directory, 'compose.json');
    const docker = (args, options) => run('docker', ['--context', context, ...args], options);
    const compose = (image, args) => docker(['compose', '-p', project, '-f', path, ...args],
      { environment: { ...process.env, WORKER_IMAGE: image } });
    const inspect = async id => JSON.parse((await docker(['inspect', id])).stdout)[0];
    const identifiers = async () => (await docker(['ps', '--all', '--quiet',
      '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=browser-worker'])).stdout.trim().split(/\s+/).filter(Boolean);
    const healthy = async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const states = await Promise.all((await identifiers()).map(inspect));
        if (states.length === 2 && states.every(state => state.State.Health?.Status === 'healthy')) return states;
        await delay(200);
      }
      throw new Error('Fixture workers did not become healthy');
    };
    await writeFile(path, JSON.stringify({ services: { 'browser-worker': {
      image: '${WORKER_IMAGE}', entrypoint: ['node'], command: ['-e', 'setInterval(() => {}, 1000)'],
      network_mode: 'none', read_only: true, cap_drop: ['ALL'], pids_limit: 32,
      healthcheck: { test: ['CMD', 'node', '-e', 'process.exit(0)'], interval: '1s', timeout: '1s', retries: 1 },
    } } }));
    try {
      await docker(['create', '--name', seed, '--network', 'none', '--label', `helmglass.acceptance=${fixture}`,
        '--entrypoint', 'node', base, '-e', 'process.exit(0)']);
      for (const [image, release] of [[oldImage, 'old'], [newImage, 'new']]) {
        await docker(['commit', '--change', `LABEL helmglass.fixture.release=${release}`, seed, image]);
      }
      const expectedId = JSON.parse((await docker(['image', 'inspect', newImage])).stdout)[0].Id;
      const release = new WorkerRelease({ docker, identifiers, imageId: expectedId, count: 2 });
      await compose(oldImage, ['up', '-d', '--scale', 'browser-worker=1']);
      const obsoleteId = (await identifiers())[0];
      await assert.rejects(release.prepare(), /drain active browser work/);
      assert.equal((await inspect(obsoleteId)).State.Running, true);

      // Reproduce the defect: no-recreate restarts the stopped old image and adds a new replica.
      await docker(['stop', obsoleteId]);
      await compose(newImage, ['up', '-d', '--no-recreate', '--scale', 'browser-worker=2']);
      const mixed = await healthy();
      assert.equal(new Set(mixed.map(state => state.Image)).size, 2);
      await assert.rejects(release.verify(), /image does not match/);
      const retained = mixed.find(state => state.Image === expectedId);
      assert.ok(retained);

      await docker(['stop', obsoleteId]);
      await release.prepare();
      await docker(['start', obsoleteId]);
      await assert.rejects(release.removeObsolete(), /failed with exit code/);
      assert.equal((await inspect(obsoleteId)).State.Running, true, 'Removal must not force-stop a raced worker');

      await docker(['stop', obsoleteId]);
      await release.prepare();
      await release.removeObsolete();
      await compose(newImage, ['up', '-d', '--no-recreate', '--scale', 'browser-worker=2']);
      const completed = await healthy();
      await release.verify();
      assert.ok(completed.every(state => state.Image === expectedId));
      const preserved = completed.find(state => state.Id === retained.Id);
      assert.ok(preserved, 'The already admitted worker must retain its container');
      assert.equal(preserved.State.StartedAt, retained.State.StartedAt, 'The admitted worker must not restart');
      assert.equal(completed.some(state => state.Id.startsWith(obsoleteId)), false);
      await assert.rejects(new WorkerRelease({ docker, identifiers, imageId: expectedId, count: 1 }).prepare(),
        /drain the existing pool/);
      await assert.rejects(new WorkerRelease({ docker, identifiers, imageId: expectedId, count: 3 }).verify(),
        /count does not match/);
    } finally {
      await compose(newImage, ['down', '--remove-orphans']);
      await docker(['rm', '--force', seed], { allowedExitCodes: [0, 1] });
      await docker(['image', 'rm', oldImage, newImage], { allowedExitCodes: [0, 1] });
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true });
    }
  });
