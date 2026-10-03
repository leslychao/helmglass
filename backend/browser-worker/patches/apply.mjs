import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Upstream e8149b8257d32dcf8f72573ecc43e72439da7080. Lifecycle only;
// native ARIA, refs, actionability and browser/context ownership are unchanged.
const path = fileURLToPath(new URL('../node_modules/playwright-core/lib/coreBundle.js', import.meta.url));
const expected = 'cd6730be1bbcff00771a0fc1390f200306d28428ce68e305420ca623cb39cdeb';
const marker = '// Helm awaitable disposal v1';
let source = await readFile(path, 'utf8');
if (source.startsWith(marker)) {
  process.stdout.write('Pinned lifecycle patch already applied.\n');
  process.exit(0);
}
if (createHash('sha256').update(source).digest('hex') !== expected) {
  throw new Error('Pinned Playwright bundle digest mismatch; refusing to patch another release.');
}
function replace(before, after) {
  if (source.split(before).length !== 2) {
    throw new Error('Upstream lifecycle patch does not apply uniquely.');
  }
  source = source.replace(before, after);
}
replace('        this._writeChain = this._writeChain.then(() => this._write(wallTime, text2)).catch((e) => debug5("pw:tools:error")(e));',
  '        if (this._stopped) return;\n        this._writeChain = this._writeChain.then(() => this._write(wallTime, text2)).catch((e) => { this._writeFailure ??= e; });');
replace('      stop() {\n        this._stopped = true;\n      }\n      async take(relativeTo)',
  '      stop() {\n        this._stopped = true;\n        return this._writeChain.then(() => { if (this._writeFailure) throw this._writeFailure; });\n      }\n      async take(relativeTo)');
replace('        this._onPageClose = onPageClose;\n        const p = page;',
  '        this._onPageClose = onPageClose;\n        this._backgroundWork = [];\n        const p = page;');
replace('            this._downloadStarted(download).catch((e) => debug6("pw:tools:error")(e));',
  '            const work = this._downloadStarted(download);\n            this._backgroundWork.push(work);\n            work.catch(() => {});');
replace('      async dispose() {\n        await disposeAll(this._disposables);\n        this._consoleLog.stop();\n      }',
  '      dispose() {\n        return this._disposePromise ??= (async () => {\n          await disposeAll(this._disposables);\n          await this._initializedPromise;\n          await Promise.all(this._backgroundWork);\n          await this._consoleLog.stop();\n          delete this.page[tabSymbol];\n          this._requests.length = 0;\n          this._downloads.length = 0;\n          this._recentEventEntries.length = 0;\n        })();\n      }');
replace('        this._consoleLog.stop();\n        this._consoleLog = new LogFile(this.context, wallTime, "console", "Console");',
  '        const work = this._consoleLog.stop();\n        this._backgroundWork.push(work);\n        work.catch(() => {});\n        this._consoleLog = new LogFile(this.context, wallTime, "console", "Console");');
replace('        process.off("unhandledRejection", this._onUnhandledRejection);\n        await this.stopRecording();',
  '        process.off("unhandledRejection", this._onUnhandledRejection);\n        await this._browserContextPromise;\n        await this.stopRecording();');
replace('        this._browserContext.once("close", markDisconnected);',
  '        this._markDisconnected = markDisconnected;\n        this._browserContext.once("close", markDisconnected);');
replace('      async dispose() {\n        if (this._disposed)\n          return;\n        this._disposed = true;\n        await this._context?.dispose().catch((e) => debug10("pw:tools:error")(e));\n        await this._disposeCallback?.().catch((e) => debug10("pw:tools:error")(e));\n      }',
  '      dispose() {\n        return this._disposePromise ??= (async () => {\n          this._disposed = true;\n          this._browserContext.off("close", this._markDisconnected);\n          this._browserContext.browser()?.off("disconnected", this._markDisconnected);\n          await this._context?.dispose();\n          await this._disposeCallback?.();\n        })();\n      }');
replace('      async callTool(name, rawArguments = {}, signal) {\n        this._idleTimer?.poke();',
  '      async callTool(name, rawArguments = {}, signal) {\n        if (this._disposed) throw new Error("Browser backend disposed");\n        this._idleTimer?.poke();');
replace('  const onClose = () => backendPromise?.then((b) => b.dispose?.()).catch(serverDebug);\n  addServerListener(server, "close", onClose);',
  '  let closing = false;\n  let disposalPromise;\n  let closePromise;\n  const activeCalls = new Set();\n  const disposeBackend = () => disposalPromise ??= (async () => {\n    closing = true;\n    await Promise.all(activeCalls);\n    const backend = await backendPromise;\n    await backend?.dispose?.();\n  })();\n  const transportClose = server.close.bind(server);\n  server.close = () => closePromise ??= (async () => {\n    await disposeBackend();\n    await transportClose();\n  })();\n  addServerListener(server, "close", () => { void disposeBackend().catch(() => {}); });');
replace('    serverDebug("callTool", request2);\n    try {',
  '    if (closing) throw new Error("Browser backend closing");\n    let finishCall;\n    const completion = new Promise((resolve) => { finishCall = resolve; });\n    activeCalls.add(completion);\n    serverDebug("callTool", request2);\n    try {');
replace('        isError: true\n      };\n    }\n  });\n  return server;\n}',
  '        isError: true\n      };\n    } finally {\n      activeCalls.delete(completion);\n      finishCall();\n    }\n  });\n  return server;\n}');
replace('          backend2.once("disconnected", () => {\n            if (backendPromise === promise)\n              backendPromise = void 0;\n            void backend2.dispose?.().catch(serverDebug);\n          });',
  '          backend2.once("disconnected", () => {\n            closing = true;\n            void disposeBackend().catch(() => {});\n          });');
source = `${marker}\n${source}`;
await writeFile(path, source);
process.stdout.write(`Applied lifecycle patch: ${createHash('sha256').update(source).digest('hex')}\n`);
