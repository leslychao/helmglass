import { spawn } from 'node:child_process';
import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readEnvironmentFile, validateDeployment, validateRelease } from './configuration.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = process.argv[2] ?? '0.1.0';
if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(version)) throw new Error('Release version has an invalid image tag.');
const configuration = validateDeployment(await readEnvironmentFile(new URL('./.env.dev', import.meta.url)));
const environment = { ...process.env, DOCKER_HOST: configuration.DOCKER_HOST };
delete environment.DOCKER_CONTEXT;

function run(command, arguments_, capture = false) {
  return new Promise((accept, reject) => {
    const process_ = spawn(command, arguments_, { cwd: root, shell: false, env: environment,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    if (capture) process_.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 65_536) process_.kill();
    });
    process_.on('error', reject);
    process_.on('exit', (code) => code === 0 ? accept(output.trim()) : reject(new Error(`${command} exited ${code}`)));
  });
}

const images = [
  ['NGINX_IMAGE', 'nginx', 'frontend/Dockerfile', '.'],
  ['API_IMAGE', 'api', 'backend/api/Dockerfile', 'backend'],
  ['MCP_ADAPTER_IMAGE', 'mcp-adapter', 'backend/mcp-adapter/Dockerfile', 'backend/mcp-adapter'],
  ['WORKER_IMAGE', 'browser-worker', 'backend/browser-worker/Dockerfile', 'backend/browser-worker'],
  ['EGRESS_IMAGE', 'egress-proxy', 'Deploy/egress-proxy/Dockerfile', '.'],
  ['TURN_IMAGE', 'coturn', 'Deploy/coturn/Dockerfile', '.'],
  ['POSTGRES_IMAGE', 'postgres', 'Deploy/postgres/Dockerfile', '.'],
  ['REDIS_IMAGE', 'redis', 'Deploy/redis/Dockerfile', '.'],
  ['MINIO_IMAGE', 'minio', 'Deploy/minio/Dockerfile', '.'],
  ['VAULT_IMAGE', 'vault', 'Deploy/vault/Dockerfile', '.'],
  ['KEYCLOAK_IMAGE', 'keycloak', 'Deploy/keycloak/Dockerfile', '.'],
  ['PROVISION_IMAGE', 'provision', 'Deploy/provision/Dockerfile', '.'],
  ['OAUTH_IMAGE', 'oauth2-proxy', 'Deploy/oauth2-proxy/Dockerfile', '.'],
];

const release = {};
const daemon = JSON.parse(await run('docker', ['info', '--format', '{{json .}}'], true));
if (daemon.OSType !== 'linux') throw new Error('The selected Docker daemon must run Linux containers.');
for (const [parameter, service, dockerfile, context] of images) {
  const tag = `helmglass-${service}:${version}`;
  process.stdout.write(`Building ${service}\n`);
  await run('docker', ['build', '--file', resolve(root, dockerfile), '--tag', tag,
    ...(service === 'mcp-adapter' ? ['--build-arg', `FRONTEND_IMAGE=helmglass-nginx:${version}`] : []),
    resolve(root, context)]);
  release[parameter] = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], true);
}
validateRelease(release);
const temporary = resolve(root, 'Deploy/release.env.pending');
await writeFile(temporary, '# Generated immutable images for the selected Docker daemon.\n'
  + Object.entries(release).map(([name, digest]) => `${name}=${digest}\n`).join(''), { flag: 'wx' });
await rename(temporary, resolve(root, 'Deploy/release.env'));
process.stdout.write('Release image manifest written to Deploy/release.env\n');
