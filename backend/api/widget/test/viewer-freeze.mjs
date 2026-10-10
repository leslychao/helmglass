import assert from 'node:assert/strict';
import vm from 'node:vm';

const origin = 'https://helm.example';
const response = await fetch('http://127.0.0.1:8090/novnc/helm.html?parentOrigin=https://test.oaiusercontent.com');
assert.equal(response.status, 200);
const html = await response.text();
assert.ok(html.includes("startViewer(\"https://test.oaiusercontent.com\")"));
const client = await fetch('http://127.0.0.1:8090/novnc/helm-viewer.js');
assert.equal(client.status, 200);
const source = (await client.text())
  .replace(/^import RFB,.*$/m, 'const CLIPBOARD_TEXT_LIMIT = 262144;')
  .replace('export function startViewer', 'function startViewer')
  + '\nstartViewer("https://test.oaiusercontent.com");';

async function fixture(viewOnly) {
  const listeners = new Map(), connections = [], snapshots = [];
  let disconnectedObservers = 0;
  const frame = { width: 1280, height: 720,
    getBoundingClientRect: () => ({ left: 4, top: 8, width: 640, height: 360 }) };
  const document = {
    addEventListener: (type, callback) => listeners.set('document:' + type, callback),
    body: { append: snapshot => snapshots.push(snapshot) },
    getElementById: () => ({}),
    querySelector: () => frame,
    createElement: () => ({ style: {}, getContext() {
      return { drawImage: (canvas, x, y) => { this.copied = canvas; assert.equal(x + y, 0); } };
    } }),
  };
  const window = { parent: { postMessage() {} }, location: { origin },
    addEventListener: (type, callback) => listeners.set(type, callback) };
  const url = new URL(origin + '/browser/novnc/helm.html?path=browser/sessions/fixture/view?ticket=fixture&viewerEpoch=7&view_only=' + Number(viewOnly));
  window.location = url;
  const RFB = class {
    handlers = new Map(); disconnects = 0;
    constructor() { connections.push(this); }
    addEventListener(type, callback) { this.handlers.set(type, callback); }
    disconnect() { this.disconnects++; this.handlers.get('disconnect')(); }
  };
  vm.runInNewContext(source, { RFB, document, window, location: url, URL,
    MutationObserver: class { observe() {} disconnect() { disconnectedObservers++; } } });
  const message = (data, overrides = {}) => listeners.get('message')({ source: window.parent,
    origin: 'https://test.oaiusercontent.com', data, ...overrides });
  return { connections, snapshots, frame, message, observers: () => disconnectedObservers };
}

const viewer = await fixture(true);
const freeze = { type: 'helm-viewer-freeze', viewerEpoch: '7' };
await viewer.message(freeze, { origin: 'https://foreign.example' });
await viewer.message(freeze, { source: {} });
await viewer.message({ ...freeze, viewerEpoch: '6' });
assert.equal(viewer.connections[0].disconnects, 0, 'Only the bound parent and current viewer may freeze');
await viewer.message(freeze);
assert.equal(viewer.connections[0].disconnects, 1);
assert.equal(viewer.observers(), 1);
assert.equal(viewer.snapshots.length, 1);
assert.equal(viewer.snapshots[0].copied, viewer.frame, 'Freeze copies the last received frame');
assert.equal(viewer.snapshots[0].width, 1280);
assert.equal(viewer.snapshots[0].height, 720);
assert.equal(viewer.snapshots[0].style.cssText, 'position:fixed;left:4px;top:8px;width:640px;height:360px');
await viewer.message(freeze);
await viewer.message({ type: 'helm-viewer-reconnect', url: origin + '/browser/novnc/helm.html' });
assert.equal(viewer.connections.length, 1, 'A frozen viewer cannot reconnect');
assert.equal(viewer.snapshots.length, 1, 'Freeze is idempotent');

const controller = await fixture(false);
await controller.message(freeze);
assert.equal(controller.connections[0].disconnects, 0, 'The widget freeze message cannot disable manual control');
assert.equal(controller.snapshots.length, 0);
console.log('Published viewer freeze contract passed');
