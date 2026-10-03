import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { run } from './process.mjs';
import { readProtectedFile, writeProtectedFile } from './protected-files.mjs';

const openssl = process.env.OPENSSL_BIN ?? (process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');

export function validateBackupRecipient(pem, now = Date.now()) {
  if (typeof pem !== 'string' || /PRIVATE KEY/.test(pem)
      || (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) {
    throw new Error('Backup recipient must contain one public certificate and no private key');
  }
  const certificate = new X509Certificate(pem);
  if (certificate.publicKey.asymmetricKeyType !== 'rsa'
      || certificate.publicKey.asymmetricKeyDetails.modulusLength < 3072
      || Date.parse(certificate.validFrom) > now
      || Date.parse(certificate.validTo) < now + 86_400_000) {
    throw new Error('Backup recipient must use RSA 3072 or stronger and remain valid for one day');
  }
  return pem;
}

/** Rechecks an installed service identity without silently issuing replacement credentials. */
export function validateInternalIdentity(identity, hostname, client = false, now = Date.now()) {
  const certificate = new X509Certificate(identity.certificatePem);
  const authority = new X509Certificate(identity.caPem);
  const usage = client ? '1.3.6.1.5.5.7.3.2' : '1.3.6.1.5.5.7.3.1';
  if (certificate.ca || !authority.ca || !certificate.checkHost(hostname)
      || !certificate.checkPrivateKey(createPrivateKey(identity.privateKeyPem))
      || !certificate.verify(authority.publicKey) || !certificate.checkIssued(authority)
      || !certificate.keyUsage?.includes(usage)
      || [certificate, authority].some(value => Date.parse(value.validFrom) > now
        || Date.parse(value.validTo) < now + 86_400_000)) {
    throw new Error('Installed TLS identity is invalid or near expiry; explicit certificate rotation is required');
  }
}

export async function readTlsBundle(path, hostname) {
  const pem = (await readProtectedFile(path, 131_072)).toString('utf8');
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  const keys = pem.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/g);
  if (!certificates?.length || keys?.length !== 1) throw new Error('TLS bundle requires a certificate chain and one private key');
  const certificate = new X509Certificate(certificates[0]);
  const expectedName = isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname);
  if (!expectedName || !certificate.checkPrivateKey(createPrivateKey(keys[0]))
      || Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) < Date.now() + 86_400_000) {
    throw new Error('TLS certificate must match the configured host and key and remain valid for at least one day');
  }
  return { certificatePem: certificates.join('\n') + '\n', privateKeyPem: keys[0] + '\n',
    caPem: certificates.slice(1).join('\n') + '\n', pem };
}

export async function createAuthority(directory) {
  const key = join(directory, 'installation-ca.key');
  const certificate = join(directory, 'installation-ca.crt');
  await run(openssl, ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256',
    '-keyout', key, '-out', certificate, '-days', '3650', '-subj', '/CN=Helm Glass installation CA',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:1',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  return readFile(certificate, 'utf8');
}

export async function createIdentity(directory, name, caPem, { client = false } = {}) {
  if (!/^[a-z][a-z0-9-]+$/.test(name)) throw new Error('Invalid internal certificate identity');
  const key = join(directory, `${name}.key`);
  const csr = join(directory, `${name}.csr`);
  const certificate = join(directory, `${name}.crt`);
  const extension = join(directory, `${name}.ext`);
  await run(openssl, ['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-sha256',
    '-keyout', key, '-out', csr, '-subj', `/CN=${name}`]);
  await writeProtectedFile(extension, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
    + `extendedKeyUsage=${client ? 'clientAuth' : 'serverAuth'}\nsubjectAltName=DNS:${name}\n`);
  await sign(directory, csr, certificate, extension, 365);
  const identity = { certificatePem: await readFile(certificate, 'utf8'),
    privateKeyPem: await readFile(key, 'utf8'), caPem };
  for (const path of [key, csr, certificate, extension]) await unlink(path);
  return identity;
}

async function sign(directory, csr, certificate, extension, days) {
  await run(openssl, ['x509', '-req', '-in', csr, '-CA', join(directory, 'installation-ca.crt'),
    '-CAkey', join(directory, 'installation-ca.key'), '-set_serial', `0x${randomBytes(16).toString('hex')}`,
    '-days', String(days), '-sha256', '-extfile', extension, '-out', certificate]);
}

export async function signWorkerAuthority(directory, csrPem) {
  if (!csrPem.startsWith('-----BEGIN CERTIFICATE REQUEST-----') || csrPem.length > 16_384) {
    throw new Error('Vault returned an invalid worker authority CSR');
  }
  const csr = join(directory, 'worker-authority.csr');
  const certificate = join(directory, 'worker-authority.crt');
  const extension = join(directory, 'worker-authority.ext');
  await writeProtectedFile(csr, csrPem);
  await writeProtectedFile(extension, 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  try {
    await sign(directory, csr, certificate, extension, 365);
    return (await readFile(certificate, 'utf8')) + (await readFile(join(directory, 'installation-ca.crt'), 'utf8'));
  } finally {
    for (const path of [csr, certificate, extension]) {
      try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
