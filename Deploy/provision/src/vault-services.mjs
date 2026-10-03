import { X509Certificate } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ProvisioningError } from './keycloak-client.mjs';

export const VAULT_SERVICES = ['api', 'migration', 'keycloak', 'oauth2-proxy', 'provision', 'coturn', 'egress-proxy'];
export const VAULT_ROLES = [
  ...VAULT_SERVICES.filter((name) => !['coturn', 'egress-proxy'].includes(name)),
];

function fail(code, message) { throw new ProvisioningError(code, message); }

export function servicePolicy(service) {
  if (!VAULT_ROLES.includes(service)) fail('VAULT_SCOPE_INVALID', 'Unknown Vault service role.');
  const kv = `path "helm-kv/data/services/${service}" { capabilities = ["read"] }`;
  if (service === 'provision') {
    return `${kv}\npath "helm-kv/data/bootstrap/minio" { capabilities = ["create", "read", "update"] }`;
  }
  if (service !== 'api') return kv;
  return `${kv}
path "helm-transit/keys/profiles-*" {
  capabilities = ["create", "read", "update", "delete"]
  allowed_parameters = {
    "type" = ["aes256-gcm96"]
    "exportable" = [false]
    "allow_plaintext_backup" = [false]
    "derived" = [false]
    "convergent_encryption" = [false]
    "deletion_allowed" = [true]
  }
}
path "helm-transit/encrypt/profiles-*" { capabilities = ["update"] }
path "helm-transit/decrypt/profiles-*" { capabilities = ["update"] }
path "helm-transit/rewrap/profiles-*" { capabilities = ["update"] }
path "helm-pki/sign/browser-workers" { capabilities = ["update"] }
path "helm-pki/revoke" { capabilities = ["update"] }`;
}

function validate(input) {
  if (input?.schemaVersion !== 1 || !/^[A-Za-z0-9_-]{1,80}$/.test(input.installationId ?? '')) {
    fail('VAULT_INPUT_INVALID', 'Vault service input has no valid installation identity.');
  }
  if (!isDeepStrictEqual(Object.keys(input.services ?? {}).sort(), [...VAULT_SERVICES].sort())
      || !isDeepStrictEqual(Object.keys(input.credentials ?? {}).sort(), [...VAULT_ROLES].sort())) {
    fail('VAULT_INPUT_INVALID', 'Vault service input must contain the exact supported service scopes.');
  }
  for (const service of VAULT_SERVICES) {
    if (!input.services[service] || typeof input.services[service] !== 'object' || Array.isArray(input.services[service])) {
      fail('VAULT_INPUT_INVALID', `Service ${service} has invalid KV input.`);
    }
  }
  for (const service of VAULT_ROLES) {
    const credential = input.credentials[service];
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(credential?.roleId ?? '')
        || !/^[A-Za-z0-9_-]{32,128}$/.test(credential?.secretId ?? '')) {
      fail('VAULT_INPUT_INVALID', `Service ${service} has invalid AppRole bootstrap credentials.`);
    }
  }
}

function reconcileWrite(vault, path, body, read, matches) {
  try { vault.write(path, body); }
  catch (error) {
    // A lost write response is not a reason to perform the write a second time.
    if (matches(read())) return;
    throw error;
  }
  if (!matches(read())) fail('VAULT_VERIFY_FAILED', 'Vault did not confirm the requested configuration.');
}

function ensureKv(vault, path, value, mayCreate = true) {
  const current = vault.read(path, true);
  if (current) {
    if (!isDeepStrictEqual(current.data, value)) {
      fail('VAULT_SECRET_DRIFT', 'Stored service secrets differ from bootstrap input; use an explicit rotation operation.');
    }
    return;
  }
  if (!mayCreate) fail('VAULT_SECRET_REMOVED', 'A provisioned service secret was removed; restore or rotate it explicitly.');
  reconcileWrite(vault, path, { data: value, options: { cas: 0 } },
    () => vault.read(path, true), (observed) => isDeepStrictEqual(observed?.data, value));
}

