const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../Docs/Helm-Glass-v8.html'), 'utf8');

// The standalone HTML has no module loader. Exercise its actual shared selector and renderers.
function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const firstLineEnd = source.indexOf('\n', start);
  const firstLine = source.slice(start, firstLineEnd);
  if (firstLine.endsWith('}')) return firstLine;
  const end = source.indexOf('\n}', firstLineEnd);
  return source.slice(start, end + 2);
}

function fixture() {
  const context = vm.createContext({
    URL, URLSearchParams,
    BROWSER_INSTANCE_H: 'this-window',
    BROWSER_STATES: {stale: [], disconnected: [], expired: [], paused: [], hidden: []},
    V: {browser: {}}, U: {manual: {}, viewer: {}, signedOut: false},
    S: {connections: [{id: 'account-a', startUrl: 'https://example.com', status: 'SAVED'}], runs: []},
    route: {path: '/tasks/101', query: new URLSearchParams()},
    LIVE7: {phase: 'demo'},
    isFinal: task => ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status),
    domainH: url => new URL(url).hostname,
    esc: value => String(value ?? '').replace(/"/g, '&quot;'),
    icon: () => '',
    btn: (label, action, icon, style, attributes) => `<button data-action="${action}" ${attributes}>${label}</button>`,
    link: (label, path) => `<a href="#${path}">${label}</a>`
  });
  for (const name of ['browserState', 'browserVState', 'taskConnectionH', 'liveUnavailable7',
    'browserActionsH', 'widgetTaskLink8', 'renderBrowserActionH', 'connectionBrowserActionH']) {
    vm.runInContext(declaration(name), context);
  }
  const task = {id: 101, version: 1, status: 'RUNNING', browser: 'available',
    connections: ['account-a'], startUrl: 'https://example.com',
    siteAccess: {connectionId: 'account-a', state: 'AUTHENTICATED'}};
  context.S.runs.push(task);
  return {context, task, actions: widget => context.browserActionsH(task, !!widget)};
}

test('all inline scripts remain valid JavaScript', () => {
  for (const [, script] of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script);
});

test('healthy and session-only access offer takeover, with no redundant login', () => {
  const {context, actions} = fixture();
  for (const status of ['SAVED', 'NEEDS_LOGIN']) {
    context.S.connections[0].status = status;
    assert.equal(actions().authenticated, true);
    assert.equal(actions().primary.kind, 'take');
  }
});

test('saved, unknown, asserted and public access do not manufacture a login requirement', () => {
  const {context, task, actions} = fixture();
  for (const state of ['UNKNOWN', 'USER_ASSERTED', 'ANONYMOUS']) {
    task.siteAccess.state = state;
    assert.equal(actions().authenticated, false);
    assert.equal(actions().primary.kind, 'take');
  }
  task.connections = [];
  assert.equal(actions().primary.kind, 'take');
  assert.equal(context.S.connections[0].status, 'SAVED');
});

test('a current login request takes priority over old authenticated evidence', () => {
  const {task, actions} = fixture();
  task.status = 'WAITING_USER';
  task.request = {type: 'LOGIN', connectionId: 'account-a'};
  assert.equal(actions().primary.kind, 'login');
  assert.equal(actions().canPause, false);
  task.siteAccess.connectionId = 'another-account';
  assert.equal(actions().authenticated, false);
  assert.equal(actions().primary.label, 'Войти на сайт');
});

test('widget actions navigate to the same task without a control mutation', () => {
  const {context, task, actions} = fixture();
  const before = JSON.stringify(task);
  let markup = context.renderBrowserActionH(task, actions(true));
  assert.match(markup, /href="#\/tasks\/101"/);
  assert.match(markup, /target="_blank"/);
  assert.doesNotMatch(markup, /data-action|manual\?/);
  assert.equal(JSON.stringify(task), before);
  task.status = 'WAITING_USER';
  task.request = {type: 'LOGIN'};
  markup = context.renderBrowserActionH(task, actions(true));
  assert.match(markup, /Войти на сайт/);
  assert.match(markup, /href="#\/tasks\/101"/);
  assert.doesNotMatch(markup, /data-action|manual\?/);
});

