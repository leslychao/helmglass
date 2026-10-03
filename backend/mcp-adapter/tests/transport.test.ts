import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { authenticatedAdapter, createAdapter } from '../src/server.js';
import { toolSchemas, widgetResourceUri } from '../src/catalog.js';
import type { HostConversationContext } from '../src/host-context.js';

const publicOrigin = 'https://helm.example.test';
const widgetHtml = '<html><script type="application/json" id="helm-runtime-config">{"publicOrigin":"__HELM_PUBLIC_ORIGIN__"}</script></html>';

test('task resume accepts optional reconciliation without unrelated browser consent', () => {
  const input = { taskId: randomUUID(), idempotencyKey: randomUUID(), expectedTaskVersion: 9 };
  assert.deepEqual(toolSchemas['tasks.resume'].parse(input), input);
  const reconciled = { ...input, resolutionId: randomUUID() };
  assert.deepEqual(toolSchemas['tasks.resume'].parse(reconciled), reconciled);
  assert.equal(toolSchemas['tasks.resume'].safeParse({ ...input, resolutionId: 'invalid' }).success, false);
  assert.equal(toolSchemas['tasks.resume'].safeParse({ ...input, consentNewBrowser: true }).success, false);
});

test('widget configuration rejects noncanonical origins and missing or repeated markers', () => {
  const owner = { call: async () => ({ content: [] }) };
  for (const origin of ['http://helm.example.test', 'https://helm.example.test/path', 'https://user:secret@helm.example.test']) {
    assert.throws(() => createAdapter(owner, widgetHtml, origin));
  }
  assert.throws(() => createAdapter(owner, '<html></html>', publicOrigin));
  assert.throws(() => createAdapter(owner, widgetHtml + '__HELM_PUBLIC_ORIGIN__', publicOrigin));
});

test('result presentation accepts safe sources and keeps older clients compatible', () => {
  const input = { taskId: randomUUID(), idempotencyKey: randomUUID(), expectedTaskVersion: 1,
    instructionRevision: 1, conclusion: 'Report', limitations: [], missing: [], columns: [], rows: [],
    coverage: {}, artifactIds: [] };
  assert.deepEqual(toolSchemas['results.publish'].parse(input).sections, []);
  assert.deepEqual(toolSchemas['results.publish'].parse(input).sources, []);
  assert.equal(toolSchemas['results.publish'].safeParse({ ...input,
    sections: [{ title: 'Details', text: 'Observed values' }],
    sources: [{ title: 'Source', url: 'https://example.com/report' }] }).success, true);
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.com/report', 'file:///tmp/a']) {
    assert.equal(toolSchemas['results.publish'].safeParse({ ...input,
      sources: [{ title: 'Invalid', url }] }).success, false);
  }
});

