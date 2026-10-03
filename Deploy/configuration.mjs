import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';

const INPUT_NAMES = [
  'DOCKER_HOST', 'INSTALLATION_ID', 'PUBLIC_ORIGIN',
  'TRUSTED_EDGE_PROXY', 'WORKER_COUNT', 'GPU_DEVICE_ID', 'LOCAL_SECRETS_DIR', 'SECRETS_DIR',
  'TURN_INTERNAL_URL', 'TURN_PUBLIC_URLS', 'TURN_REALM',
  'TURN_RELAY_MIN', 'TURN_RELAY_MAX', 'KEYCLOAK_ADMIN_EMAIL', 'KEYCLOAK_ADMIN_LAST_NAME',
  'KEYCLOAK_ANGELINA_EMAIL', 'KEYCLOAK_ANGELINA_LAST_NAME', 'MCP_REDIRECT_URIS',
  'LOCAL_RECOVERY_DIR', 'DELETION_LEDGER_DIR',
  'BACKUP_DIR', 'BACKUP_WORK_DIR', 'BACKUP_RECIPIENT_FILE',
  'MINIO_DATA_DIR', 'OPERATOR_INPUT_FILE',
];
export const IMAGE_NAMES = [
  'NGINX_IMAGE', 'API_IMAGE', 'MCP_ADAPTER_IMAGE', 'WORKER_IMAGE', 'EGRESS_IMAGE',
  'TURN_IMAGE', 'POSTGRES_IMAGE', 'REDIS_IMAGE', 'MINIO_IMAGE', 'VAULT_IMAGE',
  'KEYCLOAK_IMAGE', 'PROVISION_IMAGE', 'OAUTH_IMAGE',
];
export const BOOTSTRAP_FILES = [
  'api-bootstrap', 'worker-bootstrap', 'turn-bootstrap', 'egress-bootstrap',
  'postgres-bootstrap', 'redis-bootstrap.acl', 'redis-health-bootstrap', 'minio-bootstrap',
  'mcp-adapter-bootstrap', 'vault-tls', 'provision-bootstrap', 'migration-bootstrap',
  'keycloak-bootstrap', 'oauth-bootstrap', 'predefined-users-input',
  'backup-recipient',
];

export class ConfigurationError extends Error {
  constructor(parameter, explanation) {
    super(`${parameter}: ${explanation}`);
    this.name = 'ConfigurationError';
    this.parameter = parameter;
  }
}

function requireValue(input, name) {
  const value = input[name];
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new ConfigurationError(name, 'required non-empty single-line value is missing or invalid');
  }
  return value;
}

