import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { prepareBootstrap } from './bootstrap.mjs';
import { readOperatorInputs } from './operator-inputs.mjs';
import { BOOTSTRAP_FILES, ConfigurationError, readEnvironmentFile, validateDeployment, validateRelease } from './configuration.mjs';
import { decryptRecovery, encryptRecovery, secretInput } from './custody.mjs';
import { isInside, protectDirectory, readProtectedFile, replaceProtectedFile, writeProtectedFile } from './protected-files.mjs';
import { run } from './process.mjs';
import { signWorkerAuthority } from './tls.mjs';
import { acquireMaintenance, deploymentContainers } from './maintenance.mjs';
import { ProvisioningError } from './provision/src/keycloak-client.mjs';
import { VaultCli } from './provision/src/vault-cli.mjs';
import { provisionVaultServices } from './provision/src/vault-services.mjs';
import { deployWorkerRelease } from './worker-release.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let phase = 'configuration';
let maintenance;
function progress(value) { phase = value; process.stdout.write(`Helm Glass: ${value}\n`); }

async function optionalJson(path) {
  try { return JSON.parse((await readProtectedFile(path)).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== 'dev') {
    throw new ConfigurationError('ENVIRONMENT', 'invoke Deploy/up.sh dev or Deploy/up.ps1 dev');
  }
  const configuration = validateDeployment(await readEnvironmentFile(new URL('./.env.dev', import.meta.url)));
  const release = validateRelease(await readEnvironmentFile(new URL('./release.env', import.meta.url)));
  const operatorInputs = await readOperatorInputs(configuration);
  const environment = { ...process.env, ...configuration, ...release, COMPOSE_PROJECT_NAME: 'helm-glass' };
  if (await optionalJson(join(configuration.LOCAL_SECRETS_DIR, 'recovery-state.json'))) {
    throw new ConfigurationError('INSTALLATION_UPGRADE',
      'retire the legacy restore marker only after verifying the selected persistent storage; see the deployment specification');
  }
  for (const name of ['DOCKER_CONTEXT', 'COMPOSE_PROFILES', 'COMPOSE_FILE']) delete environment[name];
  delete environment.VAULT_TOKEN;
  const docker = (arguments_, options = {}) => run('docker', arguments_, { environment, cwd: repository, ...options });
  const composeArguments = ['compose', '--env-file', 'Deploy/release.env', '--env-file', 'Deploy/.env.dev', '-f', 'Deploy/compose.yaml'];
  const compose = (arguments_, options) => docker([...composeArguments, ...arguments_], options);
  const identifiers = service => deploymentContainers(docker, service);
  const inspect = async id => JSON.parse((await docker(['inspect', id])).stdout)[0];
  const single = async service => {
    const ids = await identifiers(service);
    if (ids.length !== 1) throw new Error(`Expected exactly one ${service} container`);
    return ids[0];
  };
  const healthy = async (service, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ids = await identifiers(service);
      if (ids.length) {
        const states = await Promise.all(ids.map(inspect));
        if (states.every(item => item.State.Running && item.State.Health?.Status === 'healthy')) return;
        if (states.some(item => !item.State.Running)) throw new Error(`${service} did not remain running`);
      }
      await delay(1000);
    }
    throw new Error(`${service} did not become healthy within its startup deadline`);
  };

  progress('checking the selected Docker daemon and release');
  const daemon = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  if (daemon.OSType !== 'linux') throw new ConfigurationError('DOCKER_HOST', 'requires a Linux Docker engine');
  const imageIds = new Map();
  for (const reference of Object.values(release)) {
    imageIds.set(reference, JSON.parse((await docker(['image', 'inspect', reference])).stdout)[0].Id);
  }
  maintenance = await acquireMaintenance({ docker, image: release.PROVISION_IMAGE,
    installationId: configuration.INSTALLATION_ID });
  progress('validating operator inputs and preparing protected installation files');
  const { directory } = await prepareBootstrap(configuration, operatorInputs);
  const delivery = [];
  for (const name of BOOTSTRAP_FILES) {
    const bytes = await readProtectedFile(join(directory, name));
    delivery.push({ name, content: bytes.toString('base64'), sha256: digest(bytes) });
  }
  progress('delivering and verifying files at the daemon-side secret path');
  await docker(['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '128m',
    '--log-driver', 'none', '--volume', `${configuration.SECRETS_DIR}:/bootstrap`,
    '--entrypoint', 'node', release.PROVISION_IMAGE, '/opt/helm/provision/src/host-files.mjs'], {
    input: JSON.stringify({ schemaVersion: 1, installationId: configuration.INSTALLATION_ID, mode: 'stage', files: delivery }),
  });
  await compose(['config', '--quiet']);
  const redisContainers = await identifiers('redis');
  if (redisContainers.length > 1) throw new Error('Expected at most one Redis container');
  if (redisContainers.length) {
    const redisState = await inspect(redisContainers[0]);
    const expectedAcl = delivery.find(file => file.name === 'redis-bootstrap.acl').sha256;
    const installedAcl = redisState.State.Running
      ? (await docker(['exec', redisContainers[0], 'sha256sum', '/run/helm/users.acl'])).stdout.split(/\s/)[0]
      : undefined;
    if (installedAcl !== expectedAcl) {
      progress('reloading Redis with its verified bootstrap policy and existing data volume');
      await compose(['up', '-d', '--no-deps', '--force-recreate', '--timeout', '0', 'redis']);
    }
  }
  progress('starting PostgreSQL, Redis, MinIO and sealed Vault');
  await compose(['up', '-d', '--no-deps', '--timeout', '0', 'postgres', 'redis', 'minio', 'vault']);
  const vaultId = await single('vault');
  const vaultArguments = ['exec', '-i', '-e', 'VAULT_TOKEN', '-e', 'VAULT_ADDR=https://vault:8200',
    '-e', 'VAULT_CACERT=/run/helm/ca.crt', '-e', 'VAULT_MAX_RETRIES=0', vaultId, 'vault'];
  const vault = async (arguments_, input, token) => docker([...vaultArguments, ...arguments_], {
    input: input === undefined ? undefined : JSON.stringify(input),
    environment: { ...environment, ...(token ? { VAULT_TOKEN: token } : { VAULT_TOKEN: '' }) },
  });
  const status = async () => {
    const result = await docker([...vaultArguments, 'status', '-format=json'], { allowedExitCodes: [0, 2] });
    return JSON.parse(result.stdout);
  };
  let state;
  const vaultDeadline = Date.now() + 60_000;
  while (Date.now() < vaultDeadline) {
    try { state = await status(); break; } catch { await delay(500); }
  }
  if (!state) throw new Error('Vault TLS listener did not become available');
  const receiptPath = join(directory, 'vault-ready.json');
  let receipt = await optionalJson(receiptPath);
  if (receipt && (receipt.schemaVersion !== 1 || typeof receipt.clusterId !== 'string'
      || !['REVOKE_PENDING', 'READY'].includes(receipt.status))) throw new Error('Invalid Vault installation receipt');
  const custodyPath = join(configuration.LOCAL_RECOVERY_DIR, `${configuration.INSTALLATION_ID}-vault.json`);
  let custodyPassword;
  let recovery;
  const openCustody = async () => {
    custodyPassword ??= await secretInput('VAULT_CUSTODY_PASSWORD', 'Offline Vault recovery password (hidden)', operatorInputs);
    const sealed = await optionalJson(custodyPath);
    if (!sealed) throw new Error('Offline recovery custody is missing');
    recovery = await decryptRecovery(configuration.INSTALLATION_ID, sealed, custodyPassword);
    if (recovery.clusterId && state.cluster_id && recovery.clusterId !== state.cluster_id) throw new Error('Vault recovery belongs to a different cluster');
    return recovery;
  };
  if (!state.initialized) {
    if (receipt || await optionalJson(custodyPath)) throw new Error('Vault data is missing; startup cannot initialize over an existing installation');
    progress('initializing Vault with encrypted operator custody outside service bootstrap');
    custodyPassword = await secretInput('VAULT_CUSTODY_PASSWORD', 'Choose an offline recovery password of at least 16 characters (hidden)', operatorInputs);
    // Validate custody before creating a seal whose shares cannot be recovered later.
    await encryptRecovery(configuration.INSTALLATION_ID, {}, custodyPassword);
    const recoveryDirectory = await protectDirectory(configuration.LOCAL_RECOVERY_DIR, repository);
    const bootstrapDirectory = await realpath(directory);
    if (isInside(bootstrapDirectory, recoveryDirectory) || isInside(recoveryDirectory, bootstrapDirectory)) {
      throw new Error('Recovery custody must be separate from bootstrap files');
    }
    const initialized = JSON.parse((await vault(['operator', 'init', '-format=json', '-key-shares=3', '-key-threshold=2'])).stdout);
    if (!Array.isArray(initialized.unseal_keys_b64) || initialized.unseal_keys_b64.length !== 3 || !initialized.root_token) {
      throw new Error('Vault initialization result is unconfirmed; do not initialize again');
    }
    recovery = { schemaVersion: 1, threshold: 2, shares: initialized.unseal_keys_b64, operatorToken: initialized.root_token };
    await writeProtectedFile(custodyPath, await encryptRecovery(configuration.INSTALLATION_ID, recovery, custodyPassword));
    for (const key of recovery.shares.slice(0, 2)) await vault(['write', '-format=json', 'sys/unseal', '-'], { key });
    state = await status();
  } else if (state.sealed) {
    progress('waiting for the operator to unlock Vault; recovery shares are not delivered to Docker');
    await openCustody();
    if (recovery.threshold !== 2 || recovery.shares?.length !== 3) throw new Error('Invalid Vault recovery quorum');
    for (const key of recovery.shares.slice(0, 2)) await vault(['write', '-format=json', 'sys/unseal', '-'], { key });
    state = await status();
  }
  if (state.sealed || !state.cluster_id || (receipt && receipt.clusterId !== state.cluster_id)) {
    throw new Error('Vault identity or unseal state does not match this installation');
  }
  if (!receipt || receipt.status !== 'READY') {
    progress('provisioning scoped Vault credentials and the worker certificate authority');
    recovery ??= await openCustody();
    const token = recovery.operatorToken;
    if (!token && !(receipt?.status === 'REVOKE_PENDING' && recovery.rootRevoked === true
        && recovery.clusterId === state.cluster_id)) {
      throw new Error('Interrupted Vault provisioning requires an authorized operator token');
    }
    const client = new VaultCli({ ...environment, VAULT_TOKEN: token }, 'docker', vaultArguments);
    if (!receipt) {
      const manifestPath = join(directory, 'vault-services-input');
      const manifestBytes = await readProtectedFile(manifestPath);
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      let result = provisionVaultServices(client, manifest);
      if (result.status === 'CERTIFICATE_REQUIRED') {
        manifest.workerCertificateChainPem = await signWorkerAuthority(directory, result.csrPem);
        await replaceProtectedFile(manifestPath, manifest, digest(manifestBytes));
        result = provisionVaultServices(client, manifest);
      }
      if (result.status !== 'READY') throw new Error('Vault service configuration was not confirmed');
      receipt = { schemaVersion: 1, clusterId: state.cluster_id, status: 'REVOKE_PENDING' };
      await writeProtectedFile(receiptPath, receipt);
    }
    if (token) {
      try { client.write('auth/token/revoke-self', {}); }
      catch (error) {
        // A lost revoke response is resolved by rejection of the same token, never by creating another root token.
        try { client.read('auth/token/lookup-self'); throw error; }
        catch (observed) { if (observed.code !== 'VAULT_403') throw observed; }
      }
    }
    delete recovery.operatorToken;
    recovery.rootRevoked = true;
    recovery.clusterId = state.cluster_id;
    const custodyBytes = await readProtectedFile(custodyPath);
    await replaceProtectedFile(custodyPath, await encryptRecovery(configuration.INSTALLATION_ID, recovery, custodyPassword), digest(custodyBytes));
    const previous = await readProtectedFile(receiptPath);
    await replaceProtectedFile(receiptPath, { ...receipt, status: 'READY' }, digest(previous));
  }
  recovery = undefined;
  custodyPassword = undefined;
  progress('checking persistent services and starting Keycloak');
  await Promise.all(['postgres', 'redis', 'minio', 'vault'].map(service => healthy(service)));
  await compose(['up', '-d', '--no-deps', '--timeout', '0', 'keycloak']);
  await healthy('keycloak', 180_000);
  for (const service of ['provision', 'migrate']) {
    progress(`running ${service} for this configuration and release`);
    await compose(['up', '--no-deps', '--force-recreate', '--timeout', '0', '--abort-on-container-exit', '--exit-code-from', service, service], { timeout: 300_000 });
    const completed = await inspect(await single(service));
    if (completed.State.Running || completed.State.ExitCode !== 0) throw new Error(`${service} did not complete successfully`);
  }
  progress('starting the API, OAuth proxy, MCP adapter and browser workers');
  await compose(['up', '-d', '--no-deps', '--force-recreate', '--timeout', '0', 'api', 'oauth2-proxy', 'coturn']);
  await Promise.all(['api', 'oauth2-proxy', 'coturn'].map(service => healthy(service)));
  await compose(['up', '-d', '--no-deps', '--force-recreate', '--timeout', '0', 'mcp-adapter', 'egress-proxy']);
  await Promise.all(['mcp-adapter', 'egress-proxy'].map(service => healthy(service)));
  progress('killing browser workers, retiring their enrollments and starting the selected pool');
  await deployWorkerRelease({ docker, compose, identifiers: () => identifiers('browser-worker'),
    imageId: imageIds.get(release.WORKER_IMAGE), count: Number(configuration.WORKER_COUNT) });
  await healthy('browser-worker');
  await compose(['up', '-d', '--no-deps', '--force-recreate', '--timeout', '0', 'nginx']);
  await healthy('nginx');
  process.stdout.write(`Helm Glass services are ready at ${configuration.PUBLIC_ORIGIN}. Browser and external-host acceptance must be verified separately.\n`);
}

main().finally(async () => { await maintenance?.release(); }).catch(error => {
  const detail = error instanceof ConfigurationError || error instanceof ProvisioningError
    ? error.message : 'Inspect the protected inputs and component diagnostics; secret-bearing exception details are withheld.';
  process.stderr.write(`Helm Glass startup stopped during ${phase}. ${detail}\n`);
  process.exitCode = 1;
});
