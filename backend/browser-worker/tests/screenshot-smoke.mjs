import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:https';
import { BrowserSession } from '../dist/src/session.js';
import { artifactMetadataSchema } from '../dist/src/artifact-transfer.js';
import { digest } from '../dist/src/protocol.js';

await mkdir('/runtime/fixtures', { recursive: true, mode: 0o700 });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/runtime/fixtures/key.pem',
  '-out', '/runtime/fixtures/cert.pem', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
const cert = await readFile('/runtime/fixtures/cert.pem');
const key = await readFile('/runtime/fixtures/key.pem');
const artifactId = randomUUID();
const transferId = randomUUID();
let allocation;
let allocated = 0;
const uploads = [];
let duringUpload = async () => undefined;
const gateway = createServer({ cert, key, ca: cert, requestCert: true, rejectUnauthorized: true }, async (request, response) => {
  assert.equal(request.socket.authorized, true);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  response.setHeader('content-type', 'application/json');
  if (request.url.endsWith('/allocate')) {
    const metadata = artifactMetadataSchema.parse(JSON.parse(bytes.toString()));
    assert.equal(metadata.kind, 'SCREENSHOT');
    if (allocation?.attemptId === metadata.attemptId) assert.deepEqual(metadata, allocation);
    allocation = metadata;
    allocated++;
    response.end(JSON.stringify({ artifactId, transferId, transferToken: 'fixture-token-012345678901234567890123456789' }));
    return;
  }
  assert.equal(request.headers['x-content-sha256'], createHash('sha256').update(bytes).digest('hex'));
  assert.equal(allocation.sha256, request.headers['x-content-sha256']);
  assert.equal(allocation.byteLength, bytes.length);
  uploads.push(bytes);
  await duringUpload();
  if (uploads.length === 1) { response.destroy(); return; }
  response.end(JSON.stringify({ artifactId, sha256: allocation.sha256, byteLength: bytes.length, state: 'READY' }));
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { WORKER_CONTROL_URL: `wss://localhost:${gateway.address().port}`, WORKER_ID: randomUUID(), WORKER_BOOT_ID: randomUUID(),
  MTLS_CERT_FILE: '/runtime/fixtures/cert.pem', MTLS_KEY_FILE: '/runtime/fixtures/key.pem', MTLS_CA_FILE: '/runtime/fixtures/cert.pem' });
const assignment = { purpose: 'TASK', taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: process.env.WORKER_BOOT_ID,
  instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1,
  originPolicy: 'ALLOWLIST', allowedOrigins: [], deadline: new Date(Date.now() + 60_000).toISOString(), viewport: { width: 1280, height: 720 } };
const controllerInstance = randomUUID();
const leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
let runtime;
try {
  runtime = await BrowserSession.create(assignment, { headless: true, stagingDirectory: '/runtime/sessions', mediaBarrier: async () => undefined });
  const page = runtime.context.pages()[0];
  await page.setContent('<h1 style="color:red">Captured once</h1>');
  const command = { commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId,
    browserSessionId: assignment.browserSessionId, instructionRevision: assignment.instructionRevision,
    executionMode: 'HUMAN', controllerInstance, action: { type: 'SNAPSHOT' } };
  const permit = async input => ({ ...assignment, commandId: input.commandId, attemptId: input.attemptId,
    executionMode: input.executionMode, controllerInstance: input.controllerInstance,
    permitId: randomUUID(), actionDigest: digest(input.action), deadline: leaseExpiresAt });
  const agent = { commandId: command.commandId, attemptId: command.attemptId, taskId: command.taskId,
    browserSessionId: command.browserSessionId, instructionRevision: command.instructionRevision, action: command.action };
  assert.equal((await runtime.execute(agent, () => { throw Error('Agent screenshot must not request a permit'); })).code, 'HUMAN_COMMAND_REQUIRED');
  await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
    allocationEpoch: 1, controlEpoch: 2, pageEpoch: assignment.pageEpoch, privacyEpoch: 1, policyVersion: 1,
    mode: 'HUMAN', controllerInstance, leaseExpiresAt });
  const snapshot = { ...command, commandId: randomUUID(), attemptId: randomUUID() };
  duringUpload = async () => { await page.setContent('<h1 style="color:blue">Different page after capture</h1>'); };
  const result = await runtime.execute(snapshot, () => permit(snapshot));
  assert.equal(result.status, 'SUCCEEDED', result.code);
  assert.equal(result.observation, undefined);
  assert.deepEqual(result.artifact, { artifactId, sha256: allocation.sha256, byteLength: allocation.byteLength, state: 'READY' });
  assert.equal(uploads.length, 2, 'Unknown HTTP delivery retries the same file');
  assert.deepEqual(uploads[0], uploads[1], 'Changing page pixels after upload cannot cause another capture');
  assert.deepEqual(uploads[0].subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(uploads[0].readUInt32BE(16), 1280);
  assert.equal(uploads[0].readUInt32BE(20), 720);
  const repeated = await runtime.execute(snapshot, () => { throw Error('Completed attempt must not request another permit'); });
  assert.deepEqual(repeated, result);
  assert.equal(allocated, 2);
  for (const sessionDirectory of await readdir('/runtime/sessions')) {
    assert.equal((await readdir('/runtime/sessions/' + sessionDirectory)).some(name => name.startsWith('screenshot-')), false);
  }
  const privateControl = { schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
    allocationEpoch: 1, controlEpoch: 3, pageEpoch: assignment.pageEpoch, privacyEpoch: 2, policyVersion: 1,
    mode: 'HUMAN_PRIVATE', controllerInstance, leaseExpiresAt };
  let barrier;
  duringUpload = async () => { barrier = runtime.control(privateControl); };
  const cancelled = { ...snapshot, commandId: randomUUID(), attemptId: randomUUID() };
  const cancelledResult = await runtime.execute(cancelled, () => permit(cancelled));
  await barrier;
  assert.equal(cancelledResult.status, 'UNKNOWN');
  assert.equal(cancelledResult.code, 'ARTIFACT_TRANSFER_UNKNOWN');
  assert.equal(cancelledResult.artifact, undefined);
  assert.equal(runtime.inventory().mode, 'HUMAN_PRIVATE');
  const privateCommand = { ...snapshot, commandId: randomUUID(), attemptId: randomUUID(), executionMode: 'HUMAN_PRIVATE' };
  assert.equal((await runtime.execute(privateCommand, () => { throw Error('Private screenshot must not request a permit'); })).code, 'SCREENSHOT_PRIVATE');
  assert.equal(allocated, 3);
  console.log(JSON.stringify({ state: 'PASS', nativePng: '1280x720', mtls: true, identicalUnknownUploadRetry: true,
    attemptReplayWithoutCapture: true, privateAndAgentDenied: true, privateBarrierAbortsUpload: true,
    stagingRemoved: true, actualS3Verified: false }));
} finally {
  await runtime?.close();
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
}
