import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('production bootstrap handles noisy RSA generation, renews identity and retries a lost response',
  { timeout: 135_000 }, async () => {
    if (process.env.HELM_RENEWAL_FIXTURE === '1') {
      await exerciseBootstrap();
      return;
    }
    const name = `helm-worker-renewal-${randomUUID()}`;
    const context = process.env.HELM_TEST_DOCKER_CONTEXT ?? 'desktop-linux';
    const image = process.env.WORKER_IMAGE ?? 'helmglass-browser-worker:dev-107';
    const docker = args => execute('docker', ['--context', context, ...args],
      { timeout: 120_000, maxBuffer: 65_536, windowsHide: true });
    try {
      const result = await docker(['run', '--rm', '--name', name, '--network', 'none',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--memory', '2g', '--pids-limit', '512', '--shm-size', '512m',
        '--tmpfs', '/tmp:size=128m', '--tmpfs', '/run:size=32m,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/runtime:size=128m,uid=10001,gid=10001,mode=0700,exec',
        '--mount', `type=bind,source=${fileURLToPath(import.meta.url)},target=/app/renewal-fixture.mjs,readonly`,
        '--env', 'HELM_RENEWAL_FIXTURE=1', '--entrypoint', 'node', image, '/app/renewal-fixture.mjs']);
      assert.match(result.stdout, /Worker identity renewal and response-loss recovery passed/);
    } finally {
      await docker(['rm', '--force', name]).catch(error => {
        if (!error.stderr?.includes(`No such container: ${name}`)) throw error;
      });
    }
  });

