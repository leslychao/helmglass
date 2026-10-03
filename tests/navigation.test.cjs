const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../Docs/Helm-Glass-v8.html'), 'utf8');

// The prototype has no module loader: run the actual router and navigation owner.
function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const firstLineEnd = source.indexOf('\n', start);
  const firstLine = source.slice(start, firstLineEnd);
  return firstLine.endsWith('}') ? firstLine : source.slice(start, source.indexOf('\n}', firstLineEnd) + 2);
}

function fixture(url = '/tasks', savedHistory = null) {
  const location = new URL('http://localhost/mock.html#' + url);
  const context = vm.createContext({
    URLSearchParams, location,
    history: {state: savedHistory, replaceState(state, _unused, url) {
      this.state = state;
      location.href = new URL(url, location).href;
    }},
    BREADCRUMB_LISTS8: new Map(),
    BREADCRUMB_LIST_PATHS8: new Set(['/tasks', '/connections', '/admin/users', '/admin/audit']),
    NAVIGATION8: {url: '', trail: []},
    route: null, allowHash: false, lastRoute: '',
    H: {filters: {
      tasks: {query: '', state: [], site: [], origin: [], from: '', to: ''},
      connections: {query: '', state: [], site: [], exact: ''}
    }},
    ADMIN_VIEW_A: {query: '', states: [], auditQuery: '', auditAction: ''},
    U: {dirty: false, draft: null, formPath: ''},
    S: {connections: [{id: 'supplier'}], runs: [
      {id: 101, status: 'RUNNING', connections: ['supplier'], sessionId: 'same-browser', control: 'HUMAN'},
      {id: 102, status: 'DRAFT', connections: ['supplier']}
    ]},
    canAdminA: () => true,
    getPersonA: id => id === 'usr-001' ? {id, name: 'Admin'} : null,
    closePopover() {}, closeDialog() {}, render() {},
    icon: () => '', esc: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  });
  context.findRun = id => context.S.runs.find(task => task.id === Number(id));
  context.confirmAction = (_title, _description, _button, confirm) => { context.confirmLeave = confirm; };
  for (const name of ['cabinetRoute8', 'navigationKey8', 'isSectionRoute8', 'navigationTrail8', 'storeNavigation8',
    'syncNavigation8', 'syncListFilters8', 'restoreListFilters8', 'loadTaskFiltersH',
    'availableReturn8', 'returnPath8', 'returnLabel8', 'pageReturn8',
    'rememberBreadcrumbList8', 'breadcrumbListPath8', 'manualContext', 'parseHash', 'go']) {
    vm.runInContext(declaration(name), context);
  }
  function settle() {
    context.route = context.parseHash();
    context.syncNavigation8();
  }
  settle();
  return {context, settle, navigate(path, mode = 'forward') { context.go(path, false, mode); settle(); }};
}

test('direct links have safe parents throughout the cabinet', () => {
  const cases = [
    ['/tasks/101/result', '/tasks'], ['/tasks/999', '/tasks'],
    ['/tasks/new', '/tasks'], ['/tasks/new?draft=102', '/tasks/102'],
    ['/tasks/new?copy=101', '/tasks/101'],
    ['/connection/supplier', '/connections'], ['/connection/missing', '/connections'],
    ['/manual?run=101', '/tasks/101'], ['/manual?connection=supplier', '/connection/supplier'],
    ['/manual?run=999', '/tasks'], ['/manual?connection=missing', '/connections'],
    ['/admin/users/usr-001', '/admin/users'],
    ['/admin/audit?user=usr-001', '/admin/users/usr-001'],
    ['/profile', '/tasks'], ['/unavailable', '/tasks'], ['/not-found', '/tasks']
  ];
  for (const [url, parent] of cases) assert.equal(fixture(url).context.returnPath8(), parent, url);
  for (const url of ['/tasks', '/connections', '/usage', '/admin', '/admin/users', '/admin/browsers', '/admin/audit', '/screens']) {
    assert.equal(fixture(url).context.pageReturn8(), '', url);
  }
});

test('switching section tabs never creates a back button or a nested return trail', () => {
  const {context, navigate} = fixture('/admin');
  for (const tab of ['/admin/browsers', '/admin', '/admin/browsers', '/tasks', '/connections', '/usage']) {
    navigate(tab);
    assert.equal(context.pageReturn8(), '', tab);
    assert.equal(context.NAVIGATION8.trail.length, 0, tab);
    const reload = fixture(tab, structuredClone(context.history.state));
    assert.equal(reload.context.pageReturn8(), '', tab + ' after reload');
  }
});

