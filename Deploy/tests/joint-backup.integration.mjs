import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { run } from '../process.mjs';

test('Encrypted joint manifest rejects mixed components, duplicate publication and corruption', async () => {
  const result = await run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
    '--memory', '512m', '--tmpfs', '/fixture:size=64m,mode=0700', '--tmpfs', '/tmp:size=32m',
    '--mount', `type=bind,source=${resolve('Deploy/provision/src/joint-backup.mjs')},target=/fixture-code/joint-backup.mjs,readonly`,
    '--mount', `type=bind,source=${resolve('Deploy/tests/joint-backup.fixture.mjs')},target=/fixture-code/test.mjs,readonly`,
    '--entrypoint', 'node', process.env.PROVISION_TEST_IMAGE ?? 'helmglass-provision:cold-backup-test',
    '/fixture-code/test.mjs'], { timeout: 180_000 });
  assert.match(result.stdout, /binding and corruption gate passed/);
});