async function exerciseBootstrap() {
  const { WebSocketServer } = await import('ws');
  const directory = '/runtime/renewal-fixture';
  await mkdir(directory, { mode: 0o700 });
  const bin = `${directory}/bin`;
  await mkdir(bin, { mode: 0o700 });
  // Deterministically reproduce a long OpenSSL key-generation progress stream in the worker.
  // Fixture setup uses the real executable; quiet genpkey and CSR signing remain unchanged.
  await writeFile(`${bin}/openssl`, `#!/bin/sh
case " $* " in
  *" -newkey "*) head -c 8192 /dev/zero | tr '\\000' '+' >&2 ;;
esac
exec /usr/bin/openssl "$@"
`, { mode: 0o700 });
  const openssl = args => execute('openssl', args, { cwd: directory, maxBuffer: 16_384 });
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', 'root.key', '-out', 'root.pem', '-subj', '/CN=Fixture root',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'intermediate.key',
    '-out', 'intermediate.csr', '-subj', '/CN=Fixture intermediate']);
  await writeFile(`${directory}/intermediate.ext`,
    'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  await openssl(['x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.pem', '-CAkey', 'root.key',
    '-set_serial', '2', '-days', '1', '-extfile', 'intermediate.ext', '-out', 'intermediate.pem']);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key',
    '-out', 'server.csr', '-subj', '/CN=localhost']);
  await writeFile(`${directory}/server.ext`,
    'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  await openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'root.pem', '-CAkey', 'root.key',
    '-set_serial', '3', '-days', '1', '-extfile', 'server.ext', '-out', 'server.pem']);
  await writeFile(`${directory}/worker.ext`,
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n');
  const root = await readFile(`${directory}/root.pem`, 'utf8');
  const chain = `${await readFile(`${directory}/intermediate.pem`, 'utf8')}\n${root}`;
  await writeFile(`${directory}/bootstrap.json`, JSON.stringify({ schemaVersion: 1,
    installationId: 'renewal-fixture', enrollmentToken: randomUUID(), caPem: root }), { mode: 0o600 });

  let failure;
  let enrollment;
  let issued;
  let issuanceCount = 0;
  let enrollmentCount = 0;
  let registrations = 0;
  let firstRegistration;
  const renewalRequests = [];
  const server = createServer({ key: await readFile(`${directory}/server.key`),
    cert: await readFile(`${directory}/server.pem`), ca: root,
    requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' },
  (request, response) => {
    void (async () => {
      assert.equal(request.url, '/internal/worker/enroll');
      assert.equal(request.method, 'POST');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 65_536);
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      enrollmentCount++;
      if (enrollmentCount === 1) {
        assert.equal(request.socket.authorized, false);
        enrollment = value;
      } else {
        // Optional client authentication permits initial enrollment without a certificate;
        // every renewal must supply the intermediate needed by this root-only trust store.
        assert.equal(request.socket.authorized, true, 'Renewal did not present a trusted client chain');
        assert.deepEqual(value, enrollment, 'Retry changed boot identity, key or request');
        renewalRequests.push(value);
      }
      if (enrollmentCount <= 2) {
        await writeFile(`${directory}/worker.csr`, value.csrPem, { mode: 0o600 });
        await openssl(['x509', '-req', '-in', 'worker.csr', '-CA', 'intermediate.pem',
          '-CAkey', 'intermediate.key', '-set_serial', String(10 + enrollmentCount), '-days', '1',
          '-extfile', 'worker.ext', '-out', 'worker.pem']);
        const certificatePem = await readFile(`${directory}/worker.pem`, 'utf8');
        issuanceCount++;
        issued = { schemaVersion: 1, workerId: value.workerId, bootId: value.bootId,
          certificatePem, caPem: chain,
          // Exercise the normal renewal scheduler after about 35 seconds, without altering
          // production clocks/timers or waiting for the real 15-minute certificate lifetime.
          expiresAt: enrollmentCount === 1 ? new Date(Date.now() + 125_000).toISOString()
            : new Date(new X509Certificate(certificatePem).validTo).toISOString() };
      }
      if (enrollmentCount === 2) {
        // Signing committed, but delivery failed. The repeated identical CSR returns the
        // already-issued identity, as the real enrollment owner does for response loss.
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(issued));
    })().catch(error => { failure = error; response.writeHead(500).end(); });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    try {
      assert.equal(request.socket.authorized, true, 'Control channel client chain was not trusted');
      assert.ok(['/internal/worker/control', '/internal/worker/signaling'].includes(request.url));
      sockets.handleUpgrade(request, socket, head, connection => {
        connection.on('message', data => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type !== 'register') return;
            assert.equal(message.workerId, enrollment.workerId);
            assert.equal(message.bootId, enrollment.bootId);
            if (!firstRegistration) firstRegistration = { workerId: message.workerId, bootId: message.bootId };
            else assert.deepEqual({ workerId: message.workerId, bootId: message.bootId }, firstRegistration);
            registrations++;
            connection.send(JSON.stringify({ schemaVersion: 1, type: 'registered', requestId: message.requestId,
              workerId: message.workerId, bootId: message.bootId }));
          } catch (error) { failure = error; }
        });
      });
    } catch (error) { failure = error; socket.destroy(); }
  });
  server.listen(8444, '127.0.0.1');
  await once(server, 'listening');
  const worker = spawn(process.execPath, ['/app/dist/src/bootstrap.js'], { detached: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      BOOTSTRAP_FILE: `${directory}/bootstrap.json`, WORKER_CONTROL_URL: 'wss://localhost:8444/internal/worker/control',
      EGRESS_PROXY_URL: 'http://127.0.0.1:3128', WORKER_IMAGE_DIGEST: 'renewal-fixture' } });
  let diagnostic = '';
  worker.stdout.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
  worker.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
  try {
    const deadline = Date.now() + 100_000;
    while (enrollmentCount < 3 || registrations < 2) {
      if (failure) throw failure;
      assert.equal(worker.exitCode, null, `Bootstrap exited before renewing: ${diagnostic}`);
      assert.ok(Date.now() < deadline, `Renewal did not finish: enrollments=${enrollmentCount}, registrations=${registrations}`);
      await delay(200);
    }
    assert.equal(issuanceCount, 2, 'Response-loss retry issued another certificate');
    assert.equal(renewalRequests.length, 2);
    const saved = new X509Certificate(await readFile('/runtime/mtls/cert.pem'));
    assert.equal(saved.publicKey.asymmetricKeyDetails?.modulusLength, 3072);
    assert.equal(saved.fingerprint256, new X509Certificate(issued.certificatePem).fingerprint256);
    const health = await fetch('http://127.0.0.1:8081/health');
    assert.equal(health.status, 200);
    const state = await health.json();
    assert.equal(state.workerId, firstRegistration.workerId);
    assert.equal(state.bootId, firstRegistration.bootId);
    assert.equal(worker.exitCode, null);
    console.log('Worker identity renewal and response-loss recovery passed');
  } finally {
    // This is the fresh process group spawned above, inside this test's isolated container.
    try { process.kill(-worker.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (const connection of sockets.clients) connection.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
