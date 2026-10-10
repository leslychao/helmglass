// @playwright/mcp 0.0.83 / playwright-core 1.64.0-alpha-1790635538000.
// Upstream source: microsoft/playwright e8149b8257d32dcf8f72573ecc43e72439da7080.
// Patch the published bundle, not a second snapshot implementation. A changed
// upstream artifact must be reviewed before this patch can be applied again.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const target = require.resolve('playwright-core/lib/coreBundle');
const originalHash = 'cd6730be1bbcff00771a0fc1390f200306d28428ce68e305420ca623cb39cdeb';
const sha = text => createHash('sha256').update(text).digest('hex');
let bundle = readFileSync(target, 'utf8');
if (bundle.startsWith('// Helm bounded MCP')) {
  const manifest = JSON.parse(readFileSync(new URL('./playwright-core.sha256.json', import.meta.url), 'utf8'));
  if (sha(bundle) !== manifest.patched) throw new Error('Modified Playwright patch output');
  process.exit(0);
}
if (sha(bundle) !== originalHash) throw new Error('Unsupported Playwright bundle checksum');
const replace = (text, before, after) => {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before))
    throw new Error('Upstream patch anchor changed: ' + before.slice(0, 100));
  return text.replace(before, () => after);
};
const patch = (before, after) => { bundle = replace(bundle, before, after); };
const section = (start, end, transform) => {
  const from = bundle.indexOf(start), to = bundle.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Upstream section changed');
  bundle = bundle.slice(0, from) + transform(bundle.slice(from, to)) + bundle.slice(to);
};

const sourceMatch = bundle.match(/^    source5 = (.+);$/m);
if (!sourceMatch) throw new Error('Missing injected source');
let injected = runInNewContext(sourceMatch[1], {}, { timeout: 1000 });
if (sha(injected) !== '689c6920633661d8ab0cd743342414a6a586d9c420113194c699a59b093a1a76')
  throw new Error('Unsupported injected source checksum');
const inject = (before, after) => { injected = replace(injected, before, after); };

// Budgets are shared by successive frame captures. Reject before allocating a
// growing name/tree/string; depth in the upstream renderer alone is too late.
inject('var lastRef = 0;', `var lastRef = 0;
var helmBudget;
function helmLimit(reason) { throw new Error("HELM_SNAPSHOT_LIMIT_" + reason); }
function helmText(value) {
  if (helmBudget && typeof value === "string") {
    helmBudget.chars += value.length;
    if (helmBudget.chars > helmBudget.maxChars) helmLimit("TEXT");
    if (Date.now() > helmBudget.deadline) helmLimit("TIME");
  }
  return value;
}
function helmNode(node) {
  if (!helmBudget) return;
  if (node && !helmBudget.seenNodes.has(node)) {
    helmBudget.seenNodes.add(node);
    if (++helmBudget.nodes > helmBudget.maxNodes) helmLimit("NODES");
  }
  if (Date.now() > helmBudget.deadline) helmLimit("TIME");
  if (node && node.childNodes && node.childNodes.length > helmBudget.maxNodes) helmLimit("NODES");
  let ancestor = node, depth = 0;
  while (ancestor) {
    if (++depth > 64) helmLimit("DEPTH");
    ancestor = ancestor.parentNode || ancestor.host;
  }
}
function helmProtected(element, accessibleName = "") {
  if (!element || element.nodeType !== 1) return false;
  const typeValue = element.getAttribute("type") || "";
  const values = ["autocomplete", "name", "id", "aria-label"].map(key => element.getAttribute(key) || "");
  if (typeValue.length > 100 || values.some(value => value.length > 1000)) return true;
  const type = typeValue.toLowerCase();
  const hints = values.join(" ") + (element.matches('input, textarea, select, [contenteditable], [role="textbox"]') ? " " + accessibleName : "");
  return ["password", "hidden"].includes(type) || /password|passwd|one.?time.?code|otp|verification.?code|security.?code|cc-|cc_?(?:number|exp|csc)|card.?number|cvc|cvv|payment|парол|однораз|код.подтверж|номер.карт/i.test(hints);
}
function helmUrl(value) {
  helmText(value);
  try { const url = new URL(value, location.href); return ["https:", "http:", "about:"].includes(url.protocol) ? url.origin === "null" ? "about:blank" : url.origin + url.pathname : ""; }
  catch { return ""; }
}
`);
// These functions are the existing upstream accessible-name accumulation path.
for (const [signature, guard] of [
  ['function normalizeWhiteSpace(text) {', 'helmText(text);'],
  ['function trimFlatString(s) {', 'helmText(s);'],
  ['function asFlatString(s) {', 'helmText(s);'],
  ['function compositeString(text, element, collectElements) {', 'helmText(text);'],
  ['function getIdRefs(element, ref) {', 'helmText(ref);'],
  ['function parseCSSContentPropertyAsString(element, content, isPseudo) {', 'helmText(content);'],
  ['function getTextAlternativeInternal(element, options) {', 'helmNode(element); if (helmBudget && (element.getAttribute("type") === "hidden" || options.embeddedInLabelledBy?.hidden || options.embeddedInDescribedBy?.hidden || (helmProtected(element) && options.embeddedInTargetElement !== "self"))) return emptyCompositeString();'],
  ['function isElementHiddenForAria(element) {', 'helmNode(element);'],
  ['function belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element) {', 'helmNode(element);']
]) inject(signature, signature + '\n  ' + guard);
inject('function generateAriaTree(rootElement, publicOptions) {\n  const options = toInternalOptions(publicOptions);', `function generateAriaTree(rootElement, publicOptions) {\n  const options = toInternalOptions(publicOptions);
  if (helmBudget && rootElement.ownerDocument.getElementsByTagName("*").length > helmBudget.maxNodes) helmLimit();`);
