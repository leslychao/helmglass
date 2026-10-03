import { createPrivateKey, X509Certificate } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { validateDisks } from './disks.mjs';

const identityPath = '/run/secrets/minio_identity';
const runtime = '/run/helm';

async function boundedFile(path, maximum) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximum) throw new Error('Invalid bootstrap file');
  return readFile(path, 'utf8');
}

try {
  process.umask(0o077);
  let disks;
  try {
    disks = await validateDisks();
  } catch {
    throw new Error('MINIO_DISKS_INVALID');
  }
  const identity = JSON.parse(await boundedFile(identityPath, 131_072));
  if (identity.schemaVersion !== 1 || typeof identity.rootUser !== 'string'
      || !/^[A-Za-z0-9_-]{3,64}$/.test(identity.rootUser)
      || typeof identity.rootPassword !== 'string' || identity.rootPassword.length < 32
      || identity.rootPassword.length > 256 || /[\r\n\0]/.test(identity.rootPassword)) {
    throw new Error('Invalid storage identity');
  }
  const certificate = new X509Certificate(identity.tls.certificatePem);
  const authority = new X509Certificate(identity.tls.caPem);
  if (!certificate.checkHost('minio') || !certificate.verify(authority.publicKey)
      || !certificate.checkPrivateKey(createPrivateKey(identity.tls.privateKeyPem))
      || Date.parse(certificate.validFrom) > Date.now()
      || Date.parse(certificate.validTo) < Date.now() + 300_000) {
    throw new Error('Invalid storage TLS identity');
  }
  await mkdir(`${runtime}/certs/CAs`, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(`${runtime}/root-user`, identity.rootUser, { mode: 0o600 }),
    writeFile(`${runtime}/root-password`, identity.rootPassword, { mode: 0o600 }),
    writeFile(`${runtime}/certs/public.crt`, identity.tls.certificatePem, { mode: 0o600 }),
    writeFile(`${runtime}/certs/private.key`, identity.tls.privateKeyPem, { mode: 0o600 }),
    writeFile(`${runtime}/certs/CAs/installation.crt`, identity.tls.caPem, { mode: 0o600 }),
  ]);
  const child = spawn('/usr/bin/minio', ['server', ...disks, '--address', ':9000', '--console-address', '127.0.0.1:9001',
    '--certs-dir', `${runtime}/certs`, '--json'], {
    stdio: 'inherit', env: { ...process.env, MINIO_ROOT_USER_FILE: `${runtime}/root-user`,
      MINIO_ROOT_PASSWORD_FILE: `${runtime}/root-password`, MINIO_BROWSER: 'off' },
  });
  child.once('error', () => { process.stderr.write('MINIO_START_FAILED\n'); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  // Bootstrap contains credentials; raw parser/provider errors must not escape.
  process.stderr.write(error instanceof Error && error.message === 'MINIO_DISKS_INVALID'
    ? 'MINIO_DISKS_INVALID: a private writable persistent data mount is required\n'
    : 'MINIO_BOOTSTRAP_INVALID: protected identity and TLS are required\n');
  process.exitCode = 1;
}
