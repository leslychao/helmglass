import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { VaultCli } from '../provision/src/vault-cli.mjs';
import { provisionVaultServices, VAULT_SERVICES, VAULT_ROLES } from '../provision/src/vault-services.mjs';
import { protectDirectory } from '../protected-files.mjs';

function docker(args, { input, token, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    input, env: { ...process.env, ...(token ? { VAULT_TOKEN: token } : {}) },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4_194_304,
  });
  // CLI diagnostics may contain private request material; report only the command category.
  if (!allowFailure && result.status !== 0) throw new Error(`Docker ${args[0]} failed (${result.status})`);
  return allowFailure ? result : result.stdout.trim();
}

function request(port, ca, method, path, body) {
  return new Promise((accept, reject) => {
    const operation = https.request({ hostname: '127.0.0.1', port, servername: 'vault', ca,
      path: `/v1/${path}`, method, timeout: path === 'sys/init' ? 30_000 : 10_000,
      headers: body ? { 'content-type': 'application/json' } : {},
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 1_048_576) return operation.destroy(new Error('Fixture response exceeds limit'));
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { accept({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { reject(new Error('Invalid fixture response')); }
      });
      response.on('error', reject);
    });
    operation.on('timeout', () => operation.destroy(new Error(`Fixture ${path} request timed out`)));
    operation.on('error', reject);
    operation.end(body ? JSON.stringify(body) : undefined);
  });
}

