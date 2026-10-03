import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const directory = '/ledger';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const filenamePattern = new RegExp(`^([a-f0-9]{64})-(${uuid})\\.json$`);
const uuidPattern = new RegExp(`^${uuid}$`);

async function boundedFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 4096
      || metadata.uid !== 10001 || (metadata.mode & 0o077) !== 0) throw new Error('Invalid ledger file');
  return readFile(path);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk.toString('utf8');
    if (Buffer.byteLength(raw) > 16_384) throw new Error('Input exceeds limit');
  }
  const input = JSON.parse(raw);
  if (input.schemaVersion !== 1 || !['prepare', 'manifest'].includes(input.mode)
      || !/^[A-Za-z0-9_-]{1,80}$/.test(input.installationId ?? '')) throw new Error('Invalid ledger input');
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 10001
      || (metadata.mode & 0o777) !== 0o700) throw new Error('Ledger mount must be private and owned by the API');
  const entries = await readdir(directory);
  if (entries.length > 100_001) throw new Error('Ledger inventory exceeds the recovery limit');
  const marker = join(directory, '.helm-ledger.json');
  if (!entries.includes('.helm-ledger.json')) {
    if (input.mode !== 'prepare' || entries.length) throw new Error('Unowned ledger mount');
    const binding = JSON.stringify({ schemaVersion: 1, installationId: input.installationId });
    const file = await open(marker, 'wx', 0o600);
    try { await file.writeFile(binding); await file.sync(); }
    finally { await file.close(); }
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  const binding = JSON.parse((await boundedFile(marker)).toString('utf8'));
  if (binding.schemaVersion !== 1 || binding.installationId !== input.installationId) {
    throw new Error('Ledger belongs to a different installation');
  }
  if (input.mode === 'prepare') {
    process.stdout.write(JSON.stringify({ status: 'READY', installationId: input.installationId }) + '\n');
    return;
  }
  if (!uuidPattern.test(input.recoveryId ?? '') || typeof input.backupId !== 'string'
      || !input.backupId || input.backupId.length > 200 || typeof input.restorePoint !== 'string'
      || !input.restorePoint || input.restorePoint.length > 500) throw new Error('Invalid recovery binding');
  const manifest = [];
  for (const name of entries.sort()) {
    if (name === '.helm-ledger.json' || /^\.pending-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const matched = filenamePattern.exec(name);
    if (!matched) throw new Error('Unknown ledger object');
    const bytes = await boundedFile(join(directory, name));
    const entry = JSON.parse(bytes.toString('utf8'));
    if (entry.schemaVersion !== 1 || entry.identityHash !== matched[1] || entry.requestId !== matched[2]
        || !uuidPattern.test(entry.userId ?? '') || !Number.isFinite(Date.parse(entry.purgeStartedAt))) {
      throw new Error('Invalid immutable tombstone');
    }
    manifest.push({ key: `control/deletions/${matched[1]}/${matched[2]}.json`,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, recoveryId: input.recoveryId,
    backupId: input.backupId, restorePoint: input.restorePoint, capturedAt: new Date().toISOString(),
    source: 'independent-current', entries: manifest }) + '\n');
}

main().catch(() => {
  process.stderr.write('INDEPENDENT_LEDGER_UNAVAILABLE: verify the current protected ledger directory and installation binding\n');
  process.exitCode = 1;
});
