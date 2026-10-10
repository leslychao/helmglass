import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserMcp, McpExecutionUnconfirmed } from '../dist/browser-mcp.js';

// Run in the browser-session image on dev.
async function fixture(html, run) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let epoch = 1;
  const mcp = new BrowserMcp(context, () => page, () => epoch, () => {});
  try {
    await page.setContent(html);
    await run({ mcp, page, context, changeControl: () => epoch++ });
  } finally { await mcp.close(); await browser.close(); }
}
function target(observation, name) {
  const matches = observation.snapshot.filter(({ node }) => typeof node !== 'string' && node.name === name && node.ref);
  assert.equal(matches.length, 1, name);
  return { observationId: observation.observationId, ref: matches[0].node.ref };
}
const signal = () => new AbortController().signal;
const batch = count => ({ operationIds: Array.from({ length: count }, randomUUID) });

test('native actions keep sibling, iframe and shadow refs until the final scoped observation', async () => {
  await fixture(`<form aria-label="Fields"><label>First<input></label><button type=button>Apply</button></form>
    <iframe srcdoc='<label>Inside<input></label>'></iframe><div id=shadow></div>`, async ({ mcp, page }) => {
    await page.locator('#shadow').evaluate(node => { node.attachShadow({ mode: 'open' }).innerHTML = '<label>Shadow<input></label>'; });
    await page.frameLocator('iframe').getByLabel('Inside').waitFor();
    const observed = await mcp.observe();
    const sequence = batch(4);
    for (const [index, name] of ['Inside', 'First', 'Shadow'].entries()) {
      await mcp.act('fill', { ...target(observed, name), text: name }, sequence.operationIds[index], sequence, signal());
    }
    const region = await mcp.observe(target(observed, 'Fields'), signal(), sequence.operationIds[3], sequence);
    assert.equal(region.scope.type, 'region');
    assert.equal(region.metrics.fullSnapshots, 1);
    assert.equal(region.metrics.targetSnapshots, 1);
    assert.equal(await page.getByLabel('First').inputValue(), 'First');
    assert.equal(await page.frameLocator('iframe').getByLabel('Inside').inputValue(), 'Inside');
    assert.equal(await page.getByLabel('Shadow').inputValue(), 'Shadow');
    await assert.rejects(mcp.act('click', target(observed, 'Apply'), randomUUID(), undefined, signal()), /not issued/);
    await mcp.act('click', target(region, 'Apply'), randomUUID(), undefined, signal());
  });
});

test('replacement and control changes revoke refs; cursor retains filtered observation', async () => {
  await fixture('<section aria-label="Scope"><button>Target</button></section>', async ({ mcp, page, changeControl }) => {
    let observed = await mcp.observe();
    await page.getByRole('button').evaluate(node => node.replaceWith(node.cloneNode(true)));
    await assert.rejects(mcp.act('click', target(observed, 'Target'), randomUUID(), undefined, signal()));
    observed = await mcp.observe();
    changeControl();
    await assert.rejects(mcp.observe(target(observed, 'Scope')), /expired/);
    await page.setContent('<section aria-label="Scope">' + '<p>Row</p>'.repeat(250) + '</section>');
    observed = await mcp.observe();
    const region = await mcp.observe(target(observed, 'Scope'));
    assert.equal(region.complete, false);
    const continued = await mcp.observe({ cursor: region.cursor });
    assert.equal(continued.observedAt, region.observedAt);
    assert.deepEqual(continued.scope, region.scope);
    await mcp.observe();
    await assert.rejects(mcp.observe({ cursor: region.cursor }), /cursor expired/);
    await page.goto('data:text/html,<button>New page</button>');
    await assert.rejects(mcp.observe(target(observed, 'Scope')));
  });
});

test('stock text waits complete before a fresh observation without repeating the effect', async () => {
  await fixture(`<button>Save</button><output>Waiting</output>
    <script>let effects=0;document.querySelector('button').onclick=()=>{effects++;setTimeout(()=>document.querySelector('output').textContent='Saved '+effects,700)}</script>`, async ({ mcp, page }) => {
    const observed = await mcp.observe();
    const sequence = batch(2);
    await mcp.act('click', target(observed, 'Save'), sequence.operationIds[0], sequence, signal());
    await mcp.act('waitFor', { textGone: 'Waiting', text: 'Saved 1', time: .01 }, sequence.operationIds[1], sequence, signal());
    const result = await mcp.observe();
    assert.equal(result.scope.type, 'page');
    assert.equal(result.metrics.fullSnapshots, 2);
    assert.ok(JSON.stringify(result.snapshot).includes('Saved 1'));
    assert.equal(await page.evaluate(() => effects), 1);
    for (const args of [{}, { time: 31 }, { text: 'Ready', state: 'visible' }])
      await assert.rejects(mcp.act('waitFor', args, randomUUID(), undefined, signal()));
  });
});

