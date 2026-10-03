import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { KeycloakClient, readKeycloakJson } from '../src/keycloak-client.mjs';
import { provisionRealm, reconcileMcpOfflineAccess } from '../src/realm.mjs';
import { provisionPredefinedUsers } from '../src/predefined-users.mjs';

const IMAGE = 'quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc';

function docker(args, env = process.env) {
  const result = spawnSync('docker', ['--context', 'desktop-linux', ...args], { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576 });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed (exit ${result.status}).`);
  return result.stdout.trim();
}

async function tokenRequest(baseUrl, parameters) {
  const response = await fetch(`${baseUrl}/realms/helm/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'helm-mcp', ...parameters }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await readKeycloakJson(response, 32_768) };
}

async function authorizeMcp(baseUrl, password,
  scope = 'openid email offline_access tasks:read tasks:write browser:view browser:execute results:write') {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const cookies = new Map();
  function remember(response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    assert.ok(cookies.size <= 20);
  }
  const authorize = new URL(`${baseUrl}/realms/helm/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({ client_id: 'helm-mcp', response_type: 'code', redirect_uri: redirectUri,
    scope,
    state, nonce: randomUUID(), code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
  const form = await fetch(authorize, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  assert.equal(form.status, 200, 'The real authorization request must render a login form');
  remember(form);
  const reader = form.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      assert.ok(bytes <= 131_072, 'Login form is bounded');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const html = Buffer.concat(chunks, bytes).toString('utf8');
  const action = /<form\b[^>]*\baction="([^"]+)"/.exec(html)?.[1];
  assert.ok(action, 'Keycloak login form must expose an action');
  const login = new URL(action.replaceAll('&amp;', '&'));
  assert.equal(login.origin, new URL(baseUrl).origin, 'Credentials stay in the disposable issuer');
  const submitted = await fetch(login, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded',
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
    body: new URLSearchParams({ username: 'admin', password }),
  });
  await submitted.body?.cancel();
  assert.equal(submitted.status, 302, 'Valid credentials finish the standard code flow');
  const callback = new URL(submitted.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.has('error'), false, 'OAuth code flow must accept the requested scopes');
  const tokens = await tokenRequest(baseUrl, { grant_type: 'authorization_code',
    code: callback.searchParams.get('code'), redirect_uri: redirectUri, code_verifier: verifier });
  assert.equal(tokens.status, 200, 'Code exchange succeeds with PKCE S256');
  return tokens.body;
}

function claims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
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

    const findClient = async clientId => (await client.request('GET',
      `admin/realms/helm/clients?clientId=${clientId}`)).find(item => item.clientId === clientId);
    const mcp = await findClient('helm-mcp');
    const web = await findClient('helm-web');
    const webBefore = await client.request('GET', `admin/realms/helm/clients/${web.id}`);
    const mcpPath = `admin/realms/helm/clients/${mcp.id}`;
    const offline = (await client.request('GET', 'admin/realms/helm/client-scopes'))
      .find(item => item.name === 'offline_access');
    await client.request('DELETE', `${mcpPath}/optional-client-scopes/${offline.id}`);
    await client.request('PUT', 'admin/realms/helm', {
      offlineSessionIdleTimeout: 2592000, offlineSessionMaxLifespanEnabled: true,
    });
    await reconcileMcpOfflineAccess(client, configuration.installationId);
    await reconcileMcpOfflineAccess(client, configuration.installationId);
    assert.deepEqual(await client.request('GET', `admin/realms/helm/clients/${web.id}`), webBefore);
    const policyRealm = await client.request('GET', 'admin/realms/helm');
    assert.equal(policyRealm.offlineSessionIdleTimeout, 7776000);
    assert.equal(policyRealm.offlineSessionMaxLifespanEnabled, false);
    assert.equal(policyRealm.ssoSessionIdleTimeout, initialRealm.ssoSessionIdleTimeout);
    assert.equal(policyRealm.ssoSessionMaxLifespan, initialRealm.ssoSessionMaxLifespan);
    assert.ok((await client.request('GET', `${mcpPath}/optional-client-scopes`))
      .some(item => item.name === 'offline_access'));
    // The base Keycloak fixture has no application theme; the real browser fixture owns theme checks.
    await client.request('PUT', 'admin/realms/helm', { loginTheme: 'keycloak' });
    const ssoTokens = await authorizeMcp(baseUrl, data.admin.password, 'openid email');
    const initialTokens = await authorizeMcp(baseUrl, data.admin.password);
    const initialClaims = claims(initialTokens.access_token);
    assert.equal(initialClaims.exp - initialClaims.iat, 300);
    assert.equal(claims(initialTokens.refresh_token).typ, 'Offline');
    const initialRefreshClaims = claims(initialTokens.refresh_token);
    assert.equal(initialRefreshClaims.exp - initialRefreshClaims.iat, 7776000,
      'Each offline token covers the configured inactivity window');
    assert.equal(typeof initialClaims.sid, 'string');
    assert.equal(typeof initialClaims.auth_time, 'number');
    const onlineSessions = await client.request('GET', `${adminPath}/sessions`);
    assert.ok(onlineSessions.some(session => session.id === claims(ssoTokens.access_token).sid),
      'The ordinary code flow creates an online SSO session');
    await client.request('DELETE', `admin/realms/helm/sessions/${claims(ssoTokens.access_token).sid}`);
    assert.equal((await client.request('GET', `${adminPath}/sessions`)).length, 0);
    await delay(1100);
    const refreshed = await tokenRequest(baseUrl, { grant_type: 'refresh_token', refresh_token: initialTokens.refresh_token });
    assert.equal(refreshed.status, 200, 'Offline refresh survives ordinary SSO session logout');
    assert.equal(claims(refreshed.body.access_token).sid, initialClaims.sid);
    assert.equal(claims(refreshed.body.access_token).auth_time, initialClaims.auth_time);
    assert.equal(claims(refreshed.body.access_token).exp - claims(refreshed.body.access_token).iat, 300);
    const refreshedClaims = claims(refreshed.body.refresh_token);
    assert.equal(refreshedClaims.exp - refreshedClaims.iat, 7776000);
    assert.ok(refreshedClaims.exp > initialRefreshClaims.exp, 'Refresh advances the inactivity window');
    assert.ok(refreshed.body.scope.split(' ').includes('offline_access'));
    const revoked = await fetch(`${baseUrl}/realms/helm/protocol/openid-connect/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'helm-mcp', token: refreshed.body.refresh_token,
        token_type_hint: 'refresh_token' }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    await revoked.body?.cancel();
    assert.equal(revoked.status, 200);
    assert.equal((await tokenRequest(baseUrl, { grant_type: 'refresh_token',
      refresh_token: refreshed.body.refresh_token })).status, 400, 'Explicit revoke denies offline refresh');
    const blockTokens = await authorizeMcp(baseUrl, data.admin.password);
    await client.request('PUT', adminPath, { enabled: false });
    assert.equal((await tokenRequest(baseUrl, { grant_type: 'refresh_token',
      refresh_token: blockTokens.refresh_token })).status, 400, 'Blocked user cannot refresh offline tokens');
    await client.request('PUT', adminPath, { enabled: true });

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
