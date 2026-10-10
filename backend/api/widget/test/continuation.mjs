import assert from 'node:assert/strict';

// Execute the actual widget bundle against controlled host callbacks on dev.
class Element {
  contentWindow = { postMessage(message) { viewerMessages.push(message); } };
  listeners = new Map(); children = []; disabled = true; hidden = false;
  classList = { add() {}, remove() {}, toggle() {} }; style = { setProperty(name, value) { this[name] = value; } }; value = "";
  focus() {}
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeAttribute(name) { delete this[name]; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = undefined; }
  insertBefore(item, reference) { item.remove(); item.parent = this; const index = reference ? this.children.indexOf(reference) : this.children.length; this.children.splice(index, 0, item); }
  replaceChildren(...items) { this.children = items; }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
for (const name of ['HTMLElement', 'HTMLHeadingElement', 'HTMLSpanElement', 'HTMLParagraphElement',
  'HTMLInputElement', 'HTMLIFrameElement', 'HTMLButtonElement', 'HTMLImageElement', 'HTMLOListElement']) globalThis[name] = Element;
let elements, sources, app, call, send, capabilities, hostContext, moduleId = 0;
const messages = [], links = [], viewerMessages = [], timers = new Map(), windowListeners = new Map(), documentListeners = new Map();
const intervals = new Map();
let copiedText, copyAllowed = true, copyThrows = false;
const selection = {
  range: undefined,
  removeAllRanges() { this.range = undefined; },
  addRange(range) { this.range = range; },
  toString() { return this.range?.node.textContent ?? ''; },
};
let timerId = 0;
globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.setInterval = callback => { const id = ++timerId; intervals.set(id, callback); return id; };
globalThis.clearInterval = id => intervals.delete(id);
globalThis.document = {
  body: new Element(),
  visibilityState: 'visible',
  getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); if (id === "session-panel" && !elements.get(id).initialized) { elements.get(id).hidden = true; elements.get(id).initialized = true; } return elements.get(id); },
  createElement() { return new Element(); },
  createRange() { return { selectNodeContents(node) { this.node = node; } }; },
  execCommand(command) {
    assert.equal(command, 'copy');
    if (copyThrows) throw new DOMException('Copy refused', 'NotAllowedError');
    if (!copyAllowed) return false;
    copiedText = selection.toString();
    return true;
  },
  addEventListener(type, callback) { documentListeners.set(type, callback); },
  removeEventListener(type, callback) { if (documentListeners.get(type) === callback) documentListeners.delete(type); },
};
globalThis.window = {
  getSelection() { return selection; },
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
  connect() {
    assert.equal(elements.get('card').style.maxHeight, 'none', 'CSS owns the initial responsive height');
    return Promise.resolve();
  }
  getHostCapabilities() { return capabilities; }
  getHostContext() { return hostContext; }
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
    status: 'WAITING_CHATGPT', waitReason: null, summary: null, version: 1, instructionRevision: 1, stepCount: 20,
    browser, request: null, result: null } });
const metadata = value => ({ publicUrl: 'https://helm.example',
  taskUrl: 'https://helm.example/tasks/' + value.task.id + '?tab=overview',
  loginUrl: 'https://helm.example/tasks/' + value.task.id + '?tab=overview&login=1',
  eventsUrl: 'https://helm.example/widget/events?ticket=' + value.generation });
const show = value => app.ontoolresult({ structuredContent: value, _meta: metadata(value) });
const stale = response({ code: 'STALE_WIDGET', message: 'Newer presentation exists' });
const ticket = text({ url: 'https://helm.example/browser/view?ticket=fixture', expiresAt: '2099-01-01T00:00:00Z' });
const liveBrowser = () => ({ id: crypto.randomUUID(), status: 'LIVE', privateMode: false, version: 1, controlOwner: 'CHATGPT', startedAt: '2026-10-09T00:00:00Z', closedAt: null, idleCloseAt: null, idleTimeoutSeconds: 300, idleWarningAt: null, cleanupState: 'NONE', cleanupError: null, closeReason: null,
  connectionId: null, connectionInfo: null,
  currentUrl: 'https://secret-user:secret-password@site.example/work?token=secret#private' });
