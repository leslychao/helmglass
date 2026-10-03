import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from '../process.mjs';

// OAuth2 Proxy v7.15.5 pins bsm/redislock v0.10.0 and appends ".lock" to the ticket key.
// These are its Lua operations, with comments omitted and indentation normalized:
// https://github.com/bsm/redislock/tree/v0.10.0
const obtain = `
local function pexpire(ttl)
  for _, key in ipairs(KEYS) do
    redis.call("pexpire", key, ttl)
  end
end
local function canOverrideKeys()
  local offset = tonumber(ARGV[2])
  for _, key in ipairs(KEYS) do
    if redis.call("getrange", key, 0, offset-1) ~= string.sub(ARGV[1], 1, offset) then
      return false
    end
  end
  return true
end
local setArgs = {}
for _, key in ipairs(KEYS) do
  table.insert(setArgs, key)
  table.insert(setArgs, ARGV[1])
end
if redis.call("msetnx", unpack(setArgs)) ~= 1 then
  if canOverrideKeys() == false then
    return false
  end
  redis.call("mset", unpack(setArgs))
end
pexpire(ARGV[3])
return redis.status_reply("OK")
`;

const refresh = `
local values = redis.call("mget", unpack(KEYS))
for i, _ in ipairs(KEYS) do
  if values[i] ~= ARGV[1] then
    return false
  end
end
for _, key in ipairs(KEYS) do
  redis.call("pexpire", key, ARGV[2])
end
return redis.status_reply("OK")
`;

const release = `
local values = redis.call("mget", unpack(KEYS))
for i, _ in ipairs(KEYS) do
  if values[i] ~= ARGV[1] then
    return false
  end
end
redis.call("del", unpack(KEYS))
return redis.status_reply("OK")
`;

