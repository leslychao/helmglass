import { createHash } from 'node:crypto';
import { chown, chmod, lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Runs once with no network and one explicit daemon-side bootstrap-directory mount.
// Secrets arrive through stdin, never Docker environment, image layers, command arguments or logs.
const allowed = new Set(['edge-tls', 'api-bootstrap', 'worker-bootstrap', 'turn-bootstrap', 'egress-bootstrap',
  'postgres-bootstrap', 'redis-bootstrap.acl', 'redis-health-bootstrap', 'minio-bootstrap', 'minio-license',
  'mcp-adapter-bootstrap', 'vault-tls', 'provision-bootstrap', 'migration-bootstrap', 'keycloak-bootstrap',
  'oauth-bootstrap', 'predefined-users-input', 'backup-recipient']);
const directory = '/bootstrap';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const ownerUid = name => name === 'edge-tls' ? 101
  : ['postgres-bootstrap', 'backup-recipient'].includes(name) ? 0 : 10001;
const fileMode = name => name === 'backup-recipient' ? 0o444 : 0o400;

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4_194_304) throw new Error('Input too large');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.installationId ?? '')
      || !['stage', 'verify'].includes(input.mode) || !Array.isArray(input.files)
      || input.files.length < 1 || input.files.length > allowed.size
      || new Set(input.files.map(file => file.name)).size !== input.files.length) throw new Error('Invalid manifest');
  for (const file of input.files) {
    if (!allowed.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || typeof file.content !== 'string') {
      throw new Error('Invalid file input');
    }
    file.bytes = Buffer.from(file.content, 'base64');
    if (!file.bytes.length || file.bytes.length > 1_048_576 || checksum(file.bytes) !== file.sha256) throw new Error('Invalid content');
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid mount');
  const ownerPath = join(directory, '.helm-owner.json');
  const entries = await readdir(directory);
  let owner;
  if (entries.includes('.helm-owner.json')) {
    if (!(await lstat(ownerPath)).isFile()) throw new Error('Invalid owner');
    owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    if (owner.schemaVersion !== 1 || owner.installationId !== input.installationId) throw new Error('Foreign owner');
  } else {
    if (entries.length || input.mode !== 'stage') throw new Error('Unowned mount');
    owner = { schemaVersion: 1, installationId: input.installationId };
  }
  if (entries.some(name => !allowed.has(name) && name !== '.helm-owner.json'
      && !(name.endsWith('.pending') && input.files.some(file => `${file.name}.pending` === name)))) throw new Error('Unexpected file');
  // Inspect all destinations before the first write. Normal restart cannot replace a credential.
  for (const file of input.files) {
    const path = join(directory, file.name);
    if (entries.includes(`${file.name}.pending`)) {
      const pending = await lstat(`${path}.pending`);
      if (input.mode === 'verify' || !pending.isFile() || pending.isSymbolicLink()
          || checksum(await readFile(`${path}.pending`)) !== file.sha256) throw new Error('Unconfirmed partial delivery');
    }
    let existing;
    try { existing = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      if (input.mode !== 'stage') throw new Error('Missing managed file');
      continue;
    }
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Unsafe destination');
    const current = await readFile(path);
    if (checksum(current) === file.sha256) continue;
    throw new Error('Credential drift');
  }
  if (input.mode !== 'verify') {
    await chmod(directory, 0o700);
    if (!entries.includes('.helm-owner.json')) await writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    for (const file of input.files) {
      const path = join(directory, file.name);
      const pending = `${path}.pending`;
      if (entries.includes(file.name) && checksum(await readFile(path)) === file.sha256) {
        if (entries.includes(`${file.name}.pending`)) await unlink(pending);
        continue;
      }
      if (!entries.includes(`${file.name}.pending`)) await writeFile(pending, file.bytes, { flag: 'wx', mode: 0o400 });
      await chmod(pending, fileMode(file.name));
      const uid = ownerUid(file.name);
      await chown(pending, uid, uid);
      await rename(pending, path);
    }
  }
  for (const file of input.files) {
    const metadata = await lstat(join(directory, file.name));
    const uid = ownerUid(file.name);
    if (metadata.uid !== uid || (metadata.mode & 0o777) !== fileMode(file.name)
        || checksum(await readFile(join(directory, file.name))) !== file.sha256) throw new Error('Protected delivery verification failed');
  }
  process.stdout.write(JSON.stringify({ status: 'READY', count: input.files.length }) + '\n');
}

main().catch(() => { process.stderr.write('BOOTSTRAP_DELIVERY_FAILED: verify installation ownership and protected daemon path\n'); process.exitCode = 1; });
