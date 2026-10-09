import assert from 'node:assert/strict';

// Execute the actual widget bundle against controlled host callbacks on dev.
class Element {
  contentWindow = { postMessage(message) { viewerMessages.push(message); } };
  listeners = new Map(); children = []; disabled = true; hidden = false;
  classList = { add() {}, toggle() {} }; style = {};
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeAttribute(name) { delete this[name]; }
  setAttribute(name, value) { this[name] = value; }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = undefined; }
  insertBefore(item, reference) { item.remove(); item.parent = this; const index = reference ? this.children.indexOf(reference) : this.children.length; this.children.splice(index, 0, item); }
  replaceChildren(...items) { this.children = items; }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
for (const name of ['HTMLElement', 'HTMLHeadingElement', 'HTMLSpanElement', 'HTMLParagraphElement',
  'HTMLIFrameElement', 'HTMLButtonElement', 'HTMLImageElement', 'HTMLOListElement']) globalThis[name] = Element;
let elements, sources, app, call, send, capabilities, moduleId = 0;
const messages = [], links = [], viewerMessages = [], timers = new Map(), windowListeners = new Map(), documentListeners = new Map();
let timerId = 0;
globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.document = {
  visibilityState: 'visible',
  getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
  createElement() { return new Element(); },
  addEventListener(type, callback) { documentListeners.set(type, callback); },
  removeEventListener(type, callback) { if (documentListeners.get(type) === callback) documentListeners.delete(type); },
};
globalThis.window = {
  addEventListener(type, callback) { windowListeners.set(type, callback); },
  removeEventListener(type, callback) { if (windowListeners.get(type) === callback) windowListeners.delete(type); },
};
globalThis.location = { origin: 'https://widget.example' };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
globalThis.EventSource = class {
  listeners = new Map(); closed = false;
  constructor(url) {
    this.url = String(url); sources.push(this);
    queueMicrotask(() => { if (!this.closed) this.onopen?.(); });
  }
  close() { this.closed = true; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  change(resource) { this.listeners.get('change')?.(new MessageEvent('change', {
    data: JSON.stringify({ resource }), lastEventId: '2' })); }
};
globalThis.WidgetTestApp = class {
  constructor() { app = this; }
  connect() { return Promise.resolve(); }
  getHostCapabilities() { return capabilities; }
  callServerTool(request) { return call(request); }
  sendMessage(message) { messages.push(message); return send(message); }
  openLink(link) { links.push(link); return Promise.resolve({}); }
};
const settled = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = value => ({ content: [], structuredContent: value });
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const presentation = (status = 'IDLE', browser = null) => ({ generation: crypto.randomUUID(),
  continuationStatus: status, continuationId: status === 'IDLE' ? null : crypto.randomUUID(),
  continuationRevision: status === 'IDLE' ? null : 1, continuationReason: null,
  task: { id: crypto.randomUUID(), title: 'Acceptance fixture', goal: 'Observe public page',
    status: 'WAITING_CHATGPT', waitReason: null, summary: null, version: 1, instructionRevision: 1,
    browser, request: null, result: null } });
const metadata = value => ({ publicUrl: 'https://helm.example',
  taskUrl: 'https://helm.example/tasks/' + value.task.id + '?tab=overview',
  loginUrl: 'https://helm.example/tasks/' + value.task.id + '?tab=overview&login=1',
  eventsUrl: 'https://helm.example/widget/events?ticket=' + value.generation });
const show = value => app.ontoolresult({ structuredContent: value, _meta: metadata(value) });
const stale = response({ code: 'STALE_WIDGET', message: 'Newer presentation exists' });
const ticket = text({ url: 'https://helm.example/browser/view?ticket=fixture', expiresAt: '2099-01-01T00:00:00Z' });
const liveBrowser = () => ({ id: crypto.randomUUID(), status: 'LIVE', privateMode: false, version: 1,
  currentUrl: 'https://secret-user:secret-password@site.example/work?token=secret#private' });
const businessStepId = crypto.randomUUID();
let businessStepVersion = 1;
const history = () => text({ items: [{ id: businessStepId, sequence: 20, version: businessStepVersion,
  status: businessStepVersion === 1 ? 'RUNNING' : 'SUCCEEDED', title: 'Проверить цену товара',
  result: businessStepVersion === 1 ? null : 'Цена товара подтверждена: 100 рублей',
  createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }], total: 20, page: 1, pageSize: 10 });
function viewerState(state, viewerEpoch = new URL(elements.get('viewer').src).searchParams.get('viewerEpoch'), dimensions = {}) {
  windowListeners.get('message')?.({ source: elements.get('viewer').contentWindow, origin: 'https://helm.example',
    data: { type: 'helm-viewer', state, viewerEpoch, ...dimensions } });
}
async function nextTimer() {
  const entry = timers.entries().next().value;
  assert.ok(entry, 'An automatic recovery attempt must be scheduled');
  timers.delete(entry[0]); entry[1].callback(); await settled();
}
async function mount() {
  if (app) await app.onteardown();
  elements = new Map(); sources = []; timers.clear(); messages.length = 0; links.length = 0; viewerMessages.length = 0;
  document.visibilityState = 'visible';
  navigator.onLine = true;
  capabilities = { message: { text: {} } };
  send = () => Promise.resolve({});
  await import('WIDGET_UNDER_TEST#' + ++moduleId);
}

await mount();
const preflight = deferred(), mounted = presentation('PENDING', liveBrowser()), preflightCalls = [];
call = request => { preflightCalls.push(request.name); return preflight.promise; };
show(mounted);
assert.equal(elements.get('title').textContent, mounted.task.title);
elements.get('cabinet').click();
assert.deepEqual(preflightCalls, ['widget.state']);
assert.equal(sources.length, 0); assert.equal(messages.length, 0); assert.equal(links.length, 0);
preflight.resolve(stale); await settled();
assert.equal(elements.get('content').inert, true);
assert.equal(elements.get('viewer').src, undefined);
assert.equal(elements.get('cabinet').disabled, true);
show(presentation('PENDING', liveBrowser())); await settled();
assert.deepEqual(preflightCalls, ['widget.state'], 'Late output cannot reactivate a retired frame');

await mount();
let state = presentation('IDLE', liveBrowser());
const calls = [];
let pendingTicket;
call = request => {
  calls.push(request);
  if (request.name === 'widget.state') return Promise.resolve(response(state));
  if (request.name === 'widget.browser') return pendingTicket?.promise ?? Promise.resolve(ticket);
  if (request.name === 'widget.steps') return Promise.resolve(history());
  throw new Error(request.name);
};
show(state); await settled();
assert.ok(elements.get('viewer').src, 'Validated live browsers open automatically');
assert.equal(elements.get('viewer').hidden, true, 'A ticket does not prove a live frame');
viewerState('connected');
assert.equal(elements.get('viewer').hidden, false);
assert.equal(elements.get('address').textContent, 'https://site.example/work', 'Address must omit credentials, query and fragment');
assert.equal(elements.get('steps').children.length, 1, 'Latest steps are visible without disclosure');
assert.equal(elements.get('event-count').textContent, 'Всего шагов: 20');
assert.ok(calls.filter(item => item.name === 'widget.steps').every(item => item.arguments.page === 1));
assert.equal(elements.get('cabinet').textContent, 'Открыть в Helm Glass');
const viewerSource = elements.get('viewer').src;
const callsBeforeCollapse = calls.length;
elements.get('steps-toggle').disabled = false;
elements.get('steps-toggle').click();
assert.equal(elements.get('steps-panel').hidden, true);
assert.equal(elements.get('steps-toggle')['aria-expanded'], 'false');
elements.get('steps-toggle').click();
assert.equal(elements.get('steps-panel').hidden, false);
assert.equal(elements.get('steps-toggle')['aria-expanded'], 'true');
assert.equal(elements.get('viewer').src, viewerSource, 'Folding steps preserves the current viewer');
assert.equal(calls.length, callsBeforeCollapse, 'Folding steps is a local presentation action');
viewerState('resized', 'stale-epoch', { width: 800, height: 600 });
assert.equal(elements.get('viewport').style.aspectRatio, undefined);
viewerState('resized', undefined, { width: 1440, height: 900 });
assert.equal(elements.get('viewport').style.aspectRatio, '1440 / 900');
viewerState('resized', undefined, { width: -1, height: 900 });
assert.equal(elements.get('viewport').style.aspectRatio, '1440 / 900', 'Invalid frame dimensions cannot change layout');
elements.get('cabinet').click();
assert.equal(links.at(-1).url, metadata(state).taskUrl);

const historyCalls = calls.filter(item => item.name === 'widget.steps').length;
const businessRow = elements.get('steps').children[0];
businessStepVersion++;
sources.at(-1).change('step'); await settled();
assert.equal(elements.get('steps').children[0], businessRow, 'An update must preserve the business step row');
assert.equal(elements.get('steps').children.length, 1, 'Status updates do not append progress entries');
assert.equal(elements.get('event-count').textContent, 'Всего шагов: 20');
assert.match(businessRow.children[0].textContent, /Выполнен/);

assert.equal(calls.filter(item => item.name === 'widget.steps').length, historyCalls + 1);
viewerState('disconnected');
assert.equal(elements.get('viewer').hidden, true, 'Disconnected frames are immediately hidden');
await nextTimer();
assert.equal(viewerMessages.at(-1).type, 'helm-viewer-reconnect');
viewerState('connected');
assert.equal(elements.get('viewer').hidden, false);

const offlineEpoch = new URL(elements.get('viewer').src).searchParams.get('viewerEpoch');
const offlineSource = sources.at(-1);
navigator.onLine = false;
windowListeners.get('offline')();
assert.equal(elements.get('viewer').hidden, true, 'Offline immediately hides the last live frame');
assert.equal(elements.get('viewer').src, undefined, 'Offline releases the viewer transport');
assert.equal(offlineSource.closed, true);
assert.equal(timers.size, 0, 'Offline cancels recovery timers');
assert.match(elements.get('state').textContent, /Нет сети/);
const offlineCalls = calls.length;
viewerState('connected', offlineEpoch);
offlineSource.onopen(); offlineSource.change('browser');
await settled();
assert.equal(elements.get('viewer').hidden, true, 'Late connected messages cannot restore an offline frame');
assert.equal(calls.length, offlineCalls, 'Offline callbacks cannot start new requests');
navigator.onLine = true;
windowListeners.get('online')(); await settled();
viewerState('connected');
assert.equal(elements.get('viewer').hidden, false, 'Online restores the same task without manual refresh');
assert.equal(calls.at(-1).arguments.taskId, state.task.id);

pendingTicket = deferred();
viewerState('disconnected'); await nextTimer();
navigator.onLine = false; windowListeners.get('offline')();
pendingTicket.resolve(ticket); await settled();
assert.equal(elements.get('viewer').src, undefined, 'A late ticket cannot restore offline viewing');
assert.equal(timers.size, 0);
pendingTicket = undefined;
navigator.onLine = true; windowListeners.get('online')(); await settled();
viewerState('connected');
assert.equal(elements.get('viewer').hidden, false);

state = { ...state, task: { ...state.task, version: 2, waitReason: 'LOGIN',
  request: { type: 'LOGIN', prompt: 'Войдите на сайт' },
  browser: { ...state.task.browser, version: 3, privateMode: true } } };
sources.at(-1).change('browser'); await settled();
assert.equal(elements.get('viewer').src, undefined);
assert.equal(elements.get('viewer').hidden, true);
assert.equal(elements.get('address').textContent, 'Защищённый вход');
assert.equal(elements.get('cabinet').textContent, 'Войти на сайт');
elements.get('cabinet').click();
assert.equal(links.at(-1).url, metadata(state).loginUrl);

state = { ...state, task: { ...state.task, browser: { ...state.task.browser, version: 2, privateMode: false } } };
sources.at(-1).change('browser'); await settled();
assert.equal(elements.get('viewer').src, undefined, 'Late browser version cannot reopen private viewing');
state = { ...state, task: { ...state.task, version: 3, waitReason: null, request: null,
  browser: { ...state.task.browser, version: 4, privateMode: false } } };
sources.at(-1).change('browser'); await settled();
viewerState('connected');
assert.equal(elements.get('cabinet').textContent, 'Открыть в Helm Glass');

const oldEpoch = new URL(elements.get('viewer').src).searchParams.get('viewerEpoch');
pendingTicket = deferred();
state = { ...state, task: { ...state.task, version: 4, browser: liveBrowser() } };
sources.at(-1).change('browser'); await settled();
state = { ...state, task: { ...state.task, version: 5, browser: { ...state.task.browser, version: 2, privateMode: true } } };
sources.at(-1).change('browser'); await settled();
pendingTicket.resolve(ticket); await settled();
assert.equal(elements.get('viewer').src, undefined, 'Late viewer ticket cannot undo private mode');
viewerState('connected', oldEpoch);
assert.equal(elements.get('viewer').hidden, true);

const lastSource = sources.at(-1);
call = request => Promise.resolve(request.name === 'widget.state' ? stale : history());
lastSource.onerror();
await nextTimer();
assert.ok(lastSource.closed); assert.equal(timers.size, 0);
assert.equal(elements.get('cabinet').disabled, true);
assert.match(elements.get('state').textContent, /Неактивная карточка/);

await mount();
let retryState = presentation();
call = request => Promise.resolve(request.name === 'widget.state' ? response(retryState) : history());
show(retryState); await settled();
for (let i = 0; i < 9; i++) {
  // An error before onopen must remain bounded, unlike a successfully recovered stream.
  const source = sources.at(-1);
  source.onerror();
  if (i < 8) {
    const entry = timers.entries().next().value;
    assert.ok(entry);
    timers.delete(entry[0]);
    const oldConstructor = globalThis.EventSource;
    globalThis.EventSource = class extends oldConstructor {
      constructor(url) { super(url); this.close(); }
    };
    entry[1].callback(); await settled();
    globalThis.EventSource = oldConstructor;
  }
}
assert.equal(timers.size, 0, 'Connection retries are bounded');
windowListeners.get('online')();
await settled();
assert.equal(sources.at(-1).closed, false, 'Network recovery restarts subscription without a button');

await mount();
const delayedClaim = deferred();
let first = presentation('PENDING'), claims = 0, reports = [];
call = request => {
  if (request.name === 'widget.state') return Promise.resolve(response(first));
  if (request.name === 'widget.steps') return Promise.resolve(history());
  if (request.name === 'widget.claim') { claims++; return delayedClaim.promise; }
  reports.push(request); return Promise.resolve(response(first));
};
show(first); await settled(); assert.equal(claims, 1);
first = presentation('IDLE'); show(first); await settled();
delayedClaim.resolve(text({ claimed: true })); await settled();
assert.equal(messages.length, 0, 'A late claim cannot continue another task');
assert.equal(reports.length, 0);

await mount();
const oldAck = deferred();
let intent = presentation('PENDING'), originalIntent = intent.continuationId;
reports = [];
call = request => {
  if (request.name === 'widget.state') return Promise.resolve(response(intent));
  if (request.name === 'widget.steps') return Promise.resolve(history());
  if (request.name === 'widget.claim') return Promise.resolve(text({ claimed: true }));
  reports.push(request.arguments);
  intent = { ...intent, continuationStatus: 'MESSAGE_SENT' };
  return Promise.resolve(response(intent));
};
send = () => messages.length === 1 ? oldAck.promise : Promise.resolve({});
show(intent); await settled(); assert.equal(messages.length, 1);
intent = { ...intent, continuationStatus: 'IDLE', continuationId: null,
  task: { ...intent.task, status: 'PAUSED', version: 2 } };
show(intent); await settled();
intent = { ...intent, continuationStatus: 'PENDING', continuationId: crypto.randomUUID(),
  task: { ...intent.task, status: 'WAITING_CHATGPT', version: 3 } };
show(intent); await settled(); oldAck.resolve({}); await settled();
assert.equal(messages.length, 2); assert.equal(reports.length, 1);
assert.notEqual(reports[0].continuationId, originalIntent);
assert.equal(reports[0].continuationId, intent.continuationId);
assert.equal(intent.continuationStatus, 'MESSAGE_SENT');

await mount();
let refused = presentation('PENDING');
reports = [];
send = () => Promise.reject(new Error('Outcome of sending is unknown'));
call = request => {
  if (request.name === 'widget.state') return Promise.resolve(response(refused));
  if (request.name === 'widget.steps') return Promise.resolve(history());
  if (request.name === 'widget.claim') return Promise.resolve(text({ claimed: true }));
  reports.push(request.arguments);
  refused = { ...refused, continuationStatus: 'UNAVAILABLE', continuationReason: request.arguments.reason };
  return Promise.resolve(response(refused));
};
show(refused); await settled();
assert.equal(messages.length, 1); assert.equal(reports[0].sent, false);
show(refused); await settled();
assert.equal(messages.length, 1, 'An uncertain host send cannot be automatically replayed');
assert.match(elements.get('state').textContent, /не подтвердил отправку/);

await mount();
capabilities = {};
const unsupported = presentation('PENDING');
const unsupportedCalls = [];
call = request => {
  unsupportedCalls.push(request.name);
  return Promise.resolve(request.name === 'widget.state' ? response(unsupported) : history());
};
show(unsupported); await settled();
assert.equal(messages.length, 0);
assert.equal(unsupportedCalls.includes('widget.claim'), false, 'Unsupported hosts cannot consume a continuation claim');
assert.match(elements.get('state').textContent, /не поддерживает автоматическое продолжение/);
await app.onteardown();
assert.equal(timers.size, 0);
assert.equal(windowListeners.has('online'), false);
assert.equal(windowListeners.has('offline'), false);
assert.equal(documentListeners.has('visibilitychange'), false);
for (const outcome of ['PARTIAL', 'NOT_ACHIEVED', 'FAILED', 'SUCCEEDED', 'STOPPED']) {
  await mount();
  let taskState = presentation('IDLE', liveBrowser());
  let viewerRequests = 0;
  call = request => {
    if (request.name === 'widget.state') return Promise.resolve(response(taskState));
    if (request.name === 'widget.steps') return Promise.resolve(history());
    if (request.name === 'widget.browser') { viewerRequests++; return Promise.resolve(ticket); }
    throw new Error(request.name);
  };
  show(taskState); await settled(); viewerState('connected');
  const epoch = new URL(elements.get('viewer').src).searchParams.get('viewerEpoch');
  taskState = { ...taskState, task: { ...taskState.task, status: outcome, version: 2 } };
  sources.at(-1).change('task'); await settled();
  assert.equal(elements.get('viewer').src, undefined, outcome + ' releases the video transport');
  assert.equal(elements.get('browser-state').hidden, true, outcome + ' leaves an empty canvas');
  assert.equal(elements.get('browser-state').textContent, '');
  assert.equal(elements.get('content').inert, true);
  assert.equal(elements.get('header-status')['data-status'], outcome);
  assert.equal(elements.has('status'), false, 'Only the header owns the task status');
  assert.equal(timers.size, 0, 'Finished widgets must not retry viewing');
  viewerState('connected', epoch);
  sources.at(-1).change('browser'); await settled();
  assert.equal(elements.get('viewer').hidden, true, 'Late frames cannot reactivate a finished widget');
  assert.equal(viewerRequests, 1);
  if (outcome !== 'STOPPED') {
    taskState = { ...taskState, task: { ...taskState.task, status: 'WAITING_CHATGPT', version: 3 } };
    sources.at(-1).change('task'); await settled(); viewerState('connected');
    assert.equal(elements.get('content').inert, false, 'Explicit continuation reactivates the current widget');
    assert.equal(elements.get('viewer').hidden, false);
    assert.equal(viewerRequests, 2);
  }
  await app.onteardown();
}
console.log('PASS widget execution, finished canvas, contextual login, safe address, fresh media, recovery, isolation and continuation races');
