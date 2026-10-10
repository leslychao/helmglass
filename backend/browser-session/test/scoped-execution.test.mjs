import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserMcp } from '../dist/browser-mcp.js';

async function fixture(html, run) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let page = await context.newPage();
  let epoch = 1;
  const mcp = new BrowserMcp(context, () => page, () => epoch, () => {});
  try {
    await page.setContent(html);
    await run({ mcp, page, context, changePage: value => { page = value; }, changeControl: () => epoch++ });
  } finally { await mcp.close(); await browser.close(); }
}
function target(observation, name) {
  const matches = observation.snapshot.filter(({ node }) => typeof node !== 'string' && node.name === name && node.ref);
  assert.equal(matches.length, 1, name);
  return { observationId: observation.observationId, ref: matches[0].node.ref };
}
const signal = () => new AbortController().signal;
const batch = count => ({ operationIds: Array.from({ length: count }, randomUUID) });

test('target preflights preserve sibling, iframe and shadow refs; final region replaces observation', async () => {
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
    assert.equal(region.complete, true);
    assert.equal(region.metrics.fullSnapshots, 1);
    assert.equal(region.metrics.targetSnapshots, 4);
    assert.equal(await page.frameLocator('iframe').getByLabel('Inside').inputValue(), 'Inside');
    assert.equal(await page.getByLabel('Shadow').inputValue(), 'Shadow');
    assert.ok(!JSON.stringify(region.snapshot).includes('Inside'));
    await assert.rejects(mcp.act('click', target(observed, 'Apply'), randomUUID(), undefined, signal()), /not issued/);
    await mcp.act('click', target(region, 'Apply'), randomUUID(), undefined, signal());
  });
});

test('replacement, changed role/name, navigation, control and scope cursor revoke references', async () => {
  await fixture('<section aria-label="Scope"><button>Target</button></section>', async ({ mcp, page, context, changePage, changeControl }) => {
    let observed = await mcp.observe();
    await page.getByRole('button').evaluate(node => node.replaceWith(node.cloneNode(true)));
    await assert.rejects(mcp.act('click', target(observed, 'Target'), randomUUID(), undefined, signal()));
    observed = await mcp.observe();
    await page.getByRole('button').evaluate(node => node.setAttribute('aria-label', 'Changed'));
    await assert.rejects(mcp.act('click', target(observed, 'Target'), randomUUID(), undefined, signal()));
    observed = await mcp.observe();
    await page.getByRole('button').evaluate(node => node.setAttribute('role', 'link'));
    await assert.rejects(mcp.act('click', target(observed, 'Changed'), randomUUID(), undefined, signal()));
    observed = await mcp.observe();
    changeControl();
    await assert.rejects(mcp.observe(target(observed, 'Scope')), /expired/);
    observed = await mcp.observe();
    const next = await context.newPage();
    changePage(next);
    await assert.rejects(mcp.act('click', target(observed, 'Changed'), randomUUID(), undefined, signal()));
    changePage(page);
    await next.close();
    await page.setContent('<section aria-label="Scope">' + '<p>Row</p>'.repeat(250) + '</section>');
    observed = await mcp.observe();
    let region = await mcp.observe(target(observed, 'Scope'));
    assert.equal(region.complete, false);
    const original = region;
    region = await mcp.observe({ cursor: region.cursor });
    assert.equal(region.observedAt, original.observedAt);
    assert.deepEqual(region.scope, original.scope);
    await mcp.observe();
    await assert.rejects(mcp.observe({ cursor: original.cursor }), /cursor expired/);
    observed = await mcp.observe();
    await page.goto('data:text/html,<button>New page</button>');
    await assert.rejects(mcp.observe(target(observed, 'Scope')));
  });
});

test('target traversal ignores unrelated growth and restores native maps after bounded failure', async () => {
  await fixture('<section aria-label="Region"><p>Small</p></section><button>Other</button><div id=outside></div>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    await page.locator('#outside').evaluate(node => { node.innerHTML = '<i>x</i>'.repeat(20001); });
    const region = await mcp.observe(target(observed, 'Region'));
    assert.equal(region.complete, true);
    assert.ok(JSON.stringify(region).length < 2000);
  });
  await fixture('<section aria-label="Region"><p>Small</p></section><button>Other</button>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    const other = target(observed, 'Other');
    await page.locator('p').evaluate(node => { node.textContent = 'x'.repeat(262145); });
    await assert.rejects(mcp.act('click', target(observed, 'Region'), randomUUID(), undefined, signal()),
      error => error.code === 'OBSERVATION_LIMIT_EXCEEDED');
    assert.equal(await page.locator(`aria-ref=${other.ref}`).count(), 1);
  });
});

test('text waits reuse the matching safe native region and skip only explicitly replaced settle', async () => {
  for (const millis of [0, 150, 700]) {
    await fixture(`<button>Save</button><div role=status aria-label="Result">Waiting</div>
      <script>let effects=0;document.querySelector('button').onclick=()=>{effects++;setTimeout(()=>document.querySelector('[role=status]').textContent='Saved once',${millis})}</script>`, async ({ mcp, page }) => {
      const observed = await mcp.observe();
      const sequence = batch(2);
      const started = performance.now();
      await mcp.act('click', target(observed, 'Save'), sequence.operationIds[0], sequence, signal(), { explicitWait: true });
      const clickMillis = performance.now() - started;
      assert.ok(clickMillis < 450, `click still settled for ${clickMillis} ms`);
      const result = await mcp.act('waitFor', { ...target(observed, 'Result'), text: 'Saved once' }, sequence.operationIds[1], sequence, signal(), { observeAfter: true });
      assert.equal(result.scope.type, 'region');
      assert.equal(result.metrics.fullSnapshots, 1);
      assert.equal(result.metrics.waits, 1);
      assert.ok(result.metrics.waitMillis > 0);
      assert.equal(await page.evaluate(() => effects), 1);
      assert.ok(JSON.stringify(result).includes('Saved once'));
      assert.ok(!JSON.stringify(result.snapshot).includes('Save"'));
      console.log(JSON.stringify({ waitDelayMillis: millis, clickMillis, totalMillis: performance.now() - started, metrics: result.metrics }));
    });
  }
});

