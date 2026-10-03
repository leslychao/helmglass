import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from '../process.mjs';
import { protectDirectory } from '../protected-files.mjs';
import { createAuthority, createIdentity } from '../tls.mjs';
import { storagePolicy, stagingLifecycle } from '../provision/src/minio-provision.mjs';

const id = 'helm-minio-test-' + randomUUID();
const image = process.env.MINIO_TEST_IMAGE ?? 'helmglass-minio:integration-i';
const context = process.env.HELM_TEST_DOCKER_CONTEXT ?? (process.platform === 'win32' ? 'desktop-linux' : 'default');
const directory = await mkdtemp(join(tmpdir(), id));
const docker = (args, options = {}) => run('docker', ['--context', context, ...args], options);
const data = id + '-data';
const secrets = id + '-secrets';
const testImage = id + ':test';
let container;
let network;
const volumes = [];
let phase = 'TLS fixture';
try {
  await protectDirectory(directory, resolve('.'));
  const caPem = await createAuthority(directory);
  const tls = await createIdentity(directory, 'minio', caPem);
  const identity = { schemaVersion: 1, rootUser: 'fixture-root', rootPassword: randomBytes(32).toString('hex'), tls };
  const input = { installationId: 'fixture', mode: 'apply', identity: { rootUser: identity.rootUser,
    rootPassword: identity.rootPassword, apiAccessKey: randomBytes(15).toString('base64url'),
    apiSecretKey: randomBytes(30).toString('base64url'), caPem }, policy: storagePolicy, lifecycle: stagingLifecycle };
  const dockerfile = `FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS build
WORKDIR /build
COPY Deploy/provision/minio-admin/go.mod Deploy/provision/minio-admin/go.sum ./
RUN go mod download
COPY Deploy/provision/minio-admin/*.go ./
RUN go test ./... && CGO_ENABLED=0 go test -c -o /minio-test .
FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532
COPY --from=build /minio-test /minio-test
USER 10001:10001
ENTRYPOINT ["/minio-test"]
`;
  phase = 'test binary build';
  const build = await docker(['build', '-f', '-', '-t', testImage, '.'],
    { input: dockerfile, timeout: 300_000, maximum: 2_097_152, allowedExitCodes: [0, 1] });
  assert.equal(build.code, 0, build.stderr);
  phase = 'isolated storage';
  await docker(['network', 'create', '--internal', id]);
  network = id;
  for (const volume of [data, secrets]) {
    await docker(['volume', 'create', volume]);
    volumes.push(volume);
  }
  const stage = `import{chown,chmod,writeFile}from'node:fs/promises';const chunks=[];for await(const c of process.stdin)chunks.push(c);const v=JSON.parse(Buffer.concat(chunks));await chown('/data',10001,10001);await chmod('/data',0o700);for(const[name,value]of Object.entries(v)){const path='/secrets/'+name;await writeFile(path,JSON.stringify(value),{mode:0o400});await chown(path,10001,10001)}`;
  await docker(['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0',
    '--mount', `type=volume,source=${data},target=/data`, '--mount', `type=volume,source=${secrets},target=/secrets`,
    '--entrypoint', 'node', image, '--input-type=module', '-e', stage],
  { input: JSON.stringify({ minio_identity: identity, test_input: input }) });
  phase = 'MinIO startup';
  container = (await docker(['run', '-d', '--name', id, '--network', network, '--network-alias', 'minio',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '512m',
    '--tmpfs', '/run:size=32m,uid=10001,gid=10001,mode=0700', '--tmpfs', '/tmp:size=16m',
    '--mount', `type=volume,source=${data},target=/data`,
    '--mount', `type=volume,source=${secrets},target=/run/secrets,readonly`, image])).stdout.trim();
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await docker(['exec', container, '/opt/helm/bin/healthcheck']); healthy = true; break; }
    catch { await delay(500); }
  }
  assert.ok(healthy, 'community MinIO must become healthy through the actual TLS bootstrap');
  for (const file of ['bootstrap.mjs', 'disks.mjs']) {
    const actual = (await docker(['exec', container, 'sha256sum', '/opt/helm/minio/' + file])).stdout.split(' ')[0];
    assert.equal(actual, createHash('sha256').update(await readFile('Deploy/minio/' + file)).digest('hex'));
  }
  phase = 'S3 operations';
  const smoke = await docker(['run', '--rm', '--network', network, '--read-only', '--cap-drop', 'ALL', '--memory', '256m',
    '--mount', `type=volume,source=${secrets},target=/run/secrets,readonly`,
    '-e', 'HELM_MINIO_TEST_INPUT=/run/secrets/test_input', testImage, '-test.run', 'TestCommunityRuntime', '-test.v'],
  { allowedExitCodes: [0, 1] });
  assert.equal(smoke.code, 0, smoke.stdout);
  process.stdout.write('PASS: community MinIO TLS startup without license, exact image sources, three private buckets, scoped service account, multipart PUT, HEAD, Range GET, object DELETE and forbidden out-of-scope writes/ledger deletion.\n');
} catch (error) {
  process.stderr.write(`MinIO fixture failed during ${phase}.\n`);
  throw error;
} finally {
  if (container) await docker(['rm', '-f', container]);
  for (const volume of volumes) await docker(['volume', 'rm', volume]);
  if (network) await docker(['network', 'rm', network]);
  await docker(['image', 'rm', testImage], { allowedExitCodes: [0, 1] });
  await rm(directory, { recursive: true, force: true });
}
