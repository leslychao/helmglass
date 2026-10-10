import { createReadStream } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export function operationReceipt(db: DatabaseSync, id: string, stopped = false): object | undefined {
  const row = db.prepare("SELECT status,result FROM operations WHERE id=?").get(id);
  if (!row) return undefined;
  return { operationId: id, status: stopped && row["status"] === "RUNNING" ? "UNKNOWN" : row["status"],
    ...(typeof row["result"] === "string" ? JSON.parse(row["result"]) : {}) };
}

/** Immutable committed artifacts are shared by the runtime and its restricted disk reader. */
export async function artifactResponse(db: DatabaseSync | undefined, directory: string,
  url: URL, response: ServerResponse): Promise<boolean> {
  if (url.pathname === "/artifacts") {
    const after = z.coerce.number().int().nonnegative().safe().parse(url.searchParams.get("after") ?? "0");
    const rows = db?.prepare("SELECT rowid,document FROM artifacts WHERE rowid>? ORDER BY rowid LIMIT 101").all(after) ?? [];
    const page = rows.slice(0, 100);
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ artifacts: page.map(row => JSON.parse(z.string().parse(row["document"]))),
      nextCursor: page.at(-1)?.["rowid"] ?? after, hasMore: rows.length > 100 }));
    return true;
  }
  const match = /^\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (!match?.[1]) return false;
  const id = z.uuid().parse(match[1]);
  const row = db?.prepare("SELECT document FROM artifacts WHERE id=?").get(id);
  if (!row) { response.writeHead(404); response.end(); return true; }
  const metadata = z.object({ mimeType: z.string(), sizeBytes: z.number().int().nonnegative() })
    .parse(JSON.parse(z.string().parse(row["document"])));
  response.writeHead(200, { "Content-Type": metadata.mimeType, "Content-Length": metadata.sizeBytes,
    "Cache-Control": "no-store" });
  await pipeline(createReadStream(path.join(directory, "artifacts", id)), response);
  return true;
}
