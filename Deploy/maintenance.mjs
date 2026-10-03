import { randomUUID } from 'node:crypto';

/** One Docker-side exclusion for concurrent startup, including remote launchers. */
export async function acquireMaintenance({ docker, image, installationId,
  project = 'helm-glass' }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(installationId ?? '')
      || !/^helm-glass(?:-[a-z0-9-]+)?$/.test(project)) {
    throw new Error('Invalid maintenance owner');
  }
  const token = randomUUID();
  const name = `${project}-maintenance`;
  // This container is never started. Docker's unique name is the cross-process lock.
  // A killed launcher leaves it in place; another launcher must not steal it on a TTL.
  const id = (await docker(['create', '--name', name, '--network', 'none', '--read-only',
    '--label', `helmglass.maintenance.installation=${installationId}`,
    '--label', 'helmglass.maintenance.operation=startup',
    '--label', `helmglass.maintenance.token=${token}`,
    '--entrypoint', 'node', image, '--version'])).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Maintenance ownership was not confirmed');
  let released = false;
  return {
    id,
    async release() {
      if (released) return;
      const state = JSON.parse((await docker(['inspect', '--format',
        '{"id":{{json .Id}},"running":{{json .State.Running}},"token":{{json (index .Config.Labels "helmglass.maintenance.token")}}}', id])).stdout);
      if (state.id !== id || state.running || state.token !== token) {
        throw new Error('Maintenance ownership changed; the lock was retained');
      }
      await docker(['rm', id]);
      released = true;
    },
  };
}

export async function deploymentContainers(docker, service, project = 'helm-glass') {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) throw new Error('Invalid deployment service');
  const ids = (await docker(['ps', '--all', '--quiet', '--no-trunc',
    '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.oneoff=False',
    '--filter', `label=com.docker.compose.service=${service}`])).stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Invalid deployment container inventory');
  }
  return ids;
}

