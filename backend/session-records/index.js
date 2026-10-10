import { DatabaseSync } from "node:sqlite";

const maximumDocumentBytes = 16_384;
const maximumReceiptBytes = 2_000_000;

export function initializeRecords(db) {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT); CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, document TEXT NOT NULL);");
}

export function openRecords(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function document(value, maximumBytes) {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximumBytes) {
    throw new Error("Session record exceeds its response limit");
  }
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid session record");
  }
  return parsed;
}

export function operationReceipt(db, id, stopped = false) {
  const row = db.prepare("SELECT status, CASE WHEN length(CAST(result AS BLOB))<=? THEN result ELSE NULL END AS result, length(CAST(result AS BLOB)) AS bytes FROM operations WHERE id=?")
    .get(maximumReceiptBytes, id);
  if (!row) return undefined;
  if (Number(row.bytes ?? 0) > maximumReceiptBytes) throw new Error("Session receipt exceeds its response limit");
  if (!["RUNNING", "UNKNOWN", "SUCCEEDED", "FAILED", "REJECTED", "UNCONFIRMED"].includes(row.status)) {
    throw new Error("Invalid operation status");
  }
  return { ...(row.result === null ? {} : document(row.result, maximumReceiptBytes)),
    operationId: id, status: stopped && row.status === "RUNNING" ? "UNKNOWN" : row.status };
}

export function artifactPage(db, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid artifact cursor");
  const rows = db.prepare("SELECT id, rowid, CASE WHEN length(CAST(document AS BLOB))<=? THEN document ELSE NULL END AS document FROM artifacts WHERE rowid>? ORDER BY rowid LIMIT 101")
    .all(maximumDocumentBytes, after);
  const page = rows.slice(0, 100);
  return { artifacts: page.map(row => {
      const metadata = document(row.document, maximumDocumentBytes);
      if (metadata.id !== row.id) throw new Error("Artifact record ID differs from its metadata");
      return metadata;
    }),
    nextCursor: page.at(-1)?.rowid ?? after, hasMore: rows.length > 100 };
}
