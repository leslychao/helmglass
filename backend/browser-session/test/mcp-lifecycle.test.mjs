import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { snapshotText, target } from './references.mjs';

// Runs in the existing dev manager with fixtures/browser-execution.html from
// backend/api/tests. Every resource touched below belongs to this test session.
const worker = process.env.WORKER_URL, token = process.env.WORKER_TOKEN;
const fixture = process.env.TEST_FIXTURE_URL, docker = process.env.DOCKER_HOST;
assert.ok(worker && token && fixture && docker);
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET', signal) {
  const response = await fetch(worker + route, { method, headers,
    body: body ? JSON.stringify(body) : undefined, signal });
  return { code: response.status, value: await response.json() };
}
async function inspect(id) {
  const response = await fetch(docker + '/containers/helm-browser-' + id + '/json');
  assert.equal(response.status, 200);
  const value = await response.json();
  return { pid: value.State.Pid, startedAt: value.State.StartedAt };
}

test('a timed out read releases MCP and the next observation reuses the same live page',
  { timeout: 45_000 }, async () => {
    const id = randomUUID(), base = '/sessions/' + id;
    let createdSession = false;
    try {
      const created = await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: fixture });
      createdSession = created.code >= 200 && created.code < 300;
      assert.equal(created.value.status, 'LIVE', JSON.stringify(created.value));
      assert.equal((await request(base + '/control', { controlEpoch: 1, owner: 'CHATGPT', privateMode: false })).code, 200);
      const process = await inspect(id);
      const before = (await request(base + '/observe')).value;
      const waiting = { operationId: randomUUID(), type: 'waitFor', instructionRevision: 0, controlEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        arguments: { textGone: 'Increment' } };
      const receipt = await request(base + '/commands', waiting);
      assert.equal(receipt.value.status, 'FAILED');
      const after = await request(base + '/observe');
      assert.equal(after.code, 200, 'A completed read timeout must not poison subsequent observations');
      assert.notEqual(after.value.runtimeId, before.runtimeId);
      assert.equal(after.value.tabs.find(tab => tab.active).id, before.tabs.find(tab => tab.active).id);
      assert.deepEqual(await inspect(id), process);
      assert.deepEqual(await request(base + '/commands', waiting), receipt);
    } finally {
      if (createdSession) {
        assert.equal((await request(base, undefined, 'DELETE')).value.status, 'CLOSED');
        assert.equal((await request(base + '/cleanup', undefined, 'DELETE')).code, 200);
      }
    }
  });

test('MCP cancellation, private handoff, tab identity and lost response preserve one effect',
  { timeout: 100_000 }, async () => {
    const id = randomUUID(), base = '/sessions/' + id;
    let createdSession = false;
    let epoch = 1;
    const action = (type, args = {}) => ({ operationId: randomUUID(), type,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      arguments: args, instructionRevision: 0, controlEpoch: epoch });
    async function command(type, args) {
      const result = await request(base + '/commands', action(type, args));
      assert.equal(result.code, 200); assert.equal(result.value.status, 'SUCCEEDED', JSON.stringify(result.value));
      return result.value.result;
    }
    async function control(owner, privateMode = false, controllerId) {
      const result = await request(base + '/control', { controlEpoch: epoch, owner, privateMode,
        ...(controllerId ? { controllerId } : {}) });
      assert.equal(result.code, 200, JSON.stringify(result.value));
    }
    try {
      const created = await request('/sessions', { sessionId: id, ownerId: randomUUID(), startUrl: fixture });
      createdSession = created.code >= 200 && created.code < 300;
      assert.equal(created.value.status, 'LIVE', JSON.stringify(created.value));
      const process = await inspect(id);
      await control('CHATGPT');
      const filled = await command('fill', { ...await target(request, base, 'Recipient'), text: 'same-page-marker' });
      const originalPage = filled.observation.tabs.find(tab => tab.active).id;
      await command('newTab', { url: fixture });
      const selected = await command('selectTab', { tabId: originalPage });
      assert.ok(snapshotText(selected.observation).includes('same-page-marker'));
      const before = selected.observation;

      const waiting = action('waitFor', { time: 3 });
      const pending = request(base + '/commands', waiting);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if ((await request(base + '/commands/' + waiting.operationId)).value.status === 'RUNNING') break;
        await delay(20);
      }
      assert.equal((await request(base + '/commands/' + waiting.operationId)).value.status, 'RUNNING');
      await delay(500);
      epoch++;
      const started = performance.now();
      const busy = await request(base + '/control', { controlEpoch: epoch, owner: 'NONE', privateMode: true });
      assert.equal(busy.code, 409, 'Manager keeps control fenced while the command is running');
      const cancelling = await request(base + '/commands/' + waiting.operationId + '/cancel', {});
      assert.equal(cancelling.value.status, 'RUNNING', 'Cancellation is not acknowledgement of native completion');
      const settled = await pending;
      assert.equal(settled.value.status, 'FAILED');
      assert.equal((await request(base + '/commands/' + waiting.operationId)).value.status, 'FAILED');
      await control('NONE', true);
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 1000 && elapsed < 10_000, 'Handoff waits for the native handler to finish');
      console.log('Confirmed native completion before handoff: ' + elapsed.toFixed(0) + ' ms');
      epoch++;
      const contenders = [randomUUID(), randomUUID()];
      const raced = await Promise.all(contenders.map(controllerId => request(base + '/control', {
        controlEpoch: epoch, owner: 'USER', privateMode: true, controllerId })));
      assert.deepEqual(raced.map(value => value.code).sort(), [200, 409]);
      assert.equal((await request(base + '/observe')).code, 423);
      epoch++;
      await control('CHATGPT');
      const after = (await request(base + '/observe')).value;
      assert.equal(after.tabs.find(tab => tab.active).id, originalPage);
      assert.ok(snapshotText(after).includes('same-page-marker'));
      assert.notEqual(after.runtimeId, before.runtimeId);
      assert.deepEqual(await inspect(id), process, 'Handoff must retain the running Chromium session');
      const old = before.snapshot.find(entry => entry.node.name === 'Increment').node.ref;
      assert.equal((await request(base + '/commands', action('click', {
        observationId: before.observationId, ref: old }))).value.status, 'FAILED');

      const increment = action('click', await target(request, base, 'Increment'));
      await assert.rejects(request(base + '/commands', increment, 'POST', AbortSignal.timeout(80)));
      let receipt;
      const receiptDeadline = Date.now() + 10_000;
      do {
        receipt = await request(base + '/commands/' + increment.operationId);
        if (receipt.value.status === 'SUCCEEDED') break;
        await delay(50);
      } while (Date.now() < receiptDeadline);
      assert.equal(receipt.value.status, 'SUCCEEDED');
      assert.deepEqual(await request(base + '/commands', increment), receipt);
      assert.ok(snapshotText((await request(base + '/observe')).value).includes('"counter":1'));
    } finally {
      if (createdSession) {
        const closed = await Promise.all([request(base, undefined, 'DELETE'), request(base, undefined, 'DELETE')]);
        for (const result of closed) assert.equal(result.value.status, 'CLOSED');
        assert.equal((await request(base + '/cleanup', undefined, 'DELETE')).code, 200);
        for (const route of ['/containers/helm-browser-' + id + '/json',
          '/containers/helm-browser-' + id + '-egress/json', '/networks/helm-browser-' + id,
          '/volumes/helm-browser-' + id + '-data']) {
          const response = await fetch(docker + route);
          assert.equal(response.status, 404, 'CLOSED must acknowledge resource disposal');
          await response.body?.cancel();
        }
      }
    }
  });
