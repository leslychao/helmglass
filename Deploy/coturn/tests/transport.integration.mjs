import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const egressImage = process.env.EGRESS_IMAGE ?? 'helmglass-egress-proxy:dev-107';
    const docker = (args, options) => run('docker', ['--context', context, ...args], options);
    const label = `helmglass.acceptance=${fixture}`;
    const networks = [];
    const containers = [];
    const cache = resolve('.cache');
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(resolve(cache, 'turn-transport-'));
    const sharedSecret = randomBytes(32).toString('base64url');
    const name = purpose => `helm-turn-${purpose}-${fixture}`;
    const network = Object.fromEntries(['front', 'edge', 'relay', 'worker'].map(purpose => [purpose, name(purpose)]));
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

    async function client(purpose, flags, allowedExitCodes = [0], identity = 'identity.json', endpoint = { network: network.front, host: 'gateway' }) {
      const container = name(purpose);
      containers.push(container);
      const result = await docker(['run', '--rm', '--name', container, '--label', label,
        '--network', endpoint.network, ...limited,
        '--mount', `type=bind,src=${resolve(directory, identity)},dst=/fixture/${identity},readonly`,
        '--mount', `type=bind,src=${resolve(directory, 'tls.crt')},dst=/fixture/tls.crt,readonly`,
        '--entrypoint', 'sh', turnImage,
        '-c', 'secret=$(jq -er .turnSharedSecret "/fixture/$1"); shift; '
          + 'exec timeout 15 turnutils_uclient -W "$secret" "$@"', 'turn-client',
        identity, '-c', '-n', '5', '-z', '100', '-K', '0', ...flags, endpoint.host], { allowedExitCodes, timeout: 25_000 });
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

      await writeFile(resolve(directory, 'egress.json'), JSON.stringify({ schemaVersion: 1,
        mediaProxyUsername: 'helm-media', mediaProxyPassword: randomBytes(32).toString('base64url') }));
      const egress = await start('egress-proxy', egressImage, network.relay, [...limited,
        '--mount', `type=bind,src=${resolve(directory, 'egress.json')},dst=/run/secrets/egress_identity,readonly`,
        '--tmpfs', '/run:size=32m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp:size=32m']);
      await docker(['network', 'connect', '--alias', 'egress-proxy', network.worker, egress]);
      await ready(egress, ['/opt/helm/bin/healthcheck']);
      // turnutils has no HTTP-proxy option. This test-only bridge performs the same
      // authenticated CONNECT as libnice, then pipes the real TURN exchange with backpressure.
      await writeFile(resolve(directory, 'connect.mjs'), `
import { createServer, connect } from 'node:net';
import { readFile } from 'node:fs/promises';
const identity = JSON.parse(await readFile('/fixture/egress.json', 'utf8'));
const authorization = Buffer.from(identity.mediaProxyUsername + ':' + identity.mediaProxyPassword).toString('base64');
const server = createServer(client => {
  client.pause();
  const proxy = connect(3128, 'egress-proxy');
  const close = () => { client.destroy(); proxy.destroy(); };
  client.setTimeout(20000, close); proxy.setTimeout(20000, close);
  client.on('error', close); proxy.on('error', close);
  client.on('close', () => proxy.destroy()); proxy.on('close', () => client.destroy());
  proxy.once('connect', () => proxy.write('CONNECT coturn:3478 HTTP/1.1\\r\\nHost: coturn:3478\\r\\nProxy-Authorization: Basic ' + authorization + '\\r\\n\\r\\n'));
  let header = Buffer.alloc(0);
  const handshake = chunk => {
    header = Buffer.concat([header, chunk]);
    if (header.length > 8192) { close(); return; }
    const end = header.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    if (header.toString('ascii', 0, end).split(' ')[1] !== '200') { close(); return; }
    proxy.off('data', handshake);
    if (header.length > end + 4) client.write(header.subarray(end + 4));
    proxy.pipe(client); client.pipe(proxy); client.resume();
  };
  proxy.on('data', handshake);
});
server.maxConnections = 8;
server.listen(13478, '0.0.0.0');
`);
      const bridge = await start('worker-turn', provisionImage, network.worker, [...limited,
        '--mount', `type=bind,src=${resolve(directory, 'egress.json')},dst=/fixture/egress.json,readonly`,
        '--mount', `type=bind,src=${resolve(directory, 'connect.mjs')},dst=/fixture/connect.mjs,readonly`,
        '--entrypoint', 'node'], ['/fixture/connect.mjs']);
      await ready(bridge, ['node', '-e', "const s=require('net').connect(13478,'127.0.0.1');s.once('connect',()=>s.destroy());s.once('error',()=>process.exit(1));"]);
      await t.test('worker TURN/TCP traverses the authenticated Squid CONNECT route', async () => {
        const output = await client('worker-connect', ['-y', '-t', '-p', '13478'], [0],
          'identity.json', { network: network.worker, host: 'worker-turn' });
        assert.match(output, /tot_recv_msgs=10\b/);
        assert.match(output, /Total lost packets 0\b/);
      });

      await writeFile(resolve(directory, 'global.conf'), `
events {}
stream {
    resolver 127.0.0.11 valid=1s ipv6=off;
    upstream internal_udp { zone internal_udp 32k; server internal:3478 resolve; }
    upstream internal_tcp { zone internal_tcp 32k; server internal:5349 resolve; }
    server {
        listen 3478 udp reuseport;
        proxy_pass internal_udp;
        proxy_timeout 10m;
    }
    server {
        listen 3478;
        proxy_protocol on;
        proxy_pass internal_tcp;
        proxy_timeout 10m;
    }
    server {
        listen 5349 ssl;
        ssl_certificate /fixture/tls.crt;
        ssl_certificate_key /fixture/tls.key;
        ssl_protocols TLSv1.2 TLSv1.3;
        proxy_protocol on;
        proxy_pass internal_tcp;
        proxy_timeout 10m;
    }
}
`);
      const gateway = await start('gateway', nginxImage, network.edge,
        ['--user', '0:0',
          ...['global.conf', 'tls.crt', 'tls.key'].flatMap(file => [
            '--mount', `type=bind,src=${resolve(directory, file)},dst=/fixture/${file},readonly`]),
          '--entrypoint', 'nginx'], ['-c', '/fixture/global.conf', '-g', 'daemon off;']);
      await docker(['network', 'connect', '--alias', 'gateway', network.front, gateway]);
      await ready(gateway, ['nginx', '-t', '-c', '/fixture/global.conf']);
      const gatewayAddress = (await state(gateway)).NetworkSettings.Networks[network.edge].IPAddress;
      await writeFile(resolve(directory, 'production.conf'), await readFile(new URL('../../nginx/nginx.conf', import.meta.url)));
      await writeFile(resolve(directory, 'production-entrypoint.sh'), await readFile(new URL('../../nginx/entrypoint.sh', import.meta.url)));
      const internal = await start('internal', nginxImage, network.relay, [
        ...limited, '--user', '101:101',
        '--mount', `type=bind,src=${resolve(directory, 'production-entrypoint.sh')},dst=/fixture/production-entrypoint.sh,readonly`,
        '--mount', `type=bind,src=${resolve(directory, 'production.conf')},dst=/etc/helm/nginx.conf.template,readonly`,
        '--tmpfs', '/run:size=32m,uid=101,gid=101,mode=0700', '--tmpfs', '/tmp:size=64m',
        '--env', 'PUBLIC_ORIGIN=https://helm.integration.test', '--env', `TRUSTED_EDGE_PROXY=${gatewayAddress}`,
        '--entrypoint', 'sh'], ['/fixture/production-entrypoint.sh']);
      await docker(['network', 'connect', '--alias', 'internal', network.edge, internal]);
      await ready(internal, ['nginx', '-t', '-c', '/run/nginx.conf']);
      await docker(['exec', internal, 'test', '!', '-e', '/run/secrets/edge_tls_identity']);
      await docker(['exec', internal, 'test', '!', '-e', '/fixture/tls.key']);
      // The internal endpoint was created after the global listener; resolve its new Docker alias now.
      await docker(['exec', gateway, 'nginx', '-s', 'reload', '-c', '/fixture/global.conf']);

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

      await t.test('an untrusted container cannot inject a PROXY header into the internal listener', async () => {
        const container = name('untrusted');
        containers.push(container);
        await docker(['run', '--rm', '-i', '--name', container, '--label', label,
          '--network', network.edge, ...limited, '--entrypoint', 'node', provisionImage,
          '--input-type=module'], { input: `
import { connect } from 'node:net';
await new Promise((resolve, reject) => {
  const socket = connect(5349, 'internal');
  socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Untrusted connection was not closed')); });
  socket.once('connect', () => {
    const binding = Buffer.alloc(20);
    binding.writeUInt16BE(1, 0);
    binding.writeUInt32BE(0x2112a442, 4);
    socket.write(Buffer.concat([Buffer.from('PROXY TCP4 203.0.113.20 203.0.113.30 50000 5349\\r\\n'), binding]));
  });
  socket.on('data', () => { socket.destroy(); reject(new Error('Untrusted client reached coturn')); });
  socket.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  socket.once('close', () => resolve());
});
`, timeout: 10_000 });
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
