import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const installed = JSON.parse(await readFile(new URL('node_modules/playwright-core/package.json', root), 'utf8'));
if (installed.version !== manifest.dependencies['playwright-core']) {
  throw new Error('Playwright action completion patch requires the pinned playwright-core version');
}

const original = `async function waitForCompletion(tab2, callback) {
  const settleMs = tab2.context.config.timeouts?.settle ?? 500;
  const requests2 = [];
  const requestListener = (request2) => requests2.push(request2);
  const disposeListeners = () => {
    tab2.page.off("request", requestListener);
  };
  tab2.page.on("request", requestListener);
  let result2;
  try {
    result2 = await callback();
    await tab2.waitForTimeout(settleMs);
  } finally {
    disposeListeners();
  }
  const requestedNavigation = requests2.some((request2) => request2.isNavigationRequest());
  if (requestedNavigation) {
    await tab2.page.mainFrame().waitForLoadState("load", { timeout: 1e4 }).catch(() => {
    });
    return result2;
  }
  const promises2 = [];
  for (const request2 of requests2) {
    if (["document", "stylesheet", "script", "xhr", "fetch"].includes(request2.resourceType()))
      promises2.push(request2.response().then((r) => r?.finished()).catch(() => {
      }));
    else
      promises2.push(request2.response().catch(() => {
      }));
  }
  const timeout = new Promise((resolve) => setTimeout(resolve, 5e3));
  await Promise.race([Promise.all(promises2), timeout]);
  if (requests2.length)
    await tab2.waitForTimeout(settleMs);
  return result2;
}`;
const replacement = `async function waitForCompletion(_tab2, callback) {
  // Helm awaits the native action; page readiness is an explicit browser_wait_for.
  return await callback();
}`;

const bundle = new URL('node_modules/playwright-core/lib/coreBundle.js', root);
const source = await readFile(bundle, 'utf8');
const originalOffset = source.indexOf(original);
const replacementOffset = source.indexOf(replacement);
if (replacementOffset !== -1) {
  if (originalOffset !== -1 || replacementOffset !== source.lastIndexOf(replacement)) {
    throw new Error('Unexpected Playwright action completion patch state');
  }
} else {
  if (originalOffset === -1 || originalOffset !== source.lastIndexOf(original)) {
    throw new Error('Playwright action completion source changed; review the patch before building');
  }
  await writeFile(bundle, source.replace(original, replacement));
}
