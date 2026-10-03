import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const IMAGE = 'nginx:1.30.5-alpine3.24@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94';
const nginxDirectory = fileURLToPath(new URL('../', import.meta.url));

function docker(args) {
  const result = spawnSync('docker', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed (exit ${result.status}): ${result.stderr}`);
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
}

function request(port, certificate, path) {
  return new Promise((accept, reject) => {
    const operation = https.get({
      hostname: '127.0.0.1', port, path, servername: 'helm.integration.test',
      ca: certificate, headers: { host: 'helm.integration.test:8443' },
      timeout: 3000,
    }, (response) => {
      response.resume();
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers }));
    });
    operation.on('timeout', () => operation.destroy(new Error('TLS request timed out')));
    operation.on('error', reject);
  });
}

function untrustedHttpRequest(address) {
  return new Promise((accept, reject) => {
    const operation = http.get(`http://${address}/mcp`, {
      headers: { host: 'helm.integration.test', 'x-forwarded-for': '127.0.0.1' },
      timeout: 3000,
    }, (response) => {
      response.resume();
      response.on('end', () => accept(response.statusCode));
    });
    operation.on('timeout', () => operation.destroy(new Error('HTTP request timed out')));
    operation.on('error', reject);
  });
}

test('renders and starts real Nginx with TLS, preserving variables and private route boundaries', { timeout: 60_000 }, async () => {
  const testId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'helmglass-nginx-it-'));
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'certificate.pem');
  const bundlePath = join(directory, 'edge-tls.pem');
  const oauthConfigurationPath = join(directory, 'oauth.conf');
  const openssl = process.env.OPENSSL_BIN ?? (process.platform === 'win32'
    ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
  const generated = spawnSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certificatePath, '-subj', '/CN=helm.integration.test',
    '-addext', 'subjectAltName=DNS:helm.integration.test', '-days', '1',
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(generated.status, 0, 'A temporary TLS fixture must be generated');
  const certificate = await readFile(certificatePath);
  await writeFile(bundlePath, Buffer.concat([certificate, await readFile(keyPath)]), { mode: 0o600 });
  // Anonymous users can load the shell; protected requests still need forward-auth.
  await writeFile(oauthConfigurationPath, `
pid /tmp/oauth.pid;
error_log /dev/stderr crit;
events { worker_connections 32; }
http {
  access_log off;
  client_body_temp_path /tmp/body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server { listen 4180; location / { return 401; } }
}
`);
  let containerId;
  let edgeContainerId;
  let oauthId;
  let network;
  try {
    network = docker(['network', 'create', '--label', `helmglass.acceptance=${testId}`,
      `helmglass-nginx-it-${testId}`]);
    oauthId = docker(['run', '--detach', '--network', network, '--network-alias', 'oauth2-proxy',
      '--label', `helmglass.acceptance=${testId}`, '--user', '101:101', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '16',
      '--tmpfs', '/tmp:size=16m', '--mount', `type=bind,source=${oauthConfigurationPath},target=/etc/oauth.conf,readonly`,
      '--entrypoint', 'nginx', IMAGE, '-c', '/etc/oauth.conf', '-g', 'daemon off;']);
    containerId = docker([
      'run', '--detach', '--name', `helmglass-nginx-it-${testId}`,
      '--network', network,
      '--label', `helmglass.acceptance=${testId}`, '--user', '101:101', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '32',
      '--tmpfs', '/tmp:size=16m', '--tmpfs', '/run:size=16m,uid=101,gid=101,mode=0700',
      '--publish', '127.0.0.1::8443',
      '--publish', '127.0.0.1::8080',
      '--env', 'PUBLIC_ORIGIN=https://helm.integration.test:8443',
      '--mount', `type=bind,source=${resolve(nginxDirectory, 'nginx.conf')},target=/etc/helm/nginx.conf.template,readonly`,
      '--mount', `type=bind,source=${resolve(nginxDirectory, 'entrypoint.sh')},target=/opt/helm/bin/start-nginx,readonly`,
      '--mount', `type=bind,source=${bundlePath},target=/run/secrets/edge_tls_identity,readonly`,
      '--entrypoint', '/bin/sh', IMAGE, '/opt/helm/bin/start-nginx',
    ]);
    let address;
    try {
      address = docker(['port', containerId, '8443/tcp']);
    } catch (error) {
      assert.fail(`Nginx port unavailable: ${error.message}; ${docker(['logs', containerId])}`);
    }
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const port = Number(address.split(':')[1]);
    const deadline = Date.now() + 15_000;
    let health;
    while (Date.now() < deadline) {
      try {
        health = await request(port, certificate, '/internal/worker/control');
        break;
      } catch { await delay(250); }
    }
    if (!health) {
      const status = docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', containerId]);
      const logs = docker(['logs', containerId]);
      assert.fail(`Nginx startup failed: ${status}; ${logs}`);
    }
    assert.equal(health.status, 404);
    for (const path of ['/ops/health', '/actuator/health', '/metrics', '/oauth2/auth', '/oauth2/sign_out', '/_oauth2_auth']) {
      assert.equal((await request(port, certificate, path)).status, 404, path);
    }
    const missingUpstream = await request(port, certificate, '/mcp');
    assert.equal(missingUpstream.status, 503);
    assert.match(missingUpstream.headers['content-type'], /application\/problem\+json/);
    assert.equal(missingUpstream.headers.location, undefined);
    assert.equal(missingUpstream.headers['x-content-type-options'], 'nosniff');
    edgeContainerId = docker([
      'run', '--detach', '--network', network,
      '--label', `helmglass.acceptance=${testId}`, '--user', '101:101', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '32',
      '--tmpfs', '/tmp:size=16m', '--tmpfs', '/run:size=16m,uid=101,gid=101,mode=0700',
      '--publish', '127.0.0.1::8080',
      '--env', 'PUBLIC_ORIGIN=https://helm.integration.test:8443',
      '--env', 'TRUSTED_EDGE_PROXY=127.0.0.1',
      '--mount', `type=bind,source=${resolve(nginxDirectory, 'nginx.conf')},target=/etc/helm/nginx.conf.template,readonly`,
      '--mount', `type=bind,source=${resolve(nginxDirectory, 'entrypoint.sh')},target=/opt/helm/bin/start-nginx,readonly`,
      '--entrypoint', '/bin/sh', IMAGE, '/opt/helm/bin/start-nginx',
    ]);
    const httpAddress = docker(['port', edgeContainerId, '8080/tcp']);
    const edgeDeadline = Date.now() + 15_000;
    while (Date.now() < edgeDeadline) {
      try { await untrustedHttpRequest(httpAddress); break; } catch { await delay(100); }
    }
    assert.equal(await untrustedHttpRequest(httpAddress), 403,
      'Spoofed forwarding headers cannot authorize the HTTP peer');
    const trusted = spawnSync('docker', ['--context', 'desktop-linux', 'exec', edgeContainerId, 'wget', '-S', '-O', '-',
      '--header=Host: helm.integration.test', '--header=X-Forwarded-For: 203.0.113.8',
      'http://127.0.0.1:8080/mcp'], { encoding: 'utf8', timeout: 5000 });
    assert.match(trusted.stderr, /HTTP\/1\.1 503/,
      'The trusted gateway uses the existing authenticated application route');
    const trustedWeb = spawnSync('docker', ['--context', 'desktop-linux', 'exec', edgeContainerId, 'wget', '-S', '-O', '-',
      '--header=Host: helm.integration.test', '--header=X-Forwarded-For: 203.0.113.8',
      'http://127.0.0.1:8080/'], { encoding: 'utf8', timeout: 5000 });
    assert.match(trustedWeb.stderr, /HTTP\/1\.1 200/);
    for (const path of ['/', '/sign-in', '/tasks/owned-task?view=result', '/index.html']) {
      const shell = await request(port, certificate, path);
      assert.equal(shell.status, 200, path + ' loads the public shell without losing navigation');
      assert.equal(shell.headers.location, undefined);
    }
    const anonymousApi = await request(port, certificate, '/api/v1/me');
    assert.equal(anonymousApi.status, 401);
    assert.match(anonymousApi.headers['content-type'], /application\/problem\+json/);
    assert.equal(anonymousApi.headers.location, undefined);
    const configuration = docker(['exec', containerId, 'cat', '/run/nginx.conf']);
    assert.ok(configuration.includes('proxy_set_header Authorization $upstream_authorization;'));
    assert.ok(configuration.includes('proxy_set_header X-Forwarded-Port 8443;'));
    assert.ok(configuration.includes('wss://helm.integration.test:8443'));
    assert.ok(!configuration.includes('set_real_ip_from 192.0.2.10'));
    const edgeConfiguration = docker(['exec', edgeContainerId, 'cat', '/run/nginx.conf']);
    assert.ok(!edgeConfiguration.includes('ssl_certificate'), 'Global edge mode needs no copied public key');
    assert.ok(!edgeConfiguration.includes('listen 8443'), 'Global edge mode has no duplicate HTTPS listener');
  } finally {
    for (const id of [edgeContainerId, containerId, oauthId].filter(Boolean)) {
      assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "helmglass.acceptance"}}', id]), testId);
      docker(['rm', '--force', id]);
    }
    if (network) {
      assert.equal(docker(['network', 'inspect', '--format', '{{index .Labels "helmglass.acceptance"}}', network]), testId);
      docker(['network', 'rm', network]);
    }
    for (const path of [keyPath, certificatePath, bundlePath, oauthConfigurationPath]) await unlink(path);
    await rmdir(directory);
  }
});
