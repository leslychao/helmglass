from pathlib import Path
p=Path('backend/browser-node/src/server.ts')
s=p.read_text(encoding='utf-8')
s=s.replace('  initializing: z.boolean().default(false),', '''  initializing: z.boolean().default(false),
  startDeadlineAt: z.string().datetime().optional(), closeRequested: z.boolean().default(false),
  runtimeStoppedAt: z.string().datetime().optional(), cleanupComplete: z.boolean().default(false),
  pendingOperation: z.object({ id: z.string(), deadlineAt: z.string().datetime(),
    cancelAt: z.string().datetime().optional(), kind: z.enum(["COMMAND", "CONTROL", "PROFILE"]) }).optional(),''')
s=s.replace('const CreateSession = z.object({ sessionId:', 'const CreateSession = z.object({ deadlineAt: z.string().datetime().optional(), sessionId:')
s=s.replace('function save(session: Session): Session {', '''function save(session: Session): Session {
  const previous = db.prepare("SELECT document FROM sessions WHERE id=?").get(session.id);
  if (typeof previous?.["document"] === "string") {
    const state = Session.parse(JSON.parse(previous["document"]));
    if (state.closeRequested && !session.closeRequested) throw new HttpError(409, "Session closing");
    if (state.runtimeStoppedAt && !session.runtimeStoppedAt) throw new HttpError(409, "Session stopped");
  }''')
s=s.replace('profileConnectionId: session.connectionId, profileRevision:', '''runtimeStoppedAt: session.runtimeStoppedAt ?? null,
    cleanupState: session.cleanupComplete ? "COMPLETE" : session.runtimeStoppedAt ? "PENDING" : "NONE",
    profileConnectionId: session.connectionId, profileRevision:''')
s=s.replace('initializing: true, token:', 'initializing: true, startDeadlineAt: input.deadlineAt ?? new Date(Date.now() + 360_000).toISOString(), closeRequested: false, cleanupComplete: false, token:')
s=s.replace('  const prefix = `helm-browser-${session.id}`;\n  if (!session.networkId)', '''  if (session.closeRequested || session.startDeadlineAt && Date.parse(session.startDeadlineAt) <= Date.now()) {
    return closeSession(session);
  }
  const prefix = `helm-browser-${session.id}`;
  if (!session.networkId)''')
s=s.replace('  for (let attempt = 0; attempt < 40; attempt += 1) {\n    try {', '''  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (saved(session.id).closeRequested) throw new HttpError(409, "Session closing");
    if (session.startDeadlineAt && Date.parse(session.startDeadlineAt) <= Date.now()) throw new HttpError(408, "Startup deadline exceeded");
    try {''')
