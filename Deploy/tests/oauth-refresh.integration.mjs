import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { run } from '../process.mjs';

test('pinned OAuth proxy refreshes Redis sessions before forwarded JWT expiry',
  { timeout: 360_000 }, async () => {
    const source = await readFile(new URL('../oauth2-proxy/entrypoint.sh', import.meta.url), 'utf8');
    const minutes = Number(source.match(/^cookie_refresh = "(\d+)m"$/m)?.[1]);
    assert.ok(Number.isInteger(minutes) && minutes > 0 && minutes <= 5);
    const dockerfile = await readFile(new URL('../oauth2-proxy/Dockerfile', import.meta.url), 'utf8');
    const oauthImage = dockerfile.match(/^ARG OAUTH_BASE_IMAGE=(.+)$/m)?.[1].trim();
    const nodeImage = dockerfile.match(/^ARG WRAPPER_BASE_IMAGE=(.+)$/m)?.[1].trim();
    const redisFile = await readFile(new URL('../redis/Dockerfile', import.meta.url), 'utf8');
    const redisImage = redisFile.match(/^ARG REDIS_BASE_IMAGE=(.+)$/m)?.[1].trim();
    assert.match(oauthImage ?? '', /oauth2-proxy:v7\.15\.5@sha256:[a-f0-9]{64}$/);
    for (const image of [nodeImage, redisImage]) assert.match(image ?? '', /@sha256:[a-f0-9]{64}$/);

    const id = randomUUID();
    const network = `helm-oauth-expiry-${id}`;
    const redis = `${network}-redis`;
    const client = `${network}-client`;
    const image = `${network}:test`;
    const environment = { ...process.env };
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
      delete environment[key];
    }
    const docker = (args, options = {}) => run('docker', [
      '--context', process.env.HELM_TEST_DOCKER_CONTEXT ?? 'desktop-linux', ...args,
    ], { environment, maximum: 131_072, ...options });
    let built = false;
    let created = false;
    try {
      // Reuse exactly the production binary and Node base, with no production secrets or services.
      await docker(['build', '--quiet', '--tag', image, '-'], { timeout: 300_000,
        input: `FROM ${oauthImage} AS oauth\nFROM ${nodeImage}\n`
          + 'COPY --from=oauth /bin/oauth2-proxy /usr/local/bin/oauth2-proxy\n' });
      built = true;
      await docker(['network', 'create', '--internal', network]);
      created = true;
      await docker(['run', '-d', '--name', redis, '--network', network, '--network-alias', 'redis',
        '--log-driver', 'none', '--read-only', '--tmpfs', '/data:rw,noexec,nosuid,size=8m',
        redisImage, 'redis-server', '--save', '', '--appendonly', 'no']);
      const result = await docker(['run', '--rm', '--name', client, '--network', network,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--log-driver', 'none', '--user', '1000:1000',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m,mode=1777',
        '--mount', `type=bind,source=${fileURLToPath(new URL('./auth-browser/oauth-refresh.mjs', import.meta.url))},target=/fixture.mjs,readonly`,
        '--entrypoint', 'node', image, '/fixture.mjs', String(minutes)], { timeout: 60_000,
        allowedExitCodes: [0, 1] });
      // The fixture emits only fixed assertion descriptions and numeric/boolean measurements.
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const evidence = JSON.parse(result.stdout.trim());
      assert.equal(evidence.expiredForwardingReproduced, true);
      assert.equal(evidence.refreshBeforeExpiry, true);
      assert.equal(evidence.expiryBoundaryContinuous, true);
      assert.equal(evidence.revokedRefreshDenied, true);
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } finally {
      await docker(['rm', '-f', client, redis], { allowedExitCodes: [0, 1] });
      if (created) await docker(['network', 'rm', network]);
      if (built) await docker(['image', 'rm', image]);
    }
  });
