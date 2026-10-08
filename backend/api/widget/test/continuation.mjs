import assert from 'node:assert/strict';

// A controlled host boundary exercises the actual bundled widget's async callbacks.
// It does not establish compatibility with the real ChatGPT host.
class Element {
  contentWindow = { postMessage() {} };
  listeners = new Map();
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeAttribute(name) { delete this[name]; }
  click() { this.listeners.get('click')?.(); }
}
for (const name of ['HTMLElement', 'HTMLHeadingElement', 'HTMLSpanElement', 'HTMLParagraphElement',
  'HTMLIFrameElement', 'HTMLButtonElement']) globalThis[name] = Element;
const elements = new Map();
globalThis.document = { getElementById(id) {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
} };
globalThis.window = { addEventListener() {} };
globalThis.location = { origin: 'https://widget.example' };
const sources = [];
globalThis.EventSource = class {
  constructor(url) { this.url = String(url); sources.push(this); }
  closed = false;
  close() { this.closed = true; }
  addEventListener() {}
};
let app, call, send;
const openedLinks = [];
globalThis.WidgetTestApp = class {
  constructor() { app = this; }
  connect() { return Promise.resolve(); }
  callServerTool(request) { return call(request); }
  sendMessage(message) { return send(message); }
  openLink(link) { openedLinks.push(link); return Promise.resolve({}); }
};
await import('WIDGET_UNDER_TEST');
const deferred = () => {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
};
const settled = () => new Promise(resolve => setImmediate(resolve));
const presentation = status => ({ generation: crypto.randomUUID(), continuationStatus: status,
  continuationId: crypto.randomUUID(), continuationRevision: 1, continuationReason: null, task: { id: crypto.randomUUID(),
    title: 'Acceptance fixture', goal: 'Observe a public page', status: 'WAITING_CHATGPT',
    version: 1, instructionRevision: 1, browser: null, request: null, result: null } });
const show = value => app.ontoolresult({ structuredContent: value });

const claim = deferred(), messages = [], reports = [];
const first = presentation('PENDING'), replacement = presentation('IDLE');
call = request => {
  if (request.name === 'widget.claim') return claim.promise;
  reports.push(request);
  return Promise.resolve({ structuredContent: replacement });
};
send = message => { messages.push(message); return Promise.resolve({}); };
show(first);
show(replacement);
claim.resolve({ content: [{ type: 'text', text: '{"claimed":true}' }] });
await settled();
assert.equal(messages.length, 0, 'A late claim must not send a message about the replacement task');
assert.equal(reports.length, 0, 'A late claim must not report continuation on the replacement binding');

const sending = deferred(), next = presentation('PENDING'), last = presentation('IDLE');
call = request => {
  if (request.name === 'widget.claim') return Promise.resolve({ content: [{ type: 'text', text: '{"claimed":true}' }] });
  reports.push(request);
  return Promise.resolve({ structuredContent: last });
};
send = message => { messages.push(message); return sending.promise; };
show(next);
await settled();
assert.equal(messages.length, 1);
assert.ok(messages[0].content[0].text.includes(next.task.id));
show(last);
sending.resolve({});
await settled();
assert.equal(reports.length, 0, 'A late host acknowledgement must not mutate the newer binding');
assert.equal(elements.get('title').textContent, last.task.title);

// Pause and resume may retain the task, revision and widget, but create a new intent.
const oldAcknowledgement = deferred();
const oldIntent = presentation('PENDING');
const newIntent = { ...oldIntent, continuationId: crypto.randomUUID(),
  task: { ...oldIntent.task, version: 3 } };
