import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { artifactPage, initializeRecords } from "@helmglass/session-records";

test("artifact metadata must identify its registry row", () => {
  const records = new DatabaseSync(":memory:");
  const id = "6600ca80-cb85-49aa-b9b3-cf899faac974";
  const other = "0b66b432-b4e3-4cdf-9c15-e8183d268973";
  try {
    initializeRecords(records);
    records.prepare("INSERT INTO artifacts(id,document) VALUES (?,?)")
      .run(id, JSON.stringify({ id: other }));
    assert.throws(() => artifactPage(records), /Artifact record ID differs/);

    records.prepare("UPDATE artifacts SET document=? WHERE id=?")
      .run(JSON.stringify({ id }), id);
    assert.deepEqual(artifactPage(records), {
      artifacts: [{ id }], nextCursor: 1, hasMore: false,
    });
  } finally { records.close(); }
});
