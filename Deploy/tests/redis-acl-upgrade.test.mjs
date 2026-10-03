import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { upgradeRedisAcl } from '../provision/src/redis-acl-upgrade.mjs';

const current = (await readFile(new URL('../redis/users.acl.template', import.meta.url), 'utf8'))
  .replaceAll('\r\n', '\n').replace('HEALTH_PASSWORD_SHA256', '1'.repeat(64))
  .replace('API_PASSWORD_SHA256', '2'.repeat(64)).replace('OAUTH_PASSWORD_SHA256', '3'.repeat(64));
const previous = current.replace(' +msetnx +mset +mget +getrange', '');

test('only the known OAuth lock policy upgrades, preserving hashes, scope and line endings', () => {
  for (const newline of ['\n', '\r\n']) {
    const oldBytes = Buffer.from(previous.replaceAll('\n', newline));
    const expected = Buffer.from(current.replaceAll('\n', newline));
    assert.deepEqual(upgradeRedisAcl(oldBytes), expected);
    assert.equal(upgradeRedisAcl(expected), expected);
  }
  for (const drift of [previous.replace('~__Host-helm_session-*', '~*'),
    previous.replace(' +ping', ' +flushall'), previous.replace('user default reset off', 'user default on'),
    previous.replace('3'.repeat(64), 'invalid-password-hash')]) {
    assert.throws(() => upgradeRedisAcl(Buffer.from(drift)), /Unrecognized Redis ACL/);
  }
});