function ensureMounts(vault, installationId) {
  const expected = [
    ['helm-kv', 'kv', { version: '2' }], ['helm-transit', 'transit', {}], ['helm-pki', 'pki', {}],
  ];
  const description = `helm-glass:${installationId}`;
  const existing = vault.read('sys/mounts');
  const authentication = vault.read('sys/auth');
  // Check every owner before making the first change, including the shared auth mount.
  for (const [name, type] of [...expected, ['approle', 'approle']]) {
    const mount = (name === 'approle' ? authentication : existing)?.[`${name}/`];
    if (mount && (mount.type !== type || mount.description !== description)) {
      fail('VAULT_OWNERSHIP_CONFLICT', `Vault mount ${name} is not owned by this installation.`);
    }
  }
  const initialized = existing['helm-kv/']
    ? vault.read('helm-kv/data/bootstrap/installation', true)?.data?.status === 'READY' : false;
  if (initialized && (expected.some(([name]) => !existing[`${name}/`]) || !authentication['approle/'])) {
    fail('VAULT_MOUNT_REMOVED', 'A provisioned secret engine was removed; restore its state explicitly.');
  }
  for (const [name, type, options] of expected) {
    if (!existing[`${name}/`]) {
      reconcileWrite(vault, `sys/mounts/${name}`, { type, description, options },
        () => vault.read('sys/mounts')?.[`${name}/`],
        (mount) => mount?.type === type && mount.description === description);
    }
  }
  if (!authentication['approle/']) {
    reconcileWrite(vault, 'sys/auth/approle', { type: 'approle', description },
      () => vault.read('sys/auth')?.['approle/'],
      (mount) => mount?.type === 'approle' && mount.description === description);
  }
  if (vault.read('sys/mounts')['helm-kv/'].options?.version !== '2') {
    fail('VAULT_CONFIGURATION_DRIFT', 'Helm service storage must use KV version 2.');
  }
}

function ensureAudit(vault) {
  const current = vault.read('sys/audit')?.['helm/'];
  if (!current) {
    reconcileWrite(vault, 'sys/audit/helm', {
      type: 'file', description: 'Helm redacted audit', options: { file_path: 'stdout', log_raw: 'false' },
    }, () => vault.read('sys/audit')?.['helm/'], (device) => device?.type === 'file');
  }
  const verified = vault.read('sys/audit')['helm/'];
  if (verified.type !== 'file' || verified.options.file_path !== 'stdout'
      || verified.options.log_raw === 'true') {
    fail('VAULT_AUDIT_UNSAFE', 'Vault audit must redact secrets and use the bounded runtime log sink.');
  }
}

function ensureRole(vault, input, service, complete) {
  const name = `helm-${service}`;
  const path = `auth/approle/role/${name}`;
  const policy = servicePolicy(service);
  const currentPolicy = vault.read(`sys/policies/acl/${name}`, true);
  if (currentPolicy && currentPolicy.policy !== policy) {
    fail('VAULT_POLICY_DRIFT', `Vault policy ${name} differs from the required service scope.`);
  }
  if (!currentPolicy) {
    if (complete) fail('VAULT_POLICY_REVOKED', `Previously provisioned policy ${name} is absent.`);
    vault.write(`sys/policies/acl/${name}`, { policy });
  }
  let role = vault.read(path, true);
  if (!role) {
    if (complete) fail('VAULT_ROLE_REVOKED', `Previously provisioned role ${name} is absent.`);
    vault.write(path, { bind_secret_id: true, token_policies: [name], token_ttl: 300,
      token_max_ttl: service === 'api' ? 1800 : 300, secret_id_ttl: 0, secret_id_num_uses: 0 });
    role = vault.read(path);
  }
  if (!role.bind_secret_id || role.token_no_default_policy
      || !isDeepStrictEqual(role.token_policies, [name]) || role.token_ttl !== 300
      || role.token_max_ttl !== (service === 'api' ? 1800 : 300)) {
    fail('VAULT_ROLE_DRIFT', `AppRole ${name} differs from its required scope or lifetime.`);
  }
  const credential = input.credentials[service];
  if (vault.read(`${path}/role-id`).role_id !== credential.roleId) {
    if (complete) fail('VAULT_CREDENTIAL_DRIFT', `AppRole identity ${name} changed.`);
    vault.write(`${path}/role-id`, { role_id: credential.roleId });
  }
  let secret;
  try { secret = vault.write(`${path}/secret-id/lookup`, { secret_id: credential.secretId }); }
  catch (error) { if (error.code !== 'VAULT_400') throw error; }
  if (!secret) {
    if (complete) fail('VAULT_CREDENTIAL_REVOKED', `AppRole bootstrap credential ${name} is unavailable.`);
    try {
      vault.write(`${path}/custom-secret-id`, { secret_id: credential.secretId,
        metadata: JSON.stringify({ installationId: input.installationId }), ttl: 0, num_uses: 0 });
    } catch (error) {
      if (!vault.write(`${path}/secret-id/lookup`, { secret_id: credential.secretId })) throw error;
    }
    secret = vault.write(`${path}/secret-id/lookup`, { secret_id: credential.secretId });
  }
  if (secret.metadata?.installationId !== input.installationId
      || secret.secret_id_num_uses !== 0 || secret.secret_id_ttl !== 0) {
    fail('VAULT_CREDENTIAL_SCOPE', `AppRole bootstrap credential ${name} has an unexpected scope.`);
  }
}