test('text waits retain other batch refs, permit changed text, reject target replacement and settle cancellation', async () => {
  await fixture('<button>Waiting</button>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    await page.getByRole('button').evaluate(node => { node.textContent = 'Ready'; });
    const result = await mcp.act('waitFor', { ...target(observed, 'Waiting'), text: 'Ready' },
      randomUUID(), undefined, signal(), { observeAfter: true });
    assert.ok(target(result, 'Ready').ref);
    await mcp.act('click', target(result, 'Ready'), randomUUID(), undefined, signal());
  });
  await fixture('<button>Other</button><div role=status>Waiting</div>', async ({ mcp, page }) => {
    let observed = await mcp.observe();
    const status = observed.snapshot.find(({ node }) => node.role === 'status').node.ref;
    const sequence = batch(2);
    await page.locator('[role=status]').evaluate(node => { node.textContent = 'Ready'; });
    await mcp.act('waitFor', { observationId: observed.observationId, ref: status, text: 'Ready' }, sequence.operationIds[0], sequence, signal());
    await mcp.act('click', target(observed, 'Other'), sequence.operationIds[1], sequence, signal());
    observed = await mcp.observe();
    const current = observed.snapshot.find(({ node }) => node.role === 'status').node.ref;
    await page.locator('[role=status]').evaluate(node => node.replaceWith(node.cloneNode(true)));
    const started = performance.now();
    await assert.rejects(mcp.act('waitFor', { observationId: observed.observationId, ref: current, text: 'Ready' }, randomUUID(), undefined, signal()));
    assert.ok(performance.now() - started < 1000, 'Removed identity must fail immediately');
  });
  await fixture('<div role=status aria-label="Result">Waiting</div>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    const abort = new AbortController();
    const pending = mcp.act('waitFor', { ...target(observed, 'Result'), text: 'Never' }, randomUUID(), undefined, abort.signal);
    setTimeout(() => abort.abort(), 350);
    await assert.rejects(pending);
    await mcp.close();
    assert.equal(page.isClosed(), false);
    assert.equal(await page.locator(`aria-ref=${target(observed, 'Result').ref}`).count(), 0);
  });
});

test('hidden/detached already reached succeed; private values and bounded target failures stay safe', async () => {
  for (const state of ['hidden', 'detached']) {
    await fixture('<button>Target</button>', async ({ mcp, page }) => {
      const observed = await mcp.observe();
      await page.getByRole('button').evaluate((node, state) => { if (state === 'hidden') node.hidden = true; else node.remove(); }, state);
      await mcp.act('waitFor', { ...target(observed, 'Target'), state }, randomUUID(), undefined, signal());
    });
  }
  await fixture('<section aria-label="Private"><input type=password value=private-password><input autocomplete=one-time-code value=private-otp><input autocomplete=cc-number value=private-card><input type=hidden value=private-hidden><button>Safe</button></section>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    const region = await mcp.observe(target(observed, 'Private'));
    assert.ok(!/private-(password|otp|card|hidden)/.test(JSON.stringify(region)));
    await page.locator('section').evaluate(node => { const huge = document.createElement('p'); huge.textContent = 'x'.repeat(262145); node.append(huge); });
    await assert.rejects(mcp.observe(target(region, 'Private')), error => error.code === 'OBSERVATION_LIMIT_EXCEEDED');
  });
});

test('region budgets include accessible-name dependencies and restore all affected frame maps', async () => {
  await fixture('<button aria-labelledby="name">Target</button><span id=name>Small name</span>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    await page.locator('#name').evaluate(node => { node.textContent = 'x'.repeat(262145); });
    await assert.rejects(mcp.observe(target(observed, 'Small name')),
      error => error.code === 'OBSERVATION_LIMIT_EXCEEDED');
  });
  await fixture('<section aria-label="Region"><iframe srcdoc="<label>Inside<input></label><p>Small</p>"></iframe></section><button>Other</button>', async ({ mcp, page }) => {
    await page.frameLocator('iframe').getByLabel('Inside').waitFor();
    const observed = await mcp.observe();
    await page.frameLocator('iframe').locator('p').evaluate(node => { node.textContent = 'x'.repeat(262145); });
    await assert.rejects(mcp.act('click', target(observed, 'Region'), randomUUID(), undefined, signal()),
      error => error.code === 'OBSERVATION_LIMIT_EXCEEDED');
    for (const name of ['Other', 'Inside'])
      assert.equal(await page.locator(`aria-ref=${target(observed, name).ref}`).count(), 1);
  });
  await fixture('<section aria-label="Region">Small</section>', async ({ mcp, page }) => {
    const observed = await mcp.observe();
    await page.locator('section').evaluate(node => { node.innerHTML = '<div>'.repeat(65) + 'Deep' + '</div>'.repeat(65); });
    await assert.rejects(mcp.observe(target(observed, 'Region')),
      error => error.code === 'OBSERVATION_LIMIT_EXCEEDED');
  });
});

test('an unchanged target expires after the real observation lifetime', async () => {
  await fixture('<button>Target</button>', async ({ mcp }) => {
    const observed = await mcp.observe();
    await delay(60_100);
    await assert.rejects(mcp.act('click', target(observed, 'Target'), randomUUID(), undefined, signal()), /expired/);
  });
});