const intentReports = [], intentClaims = [], intentMessages = [];
call = request => {
  if (request.name === 'widget.claim') {
    intentClaims.push(request.arguments);
    return Promise.resolve({ content: [{ type: 'text', text: '{"claimed":true}' }] });
  }
  intentReports.push(request.arguments);
  return Promise.resolve({ structuredContent: { ...newIntent, continuationStatus: 'MESSAGE_SENT' } });
};
send = message => {
  intentMessages.push(message);
  return intentMessages.length === 1 ? oldAcknowledgement.promise : Promise.resolve({});
};
show(oldIntent);
await settled();
show({ ...oldIntent, continuationStatus: 'IDLE', continuationId: null,
  task: { ...oldIntent.task, status: 'PAUSED', version: 2 } });
show(newIntent);
oldAcknowledgement.resolve({});
await settled();
await settled();
assert.equal(intentClaims.length, 2);
assert.equal(intentClaims[0].continuationId, oldIntent.continuationId);
assert.equal(intentClaims[1].continuationId, newIntent.continuationId);
assert.equal(intentMessages.length, 2);
assert.equal(intentReports.length, 1, 'The old acknowledgement must not report the new intent');
assert.equal(intentReports[0].continuationId, newIntent.continuationId);

const rejected = presentation('PENDING');
const rejectedReports = [];
send = () => Promise.resolve({ isError: true });
call = request => {
  if (request.name === 'widget.claim') return Promise.resolve({ content: [{ type: 'text', text: '{"claimed":true}' }] });
  rejectedReports.push(request.arguments);
  return Promise.resolve({ structuredContent: { ...rejected, continuationStatus: 'UNAVAILABLE',
    continuationReason: request.arguments.reason } });
};
show(rejected);
await settled();
assert.equal(rejectedReports.length, 1);
assert.equal(rejectedReports[0].continuationId, rejected.continuationId);
assert.equal(rejectedReports[0].sent, false);
assert.match(elements.get('state').textContent, /отклонил.*Продолжите.*исходном чате/);

const timers = new Map();
let timerSequence = 0;
globalThis.setTimeout = callback => { const id = ++timerSequence; timers.set(id, callback); return id; };
globalThis.clearTimeout = id => { timers.delete(id); };
const metadata = value => ({ publicUrl: 'https://helm.example', taskUrl: `https://helm.example/tasks/${value.task.id}`,
  eventsUrl: `https://helm.example/widget/events?ticket=${value.generation}` });
const showLive = value => app.ontoolresult({ structuredContent: value, _meta: metadata(value) });
const stale = { isError: false, structuredContent: {
  code: 'STALE_WIDGET', message: 'A newer widget is active' } };
const ticket = { content: [{ type: 'text', text: JSON.stringify({
  url: 'https://helm.example/browser/novnc/helm.html?path=browser/sessions/fixture/view?ticket=fixture',
  expiresAt: '2099-01-01T00:00:00Z' }) }] };
const retired = presentation('IDLE');
retired.task.browser = { id: crypto.randomUUID(), status: 'LIVE', privateMode: false };
const calls = [];
call = request => {
  calls.push(request);
  return Promise.resolve(request.name === 'widget.browser' ? ticket : stale);
};
showLive(retired);
elements.get('show-browser').click();
await settled();
assert.ok(elements.get('viewer').src, 'The fixture must first open an ordinary viewer');
const failedStream = sources.at(-1);
await failedStream.onerror();
assert.equal(calls.filter(value => value.name === 'widget.state').length, 1,
  'An SSE failure must check generation once through the authenticated tool');
assert.ok(failedStream.closed);
assert.equal(timers.size, 0, 'A superseded generation must not reconnect SSE or viewer');
assert.equal(elements.get('viewer').src, undefined);
assert.equal(elements.get('browser').hidden, true);
assert.equal(elements.get('refresh').disabled, true);
assert.equal(elements.get('show-browser').disabled, true);
assert.equal(elements.get('cabinet').disabled, false);
assert.match(elements.get('state').textContent, /более новый виджет/);
assert.equal(elements.get('status').textContent, 'Неактуальный виджет');
const retiredCallCount = calls.length;
const retiredMessageCount = messages.length;
elements.get('refresh').click();
elements.get('show-browser').click();
showLive({ ...retired, continuationStatus: 'PENDING' });
await failedStream.onerror();
await settled();
assert.equal(calls.length, retiredCallCount, 'Retired UI callbacks must not regain its generation');
assert.equal(messages.length, retiredMessageCount, 'Retired presentation must not send continuation');
assert.equal(timers.size, 0);

