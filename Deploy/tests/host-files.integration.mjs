import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../process.mjs';
import { isInside, protectDirectory } from '../protected-files.mjs';
import { createAuthority, createIdentity } from '../tls.mjs';

test('daemon-side delivery migrates TURN atomically, retires managed edge TLS and rejects credential drift', { timeout: 180_000 }, async () => {
  const fixture = randomUUID();
  const volume = `helm-bootstrap-delivery-${fixture}`;
  const image = process.env.PROVISION_IMAGE ?? 'helmglass-provision:dev-107';
  const docker = (arguments_, options) => run('docker', ['--context', 'desktop-linux', ...arguments_], options);
  const content = randomBytes(64);
  const acl = (await readFile(new URL('../redis/users.acl.template', import.meta.url), 'utf8'))
    .replaceAll(/(?:HEALTH|API|OAUTH)_PASSWORD_SHA256/g, () => randomBytes(32).toString('hex'));
  const entry = (name, bytes = content) => ({ name, content: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const turnSecret = randomBytes(32).toString('base64url');
  const currentTurn = Buffer.from(JSON.stringify({ schemaVersion: 2, turnSharedSecret: turnSecret }));
  const input = { schemaVersion: 1, installationId: 'delivery-fixture', mode: 'stage',
    files: [entry('turn-bootstrap', currentTurn), entry('api-bootstrap', randomBytes(64)),
      entry('redis-bootstrap.acl', Buffer.from(acl))] };
  const containerArguments = ['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges:true', '--log-driver', 'none', '--pids-limit', '32', '--memory', '128m',
    '--volume', `${volume}:/bootstrap`,
    '--mount', `type=bind,source=${fileURLToPath(new URL('../provision/src', import.meta.url))},target=/opt/helm/provision/src,readonly`,
    '--mount', `type=bind,source=${fileURLToPath(new URL('../redis/users.acl.template', import.meta.url))},target=/opt/helm/redis/users.acl.template,readonly`,
    '--entrypoint', 'node', image];
  const deliver = (value, allowedExitCodes = [0]) => docker([...containerArguments, '/opt/helm/provision/src/host-files.mjs'],
    { input: JSON.stringify(value), allowedExitCodes });
  const temporary = await mkdtemp(join(tmpdir(), 'helm-bootstrap-delivery-'));
  let volumeCreated = false;
  try {
    await protectDirectory(temporary, resolve('.'));
    const caPem = await createAuthority(temporary);
    const tls = await createIdentity(temporary, 'turn-fixture', caPem);
    const legacyTurn = Buffer.from(JSON.stringify({ schemaVersion: 1, turnSharedSecret: turnSecret, tls }));
    await docker(['volume', 'create', '--label', `helmglass.acceptance=${fixture}`, volume]);
    volumeCreated = true;
    const first = await deliver(input);
    assert.deepEqual(JSON.parse(first.stdout), { status: 'READY', count: 3 });
    assert.ok(!first.stdout.includes(content.toString('base64')));
    assert.equal((await deliver({ ...input, mode: 'verify' })).code, 0);
    assert.equal((await deliver(input)).code, 0);
    assert.equal((await deliver({ ...input, installationId: 'different-installation' }, [0, 1])).code, 1);
    assert.equal((await deliver({ ...input, files: [entry('api-bootstrap', randomBytes(64))] }, [0, 1])).code, 1);
    assert.equal((await deliver({ ...input, files: [entry('edge-tls')] }, [0, 1])).code, 1);
    const inspect = () => docker([...containerArguments, '--input-type=module', '-e',
      'import {lstat,readFile,readdir} from "node:fs/promises";import {createHash} from "node:crypto";'
      + 'const path="/bootstrap/turn-bootstrap";const info=await lstat(path);'
      + 'process.stdout.write(JSON.stringify({inode:info.ino,uid:info.uid,gid:info.gid,mode:info.mode&0o777,'
      + 'sha256:createHash("sha256").update(await readFile(path)).digest("hex"),files:await readdir("/bootstrap")}));']);
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {writeFile,chown} from "node:fs/promises";let text="";for await(const chunk of process.stdin)text+=chunk;'
      + 'const input=JSON.parse(text);await writeFile("/bootstrap/turn-bootstrap",Buffer.from(input.turn,"base64"));'
      + 'await writeFile("/bootstrap/edge-tls",Buffer.from(input.edge,"base64"),{mode:0o400,flag:"wx"});'
      + 'await chown("/bootstrap/edge-tls",101,101);'],
    { input: JSON.stringify({ turn: legacyTurn.toString('base64'), edge: content.toString('base64') }) });
    const beforeMigration = JSON.parse((await inspect()).stdout);
    assert.equal((await deliver({ ...input, mode: 'verify' }, [0, 1])).code, 1);
    assert.equal((await deliver({ ...input, installationId: 'another-owner' }, [0, 1])).code, 1);
    const changedTurn = Buffer.from(JSON.stringify({ schemaVersion: 2, turnSharedSecret: randomBytes(32).toString('base64url') }));
    assert.equal((await deliver({ ...input, files: [entry('turn-bootstrap', changedTurn)] }, [0, 1])).code, 1);
    assert.equal((await deliver({ ...input, files: [entry('turn-bootstrap', legacyTurn)] }, [0, 1])).code, 1);
    // An otherwise valid migration cannot write or retire the key if another input drifts.
    assert.equal((await deliver({ ...input, files: [entry('turn-bootstrap', currentTurn),
      entry('api-bootstrap', randomBytes(64))] }, [0, 1])).code, 1);
    assert.deepEqual(JSON.parse((await inspect()).stdout), beforeMigration);
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {writeFile} from "node:fs/promises";await writeFile("/bootstrap/unrelated-secret","fixture",{flag:"wx",mode:0o400});']);
    assert.equal((await deliver(input, [0, 1])).code, 1);
    const rejected = JSON.parse((await inspect()).stdout);
    assert.equal(rejected.sha256, beforeMigration.sha256);
    assert.ok(rejected.files.includes('edge-tls') && rejected.files.includes('unrelated-secret'));
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {unlink,chown} from "node:fs/promises";await unlink("/bootstrap/unrelated-secret");await chown("/bootstrap/edge-tls",0,0);']);
    assert.equal((await deliver(input, [0, 1])).code, 1, 'Never remove a legacy file owned by another principal');
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {chown,writeFile} from "node:fs/promises";await chown("/bootstrap/edge-tls",101,101);'
      + 'let text="";for await(const chunk of process.stdin)text+=chunk;'
      + 'await writeFile("/bootstrap/turn-bootstrap.pending",Buffer.from(text,"base64"),{flag:"wx",mode:0o400});'],
    { input: currentTurn.toString('base64') });
    assert.equal((await deliver(input)).code, 0);
    const migrated = JSON.parse((await inspect()).stdout);
    assert.notEqual(migrated.inode, beforeMigration.inode, 'Commit replaces the file atomically');
    assert.equal(migrated.sha256, entry('turn-bootstrap', currentTurn).sha256);
    assert.equal(migrated.uid, 10001);
    assert.equal(migrated.gid, 10001);
    assert.equal(migrated.mode, 0o400);
    assert.ok(!migrated.files.includes('edge-tls') && !migrated.files.includes('turn-bootstrap.pending'));
    assert.equal((await deliver(input)).code, 0);
    assert.deepEqual(JSON.parse((await inspect()).stdout), migrated, 'Replay preserves the committed file');
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {symlink} from "node:fs/promises";await symlink("/bootstrap/api-bootstrap","/bootstrap/edge-tls");']);
    assert.equal((await deliver(input, [0, 1])).code, 1);
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {lstat,unlink} from "node:fs/promises";if(!(await lstat("/bootstrap/edge-tls")).isSymbolicLink())throw Error("Fixture link changed");await unlink("/bootstrap/edge-tls");']);
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {writeFile} from "node:fs/promises";let input="";for await(const chunk of process.stdin)input+=chunk;await writeFile("/bootstrap/redis-bootstrap.acl",Buffer.from(input,"base64"));'],
    { input: Buffer.from(acl.replace(' +msetnx +mset +mget +getrange', '')).toString('base64') });
    assert.equal((await deliver({ ...input, mode: 'verify' }, [0, 1])).code, 1);
    const changedPassword = Buffer.from(acl.replace(/#[a-f0-9]{64}/, '#' + '0'.repeat(64)));
    assert.equal((await deliver({ ...input, files: [entry('redis-bootstrap.acl', changedPassword)] }, [0, 1])).code, 1);
    assert.equal((await deliver(input)).code, 0);
    assert.equal((await deliver({ ...input, mode: 'verify' })).code, 0);
    // Interrupt after the complete private file is written, but before ownership/atomic rename.
    const resume = entry('worker-bootstrap', randomBytes(64));
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {writeFile} from "node:fs/promises";let input="";for await(const chunk of process.stdin)input+=chunk;await writeFile("/bootstrap/worker-bootstrap.pending",Buffer.from(input,"base64"),{mode:0o400,flag:"wx"});'],
    { input: resume.content });
    assert.equal((await deliver({ ...input, files: [resume] })).code, 0);
    assert.equal((await deliver({ ...input, mode: 'verify', files: [resume] })).code, 0);
    await docker([...containerArguments, '--input-type=module', '-e',
      'import {symlink} from "node:fs/promises";await symlink("/bootstrap/api-bootstrap","/bootstrap/oauth-bootstrap");']);
    assert.equal((await deliver({ ...input, files: [entry('oauth-bootstrap')] }, [0, 1])).code, 1);
    assert.equal((await deliver({ ...input, mode: 'verify' })).code, 0);
  } finally {
    if (volumeCreated) {
      const actual = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0];
      assert.equal(actual.Labels['helmglass.acceptance'], fixture);
      await docker(['volume', 'rm', volume]);
    }
    const canonical = await realpath(temporary);
    assert.equal(canonical.toLowerCase(), resolve(temporary).toLowerCase());
    assert.ok(isInside(tmpdir(), canonical) && temporary.includes('helm-bootstrap-delivery-'));
    await rm(canonical, { recursive: true });
  }
});
