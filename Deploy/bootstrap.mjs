import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_FILES } from './configuration.mjs';
import { isInside, protectDirectory, readProtectedFile, writeProtectedFile } from './protected-files.mjs';
import { createAuthority, createIdentity, readTlsBundle, validateBackupRecipient, validateInternalIdentity } from './tls.mjs';
import { VAULT_ROLES } from './provision/src/vault-services.mjs';
import { validatePredefinedInput } from './provision/src/predefined-users.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const secret = () => randomBytes(32).toString('base64url');

function profiles(configuration, environment) {
  const input = { installationId: configuration.INSTALLATION_ID };
  for (const username of ['admin', 'angelina']) {
    const prefix = `KEYCLOAK_${username.toUpperCase()}_`;
    input[username] = { email: configuration[`${prefix}EMAIL`], lastName: configuration[`${prefix}LAST_NAME`],
      password: environment[`${prefix}PASSWORD`] };
  }
  validatePredefinedInput(input);
  return input;
}

function binding(configuration) {
  return { schemaVersion: 1, installationId: configuration.INSTALLATION_ID,
    publicOrigin: configuration.PUBLIC_ORIGIN, turnRealm: configuration.TURN_REALM };
}

/** Generates installation credentials once; restart never rotates or repairs a revoked identity. */
export async function prepareBootstrap(configuration, environment = process.env) {
  const directory = resolve(configuration.LOCAL_SECRETS_DIR);
  const recovery = resolve(configuration.LOCAL_RECOVERY_DIR);
  if (isInside(directory, recovery) || isInside(recovery, directory) || isInside(repository, recovery)) {
    throw new Error('Recovery custody must be outside the repository and separate from service bootstrap');
  }
  const users = profiles(configuration, environment);
  let entries = [];
  try { entries = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (entries.length) {
    await protectDirectory(directory, repository);
    const recorded = JSON.parse((await readProtectedFile(join(directory, 'installation.json'))).toString());
    if (JSON.stringify(recorded) !== JSON.stringify(binding(configuration))) {
      throw new Error('Existing bootstrap belongs to a different installation or origin; use an explicit certificate rotation');
    }
    for (const file of [...BOOTSTRAP_FILES, 'backup-bootstrap', 'vault-services-input',
      'installation-ca.crt', 'installation-ca.key']) {
      await readProtectedFile(join(directory, file));
    }
    await readTlsBundle(join(directory, 'edge-tls'), new URL(configuration.PUBLIC_ORIGIN).hostname);
    validateBackupRecipient((await readProtectedFile(join(directory, 'backup-recipient'))).toString('utf8'));
    for (const [name, file] of Object.entries({ api: 'api-bootstrap', vault: 'vault-tls',
      minio: 'minio-bootstrap', 'mcp-adapter': 'mcp-adapter-bootstrap' })) {
      const installed = JSON.parse((await readProtectedFile(join(directory, file))).toString());
      validateInternalIdentity(installed.tls, name, name === 'mcp-adapter');
    }
    return { directory, created: false };
  }
  // Validate every operator-supplied value before creating installation credentials.
  const edge = await readTlsBundle(configuration.EDGE_TLS_FILE, new URL(configuration.PUBLIC_ORIGIN).hostname);
  const turn = await readTlsBundle(configuration.TURN_TLS_FILE, configuration.TURN_REALM);
  if (!turn.caPem.includes('BEGIN CERTIFICATE')) throw new Error('TURN TLS bundle must include its CA chain');
  const backupRecipient = validateBackupRecipient(
    (await readProtectedFile(configuration.BACKUP_RECIPIENT_FILE, 65_536)).toString('utf8'));
  await protectDirectory(directory, repository);
  const caPem = await createAuthority(directory);
  const identities = {};
  for (const name of ['vault', 'api', 'minio', 'mcp-adapter']) {
    identities[name] = await createIdentity(directory, name, caPem, { client: name === 'mcp-adapter' });
  }
  const credentials = Object.fromEntries(VAULT_ROLES.map(service => [service, { roleId: secret(), secretId: secret() }]));
  const postgres = { schemaVersion: 1, rootPassword: secret(), migrationPassword: secret(), apiPassword: secret(), keycloakPassword: secret() };
  const redis = { health: secret(), api: secret(), oauth: secret() };
  const bootstrapClientSecret = secret();
  const webClientSecret = secret();
  const apiClientSecret = secret();
  const enrollmentToken = secret();
  const turnSharedSecret = secret();
  const mediaProxyUsername = 'helm-media';
  const mediaProxyPassword = secret();
  const minio = { rootUser: 'helm-storage-root', rootPassword: secret(),
    apiAccessKey: secret(), apiSecretKey: secret(), caPem };
  const services = {
    api: { databaseUrl: 'jdbc:postgresql://postgres:5432/helm', databaseUsername: 'helm_api', databasePassword: postgres.apiPassword,
      redisUsername: 'helm_api', redisPassword: redis.api, s3AccessKey: minio.apiAccessKey, s3SecretKey: minio.apiSecretKey,
      keycloakClientId: 'helm-api-service', keycloakClientSecret: apiClientSecret, turnSharedSecret, mediaProxyUsername, mediaProxyPassword,
      installationId: configuration.INSTALLATION_ID, workerEnrollmentToken: enrollmentToken },
    migration: { databaseUrl: 'jdbc:postgresql://postgres:5432/helm', databaseUsername: 'helm_migration', databasePassword: postgres.migrationPassword },
    keycloak: { databaseUrl: 'jdbc:postgresql://postgres:5432/keycloak', databaseUsername: 'keycloak', databasePassword: postgres.keycloakPassword,
      bootstrapClientId: 'helm-bootstrap', bootstrapClientSecret },
    'oauth2-proxy': { clientId: 'helm-web', clientSecret: webClientSecret, cookieSecret: secret(), redisUsername: 'helm_oauth', redisPassword: redis.oauth },
    provision: { installationId: configuration.INSTALLATION_ID, keycloak: { realm: 'master', clientId: 'helm-bootstrap', clientSecret: bootstrapClientSecret },
      webClientSecret, apiClientSecret, mcpRedirectUris: configuration.MCP_REDIRECT_URIS.split(','), minio },
    coturn: { turnSharedSecret },
    'egress-proxy': { mediaProxyUsername, mediaProxyPassword },
  };
  const files = {
    'edge-tls': edge.pem,
    'vault-tls': { schemaVersion: 1, tls: identities.vault },
    'mcp-adapter-bootstrap': { schemaVersion: 1, tls: identities['mcp-adapter'] },
    'postgres-bootstrap': postgres,
    'redis-health-bootstrap': { schemaVersion: 1, username: 'helm_health', password: redis.health },
    'minio-bootstrap': { schemaVersion: 1, rootUser: minio.rootUser, rootPassword: minio.rootPassword, tls: identities.minio },
    'backup-recipient': backupRecipient,
    'worker-bootstrap': { schemaVersion: 1, installationId: configuration.INSTALLATION_ID, enrollmentToken, caPem },
    'turn-bootstrap': { schemaVersion: 1, turnSharedSecret,
      tls: { certificatePem: turn.certificatePem, privateKeyPem: turn.privateKeyPem, caPem: turn.caPem } },
    'egress-bootstrap': { schemaVersion: 1, mediaProxyUsername, mediaProxyPassword },
    'predefined-users-input': users,
    'vault-services-input': { schemaVersion: 1, installationId: configuration.INSTALLATION_ID, caPem, services, credentials },
  };
  for (const [service, file] of Object.entries({ api: 'api-bootstrap', migration: 'migration-bootstrap',
    keycloak: 'keycloak-bootstrap', 'oauth2-proxy': 'oauth-bootstrap', provision: 'provision-bootstrap',
    backup: 'backup-bootstrap' })) {
    files[file] = { schemaVersion: 1, vault: { address: 'https://vault:8200', caPem, ...credentials[service] },
      ...(service === 'api' ? { tls: identities.api } : {}) };
  }
  let acl = await readFile(new URL('./redis/users.acl.template', import.meta.url), 'utf8');
  for (const [service, password] of Object.entries(redis)) {
    acl = acl.replace(`${service.toUpperCase()}_PASSWORD_SHA256`, createHash('sha256').update(password).digest('hex'));
  }
  files['redis-bootstrap.acl'] = acl;
  for (const [name, value] of Object.entries(files)) await writeProtectedFile(join(directory, name), value);
  await writeProtectedFile(join(directory, 'installation.json'), binding(configuration));
  return { directory, created: true };
}
