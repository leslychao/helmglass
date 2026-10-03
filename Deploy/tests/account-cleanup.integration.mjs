import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../process.mjs';
import { protectDirectory } from '../protected-files.mjs';
import { createAuthority, createIdentity } from '../tls.mjs';
import { servicePolicy } from '../provision/src/vault-services.mjs';

// Explicit local acceptance harness. All provider credentials and data are disposable.
const id = `helm-account-cleanup-${randomUUID()}`;
const context = process.platform === 'win32' ? 'desktop-linux' : 'default';
const docker = (args, options = {}) => run('docker', ['--context', context, ...args], options);
const provision = 'helmglass-provision:account-cleanup-test';
const images = {
  keycloak: 'quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc',
  vault: 'hashicorp/vault:2.1.1@sha256:47f14a6acb98f48d798a07df7c83f23a6e636e1cf724c5f8ff165cb32667a1e2',
  redis: 'redis:8.4.6-alpine', minio: 'helmglass-minio:integration',
};
const directory = await mkdtemp(join(tmpdir(), id));
const containers = [];
const volumes = [];
let networkCreated = false;
let phase = 'local images';
const secret = () => randomBytes(32).toString('hex');
try {
  const endpoint = (await docker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
  if (!endpoint.startsWith('npipe://') && !endpoint.startsWith('unix://')) {
    throw new Error('Account cleanup acceptance requires a local Docker socket');
  }
  await protectDirectory(directory, resolve('.'));
  await docker(['build', '-f', 'Deploy/provision/Dockerfile', '-t', provision, '.'], { timeout: 300_000 });
  await docker(['image', 'inspect', images.minio], { maximum: 131_072 });
  await docker(['network', 'create', id]);
  networkCreated = true;
  for (const suffix of ['fixture', 'minio', 'redis', 'data']) {
    const name = `${id}-${suffix}`;
    await docker(['volume', 'create', name]);
    volumes.push(name);
  }
  const caPem = await createAuthority(directory);
  const tls = await createIdentity(directory, 'minio', caPem);
  const input = {
    keycloakAddress: 'http://keycloak:8080/auth', bootstrapPassword: secret(), webClientSecret: secret(),
    apiClientSecret: secret(), redisPassword: secret(), oauthRedisPassword: secret(), vaultRootToken: secret(),
    vaultPolicy: servicePolicy('api'), users: ['target', 'retained'].map(name => ({ username: `${name}-${randomUUID()}`, password: secret() })),
    minio: { rootUser: 'fixture-root', rootPassword: secret(), apiAccessKey: randomBytes(10).toString('hex'),
      apiSecretKey: randomBytes(20).toString('hex'), caPem },
  };
  const acl = (await readFile('Deploy/redis/users.acl.template', 'utf8'))
    .replace('HEALTH_PASSWORD_SHA256', createHash('sha256').update(secret()).digest('hex'))
    .replace('API_PASSWORD_SHA256', createHash('sha256').update(input.redisPassword).digest('hex'))
    .replace('OAUTH_PASSWORD_SHA256', createHash('sha256').update(input.oauthRedisPassword).digest('hex'));
  const stage = `import{writeFile,chown,chmod}from'node:fs/promises';const chunks=[];for await(const c of process.stdin)chunks.push(c);const v=JSON.parse(Buffer.concat(chunks));for(const[p,s]of Object.entries(v)){await writeFile(p,s,{mode:0o600});await chown(p,10001,10001)}`;
  await docker(['run', '--rm', '-i', '--network', 'none', '--user', '0', '--entrypoint', 'node',
    '--mount', `type=volume,source=${volumes[0]},target=/fixture`, '--mount', `type=volume,source=${volumes[1]},target=/minio`,
    '--mount', `type=volume,source=${volumes[2]},target=/redis`, '--mount', `type=volume,source=${volumes[3]},target=/data`,
    provision, '--input-type=module', '-e', stage + ';await chown("/data",10001,10001);await chmod("/data",0o700)'],
  { input: JSON.stringify({ '/fixture/input.json': JSON.stringify(input),
    '/minio/minio_identity': JSON.stringify({ schemaVersion: 1, rootUser: input.minio.rootUser, rootPassword: input.minio.rootPassword, tls }),
    '/redis/users.acl': acl }) });
  async function start(name, args) {
    const container = (await docker(['run', '-d', '--name', `${id}-${name}`, '--network', id, '--network-alias', name,
      '--label', `helm.acceptance=${id}`, ...args])).stdout.trim();
    containers.push(container);
    return container;
  }
  phase = 'provider startup';
  await start('minio', ['--mount', `type=volume,source=${volumes[3]},target=/data`, '--tmpfs', '/run:uid=10001,gid=10001,mode=0700',
    '--tmpfs', '/tmp', '--mount', `type=volume,source=${volumes[1]},target=/run/secrets,readonly`, images.minio]);
  await start('redis', ['--user', '10001:10001', '--mount', `type=volume,source=${volumes[2]},target=/fixture,readonly`,
    images.redis, 'redis-server', '--save', '', '--appendonly', 'no', '--aclfile', '/fixture/users.acl']);
  await start('keycloak', ['--memory', '1g', '--cpus', '1.5', '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=acceptance-bootstrap',
    '-e', `KC_BOOTSTRAP_ADMIN_PASSWORD=${input.bootstrapPassword}`, images.keycloak, 'start-dev', '--http-relative-path=/auth']);
  const vault = await start('vault', ['-e', `VAULT_DEV_ROOT_TOKEN_ID=${input.vaultRootToken}`, images.vault,
    'server', '-dev-tls', '-dev-tls-cert-dir=/tmp', '-dev-tls-san=vault', '-dev-listen-address=0.0.0.0:8200', '-dev-no-store-token']);
  const wait = `const until=Date.now()+120000;while(Date.now()<until){try{const r=await fetch('http://keycloak:8080/auth/realms/master',{signal:AbortSignal.timeout(2000)});await r.body?.cancel();if(r.ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,500))}process.exit(1)`;
  await docker(['run', '--rm', '--network', id, '--entrypoint', 'node', provision, '-e', wait], { timeout: 125_000 });
  input.vaultCaPem = (await docker(['exec', vault, 'cat', '/tmp/vault-ca.pem'], { maximum: 16_384 })).stdout;
  await docker(['run', '--rm', '-i', '--network', 'none', '--user', '0', '--entrypoint', 'node',
    '--mount', `type=volume,source=${volumes[0]},target=/fixture`, provision, '--input-type=module', '-e', stage],
  { input: JSON.stringify({ '/fixture/input.json': JSON.stringify(input) }) });
  phase = 'canonical provisioning';
  const bootstrap = await start('bootstrap', ['--user', '0', '--entrypoint', 'node',
    '--mount', `type=volume,source=${volumes[0]},target=/fixture`, provision, '-e', 'setInterval(()=>{},60000)']);
  await docker(['cp', 'Deploy/provision/tests', `${bootstrap}:/opt/helm/provision/tests`]);
  await docker(['exec', bootstrap, 'node', '/opt/helm/provision/tests/account-cleanup-bootstrap.mjs'], { timeout: 150_000 });
  phase = 'real provider cleanup owner test';
  process.stdout.write('Disposable providers ready; running AccountCleanupProvidersIntegrationTest.\n');
  await docker(['run', '--rm', '--name', `${id}-maven`, '--network', id,
    '--env', 'DOCKER_HOST=unix:///var/run/docker.sock', '--env', 'TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal',
    '--env', 'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock', '--env', 'HELM_ACCOUNT_PROVIDER_FIXTURE=/fixture/input.json',
    '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--mount', `type=bind,source=${resolve('backend')},target=/workspace`,
    '--mount', `type=bind,source=${resolve(process.env.USERPROFILE ?? process.env.HOME, '.m2')},target=/root/.m2`,
    '--mount', `type=volume,source=${volumes[0]},target=/fixture,readonly`, '--workdir', '/workspace',
    'maven:3.9.16-eclipse-temurin-25', './mvnw', '-B', '-ntp', '-pl', 'api', '-Dtest=AccountCleanupProvidersIntegrationTest,TaskEventMigrationIntegrationTest', 'test'],
  { timeout: 360_000, inherit: true });
  process.stdout.write('PASS: isolated real-provider account cleanup; active-browser closure is outside this fixture.\n');
} catch (error) {
  process.stderr.write(`Account cleanup fixture failed during ${phase}.\n`);
  throw error;
} finally {
  await docker(['rm', '-f', `${id}-maven`], { allowedExitCodes: [0, 1] });
  for (const container of containers.reverse()) await docker(['rm', '-f', container], { allowedExitCodes: [0, 1] });
  for (const volume of volumes) await docker(['volume', 'rm', volume]);
  if (networkCreated) await docker(['network', 'rm', id]);
  await rm(directory, { recursive: true, force: true });
}
