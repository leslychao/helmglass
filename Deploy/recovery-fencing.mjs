import { createHash } from 'node:crypto';
import { run } from './process.mjs';

const runtimeServices = new Set(['nginx', 'mcp-adapter', 'browser-worker', 'api', 'oauth2-proxy',
  'keycloak', 'provision', 'migrate', 'coturn', 'egress-proxy', 'redis']);
const storageServices = new Set(['postgres', 'minio', 'vault']);
const containerIdPattern = /^[a-f0-9]{64}$/;
const inspectProjection = '{{json .}}';

/** All calls are scoped to the selected daemon. Diagnostics never contain container secrets. */
export function recoveryDocker(environment) {
  const selected = { ...environment };
  delete selected.DOCKER_CONTEXT;
  return arguments_ => run('docker', arguments_, { environment: selected,
    timeout: 180_000, maximum: 8_388_608 });
}

async function inspectRuntime(docker, containerId, project) {
  const projection = '{"id":{{json .Id}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    + '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    + '"state":{{json .State.Status}},"running":{{json .State.Running}},'
    + '"restarting":{{json .State.Restarting}},"pid":{{json .State.Pid}}}';
  const value = JSON.parse((await docker(['inspect', '--format', projection, containerId])).stdout);
  if (value.id !== containerId || value.project !== project
      || !runtimeServices.has(value.service) && !storageServices.has(value.service)) {
    throw new Error('Recovery found an unowned or unexpected container');
  }
  return value;
}

async function inventory(docker, project) {
  const ids = (await docker(['ps', '--all', '--quiet', '--no-trunc',
    '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length > 128 || new Set(ids).size !== ids.length
      || ids.some(id => !containerIdPattern.test(id))) throw new Error('Invalid recovery inventory');
  const containers = [];
  for (const id of ids) containers.push(await inspectRuntime(docker, id, project));
  return containers.sort((left, right) => left.id.localeCompare(right.id));
}

function sameInventory(before, after) {
  return before.length === after.length && before.every((value, index) =>
    value.id === after[index].id && value.service === after[index].service);
}

/** Stops the known installation before restore; callers must persist this receipt and keep admission closed. */
export async function fenceInstallation({ docker, expectedDaemonId, previousContainers, project = 'helm-glass' }) {
  if (typeof expectedDaemonId !== 'string' || !expectedDaemonId
      || !/^helm-glass(?:-[a-z0-9-]+)?$/.test(project)
      || !Array.isArray(previousContainers) || previousContainers.length > 128
      || new Set(previousContainers.map(value => value.containerId)).size !== previousContainers.length
      || previousContainers.some(value => !containerIdPattern.test(value.containerId ?? '')
        || !runtimeServices.has(value.service))) throw new Error('Invalid previous runtime manifest');
  const daemon = JSON.parse((await docker(['info', '--format', inspectProjection])).stdout);
  if (daemon.OSType !== 'linux' || daemon.ID !== expectedDaemonId) {
    throw new Error('The original Docker daemon is not confirmed; external fencing evidence is required');
  }
  const before = await inventory(docker, project);
  const runtime = before.filter(value => runtimeServices.has(value.service));
  if (!runtime.length && !previousContainers.length) throw new Error('No installation runtime could be identified');
  const allHostIds = new Set((await docker(['ps', '--all', '--quiet', '--no-trunc']))
    .stdout.trim().split(/\s+/).filter(Boolean));
  for (const previous of previousContainers) {
    const found = before.find(value => value.id === previous.containerId);
    if (found && found.service !== previous.service || !found && allHostIds.has(previous.containerId)) {
      throw new Error('A previous runtime no longer has the expected installation ownership');
    }
  }
  // Close incoming requests first. Other runtimes cannot be used as proof until inspected after stop.
  const ingress = runtime.filter(value => value.service === 'nginx');
  const remaining = runtime.filter(value => value.service !== 'nginx');
  for (const group of [ingress, remaining]) {
    const running = group.filter(value => value.running || value.restarting).map(value => value.id);
    if (running.length) await docker(['stop', '--time', '60', ...running]);
  }
  const after = await inventory(docker, project);
  if (!sameInventory(before, after)) throw new Error('Installation inventory changed during fencing; admission must remain closed');
  const stopped = after.filter(value => runtimeServices.has(value.service));
  if (stopped.some(value => value.running || value.restarting || value.pid !== 0
      || !['created', 'exited', 'dead'].includes(value.state))) {
    throw new Error('An old runtime is still active; admission must remain closed');
  }
  const daemonAfter = JSON.parse((await docker(['info', '--format', inspectProjection])).stdout);
  if (daemonAfter.ID !== expectedDaemonId) throw new Error('Docker daemon identity changed during fencing');
  const records = new Map(previousContainers.map(value => [value.containerId,
    { containerId: value.containerId, service: value.service, state: 'absent' }]));
  for (const value of stopped) records.set(value.id,
    { containerId: value.id, service: value.service, state: value.state });
  const containers = [...records.values()].sort((left, right) => left.containerId.localeCompare(right.containerId));
  const receipt = { daemonId: expectedDaemonId, observedAt: new Date().toISOString(),
    expectedContainerIds: containers.map(value => value.containerId), containers };
  const bytes = Buffer.from(JSON.stringify(receipt));
  return { receipt, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
