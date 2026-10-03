import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileMcpOfflineAccess } from '../src/realm.mjs';

function fixture() {
  const realm = { attributes: { 'helm.installationId': 'fixture' }, offlineSessionIdleTimeout: 2592000,
    offlineSessionMaxLifespanEnabled: false, ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 28800 };
  const client = { id: 'mcp-id', clientId: 'helm-mcp', enabled: true, publicClient: true,
    standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false, optionalClientScopes: [], defaultClientScopes: ['basic', 'tasks:read'],
    attributes: { 'helm.installationId': 'fixture', 'pkce.code.challenge.method': 'S256', retained: 'value' } };
  const mutations = [];
  const admin = { async request(method, path, body) {
    if (method === 'GET') {
      if (path === 'admin/realms/helm') return structuredClone(realm);
      if (path === 'admin/realms/helm/clients?clientId=helm-mcp') return [structuredClone(client)];
      if (path === 'admin/realms/helm/clients/mcp-id') return structuredClone(client);
      if (path === 'admin/realms/helm/client-scopes') return [{ id: 'offline-id', name: 'offline_access', protocol: 'openid-connect' }];
    }
    if (method === 'PUT') {
      mutations.push({ path, body });
      if (path === 'admin/realms/helm') return Object.assign(realm, body);
      if (path === 'admin/realms/helm/clients/mcp-id') return Object.assign(client, body);
      if (path === 'admin/realms/helm/clients/mcp-id/optional-client-scopes/offline-id') {
        client.optionalClientScopes.push('offline_access');
        return;
      }
    }
    throw new Error('Unexpected admin operation');
  } };
  return { realm, client, mutations, admin };
}

test('persistent MCP policy preserves SSO, client security and unrelated attributes; repeat is read-only', async () => {
  const state = fixture();
  assert.deepEqual(await reconcileMcpOfflineAccess(state.admin, 'fixture'), {
    clientId: 'helm-mcp', accessTokenSeconds: 300, offlineIdleSeconds: 7776000, offlineMaximumEnabled: false,
  });
  assert.deepEqual(state.mutations.map(item => item.path), [
    'admin/realms/helm', 'admin/realms/helm/clients/mcp-id',
    'admin/realms/helm/clients/mcp-id/optional-client-scopes/offline-id',
  ]);
  assert.deepEqual(state.mutations[0].body, {
    offlineSessionIdleTimeout: 7776000, offlineSessionMaxLifespanEnabled: false,
  });
  assert.equal(state.realm.ssoSessionIdleTimeout, 1800);
  assert.equal(state.realm.ssoSessionMaxLifespan, 28800);
  assert.equal(state.client.attributes.retained, 'value');
  assert.equal(state.client.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(state.client.directAccessGrantsEnabled, false);
  assert.deepEqual(state.client.defaultClientScopes, ['basic', 'tasks:read']);
  await reconcileMcpOfflineAccess(state.admin, 'fixture');
  assert.equal(state.mutations.length, 3);
});

test('foreign ownership or weakened MCP OAuth contract fails before any mutation', async () => {
  for (const change of [state => { state.realm.attributes['helm.installationId'] = 'foreign'; },
    state => { state.client.attributes['helm.installationId'] = 'foreign'; },
    state => { state.client.attributes['pkce.code.challenge.method'] = 'plain'; },
    state => { state.client.directAccessGrantsEnabled = true; }]) {
    const state = fixture();
    change(state);
    await assert.rejects(reconcileMcpOfflineAccess(state.admin, 'fixture'), { code: 'REALM_CONFIGURATION_INVALID' });
    assert.equal(state.mutations.length, 0);
  }
});
