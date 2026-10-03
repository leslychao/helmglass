import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { run } from '../process.mjs';

test('daemon-side delivery protects file ownership, rejects drift and resumes a confirmed interrupted write', { timeout: 120_000 }, async () => {
  const fixture = randomUUID();
  const volume = `helm-bootstrap-delivery-${fixture}`;
  const image = process.env.PROVISION_IMAGE ?? 'helmglass-provision:0.1.0';
  const docker = (arguments_, options) => run('docker', arguments_, options);
  const content = randomBytes(64);
  const acl = (await readFile(new URL('../redis/users.acl.template', import.meta.url), 'utf8'))
    .replaceAll(/(?:HEALTH|API|OAUTH)_PASSWORD_SHA256/g, () => randomBytes(32).toString('hex'));
  const entry = (name, bytes = content) => ({ name, content: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const input = { schemaVersion: 1, installationId: 'delivery-fixture', mode: 'stage',
    files: [entry('edge-tls'), entry('api-bootstrap', randomBytes(64)),
      entry('backup-recipient', Buffer.from('Public certificate transport fixture')),
      entry('redis-bootstrap.acl', Buffer.from(acl))] };
  const containerArguments = ['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges:true', '--log-driver', 'none', '--pids-limit', '32', '--memory', '128m',
    '--volume', `${volume}:/bootstrap`, '--entrypoint', 'node', image];
  const deliver = (value, allowedExitCodes = [0]) => docker([...containerArguments, '/opt/helm/provision/src/host-files.mjs'],
    { input: JSON.stringify(value), allowedExitCodes });
  await docker(['volume', 'create', '--label', `helmglass.acceptance=${fixture}`, volume]);
  try {
    const first = await deliver(input);
    assert.deepEqual(JSON.parse(first.stdout), { status: 'READY', count: 4 });
    assert.ok(!first.stdout.includes(content.toString('base64')));
    assert.equal((await deliver({ ...input, mode: 'verify' })).code, 0);
    assert.equal((await deliver(input)).code, 0);
    assert.equal((await deliver({ ...input, installationId: 'different-installation' }, [0, 1])).code, 1);
    assert.equal((await deliver({ ...input, files: [entry('edge-tls', randomBytes(64))] }, [0, 1])).code, 1);
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
    const actual = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0];
    assert.equal(actual.Labels['helmglass.acceptance'], fixture);
    await docker(['volume', 'rm', volume]);
  }
});