const agentStepId = crypto.randomUUID();
let agentStepVersion = 1;
const history = () => text({ items: [{ id: agentStepId, sequence: 20, version: agentStepVersion,
  status: agentStepVersion === 1 ? 'RUNNING' : 'FAILED', title: 'Прочитать страницу',
  tool: 'browser.execute', durationMs: agentStepVersion === 1 ? null : 123,
  result: agentStepVersion === 1 ? null : 'Инструмент отклонил запрос.',
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
async function mount(widgetHost) {
  if (app) await app.onteardown();
  window.openai = widgetHost;
  elements = new Map(); sources = []; timers.clear(); messages.length = 0; links.length = 0; viewerMessages.length = 0;
  document.visibilityState = 'visible';
  navigator.onLine = true;
  capabilities = { message: { text: {} } };
  hostContext = { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] };
  send = () => Promise.resolve({});
  await import('WIDGET_UNDER_TEST#' + ++moduleId);
}

await mount();
assert.equal(elements.get('card').style.maxHeight, 'none', 'An unconstrained host preserves the intrinsic card size');
hostContext.containerDimensions = { maxHeight: 480, width: 700 };
hostContext.safeAreaInsets = { top: 12, bottom: 20, left: 0, right: 0 };
app.onhostcontextchanged(hostContext);
assert.equal(elements.get('card').style.maxHeight, '448px', 'Safe area is reserved inside the host height limit');
hostContext.containerDimensions = { height: 600, width: 700 };
hostContext.displayMode = 'fullscreen';
app.onhostcontextchanged(hostContext);
assert.equal(elements.get('card').style.maxHeight, '568px', 'A larger host allows the intrinsic size without stretching the card');
hostContext.containerDimensions = { maxWidth: 700 };
hostContext.safeAreaInsets = undefined;
app.onhostcontextchanged(hostContext);
assert.equal(elements.get('card').style.maxHeight, 'none', 'Removing the host constraint restores the intrinsic size');
const fresh = presentation('IDLE', liveBrowser()), saved = structuredClone(fresh), restoredCalls = [];
saved.task.title = 'Saved title before the update';
delete saved.task.stepCount;
delete saved.task.browser.idleCloseAt;
delete saved.task.browser.closeReason;
call = request => {
  restoredCalls.push(request.name);
  if (request.name === 'widget.state') return Promise.resolve(response(fresh));
  if (request.name === 'widget.browser') return Promise.resolve(ticket);
  if (request.name === 'widget.steps') return Promise.resolve(history());
  throw new Error(request.name);
};
show(saved); await settled();
assert.ok(restoredCalls.includes('widget.state'), 'Saved responses from before a schema change must refresh from the server');
assert.equal(elements.get('title').textContent, fresh.task.title);
assert.equal(elements.get('event-count').textContent, '20');
assert.ok(elements.get('viewer').src, 'A historical response must restore the current browser');

await mount();
const oldState = deferred(), oldPresentation = presentation('PENDING'), active = presentation();
let initialCalls = 0;
call = request => {
  if (request.name === 'widget.state') return ++initialCalls === 1 ? oldState.promise : Promise.resolve(response(active));
  if (request.name === 'widget.steps') return Promise.resolve(history());
  throw new Error(request.name);
};
show({ generation: oldPresentation.generation, task: { id: oldPresentation.task.id } });
show({ generation: active.generation, task: { id: active.task.id } });
oldState.resolve(response(oldPresentation)); await settled();
assert.equal(elements.get('title').textContent, active.task.title);
assert.equal(elements.get('cabinet').disabled, false, 'A stable reference alone restores a card');
assert.equal(messages.length, 0, 'A late bootstrap response cannot continue the previous presentation');

await mount();
let offlineBootstrapCalls = 0;
call = request => {
  offlineBootstrapCalls++;
  return Promise.resolve(request.name === 'widget.state' ? response(active) : history());
};
navigator.onLine = false; windowListeners.get('offline')();
show({ generation: active.generation, task: { id: active.task.id } }); await settled();
assert.equal(offlineBootstrapCalls, 0);
navigator.onLine = true; windowListeners.get('online')(); await settled();
assert.equal(elements.get('title').textContent, active.task.title, 'A reference received offline restores when the network returns');

let retirementWrites = 0;
const retiredHost = { widgetState: null, setWidgetState(value) {
  retirementWrites++;
  this.widgetState = structuredClone(value);
} };
await mount(retiredHost);
call = () => Promise.resolve({ ...stale, isError: true });
show({ generation: active.generation, task: { id: active.task.id } }); await settled();
assert.equal(elements.get('header-status').hidden, true);
assert.equal(elements.get('state').hidden, true);
assert.equal(timers.size, 0, 'A stale reference is retired before any current state exists');
assert.equal(messages.length, 0);
assert.deepEqual(retiredHost.widgetState, { privateContent: {
  retiredPresentation: { generation: active.generation, task: { id: active.task.id } },
} }, 'Only the confirmed retired presentation is saved in widget-private state');

await mount(retiredHost);
const retiredReloadCalls = [];
call = request => { retiredReloadCalls.push(request.name); return Promise.resolve(stale); };
show({ generation: active.generation, task: { id: active.task.id } }); await settled();
windowListeners.get('online')(); documentListeners.get('visibilitychange')(); await settled();
assert.deepEqual(retiredReloadCalls, [], 'A restored inactive widget makes no server requests');
assert.equal(elements.get('card').inert, true);
assert.equal(elements.get('state').hidden, true);
assert.equal(sources.length, 0, 'A restored inactive widget creates no event subscription');
assert.equal(timers.size, 0);
assert.equal(intervals.size, 0);
assert.equal(retirementWrites, 1, 'Restoring retirement must not write unchanged host state again');

for (const storedReference of [
  { generation: crypto.randomUUID(), task: { id: active.task.id } },
  { generation: active.generation, task: { id: crypto.randomUUID() } },
  { generation: active.generation, task: null },
]) {
  await mount({ widgetState: { privateContent: { retiredPresentation: storedReference } } });
  const checkedCalls = [];
  call = request => {
    checkedCalls.push(request.name);
    return Promise.resolve(request.name === 'widget.state' ? response(active) : history());
  };
  show({ generation: active.generation, task: { id: active.task.id } }); await settled();
  assert.ok(checkedCalls.includes('widget.state'), 'Unrelated or invalid saved state must not retire this presentation');
  assert.equal(elements.get('title').textContent, active.task.title);
}

await mount();
call = () => { throw new Error('An invalid tool result must not call the server'); };
app.ontoolresult({ isError: true, structuredContent: { code: 'FORBIDDEN', message: 'Доступ к задаче запрещён.' } });
assert.equal(elements.get('state').textContent, 'Доступ к задаче запрещён.');
assert.equal(elements.get('header-status').textContent, 'Ошибка загрузки');
assert.equal(elements.get('browser-state').textContent, 'Данные задачи недоступны.');
assert.equal(elements.get('cabinet').disabled, true);

await mount();
const preflight = deferred(), mounted = presentation('PENDING', liveBrowser()), preflightCalls = [];
call = request => { preflightCalls.push(request.name); return preflight.promise; };
show(mounted);
assert.notEqual(elements.get('title').textContent, mounted.task.title, 'Saved task data is not authoritative before preflight');
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
const frozenPresentation = presentation('IDLE', liveBrowser()), lateSteps = deferred();
let retire = false;
const frozenCalls = [];
call = request => {
  frozenCalls.push(request.name);
  if (request.name === 'widget.state') return Promise.resolve(retire ? stale : response(frozenPresentation));
  if (request.name === 'widget.steps') return retire ? lateSteps.promise : Promise.resolve(history());
  if (request.name === 'widget.browser') return Promise.resolve(ticket);
  throw new Error(request.name);
};
show(frozenPresentation); await settled();
viewerState('connected');
const frozenVisual = () => Object.fromEntries(['title', 'header-status', 'browser-state', 'viewer',
  'event-count', 'steps-count', 'history-state', 'session-duration'].map(id => {
    const element = elements.get(id);
    return [id, { text: element.textContent, hidden: element.hidden, src: element.src }];
  }));
const beforeRetirement = frozenVisual(), retiredSource = sources.at(-1);
retire = true;
retiredSource.change('step'); await settled();
assert.deepEqual(frozenVisual(), beforeRetirement, 'Retiring preserves the displayed status, steps and browser frame');
assert.equal(elements.get('state').hidden, true, 'Inactive cards have no status banner below their content');
assert.equal(elements.get('idle-warning').hidden, true, 'A retired browser has no idle extension control');
assert.equal(viewerMessages.at(-1).type, 'helm-viewer-freeze', 'The viewer disconnects without clearing its last frame');
assert.ok(retiredSource.closed);
assert.equal(timers.size, 0);
assert.equal(intervals.size, 0);
const retiredCallCount = frozenCalls.length;
lateSteps.resolve(history());
retiredSource.change('task'); retiredSource.onopen(); retiredSource.onerror();
windowListeners.get('offline')(); windowListeners.get('online')();
documentListeners.get('visibilitychange')();
show(presentation('PENDING', liveBrowser()));
await settled();
assert.equal(frozenCalls.length, retiredCallCount, 'Retired cards never request status, steps or viewer tickets again');
assert.deepEqual(frozenVisual(), beforeRetirement, 'Late replies and host events cannot repaint a retired card');
assert.equal(elements.get('state').hidden, true);
assert.equal(messages.length, 0);

await mount();
let state = presentation('IDLE', liveBrowser());
const calls = [];
let pendingTicket;
call = request => {
  calls.push(request);
  if (request.name === 'widget.state') return Promise.resolve(response(state));
  if (request.name === 'widget.browser') return pendingTicket?.promise ?? Promise.resolve(ticket);
  if (request.name === 'widget.steps') return Promise.resolve(request.arguments.search
    ? text({ items: [], total: 0, page: 1, pageSize: 10 }) : history());
  throw new Error(request.name);
};
show(state); await settled();
assert.ok(elements.get('viewer').src, 'Validated live browsers open automatically');
assert.equal(elements.get('viewer').hidden, true, 'A ticket does not prove a live frame');
viewerState('connected');
assert.equal(elements.get('viewer').hidden, false);
assert.equal(elements.get('steps').children.length, 1, 'Latest steps are visible without disclosure');
assert.equal(elements.get('event-count').textContent, '20');
assert.ok(calls.filter(item => item.name === 'widget.steps').every(item => item.arguments.page === 1));
assert.equal(elements.get('cabinet').textContent, 'Открыть в Helm Glass');
const viewerSource = elements.get('viewer').src;
const callsBeforeCollapse = calls.length;
elements.get('steps-toggle').disabled = false;
assert.equal(elements.get('steps-panel').hidden, false);
assert.equal(elements.get('steps-toggle')['aria-expanded'], 'true');
elements.get('steps-toggle').click();
assert.equal(elements.get('steps-panel').hidden, true);
assert.equal(elements.get('steps-toggle')['aria-expanded'], 'false');
assert.equal(elements.get('viewer').src, viewerSource, 'Folding steps preserves the current viewer');
assert.equal(calls.length, callsBeforeCollapse, 'Folding steps is a local presentation action');
elements.get('expand').disabled = false;
elements.get('expand').click();
assert.equal(elements.get('expand')['aria-label'], 'Свернуть браузер');
assert.equal(elements.get('viewer').src, viewerSource, 'Expanding preserves the live viewer');
assert.equal(calls.length, callsBeforeCollapse, 'Expanding stays inside the existing widget');
documentListeners.get('keydown')({ key: 'Escape' });
assert.equal(elements.get('expand')['aria-label'], 'Развернуть браузер');
assert.equal(elements.get('steps-panel').hidden, true, 'Returning restores the chosen sidebar state');
elements.get('session-toggle').disabled = false;
elements.get('steps-toggle').click();
elements.get('session-toggle').click();
assert.equal(elements.get('steps-panel').hidden, true);
assert.equal(elements.get('steps-toggle')['aria-expanded'], 'false');
assert.equal(elements.get('steps-toggle')['aria-label'], 'Показать шаги');
assert.equal(elements.get('session-id').textContent, state.task.browser.id);
assert.equal(elements.get('viewer').src, viewerSource, 'Session facts reuse the same viewer');

navigator.clipboard = { writeText() { return Promise.reject(new DOMException('Clipboard API blocked by the host', 'NotAllowedError')); } };
elements.get('copy-session').disabled = false;
elements.get('copy-session').click(); await settled();
assert.equal(copiedText, state.task.browser.id, 'Copy works even when the host blocks the Clipboard API');
assert.equal(elements.get('state').textContent, 'Идентификатор браузера скопирован.');
copyAllowed = false;
elements.get('copy-session').click(); await settled();
assert.match(elements.get('state').textContent, /Ctrl\+C/);
assert.equal(elements.get('state').className, 'error');
assert.equal(selection.toString(), state.task.browser.id, 'A refused copy leaves the exact ID selected for manual copying');
copyAllowed = true; copyThrows = true;
elements.get('copy-session').click(); await settled();
assert.match(elements.get('state').textContent, /Ctrl\+C/, 'Copy exceptions remain actionable');
copyThrows = false; navigator.clipboard = undefined; copiedText = undefined;
elements.get('copy-session').click(); await settled();
assert.equal(copiedText, state.task.browser.id, 'Copy also works when the Clipboard API is absent');

elements.get('session-toggle').click();
const sourceBeforeVideoOff = sources.at(-1);
elements.get('video-toggle').click();
assert.equal(elements.get('viewer').src, undefined, 'Video off releases frame transport');
assert.equal(sourceBeforeVideoOff.closed, false, 'Video off preserves server events');
const requestsWhileOff = calls.filter(item => item.name === 'widget.browser').length;
sources.at(-1).change('browser'); await settled();
assert.equal(calls.filter(item => item.name === 'widget.browser').length, requestsWhileOff,
  'Server changes cannot restart explicitly disabled video');
elements.get('video-toggle').click(); await settled(); viewerState('connected');
assert.equal(elements.get('viewer').hidden, false);
assert.equal(sourceBeforeVideoOff, sources.at(-1));
viewerState('resized', 'stale-epoch', { width: 800, height: 600 });
assert.equal(document.getElementById('viewport').style.aspectRatio, undefined);
viewerState('resized', undefined, { width: 1440, height: 900 });
assert.equal(elements.get('viewport').style.aspectRatio, undefined, 'Frame dimensions cannot grow the card');
viewerState('resized', undefined, { width: -1, height: 900 });
assert.equal(elements.get('viewport').style.aspectRatio, undefined);
elements.get('cabinet').click();
assert.equal(links.at(-1).url, metadata(state).taskUrl);

const historyCalls = calls.filter(item => item.name === 'widget.steps').length;
const sourceBeforeHistory = elements.get('viewer').src;
const stepRow = elements.get('steps').children[0];
const disclosure = stepRow.children[0];
const result = stepRow.children[1];
assert.equal(disclosure.disabled, true, 'A step without a result has no disclosure');
assert.equal(disclosure.getAttribute('aria-expanded'), null);
agentStepVersion++;
sources.at(-1).change('step'); await settled();
assert.equal(elements.get('steps').children[0], stepRow, 'An update must preserve the agent step row');
assert.equal(elements.get('steps').children.length, 1, 'Status updates do not append progress entries');
assert.equal(elements.get('event-count').textContent, '20');
assert.match(disclosure.children[0].textContent, /Вызов отклонён · browser.execute · 123 мс/);
assert.equal(disclosure.disabled, false);
assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
assert.equal(result.hidden, true, 'A newly available result starts collapsed');
disclosure.click();
assert.equal(result.hidden, false);
assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
elements.get('steps-content').scrollTop = 123;
agentStepVersion++;
sources.at(-1).change('step'); await settled();
assert.equal(elements.get('steps').children[0], stepRow);
assert.equal(disclosure.getAttribute('aria-expanded'), 'true', 'Updates preserve disclosure state');
assert.equal(result.hidden, false);
assert.equal(elements.get('steps-content').scrollTop, 123, 'Updates preserve panel scroll position');
assert.equal(elements.get('viewer').src, sourceBeforeHistory, 'Step updates preserve the viewer');
hostContext.containerDimensions = { maxHeight: 400, width: 500 };
hostContext.displayMode = 'fullscreen';
app.onhostcontextchanged(hostContext);
assert.equal(elements.get('viewer').src, sourceBeforeHistory, 'Host resizing preserves the connected iframe');
disclosure.click();
assert.equal(result.hidden, true);

assert.equal(calls.filter(item => item.name === 'widget.steps').length, historyCalls + 2);
elements.get('steps-search').value = 'несуществующий шаг';
elements.get('steps-search').listeners.get('input')(); await nextTimer();
assert.match(elements.get('history-state').textContent, /По запросу шаги не найдены/);
assert.equal(elements.get('event-count').textContent, '20', 'Filtering keeps the task step count');
assert.equal(elements.get('steps').children.length, 0);
elements.get('steps-search').value = '';
elements.get('steps-search').listeners.get('input')(); await nextTimer();
assert.equal(elements.get('history-state').hidden, true);
assert.equal(elements.get('steps').children.length, 1);
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
const beforeStaleRecovery = frozenVisual();
await nextTimer();
assert.ok(lastSource.closed); assert.equal(timers.size, 0);
assert.equal(elements.get('cabinet').disabled, true);
assert.deepEqual(frozenVisual(), beforeStaleRecovery, 'A stale recovery response preserves the last displayed state');

for (const outage of ['snapshot', 'events']) {
  await mount();
  const recovering = presentation('IDLE', liveBrowser());
  let stateUnavailable = false;
  let viewerRequests = 0;
  call = request => {
    if (request.name === 'widget.state') return stateUnavailable
      ? Promise.reject(new Error('Temporary state request failure')) : Promise.resolve(response(recovering));
    if (request.name === 'widget.steps') return Promise.resolve(history());
    if (request.name === 'widget.browser') { viewerRequests++; return Promise.resolve(ticket); }
    throw new Error(request.name);
  };
  show(recovering); await settled(); viewerState('connected');
  const originalSource = elements.get('viewer').src;
  const originalViewerEpoch = new URL(originalSource).searchParams.get('viewerEpoch');
  viewerState('disconnected');
  const eventStream = sources.at(-1);
  if (outage === 'events') eventStream.onerror();
  else {
    stateUnavailable = true;
    eventStream.change('task'); await settled();
  }
  await nextTimer();
  assert.equal(viewerRequests, 1, 'Viewer recovery waits for authoritative state');
  assert.equal(elements.get('viewer').hidden, true, 'An unsynchronized frame stays hidden');
  stateUnavailable = false;
  await nextTimer();
  assert.equal(viewerRequests, 2, outage + ': restored state resumes a skipped video retry');
  assert.equal(viewerMessages.at(-1)?.type, 'helm-viewer-reconnect');
  assert.equal(elements.get('viewer').src, originalSource, 'Recovery preserves the viewer iframe');
  assert.equal(new URL(viewerMessages.at(-1).url).searchParams.get('viewerEpoch'), originalViewerEpoch);
  viewerState('connected');
  assert.equal(elements.get('viewer').hidden, false, outage + ': fresh video returns automatically');
  assert.equal(timers.size, 0);
  assert.equal(messages.length, 0, 'Restoring video does not continue the task or replay browser actions');
}

for (const outcome of ['SUCCEEDED', 'PARTIAL', 'NOT_ACHIEVED', 'FAILED', 'STOPPED', 'WAITING_CHATGPT']) {
  await mount();
  const recovered = presentation();
  recovered.task.status = outcome;
  recovered.task.summary = 'Сохранённый результат';
  let stateUnavailable = false;
  call = request => {
    if (request.name === 'widget.state') return stateUnavailable
      ? Promise.reject(new Error('Temporary state request failure')) : Promise.resolve(response(recovered));
    if (request.name === 'widget.steps') return Promise.resolve(history());
    throw new Error(request.name);
  };
  show(recovered); await settled();
  const healthyStream = sources.at(-1);
  for (let outage = 0; outage < 9; outage++) {
    stateUnavailable = true;
    healthyStream.change('task'); await settled();
    assert.equal(elements.get('state').hidden, false, 'An actual refresh failure remains visible');
    assert.equal(elements.get('header-status')['data-status'], outcome);
    assert.equal(elements.has('summary'), false, 'Task results must not create a duplicate footer summary');
    stateUnavailable = false;
    assert.equal(timers.size, 1, outcome + ': outage ' + (outage + 1) + ' must schedule recovery');
    await nextTimer();
    assert.equal(elements.get('state').hidden, true, outcome + ' recovers from an independent outage');
    assert.equal(sources.at(-1), healthyStream, 'A failed snapshot must not replace a healthy stream');
  }
  stateUnavailable = true;
  healthyStream.change('task'); await settled();
  assert.equal(timers.size, 1);
  stateUnavailable = false;
  healthyStream.change('task'); await settled();
  assert.equal(timers.size, 0, 'A successful event-driven refresh cancels the obsolete retry');
  assert.equal(elements.get('state').hidden, true);

  stateUnavailable = true;
  healthyStream.change('task'); await settled();
  for (let retry = 0; retry < 8; retry++) await nextTimer();
  assert.equal(timers.size, 0, 'Consecutive snapshot failures remain bounded');
  assert.match(elements.get('state').textContent, /Связь недоступна/);
}

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
let intent = presentation('PENDING', liveBrowser()), originalIntent = intent.continuationId;
reports = [];
call = request => {
  if (request.name === 'widget.state') return Promise.resolve(response(intent));
  if (request.name === 'widget.browser') return Promise.resolve(ticket);
  if (request.name === 'widget.steps') return Promise.resolve(history());
  if (request.name === 'widget.claim') return Promise.resolve(text({ claimed: true }));
  reports.push(request.arguments);
  intent = { ...intent, continuationStatus: 'MESSAGE_SENT' };
  return Promise.resolve(response(intent));
};
send = () => messages.length === 1 ? oldAck.promise : Promise.resolve({});
show(intent); await settled(); assert.equal(messages.length, 1);
viewerState('connected');
const continuationViewer = elements.get('viewer').src;
assert.match(messages[0].content[0].text, /Не вызывай tasks\.view/,
  'Automatic continuation must keep the mounted card instead of requesting another render');
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
assert.equal(elements.get('viewer').src, continuationViewer, 'Continuation retains the live video frame');
assert.equal(elements.get('viewer').hidden, false);

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
  assert.equal(elements.get('browser-state').hidden, false, outcome + ' explains the closed browser');
  assert.match(elements.get('browser-state').textContent, /Шаги и результаты/);
  assert.equal(elements.get('content').inert, false);
  assert.equal(elements.get('cabinet').disabled, false, 'Results remain accessible');
  assert.equal(elements.get('header-status')['data-status'], outcome);
  assert.equal(elements.has('status'), false, 'Only the header owns the task status');
  assert.equal(timers.size, 0, 'Finished widgets must not retry viewing');
  viewerState('connected', epoch);
  sources.at(-1).change('browser'); await settled();
  assert.equal(elements.get('viewer').hidden, true, 'Late frames cannot reactivate a finished widget');
  assert.equal(viewerRequests, 1);
  if (outcome === 'STOPPED') {
    taskState = { ...taskState, task: { ...taskState.task,
      browser: { ...taskState.task.browser, status: 'CLOSED' }, version: 3 } };
    sources.at(-1).change('browser'); await settled();
    assert.doesNotMatch(elements.get('browser-state').textContent, /Возобновить/,
      'STOPPED is final and cannot offer to resume the task');
    assert.match(elements.get('browser-state').textContent, /Шаги и результаты/);
  }
  if (outcome !== 'STOPPED') {
    taskState = { ...taskState, task: { ...taskState.task, status: 'WAITING_CHATGPT', version: 3 } };
    sources.at(-1).change('task'); await settled(); viewerState('connected');
    assert.equal(elements.get('content').inert, false, 'Explicit continuation reactivates the current widget');
    assert.equal(elements.get('viewer').hidden, false);
    assert.equal(viewerRequests, 2);
  }
  await app.onteardown();
}
await mount();
let idle = presentation('IDLE', { ...liveBrowser(), idleCloseAt: new Date(Date.now() + 59000).toISOString(), idleWarningAt: new Date(Date.now() - 1000).toISOString() });
const keepRequests = [];
call = request => {
  if (request.name === 'widget.state') return Promise.resolve(response(idle));
  if (request.name === 'widget.steps') return Promise.resolve(history());
  if (request.name === 'widget.browser') return Promise.resolve(ticket);
  if (request.name === 'widget.keep-open') {
    keepRequests.push(request.arguments);
    idle = { ...idle, task: { ...idle.task, browser: { ...idle.task.browser,
      idleCloseAt: new Date(Date.now() + 300000).toISOString(), idleWarningAt: new Date(Date.now() + 240000).toISOString() } } };
    return Promise.resolve(response(idle));
  }
  throw new Error(request.name);
};
show(idle); await settled();
assert.equal(elements.get('idle-warning').hidden, false, 'One-minute warning uses the server deadline with session details folded');
assert.match(elements.get('idle-countdown').textContent, /0:5/);
elements.get('keep-open').disabled = false;
elements.get('keep-open').click(); await settled();
assert.equal(keepRequests.length, 1);
assert.equal(keepRequests[0].browserId, idle.task.browser.id);
assert.equal(elements.get('idle-warning').hidden, true, 'An acknowledged extension clears the warning');
assert.equal(messages.length, 0, 'Keeping the browser open must not launch ChatGPT');
await app.onteardown();
assert.equal(intervals.size, 0, 'Widget clocks are disposed on teardown');
await mount();
const capacityPresentation = presentation('IDLE', liveBrowser());
const capacityMessage = 'Оба места просмотра заняты. Закройте трансляцию в другой вкладке. Ожидаем свободного места.';
let capacityFull = true;
call = request => {
  if (request.name === 'widget.state') return Promise.resolve(response(capacityPresentation));
  if (request.name === 'widget.steps') return Promise.resolve(history());
  if (request.name === 'widget.browser') return Promise.resolve(capacityFull
    ? { isError: true, content: [], structuredContent: { code: 'VIEWER_LIMIT_REACHED', message: capacityMessage } }
    : ticket);
  throw new Error(request.name);
};
show(capacityPresentation); await settled();
assert.equal(elements.get('browser-state').textContent, capacityMessage,
  'Ticket rejection must preserve the server reason instead of claiming a network break');
assert.equal(elements.get('viewer').src, undefined, 'Rejected tickets never initiate an iframe handshake');
await nextTimer();
assert.equal(elements.get('browser-state').textContent, capacityMessage);
capacityFull = false;
await nextTimer(); viewerState('connected');
assert.equal(elements.get('viewer').hidden, false, 'A freed viewer slot recovers through the existing retry');
assert.equal(elements.get('browser-state').hidden, true);
assert.equal(messages.length, 0, 'Viewer recovery does not launch ChatGPT or perform a browser action');
await app.onteardown();
await mount();
let sessionState = presentation('IDLE', { ...liveBrowser(), connectionId: crypto.randomUUID(),
  connectionInfo: { name: 'Подключение к заданию', site: 'site.example',
    accountLabel: 'Тестовый аккаунт', version: 1 } });
call = request => Promise.resolve(request.name === 'widget.state' ? response(sessionState)
  : request.name === 'widget.steps' ? history() : ticket);
show(sessionState); await settled();
elements.get('session-toggle').listeners.get('click')();
assert.equal(elements.get('session-connection').textContent, 'Подключение к заданию');
assert.equal(elements.get('session-account').textContent, 'Тестовый аккаунт');
assert.equal(elements.get('session-site').textContent, 'site.example');
sessionState = { ...sessionState, task: { ...sessionState.task, browser: {
  ...sessionState.task.browser, version: 3,
  connectionInfo: { ...sessionState.task.browser.connectionInfo, name: 'Обновлённое подключение', version: 2 },
} } };
sources.at(-1).change('connection'); await settled();
assert.equal(elements.get('session-connection').textContent, 'Обновлённое подключение');
assert.equal(elements.get('session-panel').hidden, false, 'Connection changes preserve the open panel');
sessionState = { ...sessionState, task: { ...sessionState.task, browser: {
  ...sessionState.task.browser, version: 4,
  connectionInfo: { ...sessionState.task.browser.connectionInfo, name: 'Устаревшее имя', version: 1 },
} } };
sources.at(-1).change('connection'); await settled();
assert.equal(elements.get('session-connection').textContent, 'Обновлённое подключение',
  'An older connection revision cannot replace its newer name');
sessionState = { ...sessionState, task: { ...sessionState.task, browser: {
  ...sessionState.task.browser, version: 3,
  connectionInfo: { ...sessionState.task.browser.connectionInfo, name: 'Актуальный аккаунт', version: 3 },
} } };
sources.at(-1).change('connection'); await settled();
assert.equal(elements.get('session-connection').textContent, 'Актуальный аккаунт',
  'Browser and connection revisions advance independently');
sessionState = { ...sessionState, task: { ...sessionState.task, browser: {
  ...sessionState.task.browser, version: 5, connectionInfo: null,
  idleCloseAt: new Date(Date.now() - 1000).toISOString(),
} } };
sources.at(-1).change('browser'); await settled();
assert.equal(elements.get('session-account-row').hidden, true);
assert.equal(elements.get('session-connection-row').hidden, true);
assert.match(elements.get('session-idle').textContent, /Ожидаем подтверждения закрытия/);
sessionState = { ...sessionState, task: { ...sessionState.task, browser: {
  ...sessionState.task.browser, version: 6, status: 'CLOSED', closeReason: 'IDLE_TIMEOUT',
  closedAt: '2026-10-09T00:05:00Z',
} } };
sources.at(-1).change('browser'); await settled();
assert.equal(elements.get('session-duration').textContent, '00:05:00');
assert.equal(elements.get('session-close-reason').textContent, 'Из-за простоя');
assert.equal(elements.get('session-idle-row').hidden, true);
assert.equal(intervals.size, 0, 'A confirmed close stops the session clock');
sessionState = { ...sessionState, task: { ...sessionState.task, browser: {
  ...sessionState.task.browser, version: 7, status: 'LOST', closedAt: null, closeReason: null,
} } };
sources.at(-1).change('browser'); await settled();
assert.equal(elements.get('session-duration-row').hidden, true, 'An unconfirmed loss has no final duration');
assert.equal(elements.get('session-closed-row').hidden, true);
assert.equal(intervals.size, 0);
sessionState = { ...sessionState, task: { ...sessionState.task, browser: {
  ...sessionState.task.browser, version: 8, status: 'QUEUED', startedAt: null,
} } };
sources.at(-1).change('browser'); await settled();
assert.equal(elements.get('session-start-row').hidden, true);
assert.equal(elements.get('session-duration-row').hidden, true);
await app.onteardown();
console.log('PASS widget session context and lifecycle, idle extension, execution, recovery, isolation, viewer admission and continuation races');
