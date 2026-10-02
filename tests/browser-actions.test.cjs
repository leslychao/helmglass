const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../Docs/Helm-Glass-v8.html'), 'utf8').replace(/\r\n/g, '\n');

// The standalone HTML has no module loader. Exercise its actual shared selector and renderers.
function declaration(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const firstLineEnd = source.indexOf('\n', start);
  const firstLine = source.slice(start, firstLineEnd);
  if (firstLine.endsWith('}')) return firstLine;
  for (let end = source.indexOf('\n}', firstLineEnd); end !== -1; end = source.indexOf('\n}', end + 2)) {
    const candidate = source.slice(start, end + 2);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  assert.fail(`Unterminated function ${name}`);
}

function fixture() {
  let keySequence = 0;
  const context = vm.createContext({
    URL, URLSearchParams,
    BROWSER_INSTANCE_H: 'this-window',
    BROWSER_STATES: {stale: [], disconnected: [], expired: [], paused: [], hidden: []},
    V: {browser: {}, login: {}}, U: {manual: {}, viewer: {}, signedOut: false},
    S: {connections: [{id: 'account-a', startUrl: 'https://example.com', status: 'SAVED'}], runs: []},
    route: {path: '/tasks/101', query: new URLSearchParams()},
    LIVE7: {phase: 'demo'},
    isExternal: task => task.mode === 'EXTERNAL_MCP',
    domainH: url => new URL(url).hostname,
    connectionStatus: connection => connection.status === 'NEEDS_LOGIN'
      ? ['Нужен вход', 'warning'] : ['Вход сохранён', 'success'],
    esc: value => String(value ?? '').replace(/"/g, '&quot;'),
    icon: () => '',
    btn: (label, action, icon, style, attributes) => `<button data-action="${action}" ${attributes}>${label}</button>`,
    link: (label, path) => `<a href="#${path}">${label}</a>`,
    heading: label => `<h1>${label}</h1>`,
    notice: (title, text, tone, controls = '') => `${title} ${text} ${controls}`,
    newKey: () => `test-key-${++keySequence}`,
    handleChatDemo8: () => false, handleTableAction6: () => false,
    handleSiteActionA: () => false, handleAdminActionA: async () => false,
    browserAdmissionA: () => null,
    busy: async (_button, _key, operation) => operation(),
    render: () => {}, toast: () => {},
    brand: () => '', statusBadge: () => '', runTitle: task => task.goal,
    runSummary: () => '', renderBrowser: task => `CURRENT_BROWSER:${task.continuation8.sessionId}`
  });
  vm.runInContext(source.match(/^const isFinal=.*$/m)[0], context);
  for (const name of ['browserState', 'browserVState', 'taskConnectionH', 'liveUnavailable7',
    'hasResolvedEffectH', 'hasUnknownEffectH', 'canResumeInterruptedH',
    'browserActionsH', 'widgetTaskLink8', 'renderBrowserActionH', 'connectionTaskH',
    'connectionBrowserActionH', 'connectionBadgeV', 'manualState', 'manualEntryH',
    'demoContinuityH', 'reopenDemoBrowserH', 'unknownEffectNoticeH', 'reviewUnknownEffectH',
    'handleHelmAction', 'renderWidget', 'userAction']) {
    vm.runInContext(declaration(name), context);
  }
  const task = {id: 101, version: 1, status: 'RUNNING', browser: 'available', mode: 'EXTERNAL_MCP',
    connections: ['account-a'], startUrl: 'https://example.com',
    siteAccess: {connectionId: 'account-a', state: 'AUTHENTICATED'}};
  context.S.runs.push(task);
  context.findRun = id => context.S.runs.find(candidate => candidate.id === id);
  context.persist = () => { context.savedState = JSON.stringify(context.S); };
  context.showDialog = (title, body, controls) => { context.dialog = {title, body, controls}; };
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

test('manual entry and demo scene navigation never acquire control', () => {
  const {context, task} = fixture();
  task.status = 'WAITING_USER';
  task.request = {type: 'LOGIN', connectionId: 'account-a'};
  context.route.path = '/manual';
  context.route.query.set('scene', 'human');
  const ctx = {t: task, connection: context.S.connections[0], key: 'run:101'};
  const before = JSON.stringify(task);
  const state = context.manualState(ctx);
  assert.equal(state.phase, 'ready');
  const markup = context.manualEntryH(ctx, state);
  assert.match(markup, /Взять управление для входа/);
  assert.doesNotMatch(markup, /Продолжить демовход/);
  assert.equal(JSON.stringify(task), before);
  assert.equal(task.browserControl, undefined);
});

test('a stale login deep link cannot restart login after session-only completion', () => {
  const {context, task} = fixture();
  context.S.connections[0].status = 'NEEDS_LOGIN';
  const markup = context.manualEntryH(
    {t: task, connection: context.S.connections[0], key: 'run:101'}, {phase: 'ready'});
  assert.match(markup, /Вход сейчас не требуется/);
  assert.doesNotMatch(markup, /manual-start|Продолжить демовход/);
});

test('read-only capabilities hide control instead of offering a disabled takeover', () => {
  const {context, task, actions} = fixture();
  context.browserVState(task).mode = 'readonly';
  assert.equal(actions().primary, null);
  assert.equal(actions().canInput, false);
  assert.equal(actions().canPause, false);
});

test('two accounts on one site are resolved by current binding, never by first match', () => {
  const {context, task, actions} = fixture();
  context.S.connections.push({id: 'account-b', startUrl: 'https://example.com', status: 'NEEDS_LOGIN'});
  task.connections.push('account-b');
  task.status = 'WAITING_USER';
  task.request = {type: 'LOGIN', connectionId: 'account-b'};
  assert.equal(context.taskConnectionH(task).id, 'account-b');
  assert.equal(actions().authenticated, false);
  assert.equal(actions().primary.kind, 'login');
  task.request = null;
  task.siteAccess = null;
  assert.equal(context.taskConnectionH(task), null);
});

test('stale local login UI cannot retain privacy or grant input after ownership changes', () => {
  const {context, task} = fixture();
  const ctx = {t: task, connection: context.S.connections[0], key: 'run:101'};
  context.U.manual[ctx.key] = {phase: 'human'};
  context.V.login[ctx.key] = 'verified';
  task.status = 'WAITING_AGENT';
  assert.equal(context.browserState(task), 'available');
  assert.equal(context.manualState(ctx).phase, 'ready');
  assert.equal(context.V.login[ctx.key], undefined);
  assert.doesNotMatch(context.manualEntryH(ctx, context.manualState(ctx)), /manual-start/);
});

test('session-only connection status describes the live login without claiming a saved profile', () => {
  const {context, task} = fixture();
  const connection = context.S.connections[0];
  connection.status = 'NEEDS_LOGIN';
  connection.saved = false;
  assert.match(context.connectionBadgeV(connection), /Вход активен · без сохранения/);
  task.browser = 'closed';
  assert.match(context.connectionBadgeV(connection), /Нужен вход/);
});

test('reopen changes browser identity once and both views retain the task after reload', async () => {
  const {context, task} = fixture();
  task.status = 'PAUSED';
  task.browser = 'released';
  task.goal = 'Keep the confirmed result and the user clarification';
  task.steps = [{id: 'confirmed-step'}];
  task.result = {conclusion: 'Confirmed result'};
  const continuity = context.demoContinuityH(task);
  continuity.command.state = 'SUCCEEDED';
  continuity.effects = 1;
  continuity.instructionRevision = 2;
  continuity.clarifications.push({text: 'Use available items only', revision: 2});
  continuity.closeReason = 'The old browser expired';
  const previousSessionId = continuity.sessionId;
  const preserved = JSON.stringify({goal: task.goal, steps: task.steps, result: task.result,
    command: continuity.command, clarifications: continuity.clarifications});
  context.browserVState(task).history.push('https://example.com/private-form');
  context.browserVState(task).closed = true;
  context.U.viewer[task.id] = 'released';
  context.S.chatViews8 = {
    'demo-a': {taskId: task.id, notice: 'The old browser expired'},
    'demo-b': {taskId: 102, notice: 'Another task is unchanged'}
  };

  await context.handleHelmAction('h-reopen-session', {dataset: {id: String(task.id)}});
  assert.notEqual(continuity.sessionId, previousSessionId);
  assert.equal(continuity.previousSessionId, previousSessionId);
  assert.equal(continuity.browserStarts, 2);
  assert.equal(continuity.closeReason, undefined);
  assert.ok(continuity.contextResetReason);
  assert.equal(context.S.chatViews8['demo-a'].notice, continuity.contextResetReason);
  assert.equal(context.S.chatViews8['demo-b'].notice, 'Another task is unchanged');
  assert.equal(task.status, 'PAUSED');
  assert.equal(task.browser, 'available');
  assert.equal(task.siteAccess, null);
  assert.equal(task.browserControl, null);
  assert.equal(context.browserVState(task).history.length, 1);
  assert.equal(continuity.effects, 1);
  assert.equal(JSON.stringify({goal: task.goal, steps: task.steps, result: task.result,
    command: continuity.command, clarifications: continuity.clarifications}), preserved);

  await context.handleHelmAction('h-reopen-session', {dataset: {id: String(task.id)}});
  assert.equal(continuity.browserStarts, 2);
  context.S = JSON.parse(context.savedState);
  context.V.browser = {};
  context.U.viewer = {};
  const restored = context.findRun(task.id);
  assert.equal(context.browserState(restored), 'available');
  const widget = context.renderWidget(task.id);
  assert.ok(widget.includes(`CURRENT_BROWSER:${continuity.sessionId}`));
  assert.doesNotMatch(widget, /Новый браузер не создан|The old browser expired/);
});

test('a saved UNKNOWN command cannot be bypassed by paused state or a reopen action', async () => {
  const {context, task, actions} = fixture();
  task.status = 'PAUSED';
  task.browser = 'released';
  context.U.viewer[task.id] = 'released';
  context.demoContinuityH(task).command.state = 'UNKNOWN';
  assert.equal(actions().primary, null);
  const before = JSON.stringify(task);
  await context.handleHelmAction('h-reopen-session', {dataset: {id: String(task.id)}});
  assert.equal(JSON.stringify(task), before);
});

test('reopen rechecks admission after a pending request loses its capacity', async () => {
  const {context, task} = fixture();
  task.status = 'PAUSED';
  task.browser = 'released';
  context.U.viewer[task.id] = 'released';
  context.busy = async (_button, _key, operation) => {
    context.browserAdmissionA = () => 'Capacity exhausted';
    operation();
  };
  await context.handleHelmAction('h-reopen-session', {dataset: {id: String(task.id)}});
  assert.equal(task.browser, 'released');
  assert.equal(task.continuation8, undefined);
});

test('reopen rechecks task state after the pending UI operation', async () => {
  const {context, task} = fixture();
  task.status = 'PAUSED';
  task.browser = 'released';
  context.U.viewer[task.id] = 'released';
  context.busy = async (_button, _key, operation) => {
    context.S.runs = [{...task, status: 'CANCELLED'}];
    return operation();
  };
  await context.handleHelmAction('h-reopen-session', {dataset: {id: String(task.id)}});
  assert.equal(context.findRun(task.id).status, 'CANCELLED');
  assert.equal(context.findRun(task.id).browser, 'released');
  assert.equal(task.continuation8, undefined);
  assert.equal(context.S.browserOwner, undefined);
});

test('resume waits for ChatGPT and cannot bypass a known or newly discovered unknown effect', async () => {
  for (const failure of ['none', 'known', 'during-request']) {
    const {context, task, actions} = fixture();
    task.status = 'PAUSED';
    if (failure === 'known') {
      context.demoContinuityH(task).command.state = 'UNKNOWN';
      assert.equal(actions().canPause, false);
    }
    if (failure === 'during-request') context.busy = async (_button, _key, operation) => {
      task.unknownEffect = true;
      operation();
    };
    await context.handleHelmAction('v-pause', {dataset: {id: String(task.id)}});
    assert.equal(task.status, failure === 'none' ? 'WAITING_AGENT' : 'PAUSED');
  }
});

test('a delayed pause cannot become resume after another window already paused the task', async () => {
  const {context, task} = fixture();
  context.busy = async (_button, _key, operation) => {
    task.status = 'PAUSED';
    task.version++;
    operation();
  };
  await context.handleHelmAction('v-pause', {dataset: {id: String(task.id)}});
  assert.equal(task.status, 'PAUSED');
  assert.equal(task.version, 2);
});

test('unknown-result UI claims progress only for an accepted reconciliation operation', () => {
  const {context, task} = fixture();
  task.status = 'INTERRUPTED';
  task.error = 'Confirmation was lost';
  task.reconciliation = {state: 'RUNNING'};
  assert.match(context.userAction(task), /Результат действия неизвестен/);
  assert.match(context.userAction(task), /data-action="h-review-effect"/);
  task.reconciliation.operationId = 'accepted-reconciliation';
  assert.match(context.userAction(task), /Проверяем результат действия/);
  task.reconciliation.state = 'NEEDS_ATTENTION';
  assert.match(context.userAction(task), /Результат действия неизвестен/);
});

test('reviewing an unknown result cannot resolve it or repeat the action', async () => {
  const {context, task} = fixture();
  task.status = 'INTERRUPTED';
  task.browser = 'released';
  context.demoContinuityH(task).command.state = 'UNKNOWN';
  const before = JSON.stringify(context.S);
  await context.handleHelmAction('h-review-effect', {dataset: {id: String(task.id)}});
  assert.equal(JSON.stringify(context.S), before);
  assert.match(context.dialog.body, /проверка сайта не подключена/);
  assert.doesNotMatch(context.dialog.controls, /reopen|resume|demo-command/);
});

test('resolved interruption resumes the same task without repeating its action or resetting usage', async () => {
  for (const effect of ['APPLIED', 'NOT_APPLIED']) {
    const {context, task, actions} = fixture();
    task.status = 'INTERRUPTED';
    task.unknownEffect = true;
    task.browserSec = 127;
    task.goal = 'Read the instruction and answer the audio questions';
    task.result = {conclusion: 'Existing partial result'};
    task.steps = [{id: 'original-event', state: 'unknown'}];
    const continuity = context.demoContinuityH(task);
    continuity.command.state = 'UNKNOWN';
    task.reconciliation = {resolutionId: 'verified-result', sourceCommandId: continuity.command.id, effect};
    const original = JSON.stringify({command: continuity.command, result: task.result});
    assert.equal(actions().primary.kind, 'resume');
    assert.equal(actions(true).primary, null);
    await context.handleHelmAction('h-resume-task', {dataset: {id: String(task.id)}});
    await context.handleHelmAction('h-resume-task', {dataset: {id: String(task.id)}});
    assert.equal(context.S.runs.length, 1);
    assert.equal(context.S.runs[0], task);
    assert.equal(task.id, 101);
    assert.equal(task.status, 'WAITING_AGENT');
    assert.equal(task.browserSec, 127);
    assert.equal(task.goal, 'Read the instruction and answer the audio questions');
    assert.equal(continuity.browserStarts, 1);
    assert.equal(task.steps.length, 2);
    assert.equal(task.steps[0].id, 'original-event');
    assert.equal(JSON.stringify({command: continuity.command, result: task.result}), original);
  }
});

test('interrupted resume rejects unrelated evidence and a stop arriving during the request', async () => {
  for (const failure of ['unrelated', 'unresolved', 'stop', 'signed-out', 'readonly']) {
    const {context, task, actions} = fixture();
    task.status = 'INTERRUPTED';
    const continuity = context.demoContinuityH(task);
    continuity.command.state = 'UNKNOWN';
    task.reconciliation = {resolutionId: 'verified-result', sourceCommandId: continuity.command.id, effect: 'APPLIED'};
    if (failure === 'unrelated') task.reconciliation.sourceCommandId = 'another-command';
    if (failure === 'unresolved') task.reconciliation.effect = 'UNRESOLVED';
    if (failure === 'signed-out') context.U.signedOut = true;
    if (failure === 'readonly') context.browserVState(task).mode = 'readonly';
    if (failure === 'stop') context.busy = async (_button, _key, operation) => {
      task.cancelRequestedAt = '2026-10-03T00:00:00Z';
      operation();
    };
    else assert.equal(actions().primary, null);
    await context.handleHelmAction('h-resume-task', {dataset: {id: String(task.id)}});
    assert.equal(task.status, 'INTERRUPTED');
    assert.equal(continuity.command.state, 'UNKNOWN');
    assert.equal(continuity.browserStarts, 1);
  }
});

test('explicit interrupted recovery opens one new session on the existing task and retains the warning', async () => {
  const {context, task, actions} = fixture();
  task.status = 'INTERRUPTED';
  task.browser = 'released';
  const continuity = context.demoContinuityH(task);
  const oldSession = continuity.sessionId;
  continuity.command.state = 'UNKNOWN';
  task.reconciliation = {resolutionId: 'verified-result', sourceCommandId: continuity.command.id, effect: 'APPLIED'};
  assert.match(context.userAction(task), /прежние вкладки и поля формы потеряны/);
  assert.equal(actions().primary.label, 'Продолжить с новым браузером');
  await context.handleHelmAction('h-resume-task', {dataset: {id: String(task.id)}});
  await context.handleHelmAction('h-resume-task', {dataset: {id: String(task.id)}});
  assert.equal(context.S.runs.length, 1);
  assert.equal(task.status, 'WAITING_AGENT');
  assert.notEqual(continuity.sessionId, oldSession);
  assert.equal(continuity.browserStarts, 2);
  assert.equal(continuity.command.state, 'UNKNOWN');
});
