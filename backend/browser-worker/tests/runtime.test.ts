import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserSession } from '../src/session.js';
import { SessionSupervisor } from '../src/session-supervisor.js';
import { apiMessageSchema, digest } from '../src/protocol.js';
import type { Action, Assignment, Command, ControlMessage, ExecutionPermit, ProfileSaveMessage } from '../src/protocol.js';
import { projectSnapshot } from '../src/observation.js';
import { ProfileSaves } from '../src/profile-saves.js';
import { decryptProfile, saveProfile } from '../src/profile-transfer.js';

test('wire rejects unsupported versions and arbitrary browser execution', () => {
  assert.equal(apiMessageSchema.safeParse({ schemaVersion: 2, type: 'drain', requestId: randomUUID() }).success, false);
  assert.equal(apiMessageSchema.safeParse({ schemaVersion: 1, type: 'command', requestId: randomUUID(), command: {
    commandId: randomUUID(), attemptId: randomUUID(), taskId: randomUUID(), browserSessionId: randomUUID(), action: { type: 'EVALUATE', script: 'alert(1)' },
  } }).success, false);
});

test('safe projection removes form values and credential-bearing URL parameters', () => {
  const { nodes } = projectSnapshot([{ role: 'textbox', name: 'Password', text: 'secret', children: ['secret', { role: 'text', text: 'secret' }], ref: 'e2' },
    { role: 'link', name: 'Continue', url: 'https://user:secret@example.com/path?token=secret#secret' }]);
  assert.equal(JSON.stringify(nodes).includes('secret'), false);
  const link = nodes[1];
  assert.ok(link && typeof link !== 'string');
  assert.equal(link.url, 'https://example.com/path');
  const mixed = projectSnapshot([{ role: 'paragraph', children: ['Before https://user:secret@example.com/path?token=secret ',
    { role: 'link', name: 'Continue', ref: 'e4', url: 'https://example.com/path' }, ' after'] }]);
  assert.equal(JSON.stringify(mixed.nodes).includes('secret'), false);
  assert.deepEqual(mixed.nodes, [{ role: 'paragraph', children: ['Before https://example.com/path ',
    { role: 'link', name: 'Continue', ref: 'e4', url: 'https://example.com/path' }, ' after'] }]);
});

