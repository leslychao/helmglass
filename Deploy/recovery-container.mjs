import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

/** A physical restore is started once. A lost launcher response observes the same container; failures are never replayed. */
export async function runRecoveryContainer({ docker, recoveryId, installationId, step, image,
  entrypoint, arguments: command, options = [], timeout = 21_600_000 }) {
  if (!/^[a-f0-9-]{36}$/.test(recoveryId) || !/^[a-z][a-z0-9-]{0,40}$/.test(step)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(installationId)) throw new Error('Invalid recovery container identity');
  const name = `helm-glass-recovery-${recoveryId}-${step}`;
  const expectedImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
  const specification = createHash('sha256').update(JSON.stringify({ image: expectedImage,
    entrypoint, command, options })).digest('hex');
  const find = async () => (await docker(['ps', '--all', '--quiet', '--no-trunc',
    '--filter', `name=^/${name}$`])).stdout.trim().split(/\s+/).filter(Boolean);
  let ids = await find();
  if (ids.length > 1) throw new Error('Conflicting physical recovery process');
  if (!ids.length) {
    await docker(['create', '--name', name, '--network', 'none', '--read-only',
      '--label', `helmglass.installation=${installationId}`, '--label', `helmglass.recovery=${recoveryId}`,
      '--label', `helmglass.recovery-step=${step}`, '--label', `helmglass.recovery-spec=${specification}`,
      ...options, '--entrypoint', entrypoint, image, ...command]);
    ids = await find();
    if (ids.length !== 1) throw new Error('Physical recovery launch is unconfirmed; retry this same operation');
  }
  const id = ids[0];
  const inspect = async () => {
    const value = JSON.parse((await docker(['inspect', '--format',
      '{"id":{{json .Id}},"image":{{json .Image}},"config":{{json .Config}},"host":{{json .HostConfig}},"state":{{json .State}}}', id])).stdout);
    if (value.id !== id || value.image !== expectedImage
        || value.config.Labels?.['helmglass.installation'] !== installationId
        || value.config.Labels?.['helmglass.recovery'] !== recoveryId
        || value.config.Labels?.['helmglass.recovery-step'] !== step
        || value.config.Labels?.['helmglass.recovery-spec'] !== specification
        || JSON.stringify(value.config.Entrypoint) !== JSON.stringify([entrypoint])
        || JSON.stringify(value.config.Cmd) !== JSON.stringify(command)
        || value.host.NetworkMode !== 'none' || !value.host.ReadonlyRootfs) {
      throw new Error('Physical recovery process has different ownership or command');
    }
    return value.state;
  };
  const initial = await inspect();
  if (initial.Status === 'created' && !initial.Running && initial.Pid === 0) await docker(['start', id]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await inspect();
    if (!state.Running && !state.Restarting && state.Pid === 0 && state.Status !== 'created') {
      if (state.Status !== 'exited' || state.ExitCode !== 0 || state.OOMKilled) {
        throw new Error('Physical recovery failed; inspect its preserved target and process before any retry');
      }
      const output = (await docker(['logs', id], { maximum: 2_097_152 })).stdout;
      return { containerId: id, output };
    }
    await delay(1000);
  }
  throw new Error('Physical recovery is still active or unconfirmed; targets and process are preserved');
}
