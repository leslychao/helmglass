import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chown, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';

const root = await mkdtemp('/tmp/minio-cold-fixture-');
const data = ['/data1', '/data2', '/data3', '/data4'];
const expected = [];
function run(command, args, { failure = false, env = {} } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ...env }, maxBuffer: 1_048_576 });
  if (failure) assert.notEqual(result.status, 0);
  else assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  await mkdir(root + '/archive', { mode: 0o700 });
  await mkdir(root + '/scratch', { mode: 0o700 });
  if (process.getuid() === 0) {
    await chown(root + '/archive', 999, 999);
    await chown(root + '/scratch', 999, 999);
  }
  await writeFile(root + '/password', randomBytes(32).toString('base64url'), { mode: 0o600 });
  run('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-aes-256-cbc',
    '-pass', 'file:' + root + '/password', '-out', root + '/key']);
  run('openssl', ['req', '-new', '-x509', '-key', root + '/key', '-passin', 'file:' + root + '/password',
    '-out', root + '/cert', '-subj', '/CN=Cold archive fixture', '-days', '1']);
  const env = { BACKUP_DIR: root + '/archive', BACKUP_WORK_DIR: root + '/scratch',
    BACKUP_RECIPIENT_CERT: root + '/cert', BACKUP_PRIVATE_KEY_FILE: root + '/key',
    BACKUP_KEY_PASSWORD_FILE: root + '/password' };
  for (const [index, disk] of data.entries()) {
    assert.deepEqual(await readdir(disk), []);
    await mkdir(disk + '/u', { mode: 0o700 });
    expected.push(randomBytes(65_536 + index));
    await writeFile(disk + '/u/object', expected[index], { mode: 0o600 });
    if (process.getuid() === 0) {
      await chown(disk + '/u', 10001, 10001);
      await chown(disk + '/u/object', 10001, 10001);
    }
  }
  const command = ['node', '/opt/helm/minio/cold-archive.mjs'];
  const receipt = JSON.parse(run(command[0], [...command.slice(1), 'backup', 'fixture', 'verified'], { env }));
  assert.match(receipt.manifestSha256, /^[0-9a-f]{64}$/);
  for (const disk of data) await rm(disk + '/u', { recursive: true });

  run(command[0], [...command.slice(1), 'restore', 'fixture', 'verified', receipt.directory, '0'.repeat(64)], { env, failure: true });
  for (const disk of data) assert.deepEqual(await readdir(disk), [], 'Wrong parent manifest never changes targets');

  const cipher = receipt.directory + '/disk4/00000000.cms';
  const original = await readFile(cipher);
  await writeFile(cipher, original.subarray(0, original.length - 1));
  run(command[0], [...command.slice(1), 'restore', 'fixture', 'verified', receipt.directory, receipt.manifestSha256], { env, failure: true });
  for (const disk of data) assert.deepEqual(await readdir(disk), [], 'No target changes before all four archives verify');
  await writeFile(cipher, original);
  run(command[0], [...command.slice(1), 'restore', 'other-installation', 'verified', receipt.directory, receipt.manifestSha256], { env, failure: true });
  for (const disk of data) assert.deepEqual(await readdir(disk), []);

  // Valid encryption does not make hostile tar entries safe to extract.
  for (const kind of ['link', 'traversal']) {
    const hostile = root + '/hostile-' + kind;
    const archive = root + '/archive-' + kind;
    await mkdir(hostile, { mode: 0o700 });
    await mkdir(hostile + '/data', { mode: 0o700 });
    await writeFile(hostile + '/metadata.json', JSON.stringify({ schemaVersion: 1,
      format: 'helm-minio-cold-v1', installationId: 'fixture', backupId: 'verified', diskIndex: 4 }));
    if (kind === 'link') await symlink('/tmp/escape', hostile + '/data/escape');
    else await writeFile(hostile + '/data/escape', 'fixture');
    const tar = root + '/hostile-' + kind + '.tar';
    run('tar', ['--create', '--file', tar, '--directory', hostile, 'metadata.json', 'data',
      ...(kind === 'traversal' ? ['--transform', 's,^data/,../escape/,'] : [])]);
    await cp(receipt.directory, archive, { recursive: true });
    await rm(archive + '/disk4', { recursive: true });
    run('/opt/helm/bin/backup-file', ['encrypt', tar, archive + '/disk4'], { env });
    const manifest = JSON.parse(await readFile(archive + '/manifest.json', 'utf8'));
    manifest.disks[3].plaintextByteLength = (await stat(tar)).size;
    manifest.disks[3].manifestSha256 = createHash('sha256')
      .update(await readFile(archive + '/disk4/manifest.json')).digest('hex');
    await writeFile(archive + '/manifest.json', JSON.stringify(manifest));
    const hostileHash = createHash('sha256').update(await readFile(archive + '/manifest.json')).digest('hex');
    run(command[0], [...command.slice(1), 'restore', 'fixture', 'verified', archive, hostileHash], { env, failure: true });
    for (const disk of data) assert.deepEqual(await readdir(disk), [], 'Authenticated hostile tar never changes targets');
  }

  const restored = JSON.parse(run(command[0], [...command.slice(1), 'restore', 'fixture', 'verified', receipt.directory, receipt.manifestSha256], { env }));
  assert.equal(restored.restoredDisks, 4);
  for (const [index, disk] of data.entries()) {
    assert.deepEqual(await readFile(disk + '/u/object'), expected[index]);
    assert.equal((await stat(disk + '/u/object')).uid, 10001);
  }
  run(command[0], [...command.slice(1), 'restore', 'fixture', 'verified', receipt.directory, receipt.manifestSha256], { env, failure: true });
  await symlink('/data1/u/object', '/data1/unsafe-link');
  run(command[0], [...command.slice(1), 'backup', 'fixture', 'unsafe'], { env, failure: true });
  await unlink('/data1/unsafe-link');
  assert.deepEqual(await readdir(root + '/scratch'), []);
  process.stdout.write('PASS: four-volume encrypted cold roundtrip, corrupt fourth disk leaves every target empty, installation binding, hostile tar links/traversal, nonempty-target and source-symlink rejection. This fixture does not run AIStor or prove offhost durability.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
