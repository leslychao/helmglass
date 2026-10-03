/** Applies the selected release through Compose's normal stop/recreate lifecycle. */
export async function deployWorkerRelease({ docker, compose, identifiers, imageId, count }) {
  await compose(['up', '-d', '--no-deps', '--scale', `browser-worker=${count}`, 'browser-worker']);
  const ids = await identifiers();
  if (ids.length !== count) throw new Error('Browser worker count does not match the selected deployment');
  for (const id of ids) {
    const current = JSON.parse((await docker(['inspect', id])).stdout)[0];
    if (current.Image !== imageId) throw new Error('Browser worker image does not match the selected release');
  }
}
