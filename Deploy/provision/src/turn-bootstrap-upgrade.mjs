import { createPrivateKey, X509Certificate } from 'node:crypto';

function exactFields(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
}

function certificates(value) {
  if (typeof value !== 'string' || value.length > 131_072) throw new Error('Invalid legacy TURN TLS');
  const blocks = value.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks?.length || blocks.join('').replaceAll(/\s/g, '') !== value.replaceAll(/\s/g, '')) {
    throw new Error('Invalid legacy TURN TLS');
  }
  return blocks.map(block => new X509Certificate(block));
}

/** Retires only the known TLS fields; the TURN authentication secret is never replaced. */
export function upgradeTurnBootstrap(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 393_216) {
    throw new Error('Invalid TURN bootstrap');
  }
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value.turnSharedSecret !== 'string'
      || !/^[A-Za-z0-9_+/=-]{32,512}$/.test(value.turnSharedSecret)) {
    throw new Error('Invalid TURN bootstrap');
  }
  if (value.schemaVersion === 2 && exactFields(value, ['schemaVersion', 'turnSharedSecret'])) return bytes;
  if (value.schemaVersion !== 1 || !exactFields(value, ['schemaVersion', 'turnSharedSecret', 'tls'])
      || !exactFields(value.tls, ['certificatePem', 'privateKeyPem', 'caPem'])) {
    throw new Error('Unsupported TURN bootstrap');
  }
  const chain = certificates(value.tls.certificatePem);
  certificates(value.tls.caPem);
  const key = value.tls.privateKeyPem;
  if (typeof key !== 'string' || key.length > 65_536
      || !/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC )?PRIVATE KEY-----\s*$/.test(key)
      || !chain[0].checkPrivateKey(createPrivateKey(key))) {
    throw new Error('Invalid legacy TURN TLS');
  }
  // Expired TLS credentials can still be retired; they will never be used by the new listener.
  return Buffer.from(JSON.stringify({ schemaVersion: 2, turnSharedSecret: value.turnSharedSecret }));
}
