const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../Docs/Helm-Glass-v8.html'), 'utf8').replace(/\r\n/g, '\n');

function declaration(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

// Exercise the prototype's socket and table owners with a controllable server and clock.
function fixture() {
  const sockets = [], reads = [], events = [], timers = new Map();
  let timerId = 0;
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = Socket.CONNECTING; this.sent = []; sockets.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen(); }
    send(frame) { this.sent.push(JSON.parse(frame)); }
    receive(frame) { this.onmessage({data: JSON.stringify(frame)}); }
    close(code = 1006) { this.readyState = Socket.CLOSED; this.onclose({code}); }
  }
  const root = {isConnected: true, contains: () => false};
  const spec = {resource: 'tasks', context: {}, filters: {query: 'saved-filter'}};
  const state = {phase: 'ready', data: {items: [{id: 'task', state: 'RUNNING'}]},
    sequence: 0, revision: 0, snapshot: 'old-page', lastKey: 'old-query', page: 2, size: 10,
    sort: {field: 'created', direction: 'desc'}};
  const context = vm.createContext({
    URL, EventTarget, CustomEvent, AbortController, queueMicrotask,
    WebSocket: Socket, window: {HELM_LIVE_API: {url: '/events/v1/user'}},
    location: {href: 'https://helm.example.com/', origin: 'https://helm.example.com'},
    document: {activeElement: {}, dispatchEvent: event => events.push(event)},
    TABLE_API6: {mode: 'http'}, TABLE6: {revision: 0, specs: new Map([['tasks', spec]]),
      states: new Map([['tasks', state]])},
    canAdminA: () => false, clone: structuredClone,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval: () => ++timerId, clearInterval() {},
    setLivePhase7(phase) { context.LIVE7.phase = phase; },
    gridElement6: () => root, drawGrid6() {}, syncGridUrl6() {}, scheduleGridRetry7() {},
    requestPage6(_spec, request, signal) {
      return new Promise((resolve, reject) => reads.push({request, signal, resolve, reject}));
    }
  });
  const constants = source.slice(source.indexOf('const LIVE7 ='), source.indexOf('// Table views'));
  vm.runInContext(constants + '\nglobalThis.LIVE7 = LIVE7;', context);
  for (const name of ['connectLiveSocket7', 'enqueueLive7', 'invalidateGrid7', 'loadGrid6']) {
    vm.runInContext(declaration(name), context);
  }
  return {context, state, spec, reads, events, timers,
    connect() { context.connectLiveSocket7(); const socket = sockets.at(-1); socket.open(); return socket; },
    flushSignals() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 90) continue;
        timers.delete(id); timer.callback();
      }
    },
    async complete(index, status) {
      const read = reads[index];
      read.resolve({items: [{id: 'task', state: status}], total: 11, page: read.request.page,
        pageSize: read.request.pageSize, sort: read.request.sort, snapshot: `page-${index}`});
      await new Promise(setImmediate);
    }
  };
}

test('initial connection and reconnect read current data without a delivery cursor or replay', async () => {
  const f = fixture();
  let socket = f.connect();
  assert.deepEqual(socket.sent, [{type: 'subscribe', channels: ['self']}]);
  assert.equal(f.reads.length, 0, 'subscription must be ready before the authoritative refresh');
  socket.receive({type: 'ready'}); f.flushSignals();
  assert.equal(f.reads[0].request.snapshot, null);
  assert.equal(f.reads[0].request.page, 2);
  assert.equal(f.reads[0].request.filters.query, 'saved-filter');
  assert.equal(f.reads[0].request.sort.direction, 'desc');
  await f.complete(0, 'RUNNING');
  socket.close();
  // The server completes the task while there is no connected viewer or saved notification.
  socket = f.connect(); socket.receive({type: 'ready'}); f.flushSignals();
  await f.complete(1, 'COMPLETED');
  assert.equal(f.state.data.items[0].state, 'COMPLETED');
  assert.equal(f.reads[1].request.snapshot, null);
  assert.deepEqual(socket.sent, [{type: 'subscribe', channels: ['self']}]);
  assert.deepEqual(Object.keys(f.events.at(-1).detail), ['resources']);
  assert.equal('cursor' in f.context.LIVE7, false);
  assert.equal('seen' in f.context.LIVE7, false);

  const reloaded = fixture();
  const freshSocket = reloaded.connect(); freshSocket.receive({type: 'ready'}); reloaded.flushSignals();
  await reloaded.complete(0, 'COMPLETED');
  assert.equal(reloaded.state.data.items[0].state, 'COMPLETED', 'reload needs no previous delivery state');
});