test('real Raft Vault preserves scoped TLS, Transit keys and Shamir restart',
  { timeout: 240_000 }, async () => {
    const fixtureId = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), 'helm-vault-it-'));
    const keyPath = join(directory, 'key.pem');
    const certificatePath = join(directory, 'certificate.pem');
    const identityPath = join(directory, 'identity.json');
    const csrPath = join(directory, 'worker.csr');
    const workerCertificatePath = join(directory, 'worker.crt');
    const extensionsPath = join(directory, 'worker-ext.cnf');
    const volume = `helm-vault-it-${fixtureId}`;
    let container;
    let volumeCreated = false;
    const network = `helm-vault-it-${fixtureId}`;
    let networkCreated = false;
    try {
      await protectDirectory(directory, resolve('.'));
      const openssl = process.env.OPENSSL_BIN ?? (process.platform === 'win32'
        ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
      const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:3072', '-nodes',
        '-keyout', keyPath, '-out', certificatePath, '-subj', '/CN=vault',
        '-addext', 'subjectAltName=DNS:vault', '-days', '1'],
      { encoding: 'utf8', timeout: 15_000 });
      assert.equal(generated.status, 0, 'Temporary fixture certificate generation');
      const ca = await readFile(certificatePath, 'utf8');
      await writeFile(identityPath, JSON.stringify({ schemaVersion: 1, tls: {
        certificatePem: ca, privateKeyPem: await readFile(keyPath, 'utf8'), caPem: ca,
      } }), { mode: 0o600 });
      // The host verifies the actual TLS ingress over a loopback-only published port.
      // Docker Desktop internal networks do not route that published ingress.
      docker(['network', 'create', '--label', `helmglass.acceptance=${fixtureId}`, network]);
      networkCreated = true;
      docker(['volume', 'create', '--label', `helmglass.acceptance=${fixtureId}`, volume]);
      volumeCreated = true;
      function startVault(dataVolume) { return docker(['run', '--detach', '--name', dataVolume, '--network', network,
        '--label', `helmglass.acceptance=${fixtureId}`, '--hostname', 'vault',
        '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--memory-swap', '512m',
        '--tmpfs', '/tmp:size=16m', '--tmpfs', '/run:size=32m,uid=10001,gid=10001,mode=0700',
        '--publish', '127.0.0.1::8200', '--mount', `type=volume,source=${dataVolume},target=/vault/data`,
        '--mount', `type=bind,source=${identityPath},target=/run/secrets/vault_tls_identity,readonly`,
        '--mount', `type=bind,source=${resolve('Deploy/runtime/vault-bootstrap')},target=/opt/helm/bin/vault-bootstrap,readonly`,
        'helmglass-vault:0.1.0']); }
      container = startVault(volume);
      let port;
      async function statusAfterStart() {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try {
            const address = docker(['port', container, '8200/tcp']);
            port = Number(address.split(':').at(-1));
            return await request(port, ca, 'GET', 'sys/health');
          } catch { await delay(200); }
        }
        throw new Error('Vault did not expose its TLS status');
      }
      assert.equal((await statusAfterStart()).status, 501);
      await assert.rejects(request(port, undefined, 'GET', 'sys/health'));
      const initialized = await request(port, ca, 'PUT', 'sys/init', {
        secret_shares: 3, secret_threshold: 2,
      });
      assert.equal(initialized.status, 200);
      const { keys_base64: shares, root_token: rootToken } = initialized.data;
      assert.equal((await request(port, ca, 'PUT', 'sys/unseal', { key: shares[0] })).data.sealed, true);
      assert.equal((await request(port, ca, 'PUT', 'sys/unseal', { key: shares[1] })).data.sealed, false);

      function vault(arguments_, body) {
        return docker(['exec', '-i', '-e', 'VAULT_TOKEN', '-e', 'VAULT_ADDR=https://vault:8200',
          '-e', 'VAULT_CACERT=/run/helm/ca.crt', '-e', 'VAULT_MAX_RETRIES=0',
          container, 'vault', ...arguments_],
        { token: rootToken, input: body === undefined ? undefined : JSON.stringify(body) });
      }
      function write(path, data) { return JSON.parse(vault(['write', '-format=json', path, '-'], data) || '{}'); }
      const secret = randomBytes(32).toString('base64url');
      const cli = new VaultCli({ ...process.env, VAULT_TOKEN: rootToken }, 'docker', [
        'exec', '-i', '-e', 'VAULT_TOKEN', '-e', 'VAULT_ADDR=https://vault:8200',
        '-e', 'VAULT_CACERT=/run/helm/ca.crt', '-e', 'VAULT_MAX_RETRIES=0', container, 'vault',
      ]);
      const installation = { schemaVersion: 1, installationId: 'integration-fixture', caPem: ca,
        services: Object.fromEntries(VAULT_SERVICES.map((service) => [service, { fixture: secret }])),
        credentials: Object.fromEntries(VAULT_ROLES.map((service) => [service, {
          roleId: randomBytes(32).toString('base64url'), secretId: randomBytes(32).toString('base64url'),
        }])),
      };
      const pending = provisionVaultServices(cli, installation);
      assert.equal(pending.status, 'CERTIFICATE_REQUIRED');
      await writeFile(csrPath, pending.csrPem);
      await writeFile(extensionsPath, 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
      const signed = spawnSync(openssl, ['x509', '-req', '-in', csrPath, '-CA', certificatePath,
        '-CAkey', keyPath, '-set_serial', '0x' + randomBytes(16).toString('hex'), '-days', '1',
        '-extfile', extensionsPath, '-out', workerCertificatePath], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(signed.status, 0, 'Installation trust root signs the Vault-owned intermediate key');
      installation.workerCertificateChainPem = `${await readFile(workerCertificatePath, 'utf8')}\n${ca}`;
      assert.equal(provisionVaultServices(cli, installation).status, 'READY');
      assert.equal(provisionVaultServices(cli, installation).status, 'READY');
      const provisionSession = cli.execute(['write', '-format=json', 'auth/approle/login', '-'], {
        role_id: installation.credentials.provision.roleId,
        secret_id: installation.credentials.provision.secretId,
      });
      const scoped = new VaultCli({ ...process.env, VAULT_TOKEN: provisionSession.auth.client_token }, 'docker', cli.prefix);
      scoped.write('helm-kv/data/bootstrap/minio', { options: { cas: 0 }, data: { installationId: 'integration-fixture', status: 'PENDING' } });
      assert.equal(scoped.read('helm-kv/data/bootstrap/minio').metadata.version, 1);
      assert.throws(() => scoped.write('helm-kv/data/bootstrap/minio', {
        options: { cas: 0 }, data: { status: 'CONFLICT' },
      }), { code: 'VAULT_400' });
      assert.throws(() => scoped.write('helm-kv/data/services/api', {
        data: { forbidden: true },
      }), { code: 'VAULT_403' });
      scoped.write('auth/token/revoke-self', {});
      docker(['exec', '-i', container, 'sh', '-c', 'umask 077; cat > /run/helm/service-identity.json'], {
        input: JSON.stringify({ schemaVersion: 1, vault: { address: 'https://vault:8200', caPem: ca,
          ...installation.credentials.provision } }),
      });
      docker(['exec', container, 'sh', '-c',
        '. /opt/helm/bin/vault-bootstrap; helm_vault_read /run/helm/service-identity.json provision']);
      const loaded = JSON.parse(docker(['exec', container, 'cat', '/run/helm/service-secrets.json']));
      assert.ok(loaded.fixture === secret, 'Wrapper reads exactly its private KV record');
      assert.equal(docker(['exec', container, 'stat', '-c', '%a', '/run/helm/service-secrets.json']), '600');
      const forbidden = docker(['exec', container, 'sh', '-c',
        '. /opt/helm/bin/vault-bootstrap; helm_vault_read /run/helm/service-identity.json api'], { allowFailure: true });
      assert.notEqual(forbidden.status, 0);
      assert.ok(!forbidden.stderr.includes(secret));
      const audit = docker(['logs', container]);
      assert.ok(audit.includes('hmac-sha256:'), 'Audit redacts secret material');
      assert.ok(!audit.includes(secret), 'Audit must not expose the fixture KV secret');

      docker(['restart', container]);
      assert.equal((await statusAfterStart()).status, 503);
      assert.equal((await request(port, ca, 'PUT', 'sys/unseal', { key: shares[0] })).data.sealed, true);
      assert.equal((await request(port, ca, 'PUT', 'sys/unseal', { key: shares[2] })).data.sealed, false);
      const persisted = JSON.parse(vault(['read', '-format=json', 'helm-kv/data/services/provision']));
      assert.ok(persisted.data.data.fixture === secret, 'Raft retains secrets across cold restart');
      docker(['exec', container, '/opt/helm/bin/healthcheck']);
      write('auth/approle/role/helm-provision/secret-id/destroy', {
        secret_id: installation.credentials.provision.secretId,
      });
      assert.throws(() => provisionVaultServices(cli, installation), { code: 'VAULT_CREDENTIAL_REVOKED' });
      cli.execute(['delete', '-format=json', 'sys/mounts/helm-transit']);
      assert.throws(() => provisionVaultServices(cli, installation), { code: 'VAULT_MOUNT_REMOVED' });
    } finally {
      if (container) {
        assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "helmglass.acceptance"}}', container]), fixtureId);
        docker(['rm', '--force', '--volumes', container]);
      }
      if (volumeCreated) {
        assert.equal(docker(['volume', 'inspect', '--format', '{{index .Labels "helmglass.acceptance"}}', volume]), fixtureId);
        docker(['volume', 'rm', volume]);
      }
      if (networkCreated) {
        assert.equal(docker(['network', 'inspect', '--format', '{{index .Labels "helmglass.acceptance"}}', network]), fixtureId);
        docker(['network', 'rm', network]);
      }
      for (const path of [keyPath, certificatePath, identityPath, csrPath, workerCertificatePath, extensionsPath]) {
        await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
      await rmdir(directory);
    }
  });
