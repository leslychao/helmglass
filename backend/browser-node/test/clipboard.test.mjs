import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const env = await readFile(process.env.HELM_TEST_ENV ?? 'deploy/.env.dev', 'utf8');
const origin = process.env.PUBLIC_URL ?? env.match(/^PUBLIC_URL=(.+)$/m)[1].trim();
const client = await (await fetch(origin + '/browser/novnc/helm-viewer.js')).text();
const rfbSource = await (await fetch(origin + '/browser/novnc/core/rfb.js?helmClipboard=1')).text();
const source = client.replace(/^import RFB,.*$/m, 'const CLIPBOARD_TEXT_LIMIT = 262144;')
  .replace('export function startViewer', 'function startViewer') + '\nstartViewer(location.origin);';

function fixture(t, viewOnly = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map(), connections = [], reports = [], keys = [], writes = [];
  const canvas = { tagName: 'CANVAS', width: 1440, height: 900 };
  const url = new URL(origin + '/browser/novnc/helm.html?viewerEpoch=7&view_only=' + Number(viewOnly));
  url.searchParams.set('path', 'browser/sessions/fixture/view?ticket=fixture');
  const RFB = class extends EventTarget {
    constructor() { super(); connections.push(this); }
    sendKey(key, code, down) { keys.push({ key, code, down }); }
    clipboardPasteFrom(text) { this.sent = text; }
    disconnect() { this.dispatchEvent(new Event('disconnect')); }
    focus() {}
  };
  const clipboard = { readText: async () => 'Привет 🌍\nстрока', writeText: async text => writes.push(text) };
  const document = { querySelector: () => canvas, getElementById: () => ({}),
    addEventListener: (type, handler) => {
      const group = listeners.get(type) ?? [];
      group.push(handler); listeners.set(type, group);
    } };
  const window = { location: url, parent: { postMessage: data => reports.push(data) },
    addEventListener: (type, handler) => listeners.set('window:' + type, [handler]) };
  vm.runInNewContext(source, { RFB, document, window, location: url, URL, TextEncoder,
    AbortController, setTimeout, clearTimeout, navigator: { clipboard },
    MutationObserver: class { observe() {} disconnect() {} } });
  const connection = connections[0];
  connection.dispatchEvent(new Event('connect'));
  const message = (data, overrides = {}) => listeners.get('window:message')[0]({
    source: window.parent, origin, data, ...overrides });
  const key = (code, overrides = {}) => {
    const event = { isTrusted: true, code, ctrlKey: true, target: canvas,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...overrides };
    listeners.get('keydown')[0](event);
    return event;
  };
  const received = text => connection.dispatchEvent(new CustomEvent('clipboard', { detail: { text } }));
  const sent = () => connection.dispatchEvent(new Event('clipboardsent'));
  t.after(() => connection.disconnect());
  return { clipboard, reports, connection, message, key, received, sent, writes, keys, connections };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('Unicode paste waits for Provide, sends one Ctrl+V, and accepts subsequent paste', async t => {
  const f = fixture(t);
  assert.ok(f.key('KeyV').prevented);
  await settle();
  assert.equal(f.connection.sent, 'Привет 🌍\nстрока');
  assert.equal(f.keys.length, 0);
  f.key('KeyV', { repeat: true });
  f.sent(); await settle();
  assert.equal(f.keys.filter(key => key.code === 'KeyV').length, 1);
  f.clipboard.readText = async () => 'Второй текст';
  f.key('KeyV'); await settle(); f.sent(); await settle();
  assert.equal(f.connection.sent, 'Второй текст');
  assert.equal(f.keys.filter(key => key.code === 'KeyV').length, 2);
});
test('only explicit copy writes local clipboard, including repeated identical copies', async t => {
  const f = fixture(t);
  f.received('Фоновый текст'); await settle();
  assert.deepEqual(f.writes, []);
  for (let i = 0; i < 2; i++) {
    f.key('KeyC'); f.received('Одинаково 🌍\nстрока'); await settle();
  }
  assert.deepEqual(f.writes, ['Одинаково 🌍\nстрока', 'Одинаково 🌍\nстрока']);
});
test('read and write denial expose manual transfer without false success', async t => {
  const f = fixture(t);
  f.clipboard.readText = async () => { throw Error('denied'); };
  f.key('KeyV'); await settle();
  assert.equal(f.keys.length, 0);
  assert.ok(f.reports.some(report => report.manual && report.error.includes('Вставьте')));
  f.clipboard.writeText = async () => { throw Error('denied'); };
  f.key('KeyC'); f.received('Ручное копирование'); await settle();
  assert.ok(f.reports.some(report => report.text === 'Ручное копирование'));
  assert.ok(f.reports.some(report => report.manual && report.error.includes('Скопируйте')));
});
test('UTF-8 boundary is accepted; one byte over and NUL are rejected without paste', async t => {
  const f = fixture(t);
  const boundary = 'я'.repeat(131072);
  const accepted = f.message({ type: 'helm-viewer-paste', viewerEpoch: '7', text: boundary });
  assert.equal(f.connection.sent, boundary);
  f.sent(); await accepted;
  const before = f.keys.length;
  for (const text of [boundary + 'a', 'a\0b'])
    await f.message({ type: 'helm-viewer-paste', viewerEpoch: '7', text });
  assert.equal(f.keys.length, before);
  assert.ok(f.reports.some(report => report.error?.includes('256')));
});
test('timeout releases an unresolved permission prompt and suppresses its late paste', async t => {
  const f = fixture(t);
  let resolve;
  f.clipboard.readText = () => new Promise(done => resolve = done);
  f.key('KeyV');
  t.mock.timers.tick(5000); await settle();
  assert.ok(f.reports.some(report => report.error?.includes('пять секунд')));
  resolve('Поздний текст'); await settle(); f.sent(); await settle();
  assert.equal(f.keys.length, 0);
  assert.equal(f.connection.sent, undefined);
});
test('disconnect cancels pending copy and stale messages cannot paste', async t => {
  const f = fixture(t);
  f.key('KeyC'); f.connection.disconnect(); f.received('Секрет'); await settle();
  assert.deepEqual(f.writes, []);
  await f.message({ type: 'helm-viewer-paste', viewerEpoch: '6', text: 'old' });
  await f.message({ type: 'helm-viewer-paste', viewerEpoch: '7', text: 'foreign' }, { origin: 'https://foreign.example' });
  assert.equal(f.connection.sent, undefined);
});
test('VIEWER and shortcuts outside the canvas cannot exchange clipboard', async t => {
  const f = fixture(t, true);
  assert.equal(f.key('KeyV').prevented, undefined);
  await f.message({ type: 'helm-viewer-paste', viewerEpoch: '7', text: 'denied' });
  f.received('Секрет'); await settle();
  assert.equal(f.connection.sent, undefined);
  assert.ok(!f.reports.some(report => report.state === 'clipboard'));
  f.connection.viewOnly = false;
  assert.equal(f.key('KeyV', { target: { tagName: 'TEXTAREA' } }).prevented, undefined);
});
test('published noVNC rejects unsupported Unicode transport and oversize before sending', () => {
  const a = rfbSource.indexOf('    clipboardPasteFrom(text) {');
  const b = rfbSource.indexOf('    getImageData() {', a);
  const fn = vm.runInNewContext('(' + rfbSource.slice(a, b).replace('clipboardPasteFrom(text)', 'function paste(text)') + ')', {
    RFB: { messages: { extendedClipboardNotify() { sends++; } } }, CLIPBOARD_TEXT_LIMIT: 262144,
    TextEncoder, CustomEvent, extendedClipboardFormatText: 1, extendedClipboardActionNotify: 1 << 27,
  });
  let sends = 0;
  const events = [];
  const connection = { _rfbConnectionState: 'connected', _viewOnly: false,
    _clipboardServerCapabilitiesFormats: {}, _clipboardServerCapabilitiesActions: {},
    dispatchEvent: event => events.push(event.type) };
  fn.call(connection, 'Привет 🌍');
  assert.deepEqual(events, ['clipboarderror']);
  connection._clipboardServerCapabilitiesFormats[1] = true;
  connection._clipboardServerCapabilitiesActions[1 << 27] = true;
  fn.call(connection, 'я'.repeat(131072));
  assert.equal(sends, 1);
  fn.call(connection, 'я'.repeat(131072) + 'a');
  assert.equal(sends, 1);
  assert.equal(events.length, 2);
});
