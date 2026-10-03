import { spawnSync } from 'node:child_process';
import { ProvisioningError } from './keycloak-client.mjs';

/** Official CLI owns TLS, Vault authentication and request serialization. */
export class VaultCli {
  constructor(environment, executable = 'vault', prefix = []) {
    this.environment = environment;
    this.executable = executable;
    this.prefix = prefix;
  }

  execute(arguments_, input, { optional = false } = {}) {
    const result = spawnSync(this.executable, [...this.prefix, ...arguments_], {
      env: { ...this.environment, VAULT_MAX_RETRIES: '0', VAULT_CLIENT_TIMEOUT: '10s' },
      input: input === undefined ? undefined : JSON.stringify(input),
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1_048_576,
    });
    if (result.status !== 0) {
      if (optional && result.status === 2 && /^No value found at /m.test(result.stderr ?? '')) return undefined;
      if (optional && arguments_[0] === 'list' && result.status === 2
          && !result.stderr?.trim() && result.stdout?.trim() === '{}') return undefined;
      const code = /Code:\s*(\d{3})/.exec(result.stderr ?? '')?.[1] ?? 'UNKNOWN';
      throw new ProvisioningError(`VAULT_${code}`, 'Vault operation did not complete; reconcile its protected state before retrying.');
    }
    if (!result.stdout.trim()) return undefined;
    try { return JSON.parse(result.stdout); }
    catch { throw new ProvisioningError('VAULT_RESPONSE_INVALID', 'Vault returned an invalid structured response.'); }
  }

  read(path, optional = false) { return this.execute(['read', '-format=json', path], undefined, { optional })?.data; }
  list(path) {
    const result = this.execute(['list', '-format=json', path], undefined, { optional: true });
    return Array.isArray(result) ? { keys: result } : result?.data ?? result;
  }
  write(path, value) { return this.execute(['write', '-format=json', path, '-'], value)?.data; }
}
