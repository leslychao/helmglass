import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { IMAGE_NAMES, validateDeployment, validateRelease } from '../../configuration.mjs';

function configuration() {
  return {
    DOCKER_HOST: 'tcp://192.168.0.107:2375', INSTALLATION_ID: 'helm-glass-dev',
    PUBLIC_ORIGIN: 'https://helm.example.test',
    TRUSTED_EDGE_PROXY: '172.30.242.2', WORKER_COUNT: '2', GPU_DEVICE_ID: '0',
    LOCAL_SECRETS_DIR: 'C:/private/helm-glass', SECRETS_DIR: '/var/lib/helm-glass/bootstrap',
    LOCAL_RECOVERY_DIR: 'C:/offline/recovery',
    MINIO_DATA_DIR: '/srv/minio/data',
    TURN_INTERNAL_URL: 'turn:coturn:3478?transport=tcp',
    TURN_PUBLIC_URLS: 'turn:192.168.0.107:3478?transport=udp,turns:helm.example.test:5349?transport=tcp',
    TURN_REALM: 'helm.example.test', TURN_RELAY_MIN: '49160', TURN_RELAY_MAX: '49259',
    KEYCLOAK_ADMIN_EMAIL: 'admin@example.test', KEYCLOAK_ADMIN_LAST_NAME: 'Fixture',
    KEYCLOAK_ANGELINA_EMAIL: 'angelina@example.test', KEYCLOAK_ANGELINA_LAST_NAME: 'Fixture',
    MCP_REDIRECT_URIS: 'https://chatgpt.com/connector_platform_oauth_redirect',
  };
}

test('validates dev configuration without confusing client and daemon secret paths', () => {
  const value = validateDeployment(configuration());
  assert.equal(value.LOCAL_SECRETS_DIR, 'C:/private/helm-glass');
  assert.equal(value.SECRETS_DIR, '/var/lib/helm-glass/bootstrap');
  assert.ok(Object.isFrozen(value));
  assert.equal(value.OPERATOR_INPUT_FILE, '');
});

test('operator password file is optional and accepts only an absolute local path', () => {
  const path = resolve('operator-inputs.json');
  assert.equal(validateDeployment({ ...configuration(), OPERATOR_INPUT_FILE: path }).OPERATOR_INPUT_FILE, path);
  assert.equal(validateDeployment({ ...configuration(), OPERATOR_INPUT_FILE: '' }).OPERATOR_INPUT_FILE, '');
  for (const value of ['relative.json', ' ', 123, null, path + '\n']) {
    assert.throws(() => validateDeployment({ ...configuration(), OPERATOR_INPUT_FILE: value }),
      { parameter: 'OPERATOR_INPUT_FILE' });
  }
});

test('rejects secrets, public trust, unsafe origins and malformed remote paths', () => {
  for (const [key, value] of [
    ['KEYCLOAK_ADMIN_PASSWORD', 'secret-must-not-appear'],
    ['BACKUP_DIR', '/srv/retired/backup'], ['BACKUP_WORK_DIR', '/srv/retired/scratch'],
    ['BACKUP_RECIPIENT_FILE', 'retired.pem'], ['DELETION_LEDGER_DIR', '/srv/retired/ledger'],
    ['TRUSTED_EDGE_PROXY', '0.0.0.0/0'], ['TRUSTED_EDGE_PROXY', '127.0.0.1;include /tmp/attack'],
    ['TRUSTED_EDGE_PROXY', ''], ['EDGE_TLS_FILE', 'obsolete.pem'], ['TURN_TLS_FILE', 'obsolete.pem'],
    ['PUBLIC_ORIGIN', 'http://helm.example.test'], ['PUBLIC_ORIGIN', 'https://helm.example.test/path'],
    ['PUBLIC_ORIGIN', 'https://username:password@helm.example.test'],
    ['PUBLIC_ORIGIN', 'https://helm.example.test?query=private'],
    ['SECRETS_DIR', 'C:/private/helm-glass'], ['SECRETS_DIR', '/'],
    ['SECRETS_DIR', '/var/lib/../etc'], ['WORKER_COUNT', '2; command'],
    ['MINIO_DATA_DIR', '/var/lib/helm-glass/bootstrap/data'], ['MINIO_DATA_DIR', '/'],
    ['TURN_RELAY_MAX', '65535'], ['MCP_REDIRECT_URIS', 'https://chatgpt.com/*'],
    ['KEYCLOAK_ADMIN_EMAIL', ''], ['KEYCLOAK_ANGELINA_EMAIL', 'admin@example.test'],
  ]) {
    assert.throws(() => validateDeployment({ ...configuration(), [key]: value }), (error) => {
      assert.ok(error.parameter);
      assert.ok(!error.message.includes('secret-must-not-appear'));
      return true;
    });
  }
});

test('release accepts immutable image references and rejects missing or mutable images', () => {
  const image = `registry.example.test/helm/api@sha256:${'a'.repeat(64)}`;
  const pins = Object.fromEntries(IMAGE_NAMES.map((name) => [name, image]));
  assert.equal(validateRelease(pins).API_IMAGE, image);
  assert.throws(() => validateRelease({ ...pins, API_IMAGE: 'helm/api:latest' }), { parameter: 'API_IMAGE' });
  assert.throws(() => validateRelease({ ...pins, API_IMAGE: '' }), { parameter: 'API_IMAGE' });
  assert.throws(() => validateRelease({ ...pins, PASSWORD: 'private' }), { parameter: 'PASSWORD' });
});

test('environment parsing preserves data rather than evaluating shell expressions', () => {
  assert.equal(parseEnv('LOCAL_SECRETS_DIR="$(whoami)"').LOCAL_SECRETS_DIR, '$(whoami)');
});
