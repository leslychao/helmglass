/** Stops the whole pool before revoking its identities and creating the selected release. */
export async function deployWorkerRelease({ docker, compose, identifiers, imageId, count }) {
  await compose(['stop', 'browser-worker']);
  for (const id of await identifiers()) {
    const current = JSON.parse((await docker(['inspect', id])).stdout)[0];
    if (current.State.Running || current.State.Restarting) {
      throw new Error('Browser worker must be stopped before retiring its enrollment');
    }
  }
  await compose(['run', '--rm', '--no-deps', '-T', 'api', 'retire-workers']);
  await compose(['up', '-d', '--no-deps', '--force-recreate', '--scale', `browser-worker=${count}`, 'browser-worker']);
  const ids = await identifiers();
  if (ids.length !== count) throw new Error('Browser worker count does not match the selected deployment');
  for (const id of ids) {
    const current = JSON.parse((await docker(['inspect', id])).stdout)[0];
    if (current.Image !== imageId) throw new Error('Browser worker image does not match the selected release');
  }
}