inject('  const visit = (ariaNode, node, parentElementVisible) => {', '  const visit = (ariaNode, node, parentElementVisible) => {\n    helmNode(node);');
inject('    const element = node;\n    const isElementVisibleForAria', '    const element = node;\n    if (helmBudget && element.getAttribute("type") === "hidden") return;\n    const isElementVisibleForAria');
inject('      const text = node.nodeValue;\n      if (ariaNode.role', '      const text = helmText(node.nodeValue);\n      if (ariaNode.role');
inject('    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {', '    if (helmBudget && node.nodeType === Node.TEXT_NODE && node.length > helmBudget.maxChars) helmLimit();\n    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {');
// Upstream drops all textbox text nodes, including editable div values. Keep its
// native text traversal for contenteditable, under the same budget/privacy guard.
inject('if (ariaNode.role !== "textbox" && text)', 'if ((ariaNode.role !== "textbox" || node.parentElement?.isContentEditable) && text)');
inject('    processElement(childAriaNode || ariaNode, element, ariaChildren, visible);', '    if (!helmBudget || !helmProtected(element, childAriaNode?.name)) processElement(childAriaNode || ariaNode, element, ariaChildren, visible);');
inject('      ariaNode.props["url"] = truncateDataUrl(href);', '      ariaNode.props["url"] = helmBudget ? helmUrl(href) : truncateDataUrl(href);');
inject('      result.children = [element.value];', '      result.children = helmBudget && helmProtected(element, result.name) ? [] : [helmText(element.value)];');
inject('    const ids = element.getAttribute("aria-owns").split(/\\s+/);', '    const ids = helmText(element.getAttribute("aria-owns")).split(/\\s+/);');
inject('  const visit = (node, skipSlotted) => {', '  const visit = (node, skipSlotted) => {\n    helmNode(node);');
inject('      tokens.push(node.textContent || "");', '      tokens.push(helmText(node.textContent || ""));');
inject('        return compositeString(element.textContent, element, options.collectElements);', '        return helmBudget ? innerAccumulatedElementText(element, childOptions) : compositeString(element.textContent, element, options.collectElements);');
inject('          selectedOptions = [...element.selectedOptions];', '          if (helmBudget && element.options.length > helmBudget.maxNodes) helmLimit();\n          selectedOptions = [...element.selectedOptions];');
inject('        accumulated.push(element.getAttribute(attrName) || "");', '        accumulated.push(helmProtected(element) ? "" : helmText(element.getAttribute(attrName) || ""));');
inject('  return { text: parts.map((part) => part.text).join(separator), elements };', '  for (const part of parts) helmText(part.text);\n  return { text: parts.map((part) => part.text).join(separator), elements };');
// Use the native traversal for names too; NodeList materialization is only safe
// after a finite bound. This check applies to shadow roots as well as documents.
inject('function queryInAriaOwned(element, selector) {', `function queryInAriaOwned(element, selector) {
  if (helmBudget) {
    const result = [];
    const add = root => {
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        helmNode(node);
        if (node.matches(selector)) result.push(node);
      }
    };
    add(element);
    for (const owned of getIdRefs(element, element.getAttribute("aria-owns"))) {
      helmNode(owned);
      if (owned.matches(selector)) result.push(owned);
      add(owned);
    }
    return result;
  }`);
