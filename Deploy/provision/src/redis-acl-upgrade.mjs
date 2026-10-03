import { readFile } from 'node:fs/promises';

const template = (await readFile(new URL('../../redis/users.acl.template', import.meta.url), 'utf8'))
  .replaceAll('\r\n', '\n');
const sessionLockCommands = ' +msetnx +mset +mget +getrange';

/** The only supported policy upgrade adds OAuth's refresh lock without changing credentials. */
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
  if (normalized !== expected.replace(sessionLockCommands, '')) throw new Error('Unrecognized Redis ACL');
  return Buffer.from(expected.replaceAll('\n', source.includes('\r\n') ? '\r\n' : '\n'));
}
