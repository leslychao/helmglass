import assert from 'node:assert/strict';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { prepareBootstrap } from '../bootstrap.mjs';
import { encryptRecovery, decryptRecovery } from '../custody.mjs';
import { isInside, protectDirectory, writeProtectedFile } from '../protected-files.mjs';
import { createAuthority, createIdentity, validateInternalIdentity } from '../tls.mjs';

test('protected bootstrap generates distinct TLS identities once and does not replace missing credentials', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'helm-bootstrap-test-'));
  try {
    await protectDirectory(temporary, resolve('.'));
    const caPem = await createAuthority(temporary);
    const edge = await createIdentity(temporary, 'helm-test', caPem);
    const edgePath = join(temporary, 'edge.pem');
    await writeProtectedFile(edgePath, edge.certificatePem + caPem + edge.privateKeyPem);
    const recipientPath = join(temporary, 'backup-recipient.pem');
    await writeProtectedFile(recipientPath, edge.certificatePem);
    const configuration = { INSTALLATION_ID: 'bootstrap-test', PUBLIC_ORIGIN: 'https://helm-test', TURN_REALM: 'helm-test',
      LOCAL_SECRETS_DIR: join(temporary, 'service-secrets'), LOCAL_RECOVERY_DIR: join(temporary, 'offline-custody'),
      EDGE_TLS_FILE: edgePath, TURN_TLS_FILE: edgePath,
      BACKUP_RECIPIENT_FILE: recipientPath,
      KEYCLOAK_ADMIN_EMAIL: 'admin@example.test', KEYCLOAK_ADMIN_LAST_NAME: 'Fixture',
      KEYCLOAK_ANGELINA_EMAIL: 'angelina@example.test', KEYCLOAK_ANGELINA_LAST_NAME: 'Fixture',
      MCP_REDIRECT_URIS: 'https://chatgpt.com/connector_platform_oauth_redirect', WORKER_COUNT: '2' };
    const environment = { KEYCLOAK_ADMIN_PASSWORD: randomBytes(32).toString('base64url'),
      KEYCLOAK_ANGELINA_PASSWORD: randomBytes(32).toString('base64url') };
    await assert.rejects(prepareBootstrap(configuration, {}), /Required parameter/);
    const first = await prepareBootstrap(configuration, environment);
    assert.equal(first.created, true);
    await assert.rejects(readFile(join(first.directory, 'minio-license')), { code: 'ENOENT' });
    const kvBefore = await readFile(join(first.directory, 'vault-services-input'));
    const api = JSON.parse(await readFile(join(first.directory, 'api-bootstrap'), 'utf8'));
    const adapter = JSON.parse(await readFile(join(first.directory, 'mcp-adapter-bootstrap'), 'utf8'));
    assert.notEqual(api.tls.privateKeyPem, adapter.tls.privateKeyPem);
    assert.equal(new X509Certificate(api.tls.certificatePem).checkHost('api'), 'api');
    assert.equal(new X509Certificate(adapter.tls.certificatePem).subject, 'CN=mcp-adapter');
    validateInternalIdentity(api.tls, 'api');
    validateInternalIdentity(adapter.tls, 'mcp-adapter', true);
    assert.throws(() => validateInternalIdentity(adapter.tls, 'mcp-adapter'), /TLS identity/);
    assert.throws(() => validateInternalIdentity(api.tls, 'wrong-host'), /TLS identity/);
    assert.throws(() => validateInternalIdentity({ ...api.tls, privateKeyPem: adapter.tls.privateKeyPem }, 'api'), /TLS identity/);
    const expiry = Date.parse(new X509Certificate(api.tls.certificatePem).validTo);
    assert.throws(() => validateInternalIdentity(api.tls, 'api', false, expiry), /rotation/);
    const secrets = JSON.parse(kvBefore);
    const backup = JSON.parse(await readFile(join(first.directory, 'backup-bootstrap'), 'utf8'));
    assert.equal(backup.vault.roleId, secrets.credentials.backup.roleId);
    assert.equal(secrets.services.backup, undefined, 'Snapshot role must not receive a service KV record');
    assert.equal(Buffer.from(secrets.services['oauth2-proxy'].cookieSecret, 'base64url').length, 32);
    assert.equal(secrets.services.api.s3AccessKey, secrets.services.provision.minio.apiAccessKey);
    assert.notEqual(secrets.services.api.databasePassword, secrets.services.migration.databasePassword);
    assert.equal((await prepareBootstrap(configuration, environment)).created, false);
    assert.deepEqual(await readFile(join(first.directory, 'vault-services-input')), kvBefore);
    await assert.rejects(prepareBootstrap({ ...configuration, PUBLIC_ORIGIN: 'https://changed.example.test' }, environment), /different installation/);
    await unlink(join(first.directory, 'worker-bootstrap'));
    await assert.rejects(prepareBootstrap(configuration, environment), { code: 'ENOENT' });
  } finally {
    const canonical = await realpath(temporary);
    assert.equal(canonical.toLowerCase(), resolve(temporary).toLowerCase());
    assert.ok(isInside(tmpdir(), canonical) && temporary.includes('helm-bootstrap-test-'));
    await rm(canonical, { recursive: true });
  }
});

test('offline recovery authenticates the installation, password and encrypted contents', async () => {
  const password = randomBytes(32).toString('base64url');
  const value = { shares: [randomBytes(32).toString('base64'), randomBytes(32).toString('base64')], threshold: 2 };
  const envelope = await encryptRecovery('fixture', value, password);
  assert.deepEqual(await decryptRecovery('fixture', envelope, password), value);
  assert.ok(!JSON.stringify(envelope).includes(value.shares[0]));
  await assert.rejects(decryptRecovery('different', envelope, password));
  await assert.rejects(decryptRecovery('fixture', envelope, 'incorrect-password-value'));
  await assert.rejects(decryptRecovery('fixture', { ...envelope, tag: randomBytes(16).toString('base64') }, password));
});