test('drilling into a user returns through the user journal to the originating browser tab', () => {
  const {context, navigate} = fixture('/admin');
  navigate('/admin/browsers');
  navigate('/admin/users/usr-001');
  assert.equal(context.returnPath8(), '/admin/browsers');
  assert.match(context.pageReturn8(), /К браузерам/);
  navigate('/admin/audit?user=usr-001');
  assert.equal(context.returnPath8(), '/admin/users/usr-001');
  navigate(context.returnPath8());
  assert.equal(context.returnPath8(), '/admin/browsers');
  navigate(context.returnPath8());
  assert.equal(context.pageReturn8(), '');
});

test('old section history cannot restore a back button after reloading a tab', () => {
  const {context, navigate} = fixture('/admin/browsers', {
    helmNavigation8: {key: '/admin/browsers', trail: ['/admin', '/admin/users/usr-001'], lists: []}
  });
  assert.equal(context.pageReturn8(), '');
  navigate('/admin/users/usr-001');
  assert.equal(context.returnPath8(), '/admin/browsers');
  navigate(context.returnPath8());
  assert.equal(context.NAVIGATION8.trail.length, 0);
});

test('task tabs and manual login return to the originating filtered and sorted list', () => {
  const list = '/tasks?search=report&page=3&pageSize=20&sort=title&direction=asc';
  const {context, navigate} = fixture(list);
  const before = JSON.stringify(context.S);
  navigate('/tasks/101/overview');
  navigate('/tasks/101/result');
  assert.equal(context.returnPath8(), list);
  navigate('/manual?run=101');
  assert.equal(context.returnPath8(), '/tasks/101/result');
  navigate(context.returnPath8());
  assert.equal(context.returnPath8(), list);
  navigate(context.returnPath8());
  assert.equal(context.location.hash, '#' + list);
  assert.equal(context.pageReturn8(), '');
  assert.equal(JSON.stringify(context.S), before, 'navigation must not change the task or browser');
});

test('a task opened from a connection returns to that connection without a cycle', () => {
  const {context, navigate} = fixture('/connections?search=supplier&page=2');
  navigate('/connection/supplier');
  navigate('/tasks/101');
  assert.equal(context.returnLabel8(context.returnPath8()), 'К подключению');
  navigate(context.returnPath8());
  assert.equal(context.returnPath8(), '/connections?search=supplier&page=2');
});

test('nested admin journal returns through user and list with its query', () => {
  const {context, navigate} = fixture('/admin/users?search=admin&page=2&state=ACTIVE');
  navigate('/admin/users/usr-001');
  navigate('/admin/audit?user=usr-001');
  assert.equal(context.returnPath8(), '/admin/users/usr-001');
  navigate(context.returnPath8());
  assert.equal(context.returnPath8(), '/admin/users?search=admin&page=2&state=ACTIVE');
});

test('profile and demo scenarios return to their actual origin; sidebar starts a section', () => {
  const {context, navigate} = fixture('/screens');
  navigate('/tasks/101?view=stale');
  navigate('/profile');
  assert.equal(context.returnPath8(), '/tasks/101?view=stale');
  navigate(context.returnPath8());
  assert.equal(context.returnPath8(), '/screens');
  navigate('/connections', 'section');
  assert.equal(context.pageReturn8(), '');
});

test('return from profile to manual login preserves the same task and control', () => {
  const {context, navigate} = fixture('/manual?run=101');
  const before = JSON.stringify(context.S);
  navigate('/profile');
  assert.equal(context.returnPath8(), '/manual?run=101');
  assert.equal(context.returnLabel8(context.returnPath8()), 'К входу на сайт');
  navigate(context.returnPath8());
  assert.equal(context.returnPath8(), '/tasks/101');
  assert.equal(JSON.stringify(context.S), before);
});

test('reload and browser history restore the entry context and breadcrumb filters', () => {
  const list = '/tasks?search=report&page=2&pageSize=10&sort=title&direction=asc';
  const {context, navigate, settle} = fixture(list, {unrelated: 'preserved'});
  navigate('/tasks/101');
  const taskEntry = structuredClone(context.history.state);
  navigate('/profile');
  const reloaded = fixture('/profile', structuredClone(context.history.state));
  assert.equal(reloaded.context.returnPath8(), '/tasks/101');
  reloaded.navigate(reloaded.context.returnPath8());
  assert.equal(reloaded.context.returnPath8(), list);
  assert.equal(reloaded.context.breadcrumbListPath8('/tasks'), list);
  // A native Back event has already selected its history entry before the router runs.
  context.location.hash = '#/tasks/101';
  context.history.state = taskEntry;
  settle();
  assert.equal(context.returnPath8(), list);
  assert.equal(context.history.state.unrelated, 'preserved');
});

