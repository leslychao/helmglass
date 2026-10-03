import { chmod, chown, lstat, readdir } from 'node:fs/promises';

// A one-shot helper receives only a newly allocated Redis volume. It never deletes contents.
try {
  const directory = '/redis-data';
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink() || (await readdir(directory)).length) {
    throw new Error('A new empty Redis volume is required');
  }
  await chown(directory, 10001, 10001);
  await chmod(directory, 0o700);
  const verified = await lstat(directory);
  if (verified.uid !== 10001 || verified.gid !== 10001 || (verified.mode & 0o777) !== 0o700) {
    throw new Error('Redis volume ownership was not confirmed');
  }
  process.stdout.write(JSON.stringify({ status: 'EMPTY', uid: 10001, gid: 10001, mode: '0700' }) + '\n');
} catch {
  process.stderr.write('REDIS_RECOVERY_VOLUME_REJECTED: a new empty private volume is required\n');
  process.exitCode = 1;
}
