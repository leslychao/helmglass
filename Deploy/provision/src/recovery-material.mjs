import { createHash } from 'node:crypto';
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const names = ['proof.json', 'deletion-ledger.json', 'fencing.json', 'redis.json'];
function requireValue(value) { if (!value) throw new Error('Invalid recovery material'); }
async function directory(path, owner) {
  const value = await lstat(path);
  requireValue(value.isDirectory() && !value.isSymbolicLink() && value.uid === owner && (value.mode & 0o077) === 0);
}
async function immutable(path, bytes, owner) {
  let handle;
  try { handle = await open(path, 'wx', 0o400); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await lstat(path);
    requireValue(previous.isFile() && !previous.isSymbolicLink() && previous.uid === owner
      && (previous.mode & 0o077) === 0 && previous.size === bytes.length
      && digest(await readFile(path)) === digest(bytes));
    return;
  }
  try { await handle.writeFile(bytes); await handle.chown(owner, owner); await handle.sync(); }
  finally { await handle.close(); }
}
async function synchronize(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

try {
  process.umask(0o077);
  requireValue(process.getuid() === 0);
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    requireValue(Buffer.byteLength(input) <= 50_331_648);
  }
  const value = JSON.parse(input);
  input = '';
  requireValue(value.schemaVersion === 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.recoveryId ?? '')
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.installationId ?? ''));
  const marker = Buffer.from(JSON.stringify({ schemaVersion: 1, recoveryId: value.recoveryId,
    installationId: value.installationId }));
  if (value.mode === 'keys' || value.mode === 'clear-keys') {
    await directory('/backup-work', 999);
    const path = join('/backup-work', `recovery-${value.recoveryId}`);
    if (value.mode === 'keys') {
      requireValue(typeof value.privateKeyPem === 'string'
        && value.privateKeyPem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')
        && value.privateKeyPem.length <= 32_768
        && typeof value.password === 'string' && value.password.length >= 16
        && value.password.length <= 4096 && !/[\0\r\n]/.test(value.password));
      try { await mkdir(path, { mode: 0o700 }); await chown(path, 999, 999); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await directory(path, 999);
      const entries = await readdir(path);
      requireValue(entries.every(name => ['owner.json', 'private.pem', 'password'].includes(name)));
      await immutable(join(path, 'owner.json'), marker, 999);
      await immutable(join(path, 'private.pem'), Buffer.from(value.privateKeyPem), 999);
      await immutable(join(path, 'password'), Buffer.from(value.password), 999);
      await synchronize(path);
      process.stdout.write(JSON.stringify({ directory: path, state: 'STAGED' }) + '\n');
    } else {
      try { await lstat(path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        process.stdout.write('{"state":"REMOVED"}\n');
        process.exit(0);
      }
      await directory(path, 999);
      const owner = await lstat(join(path, 'owner.json'));
      requireValue(owner.isFile() && !owner.isSymbolicLink() && owner.size === marker.length
        && digest(await readFile(join(path, 'owner.json'))) === digest(marker));
      const entries = await readdir(path);
      requireValue(entries.every(name => ['owner.json', 'private.pem', 'password'].includes(name)));
      for (const name of ['private.pem', 'password', 'owner.json']) {
        if (entries.includes(name)) {
          const file = join(path, name);
          const state = await lstat(file);
          requireValue(state.isFile() && !state.isSymbolicLink() && state.uid === 999);
          await unlink(file);
        }
      }
      await rmdir(path);
      await synchronize('/backup-work');
      process.stdout.write('{"state":"REMOVED"}\n');
    }
  } else if (value.mode === 'pg-parent') {
    const path = '/storage';
    const metadata = await lstat(path);
    requireValue(metadata.isDirectory() && !metadata.isSymbolicLink());
    const entries = await readdir(path);
    requireValue(entries.length === 0 || metadata.uid === 999 && (metadata.mode & 0o077) === 0
      && entries.every(name => ['owner.json', '18'].includes(name)));
    if (entries.length) {
      requireValue(entries.includes('owner.json'));
      await immutable(join(path, 'owner.json'), marker, 999);
    }
    await chown(path, 999, 999);
    await chmod(path, 0o700);
    await immutable(join(path, 'owner.json'), marker, 999);
    try { await mkdir(join(path, '18'), { mode: 0o700 }); await chown(join(path, '18'), 999, 999); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await directory(join(path, '18'), 999);
    // An existing data directory belongs to the immutable restore process, never to this preparation.
    requireValue((await readdir(join(path, '18'))).length === 0);
    await synchronize(path);
    process.stdout.write('{"state":"EMPTY_PG_PARENT"}\n');
  } else if (value.mode === 'proof') {
    const path = '/recovery';
    const state = await lstat(path);
    requireValue(state.isDirectory() && !state.isSymbolicLink());
    const entries = await readdir(path);
    requireValue(entries.every(name => [...names, 'owner.json'].includes(name)));
    requireValue(entries.length === 0 || state.uid === 10001 && (state.mode & 0o077) === 0);
    await chown(path, 10001, 10001);
    await chmod(path, 0o700);
    await immutable(join(path, 'owner.json'), marker, 10001);
    requireValue(value.files && Object.keys(value.files).length === names.length);
    const hashes = {};
    for (const name of names) {
      requireValue(typeof value.files[name] === 'string' && value.files[name].length <= 44_739_244);
      const bytes = Buffer.from(value.files[name], 'base64');
      requireValue(bytes.length > 0 && bytes.length <= (name === 'deletion-ledger.json' ? 33_554_432 : 2_097_152)
        && bytes.toString('base64') === value.files[name]);
      await immutable(join(path, name), bytes, 10001);
      hashes[name] = digest(bytes);
    }
    await synchronize(path);
    process.stdout.write(JSON.stringify({ state: 'STAGED', hashes }) + '\n');
  } else throw new Error('Unsupported recovery material operation');
} catch {
  process.stderr.write('Recovery material was not confirmed; existing files were not replaced.\n');
  process.exitCode = 1;
}
