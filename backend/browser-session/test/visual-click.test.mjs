import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserMcp } from '../dist/browser-mcp.js';

// Run against the browser-session image on dev.
async function fixture(html, run) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let epoch = 1;
  const mcp = new BrowserMcp(context, () => page, () => epoch, () => {});
  const files = [];
  const signal = new AbortController().signal;
  const screenshot = async () => {
    const shot = await mcp.screenshot(randomUUID(), signal);
    files.push(shot.filename);
    return shot.target;
  };
  const click = (args) => mcp.act('click', args, randomUUID(), undefined, signal);
  const point = async (locator, shot) => {
    shot ??= await screenshot();
    const box = await locator.boundingBox();
    assert.ok(box);
    return { screenshotId: shot.screenshotId,
      x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  try {
    await page.setContent(html);
    await run({ page, mcp, screenshot, click, point, signal, changeControl: () => epoch++ });
  } finally {
    await mcp.close();
    await browser.close();
    await Promise.all(files.map(filename => rm(filename, { force: true })));
  }
}

test('stock visual click plays native iframe audio fully without an ARIA Play ref', async () => {
  const wav = Buffer.alloc(16_044);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  await fixture(`<iframe style="width:600px;height:120px" srcdoc="<p>Left audio</p><audio controls src='data:audio/wav;base64,${wav.toString('base64')}'></audio><output>Not listened</output><script>document.querySelector('audio').onended=()=>document.querySelector('output').textContent='Listened fully'</script>"></iframe>`,
    async ({ page, mcp, screenshot, click, signal }) => {
      const player = page.frameLocator('iframe').locator('audio');
      await player.waitFor();
      const observed = await mcp.observe();
      assert.equal(observed.snapshot.some(({ node }) => typeof node !== 'string'
        && node.role === 'button' && /play/i.test(node.name ?? '')), false);
      const shot = await screenshot();
      assert.ok(shot, 'a screenshot must issue a target for controls absent from ARIA');
      const box = await player.boundingBox();
      const args = { screenshotId: shot.screenshotId,
        x: Math.round(box.x + 18), y: Math.round(box.y + box.height / 2) };
      await click(args);
      await mcp.act('waitFor', { time: 1.2 }, randomUUID(), undefined, signal);
      assert.equal(await page.frameLocator('iframe').locator('output').textContent(), 'Listened fully');
      assert.deepEqual(await player.evaluate(audio => ({ ended: audio.ended, time: audio.currentTime })),
        { ended: true, time: 1 });
      await assert.rejects(click(args), /revoked/);
    });
});

test('visual targets reject unknown IDs, bounds, viewport, control and navigation changes', async () => {
  await fixture('<button onclick="window.effects=(window.effects||0)+1">Apply</button>',
    async ({ page, screenshot, click, point, changeControl }) => {
      let shot = await screenshot();
      await assert.rejects(click({ screenshotId: randomUUID(), x: 10, y: 10 }), /revoked/);
      await assert.rejects(click({ screenshotId: shot.screenshotId, x: shot.width, y: 10 }), /outside/);
      await assert.rejects(click({ screenshotId: shot.screenshotId, x: -1, y: 10 }));
      await page.setViewportSize({ width: 800, height: 600 });
      await assert.rejects(click({ screenshotId: shot.screenshotId, x: 10, y: 10 }), /viewport/);
      shot = await screenshot();
      const oldPoint = await point(page.getByRole('button'), shot);
      changeControl();
      await assert.rejects(click(oldPoint), /expired/);
      shot = await screenshot();
      const currentPoint = await point(page.getByRole('button'), shot);
      const now = Date.now;
      try {
        Date.now = () => now() + 61_000;
        await assert.rejects(click(currentPoint), /expired/);
      } finally { Date.now = now; }
      await click(currentPoint);
      assert.equal(await page.evaluate(() => window.effects), 1);
      shot = await screenshot();
      await page.goto('data:text/html,<button>New</button>');
      await assert.rejects(click({ screenshotId: shot.screenshotId, x: 10, y: 10 }), /revoked/);
    });
});

test('visual clicks refuse private labels, iframe and shadow inputs before native dispatch', async () => {
  await fixture(`<label>One-time code<input id=otp autocomplete=one-time-code></label>
    <iframe srcdoc="<label>Password<input type=password></label>"></iframe><div id=shadow></div>
    <script>window.effects=0;addEventListener('click',()=>window.effects++)</script>`,
    async ({ page, click, point }) => {
      await page.locator('#shadow').evaluate(node => {
        node.attachShadow({ mode: 'open' }).innerHTML = '<label>Card number<input autocomplete=cc-number></label>';
      });
      await page.frameLocator('iframe').getByLabel('Password').waitFor();
      for (const locator of [page.getByText('One-time code', { exact: true }),
        page.frameLocator('iframe').getByLabel('Password'), page.getByLabel('Card number')]) {
        await assert.rejects(click(await point(locator)), /Private input/);
      }
      assert.equal(await page.evaluate(() => window.effects), 0);
      const frame = page.locator('iframe');
      await frame.evaluate(element => element.style.transform = 'scale(.9)');
      await assert.rejects(click(await point(page.frameLocator('iframe').getByLabel('Password'))), /Frame point/);
    });
});