function integer(input, name, minimum, maximum) {
  const value = requireValue(input, name);
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ConfigurationError(name, `must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function origin(input, name) {
  const value = requireValue(input, name);
  let parsed;
  try { parsed = new URL(value); } catch { throw new ConfigurationError(name, 'must be an HTTPS origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ConfigurationError(name, 'must be an HTTPS origin without credentials, path, query or fragment');
  }
  return parsed;
}

export function validateDeployment(input) {
  for (const name of Object.keys(input)) {
    if (!INPUT_NAMES.includes(name)) {
      throw new ConfigurationError(name, 'not a deployment parameter; secrets and release pins belong outside this file');
    }
  }
  const configuration = {};
  for (const name of INPUT_NAMES) {
    if (name === 'OPERATOR_INPUT_FILE' && (input[name] === undefined || input[name] === '')) {
      configuration[name] = '';
    } else {
      configuration[name] = requireValue(input, name);
    }
  }
  if (configuration.OPERATOR_INPUT_FILE && !isAbsolute(configuration.OPERATOR_INPUT_FILE)) {
    throw new ConfigurationError('OPERATOR_INPUT_FILE', 'must be an absolute operator-workstation file path');
  }
  if (!/^(tcp:\/\/[^\s/?#@]+:\d+|unix:\/\/\/.+|npipe:\/\/.+)$/.test(configuration.DOCKER_HOST)) {
    throw new ConfigurationError('DOCKER_HOST', 'must identify the intended Docker daemon');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(configuration.INSTALLATION_ID)) {
    throw new ConfigurationError('INSTALLATION_ID', 'must be a stable installation identifier');
  }
  origin(configuration, 'PUBLIC_ORIGIN');
  if (!/^(?:[0-9]+|GPU-[a-fA-F0-9-]+)$/.test(configuration.GPU_DEVICE_ID)) {
    throw new ConfigurationError('GPU_DEVICE_ID', 'must identify one NVIDIA device by index or GPU UUID');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/.test(configuration.TURN_REALM)) {
    throw new ConfigurationError('TURN_REALM', 'must be the configured TURN authentication realm');
  }
  if (configuration.TRUSTED_EDGE_PROXY) {
    const [address, prefix, extra] = configuration.TRUSTED_EDGE_PROXY.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || (prefix !== undefined
        && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new ConfigurationError('TRUSTED_EDGE_PROXY', 'must be one explicit IP address or CIDR');
    }
    if (Number(prefix) === 0) throw new ConfigurationError('TRUSTED_EDGE_PROXY', 'must not trust the whole internet');
  }
  integer(configuration, 'WORKER_COUNT', 1, 64);
  const relayMinimum = integer(configuration, 'TURN_RELAY_MIN', 1024, 65535);
  const relayMaximum = integer(configuration, 'TURN_RELAY_MAX', relayMinimum, 65535);
  if (relayMaximum - relayMinimum > 1023) {
    throw new ConfigurationError('TURN_RELAY_MAX', 'relay range must contain at most 1024 ports');
  }
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(configuration.SECRETS_DIR)
      || configuration.SECRETS_DIR.includes('//')
      || configuration.SECRETS_DIR.split('/').filter(Boolean).length < 3) {
    throw new ConfigurationError('SECRETS_DIR', 'must be a dedicated absolute daemon-side directory');
  }
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(configuration.DELETION_LEDGER_DIR)
      || configuration.DELETION_LEDGER_DIR.includes('//')
      || configuration.DELETION_LEDGER_DIR.split('/').filter(Boolean).length < 3
      || configuration.DELETION_LEDGER_DIR === configuration.SECRETS_DIR
      || configuration.DELETION_LEDGER_DIR.startsWith(`${configuration.SECRETS_DIR}/`)) {
    throw new ConfigurationError('DELETION_LEDGER_DIR',
      'must be a separate existing protected directory for immutable deletion records');
  }
  const mounts = ['BACKUP_DIR', 'BACKUP_WORK_DIR', 'DELETION_LEDGER_DIR',
    'MINIO_DATA_DIR'];
  for (const name of mounts) {
    const path = configuration[name];
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes('//') || path.endsWith('/')
        || path.split('/').filter(Boolean).length < 3) {
      throw new ConfigurationError(name, 'must be a dedicated existing absolute daemon-side mount');
    }
    for (const other of [...mounts.filter(value => value !== name), 'SECRETS_DIR']) {
      if (path === configuration[other] || path.startsWith(`${configuration[other]}/`)
          || configuration[other].startsWith(`${path}/`)) {
        throw new ConfigurationError(name, 'storage, backup, scratch, ledger and secret paths must not overlap');
      }
    }
  }
  if (configuration.TURN_INTERNAL_URL !== 'turn:coturn:3478?transport=tcp') {
    throw new ConfigurationError('TURN_INTERNAL_URL', 'must identify the private coturn TCP listener');
  }
  for (const value of configuration.TURN_PUBLIC_URLS.split(',')) {
    if (!/^turns?:[A-Za-z0-9.\[\]:-]+:\d+\?transport=(?:tcp|udp)$/.test(value)) {
      throw new ConfigurationError('TURN_PUBLIC_URLS', 'must contain explicit TURN URLs without credentials');
    }
  }
  for (const name of ['KEYCLOAK_ADMIN_EMAIL', 'KEYCLOAK_ANGELINA_EMAIL']) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configuration[name])) {
      throw new ConfigurationError(name, 'must be a confirmed valid email address');
    }
  }
  if (configuration.KEYCLOAK_ADMIN_EMAIL.toLowerCase() === configuration.KEYCLOAK_ANGELINA_EMAIL.toLowerCase()) {
    throw new ConfigurationError('KEYCLOAK_ANGELINA_EMAIL', 'must differ from the administrator email');
  }
  for (const value of configuration.MCP_REDIRECT_URIS.split(',')) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new ConfigurationError('MCP_REDIRECT_URIS', 'contains an invalid URI'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || value.includes('*')) {
      throw new ConfigurationError('MCP_REDIRECT_URIS', 'requires exact HTTPS URLs without credentials or wildcards');
    }
  }
  return Object.freeze(configuration);
}

export function validateRelease(input) {
  for (const name of Object.keys(input)) {
    if (!IMAGE_NAMES.includes(name)) throw new ConfigurationError(name, 'not a release image parameter');
  }
  const result = {};
  for (const name of IMAGE_NAMES) {
    const value = requireValue(input, name);
    if (!/^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/.test(value)) {
      throw new ConfigurationError(name, 'requires an immutable image digest, not a mutable tag');
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

export async function readEnvironmentFile(path) {
  let content;
  try { content = await readFile(path, 'utf8'); } catch {
    throw new ConfigurationError('ENV_FILE', 'configuration file cannot be read');
  }
  if (Buffer.byteLength(content) > 65_536) throw new ConfigurationError('ENV_FILE', 'configuration exceeds size limit');
  try { return parseEnv(content); } catch { throw new ConfigurationError('ENV_FILE', 'invalid environment file syntax'); }
}
