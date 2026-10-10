import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { chromium } from 'playwright';

// Run in a disposable dev browser-session container with its normal runtime files.
test('VNC retains Russian and English input across layout, Shift and editing shortcuts', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(tmpdir() + '/helm-keyboard-');
  const runtime = spawn('sh', ['/app/start-browser.sh'], { detached: true, stdio: 'ignore', env: {
    ...process.env, SESSION_ID: randomUUID(), SESSION_TOKEN: randomUUID(),
    PROXY_IP: '127.0.0.1', DATA_DIR: directory,
  } });
  let browser, socket;
  t.after(async () => {
    socket?.destroy();
    await browser?.close();
    try { process.kill(-runtime.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await new Promise(resolve => {
      const probe = net.createConnection({ host: '127.0.0.1', port: 5901 });
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
      probe.setTimeout(200, () => { probe.destroy(); resolve(false); });
    });
    if (ready) break;
    assert.ok(attempt < 49, 'Production VNC runtime starts');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: false, args: [
    '--no-sandbox', '--window-position=0,0', '--window-size=1440,900',
  ], env: { ...process.env, DISPLAY: ':99' } });
  const page = await browser.newPage({ viewport: null });
  await page.setContent('<textarea autofocus></textarea>');
  await page.locator('textarea').focus();
  socket = net.createConnection({ host: '127.0.0.1', port: 5901 });
  const chunks = socket[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function read(size) {
    while (pending.length < size) {
      const next = await chunks.next();
      assert.ok(!next.done, 'VNC remains connected');
      pending = Buffer.concat([pending, next.value]);
      assert.ok(pending.length <= 8192, 'Bounded VNC handshake');
    }
    const result = pending.subarray(0, size);
    pending = pending.subarray(size);
    return result;
  }
  socket.write(await read(12));
  const count = (await read(1))[0];
  assert.ok((await read(count)).includes(1), 'VNC None security on loopback');
  socket.write(Buffer.from([1]));
  assert.equal((await read(4)).readUInt32BE(), 0);
  socket.write(Buffer.from([1]));
  const nameLength = (await read(24)).readUInt32BE(20);
  assert.ok(nameLength <= 4096);
  await read(nameLength);
  // A DOM focus alone does not activate the native X11 browser window.
  for (const buttons of [1, 0]) socket.write(Buffer.from([5, buttons, 0, 60, 0, 110]));
  await page.bringToFront();
  await page.locator('textarea').focus();
  await page.waitForFunction(() => document.hasFocus(), undefined, { timeout: 5000 });
  function key(keysym, down) {
    const event = Buffer.alloc(8);
    event[0] = 4;
    event[1] = Number(down);
    event.writeUInt32BE(keysym, 4);
    socket.write(event);
  }
  function press(keysym) { key(keysym, true); key(keysym, false); }
  async function value(expected) {
    await page.waitForFunction(text => document.querySelector('textarea').value === text,
      expected, { timeout: 5000 });
    assert.equal(await page.locator('textarea').inputValue(), expected);
  }
  for (const letter of 'abcxyz') press(letter.codePointAt(0));
  await value('abcxyz');
  key(0xffe3, true); press(0x61); key(0xffe3, false); press(0xff08);
  await value('');
  // Legacy Cyrillic keysyms emitted by noVNC, in Russian keyboard order.
  const symbols = [1738, 1731, 1749, 1739, 1733, 1742, 1735, 1755, 1757, 1754,
    1734, 1753, 1751, 1729, 1744, 1746, 1743, 1740, 1732, 1745, 1758, 1747, 1741, 1737, 1748, 1752];
  for (const symbol of symbols) press(symbol);
  await value('йцукенгшщзфывапролдячсмить');
  key(0xffe1, true);
  for (const symbol of symbols) press(symbol + 32);
  key(0xffe1, false);
  await value('йцукенгшщзфывапролдячсмитьЙЦУКЕНГШЩЗФЫВАПРОЛДЯЧСМИТЬ');
  key(0xffe3, true); press(0x61); key(0xffe3, false); press(0xff08);
  for (const letter of 'abcxyz') press(letter.codePointAt(0));
  await value('abcxyz');
});
