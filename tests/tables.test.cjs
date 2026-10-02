const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../Docs/Helm-Glass-v8.html'), 'utf8').replace(/\r\n/g, '\n');

// Run the shared table owner from the standalone prototype, including its transport.
function declaration(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const lineEnd = source.indexOf('\n', start);
  if (source.slice(start, lineEnd).endsWith('}')) return source.slice(start, lineEnd);
  return source.slice(start, source.indexOf('\n}', lineEnd) + 2);
}

function fixture(path = '/tasks') {
  let sequence = 0;
  const rows = [
    {id: '3', name: 'Бета', updated: 30},
    {id: '2', name: 'Альфа', updated: 10},
    {id: '1', name: 'Гамма', updated: 20}
  ];
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, DOMException,
    TABLE6: {states: new Map(), specs: new Map(), snapshots: new Map(), requests: [], navigation: 0, revision: 0},
    TABLE_API6: {mode: 'demo', base: '/api'},
    collator6: new Intl.Collator('ru', {numeric: true, sensitivity: 'base'}),
    route: {path, query: new URLSearchParams()},
    history: {state: {preserved: true}, replaceState(state, _title, url) { this.url = url; this.state = state; }},
    location: {origin: 'http://localhost', hash: '#' + path},
    document: {baseURI: 'http://localhost/'}, lastRoute: '',
    clone: structuredClone, esc: String, newKey: () => `snapshot-${++sequence}`,
    scheduleTables6() {}, gridMarkup6: () => '', rememberBreadcrumbList8() {}, loadGrid6() {},
    setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout() {},
    demoDataset6: () => ({rows, fields: {name: row => row.name, updated: row => row.updated}, id: row => row.id})
  });
  for (const name of ['tableState6', 'gridMount6', 'tableEndpoint6', 'queryUrl6', 'requestPage6',
    'syncGridUrl6', 'gridHeader6', 'handleTableAction6', 'compareValue6', 'demoPage6']) {
    vm.runInContext(declaration(name), context);
  }
  const spec = {resource: 'tasks', columns: [{key: 'name', label: 'Название'}, {key: 'updated', label: 'Обновлено'}],
    defaultSort: {field: 'updated', direction: 'desc'}, pageSize: 10};
  context.gridMount6('tasks', spec);
  const state = context.TABLE6.states.get('tasks');
  return {context, spec, state,
    click: (field = 'name') => context.handleTableAction6('g6-sort', {dataset: {grid: 'tasks', field}}),
    request: () => ({resource: 'tasks', filters: {query: 'retained'}, context: {}, page: state.page,
      pageSize: state.size, sort: state.sort, snapshot: state.snapshot})};
}

test('every sortable column cycles ascending, descending, then no sort', () => {
  const {context, state, click} = fixture();
  assert.equal(state.sort, null);
  for (const field of ['name', 'updated']) {
    for (const direction of ['asc', 'desc', null]) {
      state.page = 3;
      state.snapshot = 'old-selection';
      click(field);
      assert.equal(state.sort?.direction ?? null, direction);
      assert.equal(state.sort?.field ?? null, direction ? field : null);
      assert.equal(state.page, 1);
      assert.equal(state.snapshot, null);
    }
  }
  context.route.query.set('q', 'retained');
  click();
  click('updated');
  assert.equal(state.sort.direction, 'asc', 'a different column starts ascending');
  click('missing');
  assert.equal(state.sort.field, 'updated', 'unknown columns are ignored');
  assert.equal(context.route.query.get('q'), 'retained');
});

test('headers announce the next action and mark only the active column', () => {
  const {context, state, spec, click} = fixture();
  for (const [sort, label] of [['none', 'сортировать по возрастанию'], ['ascending', 'сортировать по убыванию'],
    ['descending', 'сбросить сортировку'], ['none', 'сортировать по возрастанию']]) {
    const markup = context.gridHeader6('tasks', spec.columns[0]);
    assert.match(markup, new RegExp(`aria-sort="${sort}"`));
    assert.match(markup, new RegExp(`aria-label="Название: ${label}"`));
    assert.match(context.gridHeader6('tasks', spec.columns[1]), /aria-sort="none"/);
    click();
  }
  assert.equal(state.sort.direction, 'asc');
});

