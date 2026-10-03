import { readFile } from 'node:fs/promises';

const template = (await readFile(new URL('../../redis/users.acl.template', import.meta.url), 'utf8'))
  .replaceAll('\r\n', '\n');
const sessionLockCommands = ' +msetnx +mset +mget +getrange';
const realtimeChannel = ' &helm:realtime:invalidations:v1 +publish +subscribe +unsubscribe';

/** Upgrade known shipped policies, preserving credentials and rejecting unrelated policy drift. */
export function upgradeRedisAcl(bytes) {
  const source = bytes.toString('utf8');
  const normalized = source.replaceAll('\r\n', '\n');
  let expected = template;
  for (const name of ['health', 'api', 'oauth']) {
    const hash = normalized.match(new RegExp(`^user helm_${name} reset on #([a-f0-9]{64}) `, 'm'))?.[1];
    if (!hash) throw new Error('Unrecognized Redis ACL');
    expected = expected.replace(`${name.toUpperCase()}_PASSWORD_SHA256`, hash);
  }
  if (normalized === expected) return bytes;
  const beforeRealtime = expected.replace(realtimeChannel, '');
  if (normalized !== beforeRealtime && normalized !== beforeRealtime.replace(sessionLockCommands, '')) {
    throw new Error('Unrecognized Redis ACL');
  }
  return Buffer.from(expected.replaceAll('\n', source.includes('\r\n') ? '\r\n' : '\n'));
}
