import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../../browser-session/package.json', import.meta.url))('playwright');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await context.addCookies(input.cookies);
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: input.base });
await context.addInitScript(viewerId => {
  sessionStorage.setItem('helm-viewer-id', viewerId);
  window.__clipboardChecks = [];
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.data?.type === 'helm-viewer'
        && event.data.state === 'clipboard') window.__clipboardChecks.push(event.data);
    if (event.origin === location.origin && event.data?.type === 'helm-viewer') {
      if (event.data.state === 'connected') window.__viewerConnected = true;
      if (['disconnected', 'error'].includes(event.data.state)) window.__viewerConnected = false;
    }
  });
}, input.viewerId);
const page = await context.newPage();
const panel = page.locator('.browser-clipboard');
const clipButton = page.getByRole('button', { name: 'Буфер обмена', exact: true });
const copyOutput = page.getByRole('textbox', { name: 'Текст из удалённого браузера' });
const frame = () => page.frames().find(value => value.url().includes('/browser/novnc/helm.html'));
async function ready() {
  await clipButton.waitFor({ state: 'visible', timeout: 45000 });
  await page.waitForFunction(() => document.querySelector('button[aria-label="Буфер обмена"]')?.disabled === false
    && document.querySelector('hg-browser iframe') && !document.querySelector('.viewer-recovery'), undefined, { timeout: 45000 });
  assert.ok(frame(), 'Published noVNC frame is present');
}
async function focusCanvas() {
  const canvas = frame().locator('canvas');
  const box = await canvas.boundingBox();
  assert.ok(box);
  await canvas.click({ position: { x: box.width * 0.2, y: box.height * 0.35 } });
}
async function paste(text) {
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  const before = await page.evaluate(() => window.__clipboardChecks.length);
  await page.keyboard.press('Control+V');
  await page.waitForFunction(index => window.__clipboardChecks.slice(index).some(event => event.busy === false), before);
  const events = await page.evaluate(index => window.__clipboardChecks.slice(index), before);
  assert.ok(!events.some(event => event.error), 'Paste: ' + events.filter(event => event.error).map(event => event.error).join('; '));
}
async function copy(expected) {
  await page.evaluate(() => navigator.clipboard.writeText('local sentinel'));
  const before = await page.evaluate(() => window.__clipboardChecks.length);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+C');
  await page.waitForFunction(index => window.__clipboardChecks.slice(index).some(event => event.busy === false), before);
  const errors = await page.evaluate(index => window.__clipboardChecks.slice(index).filter(event => event.error).map(event => event.error), before);
  assert.deepEqual(errors, [], 'Copy completes before the next clipboard operation');
  await page.waitForFunction(async value => await navigator.clipboard.readText() === value, expected, { timeout: 10000 });
}
async function api(path, body) {
  const cookies = await context.cookies(input.base);
  const csrf = cookies.find(cookie => cookie.name === 'XSRF-TOKEN')?.value ?? '';
  const response = await context.request.fetch(input.base + path, { method: body ? 'POST' : 'GET',
    headers: { 'X-XSRF-TOKEN': csrf, 'Idempotency-Key': crypto.randomUUID() }, data: body });
  assert.equal(response.status(), 200, 'Authorized clipboard fixture request');
  return response.json();
}
try {
  await page.goto(input.base + '/connections/' + input.connectionId + '/login');
  await ready(); await focusCanvas();
  const text = 'Привет 🌍\nстрока с emoji 🧪';
  await paste(text); await copy(text); await copy(text);
  console.log('Real Chrome: Unicode paste and repeated identical copy passed');
  await page.keyboard.press('Control+a'); await paste('Второй текст'); await copy('Второй текст');
  const count = page.locator('hg-browser iframe');
  assert.equal(await count.count(), 1);
  await page.getByRole('button', { name: 'Развернуть браузер', exact: true }).click();
  await page.getByRole('button', { name: 'Свернуть браузер', exact: true }).click();
  assert.equal(await count.count(), 1);
  await context.setOffline(true);
  await page.waitForFunction(() => !document.querySelector('hg-browser iframe'));
  await context.setOffline(false); await ready(); await focusCanvas(); await copy('Второй текст');
  console.log('Real Chrome: expand and reconnect retained the same page and input');

  await frame().evaluate(() => {
    window.__originalClipboardRead = navigator.clipboard.readText.bind(navigator.clipboard);
    window.__originalClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.readText = () => new Promise(resolve => { window.__resolveClipboardRead = resolve; });
  });
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => document.querySelector('.browser-clipboard')?.textContent.includes('пять секунд'));
  await frame().evaluate(() => {
    window.__resolveClipboardRead('late paste must not replace the field');
    navigator.clipboard.readText = window.__originalClipboardRead;
  });
  await page.getByRole('button', { name: 'Закрыть буфер обмена', exact: true }).click();
  await focusCanvas(); await copy('Второй текст');
  console.log('Real Chrome: five-second timeout suppresses late paste');

  await frame().evaluate(() => {
    navigator.clipboard.readText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
    navigator.clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.keyboard.press('Control+V');
  await panel.waitFor({ state: 'visible' });
  assert.ok((await panel.textContent()).includes('ограничил'));
  const manual = 'Ручная передача 🌍\nдве строки';
  await page.getByRole('textbox', { name: 'Текст для вставки в браузер' }).fill(manual);
  // Replace the existing field, then use the actual fallback panel.
  await focusCanvas(); await page.keyboard.press('Control+a');
  await page.getByRole('button', { name: 'Вставить в браузер', exact: true }).click();
  await page.getByText('Передаём текст…', { exact: true }).waitFor({ state: 'hidden' });
  await focusCanvas(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+C');
  await page.waitForFunction(value => document.querySelector('[aria-label="Текст из удалённого браузера"]')?.value === value, manual);
  await page.evaluate(() => navigator.clipboard.writeText('local sentinel'));
  await page.getByRole('button', { name: 'Скопировать на компьютер', exact: true }).click();
  await page.waitForFunction(async value => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n') === value, manual);
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('local sentinel');
    window.__originalClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.getByRole('button', { name: 'Скопировать на компьютер', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Текст из удалённого браузера'
    && document.activeElement.selectionEnd > document.activeElement.selectionStart);
  await page.keyboard.press('Control+C');
  assert.equal(await page.evaluate(async () => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n')), manual);
  await page.evaluate(() => { navigator.clipboard.writeText = window.__originalClipboardWrite; });
  console.log('Real Chrome: manual panel transfers both ways when iframe Clipboard API is denied');

  const boundary = 'я'.repeat(131072);
  await page.getByRole('textbox', { name: 'Текст для вставки в браузер' }).fill(boundary + 'a');
  await page.getByRole('button', { name: 'Вставить в браузер', exact: true }).click();
  assert.ok((await panel.textContent()).includes('256'));
  await focusCanvas(); await page.keyboard.press('Control+a');
  await page.getByRole('textbox', { name: 'Текст для вставки в браузер' }).fill(boundary);
  const beforeBoundary = await page.evaluate(() => window.__clipboardChecks.length);
  await page.getByRole('button', { name: 'Вставить в браузер', exact: true }).click();
  await page.waitForFunction(index => window.__clipboardChecks.slice(index).some(event => event.busy === false), beforeBoundary);
  await focusCanvas(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+C');
  await page.waitForFunction(value => document.querySelector('[aria-label="Текст из удалённого браузера"]')?.value === value, boundary);
  assert.equal((await copyOutput.inputValue()).length, boundary.length);
  console.log('Real Chrome: exact UTF-8 boundary accepted; one byte over rejected');

  await frame().evaluate(() => {
    navigator.clipboard.readText = window.__originalClipboardRead;
    navigator.clipboard.writeText = window.__originalClipboardWrite;
  });
  await page.getByRole('button', { name: 'Закрыть буфер обмена', exact: true }).click();
  const connection = await api('/api/connections/' + input.connectionId);
  const ticket = await api('/api/browser-sessions/' + connection.browser.id + '/ticket', { role: 'VIEWER', viewerId: input.viewerId });
  const viewerUrl = new URL(ticket.url, input.base);
  viewerUrl.searchParams.set('view_only', '0'); // Deliberately bypass the client role restriction.
  const observer = await context.newPage();
  await observer.goto(viewerUrl.href);
  await observer.waitForFunction(() => window.__viewerConnected === true);
  assert.equal(new URL(observer.url()).searchParams.get('view_only'), '0');
  await observer.locator('canvas').click({ position: { x: 200, y: 300 } });
  assert.equal(await observer.evaluate(() => document.activeElement.tagName), 'CANVAS');
  await observer.keyboard.type('forbidden input');
  await observer.evaluate(() => navigator.clipboard.writeText('forbidden clipboard'));
  await observer.keyboard.press('Control+V');
  await observer.waitForTimeout(5500);
  assert.ok(!await observer.evaluate(() => window.__clipboardChecks.some(event => 'text' in event)));
  await observer.close();
  await ready(); await focusCanvas(); await copy(boundary);
  console.log('Real server: VIEWER cannot change input or exchange clipboard with UI checks bypassed');

  const address = page.getByRole('textbox', { name: 'Адрес удалённого браузера' });
  await address.fill(input.fixtureUrl + '?oversize=1'); await address.press('Enter');
  await page.waitForTimeout(1000);
  await focusCanvas(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+C');
  await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.browser-clipboard')?.textContent.includes('256'));
  console.log('Real server: oversized remote copy reports the limit without truncation');

  await address.fill(input.fixtureUrl + '?wireoversize=1'); await address.press('Enter');
  await page.waitForTimeout(1000);
  await focusCanvas(); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+C');
  await page.waitForFunction(() => ['.browser-clipboard', '.viewer-recovery'].some(selector =>
    document.querySelector(selector)?.textContent.includes('256')));
  await ready();
  console.log('Real server: oversized wire payload reports the limit and leaves a healthy view');

  if (await panel.count()) await page.getByRole('button', { name: 'Закрыть буфер обмена', exact: true }).click();
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('local sentinel');
    const element = document.querySelector('hg-browser iframe');
    window.__oldClipboardSource = element.contentWindow;
    window.__oldClipboardEpoch = new URL(element.src).searchParams.get('viewerEpoch');
  });
  await frame().evaluate(() => { navigator.clipboard.readText = () => new Promise(() => {}); });
  await focusCanvas(); await page.keyboard.press('Control+V');
  const active = await api('/api/connections/' + input.connectionId);
  await api('/api/browser-sessions/' + active.browser.id + '/control', {
    type: 'RETURN', viewerId: input.viewerId, controlEpoch: active.browser.controlEpoch,
  });
  await clipButton.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    origin: location.origin, source: window.__oldClipboardSource,
    data: { type: 'helm-viewer', state: 'clipboard', viewerEpoch: window.__oldClipboardEpoch,
      text: 'late clipboard event', manual: true },
  })));
  assert.equal(await panel.count(), 0);
  await page.bringToFront();
  await page.mouse.click(1400, 1180);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'local sentinel');
  console.log('Real server: control handoff cancels pending transfer, clears panel and rejects old viewer events');
} catch (error) {
  await page.screenshot({ path: '.clipboard-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
