import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserSession } from '../src/session.js';
import { digest } from '../src/protocol.js';
import { upstreamErrorCode } from '../src/playwright-mcp.js';
import type { Assignment } from '../src/protocol.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('real Chromium blocks forbidden redirect hops, subresources and sockets before transmission', { timeout: 30_000 }, async (testContext) => {
  let forbiddenRequests = 0;
  let forbiddenSockets = 0;
  const forbidden = createServer((_request, response) => { forbiddenRequests++; response.end('forbidden'); });
  forbidden.on('upgrade', (_request, socket) => { forbiddenSockets++; socket.destroy(); });
  const blockedOrigin = await listen(forbidden);
  const receipts: { method: string | undefined; body: string; authorization: string | undefined; hasCookie: boolean }[] = [];
  const permitted = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      receipts.push({ method: request.method, body, authorization: request.headers.authorization, hasCookie: Boolean(request.headers.cookie) });
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end('permitted');
    });
  });
  const permittedOrigin = await listen(permitted);
  const source = createServer((request, response) => {
    const path = request.url?.split('?', 1)[0];
    if (path?.startsWith('/redirect-')) {
      response.writeHead(path === '/redirect-303' ? 303 : 307, {
        location: (path === '/redirect-denied' ? blockedOrigin : permittedOrigin) + '/target',
      });
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Origin policy fixture</title><h1>Public page</h1>');
  });
  const origin = await listen(source);
  const directory = await mkdtemp(join(tmpdir(), 'helm-origin-test-'));
  const assignment: Assignment = { taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: randomUUID(),
    purpose: 'TASK', allocationEpoch: 1, controlEpoch: 1, privacyEpoch: 1, pageEpoch: 1, policyVersion: 1,
    instructionRevision: 1, originPolicy: 'DENYLIST', allowedOrigins: [], deniedOrigins: [blockedOrigin],
    deadline: new Date(Date.now() + 30_000).toISOString(), viewport: { width: 1280, height: 720 } };
  let session: BrowserSession | undefined;
  try {
    session = await BrowserSession.create(assignment, { stagingDirectory: directory, headless: true, mediaBarrier: async () => undefined });
    await session.context.addCookies([{ name: 'fixture_session', value: 'private-fixture-cookie', url: origin }]);
    const page = session.context.pages()[0];
    assert.ok(page);
    page.on('console', (message) => { if (message.type() === 'error') testContext.diagnostic(message.text()); });
    page.on('requestfailed', (request) => testContext.diagnostic('Failed fixture request: ' + request.failure()?.errorText));
    await page.goto(origin);
    const allowedResults = await page.evaluate(async () => {
      const values = [];
      for (const status of [307, 303]) {
        const response = await fetch('/redirect-' + status, { method: 'POST', body: 'submitted-once',
          headers: { Authorization: 'Bearer private-fixture-value' } });
        values.push(await response.text());
      }
      return values;
    });
    assert.deepEqual(allowedResults, ['permitted', 'permitted']);
    assert.deepEqual(receipts, [
      { method: 'POST', body: 'submitted-once', authorization: undefined, hasCookie: false },
      { method: 'GET', body: '', authorization: undefined, hasCookie: false },
    ]);
    const deniedResults = await page.evaluate(async (blocked) => {
      const results = [];
      for (const target of ['/redirect-denied', blocked + '/subresource']) {
        try { await fetch(target); results.push('unexpected response'); }
        catch { results.push('blocked'); }
      }
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(blocked.replace('http:', 'ws:') + '/socket');
        socket.onclose = () => resolve();
        socket.onerror = () => resolve();
      });
      return results;
    }, blockedOrigin);
    assert.deepEqual(deniedResults, ['blocked', 'blocked']);
    const command = { commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId,
      browserSessionId: assignment.browserSessionId, action: { type: 'NAVIGATE' as const, url: origin + '/redirect-denied?private-fixture-value' } };
    const failure = await session.execute(command, async () => ({ ...assignment, commandId: command.commandId,
      attemptId: command.attemptId, permitId: randomUUID(), actionDigest: digest(command.action),
      deadline: new Date(Date.now() + 10_000).toISOString() }));
    assert.equal(failure.status, 'UNKNOWN');
    assert.equal(failure.effectState, 'UNKNOWN');
    assert.equal(failure.code, 'BROWSER_NETWORK_BLOCKED_BY_CLIENT');
    assert.equal(JSON.stringify(failure).includes('private-fixture-value'), false);
    assert.equal(forbiddenRequests, 0);
    assert.equal(forbiddenSockets, 0);
  } finally {
    await session?.close();
    await Promise.all([close(source), close(permitted), close(forbidden)]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('upstream diagnostics expose only fixed categories, never error text', () => {
  assert.equal(upstreamErrorCode('Error: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://secret.invalid/?token=private'), 'BROWSER_NETWORK_TUNNEL_CONNECTION_FAILED');
  assert.equal(upstreamErrorCode('TimeoutError: page.goto: Timeout 20000ms exceeded.\nprivate page data'), 'BROWSER_ACTION_TIMEOUT');
  assert.equal(upstreamErrorCode('private page says net::ERR_CONNECTION_RESET'), 'BROWSER_HANDLER_FAILED');
  assert.equal(upstreamErrorCode('Error: page.goto: net::ERR_PRIVATE_SECRET at https://secret.invalid/'), 'BROWSER_HANDLER_FAILED');
});
