import { lstat, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { ProvisioningError } from './keycloak-client.mjs';
import { VaultCli } from './vault-cli.mjs';
import { provisionVaultServices } from './vault-services.mjs';

async function operatorToken() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4096) throw new ProvisioningError('VAULT_OPERATOR_INPUT_INVALID', 'Operator token input exceeds its limit.');
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks).toString('utf8').trim();
  if (!token || /[\s\0]/.test(token)) {
    throw new ProvisioningError('VAULT_OPERATOR_INPUT_INVALID', 'A protected operator token is required on stdin.');
  }
  return token;
}

async function main() {
  const inputPath = '/run/secrets/vault_services_input';
  const metadata = await lstat(inputPath);
  if (!metadata.isFile() || metadata.size > 1_048_576) {
    throw new ProvisioningError('VAULT_INPUT_INVALID', 'Protected Vault service input is invalid.');
  }
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const token = await operatorToken();
  await mkdir('/run/helm', { recursive: true, mode: 0o700 });
  const caPath = '/run/helm/provision-ca.pem';
  await writeFile(caPath, input.caPem, { mode: 0o600, flag: 'wx' });
  try {
    const environment = { ...process.env, VAULT_TOKEN: token, VAULT_ADDR: 'https://vault:8200', VAULT_CACERT: caPath };
    for (const name of ['VAULT_SKIP_VERIFY', 'VAULT_NAMESPACE', 'VAULT_CLIENT_CERT', 'VAULT_CLIENT_KEY']) delete environment[name];
    const result = provisionVaultServices(new VaultCli(environment), input);
    process.stdout.write(`${JSON.stringify({ operation: 'vault-services', ...result })}\n`);
  } finally {
    await unlink(caPath);
  }
}

main().catch((error) => {
  const code = error instanceof ProvisioningError ? error.code : 'VAULT_PROVISION_FAILED';
  const message = error instanceof ProvisioningError ? error.message : 'Vault service provisioning did not complete.';
  process.stderr.write(`${JSON.stringify({ operation: 'vault-services', status: 'failed', code, message })}\n`);
  process.exitCode = 1;
});
