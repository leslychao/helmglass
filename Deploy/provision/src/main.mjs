import { readFile, lstat, unlink } from 'node:fs/promises';
import { KeycloakClient, ProvisioningError, readKeycloakJson } from './keycloak-client.mjs';
import { provisionRealm } from './realm.mjs';
import { provisionPredefinedUsers, validatePredefinedInput } from './predefined-users.mjs';
import { provisionMinio, validateStorageInput } from './minio-provision.mjs';
import { withMinioProvisionState } from './vault-state.mjs';

async function readSecret(path, name) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 65_536) throw new Error('Invalid file');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new ProvisioningError('BOOTSTRAP_INPUT_INVALID', `Secret ${name} is missing or invalid.`);
  }
}

async function keycloakAccessToken(identity) {
  if (!identity || !/^[A-Za-z0-9_-]+$/.test(identity.realm ?? '')
      || typeof identity.clientId !== 'string' || !identity.clientId
      || typeof identity.clientSecret !== 'string' || !identity.clientSecret) {
    throw new ProvisioningError('BOOTSTRAP_INPUT_INVALID', 'Keycloak service identity is incomplete.');
  }
  const endpoint = `http://keycloak:8080/auth/realms/${encodeURIComponent(identity.realm)}/protocol/openid-connect/token`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials',
        client_id: identity.clientId, client_secret: identity.clientSecret }),
    });
  } catch {
    throw new ProvisioningError('KEYCLOAK_UNAVAILABLE', 'Keycloak service authentication was not completed.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProvisioningError('KEYCLOAK_AUTHENTICATION_FAILED', 'Keycloak rejected the provision service identity.');
  }
  const token = await readKeycloakJson(response, 32_768);
  if (typeof token?.access_token !== 'string' || !token.access_token) {
    throw new ProvisioningError('KEYCLOAK_AUTHENTICATION_FAILED', 'Keycloak returned no service access token.');
  }
  return token.access_token;
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT !== 'dev') {
    throw new ProvisioningError('ENVIRONMENT_UNSUPPORTED', 'Only the specified dev installation is supported.');
  }
  const mode = process.argv[2] ?? 'realm';
  if (!['realm', 'all'].includes(mode)) throw new ProvisioningError('MODE_UNSUPPORTED', 'Unsupported provisioning operation.');
  const identity = await readSecret('/run/helm/service-secrets.json', 'provision service KV');
  await unlink('/run/helm/service-secrets.json');
  const input = await readSecret('/run/secrets/predefined_users_input', 'predefined_users_input');
  validatePredefinedInput(input);
  if (identity.installationId !== input.installationId) {
    throw new ProvisioningError('INSTALLATION_MISMATCH', 'Bootstrap inputs refer to different installations.');
  }
  if (mode === 'all') {
    validateStorageInput(identity.minio, identity.installationId);
    const bootstrap = await readSecret('/run/secrets/provision_identity', 'provision_identity');
    await withMinioProvisionState(bootstrap,
      state => provisionMinio(identity.minio, identity.installationId, state));
  }
  const accessToken = await keycloakAccessToken(identity.keycloak);
  const client = new KeycloakClient('http://keycloak:8080/auth', accessToken);
  await provisionRealm(client, {
    installationId: identity.installationId,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    webClientSecret: identity.webClientSecret,
    apiClientSecret: identity.apiClientSecret,
    mcpRedirectUris: identity.mcpRedirectUris,
  });
  const accounts = await provisionPredefinedUsers(client, input);
  process.stdout.write(`${JSON.stringify({ operation: 'realm-provision', status: 'completed',
    accounts: accounts.map(({ username, status }) => ({ username, status })) })}\n`);
}

main().catch((error) => {
  // Upstream errors can contain credentials or user input. Never print raw errors or stacks.
  const code = error instanceof ProvisioningError ? error.code : 'PROVISION_FAILED';
  const message = error instanceof ProvisioningError ? error.message : 'Provisioning did not complete.';
  process.stderr.write(`${JSON.stringify({ operation: 'realm-provision', status: 'failed', code, message })}\n`);
  process.exitCode = 1;
});