test('unsafe history values, removed objects and revoked admin access are not return targets', () => {
  const saved = {helmNavigation8: {key: '/profile', trail: [
    '/tasks', 'https://example.com', '//example.com', '/tasks/999', '/admin/users/usr-001'
  ], lists: [['/tasks', '//example.com']]}};
  const {context} = fixture('/profile', saved);
  context.canAdminA = () => false;
  assert.equal(context.returnPath8(), '/tasks');
  assert.equal(context.breadcrumbListPath8('/tasks'), '/tasks');
  for (const path of ['javascript:alert(1)', '/\\example.com', '/tasks#foreign', '/tasks\n', null]) {
    assert.equal(context.cabinetRoute8(path), null);
  }
});

test('dirty form keeps its origin until discard is confirmed, then returns exactly there', () => {
  const {context, navigate, settle} = fixture('/tasks?search=draft&page=2');
  navigate('/tasks/new');
  context.U.dirty = true;
  context.U.draft = {goal: 'unsaved'};
  const before = JSON.stringify(context.history.state);
  context.go(context.returnPath8());
  assert.equal(context.location.hash, '#/tasks/new');
  assert.equal(context.U.draft.goal, 'unsaved');
  assert.equal(JSON.stringify(context.history.state), before);
  context.confirmLeave();
  settle();
  assert.equal(context.location.hash, '#/tasks?search=draft&page=2');
  assert.equal(context.U.dirty, false);
  assert.equal(context.U.draft, null);
});

test('saving a form does not offer a return that creates another new task', () => {
  const {context, navigate} = fixture('/tasks?page=2');
  navigate('/tasks/new');
  navigate('/tasks/101');
  assert.equal(context.returnPath8(), '/tasks?page=2');
  assert.equal(context.NAVIGATION8.trail.includes('/tasks/new'), false);
});

test('return context is bounded and excludes an external page on a direct entry', () => {
  const {context} = fixture('/tasks/101');
  const trail = Array.from({length: 40}, (_, id) => '/tasks/' + id);
  assert.equal(context.navigationTrail8('/usage', trail, '/profile').length, 16);
  assert.deepEqual(Array.from(context.navigationTrail8('https://example.com', [], '/profile')), []);
});

test('connection and administrative filters survive a detail reload through real filter models', () => {
  const cases = [
    ['/connections', '/connection/supplier', {query: 'supplier', state: ['SAVED'], site: ['supplier.example'], exact: ''},
      context => context.H.filters.connections],
    ['/admin/users', '/admin/users/usr-001', {query: 'admin', states: ['ACTIVE']},
      context => ({query: context.ADMIN_VIEW_A.query, states: context.ADMIN_VIEW_A.states})],
    ['/admin/audit', '/admin/users/usr-001', {query: 'reason', action: 'QUOTAS'},
      context => ({query: context.ADMIN_VIEW_A.auditQuery, action: context.ADMIN_VIEW_A.auditAction})]
  ];
  for (const [list, detail, filters, restored] of cases) {
    const {context, navigate} = fixture(list);
    context.syncListFilters8(filters);
    navigate(detail);
    const reload = fixture(detail, structuredClone(context.history.state));
    reload.navigate(reload.context.returnPath8());
    assert.deepEqual(JSON.parse(JSON.stringify(restored(reload.context))), filters, list);
    assert.equal(reload.context.location.hash.includes('q='), true, list);
  }
});

test('unfiltered list returns clear previous filters rather than silently retaining another view', () => {
  const {context} = fixture('/tasks');
  context.H.filters.tasks = {query: 'stale', state: ['FAILED'], site: ['old.example'], origin: ['MCP'], from: '2026-01-01', to: ''};
  context.loadTaskFiltersH();
  assert.equal(context.H.filters.tasks.query, '');
  assert.equal(context.H.filters.tasks.state.length, 0);
  assert.equal(context.H.filters.tasks.site.length, 0);
  assert.equal(context.H.filters.tasks.origin.length, 0);
  assert.equal(context.H.filters.tasks.from, '');
});