s=s.replace('await new Promise((resolve) => setTimeout(resolve, 500));', 'if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, [1000, 3000, 10000][attempt]));')
s=s.replace('  return save({ ...session, status: "UNKNOWN" });\n}\nasync function startSession', '  return save({ ...session, status: "LOST", initializing: false });\n}\nasync function startSession')
start=s.index('async function finishClose(id: string): Promise<Session> {')
end=s.index('function recordRuntimeState',start)
s=s[:start]+'''async function finishClose(id: string): Promise<Session> {
  let session = saved(id);
  if (session.runtimeStoppedAt) return session;
  save({ ...session, closeRequested: true, status: "CLOSING" });
  disconnectViewers(id, "session_closed");
  try {
    // Creation observes closeRequested at every durable resource boundary. Never wait forever.
    const creator = starting.get(id);
    if (creator) {
      const settled = await Promise.race([creator.then(() => true, () => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 10_000))]);
      if (!settled) return saved(id);
    }
    session = saved(id);
    const container = await inspect(session.containerId ?? `helm-browser-${id}`);
    if (container?.State.Running) await docker(`/containers/${container.Id}/stop?t=10`, "POST");
    const stopped = await inspect(session.containerId ?? `helm-browser-${id}`);
    if (stopped?.State.Running) return saved(id);
    const egress = await inspect(session.egressId ?? `helm-browser-${id}-egress`);
    if (egress?.State.Running) await docker(`/containers/${egress.Id}/stop?t=1`, "POST");
    const stoppedEgress = await inspect(session.egressId ?? `helm-browser-${id}-egress`);
    if (stoppedEgress?.State.Running) return saved(id);
    // Keep the original volume and receipts until the API acknowledges verified delivery.
    return save({ ...saved(id), status: "CLOSED", initializing: false,
      runtimeStoppedAt: new Date().toISOString(), pendingOperation: undefined });
  } catch { return save({ ...saved(id), status: "UNKNOWN" }); }
}

let archiveBusy = false;
let archiveSession: string | undefined;
async function withArchive(session: Session, work: (reader: Session) => Promise<void>): Promise<void> {
  if (!session.runtimeStoppedAt || session.cleanupComplete) throw new HttpError(409, "Archive unavailable");
  if (archiveBusy) throw new HttpError(409, "Archive reader busy");
  archiveBusy = true;
  const name = `helm-archive-${config.nodeId}`;
  try {
    let reader = await inspect(name);
    if (reader && archiveSession !== session.id) { await removeDocker(`/containers/${reader.Id}?force=true`); reader = undefined; }
    if (!reader) {
      const networkName = `helm-browser-${session.id}`;
      try { await docker(`/networks/${networkName}`); }
      catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        await docker("/networks/create", "POST", { Name: networkName, Driver: "bridge", Internal: true,
          Labels: { "helmglass.node": config.nodeId, "helmglass.session": session.id } });
      }
      const manager = await inspect(config.self);
      if (!manager?.NetworkSettings.Networks[networkName]) {
        await docker(`/networks/${networkName}/connect`, "POST", { Container: config.self });
      }
      const created = DockerIdentity.parse(await (await docker(`/containers/create?name=${name}`, "POST", {
        Image: config.sessionImage, Entrypoint: ["node", "/app/dist/archive-reader.js"], User: "1000:1000",
        Env: [`SESSION_TOKEN=${session.token}`], Labels: { "helmglass.node": config.nodeId, "helmglass.archive": "true" },
        HostConfig: { NetworkMode: networkName, ReadonlyRootfs: true, CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"], Memory: 268_435_456, PidsLimit: 32,
          Mounts: [{ Type: "volume", Source: `helm-browser-${session.id}-data`, Target: "/data", ReadOnly: true }],
          LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "1" } } },
      })).json());
      await docker(`/containers/${created.Id}/start`, "POST");
      reader = await inspect(created.Id); archiveSession = session.id;
    }
    const address = reader?.NetworkSettings.Networks[`helm-browser-${session.id}`]?.IPAddress;
    if (!address) throw new HttpError(502, "Archive reader unavailable");
    const target = { ...session, address };
    for (let attempt = 0; ; attempt++) {
      try { await sessionJson(target, "/health"); break; }
      catch (error) { if (attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, [1000, 3000, 10000][attempt])); }
    }
    await work(target);
  } finally { archiveBusy = false; }
}

async function cleanupSession(session: Session): Promise<Session> {
  if (!session.runtimeStoppedAt) throw new HttpError(409, "Execution stop is not confirmed");
  if (session.cleanupComplete) return session;
  if (archiveBusy) throw new HttpError(409, "Archive reader busy");
  archiveBusy = true;
  try {
    // Remove a reader left by this or a previous node process before removing its source volume.
    await removeDocker(`/containers/helm-archive-${config.nodeId}?force=true`);
    archiveSession = undefined;
    await removeDocker(`/containers/${session.containerId ?? `helm-browser-${session.id}`}?v=true`);
    await removeDocker(`/containers/${session.egressId ?? `helm-browser-${session.id}-egress`}?force=true`);
    const network = session.networkId ?? `helm-browser-${session.id}`;
    const manager = await inspect(config.self);
    if (manager?.NetworkSettings.Networks[`helm-browser-${session.id}`]) {
      await docker(`/networks/${network}/disconnect`, "POST", { Container: config.self, Force: true });
    }
    await removeDocker(`/networks/${network}`);
    await removeDocker(`/volumes/helm-browser-${session.id}-data`);
    return save({ ...saved(session.id), cleanupComplete: true });
  } finally { archiveBusy = false; }
}

async function watchDeadlines(): Promise<void> {
  const candidates = summaries().filter(session => session.closeRequested
    || session.initializing && session.startDeadlineAt && Date.parse(session.startDeadlineAt) <= Date.now()
    || session.pendingOperation && Date.parse(session.pendingOperation.deadlineAt) <= Date.now());
  await Promise.allSettled(candidates.slice(0, 20).map(async session => {
    if (session.closeRequested || session.initializing) { await closeSession(session); return; }
    const operation = session.pendingOperation;
    if (!operation) return;
    if (!operation.cancelAt) {
      save({ ...saved(session.id), pendingOperation: { ...operation, cancelAt: new Date().toISOString() } });
      if (operation.kind === "COMMAND") {
        try { await sessionJson(session, `/commands/${operation.id}/cancel`, "POST", {}); } catch { /* Stop is independently confirmed below. */ }
      }
    } else if (Date.parse(operation.cancelAt) + 10_000 <= Date.now()) {
      await closeSession(session);
    }
  }));
}
let checkingDeadlines = false;
setInterval(() => {
  if (checkingDeadlines) return;
  checkingDeadlines = true;
  void watchDeadlines().finally(() => { checkingDeadlines = false; });
}, 1000).unref();

''' +s[end:]
s=s.replace('if (current.status === "CLOSED" || current.status === "CLOSING") return current;', 'if (current.closeRequested || current.runtimeStoppedAt) return current;')
s=s.replace('z.object({ Labels: z.record(z.string(), z.string()) })', 'z.object({ Labels: z.record(z.string(), z.string()), State: z.string() })')
s=s.replace('const id = container.Labels["helmglass.session"]; if (id) occupied.add(id);', 'const id = container.Labels["helmglass.session"]; if (id && container.State === "running") occupied.add(id);')
# A missing node record is not evidence of process loss; inspect Docker names first.
s=s.replace('    let session = saved(z.uuid().parse(segments[1]));', '''    const sessionId = z.uuid().parse(segments[1]);
    let session: Session;
    try { session = saved(sessionId); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404 || request.method !== "GET" || segments.length !== 2) throw error;
      const runtime = await inspect(`helm-browser-${sessionId}`);
      const egress = await inspect(`helm-browser-${sessionId}-egress`);
      reply(response, 200, { id: sessionId, status: !runtime && !egress ? "LOST" : "UNKNOWN",
        runtimeStoppedAt: !runtime && !egress ? new Date().toISOString() : null }); return;
    }
    if (segments[2] === "cleanup" && request.method === "DELETE") {
      reply(response, 200, summary(await cleanupSession(session))); return;
    }
    if (session.runtimeStoppedAt && request.method === "GET" && ["artifacts", "commands"].includes(segments[2] ?? "")) {
      const endpoint = '/' + segments.slice(2).join('/') + url.search;
      await withArchive(session, async reader => {
        const upstream = await sessionRequest(reader, endpoint);
        response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json",
          ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length")! } : {}) });
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response); else response.end();
      });
      return;
    }''')