test('real Chromium executes through embedded MCP, deduplicates, and fences private mode', { timeout: 120_000 }, async (context) => {
  let clicks = 0;
  const server = createServer((request, response) => {
    if (request.url === '/effect') { clicks++; response.end('ok'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Runtime fixture</title><h1>Test</h1><input aria-label="Answer"><button onclick="fetch(\'/effect\');this.textContent=\'Saved\'">Save</button><p>Mixed text before <a href="/">native link</a> and text after</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'helm-runtime-test-'));
  const assignment: Assignment = { taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: randomUUID(),
    purpose: 'TASK',
    allocationEpoch: 1, controlEpoch: 1, privacyEpoch: 1, pageEpoch: 1, policyVersion: 1,
    instructionRevision: 1, originPolicy: 'ALLOWLIST', allowedOrigins: [origin], deadline: new Date(Date.now() + 120_000).toISOString(), viewport: { width: 1280, height: 720 } };
  let session: BrowserSession | undefined;
  try {
    context.diagnostic('Launching Chromium');
    let launches = 0;
    const supervisor = new SessionSupervisor(assignment.workerBootId, async (value) => {
      launches++;
      return BrowserSession.create(value, { stagingDirectory: directory, headless: true, mediaBarrier: async () => undefined });
    });
    const authorized = () => Promise.resolve({ permitId: randomUUID(), browserSessionId: assignment.browserSessionId,
      workerBootId: assignment.workerBootId, allocationEpoch: assignment.allocationEpoch,
      assignmentDigest: digest(assignment), deadline: new Date(Date.now() + 30_000).toISOString() });
    const first = supervisor.assign(assignment, authorized);
    const duplicate = supervisor.assign(assignment, authorized);
    session = await first;
    assert.equal(session, await duplicate);
    assert.equal(launches, 1);
    context.diagnostic('Embedded MCP ready');
    const runtime = session;
    assert.equal(runtime.usageCheckpoint(), undefined, 'Creating Chromium is not the canonical READY boundary');
    const initialUsage = await runtime.markReady(assignment.browserSessionId, assignment.allocationEpoch);
    assert.equal(typeof initialUsage['sourceStartedAt'], 'string');
    assert.ok(Date.now() - Date.parse(String(initialUsage['sourceStartedAt'])) < 10_000);
    const deniedCommand: Command = { commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId,
      browserSessionId: assignment.browserSessionId, instructionRevision: assignment.instructionRevision, action: { type: 'NAVIGATE', url: origin } };
    const denied = await runtime.execute(deniedCommand, async () => ({ ...assignment, instructionRevision: 0,
      commandId: deniedCommand.commandId, attemptId: deniedCommand.attemptId, permitId: randomUUID(), actionDigest: digest(deniedCommand.action),
      deadline: new Date(Date.now() + 30_000).toISOString() }));
    assert.equal(denied.code, 'PERMIT_FENCED');
    assert.equal(runtime.context.pages()[0]?.url(), 'about:blank');
    const run = async (action: Action, existing?: Command) => {
      assert.ok(assignment.taskId);
      const command: Command = existing ?? { commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId, browserSessionId: assignment.browserSessionId, instructionRevision: assignment.instructionRevision, action };
      const permit: () => Promise<ExecutionPermit> = async () => ({ ...assignment,
        commandId: command.commandId, attemptId: command.attemptId, permitId: randomUUID(), actionDigest: digest(action), deadline: new Date(Date.now() + 30_000).toISOString() });
      return { result: await runtime.execute(command, permit), command };
    };
    const navigation = await run({ type: 'NAVIGATE', url: origin });
    assert.equal(navigation.result.status, 'SUCCEEDED');
    assert.ok(navigation.result.observation, navigation.result.code);
    const text = JSON.stringify(navigation.result.observation.snapshot);
    assert.match(text, /Save/);
    assert.match(text, /Mixed text before/);
    assert.match(text, /and text after/);
    const root = navigation.result.observation.snapshot[0];
    assert.ok(root && typeof root !== 'string');
    const node = root.children?.find((item) => typeof item !== 'string' && item.role === 'button');
    assert.ok(node && typeof node !== 'string');
    assert.ok(node?.ref, text);
    const click: Action = { type: 'CLICK', target: node.ref, observationId: navigation.result.observation.observationId };
    const execution = await run(click);
    assert.equal(execution.result.status, 'SUCCEEDED');
    await run(click, execution.command);
    assert.equal(clicks, 1);
    await assert.rejects(() => run({ type: 'BACK' }, { ...execution.command, action: { type: 'BACK' } }), /ATTEMPT_REUSED/);
    const controllerInstance = randomUUID();
    await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
      allocationEpoch: 1, controlEpoch: 2, privacyEpoch: 2, pageEpoch: assignment.pageEpoch, policyVersion: 1,
      mode: 'HUMAN_PRIVATE', controllerInstance, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() });
    const blocked = await run({ type: 'OBSERVE' });
    assert.equal(blocked.result.code, 'CONTROL_FENCED');
    assert.equal(blocked.result.effectState, 'NOT_STARTED');
    const samePage = runtime.context.pages()[0];
    assert.ok(samePage);
    await samePage.getByRole('textbox').fill('private-secret-value');
    await samePage.evaluate(() => console.log('private-secret-console'));
    await runtime.input({ schemaVersion: 1, type: 'input', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
      controlEpoch: 2, pageEpoch: assignment.pageEpoch, controllerInstance, inputSequence: 1, action: { type: 'keyDown', key: 'Shift' } });
    const check = await runtime.checkProfile({ schemaVersion: 1, type: 'profileCheck', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, allocationEpoch: 1, controlEpoch: 2, privacyEpoch: 2,
      policyVersion: 1, expectedOrigin: origin, userAsserted: false, postLoginPathPrefix: '/', accountEvidenceText: 'Saved' });
    assert.equal(check['status'], 'SAFE');
    assert.equal(check['allocationEpoch'], 1);
    assert.equal(check['controlEpoch'], 2);
    assert.equal(runtime.inventory()['mode'], 'QUIESCED');
    const saves = new ProfileSaves();
    const key = randomBytes(32);
    const transfer: ProfileSaveMessage = { schemaVersion: 1, type: 'profileSave', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, allocationEpoch: 1, privacyEpoch: 2, controlEpoch: 2,
      policyVersion: 1, expiresAt: new Date(Date.now() + 120_000).toISOString(), transferId: randomUUID(),
      transferToken: randomBytes(32).toString('base64url'), dek: key.toString('base64'),
      binding: { userId: assignment.userId, connectionId: randomUUID(), profileId: randomUUID(), revision: 1,
        scopeVersion: 1, formatVersion: 1, storageOrigins: [origin], cookieDomains: ['127.0.0.1'] } };
    await runtime.context.addCookies([{ name: 'saved_login', value: 'initial-private-state', url: origin }]);
    let captures = 0;
    let uploaded: Buffer | undefined;
    const capture = () => { captures++; return saveProfile(runtime.context, Buffer.from(key), transfer.binding); };
    await assert.rejects(saves.save(transfer, capture, async blob => {
      uploaded = Buffer.from(blob);
      throw new Error('SIMULATED_LOST_UPLOAD_RECEIPT');
    }), /SIMULATED_LOST_UPLOAD_RECEIPT/);
    assert.equal(saves.pending()[0]?.state, 'UPLOADING');
    await runtime.context.addCookies([{ name: 'saved_login', value: 'later-private-state', url: origin }]);
    const renewed = { ...transfer, requestId: randomUUID(), reuseOnly: true as const, controlEpoch: transfer.controlEpoch + 1,
      expiresAt: new Date(Date.now() + 30_000).toISOString(), transferToken: randomBytes(32).toString('base64url') };
    assert.throws(() => new ProfileSaves().completed(renewed), /PROFILE_SNAPSHOT_UNAVAILABLE/);
    assert.throws(() => saves.completed({ ...transfer, transferToken: renewed.transferToken }), /PROFILE_TRANSFER_REUSED/);
    assert.throws(() => saves.completed({ ...renewed, binding: { ...renewed.binding, revision: 2 } }), /PROFILE_TRANSFER_REUSED/);
    const saved = await saves.save(renewed, capture, async blob => {
      assert.deepEqual(blob, uploaded);
    });
    assert.equal(captures, 1);
    assert.ok(uploaded);
    const plaintext = decryptProfile(uploaded, key, transfer.binding);
    assert.equal(plaintext.includes('initial-private-state'), true);
    assert.equal(plaintext.includes('later-private-state'), false);
    plaintext.fill(0);
    assert.equal(saves.pending()[0]?.state, 'UPLOADED');
    assert.throws(() => saves.acknowledge(transfer.transferId, '0'.repeat(64)), /PROFILE_ACK_FENCED/);
    saves.acknowledge(transfer.transferId, saved.sha256);
    saves.acknowledge(transfer.transferId, saved.sha256);
    assert.deepEqual(saves.pending(), []);
    assert.deepEqual(await saves.save(transfer, capture, async () => assert.fail('ACKed profile must not upload again')), saved);
    assert.deepEqual(await saves.save(renewed, capture, async () => assert.fail('Renewed ACKed profile must not upload again')), saved);
    assert.equal(captures, 1);
    assert.throws(() => saves.completed({ ...transfer, binding: { ...transfer.binding, revision: 2 } }), /PROFILE_TRANSFER_REUSED/);
    saves.close(); key.fill(0); uploaded.fill(0);
    await assert.rejects(runtime.input({ schemaVersion: 1, type: 'input', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
      controlEpoch: 2, pageEpoch: assignment.pageEpoch, controllerInstance, inputSequence: 2, action: { type: 'keyDown', key: 'a' } }), /INPUT_FENCED/);
    await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
      allocationEpoch: 1, controlEpoch: 3, privacyEpoch: 3, pageEpoch: assignment.pageEpoch, policyVersion: 1,
      mode: 'AGENT', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(runtime.context.pages()[0], samePage);
    const resumed = await run({ type: 'OBSERVE' });
    assert.equal(resumed.result.status, 'SUCCEEDED');
    assert.equal(JSON.stringify(resumed.result).includes('private-secret'), false);
    await samePage.evaluate(() => document.addEventListener('keyup', (event) => {
      document.documentElement.dataset['releasedKey'] = event.key;
    }));
    await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
      allocationEpoch: 1, controlEpoch: 4, privacyEpoch: 4, pageEpoch: assignment.pageEpoch, policyVersion: 1,
      mode: 'HUMAN', controllerInstance, leaseExpiresAt: new Date(Date.now() + 250).toISOString() });
    const input = { schemaVersion: 1 as const, type: 'input' as const, requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
      controlEpoch: 4, pageEpoch: assignment.pageEpoch, controllerInstance, inputSequence: 1, action: { type: 'keyDown' as const, key: 'Shift' } };
    const applied = await runtime.input(input);
    assert.equal(applied['activity'], true, 'A physically applied key is activity');
    const heartbeat = await runtime.input({ ...input, inputSequence: 2, action: { type: 'heartbeat' } });
    assert.equal(heartbeat['activity'], false, 'Control heartbeat is not browser activity');
    assert.equal(heartbeat['inputSequence'], 2);
    await samePage.waitForFunction(() => document.documentElement.dataset['releasedKey'] === 'Shift', { timeout: 3000 });
    assert.equal(runtime.inventory()['mode'], 'QUIESCED');
    await assert.rejects(runtime.input({ ...input, inputSequence: 2, action: { type: 'heartbeat' } }), /INPUT_FENCED/);
    const finalUsage = runtime.usageCheckpoint();
    assert.ok(finalUsage);
    assert.equal(finalUsage['sourceStartedAt'], initialUsage['sourceStartedAt']);
    assert.ok(Number(finalUsage['browserMs']) >= Number(initialUsage['browserMs']));
    assert.ok(Number(finalUsage['sourceSequence']) > Number(initialUsage['sourceSequence']));
    await runtime.close();
    const closedUsage = runtime.usageCheckpoint();
    await runtime.close();
    assert.deepEqual(runtime.usageCheckpoint(), closedUsage, 'Repeated close preserves the complete usage receipt');
  } finally {
    await session?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('standalone login creates no observer and initial permit returns no private page data', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm-login-test-'));
  const server = createServer((_request, response) => response.end('<h1>private-account-name</h1><input type="password" value="private-password"><a href="/next">Next</a>'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const assignment: Assignment = { taskId: null, purpose: 'CONNECTION_LOGIN', userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: randomUUID(),
    instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1,
    deadline: new Date(Date.now() + 30_000).toISOString(), originPolicy: 'ALLOWLIST', allowedOrigins: [url], viewport: { width: 1280, height: 720 } };
  let runtime: BrowserSession | undefined;
  try {
    runtime = await BrowserSession.create(assignment, { stagingDirectory: directory, headless: true, mediaBarrier: async () => undefined });
    assert.equal(runtime.inventory()['mode'], 'QUIESCED');
    const command: Command = { commandId: randomUUID(), attemptId: randomUUID(), taskId: null, browserSessionId: assignment.browserSessionId, instructionRevision: assignment.instructionRevision, action: { type: 'NAVIGATE', url } };
    const result = await runtime.execute(command, async () => ({ ...assignment, commandId: command.commandId, attemptId: command.attemptId,
      permitId: randomUUID(), actionDigest: digest(command.action), deadline: new Date(Date.now() + 15_000).toISOString() }));
    assert.equal(result.status, 'SUCCEEDED'); assert.equal(result.observation, undefined);
    assert.equal(JSON.stringify(result).includes('private-account-name'), false);
    assert.equal(JSON.stringify(result).includes('private-password'), false);
    assert.equal(runtime.usageCheckpoint(), undefined);
    const controllerInstance = randomUUID();
    await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, allocationEpoch: 1, controlEpoch: 2,
      pageEpoch: assignment.pageEpoch, privacyEpoch: 2, policyVersion: 1, mode: 'HUMAN_PRIVATE',
      controllerInstance, leaseExpiresAt: new Date(Date.now() + 5000).toISOString() });
    const page = runtime.context.pages()[0]; assert.ok(page);
    await page.getByRole('link', { name: 'Next' }).focus();
    const inputPageEpoch = assignment.pageEpoch;
    const navigation = page.waitForURL(url + '/next');
    const applied = await runtime.input({ schemaVersion: 1, type: 'input', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, controlEpoch: 2, pageEpoch: inputPageEpoch,
      controllerInstance, inputSequence: 1, action: { type: 'keyDown', key: 'Enter' } });
    await navigation;
    assert.equal(applied['activity'], true);
    assert.equal(applied['inputPageEpoch'], inputPageEpoch, 'Input keeps its admitted page after navigation');
    assert.ok(assignment.pageEpoch > inputPageEpoch, 'Real Enter input navigated the same Page');
    assert.equal(JSON.stringify(applied).includes('/next'), false, 'Private input receipt contains no URL');
    await runtime.close();
    const neverReady = runtime.usageCheckpoint();
    assert.ok(neverReady);
    assert.equal(neverReady['neverReady'], true);
    assert.equal(neverReady['browserComplete'], true);
    for (const counter of ['browserMs', 'executionMs', 'humanMs', 'loginMs']) assert.equal(neverReady[counter], 0);
    assert.deepEqual(runtime.usageCheckpoint(), neverReady);
  } finally {
    await runtime?.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('budget expiry fences input and only bounded quiescent cleanup can outlive the action deadline', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm-deadline-test-'));
  const assignment: Assignment = { taskId: randomUUID(), purpose: 'TASK', userId: randomUUID(),
    browserSessionId: randomUUID(), workerBootId: randomUUID(), connectionId: randomUUID(), scopeVersion: 1,
    instructionRevision: 1, allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1,
    deadline: new Date(Date.now() + 5000).toISOString(), originPolicy: 'PUBLIC', allowedOrigins: [], viewport: { width: 1280, height: 720 } };
  let finishClosure: () => void = () => undefined;
  const closed = new Promise<void>(resolve => { finishClosure = resolve; });
  let closedSession: BrowserSession | undefined;
  const supervisor = new SessionSupervisor(assignment.workerBootId, value => BrowserSession.create(value, {
    stagingDirectory: directory, headless: true, mediaBarrier: async () => undefined,
    onHardDeadline: () => { void supervisor.close(value.browserSessionId, value.allocationEpoch).then(session => {
      closedSession = session; finishClosure();
    }); },
  }));
  try {
    const session = await supervisor.assign(assignment, async hash => ({ permitId: randomUUID(),
      browserSessionId: assignment.browserSessionId, workerBootId: assignment.workerBootId, allocationEpoch: 1,
      assignmentDigest: hash, deadline: assignment.deadline }));
    await session.markReady(assignment.browserSessionId, 1);
    const controllerInstance = randomUUID();
    await session.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), ...assignment,
      mode: 'HUMAN', controllerInstance, leaseExpiresAt: new Date(Date.now() + 10_000).toISOString() });
    const input = { schemaVersion: 1 as const, type: 'input' as const, requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, controllerInstance, controlEpoch: 1,
      pageEpoch: assignment.pageEpoch, inputSequence: 1, action: { type: 'keyDown' as const, key: 'Shift' } };
    await session.input(input);
    await delay(Math.max(0, Date.parse(assignment.deadline) - Date.now()) + 20);
    await assert.rejects(session.input({ ...input, inputSequence: 2 }), /BROWSER_DEADLINE/);
    const cleanup: ControlMessage = { schemaVersion: 1, type: 'control', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, allocationEpoch: 1, controlEpoch: 2,
      pageEpoch: assignment.pageEpoch, privacyEpoch: 1, policyVersion: 1, mode: 'QUIESCED',
      leaseExpiresAt: new Date(Date.now() + 1000).toISOString(), cleanupDeadline: new Date(Date.now() + 500).toISOString() };
    await session.control(cleanup);
    await session.control({ ...cleanup, requestId: randomUUID() });
    await assert.rejects(session.control({ ...cleanup, requestId: randomUUID(), cleanupDeadline: new Date(Date.now() + 1500).toISOString() }), /CLEANUP_DEADLINE_INVALID/);
    const transfer: ProfileSaveMessage = { schemaVersion: 1, type: 'profileSave', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, allocationEpoch: 1, controlEpoch: 2, privacyEpoch: 1,
      policyVersion: 1, expiresAt: cleanup.cleanupDeadline ?? '', transferId: randomUUID(),
      transferToken: randomBytes(32).toString('base64url'), dek: randomBytes(32).toString('base64'),
      binding: { userId: randomUUID(), connectionId: assignment.connectionId ?? '', profileId: randomUUID(),
        revision: 1, scopeVersion: 1, formatVersion: 1, storageOrigins: [], cookieDomains: [] } };
    await assert.rejects(session.transferProfile({ ...transfer, type: 'profileLoad' }), /BROWSER_DEADLINE/);
    await assert.rejects(session.transferProfile(transfer), /PROFILE_BINDING_FENCED/);
    await closed;
    assert.equal(supervisor.session, undefined);
    assert.ok(closedSession);
    const usage = closedSession.usageCheckpoint();
    assert.ok(usage);
    assert.equal(usage['browserComplete'], true);
    assert.equal(usage['neverReady'], undefined);
    assert.deepEqual(closedSession.usageCheckpoint(), usage);
  } finally {
    await supervisor.close(assignment.browserSessionId, 1);
    await rm(directory, { recursive: true, force: true });
  }
});

