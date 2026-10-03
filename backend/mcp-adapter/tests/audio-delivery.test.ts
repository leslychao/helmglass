import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { authenticatedAdapter, createAdapter } from '../src/server.js';
import type { OwnerClient } from '../src/owner-client.js';

const origin = 'https://helm.example.test';
const widget = '<html><script>{"publicOrigin":"__HELM_PUBLIC_ORIGIN__"}</script></html>';
const wav = Buffer.alloc(60);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16, 40);
for (let i = 0; i < 8; i++) wav.writeInt16LE(i % 2 ? 1000 : -1000, 44 + i * 2);
const audio: CallToolResult = { content: [{ type: 'audio', mimeType: 'audio/wav', data: wav.toString('base64') }],
  structuredContent: { byteLength: wav.length, delivery: { status: 'UNVERIFIED', reason: 'HOST_AUDIO_ACCESS_NOT_VERIFIED' } } };

function request(name = 'audio.get', signal?: AbortSignal) {
  return new Request(`${origin}/mcp`, { method: 'POST', headers: { authorization: 'Bearer test',
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
      params: { name, arguments: name === 'audio.get' ? { taskId: randomUUID(), artifactId: randomUUID() } : { taskId: randomUUID() } } }),
    ...(signal ? { signal } : {}) });
}

function fixture(call: OwnerClient['call']) {
  const handler = createAdapter({ call }, widget, origin);
  return { handler, app: authenticatedAdapter(handler, async token => ({ token, clientId: 'fixture', scopes: ['tasks:read'] }),
    origin, `${origin}/idp`) };
}

test('a complete PCM WAV survives the real MCP SDK envelope without claiming host understanding', async () => {
  const { handler, app } = fixture(async () => audio);
  try {
    const response = await app.fetch(request());
    const body = await response.text();
    const json = response.headers.get('content-type')?.startsWith('text/event-stream')
      ? body.split('\n').find(line => line.startsWith('data:'))?.slice(5) : body;
    assert.ok(json);
    const value = JSON.parse(json) as { result: CallToolResult };
    const first = value.result.content?.[0];
    assert.equal(first?.type, 'audio');
    assert.ok(first?.type === 'audio');
    assert.equal(first.mimeType, 'audio/wav');
    assert.deepEqual(Buffer.from(first.data, 'base64'), wav);
    assert.deepEqual(value.result.structuredContent, audio.structuredContent);
  } finally { await handler.close(); }
});

test('audio admission remains bounded until responses are consumed or cancelled and does not block other tools', async () => {
  let calls = 0;
  const { handler, app } = fixture(async name => { calls++; return name === 'audio.get' ? audio : { content: [] }; });
  try {
    const first = await app.fetch(request());
    const second = await app.fetch(request());
    const reader = first.body?.getReader();
    assert.ok(reader);
    assert.equal((await reader.read()).done, false);
    // The Node HTTP adapter waits for socket drain before asking for the following chunk/EOF.
    const rejected = await app.fetch(request());
    assert.match(await rejected.text(), /AUDIO_DELIVERY_BUSY/);
    assert.equal(calls, 2);
    const other = await app.fetch(request('tasks.get'));
    await other.text();
    assert.equal(calls, 3);
    await reader.cancel();
    const replacement = await app.fetch(request());
    assert.equal(calls, 4);
    await second.text();
    await replacement.text();
    const reused = await app.fetch(request());
    await reused.text();
    assert.equal(calls, 5);
  } finally { await handler.close(); }
});

test('cancellation aborts an active owner download and permits a subsequent delivery', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = false;
  let first = true;
  const { handler, app } = fixture(async (_name, _args, _bearer, _id, _host, signal) => {
    if (!first) return audio;
    first = false;
    assert.ok(signal);
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled = true; reject(new Error('cancelled'));
    }, { once: true }));
  });
  try {
    const cancel = new AbortController();
    const pending = app.fetch(request('audio.get', cancel.signal));
    await started;
    cancel.abort();
    const response = await pending;
    await assert.rejects(response.text(), /AUDIO_DELIVERY_CANCELLED/);
    assert.equal(cancelled, true);
    await (await app.fetch(request())).text();
  } finally { await handler.close(); }
});

test('the audio deadline covers an owner that never finishes without its cancellation signal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let cancelled = false;
  const { handler, app } = fixture(async (_name, _args, _bearer, _id, _host, signal) => {
    assert.ok(signal);
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled = true; reject(new Error('deadline'));
    }, { once: true }));
  });
  try {
    const pending = app.fetch(request());
    await started;
    context.mock.timers.tick(20_000);
    const response = await pending;
    await assert.rejects(response.text(), /AUDIO_DELIVERY_CANCELLED/);
    assert.equal(cancelled, true);
  } finally { context.mock.timers.reset(); await handler.close(); }
});