// All attribute values used by the ARIA algorithm are checked before splitting,
// normalizing or copying. Never instrument generic page evaluation/action code.
const ariaStart = injected.indexOf('function getAriaBoolean(');
const ariaEnd = injected.indexOf('function matchesStringOrRegex(', ariaStart);
let aria = injected.slice(ariaStart, ariaEnd);
aria = aria.replace(/(?<!helmText\()\b(element|node)\.getAttribute\(("[^"\n]+")\)/g, 'helmText($1.getAttribute($2))');
// The guard itself must not recursively account for its own predicate.
const helperStart = aria.indexOf('function helmProtected('), helperEnd = aria.indexOf('function helmUrl(', helperStart);
aria = aria.slice(0, helperStart) + aria.slice(helperStart, helperEnd).replace(/helmText\((element\.getAttribute\("[^"\n]+"\))\)/g, '$1') + aria.slice(helperEnd);
injected = injected.slice(0, ariaStart) + aria + injected.slice(ariaEnd);
inject('  ariaSnapshotJSON(node, options) {', `  ariaSnapshotJSON(node, options) {
    if (options.mode === "ai" && options.depth === -1) {
      this._lastAriaSnapshotForQuery = undefined;
      return { json: [], iframeRefs: [], iframeDepths: {} };
    }
    if (options.mode !== "ai") return this._helmAriaSnapshotJSON(node, options);
    if (helmBudget) throw new Error("HELM_SNAPSHOT_CONCURRENT");
    helmBudget = { ...options.helmBudget, nodes: 0, chars: 0, seenNodes: new WeakSet() };
    try {
      const result = this._helmAriaSnapshotJSON(node, options);
      helmText("");
      return { ...result, helmUsage: { nodes: helmBudget.nodes, chars: helmBudget.chars } };
    } finally { helmBudget = undefined; }
  }
  _helmAriaSnapshotJSON(node, options) {`);
patch(sourceMatch[0], '    source5 = ' + JSON.stringify(injected) + ';');

section('async function ariaSnapshotJSONForFrame(', '\nfunction ensureArrayLimit(', text => {
  text = text.replace('options = {}) {', `options = {}, helmBudget = { maxNodes: 20000, maxChars: 262144, frames: 20, deadline: Date.now() + 20000 }) {
  if (--helmBudget.frames < 0 || Date.now() > helmBudget.deadline) throw new Error("HELM_SNAPSHOT_LIMIT");`);
  text = text.replace('boxes: options.boxes\n', 'boxes: options.boxes, helmBudget\n');
  text = text.replace('      if (frame.isNonRetriableError(e))', '      if (String(e).includes("HELM_SNAPSHOT_") || frame.isNonRetriableError(e))');
  text = text.replace('  const renderedIframeRefs =', `  if (snapshot3.helmUsage) {
    helmBudget.maxNodes -= snapshot3.helmUsage.nodes;
    helmBudget.maxChars -= snapshot3.helmUsage.chars;
  }
  const renderedIframeRefs =`);
  const from = text.indexOf('  progress2.setAllowConcurrentOrNestedRaces(true);');
  const to = text.indexOf('  const mergeIframeChildren', from);
  text = text.slice(0, from) + `  const childSnapshots = [];
  for (const ref of renderedIframeRefs) {
    const childDepth = options.depth ? options.depth - snapshot3.iframeDepths[ref] - 1 : undefined;
    const frameRootSelector = \`aria-ref=\${ref} >> internal:control=enter-frame >> body,frameset\`;
    childSnapshots.push(await ariaSnapshotJSONForFrame(progress2, snapshot3.resolvedFrame, frameRootSelector, { ...options, depth: childDepth, strict: false }, helmBudget));
  }
` + text.slice(to);
  return text;
});

section('    Tab = class _Tab ', '// packages/playwright-core/src/tools/backend/context.ts', text => {
  text = text.replace(/^          eventsHelper.addEventListener\(p, "(?:console|pageerror|request|response|requestfailed)".*\n/gm, '');
  text = text.replace(/,\n          eventsHelper.addEventListener\(p, "download", \(download\) => \{[\s\S]*?\n          \}\)/, '');
  text = text.replace(/        for \(const message of await _Tab.collectConsoleMessages[\s\S]*?        for \(const initPage/, '        for (const initPage');
  text = text.replace('        this._consoleLog.stop();\n      }\n      async waitForInitialized()', `        await this._initializedPromise;
        await this._consoleLog.stop();
        this._modalStates.length = 0;
        this._recentEventEntries.length = 0;
        this._requests.length = 0;
        this._downloads.length = 0;
        if (this.page[tabSymbol] === this) delete this.page[tabSymbol];
      }
      async waitForInitialized()`);
  text = text.replace('title = await this.page.title();', 'title = await this.page.evaluate(() => document.title.slice(0, 1000));');
  text = text.replace('consoleCounts = await this.consoleMessageCount();', 'consoleCounts = { total: 0, errors: 0, warnings: 0 };');
  text = text.replace('url: this.page.url(),', 'url: this.page.url().split(/[?#]/, 1)[0].replace(/^(https?:\\/\\/)[^/]*@/, "$1"),');
  text = text.replace('description: `"${dialog.type()}" dialog with message "${dialog.message()}"`,', 'description: `"${dialog.type()}" dialog`,');
  text = text.replace('        this._recentEventEntries.push(entry);', '        if (this._recentEventEntries.length < 20) this._recentEventEntries.push(entry);');
  text = text.replace('this.actionTimeoutOptions = { timeout: context.config.timeouts?.action };', 'Object.defineProperty(this, "actionTimeoutOptions", { get: () => ({ timeout: context.config.timeouts?.action, signal: context.helmSignal }) });');
  text = text.replace('this.navigationTimeoutOptions = { timeout: context.config.timeouts?.navigation };', 'Object.defineProperty(this, "navigationTimeoutOptions", { get: () => ({ timeout: context.config.timeouts?.navigation, signal: context.helmSignal }) });');
  // normalize() generates a role/CSS selector that can later select a replacement
  // element. Actions must retain the native identity-bound aria-ref locator.
  text = text.replace('const resolved = await locator2.normalize();', 'const resolved = locator2;');
  text = text.replace('      logErrorMessage(text2) {\n        this._handleConsoleMessage(pageErrorToConsoleMessage(new Error(text2)));\n      }', '      logErrorMessage() {}');
  text = text.replaceAll('{ mode: "ai", depth, boxes }', '{ mode: "ai", depth, boxes, timeout: 20000, signal: this.context.helmSignal }');
  const raceStart = text.indexOf('      async _raceAgainstModalStates(action) {');
  const raceEnd = text.indexOf('      async waitForCompletion(callback) {', raceStart);
  if (raceStart < 0 || raceEnd < 0) throw new Error('Modal race patch anchor changed');
  text = text.slice(0, raceStart) + `      async _raceAgainstModalStates(action) {
        if (this.modalStates().length) throw new Error("HELM_MODAL_BLOCKED");
        await action();
        return [];
      }
` + text.slice(raceEnd);
  return text;
});
// Helm does not consume MCP network diagnostics. The stock settle helper collects
// every request and leaves response promises pending after a race timeout.
section('async function waitForCompletion(tab2, callback) {', '\nfunction eventWaiter(', () => `async function waitForCompletion(tab2, callback) {
  const result = await callback();
  await new Promise(resolve => setTimeout(resolve, tab2.context.config.timeouts?.settle ?? 500));
  return result;
}
`);
section('    LogFile = class {', '// packages/playwright-core/src/tools/backend/tab.ts', text => text
  .replace('        this._stopped = true;', '        this._stopped = true;\n        return this._writeChain;'));
section('      async ensureTab() {', '      async closeTab(index)', () => `      async ensureTab() {
        await this.ensureBrowserContext();
        if (!this._currentTab || this._currentTab.crashed || this._currentTab.page.isClosed())
          throw new Error("HELM_PAGE_UNAVAILABLE");
        await this._currentTab.waitForInitialized();
        return this._currentTab;
      }
`);
patch('        this._browserContext.once("close", markDisconnected);', '        this._helmMarkDisconnected = markDisconnected;\n        this._browserContext.once("close", markDisconnected);');
patch(`      async dispose() {
        if (this._disposed)
          return;
        this._disposed = true;
        await this._context?.dispose().catch((e) => debug10("pw:tools:error")(e));
        await this._disposeCallback?.().catch((e) => debug10("pw:tools:error")(e));
      }`, `      async dispose() {
        return this._helmDispose ??= (async () => {
          this._disposed = true;
          this._browserContext.off("close", this._helmMarkDisconnected);
          this._browserContext.browser()?.off("disconnected", this._helmMarkDisconnected);
          await this._context?.dispose();
          await this._disposeCallback?.();
        })();
      }`);
patch('        const context = this._context;\n        let parsedArguments;', '        const context = this._context;\n        if (this._disposed) throw new Error("HELM_MCP_CLOSED");\n        context.helmSignal = signal;\n        let parsedArguments;');
patch('          context.setRunningTool(void 0);', '          context.setRunningTool(void 0);\n          context.helmSignal = undefined;');
section('    Context = class {', '// packages/playwright-core/src/tools/backend/response.ts', text => text
  .replace('        this._tabs = [];', '        this._tabs = [];\n        this._helmClosedDisposals = new Set();')
  .replace('          this._pendingUnhandledRejections.push(reason);', '          if (!this._pendingUnhandledRejections.length) this._pendingUnhandledRejections.push(new Error("HELM_MCP_FAILED"));')
  .replace('        this._tabs.splice(index, 1);', `        this._tabs.splice(index, 1);
        const pending = tab2.dispose();
        this._helmClosedDisposals.add(pending);
        pending.then(() => this._helmClosedDisposals.delete(pending), () => {
          this._helmDisposeError = new Error("HELM_MCP_DISPOSAL_FAILED");
          this._helmClosedDisposals.delete(pending);
        });`)
  .replace('        this._tabs.length = 0;', `        await Promise.all(this._helmClosedDisposals);
        this._pendingUnhandledRejections.length = 0;
        this._unhandledRejectionListeners.clear();
        this._tabs.length = 0;
        if (this._helmDisposeError) throw this._helmDisposeError;`));
// Keep the backend and all in-flight handlers alive until disposal has completed.
section('function createServer(name, version3, factory, transportInitialized, runHeartbeat) {', '\nfunction addServerListener(', text => {
  text = text.replace('  let backendPromise;', '  let backendPromise;\n  let closing;\n  const active = new Set();');
  text = text.replace('    serverDebug("callTool", request2);', '');
  text = text.replace('      serverDebugResponse("callResult", mergedResult);', '');
  text = text.replace('  const onClose = () => backendPromise?.then((b) => b.dispose?.()).catch(serverDebug);', `  const originalClose = server.close.bind(server);
  server.close = () => closing ??= Promise.resolve().then(async () => {
    await originalClose();
    await Promise.allSettled([...active]);
    await (await backendPromise)?.dispose?.();
  });
  const onClose = () => { void server.close().catch(() => {}); };`);
  text = text.replace('  server.setRequestHandler(CallToolRequestSchema, async (request2, extra) => {', `  const handle = async (request2, extra) => {`);
  text = text.replace(/          backend2.once\("disconnected", \(\) => \{[\s\S]*?\n          \}\);/, '          backend2.once("disconnected", onClose);');
  text = text.replace('  });\n  return server;', `  };
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    if (closing) throw new Error("HELM_MCP_CLOSED");
    const pending = handle(request, extra);
    active.add(pending);
    void pending.then(() => active.delete(pending), () => active.delete(pending));
    return pending;
  });
  return server;`);
  text = text.replace('"### Error\\n" + String(error)', '"HELM_MCP_FAILED"');
  return text;
});
// No raw site exception is exposed or retained in an MCP result.
section('    BrowserBackend = class', '// packages/playwright-core/src/tools/backend/common.ts', text => text
  .replace('const messages = [String(error), ...context.drainPendingUnhandledRejections().map(formatRejectionReason)];', 'context.drainPendingUnhandledRejections();\n          const messages = [String(error).match(/HELM_SNAPSHOT_LIMIT(?:_(?:TEXT|TIME|NODES|DEPTH))?/)?.[0] ?? "HELM_MCP_FAILED"];'));
bundle = '// Helm bounded MCP; see patches/playwright-core.mjs\n' + bundle;
const manifestPath = new URL('./playwright-core.sha256.json', import.meta.url);
if (process.argv.includes('--record')) {
  writeFileSync(manifestPath, JSON.stringify({ upstream: originalHash, patched: sha(bundle) }, null, 2) + '\n');
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.upstream !== originalHash || manifest.patched !== sha(bundle)) throw new Error('Playwright patch checksum mismatch');
}
writeFileSync(target, bundle);
