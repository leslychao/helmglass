import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSession } from '../dist/src/session.js';

await mkdir('/runtime/fixtures', { recursive: true, mode: 0o700 });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/runtime/fixtures/key.pem',
  '-out', '/runtime/fixtures/cert.pem', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
const cert = await readFile('/runtime/fixtures/cert.pem');
const key = await readFile('/runtime/fixtures/key.pem');
let received = 0;
const gateway = createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, async (request, _response) => {
  assert.equal(request.socket.authorized, true);
  for await (const chunk of request) received += chunk.length;
  // Deliberately withhold the PUT receipt; only the granted cleanup window may bound this wait.
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { WORKER_CONTROL_URL: `wss://localhost:${gateway.address().port}`, WORKER_ID: randomUUID(), WORKER_BOOT_ID: randomUUID(),
  MTLS_CERT_FILE: '/runtime/fixtures/cert.pem', MTLS_KEY_FILE: '/runtime/fixtures/key.pem', MTLS_CA_FILE: '/runtime/fixtures/cert.pem' });
const connectionId = randomUUID();
const assignment = { purpose: 'CONNECTION_LOGIN', taskId: null, userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: process.env.WORKER_BOOT_ID,
  connectionId, scopeVersion: 1, instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1,
  originPolicy: 'ALLOWLIST', allowedOrigins: [], deadline: new Date(Date.now() + 30_000).toISOString(), viewport: { width: 1280, height: 720 } };
let runtime;
let closed;
let acknowledgeClosureRequest;
const closureRequested = new Promise(resolve => { acknowledgeClosureRequest = resolve; });
try {
  runtime = await BrowserSession.create(assignment, { headless: true, stagingDirectory: '/runtime/sessions', mediaBarrier: async () => undefined,
    onHardDeadline: () => { closed = runtime.close(); acknowledgeClosureRequest(); } });
  const deadline = Date.now() + 700;
  await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
    allocationEpoch: 1, controlEpoch: 2, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1, mode: 'QUIESCED',
    leaseExpiresAt: assignment.deadline, cleanupDeadline: new Date(deadline).toISOString() });
  const started = Date.now();
  await assert.rejects(runtime.transferProfile({ schemaVersion: 1, type: 'profileSave', requestId: randomUUID(),
    browserSessionId: assignment.browserSessionId, allocationEpoch: 1, controlEpoch: 2, privacyEpoch: 1, policyVersion: 1,
    expiresAt: assignment.deadline, transferId: randomUUID(), transferToken: randomBytes(32).toString('base64'), dek: randomBytes(32).toString('base64'),
    binding: { userId: assignment.userId, connectionId, profileId: randomUUID(), revision: 1, formatVersion: 1,
      scopeVersion: 1, cookieDomains: [], storageOrigins: [] } }), /PROFILE_TRANSFER_UNKNOWN/);
  await Promise.race([closureRequested, delay(3000, undefined, { ref: false }).then(() => assert.fail('No supervisor closure request'))]);
  await closed;
  assert.ok(received > 32, 'A real encrypted native storageState PUT was waiting for its acknowledgement');
  assert.ok(Date.now() - started < 3000, 'Cleanup deadline interrupts the 30-second HTTP wait');
  assert.equal(runtime.inventory().closed, true);
  assert.equal(runtime.usageCheckpoint().browserComplete, true);
  assert.equal(runtime.usageCheckpoint().neverReady, true);
  console.log(JSON.stringify({ state: 'PASS', mtlsUploadInterruptedAtCleanupDeadline: true,
    physicalBrowserClosed: true, finalNeverReadyZero: true, actualS3Verified: false }));
} finally {
  await runtime?.close();
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
}