s=s.replace('if (session.status === "CLOSED" || session.status === "LOST") { reply', 'if (session.status === "CLOSED") { reply')
s=s.replace('if (session.initializing) {\n        const result', 'if (session.closeRequested || session.status === "LOST") { reply(response, 200, summary(await closeSession(session))); return; }\n      if (session.initializing) {\n        const result')
s=s.replace('restoreProfile: session.restoreProfile ?? true });', 'restoreProfile: session.restoreProfile ?? true, deadlineAt: session.startDeadlineAt });')
s=s.replace('"/resolve" : ""}`', '"/resolve" : segments[4] === "cancel" ? "/cancel" : ""}`')
s=s.replace('const command = z.object({ operationId: z.uuid(), type: z.string(), arguments:', 'const command = z.object({ deadlineAt: z.string().datetime(), operationId: z.uuid(), type: z.string(), arguments:')
s=s.replace('''        if (command.type === "applyConnection") {''','''        if (Date.parse(command.deadlineAt) <= Date.now()) throw new HttpError(408, "Operation deadline exceeded");
        const pending = saved(session.id).pendingOperation;
        if (pending && pending.id !== command.operationId) throw new HttpError(409, "Operation in progress");
        if (!pending) save({ ...saved(session.id), pendingOperation: { id: command.operationId, kind: "COMMAND", deadlineAt: command.deadlineAt } });
        if (command.type === "applyConnection") {''')
s=s.replace('''      reconcileAppliedConnection(session.id, result);
      reply(response, 200, result); return;''', '''      reconcileAppliedConnection(session.id, result);
      const receipt = z.object({ operationId: z.string(), status: z.string() }).safeParse(result);
      if (receipt.success && receipt.data.status !== "RUNNING" && saved(session.id).pendingOperation?.id === receipt.data.operationId) {
        save({ ...saved(session.id), pendingOperation: undefined });
      }
      reply(response, 200, result); return;''')
s=s.replace('''      const policy = Policy.parse(await body(request));''', '''      const input = Policy.extend({ deadlineAt: z.string().datetime().optional() }).parse(await body(request));
      const policy = Policy.parse(input);
      const deadlineAt = input.deadlineAt ?? new Date(Date.now() + 30_000).toISOString();
      if (Date.parse(deadlineAt) <= Date.now()) throw new HttpError(408, "Control deadline exceeded");
      save({ ...saved(session.id), pendingOperation: { id: `control:${policy.controlEpoch}`, kind: "CONTROL", deadlineAt } });''')
s=s.replace('if (JSON.stringify(policy) === JSON.stringify(session.policy)) { reply(response, 200, await sessionJson(session, "/control", "POST", policy)); return; }','')
s=s.replace('if (current.policy.controlEpoch <= policy.controlEpoch) save({ ...current, policy });', 'if (!current.closeRequested && current.policy.controlEpoch <= policy.controlEpoch) save({ ...current, policy, pendingOperation: undefined });')
p.write_text(s,encoding='utf-8',newline='\n')
