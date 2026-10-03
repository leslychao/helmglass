import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { KeycloakClient, readKeycloakJson } from '../src/keycloak-client.mjs';
import { provisionRealm } from '../src/realm.mjs';
import { provisionMinio } from '../src/minio-provision.mjs';
import { authorizeMcp } from './keycloak-flow.mjs';

// Runs only in the disposable provider fixture, with its private input volume.
const path = '/fixture/input.json';
const input = JSON.parse(await readFile(path, 'utf8'));
const tokenResponse = await fetch(`${input.keycloakAddress}/realms/master/protocol/openid-connect/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli',
    username: 'acceptance-bootstrap', password: input.bootstrapPassword }),
  signal: AbortSignal.timeout(10_000),
});
assert.equal(tokenResponse.status, 200);
const token = await readKeycloakJson(tokenResponse, 32_768);
const client = new KeycloakClient(input.keycloakAddress, token.access_token);
await provisionRealm(client, {
  installationId: 'account-cleanup-fixture', publicOrigin: 'https://helm.integration.test',
  webClientSecret: input.webClientSecret, apiClientSecret: input.apiClientSecret,
  mcpRedirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
});
// Theme rendering is covered separately; this disposable official image has no Helm theme.
await client.request('PUT', 'admin/realms/helm', { loginTheme: 'keycloak' });
for (const user of input.users) {
  await client.request('POST', 'admin/realms/helm/users', {
    username: user.username, firstName: 'Disposable', lastName: 'Fixture',
    email: `${user.username}@example.test`, emailVerified: true, enabled: true,
    requiredActions: [], credentials: [{ type: 'password', value: user.password, temporary: false }],
  });
  const matches = await client.request('GET', `admin/realms/helm/users?username=${user.username}&exact=true`);
  assert.equal(matches.length, 1);
  user.subject = matches[0].id;
  const grant = await authorizeMcp(input.keycloakAddress, user.password, undefined, user.username);
  user.refreshToken = grant.refresh_token;
}
let checkpoint = { value: null, version: 0 };
await provisionMinio(input.minio, 'account-cleanup-fixture', {
  read: async () => checkpoint,
  compareAndSet: async (value, version) => {
    assert.equal(version, checkpoint.version);
    checkpoint = { value, version: version + 1 };
    return checkpoint;
  },
});
delete input.bootstrapPassword;
delete input.webClientSecret;
for (const user of input.users) delete user.password;
await writeFile(path, JSON.stringify(input), { mode: 0o600 });
process.stdout.write('Disposable realm, user grants and scoped storage identity ready.\n');
