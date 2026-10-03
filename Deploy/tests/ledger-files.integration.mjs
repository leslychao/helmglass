import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { run } from '../process.mjs';

test('independent ledger preparation binds its installation and manifests current immutable entries',
  { timeout: 60_000 }, async () => {
    const fixture = randomUUID();
    const volume = `helm-ledger-fixture-${fixture}`;
    const installationId = 'ledger-integration';
    const image = 'node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532';
    const docker = (args, options = {}) => run('docker', args, { timeout: 30_000, ...options });
    const base = ['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '10001:10001',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '64m',
      '--mount', `type=volume,source=${volume},target=/ledger`, '--mount',
      `type=bind,source=${resolve('Deploy/provision/src/ledger-files.mjs')},target=/fixture/ledger-files.mjs,readonly`,
      '--entrypoint', 'node', image];
    const call = async input => JSON.parse((await docker([...base, '/fixture/ledger-files.mjs'], {
      input: JSON.stringify({ schemaVersion: 1, installationId, ...input }),
    })).stdout);
    const write = async files => docker([...base, '--input-type=module', '-e',
      'import fs from "node:fs";let data="";for await(const chunk of process.stdin)data+=chunk;'
        + 'for(const [name,body] of Object.entries(JSON.parse(data)))fs.writeFileSync("/ledger/"+name,body,{mode:0o600});'],
    { input: JSON.stringify(files) });
    await docker(['volume', 'create', '--label', `helmglass.acceptance=${fixture}`, volume]);
    try {
      await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--mount', `type=volume,source=${volume},target=/ledger`,
        '--entrypoint', 'node', image, '-e',
        'const fs=require("node:fs");fs.chownSync("/ledger",10001,10001);fs.chmodSync("/ledger",0o700);']);
      assert.equal((await call({ mode: 'prepare' })).status, 'READY');
      assert.equal((await call({ mode: 'prepare' })).status, 'READY');
      await assert.rejects(call({ mode: 'prepare', installationId: 'foreign' }));
      const entry = { schemaVersion: 1, requestId: randomUUID(), userId: randomUUID(),
        identityHash: 'a'.repeat(64), purgeStartedAt: new Date().toISOString() };
      const filename = `${entry.identityHash}-${entry.requestId}.json`;
      const bytes = JSON.stringify(entry);
      await write({ [filename]: bytes, '.pending-incomplete.json': 'not published before purge' });
      const binding = { mode: 'manifest', recoveryId: randomUUID(), backupId: 'backup-fixture',
        restorePoint: 'fixture consistent snapshot' };
      const manifest = await call(binding);
      assert.equal(manifest.recoveryId, binding.recoveryId);
      assert.equal(manifest.source, 'independent-current');
      assert.deepEqual(manifest.entries, [{ key: `control/deletions/${entry.identityHash}/${entry.requestId}.json`,
        sha256: createHash('sha256').update(bytes).digest('hex') }]);
      await write({ [filename]: JSON.stringify({ ...entry, requestId: randomUUID() }) });
      await assert.rejects(call(binding), 'A renamed or inconsistent tombstone cannot become recovery evidence');
    } finally {
      const owner = (await docker(['volume', 'inspect', '--format',
        '{{index .Labels "helmglass.acceptance"}}', volume])).stdout.trim();
      assert.equal(owner, fixture);
      await docker(['volume', 'rm', volume]);
    }
  });
