import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { test } from 'node:test';

// Run in an existing, test-owned dev egress container. The public DNS service
// changes the same name from public to loopback; no local resolver is installed.
// Service contract: https://github.com/neex/1u.ms#dns-rebinding
const proxy = new URL(process.env.EGRESS_URL ?? 'http://127.0.0.1:3128');

function connectStatus(hostname) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let headers = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Proxy handshake timed out')));
    socket.once('connect', () => socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`));
    socket.on('data', chunk => {
      headers += chunk.toString('ascii');
      if (headers.length > 4096) { socket.destroy(new Error('Oversized proxy handshake')); return; }
      if (!headers.includes('\r\n\r\n')) return;
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headers)?.[1]);
      socket.destroy(); resolve(status);
    });
    socket.once('error', reject);
  });
}

test('a changing DNS answer cannot reuse an earlier public-address authorization', { timeout: 30000 }, async () => {
  const hostname = `probe-${randomUUID()}.make-1-1-1-1-rebindfor30safter20times-127-0-0-1-rr.1u.ms`;
  const initial = await lookup(hostname, { all: true });
  assert.deepEqual(initial.map(value => value.address), ['1.1.1.1']);
  const statuses = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    statuses.push(await connectStatus(hostname));
    if (statuses.includes(200) && statuses.at(-1) === 403) break;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  assert.equal(statuses[0], 200, 'The first tunnel must actually connect to the public address');
  assert.equal(statuses.at(-1), 403, 'A later answer for the same name must be denied');
  assert.deepEqual((await lookup(hostname, { all: true })).map(value => value.address), ['127.0.0.1']);
  assert.equal(await connectStatus(hostname), 403, 'The changed answer remains forbidden');
});

test('mixed public and private DNS answers are rejected before opening a tunnel', { timeout: 15000 }, async () => {
  const hostname = `probe-${randomUUID()}.make-1-1-1-1-and-127-0-0-1-rr.1u.ms`;
  const addresses = await lookup(hostname, { all: true });
  assert.deepEqual(addresses.map(value => value.address).sort(), ['1.1.1.1', '127.0.0.1']);
  assert.equal(await connectStatus(hostname), 403, 'Every answer must be public, regardless of DNS ordering');
});