function workerPki(vault, input, complete) {
  const keyName = 'helm-workers';
  function workerKeyExists() {
    const keys = vault.list('helm-pki/keys');
    if (keys?.key_info) return Object.values(keys.key_info).some((key) => key.key_name === keyName);
    // `vault list -format=json` projects a keys-only array on some server/CLI combinations.
    const identifiers = keys?.keys ?? [];
    if (identifiers.length > 64) fail('WORKER_PKI_KEY_LIMIT', 'Worker key inventory exceeds the inspection limit.');
    return identifiers.some((id) => vault.read(`helm-pki/key/${id}`).key_name === keyName);
  }
  if (!workerKeyExists()) {
    if (complete) fail('WORKER_PKI_KEY_REVOKED', 'Previously provisioned worker key is absent.');
    try { vault.write('helm-pki/keys/generate/internal', { key_name: keyName, key_type: 'rsa', key_bits: 3072 }); }
    catch (error) { if (!workerKeyExists()) throw error; }
  }
  const issuers = vault.list('helm-pki/issuers');
  const issuer = issuers?.keys?.length ? vault.read('helm-pki/issuer/default') : undefined;
  if (!issuer) {
    if (complete) fail('WORKER_PKI_ISSUER_REVOKED', 'Previously provisioned worker issuer is absent.');
    if (!input.workerCertificateChainPem) {
      const generated = vault.write('helm-pki/intermediate/generate/existing', {
        key_ref: keyName, common_name: `Helm ${input.installationId} workers`, format: 'pem',
      });
      return { status: 'CERTIFICATE_REQUIRED', csrPem: generated.csr };
    }
    const imported = vault.write('helm-pki/intermediate/set-signed', { certificate: input.workerCertificateChainPem });
    if (!imported?.imported_issuers?.length) fail('WORKER_PKI_INVALID', 'Worker intermediate was not imported.');
  }
  const current = vault.read('helm-pki/issuer/default');
  const key = vault.read(`helm-pki/key/${keyName}`);
  if (current.key_id !== key.key_id || !current.ca_chain?.length || current.ca_chain.length < 2) {
    fail('WORKER_PKI_CHAIN_INVALID', 'Worker issuer must use its non-exportable Vault key and a bootstrap CA chain.');
  }
  const trusted = new X509Certificate(input.caPem);
  const root = new X509Certificate(current.ca_chain.at(-1));
  if (trusted.fingerprint256 !== root.fingerprint256) {
    fail('WORKER_PKI_CHAIN_INVALID', 'Worker issuer does not chain to the installation trust root.');
  }
  const definition = {
    allowed_domains: ['browser-worker-*'], allow_glob_domains: true, allow_bare_domains: true,
    allow_subdomains: false, allow_any_name: false, allow_localhost: false, allow_ip_sans: false,
    use_csr_common_name: false, use_csr_sans: false,
    allowed_uri_sans: [`urn:helm-glass:${input.installationId}:*`],
    server_flag: false, client_flag: true, key_type: 'rsa', key_bits: 3072,
    max_ttl: 900, ttl: 900,
  };
  const previous = vault.read('helm-pki/roles/browser-workers', true);
  if (previous && Object.entries(definition).some(([name, value]) => !isDeepStrictEqual(previous[name], value))) {
    fail('WORKER_PKI_ROLE_DRIFT', 'Worker issuance role differs from its permitted identity scope.');
  }
  if (!previous) {
    if (complete) fail('WORKER_PKI_ROLE_REVOKED', 'Previously provisioned worker issuance role is absent.');
    vault.write('helm-pki/roles/browser-workers', definition);
  }
  return { status: 'READY' };
}

export function provisionVaultServices(vault, input) {
  validate(input);
  ensureMounts(vault, input.installationId);
  ensureAudit(vault);
  const statePath = 'helm-kv/data/bootstrap/installation';
  let state = vault.read(statePath, true);
  if (state && state.data.installationId !== input.installationId) {
    fail('VAULT_OWNERSHIP_CONFLICT', 'Vault state belongs to a different installation.');
  }
  if (!state) {
    ensureKv(vault, statePath, { installationId: input.installationId, status: 'PENDING' });
    state = vault.read(statePath);
  }
  for (const service of VAULT_SERVICES) {
    ensureKv(vault, `helm-kv/data/services/${service}`, input.services[service], state.data.status !== 'READY');
  }
  for (const service of VAULT_ROLES) ensureRole(vault, input, service, state.data.status === 'READY');
  const result = workerPki(vault, input, state.data.status === 'READY');
  if (result.status === 'READY' && state.data.status !== 'READY') {
    vault.write(statePath, { options: { cas: state.metadata.version },
      data: { installationId: input.installationId, status: 'READY' } });
  }
  return result;
}
