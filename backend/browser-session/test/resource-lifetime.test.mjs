import { target, snapshotText } from './references.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';

// Run against dev. Only the session created below may be inspected or removed.
const worker = process.env.WORKER_URL;
const docker = process.env.DOCKER_HOST;
const token = process.env.WORKER_TOKEN;
const origin = process.env.PUBLIC_URL;
assert.ok(worker && docker && token && origin);
const headers = { 'X-Worker-Token': token, 'Content-Type': 'application/json' };
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(worker + route, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  assert.equal(response.status, 200, 'Worker request: ' + route);
  return response.json();
}
async function dockerRequest(route, body) {
  const response = await fetch(docker + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, 'Docker inspection: ' + route);
  return response;
}
async function sample(container) {
  const script = `
    import {readdir,readFile,stat} from 'node:fs/promises';
    let downloads=0, downloadBytes=0, descriptors=0, processes=0;
    for(const entry of await readdir('/tmp',{withFileTypes:true})) {
      if(!entry.isDirectory() || !entry.name.startsWith('playwright-artifacts-')) continue;
      for(const name of await readdir('/tmp/'+entry.name)) {
        const file=await stat('/tmp/'+entry.name+'/'+name);
        if(file.isFile()) {downloads++; downloadBytes+=file.size;}
      }
    }
    for(const pid of await readdir('/proc')) {
      if(!/^\\d+$/.test(pid)) continue;
      try {descriptors+=(await readdir('/proc/'+pid+'/fd')).length; processes++;}
      catch(error) {if(error.code!=='ENOENT' && error.code!=='EACCES') throw error;}
    }
    const memoryBytes=Number(await readFile('/sys/fs/cgroup/memory.current','utf8'));
    console.log(JSON.stringify({downloads,downloadBytes,descriptors,processes,memoryBytes}));`;
  const execution = await (await dockerRequest('/containers/' + container + '/exec', {
    AttachStdout: true, AttachStderr: true, Tty: true, User: 'node',
    Cmd: ['node', '--input-type=module', '-e', script],
  })).json();
  const output = await (await dockerRequest('/exec/' + execution.Id + '/start', {
    Detach: false, Tty: true,
  })).text();
  const result = await (await dockerRequest('/exec/' + execution.Id + '/json')).json();
  assert.equal(result.ExitCode, 0, 'Owned browser resource inspection failed: ' + output);
  return JSON.parse(output.trim());
}
async function closeAndCheck(id) {
  assert.equal((await request('/sessions/' + id, undefined, 'DELETE')).status, 'CLOSED');
  const container = 'helm-browser-' + id;
  for (const route of ['/containers/' + container + '/json', '/containers/' + container + '-egress/json',
    '/networks/' + container, '/volumes/' + container + '-data']) {
    const response = await fetch(docker + route, {signal: AbortSignal.timeout(15_000)});
    assert.equal(response.status, 404, 'CLOSED must release ' + route);
    await response.body?.cancel();
  }
}

