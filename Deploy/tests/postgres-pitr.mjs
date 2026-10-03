import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { restorePostgres, stageRecoveryMaterial } from '../recovery-storage.mjs';

const image = process.env.POSTGRES_TEST_IMAGE ?? 'helmglass-postgres:pitr-test';
const owner = randomUUID();
const volumes = [];
const containers = [];
const recoveryId = randomUUID();
function docker(args, { input, allowFailure = false, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout, maxBuffer: 8_388_608 });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`PostgreSQL fixture ${args[0]} failed: ${result.stderr.slice(-2000)}`);
  }
  return allowFailure ? result : result.stdout.trim();
}
function volume(name) {
  const id = 'helm-pitr-' + name + '-' + owner;
  docker(['volume', 'create', '--label', 'helmglass.pitr=' + owner, id]);
  volumes.push(id);
  return id;
}
function mount(source, target, readonly = false) {
  return ['--mount', `type=volume,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
}
function run(args, options) {
  return docker(['run', '--rm', '--network', 'none', '--label', 'helmglass.pitr=' + owner,
    ...args], options);
}
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (check()) return;
    await delay(250);
  }
  throw new Error(label + ' was not confirmed within 30 seconds.');
}
function sql(container, statement) {
  return docker(['exec', '--user', 'postgres', container, 'psql', '--no-psqlrc', '--quiet',
    '--tuples-only', '--no-align', '--username', 'postgres', '--dbname', 'postgres',
    '--set', 'ON_ERROR_STOP=1', '--command', statement]);
}

try {
  const sourceData = volume('source');
  const archive = volume('archive');
  const restored = volume('restored');
  const recipient = volume('recipient');
  const recoveryKeys = volume('recovery-keys');
  const identity = volume('identity');
  const setupMounts = [...mount(archive, '/backup'), ...mount(recipient, '/recipient'),
    ...mount(recoveryKeys, '/keys'), ...mount(identity, '/identity'), ...mount(restored, '/restored')];
  run(['--interactive', ...setupMounts, '--entrypoint', '/bin/sh', image, '-c', `
    set -eu
    umask 077
    cat > /identity/postgres_identity
    openssl rand -base64 32 > /keys/password
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc \
      -pass file:/keys/password -out /keys/private.pem 2>/dev/null
    openssl req -new -x509 -key /keys/private.pem -passin file:/keys/password \
      -out /recipient/public.pem -subj '/CN=Helm isolated PITR fixture' -days 1
    chown -R postgres:postgres /backup /recipient /keys /identity /restored
    chmod 700 /backup /recipient /keys /identity /restored
    chmod 600 /keys/private.pem /keys/password /identity/postgres_identity
  `], { input: JSON.stringify({ schemaVersion: 1, rootPassword: randomBytes(32).toString('base64url'),
    migrationPassword: randomBytes(32).toString('base64url'), apiPassword: randomBytes(32).toString('base64url'),
    keycloakPassword: randomBytes(32).toString('base64url') }) });

  const credentials = ['--env', 'BACKUP_PRIVATE_KEY_FILE=/keys/private.pem',
    '--env', 'BACKUP_KEY_PASSWORD_FILE=/keys/password'];
  run(['--user', 'postgres', '--memory', '256m', '--memory-swap', '256m',
    ...mount(recoveryKeys, '/keys', true), ...mount(recipient, '/recipient', true),
    ...credentials, '--env', 'BACKUP_RECIPIENT_CERT=/recipient/public.pem', '--entrypoint', '/bin/sh', image, '-c', `
    set -eu
    work=$(mktemp -d)
    trap 'rm -rf -- "$work"' EXIT
    printf 'Authenticated backup fixture' > "$work/plain"
    /opt/helm/bin/backup-crypto encrypt "$work/plain" "$work/cipher"
    /opt/helm/bin/backup-crypto decrypt "$work/cipher" "$work/decoded"
    cmp "$work/plain" "$work/decoded"
    openssl cms -encrypt -binary -outform DER -aes-256-cbc -in "$work/plain" \
      -out "$work/unauthenticated" -recip /recipient/public.pem
    if /opt/helm/bin/backup-crypto decrypt "$work/unauthenticated" "$work/rejected" 2>/dev/null; then exit 1; fi
    test ! -e "$work/rejected"
    openssl cms -encrypt -binary -outform DER -aes-256-gcm -in "$work/plain" \
      -out "$work/altered" -recip /recipient/public.pem
    final_offset=$(($(wc -c < "$work/altered")-1))
    final_byte=$(od -An -tu1 -j "$final_offset" -N 1 "$work/altered")
    # Definite-length CMS ends in the GCM tag; flip it without breaking ASN.1.
    replacement=$(printf '%03o' "$((final_byte ^ 1))")
    printf "\\\\$replacement" | dd of="$work/altered" bs=1 seek="$final_offset" conv=notrunc status=none
    openssl cms -cmsout -inform DER -in "$work/altered" -noout
    if /opt/helm/bin/backup-crypto decrypt "$work/altered" "$work/rejected" 2>/dev/null; then exit 1; fi
    test ! -e "$work/rejected"
    size=$(wc -c < "$work/cipher")
    truncate -s "$((size-1))" "$work/cipher"
    if /opt/helm/bin/backup-crypto decrypt "$work/cipher" "$work/rejected" 2>/dev/null; then exit 1; fi
    test ! -e "$work/rejected"
    test -z "$(find "$work" -name '.crypto.*' -print)"
    dd if=/dev/zero of="$work/large" bs=1M count=96 status=none
    /opt/helm/bin/backup-file encrypt "$work/large" "$work/chunked"
    /opt/helm/bin/backup-file decrypt "$work/chunked" "$work/large-decoded"
    cmp "$work/large" "$work/large-decoded"
    truncate -s 1 "$work/chunked/00000001.cms"
    if /opt/helm/bin/backup-file decrypt "$work/chunked" "$work/rejected" 2>/dev/null; then exit 1; fi
    test ! -e "$work/rejected"
    test -z "$(find "$work" -name '.backup-file.*' -print)"
  `]);

  const source = docker(['run', '--detach', '--network', 'none', '--label', 'helmglass.pitr=' + owner,
    ...mount(sourceData, '/var/lib/postgresql'), ...mount(archive, '/backup'), ...mount(recipient, '/recipient', true),
    ...mount(identity, '/run/secrets', true), '--tmpfs', '/run:size=16m,mode=0755',
    '--tmpfs', '/backup-work:size=512m,uid=999,gid=999,mode=0700',
    '--env', 'BACKUP_DIR=/backup', '--env', 'BACKUP_WORK_DIR=/backup-work',
    '--env', 'BACKUP_RECIPIENT_CERT=/recipient/public.pem', image]);
  containers.push(source);
  await waitFor(() => docker(['exec', '--user', 'postgres', source, '/bin/sh', '-c',
    'test "$(cat /proc/1/comm)" = postgres && pg_isready --quiet'],
    { allowFailure: true }).status === 0, 'Source PostgreSQL readiness');
  sql(source, 'CREATE TABLE pitr_fixture(id integer PRIMARY KEY); INSERT INTO pitr_fixture VALUES (1)');
  const base = docker(['exec', '--user', 'postgres', source, '/opt/helm/bin/backup-base', 'verified-base']);
  const system = sql(source, 'SELECT system_identifier FROM pg_control_system()');
  assert.match(base, /^\/backup\/postgres\/[0-9]+\/base\/verified-base$/);
  sql(source, 'INSERT INTO pitr_fixture VALUES(2)');
  const targetLsn = sql(source, "SELECT pg_create_restore_point('verified_target')");
  sql(source, 'INSERT INTO pitr_fixture VALUES(3)');
  const wal = sql(source, 'SELECT pg_walfile_name(pg_current_wal_lsn())');
  sql(source, 'SELECT pg_switch_wal()');
  await waitFor(() => docker(['exec', '--user', 'postgres', source, 'test', '-f',
    `/backup/postgres/${system}/wal/${wal}/manifest.json`], { allowFailure: true }).status === 0,
  'WAL archive through the production archive_command');
  assert.equal(sql(source, 'SELECT count(*) FROM pitr_fixture'), '3');
  const archivedHash = docker(['exec', '--user', 'postgres', source, 'sha256sum',
    `/backup/postgres/${system}/wal/${wal}/wal.cms`]);
  docker(['exec', '--user', 'postgres', source, '/opt/helm/bin/archive-wal',
    `/var/lib/postgresql/18/docker/pg_wal/${wal}`, wal]);
  assert.equal(docker(['exec', '--user', 'postgres', source, 'sha256sum',
    `/backup/postgres/${system}/wal/${wal}/wal.cms`]), archivedHash, 'Archive retry preserves the published object');

  const restoreMounts = [...mount(archive, '/backup', true), ...mount(restored, '/restored'), ...mount(recoveryKeys, '/keys', true)];
  run(['--user', 'postgres', ...restoreMounts, ...credentials, '--entrypoint', '/opt/helm/bin/restore-base',
    image, base, '/restored/data', 'name', 'verified_target']);
  const recovery = docker(['run', '--detach', '--network', 'none', '--user', 'postgres',
    '--label', 'helmglass.pitr=' + owner, ...restoreMounts, ...credentials,
    '--env', 'BACKUP_DIR=/backup', '--env', 'BACKUP_SYSTEM_IDENTIFIER=' + system,
    '--tmpfs', '/var/run/postgresql:uid=999,gid=999,mode=0700', '--entrypoint', 'postgres',
    image, '-D', '/restored/data']);
  containers.push(recovery);
  await waitFor(() => {
    const result = docker(['exec', '--user', 'postgres', recovery, 'psql', '--no-psqlrc', '--quiet',
      '--tuples-only', '--no-align', '--username', 'postgres', '--dbname', 'postgres', '--command',
      "SELECT pg_get_wal_replay_pause_state()"], { allowFailure: true });
    return result.status === 0 && result.stdout.trim() === 'paused';
  }, 'Paused point-in-time recovery');
  assert.equal(sql(recovery, 'SELECT string_agg(id::text,\',\' ORDER BY id) FROM pitr_fixture'), '1,2');
  assert.equal(sql(recovery, 'SELECT pg_is_in_recovery()'), 't');
  assert.equal(sql(recovery, 'SELECT pg_last_wal_replay_lsn()'), targetLsn);
  assert.equal(sql(recovery, 'SHOW listen_addresses'), '');
  const immutable = docker(['exec', '--user', 'postgres', recovery, 'psql', '--no-psqlrc',
    '--username', 'postgres', '--dbname', 'postgres', '--set', 'ON_ERROR_STOP=1', '--command',
    'INSERT INTO pitr_fixture VALUES(4)'], { allowFailure: true });
  assert.notEqual(immutable.status, 0, 'Recovery does not admit writes before deployment fencing');
  docker(['stop', '--time', '30', recovery]);
  for (const target of ['/restored/rejected-promotion', '/restored/promotion']) {
    run(['--user', 'postgres', ...restoreMounts, ...credentials, '--entrypoint', '/opt/helm/bin/restore-base',
      image, base, target, 'name', 'verified_target']);
  }
  const promotion = ['--user', 'postgres', ...restoreMounts, ...credentials,
    '--env', 'BACKUP_DIR=/backup', '--env', 'BACKUP_SYSTEM_IDENTIFIER=' + system,
    '--tmpfs', '/var/run/postgresql:uid=999,gid=999,mode=0700',
    '--entrypoint', '/opt/helm/bin/recover-and-stop', image];
  assert.notEqual(run([...promotion, '/restored/rejected-promotion', system, 'verified_target', '0/1'], { allowFailure: true }).status, 0,
    'A different LSN cannot promote even when the configured restore point is paused');
  const receipt = JSON.parse(run([...promotion, '/restored/promotion', system, 'verified_target', targetLsn]));
  assert.deepEqual(receipt, { schemaVersion: 1, systemIdentifier: system,
    targetName: 'verified_target', targetLsn, state: 'PROMOTED_AND_STOPPED' });
  const controlState = run(['--user', 'postgres', ...restoreMounts, '--entrypoint', 'pg_controldata', image, '/restored/promotion']);
  assert.match(controlState, /Database cluster state:\s+shut down\b/);
  assert.notEqual(run([...promotion, '/restored/promotion', system, 'verified_target', targetLsn], { allowFailure: true }).status, 0,
    'A promoted directory is not blindly promoted again after a lost acknowledgement');
  const resumed = docker(['run', '--detach', '--network', 'none', '--label', 'helmglass.pitr=' + owner,
    ...restoreMounts, ...mount(identity, '/run/secrets', true), '--tmpfs', '/run:size=16m,mode=0755',
    '--env', 'PGDATA=/restored/promotion', image]);
  containers.push(resumed);
  await waitFor(() => docker(['exec', '--user', 'postgres', resumed, '/bin/sh', '-c',
    'test "$(cat /proc/1/comm)" = postgres && pg_isready --quiet'],
  { allowFailure: true }).status === 0, 'Normal entrypoint after isolated promotion');
  assert.equal(sql(resumed, 'SHOW listen_addresses'), '*');
  assert.equal(sql(resumed, 'SELECT pg_is_in_recovery()'), 'f');
  assert.equal(sql(resumed, 'SHOW recovery_target_name'), '');
  assert.equal(sql(resumed, 'SHOW restore_command'), '');
  const connected = docker(['exec', '--user', 'postgres', resumed, '/bin/sh', '-c',
    'PGPASSWORD=$(jq -er .rootPassword /run/secrets/postgres_identity) psql --no-psqlrc --host 127.0.0.1 --username postgres --dbname postgres --tuples-only --no-align --command "SELECT count(*) FROM pitr_fixture"']);
  assert.equal(connected, '2');
  // Exercise the same volume ownership, material delivery and preserved-process owner as restore.mjs.
  const scratch = volume('recovery-work');
  run([...mount(scratch, '/scratch'), '--entrypoint', '/bin/sh', image, '-c',
    'chown 999:999 /scratch && chmod 700 /scratch']);
  const mountpoint = name => JSON.parse(docker(['volume', 'inspect', name]))[0].Mountpoint;
  const configuration = { INSTALLATION_ID: 'pitr-fixture', BACKUP_DIR: mountpoint(archive),
    BACKUP_WORK_DIR: mountpoint(scratch) };
  const release = { POSTGRES_IMAGE: image, PROVISION_IMAGE: process.env.PROVISION_TEST_IMAGE ?? 'helmglass-provision:recovery-test' };
  const transport = async (args, options = {}) => ({ stdout: docker(args, options) });
  let recoveryState = { recoveryId, storage: { postgresVolume: `helm-glass-pg-recovery-${recoveryId}` } };
  const privateKeyPem = run([...mount(recoveryKeys, '/keys', true), '--entrypoint', 'cat', image, '/keys/private.pem']) + '\n';
  const password = run([...mount(recoveryKeys, '/keys', true), '--entrypoint', 'cat', image, '/keys/password']);
  await stageRecoveryMaterial({ docker: transport, configuration, release, state: recoveryState,
    mode: 'keys', input: { privateKeyPem, password } });
  const restoreInput = { docker: transport, configuration, release,
    manifest: { postgres: { systemIdentifier: system, directory: base.slice('/backup/'.length),
      restorePoint: 'verified_target', restoreLsn: targetLsn } },
    saveState: async value => { recoveryState = value; } };
  const completed = await restorePostgres({ ...restoreInput, state: recoveryState });
  assert.equal(completed.physical.postgres.state, 'PROMOTED_AND_STOPPED');
  const started = docker(['inspect', '--format', '{{.State.StartedAt}}', completed.physical.postgres.recoveryContainer]);
  assert.deepEqual(await restorePostgres({ ...restoreInput, state: completed }), completed);
  assert.equal(docker(['inspect', '--format', '{{.State.StartedAt}}', completed.physical.postgres.recoveryContainer]), started);
  await assert.rejects(restorePostgres({ ...restoreInput, state: completed,
    manifest: { postgres: { ...restoreInput.manifest.postgres, restoreLsn: '0/1' } } }), /different ownership/);
  assert.equal((await stageRecoveryMaterial({ docker: transport, configuration, release,
    state: completed, mode: 'clear-keys' })).state, 'REMOVED');
  const reopened = docker(['run', '--detach', '--network', 'none', '--label', 'helmglass.pitr=' + owner,
    ...mount(completed.storage.postgresVolume, '/var/lib/postgresql'), ...mount(identity, '/run/secrets', true),
    '--tmpfs', '/run:size=16m,mode=0755', image]);
  containers.push(reopened);
  await waitFor(() => docker(['exec', '--user', 'postgres', reopened, 'pg_isready', '--quiet'],
    { allowFailure: true }).status === 0, 'Restored volume production startup');
  assert.equal(sql(reopened, "SELECT string_agg(id::text,',' ORDER BY id) FROM pitr_fixture"), '1,2');
  assert.equal(sql(source, 'SELECT count(*) FROM pitr_fixture'), '3', 'Original source storage is unchanged');
  assert.equal(sql(reopened, 'SHOW listen_addresses'), '*');
  process.stdout.write('PASS: encrypted base/WAL, exact target exclusion, paused recovery, production restore owner in a new volume, same-process retry, source preservation, key cleanup and normal TCP restart. Offhost and joint PG/MinIO/Vault recovery are not proven by this fixture.\n');
} finally {
  for (const container of containers.reverse()) {
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "helmglass.pitr"}}', container]), owner);
    docker(['rm', '--force', '--volumes', container]);
  }
  const physicalProcesses = docker(['ps', '--all', '--quiet', '--filter', 'label=helmglass.recovery=' + recoveryId])
    .split(/\s+/).filter(Boolean);
  for (const id of physicalProcesses) {
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "helmglass.installation"}}', id]), 'pitr-fixture');
    docker(['rm', '--force', id]);
  }
  const recoveryVolumes = docker(['volume', 'ls', '--quiet', '--filter', 'label=helmglass.recovery=' + recoveryId])
    .split(/\s+/).filter(Boolean);
  for (const name of recoveryVolumes) {
    assert.equal(docker(['volume', 'inspect', '--format', '{{index .Labels "helmglass.installation"}}', name]), 'pitr-fixture');
    docker(['volume', 'rm', name]);
  }
  for (const name of volumes) {
    assert.equal(docker(['volume', 'inspect', '--format', '{{index .Labels "helmglass.pitr"}}', name]), owner);
    docker(['volume', 'rm', name]);
  }
}
