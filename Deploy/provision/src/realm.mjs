import { ProvisioningError } from './keycloak-client.mjs';

const REALM_PATH = 'admin/realms/helm';
const SCOPES = ['tasks:read', 'tasks:write', 'browser:view', 'browser:execute', 'results:write'];
const PROTECTED_ATTRIBUTES = ['helm.provisioning.installation', 'helm.provisioning.phase'];

function reject(message) {
  throw new ProvisioningError('REALM_CONFIGURATION_INVALID', message);
}

function publicOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { reject('PUBLIC_ORIGIN is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search
      || parsed.hash || parsed.pathname !== '/' || parsed.origin !== value) {
    reject('PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.');
  }
  return parsed.origin;
}

function clientDefinition(input, clientId, audience, redirects, confidential) {
  return {
    clientId,
    enabled: true,
    protocol: 'openid-connect',
    publicClient: !confidential,
    ...(confidential ? { secret: input.webClientSecret } : {}),
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: redirects,
    webOrigins: confidential ? [input.publicOrigin] : [],
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'helm.installationId': input.installationId,
      'include.auth_time': 'true',
      'post.logout.redirect.uris': confidential ? input.publicOrigin : '',
    },
    // Keycloak's built-in basic scope supplies the authenticated session's auth_time and sub.
    defaultClientScopes: confidential ? ['basic', 'profile', 'email', 'roles'] : ['basic', 'profile', 'email', ...SCOPES],
    protocolMappers: [{
      name: 'helm-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
      config: { 'included.custom.audience': audience, 'access.token.claim': 'true', 'id.token.claim': 'false' },
    }],
  };
}

async function createOrRead(client, createPath, body, findExisting) {
  try {
    await client.request('POST', createPath, body);
  } catch (error) {
    if (error.code !== 'ADMIN_RESULT_UNKNOWN' && error.code !== 'ADMIN_HTTP_409') throw error;
    const existing = await findExisting();
    if (!existing) throw error;
    return existing;
  }
  return findExisting();
}

