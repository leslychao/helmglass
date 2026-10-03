import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { KeycloakClient } from '../src/keycloak-client.mjs';
import { provisionRealm } from '../src/realm.mjs';
import { provisionPredefinedUsers } from '../src/predefined-users.mjs';

const IMAGE = 'quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc';

function docker(args, env = process.env) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576 });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed (exit ${result.status}).`);
  return result.stdout.trim();
}

async function waitForKeycloak(baseUrl) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/realms/master`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      await response.body?.cancel();
    } catch { /* The bounded readiness loop tolerates startup connection refusal. */ }
    await delay(500);
  }
  throw new Error('Keycloak did not become ready within 120 seconds.');
}

test('real Keycloak provisioning, repeat run, role revocation and conflict handling', { timeout: 240_000 }, async () => {
  const testId = randomUUID();
  const bootstrapPassword = randomBytes(32).toString('base64url');
  const containerId = docker([
    'run', '--detach', '--name', `helmglass-keycloak-it-${testId}`,
    '--label', `helmglass.acceptance=${testId}`,
    '--memory', '1g', '--cpus', '1.5', '--publish', '127.0.0.1::8080',
    '--env', 'KC_BOOTSTRAP_ADMIN_USERNAME=acceptance-bootstrap',
    '--env', 'KC_BOOTSTRAP_ADMIN_PASSWORD', IMAGE,
    'start-dev', '--http-relative-path=/auth',
  ], { ...process.env, KC_BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword });

  try {
    const address = docker(['port', containerId, '8080/tcp']);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const baseUrl = `http://${address}/auth`;
    await waitForKeycloak(baseUrl);
    const tokenResponse = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli',
        username: 'acceptance-bootstrap', password: bootstrapPassword }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(tokenResponse.status, 200, 'Bootstrap token request must succeed');
    const { access_token: accessToken } = await tokenResponse.json();
    const client = new KeycloakClient(baseUrl, accessToken);
    const configuration = {
      installationId: 'integration-fixture', publicOrigin: 'https://helm.integration.test',
      webClientSecret: randomBytes(32).toString('base64url'),
      apiClientSecret: randomBytes(32).toString('base64url'),
      mcpRedirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    };
    await provisionRealm(client, configuration);
    const initialRealm = await client.request('GET', 'admin/realms/helm');
    assert.equal(initialRealm.loginTheme, 'helmglass');
    assert.equal(initialRealm.defaultLocale, 'ru');
    // Upgrade an already provisioned realm without resetting users or security policy.
    await client.request('PUT', 'admin/realms/helm', { loginTheme: 'keycloak' });
    await provisionRealm(client, configuration);
    const upgraded = await client.request('GET', 'admin/realms/helm');
    assert.equal(upgraded.loginTheme, 'helmglass');
    assert.equal(upgraded.bruteForceProtected, initialRealm.bruteForceProtected);
    assert.deepEqual(upgraded.attributes, initialRealm.attributes);
    const data = {
      installationId: configuration.installationId,
      admin: { email: 'admin@example.test', lastName: 'Fixture', password: randomBytes(32).toString('base64url') },
      angelina: { email: 'angelina@example.test', lastName: 'Fixture', password: randomBytes(32).toString('base64url') },
    };
    const results = await provisionPredefinedUsers(client, data);
    assert.equal(results.length, 2);
    const adminPath = `admin/realms/helm/users/${results[0].id}`;
    const userPath = `admin/realms/helm/users/${results[1].id}`;
    const admin = await client.request('GET', adminPath);
    const regular = await client.request('GET', userPath);
    assert.equal(admin.enabled, true);
    assert.equal(regular.enabled, true);
    assert.equal(admin.emailVerified, true);
    assert.deepEqual(admin.requiredActions, []);
    assert.deepEqual(regular.requiredActions, []);
    const role = await client.request('GET', 'admin/realms/helm/roles/platform_admin');
    assert.ok((await client.request('GET', `${adminPath}/role-mappings/realm`)).some((item) => item.id === role.id));
    assert.ok(!(await client.request('GET', `${userPath}/role-mappings/realm`)).some((item) => item.id === role.id));

    const serviceTokenResponse = await fetch(`${baseUrl}/realms/helm/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'helm-api-service',
        client_secret: configuration.apiClientSecret }), signal: AbortSignal.timeout(10_000),
    });
    assert.equal(serviceTokenResponse.status, 200);
    const serviceToken = await serviceTokenResponse.json();
    const serviceClient = new KeycloakClient(baseUrl, serviceToken.access_token);
    assert.equal((await serviceClient.request('GET', userPath)).id, results[1].id);
    await serviceClient.request('POST', `${userPath}/logout`);
    await assert.rejects(serviceClient.request('GET', 'admin/realms/master'), { code: 'ADMIN_HTTP_403' });

    const profile = await client.request('GET', 'admin/realms/helm/users/profile');
    for (const name of ['helm.provisioning.installation', 'helm.provisioning.phase']) {
      assert.deepEqual(profile.attributes.find((attribute) => attribute.name === name).permissions.edit, ['admin']);
    }
    await client.request('DELETE', `${adminPath}/role-mappings/realm`, [role]);
    await client.request('PUT', adminPath, { ...admin, enabled: false, lastName: 'Changed' });
    const changedPassword = randomBytes(32).toString('base64url');
    await client.request('PUT', `${userPath}/reset-password`, { type: 'password', value: changedPassword, temporary: false });
    const passwordBefore = await client.request('GET', `${userPath}/credentials`);
    await provisionRealm(client, configuration);
    const repeated = await provisionPredefinedUsers(client, data);
    assert.deepEqual(repeated.map((item) => item.id), results.map((item) => item.id));
    assert.equal((await client.request('GET', adminPath)).enabled, false);
    assert.equal((await client.request('GET', adminPath)).lastName, 'Changed');
    assert.ok(!(await client.request('GET', `${adminPath}/role-mappings/realm`)).some((item) => item.id === role.id));
    assert.deepEqual(await client.request('GET', `${userPath}/credentials`), passwordBefore);

    await client.request('DELETE', userPath);
    const afterDelete = await provisionPredefinedUsers(client, data);
    assert.equal(afterDelete[1].status, 'previously-removed');
    assert.equal(await client.request('GET', userPath, undefined, { allowNotFound: true }), undefined);

    const realm = await client.request('GET', 'admin/realms/helm');
    await client.request('PUT', 'admin/realms/helm', {
      ...realm, attributes: { ...realm.attributes, 'helm.installationId': 'different-installation' },
    });
    await assert.rejects(provisionPredefinedUsers(client, data), { code: 'REALM_OWNERSHIP_CONFLICT' });
  } finally {
    const owner = docker(['inspect', '--format', '{{index .Config.Labels "helmglass.acceptance"}}', containerId]);
    assert.equal(owner, testId, 'Only this test-owned container may be removed');
    docker(['rm', '--force', containerId]);
  }
});