test('invalidations during a snapshot read coalesce and trigger a fresh read afterward', async () => {
  const f = fixture(), socket = f.connect();
  socket.receive({type: 'ready'}); f.flushSignals();
  for (let i = 0; i < 5; i++) socket.receive({type: 'invalidate', resources: ['tasks', 'tasks', 'unknown']});
  f.flushSignals();
  assert.equal(f.reads.length, 1, 'do not start parallel reads for the same table');
  await f.complete(0, 'RUNNING');
  assert.equal(f.reads.length, 2, 'an update during the first read must not be lost');
  assert.equal(f.reads[1].request.snapshot, null);
  await f.complete(1, 'COMPLETED');
  assert.equal(f.state.data.items[0].state, 'COMPLETED');
});

test('repeated signals need no event IDs and never patch business state from a message', async () => {
  const f = fixture(), socket = f.connect();
  socket.receive({type: 'ready'}); f.flushSignals(); await f.complete(0, 'RUNNING');
  const signal = {type: 'invalidate', resources: ['tasks'], id: 'optional-old-id', cursor: 'ignored',
    payload: {state: 'FAILED'}};
  socket.receive(signal); f.flushSignals(); await f.complete(1, 'COMPLETED');
  socket.receive(signal); f.flushSignals();
  assert.equal(f.reads.length, 3, 'reusing an ID cannot suppress a new refresh');
  assert.equal(f.state.data.items[0].state, 'COMPLETED', 'message payload cannot overwrite the snapshot');
  await f.complete(2, 'COMPLETED');
  assert.equal('cursor' in f.context.LIVE7, false);
});

test('callbacks from a closed socket cannot affect its replacement or request a new login', async () => {
  const f = fixture(), oldSocket = f.connect();
  oldSocket.receive({type: 'ready'}); f.flushSignals(); await f.complete(0, 'RUNNING');
  oldSocket.close();
  const current = f.connect(); current.receive({type: 'ready'}); f.flushSignals();
  await f.complete(1, 'COMPLETED');
  oldSocket.receive({type: 'auth.required'});
  oldSocket.receive({type: 'ready'});
  oldSocket.receive({type: 'invalidate', resources: ['tasks']}); f.flushSignals();
  assert.equal(f.context.LIVE7.phase, 'connected');
  assert.equal(f.reads.length, 2);
  assert.equal(f.context.LIVE7.socket, current);
});

test('a late HTTP response cannot replace a newer snapshot', async () => {
  const f = fixture(), socket = f.connect();
  socket.receive({type: 'ready'}); f.flushSignals();
  const freshRead = f.context.loadGrid6('tasks', true);
  assert.equal(f.reads[0].signal.aborted, true);
  await f.complete(1, 'COMPLETED'); await freshRead;
  await f.complete(0, 'RUNNING');
  assert.equal(f.state.data.items[0].state, 'COMPLETED');
});

test('revoked access stops reconnect and prevents queued invalidations from starting reads', async () => {
  const f = fixture(), socket = f.connect();
  socket.receive({type: 'ready'}); f.flushSignals(); await f.complete(0, 'RUNNING');
  socket.receive({type: 'invalidate', resources: ['tasks']});
  socket.receive({type: 'auth.required'}); f.flushSignals();
  assert.equal(f.context.LIVE7.phase, 'auth');
  assert.equal(f.reads.length, 1);
  assert.equal(f.timers.size, 0, 'no reconnect or polling after revocation');
});
