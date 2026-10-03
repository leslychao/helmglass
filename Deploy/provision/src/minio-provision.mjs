import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { ProvisioningError } from './keycloak-client.mjs';

export const storageBuckets = ['hg-artifacts', 'hg-browser-profiles', 'hg-staging'];
export const storagePolicy = {
  Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketVersions', 's3:ListBucketMultipartUploads'],
      Resource: storageBuckets.map(bucket => `arn:aws:s3:::${bucket}`) },
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:GetObjectVersion', 's3:DeleteObjectVersion',
      's3:AbortMultipartUpload', 's3:ListMultipartUploadParts', 's3:GetObjectTagging', 's3:PutObjectTagging'],
      Resource: storageBuckets.map(bucket => `arn:aws:s3:::${bucket}/u/*`) },
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'],
      Resource: ['arn:aws:s3:::hg-staging/control/deletions/*'] },
  ],
};
export const stagingLifecycle = { Rules: [{ ID: 'helm-approved-orphans', Status: 'Enabled',
  Filter: { And: { Prefix: 'u/', Tags: [{ Key: 'helm-gc', Value: 'approved' }] } }, Expiration: { Days: 1 } }] };

function fail(code) {
  return new ProvisioningError(code, 'MinIO provisioning did not complete; reconcile the protected installation checkpoint.');
}

export function validateStorageInput(input, installationId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(installationId ?? '') || !input
      || !/^[A-Za-z0-9_-]{3,64}$/.test(input.rootUser ?? '')
      || !/^[A-Za-z0-9_-]{16,64}$/.test(input.apiAccessKey ?? '')
      || input.apiAccessKey === input.rootUser
      || typeof input.caPem !== 'string' || input.caPem.length > 65_536
      || !input.caPem.includes('-----BEGIN CERTIFICATE-----')) throw fail('S3_INPUT_INVALID');
  for (const name of ['rootPassword', 'apiSecretKey']) {
    if (typeof input[name] !== 'string' || input[name].length < 32 || input[name].length > 256
        || /[\r\n\0]/.test(input[name])) throw fail('S3_INPUT_INVALID');
  }
}

function sdk(input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/opt/helm/bin/minio-admin', [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 95_000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 65_536) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.once('error', () => { clearTimeout(timer); reject(fail('S3_SDK_UNAVAILABLE')); });
    child.once('close', code => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reject(fail('S3_RESULT_UNKNOWN')); return; }
      if (code !== 0 || size > 65_536) {
        reject(fail(/^S3_[A-Z_]+$/.test(result?.error ?? '') ? result.error : 'S3_RESULT_UNKNOWN')); return;
      }
      if (typeof result.accountExists !== 'boolean' || typeof result.verified !== 'boolean'
          || !isDeepStrictEqual(Object.keys(result.buckets ?? {}).sort(), [...storageBuckets].sort())
          || storageBuckets.some(bucket => typeof result.buckets[bucket] !== 'boolean')) {
        reject(fail('S3_RESULT_INVALID')); return;
      }
      resolve(result);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

/** Checkpoint is the installation's scoped Vault KV CAS owner, not local process state. */
export async function provisionMinio(input, installationId, checkpoint) {
  validateStorageInput(input, installationId);
  if (!checkpoint?.read || !checkpoint.compareAndSet) throw fail('S3_CHECKPOINT_REQUIRED');
  const owner = { schemaVersion: 1, installationId, buckets: [...storageBuckets], apiAccessKey: input.apiAccessKey, rootUser: input.rootUser };
  const request = { installationId, identity: input, policy: storagePolicy, lifecycle: stagingLifecycle };
  let stored = await checkpoint.read();
  if (stored.value === null) {
    const existing = await sdk({ ...request, mode: 'inspect' });
    if (existing.accountExists || storageBuckets.some(bucket => existing.buckets[bucket])) throw fail('S3_OWNERSHIP_CONFLICT');
    stored = await checkpoint.compareAndSet({ ...owner, status: 'PENDING' }, stored.version);
  }
  const { status, ...binding } = stored.value;
  if (!isDeepStrictEqual(binding, owner) || !['PENDING', 'READY'].includes(status)) throw fail('S3_CHECKPOINT_CONFLICT');
  // READY is read-only: an absent or disabled identity never becomes an invitation to recreate it.
  const result = await sdk({ ...request, mode: status === 'READY' ? 'verify' : 'apply' });
  if (!result.verified) throw fail('S3_VERIFICATION_REQUIRED');
  if (status !== 'READY') await checkpoint.compareAndSet({ ...owner, status: 'READY' }, stored.version);
  return { status: 'completed', buckets: [...storageBuckets], serviceIdentity: 'helm-api-storage' };
}