test('background requests do not delay native clicks; explicit waits retain their conditions', async () => {
  await fixture(`<button>Choose</button><output>Waiting</output><script>
    let effects=0;document.querySelector('button').onclick=()=>{
      document.querySelector('output').textContent='Chosen '+(++effects);
      fetch('https://latency.example.test/background').then(()=>{
        document.querySelector('output').textContent='Ready '+effects;
      });
    };</script>`, async ({ mcp, page, context }) => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await context.route('https://latency.example.test/background', async route => {
      await pending;
      await delay(180);
      await route.fulfill({ body: 'ok', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    try {
      const observed = await mcp.observe();
      const started = performance.now();
      await mcp.act('click', target(observed, 'Choose'), randomUUID(), undefined, signal());
      const clickMillis = performance.now() - started;
      assert.ok(clickMillis < 1000, `Click waited for the unfinished request: ${clickMillis} ms`);
      assert.equal(await page.locator('output').textContent(), 'Chosen 1');

      const timeStarted = performance.now();
      await mcp.act('waitFor', { time: .12 }, randomUUID(), undefined, signal());
      const timeMillis = performance.now() - timeStarted;
      assert.ok(timeMillis >= 115 && timeMillis < 1000, `Explicit time wait: ${timeMillis} ms`);
      assert.equal(await page.locator('output').textContent(), 'Chosen 1');

      release();
      const textStarted = performance.now();
      await mcp.act('waitFor', { textGone: 'Chosen 1', text: 'Ready 1' }, randomUUID(), undefined, signal());
      const textMillis = performance.now() - textStarted;
      const final = await mcp.observe();
      assert.ok(textMillis >= 150 && textMillis < 1500, `Explicit text wait: ${textMillis} ms`);
      assert.ok(JSON.stringify(final.snapshot).includes('Ready 1'));
      assert.equal(await page.evaluate(() => effects), 1);
      console.log(JSON.stringify({ clickMillis, timeMillis, textMillis }));
    } finally {
      release();
      await context.unrouteAll({ behavior: 'wait' });
    }
  });
});

test('keyboard uses actual focus and refuses sensitive input after focus changes', async () => {
  await fixture('<label>Text<input id=plain></label><label>One-time code<input id=code></label>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    await mcp.act('click', target(observed, 'Text'), randomUUID(), undefined, signal());
    await mcp.act('press', { key: 'a' }, randomUUID(), undefined, signal());
    assert.equal(await page.locator('#plain').inputValue(), 'a');
    await mcp.act('press', { key: 'Tab' }, randomUUID(), undefined, signal());
    await assert.rejects(mcp.act('press', { key: 'b' }, randomUUID(), undefined, signal()), /Private input/);
    assert.equal(await page.locator('#code').inputValue(), '');
    await assert.rejects(mcp.act('press', { ...target(observed, 'Text'), key: 'Enter' }, randomUUID(), undefined, signal()));
  });
});

test('current field metadata refuses a newly sensitive label on an already issued target', async () => {
  await fixture('<label><span>Public field</span><input></label>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    await page.locator('span').evaluate(label => { label.textContent = 'One-time code'; });
    await assert.rejects(mcp.act('fill', { ...target(observed, 'Public field'), text: 'blocked' }, randomUUID(), undefined, signal()), /Private input/);
    assert.equal(await page.locator('input').inputValue(), '');
  });
});

test('caller cancellation waits for actual native handler completion', async () => {
  await fixture('<p>Ready</p>', async ({ mcp }) => {
    await mcp.observe();
    const abort = new AbortController();
    const started = performance.now();
    const pending = mcp.act('waitFor', { time: .8 }, randomUUID(), undefined, abort.signal);
    await delay(150); abort.abort();
    await assert.rejects(pending);
    assert.ok(performance.now() - started >= 750);
    assert.equal(mcp.requiresStop, false);
  });
});

test('a native modal early response leaves execution unconfirmed until the session stops', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const mcp = new BrowserMcp(context, () => page, () => 1, () => {});
  try {
    await page.setContent('<button onclick="alert(\'Hold\');document.body.dataset.effect=\'late\'">Dialog</button>');
    const observed = await mcp.observe();
    await assert.rejects(mcp.act('click', target(observed, 'Dialog'), randomUUID(), undefined, signal()), McpExecutionUnconfirmed);
    assert.equal(mcp.requiresStop, true);
    await assert.rejects(mcp.close(), McpExecutionUnconfirmed);
  } finally { await browser.close(); }
});

test('a pre-existing native dialog refuses wheel without a late action', { timeout: 5000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const mcp = new BrowserMcp(context, () => page, () => 1, () => {});
  let dialogExecution;
  try {
    await page.setContent('<p>Ready</p><script>window.wheels=0;addEventListener("wheel",()=>wheels++)</script>');
    await mcp.observe();
    const opened = page.waitForEvent('dialog');
    dialogExecution = page.evaluate(() => alert('Hold')).catch(() => {});
    const dialog = await opened;
    await assert.rejects(mcp.act('scroll', { y: 100 }, randomUUID(), undefined, signal()), /Browser tool failed/);
    await mcp.close();
    await dialog.dismiss();
    await dialogExecution;
    assert.equal(await page.evaluate(() => wheels), 0);
  } finally { await browser.close(); await dialogExecution; }
});