// A transient transport error on a valid generation still has bounded retries.
const restored = presentation('IDLE');
restored.task.title = 'Current presentation';
call = request => { calls.push(request); return Promise.resolve({ structuredContent: restored }); };
showLive(restored);
assert.equal(elements.get('refresh').disabled, false);
await sources.at(-1).onerror();
assert.equal(timers.size, 1, 'Current generation retains transport recovery');
const [timerId, reconnect] = timers.entries().next().value;
timers.delete(timerId);
reconnect();
assert.equal(sources.at(-1).closed, false);

// A response from the old stream cannot retire a newer presentation in the same frame.
const lateState = deferred();
const fresh = presentation('IDLE');
fresh.task.title = 'Newer presentation stays active';
call = request => {
  calls.push(request);
  return request.arguments.generation === restored.generation ? lateState.promise
    : Promise.resolve({ structuredContent: fresh });
};
const oldError = sources.at(-1).onerror();
showLive(fresh);
sources.at(-1).onopen();
lateState.resolve(stale);
await oldError;
await settled();
assert.equal(elements.get('title').textContent, fresh.task.title);
assert.equal(elements.get('refresh').disabled, false);
assert.notEqual(elements.get('status').textContent, 'Неактуальный виджет');
assert.equal(sources.at(-1).closed, false);
assert.equal(timers.size, 0);

// A viewer ticket already in flight cannot reopen a retired presentation.
const pendingTicket = deferred();
const pendingViewer = presentation('IDLE');
pendingViewer.task.browser = { id: crypto.randomUUID(), status: 'LIVE', privateMode: false };
call = request => request.name === 'widget.browser' ? pendingTicket.promise : Promise.resolve(stale);
showLive(pendingViewer);
elements.get('show-browser').click();
await sources.at(-1).onerror();
pendingTicket.resolve(ticket);
await settled();
assert.equal(elements.get('viewer').src, undefined);
assert.equal(elements.get('browser').hidden, true);
assert.equal(timers.size, 0);

const deniedViewer = presentation('IDLE');
deniedViewer.task.browser = { id: crypto.randomUUID(), status: 'LIVE', privateMode: false };
call = () => Promise.resolve({ isError: true, content: [{ type: 'text',
  text: JSON.stringify({ code: 'VIEWER_LIMIT', message: 'Два места просмотра уже заняты.' }) }] });
showLive(deniedViewer);
elements.get('show-browser').click();
await settled();
assert.equal(elements.get('viewer').src, undefined);
assert.match(elements.get('state').textContent, /Два места просмотра/);
assert.equal(elements.get('cabinet').disabled, false);
elements.get('cabinet').click();
assert.deepEqual(openedLinks, [{ url: metadata(deniedViewer).taskUrl }]);

const privateEntry = presentation('IDLE');
privateEntry.task.browser = { id: crypto.randomUUID(), status: 'LIVE', privateMode: false };
call = () => Promise.resolve(ticket);
showLive(privateEntry);
elements.get('show-browser').click();
await settled();
assert.ok(elements.get('viewer').src);
showLive({ ...privateEntry, task: { ...privateEntry.task, version: 2,
  browser: { ...privateEntry.task.browser, privateMode: true } } });
assert.equal(elements.get('viewer').src, undefined);
assert.equal(elements.get('show-browser').disabled, true);
assert.match(elements.get('state').textContent, /Защищённый вход/);
assert.equal(elements.get('cabinet').disabled, false);
await app.onteardown();
console.log('PASS widget: continuation identity, host rejection, retired generation, reconnect and viewer failure');
