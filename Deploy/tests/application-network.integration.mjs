import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../process.mjs';

test('application dynamic endpoints cannot claim the fixed Nginx address before Nginx starts',
  { timeout: 60_000 }, async () => {
    const fixture = randomUUID();
    const network = `helm-application-ipam-${fixture}`;
    const containers = [];
    const context = process.env.HELM_TEST_DOCKER_CONTEXT ?? 'desktop-linux';
    const image = process.env.PROVISION_IMAGE ?? 'helmglass-provision:dev-107';
    const docker = args => run('docker', ['--context', context, ...args]);
    const compose = JSON.parse((await docker(['compose', '--file',
      fileURLToPath(new URL('../compose.yaml', import.meta.url)),
      'config', '--no-interpolate', '--format', 'json'])).stdout);
    const application = compose.networks.application;
    const pool = application.ipam.config[0];
    const nginxAddress = compose.services.nginx.networks.application.ipv4_address;
    assert.equal(application.internal, true);
    assert.deepEqual(pool, { subnet: '172.28.40.0/24', ip_range: '172.28.40.128/25' });
    assert.equal(nginxAddress, '172.28.40.2');
    for (const service of ['keycloak', 'oauth2-proxy']) {
      assert.equal(compose.services[service].environment.NGINX_INTERNAL_ADDRESS, nginxAddress);
    }
    await docker(['network', 'create', '--internal', '--subnet', pool.subnet,
      '--ip-range', pool.ip_range, '--label', `helmglass.acceptance=${fixture}`, network]);
    try {
      const addresses = [];
      for (const service of ['keycloak', 'api', 'nginx']) {
        const name = `helm-ipam-${service}-${fixture}`;
        const options = ['run', '-d', '--name', name, '--network', network, '--read-only',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none'];
        if (service === 'nginx') options.push('--ip', nginxAddress);
        containers.push(name);
        await docker([...options, '--entrypoint', 'node', image,
          '-e', 'setTimeout(() => {}, 60000)']);
        const state = JSON.parse((await docker(['inspect', name])).stdout)[0];
        const address = state.NetworkSettings.Networks[network].IPAddress;
        if (service === 'nginx') {
          assert.equal(address, nginxAddress);
        } else {
          const octets = address.split('.').map(Number);
          assert.deepEqual(octets.slice(0, 3), [172, 28, 40]);
          assert.ok(octets[3] >= 128 && octets[3] < 255);
          assert.notEqual(address, nginxAddress);
        }
        addresses.push(address);
      }
      assert.equal(new Set(addresses).size, 3);
    } finally {
      for (const container of containers) await docker(['rm', '--force', container]);
      const state = JSON.parse((await docker(['network', 'inspect', network])).stdout)[0];
      assert.equal(state.Labels['helmglass.acceptance'], fixture);
      await docker(['network', 'rm', network]);
    }
  });