test('human navigation uses the same Page, fences permits and keeps private receipts opaque', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm-human-navigation-'));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>private-page-title</title><h1>private-page-body</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const assignment: Assignment = { taskId: randomUUID(), purpose: 'TASK', userId: randomUUID(),
    browserSessionId: randomUUID(), workerBootId: randomUUID(), instructionRevision: 1,
    allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1,
    deadline: new Date(Date.now() + 30_000).toISOString(), originPolicy: 'ALLOWLIST',
    allowedOrigins: [origin], viewport: { width: 1280, height: 720 } };
  const controllerInstance = randomUUID();
  let runtime: BrowserSession | undefined;
  let mode: 'HUMAN' | 'HUMAN_PRIVATE' = 'HUMAN';
  let expiry = new Date(Date.now() + 10_000).toISOString();
  try {
    runtime = await BrowserSession.create(assignment, { stagingDirectory: directory, headless: true,
      mediaBarrier: async () => undefined });
    const session = runtime;
    await session.markReady(assignment.browserSessionId, assignment.allocationEpoch);
    const page = session.context.pages()[0]; assert.ok(page);
    const control = (binding: Pick<ControlMessage, 'connectionId' | 'scopeVersion'> = {}) => session.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, allocationEpoch: assignment.allocationEpoch,
      pageEpoch: assignment.pageEpoch, policyVersion: 1, controlEpoch: assignment.controlEpoch + 1,
      privacyEpoch: assignment.privacyEpoch + 1, controllerInstance, mode, leaseExpiresAt: expiry, ...binding });
    const connectionId = randomUUID();
    await assert.rejects(control({ connectionId, scopeVersion: 7 }), /CONNECTION_BINDING_FENCED/);
    await control();
    const run = async (action: Action, commandPatch: Partial<Command> = {}, permitPatch: Partial<ExecutionPermit> = {}, wait = 0) => {
      const command: Command = { commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId,
        browserSessionId: assignment.browserSessionId, instructionRevision: assignment.instructionRevision, executionMode: mode, controllerInstance, action, ...commandPatch };
      const result = await session.execute(command, async () => {
        if (wait) await delay(wait);
        return { ...assignment, commandId: command.commandId, attemptId: command.attemptId,
          executionMode: mode, controllerInstance, permitId: randomUUID(), actionDigest: digest(action),
          deadline: expiry, ...permitPatch };
      });
      return { command, result };
    };
    const navigate: Action = { type: 'NAVIGATE', url: origin + '/one?token=secret#fragment' };
    assert.equal((await run(navigate, { controllerInstance: randomUUID() })).result.code, 'CONTROL_FENCED');
    assert.equal((await run(navigate, {}, { controllerInstance: randomUUID() })).result.code, 'PERMIT_INVALID');
    assert.equal((await run({ type: 'OBSERVE' })).result.code, 'HUMAN_COMMAND_FORBIDDEN');
    assert.equal(requests, 0);
    const first = await run(navigate);
    assert.equal(first.result.status, 'SUCCEEDED');
    assert.equal(first.result.observation, undefined);
    assert.equal(first.result.safeUrl, origin + '/one');
    assert.equal(JSON.stringify(first.result).includes('secret'), false);
    assert.equal(JSON.stringify(first.result).includes('private-page'), false);
    assert.equal((await run({ type: 'NAVIGATE', url: origin + '/two' })).result.status, 'SUCCEEDED');
    assert.equal((await run({ type: 'BACK' })).result.safeUrl, origin + '/one');
    assert.equal((await run({ type: 'FORWARD' })).result.safeUrl, origin + '/two');
    assert.equal((await run({ type: 'RELOAD' })).result.safeUrl, origin + '/two');
    const beforeReplay = requests;
    const replay = await session.execute(first.command, async () => { throw new Error('A receipt must not request another permit'); });
    assert.deepEqual(replay, first.result);
    assert.equal(requests, beforeReplay);
    await assert.rejects(session.execute({ ...first.command, executionMode: 'HUMAN_PRIVATE' }, async () => {
      throw new Error('A reused attempt must not request a permit');
    }), /ATTEMPT_REUSED/);
    mode = 'HUMAN_PRIVATE';
    await control({ connectionId, scopeVersion: 7 });
    assert.equal(assignment.connectionId, connectionId);
    assert.equal(assignment.scopeVersion, 7);
    await assert.rejects(control({ connectionId: randomUUID(), scopeVersion: 7 }), /CONNECTION_BINDING_FENCED/);
    const privateNavigation = await run({ type: 'NAVIGATE', url: origin + '/private-secret?token=secret' });
    assert.equal(privateNavigation.result.status, 'SUCCEEDED');
    assert.equal(privateNavigation.result.safeUrl, undefined);
    assert.equal(privateNavigation.result.observation, undefined);
    assert.equal(JSON.stringify(privateNavigation.result).includes('private'), false);
    assert.equal(session.context.pages()[0], page);
    const humanUsage = session.usageCheckpoint();
    assert.ok(humanUsage);
    assert.equal(humanUsage['executionMs'], 0, 'Human lease intervals are not counted again as agent execution');
    await page.evaluate(() => {
      document.documentElement.dataset['fixtureNavigation'] = 'running';
      const channel = new MessageChannel();
      let sequence = 0;
      channel.port1.onmessage = () => {
        if (document.documentElement.dataset['fixtureNavigation'] !== 'running' || sequence >= 100) {
          channel.port1.close(); channel.port2.close(); return;
        }
        history.replaceState({}, '', '/private-secret/page-' + ++sequence);
        setTimeout(() => channel.port2.postMessage(null), 1);
      };
      channel.port2.postMessage(null);
    });
    const profileCheck = () => session.checkProfile({ schemaVersion: 1, type: 'profileCheck', requestId: randomUUID(),
      browserSessionId: assignment.browserSessionId, allocationEpoch: assignment.allocationEpoch,
      controlEpoch: assignment.controlEpoch, privacyEpoch: assignment.privacyEpoch, policyVersion: 1,
      expectedOrigin: origin, userAsserted: false, postLoginPathPrefix: '/private-secret', accountEvidenceText: 'private-page-body' });
    let invalidated = false;
    for (let attempt = 0; attempt < 50 && !invalidated; attempt++) {
      const changedDuringCheck = await profileCheck();
      invalidated = changedDuringCheck['status'] === 'UNKNOWN' && changedDuringCheck['verification'] === 'UNKNOWN';
    }
    await page.evaluate(() => { delete document.documentElement.dataset['fixtureNavigation']; });
    assert.ok(invalidated, 'Navigation during evidence collection cannot authorize private exit');
    assert.equal((await profileCheck())['status'], 'SAFE', 'The same evidence is valid after navigation stops');
    assert.equal(session.inventory()['mode'], 'QUIESCED');
    expiry = new Date(Date.now() + 100).toISOString();
    await control();
    const beforeExpiry = requests;
    const expired = await run({ type: 'NAVIGATE', url: origin + '/after-expiry' }, {}, {}, 200);
    assert.equal(expired.result.code, 'CONTROL_FENCED');
    assert.equal(expired.result.effectState, 'NOT_STARTED');
    assert.equal(requests, beforeExpiry);
  } finally {
    await runtime?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
