// Run against the built browser-session image on dev; one warmup plus ten measured runs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { BrowserMcp } from '../dist/browser-mcp.js';

const browser = await chromium.launch({ headless: true });
try {
  for (const size of [0, 1000]) {
    for (let run = 0; run <= 10; run++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const mcp = new BrowserMcp(context, () => page, () => 1, () => {});
      try {
        await page.setContent(`<main><h1>Training form</h1><form aria-label="Training fields">
          <label>Recipient<input name="recipient"></label>
          <label>Quantity<input name="quantity" type="number"></label>
          <label>City<select name="city"><option>Perm</option><option>Kazan</option></select></label>
          <label><input name="confirmed" type="checkbox">Confirmed</label>
          <div role="textbox" aria-label="Comment" contenteditable="true"></div>
          <button type="submit">Save training form</button></form>
          <output aria-label="Saved result">Not saved</output><ul>`
          + Array.from({ length: size }, (_, index) => `<li><article><h2>Message ${index}</h2>
            <p>Training message</p><button>Play message ${index}</button></article></li>`).join('')
          + `</ul></main><script>let saves=0;document.querySelector('form').onsubmit=e=>{
            e.preventDefault();const fields=Object.fromEntries(new FormData(e.target));
            fields.comment=document.querySelector('[contenteditable]').textContent;
            fields.saves=++saves;document.querySelector('output').textContent=JSON.stringify(fields);
          };</script>`);
        const started = performance.now();
        const observed = await mcp.observe();
        const reference = name => {
          const found = observed.snapshot.map(entry => entry.node)
            .filter(node => typeof node !== 'string' && node.name === name && node.ref);
          assert.equal(found.length, 1, name);
          return { observationId: observed.observationId, ref: found[0].ref };
        };
        const commands = [
          ['fill', { ...reference('Recipient'), text: 'Training User' }],
          ['fill', { ...reference('Quantity'), text: '2' }],
          ['selectOption', { ...reference('City'), values: ['Kazan'] }],
          ['check', { ...reference('Confirmed'), checked: true }],
          ['fill', { ...reference('Comment'), text: 'Synthetic note' }],
          ['click', reference('Save training form')]
        ];
        const sequence = { operationIds: commands.map(() => randomUUID()) };
        for (const [index, [type, args]] of commands.entries()) {
          await mcp.act(type, args, sequence.operationIds[index], sequence, new AbortController().signal);
        }
        const final = await mcp.observe();
        const elapsedMillis = performance.now() - started;
        const saved = JSON.parse(await page.locator('output').textContent());
        assert.deepEqual(saved, { recipient: 'Training User', quantity: '2', city: 'Kazan',
          confirmed: 'on', comment: 'Synthetic note', saves: 1 });
        console.log(JSON.stringify({ scenario: size ? 'large' : 'form', run, warmup: run === 0,
          elapsedMillis, observationBytes: Buffer.byteLength(JSON.stringify(observed))
            + Buffer.byteLength(JSON.stringify(final)), rssBytes: process.memoryUsage().rss,
          metrics: final.metrics, correct: true, saves: saved.saves }));
      } finally {
        await mcp.close();
        await context.close();
      }
    }
  }
} finally { await browser.close(); }
