import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NodeServerResponseLike } from '@modelcontextprotocol/node';
import { authenticatedAdapter, createAdapter } from '../src/server.js';

const origin = 'https://helm.example.test';
const headers = {
  host: 'helm.example.test',
  authorization: 'Bearer fixture',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

class BackpressuredResponse extends EventEmitter implements NodeServerResponseLike {
  destroyed = false;
  ended = false;
  status = 0;
  writes = 0;
  readonly written = Promise.withResolvers<void>();

  writeHead(status: number) { this.status = status; }
  write() {
    this.writes++;
    this.written.resolve();
    return false;
  }
  end() { this.ended = true; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

function payload(name = 'audio.get') {
  return {
    jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
    params: {
      name,
      arguments: name === 'audio.get'
        ? { taskId: randomUUID(), artifactId: randomUUID() }
        : { taskId: randomUUID() },
    },
  };
}

test('audio deadline closes the native response while the pinned Node SDK waits for drain', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const handler = createAdapter({ call: async (name, _args, _bearer, _id, _host, signal) => {
    if (name !== 'audio.get') return { content: [] };
    assert.ok(signal);
    signals.push(signal);
    return { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'AA==' }] };
  } }, '<html>__HELM_PUBLIC_ORIGIN__</html>', origin);
  const app = authenticatedAdapter(handler,
    async token => ({ token, clientId: 'fixture', scopes: ['tasks:read'] }), origin, `${origin}/idp`);
  const first = new BackpressuredResponse();
  const second = new BackpressuredResponse();
  let completed = 0;
  const pending = [first, second].map(response => {
    const request = Object.assign(Readable.from([]), { method: 'POST', url: '/mcp', headers });
    const serve = toNodeHandler({ fetch: request => app.fetch(request, () => response.destroy()) });
    return serve(request, response, payload()).then(() => { completed++; });
  });
  const call = (name = 'audio.get') => app.fetch(new Request(`${origin}/mcp`, {
    method: 'POST', headers, body: JSON.stringify(payload(name)),
  }));
  try {
    await Promise.all([first.written.promise, second.written.promise]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.writes, 1);
    assert.equal(second.writes, 1);
    assert.equal(completed, 0);
    assert.equal(signals.length, 2);
    assert.match(await (await call()).text(), /AUDIO_DELIVERY_BUSY/);
    assert.doesNotMatch(await (await call('tasks.get')).text(), /AUDIO_DELIVERY_BUSY/);
    context.mock.timers.tick(19_999);
    await setImmediate();
    assert.equal(first.destroyed, false);
    assert.equal(second.destroyed, false);
    context.mock.timers.tick(1);
    for (let attempt = 0; attempt < 20 && completed !== 2; attempt++) await setImmediate();
    assert.equal(first.destroyed, true);
    assert.equal(second.destroyed, true);
    assert.equal(completed, 2, 'deadline must wake the SDK drain wait, not only cancel its body');
    assert.equal(first.ended, true);
    assert.equal(second.ended, true);
    assert.ok(signals.every(signal => signal.aborted));
    assert.doesNotMatch(await (await call()).text(), /AUDIO_DELIVERY_BUSY/);
    assert.equal(signals.length, 3);
  } finally {
    first.destroy();
    second.destroy();
    await Promise.all(pending);
    context.mock.timers.reset();
    await handler.close();
  }
});