test('Redis ACL confines OAuth locks and API realtime delivery to their namespaces',
  { timeout: 120_000 }, async t => {
    const fixture = randomUUID();
    const context = process.env.HELM_TEST_DOCKER_CONTEXT ?? 'desktop-linux';
    const image = process.env.REDIS_IMAGE ?? 'helmglass-redis:dev-107';
    const docker = (args, options) => run('docker', ['--context', context, ...args], options);
    const label = `helmglass.acceptance=${fixture}`;
    const containers = new Set();
    const volumes = new Set();
    const passwords = Object.fromEntries(['health', 'api', 'oauth']
      .map(name => [name, randomBytes(32).toString('base64url')]));
    let acl = await readFile(new URL('../redis/users.acl.template', import.meta.url), 'utf8');
    for (const [name, password] of Object.entries(passwords)) {
      acl = acl.replace(`${name.toUpperCase()}_PASSWORD_SHA256`,
        createHash('sha256').update(password).digest('hex'));
    }
    assert.match(await readFile(new URL('../oauth2-proxy/Dockerfile', import.meta.url), 'utf8'),
      /oauth2-proxy:v7\.15\.5@/, 'Update the lock fixture when the pinned OAuth2 Proxy changes');
    const legacyAcl = acl.replace(/^user helm_oauth .+$/m,
      line => line.replace(/ \+(?:msetnx|mset|mget|getrange)(?= |$)/g, ''))
      .replace(' &helm:realtime:invalidations:v1 +publish +subscribe +unsubscribe', '');
    const command = 'identity="$1"; shift; '
      + 'REDISCLI_AUTH=$(jq -er ".password" "/run/secrets/redis_${identity}_identity"); '
      + 'export REDISCLI_AUTH; exec timeout 2 redis-cli -e --no-auth-warning --raw '
      + '--user "helm_${identity}" "$@"';
    const redis = (container, args, allowedExitCodes = [0], identity = 'oauth') => docker([
      'exec', container, 'sh', '-c', command, 'redis-cli', identity, ...args], { allowedExitCodes });
    const value = async (container, args) => (await redis(container, args)).stdout.trim();
    const stage = `set -eu
umask 077
IFS= read -r fixture
printf '%s' "$fixture" | jq -er '.acl' > /secrets/redis_acl
printf '%s' "$fixture" | jq -c '.health' > /secrets/redis_health_identity
printf '%s' "$fixture" | jq -c '.oauth' > /secrets/redis_oauth_identity
printf '%s' "$fixture" | jq -c '.api' > /secrets/redis_api_identity
chown -R 10001:10001 /secrets
chmod 700 /secrets
chmod 400 /secrets/*
`;
    try {
      for (const [mode, policy] of [['legacy', legacyAcl], ['current', acl]]) {
        const container = `helm-redis-lock-${mode}-${fixture}`;
        const volume = `${container}-secrets`;
        const helper = `${container}-stage`;
        volumes.add(volume);
        await docker(['volume', 'create', '--label', label, volume]);
        containers.add(helper);
        await docker(['run', '--rm', '-i', '--name', helper, '--label', label, '--network', 'none',
          '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
          '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true',
          '--log-driver', 'none', '--volume', `${volume}:/secrets`, '--entrypoint', 'sh', image,
          '-c', stage], { input: JSON.stringify({ acl: policy,
          health: { schemaVersion: 1, username: 'helm_health', password: passwords.health },
          oauth: { password: passwords.oauth }, api: { password: passwords.api } }) + '\n' });
        containers.delete(helper);
        containers.add(container);
        await docker(['run', '-d', '--name', container, '--label', label, '--network', 'none',
          '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
          '--log-driver', 'none', '--tmpfs', '/run:uid=10001,gid=10001,mode=0700',
          '--tmpfs', '/tmp:uid=10001,gid=10001,mode=1777',
          '--tmpfs', '/data:uid=10001,gid=10001,mode=0700',
          '--volume', `${volume}:/run/secrets:ro`, image]);
        let healthy = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          if ((await docker(['exec', container, '/opt/helm/bin/healthcheck'],
            { allowedExitCodes: [0, 1] })).code === 0) {
            healthy = true;
            break;
          }
          await delay(250);
        }
        assert.ok(healthy, `${mode} Redis fixture must become healthy`);
        const key = `__Host-helm_session-${fixture}.lock`;
        const owner = 'first-owner';
        const other = 'other-owner';
        const acquire = token => ['EVAL', obtain, '1', key, token, String(token.length), '30000'];
        const channel = 'helm:realtime:invalidations:v1';
        if (mode === 'legacy') {
          await t.test('legacy ACL reproduces the denied refresh lock acquisition', async () => {
            const denied = await redis(container, acquire(owner), [0, 1]);
            assert.equal(denied.code, 1);
            assert.match(denied.stdout + denied.stderr, /ACL failure in script:.*no permissions.*msetnx/i);
            assert.equal(await value(container, ['EXISTS', key]), '0');
          });
          await t.test('legacy API policy reproduces denied realtime publication', async () => {
            const denied = await redis(container, ['PUBLISH', channel, '{}'], [0, 1], 'api');
            assert.equal(denied.code, 1);
            assert.match(denied.stdout + denied.stderr, /NOPERM/);
          });
          continue;
        }
        await t.test('API can publish, subscribe and unsubscribe on the exact realtime channel', async () => {
          const published = await redis(container, ['PUBLISH', channel, '{}'], [0], 'api');
          assert.equal(published.stdout.trim(), '0');
          const subscribed = await redis(container, ['SUBSCRIBE', channel], [0, 1, 124, 143], 'api');
          assert.ok([124, 143].includes(subscribed.code),
            'Successful subscription stays open until timeout sends SIGTERM');
          assert.equal(subscribed.stdout.trim(), `subscribe\n${channel}\n1`);
          const unsubscribed = await redis(container, ['UNSUBSCRIBE', channel], [0], 'api');
          assert.equal(unsubscribed.stdout.trim(), `unsubscribe\n${channel}\n0`);
        });
        await t.test('unrelated channels and other identities cannot use realtime transport', async () => {
          for (const [identity, args] of [
            ['api', ['PUBLISH', 'helm:realtime:invalidations:foreign', '{}']],
            ['api', ['SUBSCRIBE', 'helm:realtime:invalidations:foreign']],
            ['api', ['PSUBSCRIBE', 'helm:realtime:*']],
            ['oauth', ['PUBLISH', channel, '{}']],
            ['oauth', ['SUBSCRIBE', channel]],
            ['health', ['PUBLISH', channel, '{}']],
          ]) {
            const denied = await redis(container, args, [0, 1, 124, 143], identity);
            assert.equal(denied.code, 1, `${identity} ${args[0]} must reject unrelated access`);
            assert.match(denied.stdout + denied.stderr, /NOPERM/);
          }
        });
        await t.test('acquire, competing owner, renewal, expiry and release', async () => {
          assert.equal(await value(container, acquire(owner)), 'OK');
          assert.equal(await value(container, ['EXISTS', key]), '1');
          assert.ok(Number(await value(container, ['PTTL', key])) > 0);
          assert.equal(await value(container, acquire(other)), '');
          assert.equal(await value(container, ['GET', key]), owner);
          const obtainSha = createHash('sha1').update(obtain).digest('hex');
          assert.equal(await value(container, ['EVALSHA', obtainSha, '1', key,
            owner, String(owner.length), '30000']), 'OK');
          const refreshSha = await value(container, ['SCRIPT', 'LOAD', refresh]);
          assert.equal(await value(container, ['EVALSHA', refreshSha, '1', key, other, '60000']), '');
          assert.equal(await value(container, ['EVALSHA', refreshSha, '1', key, owner, '60000']), 'OK');
          assert.ok(Number(await value(container, ['PTTL', key])) > 30000);
          assert.equal(await value(container, ['EVAL', release, '1', key, other]), '');
          assert.equal(await value(container, ['EXISTS', key]), '1');
          assert.equal(await value(container, ['EVAL', release, '1', key, owner]), 'OK');
          assert.equal(await value(container, ['EXISTS', key]), '0');
          assert.equal(await value(container, acquire(other)), 'OK');
          assert.equal(await value(container, ['EVAL', refresh, '1', key, other, '1']), 'OK');
          await delay(20);
          assert.equal(await value(container, ['EXISTS', key]), '0');
          assert.equal(await value(container, acquire(owner)), 'OK');
          assert.equal(await value(container, ['EVAL', release, '1', key, owner]), 'OK');
        });
        await t.test('the added commands remain denied outside the OAuth ticket namespace', async () => {
          const outside = `helm:csrf:${fixture}`;
          for (const args of [
            ['MSETNX', outside, 'forbidden'],
            ['MSETNX', key, 'allowed', outside, 'forbidden'],
            ['MSET', outside, 'forbidden'],
            ['MGET', outside],
            ['GETRANGE', outside, '0', '10'],
            ['EVAL', obtain, '1', outside, owner, String(owner.length), '30000'],
          ]) {
            const denied = await redis(container, args, [0, 1]);
            assert.equal(denied.code, 1, `${args[0]} must reject a key outside the session prefix`);
            assert.match(denied.stdout + denied.stderr, /NOPERM/);
          }
          assert.equal(await value(container, ['EXISTS', key]), '0',
            'A denied mixed-prefix MSETNX must not write its allowed key');
        });
      }
    } finally {
      for (const container of containers) {
        const result = await docker(['inspect', container], { allowedExitCodes: [0, 1] });
        if (result.code !== 0) continue;
        assert.equal(JSON.parse(result.stdout)[0].Config.Labels['helmglass.acceptance'], fixture);
        await docker(['rm', '--force', container]);
      }
      for (const volume of volumes) {
        const result = await docker(['volume', 'inspect', volume], { allowedExitCodes: [0, 1] });
        if (result.code !== 0) continue;
        assert.equal(JSON.parse(result.stdout)[0].Labels['helmglass.acceptance'], fixture);
        await docker(['volume', 'rm', volume]);
      }
    }
  });
