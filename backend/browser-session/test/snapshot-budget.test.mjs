import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserMcp } from '../dist/browser-mcp.js';

// Run inside the browser-session image on dev, with no network or saved profile.
test('Helm paginates native output and keeps issued target identity', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const mcp = new BrowserMcp(context, () => page, () => 1, () => {});
  try {
    const messages = Array.from({ length: 1000 }, (_, index) =>
      `<li><article><h2>Message ${index}</h2><p>Voice note</p>`
      + `<button aria-label="Play voice message ${index}">Play</button></article></li>`);
    await page.setContent('<main><h1>Saved messages</h1><ul>' + messages.join('')
      + '</ul><output>Not played</output></main>');
    await page.getByRole('button', { name: 'Play voice message 999', exact: true }).evaluate(button => {
      button.addEventListener('click', () => { document.querySelector('output').textContent = 'Played 999'; });
    });
    let observation = await mcp.observe();
    const id = observation.observationId;
    let controls = 0;
    let target;
    do {
      assert.equal(observation.observationId, id);
      assert.equal(observation.metrics.snapshots, 1, 'Cursor reuses the filtered native snapshot');
      assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= 32768);
      for (const entry of observation.snapshot) {
        if (entry.node.role === 'button') controls++;
        if (entry.node.name === 'Play voice message 999') target = entry.node.ref;
      }
      if (observation.complete) break;
      assert.ok(observation.cursor);
      observation = await mcp.observe({ cursor: observation.cursor });
    } while (true);
    assert.equal(controls, 1000);
    assert.ok(target);
    await mcp.act('click', { observationId: id, ref: target }, randomUUID(), undefined,
      new AbortController().signal);
    assert.equal(await page.locator('output').textContent(), 'Played 999');
  } finally {
    await mcp.close();
    await browser.close();
  }
});

test('oversized native snapshots fail explicitly without exposing partial data and recover', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const mcp = new BrowserMcp(context, () => page, () => 1, () => {});
  try {
    for (const html of ['<p>' + 'x'.repeat(262145) + '</p>', '<p>' + 'я'.repeat(1_100_000) + '</p>']) {
      await page.setContent(html);
      await assert.rejects(mcp.observe(), error => error.code === 'OBSERVATION_LIMIT_EXCEEDED');
    }
    await page.setContent('<button>Readable again</button>');
    const observation = await mcp.observe();
    assert.ok(observation.snapshot.some(entry => entry.node.name === 'Readable again'));
  } finally {
    await mcp.close();
    await browser.close();
  }
});
