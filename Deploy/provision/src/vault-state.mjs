import { writeFile, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { VaultCli } from './vault-cli.mjs';
import { ProvisioningError } from './keycloak-client.mjs';

/** Owns a short-lived scoped Vault session for the durable MinIO bootstrap receipt. */
export async function withMinioProvisionState(identity, action) {
  if (identity?.schemaVersion !== 1 || identity.vault?.address !== 'https://vault:8200'
      || typeof identity.vault.caPem !== 'string' || typeof identity.vault.roleId !== 'string'
      || typeof identity.vault.secretId !== 'string') {
    throw new ProvisioningError('VAULT_IDENTITY_INVALID', 'Provision identity does not name the installation Vault.');
  }
  const caPath = '/run/helm/state-ca.pem';
  await writeFile(caPath, identity.vault.caPem, { mode: 0o600, flag: 'wx' });
  const environment = { ...process.env, VAULT_ADDR: identity.vault.address, VAULT_CACERT: caPath };
  for (const name of ['VAULT_TOKEN', 'VAULT_SKIP_VERIFY', 'VAULT_NAMESPACE', 'VAULT_CLIENT_CERT', 'VAULT_CLIENT_KEY']) delete environment[name];
  const client = new VaultCli(environment);
  let authenticated = false;
  try {
    const session = client.execute(['write', '-format=json', 'auth/approle/login', '-'], {
      role_id: identity.vault.roleId, secret_id: identity.vault.secretId,
    });
    if (typeof session?.auth?.client_token !== 'string') {
      throw new ProvisioningError('VAULT_AUTHENTICATION_FAILED', 'Vault did not authorize the provision identity.');
    }
    environment.VAULT_TOKEN = session.auth.client_token;
    authenticated = true;
    const path = 'helm-kv/data/bootstrap/minio';
    const state = {
      read() {
        const current = client.read(path, true);
        return current ? { value: current.data, version: current.metadata.version } : { value: null, version: 0 };
      },
      compareAndSet(value, version) {
        try { client.write(path, { options: { cas: version }, data: value }); }
        catch (error) {
          const reconciled = state.read();
          if (reconciled.version === version + 1 && isDeepStrictEqual(reconciled.value, value)) return reconciled;
          throw error;
        }
        const observed = state.read();
        if (observed.version !== version + 1 || !isDeepStrictEqual(observed.value, value)) {
          throw new ProvisioningError('VAULT_STATE_CONFLICT', 'MinIO bootstrap state changed concurrently.');
        }
        return observed;
      },
    };
    return await action(state);
  } finally {
    try {
      if (authenticated) client.write('auth/token/revoke-self', {});
    } finally {
      delete environment.VAULT_TOKEN;
      await unlink(caPath);
    }
  }
}
