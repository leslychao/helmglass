import { lstat } from 'node:fs/promises';
import { run } from './process.mjs';

/** A bounded, TLS-verified backup AppRole session; always revoke before returning. */
export async function withVaultBackupSession({ containerId, localCaFile, identity,
  environment = process.env, timeout = 300_000 }, action) {
  const local = containerId === undefined;
  if ((!local && !/^[a-f0-9]{64}$/.test(containerId)) || (local && typeof localCaFile !== 'string')
      || (!local && localCaFile !== undefined) || identity?.schemaVersion !== 1
      || identity.vault?.address !== 'https://vault:8200'
      || ![identity.vault.roleId, identity.vault.secretId].every(value =>
        typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value))) {
    throw new Error('INVALID_VAULT_BACKUP_IDENTITY');
  }
  if (local) {
    const authority = await lstat(localCaFile);
    if (!authority.isFile() || authority.isSymbolicLink() || authority.size === 0 || authority.size > 65_536) {
      throw new Error('INVALID_VAULT_BACKUP_CA');
    }
  }
  const baseEnvironment = { ...environment, VAULT_TOKEN: '', VAULT_ADDR: 'https://vault:8200',
    VAULT_CACERT: local ? localCaFile : '/run/helm/ca.crt', VAULT_MAX_RETRIES: '0',
    VAULT_SKIP_VERIFY: 'false', VAULT_CLIENT_TIMEOUT: `${Math.ceil(timeout / 1000)}s` };
  delete baseEnvironment.DOCKER_CONTEXT;
  const executable = local ? 'vault' : 'docker';
  const prefix = local ? [] : ['exec', '-i', '-e', 'VAULT_TOKEN', '-e', 'VAULT_ADDR=https://vault:8200',
    '-e', 'VAULT_CACERT=/run/helm/ca.crt', '-e', 'VAULT_MAX_RETRIES=0', '-e', 'VAULT_SKIP_VERIFY=false',
    '-e', `VAULT_CLIENT_TIMEOUT=${Math.ceil(timeout / 1000)}s`, containerId, 'vault'];
  const login = await run(executable, [...prefix, 'write', '-format=json', 'auth/approle/login', '-'], {
    environment: baseEnvironment, input: JSON.stringify({ role_id: identity.vault.roleId,
      secret_id: identity.vault.secretId }), timeout: 30_000, maximum: 65_536,
  });
  const token = JSON.parse(login.stdout)?.auth?.client_token;
  if (typeof token !== 'string' || !token || /[\0\r\n]/.test(token)) {
    throw new Error('VAULT_BACKUP_IDENTITY_NOT_CONFIRMED');
  }
  const authenticated = { ...baseEnvironment, VAULT_TOKEN: token };
  try { return await action({ executable, prefix, environment: authenticated, local }); }
  finally {
    try {
      await run(executable, [...prefix, 'write', 'auth/token/revoke-self', '-'], {
        environment: authenticated, input: '{}', timeout: 30_000, maximum: 65_536,
      });
    } finally { delete authenticated.VAULT_TOKEN; }
  }
}