test('abrupt viewer disconnects preserve the browser process and allow another live frame',
  { timeout: 90_000 }, async () => {
    const id = randomUUID(), base = '/sessions/' + id, container = 'helm-browser-' + id;
    let created = false;
    async function resetDuringFrame() {
      const ticket = randomBytes(32).toString('base64url');
      await request(base + '/ticket', {ticket, role: 'VIEWER', viewerId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), access: {channel: 'WEB', grantId: 'viewer-reset-' + id}});
      const socket = new WebSocket(worker.replace(/^http/, 'ws') + base + '/view?ticket=' + ticket,
        {headers: {Origin: origin}, maxPayload: 8_388_608});
      try {
        await new Promise((resolve, reject) => {
          let stage = 0, pending = Buffer.alloc(0), interruptedFrame = false;
          const timeout = setTimeout(() => reject(new Error('Viewer did not reach a live frame')), 5000);
          socket.on('error', reject);
          socket.on('close', () => {
            clearTimeout(timeout);
            if (interruptedFrame) resolve(); else reject(new Error('Viewer closed before a live frame'));
          });
          socket.on('message', data => {
            if (stage === 4) {
              interruptedFrame = true;
              socket.terminate();
              return;
            }
            if (pending.length + data.length > 65536) { reject(new Error('Oversized RFB handshake')); return; }
            pending = Buffer.concat([pending, data]);
            if (stage === 0 && pending.length >= 12) {
              assert.equal(pending.subarray(0, 12).toString(), 'RFB 003.008\n');
              socket.send(Buffer.from('RFB 003.008\n')); stage = 1; pending = pending.subarray(12);
            }
            if (stage === 1 && pending.length >= 1 && pending.length >= 1 + pending[0]) {
              assert.ok(pending.subarray(1, 1 + pending[0]).includes(1));
              socket.send(Buffer.from([1])); stage = 2; pending = pending.subarray(1 + pending[0]);
            }
            if (stage === 2 && pending.length >= 4) {
              assert.equal(pending.readUInt32BE(0), 0);
              socket.send(Buffer.from([1])); stage = 3; pending = pending.subarray(4);
            }
            if (stage === 3 && pending.length >= 24 && pending.length >= 24 + pending.readUInt32BE(20)) {
              const update = Buffer.alloc(10); update[0] = 3;
              pending.copy(update, 6, 0, 4);
              socket.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
              socket.send(update); stage = 4; pending = Buffer.alloc(0);
            }
          });
        });
      } finally { socket.terminate(); }
    }
    try {
      const session = await request('/sessions', {sessionId: id, ownerId: randomUUID(), startUrl: 'https://example.com'});
      created = true;
      assert.equal(session.status, 'LIVE');
      await request(base + '/control', {controlEpoch: 1, owner: 'CHATGPT', privateMode: false});
      const before = (await (await dockerRequest('/containers/' + container + '/json')).json()).State;
      for (let cycle = 0; cycle < 10; cycle++) {
        await resetDuringFrame();
        await delay(150);
        assert.equal((await request(base)).status, 'LIVE');
      }
      const after = (await (await dockerRequest('/containers/' + container + '/json')).json()).State;
      assert.equal(after.Running, true);
      assert.equal(after.Pid, before.Pid);
      assert.equal(after.StartedAt, before.StartedAt);
    } finally { if (created) await closeAndCheck(id); }
  });

