import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { BrowserSession } from '../dist/src/session.js';
import { MediaSession } from '../dist/src/media-session.js';

const credentials = JSON.parse(await readFile('/fixture/credentials.json', 'utf8'));
assert.equal((await lookup('coturn')).address, credentials.turnAddress,
  'Isolated worker must resolve only the configured TURN address before libnice CONNECT');
await new Promise((resolve, reject) => {
  const socket = connect(3478, 'coturn');
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); reject(new Error('Worker bypassed the relay network boundary')); });
  socket.once('error', () => resolve());
  socket.once('timeout', () => { socket.destroy(); resolve(); });
});
async function proxyConnect(authority, password) {
  return new Promise((resolve, reject) => {
    const socket = connect(3128, 'egress-proxy');
    socket.setTimeout(3000);
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${password ? `Proxy-Authorization: Basic ${Buffer.from('helm-media:' + password).toString('base64')}\r\n` : ''}\r\n`));
    socket.once('data', data => { socket.destroy(); resolve(Number(data.toString().split(' ')[1])); });
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('Proxy admission timeout')));
  });
}
for (const password of [undefined, 'wrong']) {
  assert.ok([403, 407].includes(await proxyConnect(credentials.turnAddress + ':3478', password)));
}
assert.equal(await proxyConnect('10.0.0.1:3478', credentials.proxy), 403);
assert.equal(await proxyConnect('169.254.169.254:443', credentials.proxy), 403);
assert.equal(await proxyConnect(credentials.turnAddress + ':3478', credentials.proxy), 200);
console.log('Isolated worker DNS, direct relay denial and exact authenticated Squid route verified');
const children = [spawn('Xvfb', [':99', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' }),
  spawn('gst-webrtc-signalling-server', ['--host', '127.0.0.1', '--port', '8443'], { stdio: 'ignore' })];
await delay(500); children.push(spawn('openbox', ['--sm-disable'], { stdio: 'ignore' })); await delay(500);
let runtime; let viewerBrowser; let socket; let renew;
const viewerId = randomUUID();
const media = new MediaSession(() => runtime, (_id, value) => {
  if (value.type === 'peer') console.log('producer signal', value.ice ? 'ICE' : 'SDP');
  socket?.send(JSON.stringify(value));
}, (_binding, code) => { console.log('viewer ended', code); socket?.close(); }, () => undefined);
const username = `${Math.floor(Date.now() / 1000) + 120}:test`;
const credential = createHmac('sha1', credentials.turn).update(username).digest('base64');
const ice = { urls: ['turn:coturn:3478?transport=tcp'], username, credential };
const viewerIce = { ...ice, urls: ['turn:viewer-gateway:3478?transport=tcp'] };
const server = createServer(async (request, response) => {
  if (/^\/sdk\/[a-z-]+\.js$/.test(request.url ?? '')) { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(request.url)); return; }
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><video autoplay muted playsinline></video><script type="module">
    import GstWebRTCAPI from '/sdk/gstwebrtc-api.js';
    window.framesDecoded=0;window.lastFrameAt=0;window.failures=[];
    const video=document.querySelector('video');
    const decoded=()=>{window.framesDecoded++;window.lastFrameAt=performance.now();video.requestVideoFrameCallback(decoded)};
    video.requestVideoFrameCallback(decoded);
    const api=new GstWebRTCAPI({signalingServerUrl:'ws://127.0.0.1:8099',reconnectionTimeout:0,webrtcConfig:{iceServers:[${JSON.stringify(viewerIce)}],iceTransportPolicy:'relay'},
      transportFactory:url=>{const ws=new WebSocket(url);const bridge={send:data=>ws.send(data),close:()=>ws.close(),onmessage:null,onclose:null,onerror:null};
        ws.onmessage=event=>{const value=JSON.parse(event.data);if(value.type==='streamState'){window.captureState=value.captureState;return}bridge.onmessage?.(event)};
        ws.onclose=()=>bridge.onclose?.();ws.onerror=()=>bridge.onerror?.(new ErrorEvent('error',{message:'socket'}));return bridge;}});
    api.registerConnectionListener({connected:()=>console.log('SDK connected'),disconnected:()=>console.log('SDK disconnected'),error:error=>window.failures.push(String(error))});
    api.registerPeerListener({producerAdded:producer=>{if(window.consumer)return;const consumer=api.createConsumerSession(producer.id);if(!consumer)return;window.consumer=consumer;
      consumer.addEventListener('error',event=>{window.failures.push(event.message);console.log('consumer error',event.message)});
      consumer.addEventListener('streamsChanged',()=>{if(consumer.streams[0]){video.srcObject=consumer.streams[0];video.play()}});consumer.connect();},producerRemoved:()=>{}});
  </script>`);
});
const ws = new WebSocketServer({ server });
await new Promise(resolve => server.listen(8099, '127.0.0.1', resolve));
try {
  console.log('encoder', await media.capabilities);
  const assignment = { purpose: 'TASK', taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: randomUUID(), instructionRevision: 1,
    allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1, originPolicy: 'PUBLIC', allowedOrigins: [],
    deadline: new Date(Date.now() + 90_000).toISOString(), viewport: { width: 1280, height: 720 } };
  runtime = await BrowserSession.create(assignment, { headless: false, display: ':99', stagingDirectory: '/runtime/sessions', mediaBarrier: () => media.closeAll() });
  await runtime.context.pages()[0].setContent('<body style="margin:0;background:#c32231"><h1>Actual Chromium surface</h1></body>');
  const binding = { schemaVersion: 1, type: 'viewOpen', requestId: randomUUID(), viewerId, browserSessionId: assignment.browserSessionId,
    workerBootId: assignment.workerBootId,
    allocationEpoch: 1, controlEpoch: 1, pageEpoch: assignment.pageEpoch, privacyEpoch: 1, mediaGeneration: 1, viewGeneration: 1, surface: 'WEB',
    iceServers: [ice], producerIceServer: ice, mediaProxy: { url: 'http://egress-proxy:3128', username: 'helm-media', password: credentials.proxy },
    leaseExpiresAt: new Date(Date.now() + 4500).toISOString() };
  ws.once('connection', client => {
    socket = client;
    client.on('message', async raw => {
      try { await media.accept({ schemaVersion: 1, type: 'signal', requestId: randomUUID(), viewerId,
        workerBootId: binding.workerBootId, browserSessionId: binding.browserSessionId,
        allocationEpoch: binding.allocationEpoch, viewGeneration: binding.viewGeneration, payload: JSON.parse(raw.toString()) }); }
      catch (error) { console.error('signaling rejected', error.code ?? error.message); }
    });
    void media.accept(binding).then(() => {
      renew = setInterval(() => void media.accept({ ...binding, type: 'viewRenew', requestId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 4500).toISOString() }).catch(error => console.error('renew', error.message)), 1000);
    }).catch(error => console.error('open failed', error.message));
  });
  viewerBrowser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const viewer = await viewerBrowser.newPage();
  viewer.on('console', message => console.log('viewer', message.text()));
  viewer.on('pageerror', error => console.error('viewer error', error.message));
  await viewer.goto('http://127.0.0.1:8099/');
  try { await viewer.waitForFunction(() => window.framesDecoded >= 15, undefined, { timeout: 25_000 }); }
  catch (error) {
    console.log('Viewer ICE state', await viewer.evaluate(async () => {
      const pc = window.consumer?.rtcPeerConnection;
      const stats = pc ? [...(await pc.getStats()).values()].filter(item => ['local-candidate', 'remote-candidate', 'candidate-pair', 'inbound-rtp'].includes(item.type)) : [];
      return { state: pc?.connectionState, gathering: pc?.iceGatheringState, stats: stats.map(item => ({ type: item.type, candidateType: item.candidateType, state: item.state, bytesReceived: item.bytesReceived })) };
    })); throw error;
  }
  const proof = await viewer.evaluate(() => ({ frames: window.framesDecoded, width: document.querySelector('video').videoWidth,
    height: document.querySelector('video').videoHeight, failures: window.failures, captureState: window.captureState }));
  assert.equal(proof.width, 1280); assert.equal(proof.height, 720); assert.deepEqual(proof.failures, []); assert.equal(proof.captureState, 'ACTIVE');
  console.log('Real TURN-relayed H264 frames decoded through upstream gstwebrtc-api:', proof);
  clearInterval(renew);
  // The parent JS loop cannot perform teardown during this pause. Native leases must stop peers.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 7000);
  const age = await viewer.evaluate(() => performance.now() - window.lastFrameAt);
  assert.ok(age > 1500, 'Native producer transmitted after lease expiry: ' + age);
  console.log('Native media lease stopped decoded frames while the Node owner was stalled');
} catch (error) {
  console.error(error); process.exitCode = 1;
  let diagnostic = await readFile('/runtime/helper.log', 'utf8').catch(() => 'No native diagnostic');
  for (const value of [credentials.turn, credentials.proxy, credential]) diagnostic = diagnostic.replaceAll(value, '[redacted]').replaceAll(encodeURIComponent(value), '[redacted]');
  console.log(diagnostic.split('\n').filter(line => /ERROR|WARN|turn|proxy|resolv|candidate/i.test(line) && !/webrtcstats/.test(line)).slice(0, 40).join('\n').replace(/((?:https?|turns?):\/\/)[^\s]+@/g, '$1[redacted]@'));
}
finally {
  clearInterval(renew); await media.closeAll(); await runtime?.close(); await viewerBrowser?.close();
  ws.close(); server.close(); for (const child of children) child.kill();
  process.exit(process.exitCode ?? 0);
}