test('clearing sort removes both URL parameters and survives navigation or reload', () => {
  const {context, spec, click, state, request} = fixture();
  context.route.query.set('q', 'saved-filter');
  click(); click(); click();
  assert.equal(context.route.query.has('sort'), false);
  assert.equal(context.route.query.has('direction'), false);
  assert.equal(context.route.query.get('q'), 'saved-filter');
  const url = new URL(context.queryUrl6(context.TABLE6.specs.get('tasks'), request()), 'http://localhost');
  assert.equal(url.searchParams.has('sort'), false);
  assert.equal(url.searchParams.has('direction'), false);
  assert.equal(url.searchParams.get('query'), 'retained');
  click();
  context.route.query = new URLSearchParams('page=2&pageSize=20');
  context.TABLE6.navigation++;
  context.gridMount6('tasks', spec);
  assert.equal(state.sort, null, 'an unsorted route must clear a previously selected column');
  assert.equal(state.page, 2);
  assert.equal(state.size, 20);
  context.route.query = new URLSearchParams('sort=name&direction=desc');
  context.TABLE6.navigation++;
  context.gridMount6('tasks', spec);
  assert.equal(state.sort.direction, 'desc', 'existing sorted links remain valid');
  const reloaded = fixture();
  reloaded.context.route.query = new URLSearchParams('page=2&pageSize=20');
  reloaded.context.TABLE6.navigation++;
  reloaded.context.gridMount6('tasks', reloaded.spec);
  assert.equal(reloaded.state.sort, null);
});

test('removing the active column clears sorting without selecting another column', () => {
  const {context, spec, state, click} = fixture();
  click();
  context.gridMount6('tasks', {...spec, columns: [spec.columns[1]]});
  assert.equal(state.sort, null);
  assert.equal(state.snapshot, null);
});

test('transport returns the original order after clearing sort and sorts before pagination', async () => {
  const {context, state, click, request} = fixture();
  state.size = 2;
  const spec = context.TABLE6.specs.get('tasks');
  const read = () => context.requestPage6(spec, request(), new AbortController().signal);
  const initial = await read();
  assert.deepEqual(Array.from(initial.items, row => row.id), ['3', '1']);
  assert.equal(initial.sort, null);
  click();
  const ascending = await read();
  assert.deepEqual(Array.from(ascending.items, row => row.id), ['2', '3']);
  state.page = 2;
  state.snapshot = ascending.snapshot;
  assert.deepEqual(Array.from((await read()).items, row => row.id), ['1']);
  click();
  assert.deepEqual(Array.from((await read()).items, row => row.id), ['1', '3']);
  click();
  const cleared = await read();
  assert.deepEqual(Array.from(cleared.items, row => row.id), Array.from(initial.items, row => row.id));
  assert.equal(cleared.sort, null);
  assert.notEqual(cleared.snapshot, ascending.snapshot);
});

test('HTTP responses must confirm the requested sort, including explicit null', async () => {
  const {context, request, click} = fixture();
  context.TABLE_API6.mode = 'http';
  let sort = null;
  context.fetch = async () => ({ok: true, json: async () => ({items: [], total: 0, page: 1,
    pageSize: 10, snapshot: 'server-page', sort})});
  const read = () => context.requestPage6(context.TABLE6.specs.get('tasks'), request(), new AbortController().signal);
  assert.equal((await read()).sort, null);
  sort = {};
  await assert.rejects(read, /контракту/);
  click();
  sort = {field: 'name', direction: 'desc'};
  await assert.rejects(read, /контракту/);
  sort.direction = 'asc';
  assert.equal((await read()).sort.direction, 'asc');
});
