import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionSupervisor } from '../src/session-supervisor.js';
import type { Assignment, LaunchPermit } from '../src/protocol.js';
import { digest, WorkerError } from '../src/protocol.js';

function assignment(): Assignment {
  return { taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: randomUUID(),
    purpose: 'TASK', allocationEpoch: 1, controlEpoch: 1, privacyEpoch: 1, pageEpoch: 1, policyVersion: 1,
    instructionRevision: 1, originPolicy: 'PUBLIC', allowedOrigins: [],
    deadline: new Date(Date.now() + 120_000).toISOString(), viewport: { width: 1280, height: 720 } };
}

function permit(value: Assignment): LaunchPermit {
  return { browserSessionId: value.browserSessionId, workerBootId: value.workerBootId, allocationEpoch: value.allocationEpoch,
    permitId: randomUUID(), assignmentDigest: digest(value), deadline: new Date(Date.now() + 30_000).toISOString() };
}

test('physical launch waits for durable authorization; duplicate delivery shares the occupied slot', async () => {
  const value = assignment();
  let launches = 0;
  const authorization = Promise.withResolvers<LaunchPermit>();
  const supervisor = new SessionSupervisor(value.workerBootId, async (received) => {
    ++launches;
    return { assignment: received, inventory: () => ({ browserSessionId: received.browserSessionId }),
      close: async () => undefined, fenceDisconnected: async () => undefined };
  });
  const first = supervisor.assign(value, () => authorization.promise);
  const duplicate = supervisor.assign(value, () => { throw new Error('Must reuse the original authorization request'); });
  await assert.rejects(supervisor.assign({ ...value, browserSessionId: randomUUID() }, async () => permit(value)), /WORKER_CAPACITY/);
  assert.equal(launches, 0);
  assert.equal(supervisor.inventory()?.state, 'LAUNCHING');
  authorization.resolve(permit(value));
  assert.equal(await first, await duplicate);
  assert.equal(launches, 1);
  assert.equal(await supervisor.assign(value, async () => permit(value)), supervisor.session);
  assert.equal(launches, 1);
});

test('disconnect during native launch waits for closure before an empty registration snapshot', async () => {
  const value = assignment();
  const created = Promise.withResolvers<void>();
  const launched = Promise.withResolvers<void>();
  const closure = Promise.withResolvers<void>();
  let closed = false;
  const supervisor = new SessionSupervisor(value.workerBootId, async (received) => {
    launched.resolve();
    await created.promise;
    return { assignment: received, inventory: () => ({}), fenceDisconnected: async () => undefined,
      close: async () => { await closure.promise; closed = true; } };
  });
  const pending = supervisor.assign(value, async () => permit(value));
  const rejected = assert.rejects(pending, /LAUNCH_CANCELLED/);
  await launched.promise;
  await supervisor.fenceDisconnected();
  let snapshotComplete = false;
  const snapshot = supervisor.snapshot().then((result) => { snapshotComplete = true; return result; });
  created.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(snapshotComplete, false);
  closure.resolve();
  await rejected;
  assert.equal(await snapshot, null);
  assert.equal(closed, true);
});

test('invalid permit never launches and an unconfirmed native closure cannot release inventory', async () => {
  const value = assignment();
  let launches = 0;
  const supervisor = new SessionSupervisor(value.workerBootId, async (received) => {
    ++launches;
    return { assignment: received, inventory: () => ({}), fenceDisconnected: async () => undefined,
      close: async () => { throw new WorkerError('RUNTIME_CLOSURE_UNCONFIRMED'); } };
  });
  await assert.rejects(supervisor.assign(value, async () => ({ ...permit(value), assignmentDigest: '0'.repeat(64) })), /LAUNCH_PERMIT_FENCED/);
  assert.equal(launches, 0);
  await supervisor.assign(value, async () => permit(value));
  await assert.rejects(supervisor.close(value.browserSessionId, value.allocationEpoch), /RUNTIME_CLOSURE_UNCONFIRMED/);
  await assert.rejects(supervisor.snapshot(), /RUNTIME_CLOSURE_UNCONFIRMED/);
  await assert.rejects(supervisor.assign(value, async () => permit(value)), /RUNTIME_CLOSURE_UNCONFIRMED/);
});

test('closing is an occupied phase until native completion, including a simultaneous reconnect snapshot', async () => {
  const value = assignment();
  const closure = Promise.withResolvers<void>();
  let closing = false;
  const supervisor = new SessionSupervisor(value.workerBootId, async (received) => ({
    assignment: received, inventory: () => ({ closed: closing }), fenceDisconnected: async () => undefined,
    close: async () => { closing = true; await closure.promise; },
  }));
  await supervisor.assign(value, async () => permit(value));
  const firstClose = supervisor.close(value.browserSessionId, value.allocationEpoch);
  const repeatedClose = supervisor.close(value.browserSessionId, value.allocationEpoch);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(supervisor.inventory()?.state, 'CLOSING');
  assert.equal(supervisor.occupied, true);
  await assert.rejects(supervisor.assign(assignment(), async () => permit(value)), /WORKER_CAPACITY/);
  let completed = false;
  const snapshot = supervisor.snapshot().then((inventory) => { completed = true; return inventory; });
  const fence = supervisor.fenceDisconnected();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  closure.resolve();
  assert.equal(await firstClose, await repeatedClose);
  await fence;
  assert.equal(await snapshot, null);
  assert.equal(supervisor.occupied, false);
});
