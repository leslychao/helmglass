import { DatabaseSync } from "node:sqlite";
import { lstat } from "node:fs/promises";
import { z } from "zod";

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
const endpoint = required("DOCKER_HOST");
const nodeId = z.uuid().parse(required("NODE_ID"));
const db = new DatabaseSync("/data/node.sqlite");
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
async function docker(route: string, method = "GET", value?: unknown): Promise<unknown> {
  const response = await fetch(endpoint + route, { method, signal: AbortSignal.timeout(360_000),
    headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) { await response.body?.cancel(); throw new Error("Migration Docker operation failed"); }
  const chunks: Buffer[] = []; let size = 0;
  if (response.body) for await (const raw of response.body) {
    size += raw.length;
    if (size > 2_097_152) { await response.body.cancel().catch(() => {}); throw new Error("Docker reply too large"); }
    chunks.push(Buffer.from(raw));
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
}
const Inspect = z.object({ Id: z.string(), Image: z.string(), State: z.object({ Running: z.boolean() }),
  Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional(), Destination: z.string() })) });
async function inspect(name: string) { const value = await docker(`/containers/${encodeURIComponent(name)}/json`); return value === undefined ? undefined : Inspect.parse(value); }
const own = await inspect(required("HOSTNAME"));
const mount = own?.Mounts.find(value => value.Destination === "/artifacts");
if (!own || mount?.Type !== "volume" || !mount.Name) throw new Error("Artifacts volume mount is required");
const volume = mount.Name;
const Session = z.object({ id: z.uuid(), status: z.string(), containerId: z.string().optional(),
  runtimeStoppedAt: z.string().optional(), cleanupComplete: z.boolean().optional(),
  recordsAcknowledged: z.boolean().optional(),
  storageVersion: z.literal(1).optional() }).passthrough();
const oldVolumes = z.object({ Volumes: z.array(z.object({ Name: z.string() })).nullable() }).parse(await docker("/volumes"));
for (const candidate of oldVolumes.Volumes ?? []) {
  const match = /^helm-browser-([0-9a-f-]{36})-data$/.exec(candidate.Name);
  if (!match?.[1]) continue;
  const id = z.uuid().parse(match[1]);
  if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id)) throw new Error("Unknown browser volume prevents migration");
}
const reader = await inspect(`helm-archive-${nodeId}`);
if (reader) await docker(`/containers/${reader.Id}?force=true`, "DELETE");
const helperName = `helm-session-migration-${nodeId}`;
const leftover = await inspect(helperName);
if (leftover) await docker(`/containers/${leftover.Id}?force=true`, "DELETE");
let migrated = 0;
try {
  // Bounded iteration; the node registry, not Docker naming alone, owns session identity.
  for (const row of db.prepare("SELECT id,document FROM sessions ORDER BY id").iterate()) {
    const session = Session.parse(JSON.parse(z.string().parse(row["document"])));
    if (session.id !== row["id"]) throw new Error("Session registry identity is inconsistent");
    const prefix = `helm-browser-${session.id}`;
    for (const name of [prefix, `${prefix}-egress`]) {
      if ((await inspect(name))?.State.Running) throw new Error("Browser execution must stop before migration");
    }
    if (session.status !== "CLOSED") throw new Error("Unconfirmed session prevents migration");
    const key = `session-storage:${session.id}`;
    const progress = db.prepare("SELECT value FROM settings WHERE id=?").get(key)?.["value"];
    if (progress !== undefined && !["COPYING", "COPIED", "DONE"].includes(String(progress))) {
      throw new Error("Unknown session migration state");
    }
    const source = await docker(`/volumes/${prefix}-data`);
    if (source === undefined) {
      if (progress === "COPYING") throw new Error("Unverified browser volume is missing");
      if (session.cleanupComplete || session.recordsAcknowledged) continue;
      if (progress === "COPIED" || progress === "DONE" || session.storageVersion === 1 && session.containerId) {
        for (const directory of [`/artifacts/sessions/${session.id}`, `/artifacts/sessions/${session.id}/artifacts`]) {
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 1000 || info.gid !== 10001
              || (info.mode & 0o7777) !== 0o2770) {
            throw new Error("Migrated session storage is invalid");
          }
        }
      } else if (session.runtimeStoppedAt && session.containerId && !session.cleanupComplete) {
        throw new Error("Required browser volume is missing");
      }
      continue;
    }
    db.prepare("INSERT INTO settings(id,value) VALUES(?,'COPYING') ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(key);
    const created = z.object({ Id: z.string() }).parse(await docker(`/containers/create?name=${helperName}`, "POST", {
      Image: own.Image, Entrypoint: ["node", "/app/dist/migrate-session-files.js"], Cmd: [session.id],
      Labels: { "helmglass.node": nodeId, "helmglass.migration": "session-storage" },
      HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, GroupAdd: ["10001"], CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER"], SecurityOpt: ["no-new-privileges:true"],
        Memory: 268_435_456, PidsLimit: 32,
        Mounts: [{ Type: "volume", Source: `${prefix}-data`, Target: "/source", ReadOnly: true },
          { Type: "volume", Source: volume, Target: "/artifacts" }],
        LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } } },
    }));
    let verified = false;
    try {
      await docker(`/containers/${created.Id}/start`, "POST");
      const result = z.object({ StatusCode: z.number().int() }).parse(await docker(`/containers/${created.Id}/wait?condition=not-running`, "POST"));
      if (result.StatusCode !== 0) {
        throw new Error(`Session storage verification failed: ${session.id}; inspect ${helperName}; source preserved`);
      }
      verified = true;
      db.prepare("UPDATE settings SET value='COPIED' WHERE id=?").run(key);
      db.prepare("UPDATE sessions SET document=json_set(document,'$.storageVersion',1) WHERE id=?").run(session.id);
      await docker(`/containers/${created.Id}`, "DELETE");
      for (const name of [prefix, `${prefix}-egress`]) {
        const container = await inspect(name);
        if (container) await docker(`/containers/${container.Id}`, "DELETE");
      }
      await docker(`/volumes/${prefix}-data`, "DELETE");
      db.prepare("UPDATE settings SET value='DONE' WHERE id=?").run(key);
      migrated++;
    } finally {
      // Keep a failed, stopped verifier for diagnosis. A retry removes this single named helper.
      if (verified) await docker(`/containers/${created.Id}?force=true`, "DELETE");
    }
  }
  db.prepare("INSERT INTO settings(id,value) VALUES('session-storage','1') ON CONFLICT(id) DO UPDATE SET value=excluded.value").run();
  console.info(`Session storage migration complete: ${migrated}`);
} finally { db.close(); }
