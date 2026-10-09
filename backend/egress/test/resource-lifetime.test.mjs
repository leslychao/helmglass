import assert from 'node:assert/strict';
import { readdir, readFile, readlink } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

// Run inside a test-owned dev egress container. PID 1 is the deployed proxy.
async function upstreamSockets() {
  const owned = new Set();
  for (const descriptor of await readdir('/proc/1/fd')) {
    try { owned.add(await readlink('/proc/1/fd/' + descriptor)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const rows = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1);
  return rows.map(row => row.trim().split(/\s+/))
    .filter(fields => fields[2].endsWith(':0050') && fields[3] === '01'
      && owned.has('socket:[' + fields[9] + ']')).length;
}

test('disconnect before upstream response releases the HTTP request socket', { timeout: 20_000 }, async () => {
  const before = await upstreamSockets();
  for (let cycle = 0; cycle < 3; cycle++) {
    const client = net.connect({ host: '127.0.0.1', port: 3128 });
    let received = false;
    let failure;
    client.on('data', () => { received = true; });
    client.on('error', error => { failure = error; });
    try {
      client.once('connect', () => client.write(
        'GET http://httpbin.org/delay/15 HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n'));
      const deadline = Date.now() + 5000;
      while (await upstreamSockets() === before && !received && !failure && Date.now() < deadline) {
        await delay(25);
      }
      assert.ifError(failure);
      assert.equal(await upstreamSockets(), before + 1, 'The proxy must actually connect upstream');
      await delay(100);
      assert.equal(received, false, 'The external fixture must still be waiting to respond');
      client.destroy();
      const releaseDeadline = Date.now() + 1500;
      while (await upstreamSockets() !== before && Date.now() < releaseDeadline) await delay(25);
      const afterDisconnect = await upstreamSockets();
      console.log(JSON.stringify({ cycle, before, during: before + 1, afterDisconnect }));
      assert.equal(afterDisconnect, before, 'An abandoned response must release its upstream socket');
    } finally { client.destroy(); }
  }
});