test('completed downloads release staging files while archived artifacts and the live browser remain usable',
  { timeout: 150_000 }, async () => {
    const id = randomUUID(), base = '/sessions/' + id, container = 'helm-browser-' + id;
    const bytes = Buffer.from('Helm Glass resource lifetime\n'.repeat(8));
    const html = '<!doctype html><title>Resource lifetime</title><a id="download" download="sample.txt" href="data:application/octet-stream;base64,'
      + bytes.toString('base64') + '">Download</a><a id="empty" download="empty.txt" href="data:application/octet-stream;base64,">Empty</a>';
    const url = 'https://httpbin.org/base64/' + Buffer.from(html).toString('base64');
    const action = (type, args = {}) => request(base + '/commands', {
      operationId: randomUUID(), type, arguments: args, instructionRevision: 0, controlEpoch: 1,
    });
    try {
      assert.equal((await request('/sessions', {sessionId: id, ownerId: randomUUID(), startUrl: url})).status, 'LIVE');
      await request(base + '/control', {controlEpoch: 1, owner: 'CHATGPT', privateMode: false});
      assert.equal((await action('waitFor', await target(request, base, 'Download'))).status, 'SUCCEEDED', 'Download fixture is available');
      const before = await sample(container);
      for (let index = 0; index < 5; index++) {
        assert.equal((await action('click', await target(request, base, 'Download'))).status, 'SUCCEEDED');
      }
      const afterDownloads = await sample(container);
      const artifacts = (await request(base + '/artifacts')).artifacts;
      assert.equal(artifacts.length, 5);
      for (const artifact of artifacts) {
        assert.equal(artifact.sizeBytes, bytes.length);
        assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
        const response = await fetch(worker + base + '/artifacts/' + artifact.id, {headers});
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      }
      const settledWaves = [];
      for (let wave = 0; wave < 3; wave++) {
        for (let index = 0; index < 12; index++) {
          const ticket = randomBytes(32).toString('base64url');
          await request(base + '/ticket', {ticket, role: 'VIEWER', viewerId: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(), access: {channel:'WEB', grantId:'resource-test-' + id}});
          const socket = new WebSocket(worker.replace(/^http/, 'ws') + base + '/view?ticket=' + ticket,
            {headers: {Origin: origin}});
          try {
            const [greeting] = await once(socket, 'message', {signal: AbortSignal.timeout(5000)});
            assert.equal(greeting.toString(), 'RFB 003.008\n');
            const closed = once(socket, 'close', {signal: AbortSignal.timeout(5000)});
            socket.close(); await closed;
          } finally {socket.terminate();}
        }
        for (let index = 0; index < 5; index++) {
          assert.equal((await action('newTab')).status, 'SUCCEEDED');
          assert.equal((await action('closeTab')).status, 'SUCCEEDED');
        }
        // Observation window only; no forced GC or cleanup is performed.
        await delay(6000);
        settledWaves.push(await sample(container));
      }
      const afterCycles = await sample(container);
      console.log(JSON.stringify({before, afterDownloads, settledWaves, afterCycles}));
      assert.equal(afterDownloads.downloads, before.downloads, 'Completed downloads must release Playwright staging files');
      assert.equal(afterDownloads.downloadBytes, before.downloadBytes, 'Staging bytes must return to baseline');
      // An external click can have an uncertain outcome when artifact storage rejects
      // its download. Do this last: subsequent mutations correctly require reconciliation.
      const empty = await action('click', await target(request, base, 'Empty'));
      assert.equal(empty.status, 'UNKNOWN');
      assert.equal((await request(base + '/artifacts')).artifacts.length, 5,
        'Rejected empty download must not publish an artifact');
      assert.equal((await sample(container)).downloads, before.downloads,
        'Rejected downloads must also release their staging file');
      assert.equal((await request(base)).status, 'LIVE');
    } finally {
      await closeAndCheck(id);
    }
  });

test('a download triggered during private input is cancelled without retaining a file',
  { timeout: 90_000 }, async () => {
    const id = randomUUID(), base = '/sessions/' + id;
    const html = `<!doctype html><a id="download" download="private.txt" href="data:text/plain,synthetic">Download</a>
      <button id="arm" onclick="setTimeout(() => {
        document.getElementById('download').click(); document.body.dataset.downloadAttempted = 'true'; document.querySelector('#attempt').textContent='Download attempted';
      }, 1500)">Arm private download</button><p id="attempt">Waiting for download</p>`;
    const url = 'https://httpbin.org/base64/' + Buffer.from(html).toString('base64');
    const action = (type, args, epoch) => request(base + '/commands', {
      operationId: randomUUID(), type, arguments: args, instructionRevision: 0, controlEpoch: epoch,
    });
    try {
      assert.equal((await request('/sessions', {sessionId: id, ownerId: randomUUID(), startUrl: url})).status, 'LIVE');
      await request(base + '/control', {controlEpoch: 1, owner: 'CHATGPT', privateMode: false});
      const before = await sample('helm-browser-' + id);
      assert.equal((await action('click', await target(request, base, 'Arm private download'), 1)).status, 'SUCCEEDED');
      await request(base + '/control', {controlEpoch: 2, owner: 'USER', privateMode: true, controllerId: randomUUID()});
      await delay(2500);
      const after = await sample('helm-browser-' + id);
      await request(base + '/control', {controlEpoch: 3, owner: 'CHATGPT', privateMode: false});
      assert.ok(snapshotText(await request(base + '/observe')).includes('Download attempted'));
      assert.equal((await request(base + '/artifacts')).artifacts.length, 0);
      assert.equal(after.downloads, before.downloads);
      assert.equal(after.downloadBytes, before.downloadBytes);
      console.log(JSON.stringify({privateDownload: {before, after}}));
    } finally { await closeAndCheck(id); }
  });
