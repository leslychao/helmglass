import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from '../../process.mjs';

test('private TURN allocations exchange data through two Nginx proxies without published relay ports',
  { timeout: 180_000 }, async t => {
    const fixture = randomUUID();
    const context = process.env.HELM_TEST_DOCKER_CONTEXT ?? 'desktop-linux';
    const turnImage = process.env.TURN_IMAGE ?? 'helmglass-coturn:dev-107';
    const nginxImage = process.env.NGINX_IMAGE ?? 'helmglass-nginx:dev-107';
    const provisionImage = process.env.PROVISION_IMAGE ?? 'helmglass-provision:dev-107';
    const docker = (args, options) => run('docker', ['--context', context, ...args], options);
    const label = `helmglass.acceptance=${fixture}`;
    const networks = [];
    const containers = [];
    const cache = resolve('.cache');
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(resolve(cache, 'turn-transport-'));
    const mount = ['--mount', `type=bind,src=${directory},dst=/fixture,readonly`];
    const sharedSecret = randomBytes(32).toString('base64url');
    const name = purpose => `helm-turn-${purpose}-${fixture}`;
    const network = Object.fromEntries(['front', 'edge', 'relay'].map(purpose => [purpose, name(purpose)]));
    const environment = ['--env', 'TURN_REALM=helm.integration.test',
      '--env', 'TURN_RELAY_MIN=49160', '--env', 'TURN_RELAY_MAX=49259'];
    const limited = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
    const state = async container => JSON.parse((await docker(['inspect', container])).stdout)[0];

    async function start(purpose, image, networkName, args = [], command = []) {
      const container = name(purpose);
      containers.push(container);
      await docker(['run', '-d', '--name', container, '--label', label, '--network', networkName,
        '--network-alias', purpose, ...args, image, ...command]);
      return container;
    }

    async function ready(container, command) {
      for (let attempt = 0; attempt < 30; attempt++) {
        assert.equal((await state(container)).State.Running, true, 'Fixture service stopped');
        const result = await docker(['exec', container, ...command], { allowedExitCodes: [0, 1] });
        if (result.code === 0) return;
        await delay(100);
      }
      assert.fail('Fixture service did not become ready');
    }

    async function client(purpose, flags, allowedExitCodes = [0], identity = 'identity.json') {
      const container = name(purpose);
      containers.push(container);
      const result = await docker(['run', '--rm', '--name', container, '--label', label,
        '--network', network.front, ...limited, ...mount, '--entrypoint', 'sh', turnImage,
        '-c', 'secret=$(jq -er .turnSharedSecret "/fixture/$1"); shift; '
          + 'exec timeout 15 turnutils_uclient -W "$secret" "$@"', 'turn-client',
        identity, '-c', '-n', '5', '-z', '100', '-K', '0', ...flags, 'gateway'], { allowedExitCodes, timeout: 25_000 });
      return result.stdout + result.stderr;
    }

    try {
      await writeFile(resolve(directory, 'identity.json'), JSON.stringify({ schemaVersion: 2, turnSharedSecret: sharedSecret }));
      await writeFile(resolve(directory, 'wrong-secret.json'), JSON.stringify({ schemaVersion: 2,
        turnSharedSecret: randomBytes(32).toString('base64url') }));
      await writeFile(resolve(directory, 'legacy.json'), JSON.stringify({ schemaVersion: 1,
        turnSharedSecret: sharedSecret, tls: { privateKeyPem: 'rejected-legacy-key' } }));
      for (const networkName of Object.values(network)) {
        await docker(['network', 'create', '--internal', '--label', label, networkName]);
        networks.push(networkName);
      }
      await docker(['run', '--rm', '--network', 'none', '--user', '0:0',
        '--mount', `type=bind,src=${directory},dst=/fixture`, '--entrypoint', 'openssl', provisionImage,
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=gateway', '-addext', 'subjectAltName=DNS:gateway',
        '-keyout', '/fixture/tls.key', '-out', '/fixture/tls.crt']);

      const turn = await start('coturn', turnImage, network.relay, [...limited, ...environment,
        '--mount', `type=bind,src=${resolve(directory, 'identity.json')},dst=/run/secrets/turn_identity,readonly`,
        '--tmpfs', '/run:size=32m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp:size=16m']);
      await ready(turn, ['/opt/helm/bin/healthcheck']);
      const turnState = await state(turn);
      assert.deepEqual(Object.keys(turnState.NetworkSettings.Networks), [network.relay]);
      assert.equal(Object.keys(turnState.HostConfig.PortBindings ?? {}).length, 0);
      assert.deepEqual((await docker(['exec', turn, 'sh', '-c',
        'find /run/helm -type f -name "*.pem"'])).stdout.trim(), '');

      const edgeSubnet = JSON.parse((await docker(['network', 'inspect', network.edge])).stdout)[0].IPAM.Config[0].Subnet;
      await writeFile(resolve(directory, 'internal.conf'), `
events {}
stream {
    server {
        listen 3478 udp reuseport;
        allow ${edgeSubnet};
        deny all;
        proxy_pass coturn:3478;
        proxy_timeout 10m;
    }
    server {
        listen 5349;
        allow ${edgeSubnet};
        deny all;
        proxy_pass coturn:5555;
        proxy_timeout 10m;
    }
}
`);
      const internal = await start('internal', nginxImage, network.relay,
        ['--user', '0:0', ...mount, '--entrypoint', 'nginx'], ['-c', '/fixture/internal.conf', '-g', 'daemon off;']);
      await docker(['network', 'connect', '--alias', 'internal', network.edge, internal]);
      await ready(internal, ['nginx', '-t', '-c', '/fixture/internal.conf']);

      await writeFile(resolve(directory, 'global.conf'), `
events {}
stream {
    server {
        listen 3478 udp reuseport;
        proxy_pass internal:3478;
        proxy_timeout 10m;
    }
    server {
        listen 3478;
        proxy_protocol on;
        proxy_pass internal:5349;
        proxy_timeout 10m;
    }
    server {
        listen 5349 ssl;
        ssl_certificate /fixture/tls.crt;
        ssl_certificate_key /fixture/tls.key;
        ssl_protocols TLSv1.2 TLSv1.3;
        proxy_protocol on;
        proxy_pass internal:5349;
        proxy_timeout 10m;
    }
}
`);
      const gateway = await start('gateway', nginxImage, network.edge,
        ['--user', '0:0', ...mount, '--entrypoint', 'nginx'], ['-c', '/fixture/global.conf', '-g', 'daemon off;']);
      await docker(['network', 'connect', '--alias', 'gateway', network.front, gateway]);
      await ready(gateway, ['nginx', '-t', '-c', '/fixture/global.conf']);

      for (const [transport, flags] of [
        ['udp', ['-y', '-p', '3478']],
        ['tcp-proxy', ['-y', '-t', '-p', '3478']],
        ['tls-proxy', ['-y', '-t', '-S', '-p', '5349', '-E', '/fixture/tls.crt']],
      ]) {
        await t.test(`${transport} exchanges real channel data between private allocations`, async () => {
          const output = await client(transport, flags);
          assert.match(output, /tot_recv_msgs=10\b/);
          assert.match(output, /Total lost packets 0\b/);
        });
      }

      await t.test('another private peer address is rejected', async () => {
        const output = await client('denied-peer', ['-t', '-p', '3478', '-e', '10.0.0.1', '-r', '49160'], [255]);
        assert.match(output, /channel bind: error 403\b/);
      });

      await t.test('wrong TURN credentials cannot allocate a relay', async () => {
        const output = await client('bad-auth', ['-t', '-p', '3478', '-y'], [255], 'wrong-secret.json');
        assert.match(output, /Cannot complete Allocation/);
        assert.doesNotMatch(output, /tot_recv_msgs=[1-9]/);
      });

      await t.test('legacy identities containing a private key cannot start coturn', async () => {
        const legacy = await start('legacy', turnImage, network.relay, [...limited, ...environment,
          '--mount', `type=bind,src=${resolve(directory, 'legacy.json')},dst=/run/secrets/turn_identity,readonly`,
          '--tmpfs', '/run:size=32m,uid=10001,gid=10001,mode=0700']);
        const result = await docker(['wait', legacy]);
        assert.notEqual(Number(result.stdout.trim()), 0);
      });
    } finally {
      for (const container of containers.reverse()) {
        await docker(['rm', '--force', container], { allowedExitCodes: [0, 1] });
      }
      for (const networkName of networks.reverse()) {
        const description = JSON.parse((await docker(['network', 'inspect', networkName])).stdout)[0];
        assert.equal(description.Labels['helmglass.acceptance'], fixture);
        await docker(['network', 'rm', networkName]);
      }
      assert.ok(directory.startsWith(cache + sep));
      await rm(directory, { recursive: true, force: true });
    }
  });