test('human input and release belong only to the current web instance', () => {
  const {context, task, actions} = fixture();
  task.status = 'PAUSED';
  task.browserControl = {instanceId: 'this-window', mode: 'manual', purpose: 'manual'};
  assert.equal(actions().primary.kind, 'release');
  assert.equal(actions().canInput, true);
  assert.equal(actions().canPause, false);
  context.route.path = '/widget/101';
  assert.equal(context.browserState(task), 'hidden');
  assert.equal(actions(true).primary, null);
  assert.equal(actions(true).canInput, false);
  context.route.path = '/tasks/101';
  task.browserControl.instanceId = 'other-window';
  assert.equal(context.browserState(task), 'hidden');
  assert.equal(actions().primary.kind, 'transfer');
  assert.equal(actions().canInput, false);
});

test('transfers have one disabled progress action and never enable input', () => {
  const {task, actions} = fixture();
  for (const mode of ['taking', 'returning']) {
    task.browserControl = {instanceId: 'this-window', mode};
    const result = actions();
    assert.equal(result.primary.kind, 'progress');
    assert.equal(result.primary.disabled, true);
    assert.ok(result.primary.reason);
    assert.equal(result.canInput, false);
  }
});

test('an acquired login continues the same login, without a generic release', () => {
  const {task, actions} = fixture();
  task.status = 'WAITING_USER';
  task.request = {type: 'LOGIN'};
  task.browserControl = {instanceId: 'this-window', mode: 'manual', purpose: 'login'};
  assert.equal(actions().primary.label, 'Продолжить вход');
  assert.equal(actions().canInput, false);
});

test('lost frames disable takeover but do not request a website login', () => {
  const {context, actions} = fixture();
  for (const state of ['stale', 'disconnected', 'expired', 'paused']) {
    context.U.viewer[101] = state;
    const result = actions();
    assert.equal(result.primary.kind, 'take');
    assert.equal(result.primary.disabled, true);
    assert.ok(result.primary.reason);
    assert.equal(result.loginRequired, false);
  }
});

test('a stale image blocks input but permits release with a fresh control snapshot', () => {
  const {context, task, actions} = fixture();
  task.browserControl = {instanceId: 'this-window', mode: 'manual'};
  context.U.viewer[101] = 'stale';
  assert.equal(actions().canInput, false);
  assert.equal(actions().primary.kind, 'release');
  assert.equal(actions().primary.disabled, false);
  context.LIVE7.phase = 'reconnecting';
  assert.equal(actions().primary.disabled, true);
});

test('terminal, stopping, signed-out and unknown-effect states cannot expose control', () => {
  const {context, task, actions} = fixture();
  task.browserControl = {instanceId: 'this-window', mode: 'manual'};
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'STOPPING']) {
    task.status = status;
    assert.equal(actions().primary, null);
    assert.equal(actions().canInput, false);
    assert.equal(actions(true).primary, null);
  }
  task.status = 'RUNNING';
  task.unknownEffect = true;
  assert.equal(actions().canInput, false);
  assert.equal(actions().primary, null);
  task.unknownEffect = false;
  context.U.signedOut = true;
  assert.equal(actions().primary, null);
  assert.equal(actions().canInput, false);
});

test('no-runtime and queued states do not offer ordinary takeover', () => {
  const {task, actions} = fixture();
  task.browser = 'none';
  assert.equal(actions().primary, null);
  task.status = 'QUEUED';
  assert.equal(actions(true).primary, null);
  task.status = 'PAUSED';
  task.browser = 'released';
  assert.equal(actions().primary.kind, 'reopen');
  assert.equal(actions(true).primary, null);
});

test('connection entry uses its live task instead of starting another login browser', () => {
  const {context, task} = fixture();
  const connection = context.S.connections[0];
  connection.status = 'NEEDS_LOGIN';
  assert.match(context.connectionBrowserActionH(connection), /href="#\/tasks\/101"/);
  assert.doesNotMatch(context.connectionBrowserActionH(connection), /Войти на сайт/);
  task.browser = 'closed';
  assert.match(context.connectionBrowserActionH(connection), /Войти на сайт/);
  connection.status = 'SAVED';
  assert.doesNotMatch(context.connectionBrowserActionH(connection), /Войти на сайт/);
  connection.status = 'UNAVAILABLE';
  assert.equal(context.connectionBrowserActionH(connection), '');
});
