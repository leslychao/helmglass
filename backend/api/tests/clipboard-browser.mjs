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
  });
}, input.viewerId);
const page = await context.newPage();
const panel = page.locator('.browser-clipboard');
const clipButton = page.getByRole('button', { name: 'Буфер обмена', exact: true });
const copyOutput = page.getByRole('textbox', { name: 'Текст из удалённого браузера' });
const frame = () => page.frames().find(value => value.url().includes('/browser/novnc/helm.html'));
async function ready() {
  await clipButton.waitFor({ state: 'visible', timeout: 45000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Буфер обмена"][type]')?.disabled
    && document.querySelector('hg-browser iframe') && !document.querySelector('.viewer-recovery'), { timeout: 45000 });
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
  assert.ok(!events.some(event => event.error), 'Paste completes without clipboard errors');
}
async function copy(expected) {
  await page.evaluate(() => navigator.clipboard.writeText('local sentinel'));
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
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
  await page.keyboard.press('Control+A'); await paste('Второй текст'); await copy('Второй текст');
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
    navigator.clipboard.readText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
    navigator.clipboard.writeText = async () => { throw new DOMException('denied', 'NotAllowedError'); };
  });
  await page.keyboard.press('Control+V');
  await panel.waitFor({ state: 'visible' });
  assert.ok((await panel.textContent()).includes('ограничил'));
  const manual = 'Ручная передача 🌍\nдве строки';
  await page.getByRole('textbox', { name: 'Текст для вставки в браузер' }).fill(manual);
  // Replace the existing field, then use the actual fallback panel.
  await focusCanvas(); await page.keyboard.press('Control+A');
  await page.getByRole('button', { name: 'Вставить в браузер', exact: true }).click();
  await page.getByText('Передаём текст…', { exact: true }).waitFor({ state: 'hidden' });
  await focusCanvas(); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
  await page.waitForFunction(value => document.querySelector('[aria-label="Текст из удалённого браузера"]')?.value === value, manual);
  await page.getByRole('button', { name: 'Скопировать на компьютер', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), manual);
  console.log('Real Chrome: manual panel transfers both ways when iframe Clipboard API is denied');

  const boundary = 'я'.repeat(131072);
  await page.getByRole('textbox', { name: 'Текст для вставки в браузер' }).fill(boundary + 'a');
  await page.getByRole('button', { name: 'Вставить в браузер', exact: true }).click();
  assert.ok((await panel.textContent()).includes('256'));
  await focusCanvas(); await page.keyboard.press('Control+A');
  await page.getByRole('textbox', { name: 'Текст для вставки в браузер' }).fill(boundary);
  await page.getByRole('button', { name: 'Вставить в браузер', exact: true }).click();
  await page.waitForFunction(() => window.__clipboardChecks.at(-1)?.busy === false);
  await focusCanvas(); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
  await page.waitForFunction(value => document.querySelector('[aria-label="Текст из удалённого браузера"]')?.value === value, boundary);
  assert.equal((await copyOutput.inputValue()).length, boundary.length);
  console.log('Real Chrome: exact UTF-8 boundary accepted; one byte over rejected');

  // Pause only the stream; the existing page visit protects the browser lifetime.
  await page.getByRole('button', { name: 'Закрыть буфер обмена', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить трансляцию', exact: true }).click();
  const connection = await api('/api/connections/' + input.connectionId);
  const ticket = await api('/api/browser-sessions/' + connection.browser.id + '/ticket', { role: 'VIEWER', viewerId: input.viewerId });
  const viewerUrl = new URL(ticket.url, input.base);
  viewerUrl.searchParams.set('view_only', '0'); // Deliberately bypass the client role restriction.
  const observer = await context.newPage();
  await observer.goto(viewerUrl.href);
  await observer.locator('canvas').waitFor({ state: 'visible' });
  await observer.locator('canvas').click({ position: { x: 200, y: 300 } });
  await observer.keyboard.type('forbidden input');
  await observer.evaluate(() => navigator.clipboard.writeText('forbidden clipboard'));
  await observer.keyboard.press('Control+V');
  await observer.waitForFunction(() => window.__clipboardChecks.some(event => event.error?.includes('пять секунд')));
  assert.ok(!await observer.evaluate(() => window.__clipboardChecks.some(event => 'text' in event)));
  await observer.close();
  await page.getByRole('button', { name: 'Возобновить трансляцию', exact: true }).click();
  await ready(); await focusCanvas(); await copy(boundary);
  console.log('Real server: VIEWER cannot change input or exchange clipboard with UI checks bypassed');

  const address = page.getByRole('textbox', { name: 'Адрес удалённого браузера' });
  await address.fill(input.fixtureUrl + '?oversize=1'); await address.press('Enter');
  await page.waitForTimeout(1000);
  await focusCanvas(); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+C');
  await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.browser-clipboard')?.textContent.includes('256'));
  console.log('Real server: oversized remote copy reports the limit without truncation');
} catch (error) {
  await page.screenshot({ path: '.clipboard-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
