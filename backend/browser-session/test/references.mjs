import assert from 'node:assert/strict';

export function snapshotText(observation) {
  return observation.snapshot.map(({node}) => typeof node === 'string' ? node :
    [node.name, node.text].filter(value => value !== undefined).join(' ')).join('\n');
}

export async function target(request, base, name) {
  const response = await request(base + '/observe', undefined, 'GET');
  const observation = response.value ?? response;
  const nodes = observation.snapshot.map(entry => entry.node)
    .filter(node => typeof node !== 'string' && node.name === name && node.ref);
  assert.equal(nodes.length, 1, 'Exactly one issued native reference for ' + name);
  return { observationId: observation.observationId, ref: nodes[0].ref };
}
