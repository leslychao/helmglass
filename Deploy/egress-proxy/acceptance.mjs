import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('/run/helm', { recursive: true, mode: 0o700 });
await mkdir('/run/secrets', { recursive: true, mode: 0o700 });
const password = randomBytes(32).toString('base64');
await writeFile('/run/secrets/egress_identity', JSON.stringify({ schemaVersion: 1, mediaProxyUsername: 'helm-media', mediaProxyPassword: password }), { mode: 0o600 });
const squid = spawn('/opt/helm/bin/entrypoint', [], { stdio: 'inherit' });
const turn = net.createServer(socket => socket.end());
await new Promise(resolve => turn.listen(3478, '0.0.0.0', resolve));
function proxyRequest(target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3128, path: target, headers, timeout: 20000 }, response => {
      response.resume(); resolve(response.statusCode);
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(new Error('PROXY_TIMEOUT'))); req.end();
  });
}
function connect(authority, credential) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(3128, '127.0.0.1'); socket.setTimeout(5000);
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credential ? `Proxy-Authorization: Basic ${Buffer.from(credential).toString('base64')}\r\n` : ''}\r\n`));
    socket.once('data', data => { resolve(Number(data.toString().split(' ')[1])); socket.destroy(); });
    socket.once('error', reject); socket.once('timeout', () => socket.destroy(new Error('CONNECT_TIMEOUT')));
  });
}
try {
  let ready = false;
  for (let count = 0; count < 50; count++) {
    try { ready = await proxyRequest('http://127.0.0.1/') === 403; if (ready) break; } catch { }
    await delay(100);
  }
  assert.ok(ready, 'Squid listener did not become ready');
  for (const target of ['http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://coturn:3478/']) {
    assert.equal(await proxyRequest(target), 403, target);
  }
  assert.ok([403, 407].includes(await connect('coturn:3478')), 'Browser may not enter helper CONNECT route');
  assert.ok([403, 407].includes(await connect('coturn:3478', 'helm-media:wrong')), 'Incorrect media identity accepted');
  assert.equal(await connect('coturn:3478', 'helm-media:' + password), 200);
  assert.equal(await connect('127.0.0.1:3478', 'helm-media:' + password), 200);
  assert.equal(await connect('10.0.0.1:3478', 'helm-media:' + password), 403);
  assert.equal(await proxyRequest('http://example.com/', { 'Proxy-Authorization': 'Basic ' + Buffer.from('helm-media:' + password).toString('base64') }), 403);
  const publicStatus = await proxyRequest('http://example.com/');
  assert.ok(publicStatus >= 200 && publicStatus < 400, 'Public HTTP destination unavailable: ' + publicStatus);
  assert.equal(await connect('example.com:443'), 200);
  console.log('Squid acceptance passed: private IPv4/IPv6 and mapped IPv4 denied, public HTTP/HTTPS allowed, helper-only CONNECT authenticated');
} finally {
  squid.kill('SIGTERM'); await new Promise(resolve => turn.close(resolve));
}
