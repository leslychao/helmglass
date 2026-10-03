import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { run } from '../process.mjs';

test('protected delivery supports fresh PostgreSQL and guarded empty-cluster bootstrap recovery',
  { timeout: 180_000 }, async () => {
    const fixture = randomUUID();
    const context = process.env.HELM_TEST_DOCKER_CONTEXT ?? 'desktop-linux';
    const postgresImage = process.env.POSTGRES_IMAGE ?? 'helmglass-postgres:dev-107';
    const provisionImage = process.env.PROVISION_IMAGE ?? 'helmglass-provision:dev-107';
    const docker = (args, options) => run('docker', ['--context', context, ...args], options);
    const secrets = `helm-pg-bootstrap-secrets-${fixture}`;
    const volumes = [secrets];
    const containers = new Set();
    const identity = Buffer.from(JSON.stringify({ schemaVersion: 1,
      ...Object.fromEntries(['rootPassword', 'migrationPassword', 'apiPassword', 'keycloakPassword']
        .map(name => [name, randomBytes(32).toString('base64url')])) }));
    const manifest = { schemaVersion: 1, installationId: `pg-${fixture}`, mode: 'stage',
      files: [{ name: 'postgres-bootstrap', content: identity.toString('base64'),
        sha256: createHash('sha256').update(identity).digest('hex') }] };
    const helper = ['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
      '--security-opt', 'no-new-privileges:true', '--log-driver', 'none',
      '--volume', `${secrets}:/bootstrap`, '--entrypoint', 'node', provisionImage];
    const deliver = (mode, allowedExitCodes = [0]) => docker([
      ...helper, '/opt/helm/provision/src/host-files.mjs'],
    { input: JSON.stringify({ ...manifest, mode }), allowedExitCodes });
    const sql = async (container, statement) => (await docker(['exec', '--user', 'postgres',
      container, 'psql', '-X', '-q', '-t', '-A', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', statement])).stdout.trim();
    const wait = async (container, check) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await docker(['exec', container, ...check], { allowedExitCodes: [0, 1, 2] })).code === 0) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      assert.fail('PostgreSQL readiness deadline exceeded');
    };
    const remove = async container => {
      await docker(['rm', '--force', container]);
      containers.delete(container);
    };
    try {
      await docker(['volume', 'create', '--label', `helmglass.acceptance=${fixture}`, secrets]);
      await deliver('stage');
      // Reproduce the old root-owned 0400 delivery without changing its credential bytes.
      await docker([...helper, '--input-type=module', '-e',
        'import{chown}from"node:fs/promises";await chown("/bootstrap/postgres-bootstrap",0,0);']);
      assert.equal((await deliver('verify', [0, 1])).code, 1);
      await deliver('stage');
      await deliver('verify');
      const secretPath = JSON.parse((await docker(['volume', 'inspect', secrets])).stdout)[0].Mountpoint
        + '/postgres-bootstrap';

      for (const interrupted of [false, true]) {
        const name = `helm-pg-bootstrap-${interrupted ? 'partial' : 'fresh'}-${fixture}`;
        const volume = `${name}-data`;
        volumes.push(volume);
        await docker(['volume', 'create', '--label', `helmglass.acceptance=${fixture}`, volume]);
        const args = ['run', '-d', '--name', name, '--network', 'none', '--log-driver', 'none',
          '--mount', `type=bind,source=${secretPath},target=/run/secrets/postgres_identity,readonly`,
          '--volume', `${volume}:/var/lib/postgresql`];
        if (interrupted) args.push('--tmpfs', '/docker-entrypoint-initdb.d:size=1m');
        containers.add(name);
        await docker([...args, postgresImage]);
        await wait(name, ['pg_isready', '-h', '127.0.0.1']);
        if (interrupted) {
          assert.equal((await docker(['exec', name, '/opt/helm/bin/healthcheck'],
            { allowedExitCodes: [0, 1, 2] })).code, 2);
          assert.equal(await sql(name, "SELECT count(*) FROM pg_roles WHERE rolname = 'helm_api'"), '0');
          await remove(name);
          // The official entrypoint sees PG_VERSION and skips initialization on restart.
          containers.add(name);
          await docker([...args.slice(0, -2), postgresImage]);
          await wait(name, ['pg_isready', '-h', '127.0.0.1']);
          await docker(['exec', '--user', 'postgres', name,
            '/docker-entrypoint-initdb.d/10-helm-databases.sh']);
        }
        await wait(name, ['/opt/helm/bin/healthcheck']);
        assert.equal(await sql(name, 'SHOW archive_mode'), 'off');
        assert.equal(await sql(name, 'SHOW archive_command'), '(disabled)');
        assert.equal(await sql(name,
          "SELECT count(*) FROM pg_roles WHERE rolname IN ('helm_api','helm_migration','keycloak')"), '3');
        await sql(name, 'CREATE TABLE bootstrap_preserved (id integer PRIMARY KEY); INSERT INTO bootstrap_preserved VALUES (42)');
        const refused = await docker(['exec', '--user', 'postgres', name,
          '/docker-entrypoint-initdb.d/10-helm-databases.sh'], { allowedExitCodes: [0, 1, 3] });
        assert.equal(refused.code, 3);
        assert.match(refused.stderr, /requires an empty application cluster/);
        assert.equal(await sql(name, 'SELECT id FROM bootstrap_preserved'), '42');
        await docker(['restart', name]);
        await wait(name, ['/opt/helm/bin/healthcheck']);
        assert.equal(await sql(name, 'SELECT id FROM bootstrap_preserved'), '42');
        await remove(name);
      }
    } finally {
      for (const container of containers) await docker(['rm', '--force', container]);
      for (const volume of volumes.reverse()) {
        const metadata = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0];
        assert.equal(metadata.Labels['helmglass.acceptance'], fixture);
        await docker(['volume', 'rm', volume]);
      }
    }
  });
