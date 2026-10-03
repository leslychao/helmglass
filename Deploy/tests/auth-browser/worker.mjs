import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

/** Optional real runtime extension; the caller owns the protected fixture files and container cleanup. */
export async function startWorkerFixture({
  enabled = process.env.HELM_WORKER_ACCEPTANCE === '1',
  start, file, mount, isolated, healthy, docker, network,
  installationId, apiSecrets, tls,
}) {
  if (!enabled) return undefined;
  assert.equal(apiSecrets.mediaProxyUsername, 'helm-media');
  assert.ok(installationId && network && tls.caPem);
  const internetNetwork = 'helm-worker-egress-' + randomUUID();
  let proxy;
  let turn;
  let created = false;
  async function cleanup() {
    if (!created) return;
    if (proxy) docker(['network', 'disconnect', internetNetwork, proxy], { allowFailure: true });
    docker(['network', 'rm', internetNetwork], { allowFailure: true });
    created = false;
  }

  try {
    await file('worker-identity.json', { schemaVersion: 1, installationId,
      enrollmentToken: apiSecrets.workerEnrollmentToken, caPem: tls.caPem });
    await file('worker-egress.json', { schemaVersion: 1, mediaProxyUsername: apiSecrets.mediaProxyUsername,
      mediaProxyPassword: apiSecrets.mediaProxyPassword });
    await file('worker-turn.json', { schemaVersion: 2, turnSharedSecret: apiSecrets.turnSharedSecret });
    docker(['network', 'create', '--label', 'helmglass.worker-acceptance=true', internetNetwork]);
    created = true;
    // Both peers use the actual coturn relay address inside this isolated fixture.
    // No host ports or broader private-network peer exceptions are required.
    turn = start('coturn', process.env.TURN_IMAGE ?? 'helmglass-coturn:0.1.0', [
      ...isolated(), ...mount('worker-turn.json', '/run/secrets/turn_identity'),
      '--env', 'TURN_REALM=helm.integration.test',
      '--env', 'TURN_RELAY_MIN=49160', '--env', 'TURN_RELAY_MAX=49200',
    ]);
    await healthy(turn);
    proxy = start('egress-proxy', 'helmglass-egress-proxy:0.1.0', [
      ...isolated(), ...mount('worker-egress.json', '/run/secrets/egress_identity'),
    ]);
    docker(['network', 'connect', internetNetwork, proxy]);
    await healthy(proxy);
    const worker = start('browser-worker', process.env.WORKER_IMAGE ?? 'helmglass-browser-worker:0.1.0', [
      ...isolated(), ...mount('worker-identity.json', '/run/secrets/worker_identity'),
      '--security-opt', 'seccomp=' + resolve('Deploy/security/chromium-seccomp.json'),
      '--tmpfs', '/runtime:size=512m,uid=10001,gid=10001,mode=0700', '--shm-size', '512m',
      '--pids-limit', '512', '--memory', '2g',
      '--env', 'WORKER_CONTROL_URL=wss://api:8444/internal/worker/control',
      '--env', 'WORKER_IMAGE_DIGEST=acceptance-local-image',
      '--env', 'EGRESS_PROXY_URL=http://egress-proxy:3128',
      '--env', 'STAGING_DIRECTORY=/runtime/staging',
    ]);
    await healthy(worker);
    return {
      worker, proxy, turn, cleanup,
      disconnect: () => docker(['network', 'disconnect', network, worker]),
      reconnect: () => docker(['network', 'connect', '--alias', 'browser-worker', network, worker]),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
