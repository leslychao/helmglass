import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { run } from '../process.mjs';

test('Recovery material is private, immutable, byte-preserving and bound to its installation', async () => {
  const result = await run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
    '--memory', '128m', '--tmpfs', '/backup-work:size=8m,mode=0700', '--tmpfs', '/recovery:size=8m,mode=0700',
    '--tmpfs', '/storage:size=8m,mode=0700',
    '--mount', `type=bind,source=${resolve('Deploy/provision/src/recovery-material.mjs')},target=/fixture-code/recovery-material.mjs,readonly`,
    '--mount', `type=bind,source=${resolve('Deploy/tests/recovery-material.fixture.mjs')},target=/fixture-code/test.mjs,readonly`,
    '--entrypoint', 'node', process.env.PROVISION_TEST_IMAGE ?? 'helmglass-provision:cold-backup-test',
    '/fixture-code/test.mjs']);
  assert.match(result.stdout, /immutable proof bytes/);
});