export async function provisionRealm(client, input) {
  if (!input || !/^[A-Za-z0-9_-]{1,80}$/.test(input.installationId ?? '')) {
    reject('installationId is invalid.');
  }
  publicOrigin(input.publicOrigin);
  if (typeof input.webClientSecret !== 'string' || input.webClientSecret.trim().length < 32) {
    reject('webClientSecret must contain at least 32 characters.');
  }
  if (typeof input.apiClientSecret !== 'string' || input.apiClientSecret.trim().length < 32) {
    reject('apiClientSecret must contain at least 32 characters.');
  }
  if (!Array.isArray(input.mcpRedirectUris) || input.mcpRedirectUris.length === 0
      || input.mcpRedirectUris.length > 10) {
    reject('At least one fixed MCP client redirect URI is required.');
  }
  for (const redirect of input.mcpRedirectUris) {
    let parsed;
    try { parsed = new URL(redirect); } catch { reject('MCP redirect URI is invalid.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || redirect.includes('*')) {
      reject('MCP redirect URI must be an exact HTTPS URL.');
    }
  }
  let realm = await client.request('GET', REALM_PATH, undefined, { allowNotFound: true });
  if (!realm) {
    realm = await createOrRead(client, 'admin/realms', {
      realm: 'helm', enabled: true, registrationAllowed: false,
      bruteForceProtected: true, sslRequired: 'external',
      ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 28800,
      attributes: { 'helm.installationId': input.installationId },
    }, () => client.request('GET', REALM_PATH, undefined, { allowNotFound: true }));
  }
  if (realm?.attributes?.['helm.installationId'] !== input.installationId) {
    throw new ProvisioningError('REALM_OWNERSHIP_CONFLICT', 'Existing realm is not managed by this installation.');
  }

  const profilePath = `${REALM_PATH}/users/profile`;
  const profile = await client.request('GET', profilePath);
  let profileChanged = false;
  for (const name of PROTECTED_ATTRIBUTES) {
    const existing = profile.attributes.find((attribute) => attribute.name === name);
    if (existing) {
      if (JSON.stringify(existing.permissions?.edit) !== '["admin"]'
          || JSON.stringify(existing.permissions?.view) !== '["admin"]') {
        reject('Provisioning markers are not restricted to administrators.');
      }
    } else {
      profile.attributes.push({ name, permissions: { view: ['admin'], edit: ['admin'] }, multivalued: false });
      profileChanged = true;
    }
  }
  if (profileChanged) await client.request('PUT', profilePath, profile);

  if (!await client.request('GET', `${REALM_PATH}/roles/platform_admin`, undefined, { allowNotFound: true })) {
    await createOrRead(client, `${REALM_PATH}/roles`, { name: 'platform_admin', description: 'Helm metadata administration' },
      () => client.request('GET', `${REALM_PATH}/roles/platform_admin`, undefined, { allowNotFound: true }));
  }
  const scopes = await client.request('GET', `${REALM_PATH}/client-scopes`);
  for (const name of SCOPES) {
    if (!scopes.some((scope) => scope.name === name)) {
      await createOrRead(client, `${REALM_PATH}/client-scopes`, {
        name, protocol: 'openid-connect', attributes: { 'include.in.token.scope': 'true' },
      }, async () => (await client.request('GET', `${REALM_PATH}/client-scopes`)).find((scope) => scope.name === name));
    }
  }

  for (const definition of [
    clientDefinition(input, 'helm-web', 'helm-api-web', [`${input.publicOrigin}/oauth2/callback`], true),
    clientDefinition(input, 'helm-mcp', 'helm-mcp', input.mcpRedirectUris, false),
  ]) {
    const find = async () => {
      const clients = await client.request('GET', `${REALM_PATH}/clients?${new URLSearchParams({ clientId: definition.clientId })}`);
      return clients.find((candidate) => candidate.clientId === definition.clientId);
    };
    let existing = await find();
    if (!existing) existing = await createOrRead(client, `${REALM_PATH}/clients`, definition, find);
    if (!existing || existing.attributes?.['helm.installationId'] !== input.installationId) {
      reject('An OAuth client belongs to another installation.');
    }
    // A normal restart verifies the contract; it does not overwrite operator changes or secrets.
    const actual = await client.request('GET', `${REALM_PATH}/clients/${encodeURIComponent(existing.id)}`);
    for (const property of ['enabled', 'publicClient', 'standardFlowEnabled', 'implicitFlowEnabled', 'directAccessGrantsEnabled', 'serviceAccountsEnabled']) {
      if (Boolean(actual[property]) !== definition[property]) reject(`OAuth client ${definition.clientId} requires reconciliation of ${property}.`);
    }
    if (actual.attributes?.['pkce.code.challenge.method'] !== 'S256'
        || JSON.stringify([...actual.redirectUris].sort()) !== JSON.stringify([...definition.redirectUris].sort())) {
      reject(`OAuth client ${definition.clientId} redirect or PKCE settings require reconciliation.`);
    }
    if (definition.defaultClientScopes.some(scope => !actual.defaultClientScopes?.includes(scope))) {
      reject(`OAuth client ${definition.clientId} required token scopes need reconciliation.`);
    }
  }
  await provisionApiService(client, input);
  return { realm: 'helm', webClient: 'helm-web', mcpClient: 'helm-mcp' };
}

async function provisionApiService(client, input) {
  const findClient = async (clientId) => (await client.request('GET',
    `${REALM_PATH}/clients?${new URLSearchParams({ clientId })}`)).find((item) => item.clientId === clientId);
  const clientId = 'helm-api-service';
  let api = await findClient(clientId);
  if (!api) {
    api = await createOrRead(client, `${REALM_PATH}/clients`, {
      clientId, enabled: true, protocol: 'openid-connect', publicClient: false,
      secret: input.apiClientSecret, standardFlowEnabled: false, implicitFlowEnabled: false,
      directAccessGrantsEnabled: false, serviceAccountsEnabled: true, fullScopeAllowed: false,
      attributes: { 'helm.installationId': input.installationId, 'helm.provisioning.phase': 'PENDING' },
    }, () => findClient(clientId));
  }
  if (!api || api.attributes?.['helm.installationId'] !== input.installationId) {
    reject('API service identity is not owned by this installation.');
  }
  api = await client.request('GET', `${REALM_PATH}/clients/${encodeURIComponent(api.id)}`);
  if (!api.enabled || api.publicClient || api.standardFlowEnabled || api.implicitFlowEnabled
      || api.directAccessGrantsEnabled || !api.serviceAccountsEnabled || api.fullScopeAllowed) {
    reject('API service identity settings require explicit reconciliation.');
  }
  const management = await findClient('realm-management');
  if (!management) reject('Keycloak realm management client is missing.');
  const role = await client.request('GET', `${REALM_PATH}/clients/${management.id}/roles/manage-users`);
  const account = await client.request('GET', `${REALM_PATH}/clients/${api.id}/service-account-user`);
  const mappings = [
    `${REALM_PATH}/users/${account.id}/role-mappings/clients/${management.id}`,
    `${REALM_PATH}/clients/${api.id}/scope-mappings/clients/${management.id}`,
  ];
  for (const path of mappings) {
    const assigned = await client.request('GET', path);
    if (assigned.some((item) => item.id === role.id)) continue;
    if (api.attributes['helm.provisioning.phase'] !== 'PENDING') {
      reject('API service permission was removed; automatic reprovisioning will not restore it.');
    }
    try { await client.request('POST', path, [role]); }
    catch (error) {
      if (error.code !== 'ADMIN_RESULT_UNKNOWN'
          || !(await client.request('GET', path)).some((item) => item.id === role.id)) throw error;
    }
  }
  if (api.attributes['helm.provisioning.phase'] === 'PENDING') {
    await client.request('PUT', `${REALM_PATH}/clients/${api.id}`, {
      ...api, attributes: { ...api.attributes, 'helm.provisioning.phase': 'READY' },
    });
  }
}
