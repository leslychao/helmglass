import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from '../process.mjs';
import { deployWorkerRelease } from '../worker-release.mjs';

test('redeployment replaces running and stopped old containers, preserves data and scales down',
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
    const healthy = async (count) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const states = await Promise.all((await identifiers()).map(inspect));
        if (states.length === count && states.every(state => state.State.Health?.Status === 'healthy')) return states;
        await delay(200);
      }
      throw new Error('Fixture workers did not become healthy');
    };
    const service = {
      image: '${WORKER_IMAGE}', entrypoint: ['node'], command: ['-e', `
        const fs = require('node:fs');
        if (!fs.existsSync('/data/marker')) fs.writeFileSync('/data/marker', 'preserved');
        process.on('SIGTERM', () => {
          fs.writeFileSync('/data/' + require('node:os').hostname() + '.stopped', 'SIGTERM');
          process.exit(0);
        });
        setInterval(() => {}, 1000);
      `],
      network_mode: 'none', read_only: true, user: '0:0', cap_drop: ['ALL'], pids_limit: 32,
      volumes: ['data:/data'], stop_grace_period: '5s',
      healthcheck: { test: ['CMD', 'node', '-e', 'process.exit(0)'], interval: '1s', timeout: '1s', retries: 1 },
    };
    await writeFile(path, JSON.stringify({ services: { 'browser-worker': service, api: service }, volumes: { data: {} } }));
    try {
      await docker(['create', '--name', seed, '--network', 'none', '--label', `helmglass.acceptance=${fixture}`,
        '--entrypoint', 'node', base, '-e', 'process.exit(0)']);
      for (const [image, release] of [[oldImage, 'old'], [newImage, 'new']]) {
        await docker(['commit', '--change', `LABEL helmglass.fixture.release=${release}`, seed, image]);
      }
      const expectedId = JSON.parse((await docker(['image', 'inspect', newImage])).stdout)[0].Id;
      const release = { docker, compose: args => compose(newImage, args), identifiers, imageId: expectedId, count: 2 };
      await compose(oldImage, ['up', '-d', '--scale', 'browser-worker=2']);
      const original = await healthy(2);
      const apiId = (await compose(oldImage, ['ps', '-q', 'api'])).stdout.trim();
      const originalApi = await inspect(apiId);
      await docker(['stop', original[0].Id]);
      assert.equal((await inspect(original[1].Id)).State.Running, true);

      await compose(newImage, ['up', '-d', '--no-deps', 'api']);
      const updatedApiId = (await compose(newImage, ['ps', '-q', 'api'])).stdout.trim();
      assert.notEqual(updatedApiId, apiId);
      assert.equal((await inspect(updatedApiId)).Image, expectedId);
      await deployWorkerRelease(release);
      const completed = await healthy(2);
      assert.ok(completed.every(state => state.Image === expectedId));
      assert.ok(completed.every(state => original.every(old => old.Id !== state.Id)));
      const readData = name => docker(['exec', completed[0].Id, 'node', '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', `/data/${name}`]);
      assert.equal((await readData('marker')).stdout, 'preserved');
      for (const old of [...original, originalApi]) {
        assert.equal((await readData(`${old.Config.Hostname}.stopped`)).stdout, 'SIGTERM');
      }

      await deployWorkerRelease(release);
      const repeated = await healthy(2);
      for (const state of repeated) {
        const previous = completed.find(item => item.Id === state.Id);
        assert.ok(previous, 'An unchanged release must preserve the container');
        assert.equal(state.State.StartedAt, previous.State.StartedAt);
      }
      await deployWorkerRelease({ ...release, count: 1 });
      await healthy(1);
      await assert.rejects(deployWorkerRelease({ ...release, compose: async () => {}, count: 2 }), /count does not match/);
      await assert.rejects(deployWorkerRelease({ ...release, count: 1, imageId: original[0].Image }), /image does not match/);
    } finally {
      await compose(newImage, ['down', '--volumes', '--remove-orphans']);
      await docker(['rm', '--force', seed], { allowedExitCodes: [0, 1] });
      await docker(['image', 'rm', oldImage, newImage], { allowedExitCodes: [0, 1] });
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true });
    }
  });
