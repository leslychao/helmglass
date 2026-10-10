import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, chown, lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { artifactPage, openRecords } from "@helmglass/session-records";
import { z } from "zod";

const id = z.uuid().parse(process.argv[2]);
const working = `/artifacts/sessions/${id}.migrating`;
const final = `/artifacts/sessions/${id}`;
async function info(filename: string) {
  try { return await lstat(filename); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
async function directory(filename: string) {
  const existing = await info(filename);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Invalid migration directory");
  if (!existing) await mkdir(filename, { mode: 0o2770 });
  await chown(filename, 1000, 10001);
  await chmod(filename, 0o2770);
  const prepared = await lstat(filename);
  if (prepared.uid !== 1000 || prepared.gid !== 10001 || (prepared.mode & 0o7777) !== 0o2770) {
    throw new Error("Migration directory permissions are invalid");
  }
}
async function syncDirectory(filename: string) {
  const handle = await open(filename, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function digest(filename: string) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Invalid migration file");
  const hash = createHash("sha256");
  let size = 0;
  const source = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of source.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; }
  } finally { await source.close(); }
  const after = await lstat(filename);
  if (before.ino !== after.ino || before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Migration source changed");
  }
  return { size, hash: hash.digest("hex") };
}
async function copy(source: string, destination: string, verified?: { size: number; hash: string }) {
  const expected = verified ?? await digest(source);
  if (await info(destination)) {
    const existing = await digest(destination);
    if (existing.size !== expected.size || existing.hash !== expected.hash) throw new Error("Migrated file differs from source");
    return;
  }
  const temporary = destination + ".copying";
  await rm(temporary, { force: true });
  const hash = createHash("sha256");
  const counter = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); } });
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await pipeline(input.createReadStream({ autoClose: false }),
      counter, createWriteStream(temporary, { flags: "wx", mode: 0o640 }));
  } finally { await input.close(); }
  const copied = await lstat(temporary);
  if (copied.size !== expected.size || hash.digest("hex") !== expected.hash) throw new Error("Migration copy verification failed");
  await chown(temporary, 1000, 10001);
  await chmod(temporary, 0o640);
  const file = await open(temporary, "r");
  try { await file.sync(); } finally { await file.close(); }
  await rename(temporary, destination);
}

const sourceRoot = await lstat("/source");
if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) throw new Error("Invalid migration source");
for await (const entry of await opendir("/source")) {
  if (!["artifacts", "session.sqlite", "session.sqlite-wal", "session.sqlite-shm"].includes(entry.name)) {
    throw new Error("Unknown session storage entry");
  }
}
const resumed = Boolean(await info(final));
const destination = resumed ? final : working;
await directory(destination);
await directory(path.join(destination, "artifacts"));
// The WAL contains committed data; SHM is a mutable index rebuilt by SQLite readers.
const sharedIndex = await info("/source/session.sqlite-shm");
if (sharedIndex && (!sharedIndex.isFile() || sharedIndex.isSymbolicLink())) {
  throw new Error("Invalid session shared-memory index");
}
for (const suffix of ["", "-wal"]) {
  const source = `/source/session.sqlite${suffix}`;
  if (await info(source)) await copy(source, path.join(destination, `session.sqlite${suffix}`));
  else if (!suffix) throw new Error("Required session registry is missing");
}
const records = openRecords(path.join(destination, "session.sqlite"));
try {
  const checked = records.prepare("PRAGMA integrity_check").get();
  if (checked?.["integrity_check"] !== "ok") throw new Error("Session registry is damaged");
  // Reading required columns also validates the supported schema without changing the source.
  records.prepare("SELECT id,fingerprint,status,result FROM operations LIMIT 1").get();
  records.prepare("SELECT id,value FROM state LIMIT 1").get();
  let after = 0;
  for (;;) {
    const page = artifactPage(records, after);
    for (const raw of page.artifacts) {
      const artifact = z.object({ id: z.uuid(), sizeBytes: z.number().int().positive().max(2_147_483_648),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).parse(raw);
      const published = `/artifacts/${artifact.id}`;
      const source = `/source/artifacts/${artifact.id}`;
      const target = path.join(destination, "artifacts", artifact.id);
      const ready = Boolean(await info(published));
      const original = await digest(ready ? published : source);
      if (original.size !== artifact.sizeBytes || original.hash !== artifact.sha256.toLowerCase()) {
        throw new Error("Committed artifact is damaged");
      }
      if (!ready) await copy(source, target, original);
      const verified = ready ? original : await digest(target);
      if (verified.size !== artifact.sizeBytes || verified.hash !== artifact.sha256.toLowerCase()) {
        throw new Error("Committed artifact is damaged");
      }
    }
    if (!page.hasMore) break;
    after = page.nextCursor;
  }
  // Preserve uncommitted data too; only entries with a committed receipt can be published.
  const artifacts = await lstat("/source/artifacts");
  if (!artifacts.isDirectory() || artifacts.isSymbolicLink()) throw new Error("Invalid artifact directory");
  for await (const entry of await opendir("/source/artifacts")) {
    const match = /^([0-9a-f-]{36})(\.partial)?$/.exec(entry.name);
    const artifact = z.uuid().parse(match?.[1]);
    const row = records.prepare("SELECT 1 FROM artifacts WHERE id=?").get(artifact);
    if (row && !match?.[2]) continue;
    await copy(path.join("/source/artifacts", entry.name), path.join(destination, "artifacts", entry.name));
  }
} finally { records.close(); }
await chown(path.join(destination, "session.sqlite-shm"), 1000, 10001).catch(error => {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
});
await syncDirectory(path.join(destination, "artifacts"));
await syncDirectory(destination);
if (!resumed) await rename(working, final);
await syncDirectory("/artifacts/sessions");
console.info("Session storage verified");
