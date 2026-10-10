from pathlib import Path
p=Path('backend/browser-session/src/server.ts')
s=p.read_text(encoding='utf-8')
s=s.replace('import { BrowserMcp, BrowserRejection } from "./browser-mcp.js";', 'import { BrowserMcp, BrowserRejection } from "./browser-mcp.js";\nimport { artifactResponse, operationReceipt } from "./session-records.js";')
start=s.index('function receipt(id: string): object | undefined {')
end=s.index('async function execute(',start)
s=s[:start]+'''function receipt(id: string): object | undefined {
  return operationReceipt(db, id);
}
'''+s[end:]
start=s.index('    const artifact = /^\\/artifacts')
end=s.index('    throw new HttpError(404, "Route not found");',start)
s=s[:start]+'''    if (url.pathname.startsWith("/artifacts") && request.method === "GET") {
      if (url.searchParams.get("archive") !== "true") observationAllowed();
      if (await artifactResponse(db, dataDirectory, url, response)) return;
    }
'''+s[end:]
s=s.replace('const Command = z.object({ operationId:', 'const Command = z.object({ deadlineAt: z.string().datetime(), operationId:')
s=s.replace('  observationAllowed();\n  if ((command.type', '''  if (Date.parse(command.deadlineAt) <= Date.now()) throw new BeforeEffectRejection(408, "Operation deadline exceeded");
  observationAllowed();
  if ((command.type''')
s=s.replace('  try {\n    let result = await perform(command, abort.signal);', '''  const deadlineTimer = setTimeout(() => abort.abort(new Error("Operation deadline exceeded")),
    Math.max(0, Date.parse(command.deadlineAt) - Date.now()));
  const terminationTimer = setTimeout(() => {
    if (activeOperation === command.operationId) {
      db.prepare("UPDATE operations SET status=? WHERE id=? AND status='RUNNING'")
        .run(readCommands.has(command.type) ? "FAILED" : "UNKNOWN", command.operationId);
      // The node also confirms and stops the entire container, including X11.
      process.exit(1);
    }
  }, Math.max(0, Date.parse(command.deadlineAt) + 10_000 - Date.now()));
  try {
    let result = await perform(command, abort.signal);''')
s=s.replace('    if (command.controlEpoch !== policy.controlEpoch) throw', '    abort.signal.throwIfAborted();\n    if (command.controlEpoch !== policy.controlEpoch) throw')
s=s.replace('  } finally { activeOperation = undefined; activeAbort = undefined; }', '  } finally { clearTimeout(deadlineTimer); clearTimeout(terminationTimer); activeOperation = undefined; activeAbort = undefined; }')
s=s.replace('    const resolve = /^\\/commands', '''    const cancel = /^\\/commands\\/([^/]+)\\/cancel$/.exec(url.pathname);
    if (cancel?.[1] && request.method === "POST") {
      const id = z.uuid().parse(cancel[1]);
      if (activeOperation === id) activeAbort?.abort(new Error("Operation cancelled"));
      reply(response, 200, receipt(id) ?? { operationId: id, status: "FAILED", code: "NOT_DISPATCHED" });
      return;
    }
    const resolve = /^\\/commands''')
p.write_text(s,encoding='utf-8',newline='\n')