function request(body: unknown, extra: Record<string, string> = {}): Request {
  return new Request(`${publicOrigin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', authorization: 'Bearer test', ...extra }, body: JSON.stringify(body) });
}

async function resultEnvelope(response: Response): Promise<unknown> {
  const body = await response.text();
  const messages: unknown[] = response.headers.get('content-type')?.startsWith('text/event-stream')
    ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    : [JSON.parse(body)];
  assert.equal(messages.length, 1);
  return messages[0];
}

test('MCP rejects cookies as authorization and rejects cross-origin browser requests', async () => {
  let calls = 0;
  const handler = createAdapter({ call: async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; } }, widgetHtml, publicOrigin);
  const app = authenticatedAdapter(handler, async (token) => ({ token, clientId: 'test-client', scopes: ['tasks:read'] }), publicOrigin, `${publicOrigin}/idp`);
  try {
    const missing = await app.fetch(new Request(`${publicOrigin}/mcp`, { method: 'POST', headers: { cookie: 'session=example' } }));
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate') ?? '', /oauth-protected-resource/);
    const crossOrigin = await app.fetch(request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://attacker.test' }));
    assert.equal(crossOrigin.status, 403);
    assert.equal(calls, 0);
  } finally { await handler.close(); }
});

test('Widget HTML and CSP travel in resource contents without cookie-gated asset dependencies', async () => {
  const html = widgetHtml.replace('</html>', '<style>body{margin:0}</style><script type="module">document.body.dataset.ready="true";</script></html>');
  const handler = createAdapter({ call: async () => { throw new Error('Resource reads must not invoke application mutations'); } }, html, publicOrigin);
  const app = authenticatedAdapter(handler, async (token) => ({ token, clientId: 'fixture-client', scopes: ['tasks:read'] }), publicOrigin, `${publicOrigin}/idp`);
  try {
    const response = await app.fetch(request({ jsonrpc: '2.0', id: 20, method: 'resources/read', params: { uri: widgetResourceUri } }));
    assert.equal(response.status, 200);
    const body = await response.text();
    const messages = response.headers.get('content-type')?.startsWith('text/event-stream')
      ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
      : [JSON.parse(body)];
    assert.equal(messages.length, 1);
    const resource = messages[0].result.contents[0];
    assert.equal(resource.text, html.replace('__HELM_PUBLIC_ORIGIN__', publicOrigin));
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(resource._meta.ui.csp.resourceDomains, []);
    assert.deepEqual(resource._meta.ui.csp.connectDomains, [publicOrigin, 'wss://helm.example.test']);
    assert.deepEqual(resource._meta['openai/widgetCSP'].redirect_domains, [publicOrigin]);
  } finally { await handler.close(); }
});

test('legacy MCP tool calls use official SDK and forward original Bearer without retries', async () => {
  let calls = 0;
  const handler = createAdapter({ call: async (name, args, token) => {
    calls++; assert.equal(name, 'tasks.get'); assert.equal(token, 'test');
    assert.deepEqual(args, { taskId });
    throw new Error('Connection lost after owner acceptance');
  } }, widgetHtml, publicOrigin);
  const app = authenticatedAdapter(handler, async (token) => ({ token, clientId: 'test-client', scopes: ['tasks:read'] }), publicOrigin, `${publicOrigin}/idp`);
  const taskId = randomUUID();
  try {
    const response = await app.fetch(request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tasks.get', arguments: { taskId } } }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OWNER_RESPONSE_UNKNOWN/);
    assert.equal(calls, 1);
  } finally { await handler.close(); }
});

test('typed transport cannot expose arbitrary JS or accept missing mutation idempotency', () => {
  assert.equal(toolSchemas['tasks.stop'].safeParse({ taskId: randomUUID() }).success, false);
  assert.equal(toolSchemas['browser.execute'].safeParse({ action: { type: 'EVALUATE', script: 'document.cookie' } }).success, false);
  assert.equal(toolSchemas['continuations.record_delivery'].safeParse({ dispatchId: randomUUID(), idempotencyKey: randomUUID(), outcome: 'UNKNOWN' }).success, true);
});

test('task creation exposes supported instructions and rejects an unsupported title before mutation', async () => {
  const args = { idempotencyKey: randomUUID(), goal: 'Read the public page',
    startUrl: 'https://example.com/', connectionIds: [], outputFormat: 'TEXT',
    browserTimeLimitSeconds: 600, confirmImportantActions: true, intent: 'DRAFT' };
  let calls = 0;
  const handler = createAdapter({ call: async (name, input) => {
    calls++;
    assert.equal(name, 'tasks.create');
    assert.deepEqual(input, args);
    return { content: [{ type: 'text', text: 'created' }] };
  } }, widgetHtml, publicOrigin);
  const app = authenticatedAdapter(handler, async token => ({ token, clientId: 'fixture-client',
    scopes: ['tasks:write'] }), publicOrigin, `${publicOrigin}/idp`);
  try {
    const discovery = await app.fetch(request({ jsonrpc: '2.0', id: 70, method: 'tools/list' }));
    const catalog = z.object({ result: z.object({ tools: z.array(z.object({
      name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }),
    })) }) }).parse(await resultEnvelope(discovery));
    const create = catalog.result.tools.find(tool => tool.name === 'tasks.create');
    assert.ok(create);
    assert.ok('goal' in create.inputSchema.properties);
    assert.ok(!('title' in create.inputSchema.properties));

    const rejected = await app.fetch(request({ jsonrpc: '2.0', id: 71, method: 'tools/call',
      params: { name: 'tasks.create', arguments: { ...args, title: 'Silently ignored title' } } }));
    assert.ok(!JSON.stringify(await resultEnvelope(rejected)).includes('created'));
    assert.equal(calls, 0);
    const accepted = await app.fetch(request({ jsonrpc: '2.0', id: 72, method: 'tools/call',
      params: { name: 'tasks.create', arguments: args } }));
    assert.match(await accepted.text(), /created/);
    assert.equal(calls, 1);
  } finally { await handler.close(); }
});

test('tool discovery renders only explicit presentation and keeps execution claims and reads non-rendering', async () => {
  const handler = createAdapter({ call: async () => ({ content: [] }) }, widgetHtml, publicOrigin);
  const app = authenticatedAdapter(handler, async (token) => ({ token, clientId: 'fixture-client', scopes: ['tasks:read'] }), publicOrigin, `${publicOrigin}/idp`);
  try {
    const response = await app.fetch(request({ jsonrpc: '2.0', id: 30, method: 'tools/list' }));
    assert.equal(response.status, 200);
    const body = z.object({ result: z.object({ tools: z.array(z.object({
      name: z.string(), _meta: z.record(z.string(), z.unknown()),
    })) }) }).parse(await resultEnvelope(response));
    const tools = new Map(body.result.tools.map(tool => [tool.name, tool._meta]));
    for (const name of ['tasks.view', 'tasks.continue', 'browser.execute', 'browser.observe', 'media.capture']) {
      assert.deepEqual(tools.get(name)?.ui, {
        ...(name === 'tasks.view' ? { resourceUri: widgetResourceUri } : {}),
        visibility: ['model'],
      }, name);
      assert.equal(tools.get(name)?.['openai/outputTemplate'],
        name === 'tasks.view' ? widgetResourceUri : undefined, name);
    }
    for (const name of ['browser.attach_view', 'continuations.prepare_message', 'continuations.record_delivery']) {
      assert.deepEqual(tools.get(name)?.ui, { visibility: ['app'] }, name);
      assert.equal(tools.get(name)?.['openai/widgetAccessible'], true, name);
      assert.equal(tools.get(name)?.['openai/outputTemplate'], undefined, name);
    }
    assert.equal(tools.get('tasks.get')?.['openai/outputTemplate'], undefined);
    assert.deepEqual(tools.get('tasks.get')?.ui, { visibility: ['model'] });
    assert.equal(tools.get('browser.execute')?.['openai/widgetAccessible'], undefined);
    for (const name of ['tasks.view', 'browser.attach_view']) {
      assert.deepEqual(tools.get(name)?.securitySchemes, [{ type: 'oauth2', scopes: ['tasks:read', 'browser:view'] }]);
    }
    assert.deepEqual(tools.get('tasks.complete')?.securitySchemes, [{ type: 'oauth2', scopes: ['tasks:write', 'results:write'] }]);
    assert.deepEqual(tools.get('tasks.continue')?.securitySchemes, [{ type: 'oauth2', scopes: ['tasks:write', 'browser:execute'] }]);
  } finally { await handler.close(); }
});

test('modern stateless envelope preserves scopes and rejects a write with read-only authorization', async () => {
  let calls = 0;
  const handler = createAdapter({ call: async () => { calls++; return { content: [{ type: 'text', text: 'owner-result' }] }; } }, widgetHtml, publicOrigin);
  const app = authenticatedAdapter(handler, async (token) => ({ token, clientId: 'test-client', scopes: ['tasks:read'] }), publicOrigin, `${publicOrigin}/idp`);
  const envelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  try {
    const response = await app.fetch(request({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
      name: 'tasks.get', arguments: { taskId: randomUUID() }, _meta: envelope,
    } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'tasks.get' }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /owner-result/);
    const denied = await app.fetch(request({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: {
      name: 'tasks.stop', arguments: { taskId: randomUUID(), idempotencyKey: randomUUID() }, _meta: envelope,
    } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'tasks.stop' }));
    assert.match(await denied.text(), /INSUFFICIENT_SCOPE/);
    assert.equal(calls, 1);
  } finally { await handler.close(); }
});

test('continuation requires task write and browser execution authorization before reaching the owner', async () => {
  let calls = 0;
  const handler = createAdapter({ call: async () => {
    calls++;
    return { content: [{ type: 'text', text: 'continuation-claimed' }] };
  } }, widgetHtml, publicOrigin);
  const args = { taskId: randomUUID(), continuationId: randomUUID(),
    idempotencyKey: randomUUID(), expectedInstructionRevision: 1 };
  try {
    for (const scopes of [['tasks:write'], ['browser:execute'], ['tasks:write', 'browser:execute']]) {
      const app = authenticatedAdapter(handler, async token => ({ token, clientId: 'fixture-client', scopes }),
        publicOrigin, `${publicOrigin}/idp`);
      const response = await app.fetch(request({ jsonrpc: '2.0', id: 39, method: 'tools/call',
        params: { name: 'tasks.continue', arguments: args } }));
      assert.equal(response.status, 200);
      assert.match(await response.text(), scopes.length === 2 ? /continuation-claimed/ : /INSUFFICIENT_SCOPE/);
    }
    assert.equal(calls, 1, 'partial grants cannot reach the continuation owner');
  } finally { await handler.close(); }
});

test('verified host metadata stays separate from tool arguments in model and app calls', async () => {
  const received: (HostConversationContext | undefined)[] = [];
  const handler = createAdapter({ call: async (_name, _args, _token, _requestId, hostContext) => {
    received.push(hostContext);
    return { content: [{ type: 'text', text: 'accepted' }] };
  } }, widgetHtml, publicOrigin);
  const app = authenticatedAdapter(handler, async token => ({ token, clientId: 'fixture-client',
    scopes: ['tasks:read', 'browser:view'] }), publicOrigin, `${publicOrigin}/idp`);
  const taskId = randomUUID();
  const metadata = { 'openai/session': 'fixture-conversation-a', unrelated: 'must-not-be-delegated' };
  try {
    for (const [id, name, args, meta] of [
      [40, 'tasks.get', { taskId }, metadata],
      [41, 'browser.attach_view', { taskId, viewScopeId: randomUUID(), presentationRevision: 0,
        viewerInstanceId: randomUUID(), observedSessionId: null }, metadata],
      [42, 'tasks.get', { taskId }, { 'openai/session': 'fixture-conversation-b' }],
    ] as const) {
      const response = await app.fetch(request({ jsonrpc: '2.0', id, method: 'tools/call',
        params: { name, arguments: args, _meta: meta } }));
      assert.match(await response.text(), /accepted/);
    }
    assert.deepEqual(received[0], received[1], 'model and app calls bind to the same conversation');
    assert.notEqual(received[0]?.conversationKey, received[2]?.conversationKey);
    assert.deepEqual(Object.keys(received[0] ?? {}).sort(), ['contractVersion', 'conversationKey', 'provider']);
    assert.equal(received[0]?.provider, 'CHATGPT_WEB');
    assert.equal(received[0]?.contractVersion, '2026-10-03');
    assert.match(received[0]?.conversationKey ?? '', /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(received).includes('fixture-conversation'));
    assert.ok(!JSON.stringify(received).includes('must-not-be-delegated'));

    const forged = await app.fetch(request({ jsonrpc: '2.0', id: 43, method: 'tools/call', params: {
      name: 'tasks.get', arguments: { taskId, hostContext: received[0] },
    } }));
    assert.ok(!JSON.stringify(await resultEnvelope(forged)).includes('accepted'));
    assert.equal(received.length, 3, 'model arguments cannot inject a host context');
  } finally { await handler.close(); }
});

test('absent, malformed and oversized host metadata does not prevent ordinary authorized reads', async () => {
  const received: (HostConversationContext | undefined)[] = [];
  const handler = createAdapter({ call: async (_name, _args, _token, _requestId, hostContext) => {
    received.push(hostContext);
    return { content: [{ type: 'text', text: 'accepted' }] };
  } }, widgetHtml, publicOrigin);
  const app = authenticatedAdapter(handler, async token => ({ token, clientId: 'fixture-client',
    scopes: ['tasks:read'] }), publicOrigin, `${publicOrigin}/idp`);
  const envelope = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} };
  try {
    for (const [index, value] of [undefined, null, '', 123, {}, [], 'a'.repeat(4097), 'é'.repeat(2049),
      'fixture-modern-conversation'].entries()) {
      const response = await app.fetch(request({ jsonrpc: '2.0', id: index + 50, method: 'tools/call',
        params: { name: 'tasks.get', arguments: { taskId: randomUUID() },
          _meta: { ...envelope, 'openai/session': value } } },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'tasks.get' }));
      assert.match(await response.text(), /accepted/);
    }
    assert.equal(received.length, 9);
    assert.ok(received.slice(0, 8).every(context => context === undefined));
    assert.match(received[8]?.conversationKey ?? '', /^[a-f0-9]{64}$/);
  } finally { await handler.close(); }
});
