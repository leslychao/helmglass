import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { withVaultBackupSession } from './vault-backup-session.mjs';

/** Saves through the official CLI, which verifies Vault's sealed snapshot checksums. */
export async function saveVaultSnapshot({ containerId, localCaFile, identity, destination, environment = process.env,
  timeout = 300_000, maximumBytes = 1_073_741_824, beforeSnapshot }) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || !Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error('Invalid Vault snapshot input');
  }
  const parent = await lstat(dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink()
      || (process.platform !== 'win32' && (parent.uid !== process.getuid() || (parent.mode & 0o077)))) {
    throw new Error('Snapshot destination must be an operator-owned protected directory');
  }
  // The destination must be new; a prior successful backup is never replaced.
  try {
    await lstat(destination);
    throw new Error('Snapshot destination already exists');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = `${destination}.${randomUUID()}.pending`;
  let created = false;
  try {
    const result = await withVaultBackupSession({ containerId, localCaFile, identity, environment, timeout },
      async ({ executable, prefix, environment: authenticated, local }) => {
        if (beforeSnapshot) await beforeSnapshot({ executable, prefix, environment: authenticated });
        const checksum = createHash('sha256');
        let bytes = 0;
        const measure = new Transform({
          transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (bytes > maximumBytes) return callback(new Error('Snapshot exceeds configured size limit'));
            checksum.update(chunk);
            callback(null, chunk);
          },
        });
        const output = createWriteStream(pending, { flags: 'wx', mode: 0o600, flush: true });
        output.once('open', () => { created = true; });
        // Node uses a socket for child stdout on Linux. Vault opens /dev/stdout itself, which
        // cannot reopen that socket. The fixed pipeline gives Vault a real pipe; pipefail
        // preserves its checksum/error status and the process group bounds both children.
        const snapshotExecutable = local ? 'bash' : executable;
        const snapshotArguments = local
          ? ['-o', 'pipefail', '-c', 'vault operator raft snapshot save /dev/stdout | cat']
          : [...prefix, 'operator', 'raft', 'snapshot', 'save', '/dev/stdout'];
        const child = spawn(snapshotExecutable, snapshotArguments, {
          env: authenticated, shell: false, windowsHide: true, detached: local,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        function terminate() {
          if (local && child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          } else child.kill();
        }
        let limitReached = false;
        let diagnosticBytes = 0;
        child.stderr.on('data', chunk => {
          diagnosticBytes += chunk.length;
          if (diagnosticBytes > 65_536) { limitReached = true; terminate(); }
        });
        const completion = new Promise((accept, reject) => {
          child.once('error', () => reject(new Error('Vault snapshot process could not start')));
          child.once('close', code => {
            if (code !== 0 || limitReached) reject(new Error('Vault snapshot was not confirmed'));
            else accept();
          });
        });
        const timer = setTimeout(() => { limitReached = true; terminate(); }, timeout);
        try {
          const outcomes = await Promise.allSettled([
            pipeline(child.stdout, measure, output).catch(error => { terminate(); throw error; }),
            completion,
          ]);
          if (outcomes.some(outcome => outcome.status === 'rejected') || bytes === 0) {
            throw new Error('Vault snapshot transfer failed; incomplete file was not published');
          }
        } finally { clearTimeout(timer); }
        return { bytes, sha256: checksum.digest('hex') };
      });
    // The shared session has revoked its token before publication.
    await link(pending, destination);
    return result;
  } finally {
    if (created) await unlink(pending);
  }
}
