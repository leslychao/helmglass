import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
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
let runtime; let viewerBrowser;
let mediaBarrier = Promise.resolve();
let mediaGeneration = 1;
const viewers = new Map(['WEB', 'WIDGET'].map(surface => [surface,
  { surface, id: randomUUID(), generation: 0, ended: [], failures: [] }]));
const recoveryProof = [];
const controllerInstance = randomUUID();
const measurementRun = 0x48470001;
const fixtureFiles = new Map(await Promise.all(['marker.mjs', 'collector.mjs', 'source.mjs', 'source.html'].map(async name =>
  ['/performance/' + name, await readFile(new URL('./media-performance/' + name, import.meta.url))])));
function viewerFor(binding) {
  return [...viewers.values()].find(viewer => viewer.id === binding.viewerId
    && viewer.binding?.viewGeneration === binding.viewGeneration);
}
const media = new MediaSession(() => runtime, (binding, value) => {
  const socket = viewerFor(binding)?.socket;
  if (socket?.readyState === 1) socket.send(JSON.stringify(value));
}, (binding, code) => {
  const viewer = viewerFor(binding);
  if (!viewer) return;
  viewer.ended.push({ generation: binding.viewGeneration, code });
  clearInterval(viewer.renew);
  viewer.socket?.close();
}, () => undefined);
const turnUserId = randomUUID();
for (const viewer of viewers.values()) {
  // Match IceServerService: distinct viewer identity, shared producer uses its first lease.
  const username = `${Math.floor(Date.now() / 1000) + 180}:${turnUserId}:${viewer.id}`;
  viewer.ice = { urls: ['turn:coturn:3478?transport=tcp'], username,
    credential: createHmac('sha1', credentials.turn).update(username).digest('base64') };
}
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (fixtureFiles.has(path)) {
    response.setHeader('content-type', path.endsWith('.html') ? 'text/html' : 'text/javascript');
    response.end(fixtureFiles.get(path)); return;
  }
  if (/^\/sdk\/[a-z-]+\.js$/.test(request.url ?? '')) { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(request.url)); return; }
  const viewer = viewers.get(new URL(request.url, 'http://127.0.0.1').searchParams.get('surface'));
  if (!viewer) { response.writeHead(404).end(); return; }
  const viewerIce = { ...viewer.ice, urls: ['turn:viewer-gateway:3478?transport=tcp'] };
  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><video autoplay muted playsinline></video><button id="probe">Send visual probe</button><pre id="measurement"></pre><script type="module">
    import GstWebRTCAPI from '/sdk/gstwebrtc-api.js';
    import { observeVideo } from '/performance/collector.mjs';
    window.framesDecoded=0;window.lastFrameAt=0;window.firstFrameMs=null;window.failures=[];
    window.signaling=[];window.iceErrors=[];const observedPeers=new WeakSet();
    const trace=(direction,value)=>{if(window.signaling.length>=40||value.type==='streamState')return;
      window.signaling.push({direction,type:value.type,sdpType:value.sdp?.type,
        media:value.sdp?.sdp?.split(String.fromCharCode(13,10)).filter(line=>/^m=|^a=(sendrecv|sendonly|recvonly|inactive|rtpmap|fmtp)/.test(line)),ice:!!value.ice});};
    const openedAt=performance.now();
    let measurement;let signal;let nonce=0;
    const video=document.querySelector('video');
    document.getElementById('probe').addEventListener('click',event=>{
      if(!measurement || signal?.readyState!==WebSocket.OPEN)return;
      measurement.collector.beginInput(++nonce,event.timeStamp);
      signal.send(JSON.stringify({type:'fixtureInput',nonce}));
    });
    window.measurementSnapshot=()=>measurement?.collector.snapshot(performance.now());
    window.stopMeasurement=()=>{const result=measurement?.stop('FIXTURE_COMPLETE');
      document.getElementById('measurement').textContent=JSON.stringify(result,null,2);return result;};
    const decoded=()=>{window.framesDecoded++;window.lastFrameAt=performance.now();window.firstFrameMs??=window.lastFrameAt-openedAt;video.requestVideoFrameCallback(decoded)};
    video.requestVideoFrameCallback(decoded);
    const surface=new URL(location.href).searchParams.get('surface');
    const api=new GstWebRTCAPI({signalingServerUrl:'ws://127.0.0.1:8099/?surface='+surface,reconnectionTimeout:0,webrtcConfig:{iceServers:[${JSON.stringify(viewerIce)}],iceTransportPolicy:'relay'},
      transportFactory:url=>{const ws=new WebSocket(url);signal=ws;const bridge={send:data=>{trace('out',JSON.parse(data));ws.send(data)},close:()=>ws.close(),onmessage:null,onclose:null,onerror:null};
        ws.onmessage=event=>{const value=JSON.parse(event.data);trace('in',value);if(value.type==='streamState'){window.captureState=value.captureState;return}bridge.onmessage?.(event);
          const peer=window.consumer?.rtcPeerConnection;if(peer&&!observedPeers.has(peer)){observedPeers.add(peer);peer.addEventListener('icecandidateerror',error=>window.iceErrors.push(error.errorCode));}};
        ws.onclose=()=>bridge.onclose?.();ws.onerror=()=>bridge.onerror?.(new ErrorEvent('error',{message:'socket'}));return bridge;}});
    api.registerConnectionListener({connected:()=>console.log('SDK connected'),disconnected:()=>console.log('SDK disconnected'),error:error=>window.failures.push(String(error))});
    api.registerPeerListener({producerAdded:producer=>{if(window.consumer)return;const consumer=api.createConsumerSession(producer.id);if(!consumer)return;window.consumer=consumer;
      consumer.addEventListener('error',event=>{window.failures.push(event.message);console.log('consumer error',event.message)});
      consumer.addEventListener('streamsChanged',()=>{if(consumer.streams[0]){video.srcObject=consumer.streams[0];video.play().then(()=>{
        measurement?.stop('PEER_REPLACED');measurement=observeVideo(video,{run:${measurementRun},startedAt:performance.now(),durationMs:20000});
      })}});consumer.connect();},producerRemoved:()=>{}});
  </script>`);
});
const ws = new WebSocketServer({ server });
await new Promise(resolve => server.listen(8099, '127.0.0.1', resolve));
ws.on('connection', (client, request) => {
  const viewer = viewers.get(new URL(request.url, 'http://127.0.0.1').searchParams.get('surface'));
  if (!viewer || !runtime || viewer.socket?.readyState === 1) { client.close(); return; }
  const assignment = runtime.assignment;
  const ice = viewer.ice;
  const binding = { schemaVersion: 1, type: 'viewOpen', requestId: randomUUID(), viewerId: viewer.id,
    browserSessionId: assignment.browserSessionId, workerBootId: assignment.workerBootId,
    allocationEpoch: assignment.allocationEpoch, controlEpoch: assignment.controlEpoch,
    pageEpoch: assignment.pageEpoch, privacyEpoch: assignment.privacyEpoch, mediaGeneration,
    viewGeneration: ++viewer.generation, surface: viewer.surface,
    iceServers: [ice], producerIceServer: ice,
    mediaProxy: { url: 'http://egress-proxy:3128', username: 'helm-media', password: credentials.proxy },
    leaseExpiresAt: new Date(Date.now() + 4500).toISOString() };
  viewer.binding = binding;
  viewer.socket = client;
  let inputSequence = 0;
  client.on('message', async raw => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload.type === 'fixtureInput') {
        assert.equal(viewer.surface, 'WEB');
        assert.ok(Number.isInteger(payload.nonce) && payload.nonce >= 1 && payload.nonce <= 6);
        await runtime.input({ schemaVersion: 1, type: 'input', requestId: randomUUID(),
          browserSessionId: assignment.browserSessionId, allocationEpoch: assignment.allocationEpoch,
          controlEpoch: binding.controlEpoch, pageEpoch: binding.pageEpoch,
          controllerInstance, inputSequence: ++inputSequence,
          action: { type: 'committedText', text: String(payload.nonce) } });
        return;
      }
      await media.accept({ schemaVersion: 1, type: 'signal', requestId: randomUUID(), viewerId: viewer.id,
        workerBootId: binding.workerBootId, browserSessionId: binding.browserSessionId,
        allocationEpoch: binding.allocationEpoch, viewGeneration: binding.viewGeneration, payload });
    } catch (error) {
      viewer.failures.push(error.code ?? error.message);
    }
  });
  client.once('close', () => {
    if (viewer.socket === client) clearInterval(viewer.renew);
  });
  void media.accept(binding).then(() => {
    viewer.renew = setInterval(() => void media.accept({ ...binding, type: 'viewRenew',
      requestId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 4500).toISOString() })
      .catch(error => viewer.failures.push(error.code ?? error.message)), 1000);
  }).catch(error => { viewer.failures.push(error.code ?? error.message); client.close(); });
});

async function decodedProof(viewer, stage) {
  try {
    await viewer.page.waitForFunction(() => window.framesDecoded >= 15, undefined, { timeout: 15000 });
  } catch (error) {
    console.log('Viewer failure state', viewer.surface, stage, JSON.stringify(await viewer.page.evaluate(async () => {
      const pc = window.consumer?.rtcPeerConnection;
      const stats = pc ? [...(await pc.getStats()).values()]
        .filter(item => ['local-candidate', 'remote-candidate', 'candidate-pair', 'inbound-rtp'].includes(item.type)) : [];
      return { state: pc?.connectionState, gathering: pc?.iceGatheringState,
        signaling: window.signaling, localType: pc?.localDescription?.type, remoteType: pc?.remoteDescription?.type,
        frames: window.framesDecoded, captureState: window.captureState, failures: window.failures, iceErrors: window.iceErrors,
        stats: stats.map(item => ({ type: item.type, candidateType: item.candidateType,
          state: item.state, bytesReceived: item.bytesReceived, framesDecoded: item.framesDecoded })) };
    })), viewer.failures);
    throw error;
  }
  const proof = await viewer.page.evaluate(() => ({ frames: window.framesDecoded,
    firstFrameMs: window.firstFrameMs, width: document.querySelector('video').videoWidth,
    height: document.querySelector('video').videoHeight, failures: window.failures,
    captureState: window.captureState }));
  assert.equal(proof.width, 1280); assert.equal(proof.height, 720);
  assert.deepEqual(proof.failures, []); assert.deepEqual(viewer.failures, []);
  assert.equal(proof.captureState, 'ACTIVE');
  assert.ok(proof.firstFrameMs < 15000, 'First frame exceeded the existing UI recovery window');
  recoveryProof.push({ stage, surface: viewer.surface, generation: viewer.generation, ...proof });
  console.log('Decoded viewer', stage, viewer.surface, proof);
}

async function connectViewer(viewer, stage) {
  viewer.page ??= await viewerBrowser.newPage();
  await viewer.page.goto('http://127.0.0.1:8099/?surface=' + viewer.surface);
  await decodedProof(viewer, stage);
}

async function recoverViewers(stage) {
  for (const viewer of viewers.values()) {
    await viewer.page.waitForFunction(() => !window.consumer?.rtcPeerConnection, undefined, { timeout: 3000 });
  }
  // Each document gets a fresh SDK peer; server bindings retain the same viewer IDs.
  await Promise.all([...viewers.values()].map(viewer => connectViewer(viewer, stage)));
  for (const viewer of viewers.values()) {
    const before = await viewer.page.evaluate(() => window.framesDecoded);
    await viewer.page.waitForFunction(count => window.framesDecoded >= count + 15, before, { timeout: 3000 });
  }
}

try {
  console.log('encoder', await media.capabilities);
  const assignment = { purpose: 'TASK', taskId: randomUUID(), userId: randomUUID(), browserSessionId: randomUUID(), workerBootId: randomUUID(), instructionRevision: 1,
    allocationEpoch: 1, controlEpoch: 1, pageEpoch: 1, privacyEpoch: 1, policyVersion: 1, originPolicy: 'PUBLIC', allowedOrigins: [],
    deadline: new Date(Date.now() + 150_000).toISOString(), viewport: { width: 1280, height: 720 } };
  runtime = await BrowserSession.create(assignment, { headless: false, display: ':99', stagingDirectory: '/runtime/sessions',
    mediaBarrier: () => { mediaBarrier = media.closeAll(); return mediaBarrier; } });
  await runtime.context.pages()[0].goto(`http://127.0.0.1:8099/performance/source.html?run=${measurementRun}&inputDelayMs=150`);
  await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(), browserSessionId: assignment.browserSessionId,
    allocationEpoch: 1, controlEpoch: 2, privacyEpoch: 1, pageEpoch: assignment.pageEpoch, policyVersion: 1,
    mode: 'HUMAN', controllerInstance, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  viewerBrowser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const web = viewers.get('WEB');
  await connectViewer(web, 'initial');
  const viewer = web.page;
  await viewer.waitForFunction(() => window.measurementSnapshot()?.unique >= 8, undefined, { timeout: 5000 });
  for (let expected = 1; expected <= 6; expected++) {
    await viewer.getByRole('button', { name: 'Send visual probe' }).click();
    await viewer.waitForFunction(count => window.measurementSnapshot()?.matched === count, expected, { timeout: 4000 });
  }
  const measurement = await viewer.evaluate(() => window.stopMeasurement());
  assert.equal(measurement.matched, 6);
  assert.equal(measurement.timedOut, 0);
  assert.equal(measurement.abandoned, 0);
  assert.equal(measurement.foreign, 0);
  assert.ok(measurement.unique > 8);
  assert.ok(measurement.latencyMs.min >= 150, 'Every visible response must include the deliberate Page delay');
  console.log('MEDIA_PERFORMANCE_FIXTURE=' + JSON.stringify({ scope: 'local-worker-fixture',
    deliberatePageDelayMs: 150, performanceAcceptance: false, ...measurement }));

  const widget = viewers.get('WIDGET');
  const webFrames = await viewer.evaluate(() => window.framesDecoded);
  await connectViewer(widget, 'second-viewer');
  await viewer.waitForFunction(count => window.framesDecoded >= count + 15, webFrames, { timeout: 3000 });
  await decodedProof(web, 'second-viewer');

  const survivingFrames = await widget.page.evaluate(() => window.framesDecoded);
  await media.accept({ schemaVersion: 1, type: 'viewClose', requestId: randomUUID(),
    viewerId: web.id, workerBootId: web.binding.workerBootId,
    browserSessionId: web.binding.browserSessionId, allocationEpoch: web.binding.allocationEpoch,
    viewGeneration: web.binding.viewGeneration });
  web.socket.close();
  clearInterval(web.renew);
  await viewer.waitForFunction(() => !window.consumer?.rtcPeerConnection, undefined, { timeout: 3000 });
  await widget.page.waitForFunction(count => window.framesDecoded >= count + 15, survivingFrames, { timeout: 3000 });
  const replacementUsername = `${Math.floor(Date.now() / 1000) + 240}:${turnUserId}:${web.id}`;
  assert.notEqual(replacementUsername, web.ice.username);
  web.ice = { ...web.ice, username: replacementUsername,
    credential: createHmac('sha1', credentials.turn).update(replacementUsername).digest('base64') };
  await connectViewer(web, 'individual-reattach');
  await decodedProof(widget, 'surviving-viewer');

  const originalRuntime = runtime.runtimeGeneration;
  const pageEpoch = assignment.pageEpoch;
  const reload = { commandId: randomUUID(), attemptId: randomUUID(), taskId: assignment.taskId,
    browserSessionId: assignment.browserSessionId, executionMode: 'HUMAN', controllerInstance,
    action: { type: 'RELOAD' } };
  const navigation = await runtime.execute(reload, async actionDigest => ({
    permitId: randomUUID(), commandId: reload.commandId, attemptId: reload.attemptId,
    taskId: assignment.taskId, userId: assignment.userId, browserSessionId: assignment.browserSessionId,
    workerBootId: assignment.workerBootId, instructionRevision: assignment.instructionRevision,
    allocationEpoch: assignment.allocationEpoch, controlEpoch: assignment.controlEpoch,
    pageEpoch: assignment.pageEpoch, privacyEpoch: assignment.privacyEpoch,
    policyVersion: assignment.policyVersion, executionMode: 'HUMAN', controllerInstance,
    actionDigest, deadline: new Date(Date.now() + 10000).toISOString() }));
  assert.equal(navigation.status, 'SUCCEEDED', navigation.code);
  await mediaBarrier;
  assert.equal(assignment.pageEpoch, pageEpoch + 1);
  for (const item of viewers.values()) assert.equal(item.ended.at(-1)?.code, 'VIEW_REVOKED');
  mediaGeneration++;
  await recoverViewers('page-barrier');

  const controlEpoch = assignment.controlEpoch;
  await runtime.control({ schemaVersion: 1, type: 'control', requestId: randomUUID(),
    browserSessionId: assignment.browserSessionId, allocationEpoch: assignment.allocationEpoch,
    controlEpoch: controlEpoch + 1, privacyEpoch: assignment.privacyEpoch,
    pageEpoch: assignment.pageEpoch, policyVersion: assignment.policyVersion, mode: 'AGENT' });
  assert.equal(assignment.controlEpoch, controlEpoch + 1);
  for (const item of viewers.values()) assert.equal(item.ended.at(-1)?.code, 'VIEW_REVOKED');
  mediaGeneration++;
  await recoverViewers('control-barrier');
  assert.equal(runtime.runtimeGeneration, originalRuntime);
  assert.equal(runtime.context.pages().length, 1);
  console.log('DUAL_VIEWER_FIXTURE=' + JSON.stringify({ scope: 'local-worker-fixture',
    sameRuntime: true, samePage: true, pageBarrier: true, controlBarrier: true,
    individualReattachWithNewCredentials: true, secondViewerPreserved: true,
    frontendRecoveryAcceptance: false, proofs: recoveryProof }));

  for (const item of viewers.values()) clearInterval(item.renew);
  // The parent JS loop cannot perform teardown during this pause. Native leases must stop peers.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 7000);
  for (const item of viewers.values()) {
    const age = await item.page.evaluate(() => performance.now() - window.lastFrameAt);
    assert.ok(age > 1500, 'Native producer transmitted after lease expiry for ' + item.surface + ': ' + age);
  }
  console.log('Native media lease stopped both decoded streams while the Node owner was stalled');
} catch (error) {
  console.error(error); process.exitCode = 1;
  let diagnostic = 'No native diagnostic';
  const log = await open('/runtime/helper.log', 'r').catch(() => undefined);
  if (log) {
    try {
      const size = (await log.stat()).size;
      const tail = Buffer.alloc(Math.min(size, 65536));
      const { bytesRead } = await log.read(tail, 0, tail.length, size - tail.length);
      diagnostic = tail.subarray(0, bytesRead).toString('utf8');
    } finally { await log.close(); }
  }
  for (const value of [credentials.turn, credentials.proxy, ...[...viewers.values()].map(viewer => viewer.ice.credential)]) diagnostic = diagnostic.replaceAll(value, '[redacted]').replaceAll(encodeURIComponent(value), '[redacted]');
  console.log(diagnostic.split('\n').filter(line => /ERROR|WARN|turn|proxy|resolv|candidate/i.test(line) && !/webrtcstats/.test(line)).slice(0, 40).join('\n').replace(/((?:https?|turns?):\/\/)[^\s]+@/g, '$1[redacted]@'));
}
finally {
  for (const item of viewers.values()) clearInterval(item.renew);
  await media.closeAll(); await runtime?.close(); await viewerBrowser?.close();
  ws.close(); server.close(); for (const child of children) child.kill();
  process.exit(process.exitCode ?? 0);
}
