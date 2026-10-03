import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { upgradeRedisAcl } from '../provision/src/redis-acl-upgrade.mjs';

const current = (await readFile(new URL('../redis/users.acl.template', import.meta.url), 'utf8'))
  .replaceAll('\r\n', '\n').replace('HEALTH_PASSWORD_SHA256', '1'.repeat(64))
  .replace('API_PASSWORD_SHA256', '2'.repeat(64)).replace('OAUTH_PASSWORD_SHA256', '3'.repeat(64));
const beforeRealtime = current.replace(
  ' &helm:realtime:invalidations:v1 +publish +subscribe +unsubscribe', '');
const beforeSessionLock = beforeRealtime.replace(' +msetnx +mset +mget +getrange', '');

test('known shipped policies upgrade, preserving hashes, scope and line endings', () => {
  for (const newline of ['\n', '\r\n']) {
    const expected = Buffer.from(current.replaceAll('\n', newline));
    for (const previous of [beforeRealtime, beforeSessionLock]) {
      assert.deepEqual(upgradeRedisAcl(Buffer.from(previous.replaceAll('\n', newline))), expected);
    }
    assert.equal(upgradeRedisAcl(expected), expected);
  }
});

test('unrecognized policy changes fail closed', () => {
  for (const drift of [beforeRealtime.replace('~__Host-helm_session-*', '~*'),
    beforeRealtime.replace(' +ping', ' +flushall'),
    beforeRealtime.replace('user default reset off', 'user default on'),
    beforeRealtime.replace('3'.repeat(64), 'invalid-password-hash'),
    current.replace('&helm:realtime:invalidations:v1', '&*'),
    current.replace(' +subscribe', ' +psubscribe'),
    current.replace(' +msetnx +mset +mget +getrange', '')]) {
    assert.throws(() => upgradeRedisAcl(Buffer.from(drift)), /Unrecognized Redis ACL/);
  }
});
