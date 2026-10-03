import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserSession } from '../src/session.js';
import { commandSchema, digest, WorkerError } from '../src/protocol.js';
import type { Assignment, Command, ControlMessage, ExecutionPermit } from '../src/protocol.js';

test('every command carries a bounded instruction revision in the strict worker contract', () => {
  const command = { commandId: randomUUID(), attemptId: randomUUID(), taskId: randomUUID(),
    browserSessionId: randomUUID(), action: { type: 'OBSERVE' } };
  assert.equal(commandSchema.safeParse(command).success, false);
  assert.equal(commandSchema.safeParse({ ...command, instructionRevision: 2 }).success, true);
  for (const instructionRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(commandSchema.safeParse({ ...command, instructionRevision }).success, false);
  }
});

test('a bound permit advances instruction revision on the same real Page without replaying effects', { timeout: 30_000 }, async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Revision fixture</title><h1>Read-only fixture</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'helm-revision-'));
  const assignment: Assignment = {
    taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: randomUUID(),
    purpose: 'TASK', allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1,
    policyVersion: 1, instructionRevision: 1, originPolicy: 'ALLOWLIST', allowedOrigins: [origin],
    deadline: new Date(Date.now() + 25_000).toISOString(), viewport: { width: 1280, height: 720 },
  };
  let runtime: BrowserSession | undefined;
  try {
    runtime = await BrowserSession.create(assignment, { stagingDirectory: directory, headless: true,
      mediaBarrier: async () => undefined });
    const session = runtime;
    const page = session.context.pages()[0];
    assert.ok(page);
    const controllerInstance = randomUUID();
    const expiry = new Date(Date.now() + 20_000).toISOString();
    const control = (mode: ControlMessage['mode']) => session.control({
      schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
      allocationEpoch: assignment.allocationEpoch, controlEpoch: assignment.controlEpoch + 1,
      pageEpoch: assignment.pageEpoch, privacyEpoch: assignment.privacyEpoch + 1,
      policyVersion: assignment.policyVersion, mode, leaseExpiresAt: expiry,
      ...(mode === 'AGENT' ? {} : { controllerInstance }),
    });
    await control('HUMAN');
    const command = (revision: number, mode?: 'HUMAN' | 'HUMAN_PRIVATE'): Command => ({
      commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId,
      browserSessionId: assignment.browserSessionId, instructionRevision: revision,
      action: { type: 'NAVIGATE', url: origin },
      ...(mode ? { executionMode: mode, controllerInstance } : {}),
    });
    const permit = (value: ReturnType<typeof command>, patch: Partial<ExecutionPermit> = {}): ExecutionPermit => ({
      ...assignment, instructionRevision: value.instructionRevision, commandId: value.commandId,
      attemptId: value.attemptId, permitId: randomUUID(), actionDigest: digest(value.action), deadline: expiry,
      ...(value.executionMode ? { executionMode: value.executionMode, controllerInstance } : {}), ...patch,
    });
    for (const patch of [
      { workerBootId: randomUUID() }, { allocationEpoch: 2 }, { controlEpoch: 0 },
      { pageEpoch: 0 }, { privacyEpoch: 0 }, { policyVersion: 2 }, { connectionId: randomUUID() },
    ]) {
      const rejected = command(2, 'HUMAN');
      const result = await session.execute(rejected, async () => permit(rejected, patch));
      assert.equal(result.code, 'PERMIT_FENCED');
      assert.equal(assignment.instructionRevision, 1);
    }
    const denied = await session.execute(command(2, 'HUMAN'), async () => {
      throw new WorkerError('START_PERMIT_DENIED');
    });
    assert.equal(denied.effectState, 'NOT_STARTED');
    assert.equal(assignment.instructionRevision, 1);
    assert.equal(requests, 0);

    const revised = command(2, 'HUMAN');
    const result = await session.execute(revised, async () => permit(revised));
    assert.equal(result.status, 'SUCCEEDED', result.code);
    assert.equal(assignment.instructionRevision, 2);
    assert.equal(session.context.pages()[0], page);
    const afterNavigation = requests;
    const stale = command(1, 'HUMAN');
    const staleResult = await session.execute(stale, async () => {
      assert.fail('A stale command cannot request a new permit');
    });
    assert.equal(staleResult.effectState, 'NOT_STARTED');
    assert.equal(requests, afterNavigation);
    const mismatched = command(3, 'HUMAN');
    assert.equal((await session.execute(mismatched, async () => permit(mismatched, { instructionRevision: 4 }))).code,
      'PERMIT_FENCED');
    assert.equal(assignment.instructionRevision, 2);

    await control('AGENT');
    const agent = command(3);
    assert.equal((await session.execute(agent, async () => permit(agent))).status, 'SUCCEEDED');
    assert.equal(assignment.instructionRevision, 3);
    const afterAgent = requests;
    assert.deepEqual(await session.execute(revised, async () => {
      assert.fail('An exact attempt replay cannot execute or request a permit');
    }), result);
    assert.equal(requests, afterAgent);
    const changedAttempt = { ...revised, instructionRevision: 3 };
    await assert.rejects(session.execute(changedAttempt, async () => permit(revised)),
      /ATTEMPT_REUSED/);

    await control('HUMAN_PRIVATE');
    const privateCommand = command(4, 'HUMAN_PRIVATE');
    const privateResult = await session.execute(privateCommand, async () => permit(privateCommand));
    assert.equal(privateResult.status, 'SUCCEEDED');
    assert.equal(privateResult.observation, undefined);
    assert.equal(privateResult.safeUrl, undefined);
    assert.equal(assignment.instructionRevision, 4);
    assert.equal(session.context.pages()[0], page);
  } finally {
    await runtime?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
